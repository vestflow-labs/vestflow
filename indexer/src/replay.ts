/**
 * Replay Engine
 * 
 * Background worker that processes queued gap ranges, fetches events from
 * RPC or Horizon, and applies them through the existing event processing
 * pipeline with proper ordering and idempotency.
 * 
 * Key responsibilities:
 * - Dequeue pending replay ranges from the database
 * - Determine data source (RPC vs Horizon) based on retention window
 * - Fetch events in correct ledger+operation order
 * - Process events through the same pipeline as live poller
 * - Handle errors with exponential backoff and retry logic
 * - Update progress to support mid-range restarts
 */

import { rpc as StellarRpc, xdr, scValToNative } from "@stellar/stellar-sdk";
import { parseNetwork, getNetworkConfig, type NetworkName } from "./config";
import { 
  getNextPendingReplay, 
  markReplayInProgress, 
  updateReplayProgress,
  markReplayCompleted,
  markReplayFailed,
  insertEvent,
  insertBeneficiarySchedule,
  type ReplayQueueItem 
} from "./db";
import { 
  createHorizonClient, 
  shouldUseHorizonForRange,
  type ParsedHorizonEvent,
  type HorizonClient 
} from "./horizon-client";
import { fanOutEvent } from "./webhook-delivery";
import { retryOrThrow, isHttpRetryable, sleep, backoffDelayMs } from "./retry";
import type { EventType } from "./types";

export interface ReplayEngineConfig {
  network?: NetworkName;
  batchSize?: number;        // Events to process per batch
  maxRetries?: number;       // Max retry attempts for failed ranges
  retryDelayMs?: number;     // Base delay for exponential backoff
  progressUpdateInterval?: number; // Update progress every N ledgers
  webhookDelivery?: boolean; // Enable webhook delivery for replayed events
}

export class ReplayEngine {
  private readonly network: NetworkName;
  private readonly config: ReplayEngineConfig;
  private readonly rpcServer: StellarRpc.Server;
  private readonly horizonClient: HorizonClient;
  private readonly contractId: string;
  private isRunning = false;
  private shouldStop = false;

  constructor(config: ReplayEngineConfig = {}) {
    this.network = config.network ?? parseNetwork(process.env.INDEXER_NETWORK);
    this.config = {
      batchSize: 200,
      maxRetries: 8,
      retryDelayMs: 1000,
      progressUpdateInterval: 100,
      webhookDelivery: true,
      ...config
    };

    const networkConfig = getNetworkConfig(this.network);
    this.contractId = networkConfig.contractId;
    this.rpcServer = new StellarRpc.Server(networkConfig.rpcUrl);
    this.horizonClient = createHorizonClient({ network: this.network });

    if (!this.contractId) {
      throw new Error(`Contract ID not configured for ${this.network} network`);
    }
  }

  /**
   * Start the replay worker - processes pending ranges until stopped
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.warn('[replay-engine] Already running');
      return;
    }

    this.isRunning = true;
    this.shouldStop = false;
    
    console.log(`[replay-engine] Starting replay worker for ${this.network} network`);
    
    try {
      while (!this.shouldStop) {
        const nextRange = getNextPendingReplay(this.network);
        
        if (!nextRange) {
          // No pending ranges — idle until something is enqueued
          await sleep(5000);
          continue;
        }

        console.log(
          `[replay-engine] Processing range ${nextRange.from_ledger}-${nextRange.to_ledger} ` +
          `(queue ID: ${nextRange.id})`
        );

        try {
          await this.processReplayRange(nextRange);
        } catch (error) {
          console.error(`[replay-engine] Range ${nextRange.id} failed:`, error);
          // Error handling is done in processReplayRange
        }
      }
    } catch (error) {
      console.error('[replay-engine] Fatal error in replay worker:', error);
    } finally {
      this.isRunning = false;
      console.log('[replay-engine] Replay worker stopped');
    }
  }

  /**
   * Stop the replay worker gracefully
   */
  stop(): void {
    console.log('[replay-engine] Stopping replay worker...');
    this.shouldStop = true;
  }

  /**
   * Process a single replay range with retry logic
   */
  private async processReplayRange(range: ReplayQueueItem): Promise<void> {
    const startTime = Date.now();
    
    try {
      // Mark as in progress
      markReplayInProgress(range.id, this.network);
      
      // Determine resume point (in case of restart)
      const resumeLedger = range.completed_ledger ?? range.from_ledger;
      
      if (resumeLedger > range.from_ledger) {
        console.log(
          `[replay-engine] Resuming range ${range.id} from ledger ${resumeLedger} ` +
          `(${resumeLedger - range.from_ledger} ledgers already completed)`
        );
      }

      // Determine data source
      const sourceDecision = await shouldUseHorizonForRange(
        resumeLedger, 
        range.to_ledger, 
        this.network
      );
      
      console.log(`[replay-engine] ${sourceDecision.reason}`);

      let eventsProcessed = 0;

      if (sourceDecision.useHorizon) {
        eventsProcessed = await this.processRangeWithHorizon(range, resumeLedger);
      } else {
        eventsProcessed = await this.processRangeWithRPC(range, resumeLedger);
      }

      // Mark as completed
      markReplayCompleted(range.id, this.network);
      
      const duration = Date.now() - startTime;
      const ledgerCount = range.to_ledger - range.from_ledger + 1;
      
      console.log(
        `[replay-engine] Completed range ${range.id}: ${eventsProcessed} events, ` +
        `${ledgerCount} ledgers in ${duration}ms`
      );
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      if (range.retry_count >= (this.config.maxRetries ?? 8)) {
        console.error(
          `[replay-engine] Range ${range.id} exhausted retries (${range.retry_count}), marking as failed`
        );
        markReplayFailed(range.id, errorMessage, this.network);
        // Emit the alert log entry required by the spec
        console.error(
          `[replay-engine] ALERT: replay range ${range.from_ledger}-${range.to_ledger} ` +
          `permanently failed after ${range.retry_count} attempts. Error: ${errorMessage}`
        );
      } else {
        const delay = backoffDelayMs(range.retry_count, this.config.retryDelayMs ?? 1000);
        console.warn(
          `[replay-engine] Range ${range.id} failed (attempt ${range.retry_count + 1}/${this.config.maxRetries}), ` +
          `retrying in ${delay}ms: ${errorMessage}`
        );
        // Mark failed first so it's re-queued as pending on next iteration
        markReplayFailed(range.id, errorMessage, this.network);
        await sleep(delay);
      }
      
      throw error;
    }
  }

  /**
   * Process range using Stellar RPC getEvents
   */
  private async processRangeWithRPC(range: ReplayQueueItem, fromLedger: number): Promise<number> {
    console.log(`[replay-engine] Fetching ledgers ${fromLedger}-${range.to_ledger} from RPC`);

    let cursor: string | undefined;
    let eventsProcessed = 0;
    let currentLedger = fromLedger;
    let progressBaseLedger = fromLedger;

    do {
      const response: any = await retryOrThrow(
        () => (this.rpcServer as any).getEvents({
          startLedger: cursor ? undefined : fromLedger,
          endLedger: range.to_ledger,
          filters: [{ type: "contract", contractIds: [this.contractId] }],
          ...(cursor ? { cursor } : {}),
          limit: this.config.batchSize,
        }),
        {
          maxAttempts: this.config.maxRetries,
          baseDelayMs: this.config.retryDelayMs,
          label: '[replay-engine/rpc]',
          isRetryable: isHttpRetryable,
        }
      );

      const events: any[] = response.events ?? [];

      if (events.length === 0) break;

      // Sort events by ledger then operation index for correct ordering
      events.sort((a, b) => {
        if (a.ledger !== b.ledger) return a.ledger - b.ledger;
        return this.extractOperationIndex(a.id) - this.extractOperationIndex(b.id);
      });

      for (const event of events) {
        if (await this.processEvent(event, 'rpc')) eventsProcessed++;
        if (event.ledger > currentLedger) currentLedger = event.ledger;
      }

      // Persist progress every N ledgers so restarts don't replay from scratch
      if (currentLedger - progressBaseLedger >= (this.config.progressUpdateInterval ?? 100)) {
        updateReplayProgress(range.id, currentLedger, this.network);
        progressBaseLedger = currentLedger;
      }

      cursor = events.length === this.config.batchSize
        ? events[events.length - 1].pagingToken
        : undefined;

    } while (cursor && !this.shouldStop);

    return eventsProcessed;
  }

  /**
   * Process range using Horizon archives
   */
  private async processRangeWithHorizon(range: ReplayQueueItem, fromLedger: number): Promise<number> {
    console.log(`[replay-engine] Fetching ledgers ${fromLedger}-${range.to_ledger} from Horizon`);
    
    try {
      const events = await this.horizonClient.fetchEventsInLedgerRange(
        fromLedger,
        range.to_ledger,
        (ledger, eventsInBatch) => {
          // Progress callback
          if (ledger - fromLedger >= (this.config.progressUpdateInterval ?? 100)) {
            updateReplayProgress(range.id, ledger, this.network);
          }
        }
      );

      // Sort events by ledger, then by operation index
      events.sort((a, b) => {
        if (a.ledger !== b.ledger) {
          return a.ledger - b.ledger;
        }
        return a.operation_index - b.operation_index;
      });

      let eventsProcessed = 0;
      
      for (const event of events) {
        if (this.shouldStop) break;
        
        if (await this.processHorizonEvent(event)) {
          eventsProcessed++;
        }
      }

      return eventsProcessed;
    } catch (error) {
      console.error(`[replay-engine] Horizon fetch failed:`, error);
      throw error;
    }
  }

  /**
   * Process a single RPC event through the existing pipeline
   */
  private async processEvent(rawEvent: any, source: 'rpc' | 'horizon'): Promise<boolean> {
    try {
      // Reuse the existing event processing logic from poller.ts
      const topics = this.decodeTopics(rawEvent.topic ?? []);
      const value = this.decodeValue(rawEvent.value);
      const valueArr = this.asArray(value);
      const eventType = this.inferEventType(topics);

      const { scheduleId, proposalId, grantor, beneficiary, amount, token, createdAmount } = 
        this.parseEventData(eventType, topics, valueArr, value);

      const isNew = insertEvent({
        id: rawEvent.id,
        event_type: eventType,
        ledger: rawEvent.ledger,
        ledger_closed_at: rawEvent.ledgerClosedAt || rawEvent.ledger_closed_at,
        schedule_id: scheduleId,
        proposal_id: proposalId,
        grantor,
        beneficiary,
        amount,
        token,
        created_amount: createdAmount,
        raw_topics: this.jsonStringify(topics),
        raw_value: this.jsonStringify(value),
      }, this.network);

      if (isNew) {
        // Populate beneficiary index for O(1) lookup
        if (eventType === "schedule_created" && beneficiary && scheduleId !== null) {
          insertBeneficiarySchedule(beneficiary, scheduleId, this.network);
        }
        
        // Queue webhook deliveries if enabled
        if (this.config.webhookDelivery) {
          try {
            fanOutEvent(
              {
                event_id: rawEvent.id,
                event_type: eventType,
                network: this.network,
                ledger: rawEvent.ledger,
                ledger_closed_at: rawEvent.ledgerClosedAt || rawEvent.ledger_closed_at,
                schedule_id: scheduleId,
                proposal_id: proposalId,
                grantor,
                beneficiary,
                token,
                amount,
                created_amount: createdAmount,
              },
              this.network
            );
          } catch (err) {
            console.error(`[replay-engine] Webhook fan-out failed for event ${rawEvent.id}:`, err);
            // Don't fail replay for webhook errors
          }
        }
      }

      return isNew;
    } catch (error) {
      console.error(`[replay-engine] Failed to process event ${rawEvent.id}:`, error);
      // Log but don't fail the entire range for individual event errors
      return false;
    }
  }

  /**
   * Process a Horizon event (convert format and delegate to processEvent)
   */
  private async processHorizonEvent(horizonEvent: ParsedHorizonEvent): Promise<boolean> {
    // Convert Horizon event format to match RPC format
    const rpcFormatEvent = {
      id: horizonEvent.id,
      ledger: horizonEvent.ledger,
      ledgerClosedAt: horizonEvent.ledger_closed_at,
      topic: horizonEvent.topic,
      value: horizonEvent.value
    };

    return this.processEvent(rpcFormatEvent, 'horizon');
  }

  // Utility methods (copied from poller.ts for consistency)
  private decodeTopics(rawTopics: xdr.ScVal[]): unknown[] {
    return rawTopics.map((t) => {
      try { return scValToNative(t); } catch { return null; }
    });
  }

  private decodeValue(raw: xdr.ScVal): unknown {
    try { return scValToNative(raw); } catch { return null; }
  }

  private inferEventType(topics: unknown[]): EventType {
    const tag = topics[0];
    if (tag === "created") return "schedule_created";
    if (tag === "claimed") return "claimed";
    if (tag === "revoked") return "revoked";
    if (tag === "prop_new") return "proposal_created";
    if (tag === "prop_ack") return "proposal_acknowledged";
    if (tag === "prop_act") return "proposal_activated";
    if (tag === "prop_exp") return "proposal_expired";
    if (
      tag === "stream_set" ||
      tag === "strm_set" ||
      tag === "stream_opened" ||
      tag === "stream_rate_changed" ||
      tag === "stream_closed"
    ) {
      return "stream_set";
    }
    if (tag === "given") return "given";
    if (tag === "collected" || tag === "strm_col") return "collected";
    if (tag === "strm_recv" || tag === "stream_received") return "stream_received";
    if (tag === "squeezed" || tag === "squeeze" || tag === "strm_squeeze") {
      return "squeezed";
    }
    return "unknown";
  }

  private toStr(v: unknown): string | null {
    if (v == null) return null;
    try { return String(v); } catch { return null; }
  }

  private jsonStringify(value: unknown): string {
    return JSON.stringify(value, (_key, item) =>
      typeof item === "bigint" ? item.toString() : item
    );
  }

  private asArray(v: unknown): unknown[] {
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object") {
      const keys = Object.keys(v).map(Number).filter((k) => !isNaN(k));
      if (keys.length > 0) {
        keys.sort((a, b) => a - b);
        return keys.map((k) => (v as Record<string, unknown>)[String(k)]);
      }
    }
    return [];
  }

  private parseEventData(eventType: EventType, topics: unknown[], valueArr: unknown[], value: unknown) {
    let scheduleId: number | null = null;
    let proposalId: number | null = null;
    let grantor: string | null = null;
    let beneficiary: string | null = null;
    let amount: string | null = null;
    let token: string | null = null;
    let createdAmount: string | null = null;

    switch (eventType) {
      case "schedule_created":
        scheduleId = topics[1] != null && !Number.isNaN(Number(topics[1]))
          ? Number(topics[1])
          : valueArr[0] != null ? Number(valueArr[0]) : null;
        grantor = valueArr[0] != null && scheduleId === Number(topics[1])
          ? this.toStr(valueArr[0])
          : this.toStr(topics[1]);
        beneficiary = valueArr[1] != null && scheduleId === Number(topics[1])
          ? this.toStr(valueArr[1])
          : this.toStr(topics[2]);
        token = valueArr[2] != null && scheduleId === Number(topics[1])
          ? this.toStr(valueArr[2])
          : this.toStr(topics[3]);
        createdAmount = valueArr[3] != null && scheduleId === Number(topics[1])
          ? String(valueArr[3])
          : valueArr[1] != null ? String(valueArr[1]) : null;
        break;
      case "claimed":
        beneficiary = this.toStr(topics[1]);
        token = this.toStr(topics[2]);
        scheduleId = valueArr[0] != null ? Number(valueArr[0]) : null;
        amount = valueArr[1] != null ? String(valueArr[1]) : null;
        break;
      case "revoked":
        grantor = this.toStr(topics[1]);
        token = this.toStr(topics[2]);
        scheduleId = valueArr[0] != null ? Number(valueArr[0]) : null;
        break;
      case "proposal_created":
        proposalId = topics[1] != null ? Number(topics[1]) : null;
        grantor = this.toStr(valueArr[0]);
        beneficiary = this.toStr(valueArr[1]);
        token = this.toStr(valueArr[2]);
        createdAmount = valueArr[3] != null ? String(valueArr[3]) : null;
        break;
      case "proposal_acknowledged":
        proposalId = topics[1] != null ? Number(topics[1]) : null;
        beneficiary = this.toStr(valueArr[0]);
        break;
      case "proposal_activated":
        proposalId = topics[1] != null ? Number(topics[1]) : null;
        scheduleId = value != null && !Array.isArray(value)
          ? Number(value)
          : valueArr[0] != null ? Number(valueArr[0]) : null;
        break;
      case "proposal_expired":
        proposalId = topics[1] != null ? Number(topics[1]) : null;
        grantor = this.toStr(Array.isArray(value) || (value && typeof value === "object")
          ? valueArr[0]
          : value);
        break;
      case "stream_set":
        grantor = this.toStr(topics[1]);
        token = this.toStr(topics.length >= 4 ? topics[3] : topics[2]);
        break;
      case "given":
        grantor = this.toStr(topics[1]);
        beneficiary = this.toStr(topics[2]);
        token = this.toStr(topics[3]);
        amount = this.toStr(Array.isArray(value) || (value && typeof value === "object") ? valueArr[0] : value);
        break;
      case "collected":
        beneficiary = this.toStr(topics[1]);
        token = this.toStr(topics[2]);
        amount = this.toStr(Array.isArray(value) || (value && typeof value === "object") ? valueArr[0] : value);
        break;
      case "stream_received":
        beneficiary = this.toStr(topics[1]);
        token = this.toStr(topics[2]);
        amount = this.toStr(valueArr[1] ?? valueArr[0]);
        break;
      case "squeezed":
        beneficiary = this.toStr(topics[1]);
        grantor = this.toStr(topics[2]);
        token = this.toStr(topics[3]);
        amount = this.toStr(valueArr[0] ?? value);
        break;
    }

    return { scheduleId, proposalId, grantor, beneficiary, amount, token, createdAmount };
  }

  private extractOperationIndex(eventId: string): number {
    try {
      const parts = eventId.split('-');
      return parseInt(parts[1] || '0', 10);
    } catch {
      return 0;
    }
  }

  // Public status methods
  isWorkerRunning(): boolean {
    return this.isRunning;
  }

  getConfig(): ReplayEngineConfig {
    return { ...this.config };
  }
}

/**
 * Factory function to create and start a replay engine
 */
export async function createReplayEngine(config: ReplayEngineConfig = {}): Promise<ReplayEngine> {
  return new ReplayEngine(config);
}

/**
 * Run replay engine once (process all pending ranges and exit)
 */
export async function runReplayOnce(config: ReplayEngineConfig = {}): Promise<void> {
  const engine = new ReplayEngine(config);
  const network = config.network ?? parseNetwork(process.env.INDEXER_NETWORK);
  
  console.log(`[replay-engine] Running one-time replay for ${network} network`);
  
  let processedRanges = 0;
  
  while (true) {
    const nextRange = getNextPendingReplay(network);
    
    if (!nextRange) {
      break; // No more pending ranges
    }

    console.log(`[replay-engine] Processing range ${nextRange.from_ledger}-${nextRange.to_ledger}`);
    
    try {
      await engine['processReplayRange'](nextRange);
      processedRanges++;
    } catch (error) {
      console.error(`[replay-engine] Failed to process range ${nextRange.id}:`, error);
      break; // Stop on first failure in one-time mode
    }
  }
  
  console.log(`[replay-engine] One-time replay completed: processed ${processedRanges} ranges`);
}