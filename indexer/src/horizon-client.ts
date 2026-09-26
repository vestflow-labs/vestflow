/**
 * Horizon Archive Client
 * 
 * Fetches historical contract events from Horizon's /effects and /operations endpoints
 * for ledgers that are outside the RPC retention window. Handles pagination,
 * filtering, and parsing of Horizon responses to extract VestFlow contract events.
 * 
 * Key responsibilities:
 * - Fetch contract events from Horizon /effects endpoint
 * - Handle Horizon pagination with cursor-based navigation
 * - Filter events to VestFlow contract only
 * - Parse Horizon event format to match RPC format
 * - Handle rate limiting and retries
 */

import { parseNetwork, getNetworkConfig, type NetworkName } from "./config";
import { retryOrThrow, isHttpRetryable } from "./retry";

// Horizon API endpoints by network
const HORIZON_URLS: Record<NetworkName, string> = {
  testnet: "https://horizon-testnet.stellar.org",
  mainnet: "https://horizon.stellar.org"
};

export interface HorizonEventEffect {
  id: string;
  paging_token: string;
  account: string;
  type: string;
  type_i: number;
  created_at: string;
  // Contract event specific fields
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
  // Operation details
  operation?: string;
  // Contract call details for contract events
  contract?: string;
  topic?: string[];
  value?: any;
}

export interface HorizonOperation {
  id: string;
  paging_token: string;
  source_account: string;
  type: string;
  type_i: number;
  created_at: string;
  transaction_hash: string;
  // Contract invoke operation specific fields
  function?: string;
  parameters?: any[];
  contract?: string;
  // Ledger information
  ledger: number;
  ledger_close_time: string;
}

export interface HorizonResponse<T> {
  _embedded: {
    records: T[];
  };
  _links: {
    next?: {
      href: string;
    };
    prev?: {
      href: string;
    };
  };
}

export interface ParsedHorizonEvent {
  id: string;
  ledger: number;
  ledger_closed_at: string;
  contract_id: string;
  topic: any[];
  value: any;
  operation_index: number;
  paging_token: string;
}

export interface HorizonClientConfig {
  network?: NetworkName;
  horizonUrl?: string;
  contractId?: string;
  timeoutMs?: number;
  retryDelayMs?: number;
  maxRetries?: number;
}

export class HorizonClient {
  private readonly network: NetworkName;
  readonly horizonUrl: string;        // readable by shouldUseHorizonForRange
  private readonly contractId: string;
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly maxRetries: number;

  constructor(config: HorizonClientConfig = {}) {
    this.network = config.network ?? parseNetwork(process.env.INDEXER_NETWORK);
    this.horizonUrl = config.horizonUrl ?? HORIZON_URLS[this.network];
    
    const networkConfig = getNetworkConfig(this.network);
    this.contractId = config.contractId ?? networkConfig.contractId;
    
    this.timeoutMs = config.timeoutMs ?? 30000;
    this.retryDelayMs = config.retryDelayMs ?? 1000;
    this.maxRetries = config.maxRetries ?? 3;

    if (!this.contractId) {
      throw new Error(`Contract ID not configured for ${this.network} network`);
    }
  }

  /**
   * Make HTTP request with timeout, delegating retry/backoff to the shared utility.
   */
  async makeRequest<T>(url: string): Promise<T> {
    return retryOrThrow(
      async () => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

        try {
          const response = await fetch(url, {
            signal: controller.signal,
            headers: {
              'Accept': 'application/json',
              'User-Agent': 'VestFlow-Indexer/1.0'
            }
          });

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText} — ${url}`);
          }

          return (await response.json()) as T;
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') {
            throw new Error(`Request timeout after ${this.timeoutMs}ms — ${url}`);
          }
          throw error;
        } finally {
          clearTimeout(timeoutId);
        }
      },
      {
        maxAttempts: this.maxRetries,
        baseDelayMs: this.retryDelayMs,
        label: '[horizon-client]',
        isRetryable: isHttpRetryable,
      }
    );
  }

  /**
   * Fetch contract events from Horizon /effects endpoint
   * This endpoint provides contract_debited/credited effects that include event data
   */
  async fetchEffects(params: {
    cursor?: string;
    limit?: number;
    order?: 'asc' | 'desc';
  } = {}): Promise<HorizonResponse<HorizonEventEffect>> {
    const searchParams = new URLSearchParams({
      account: this.contractId,
      limit: String(params.limit ?? 200),
      order: params.order ?? 'asc'
    });

    if (params.cursor) {
      searchParams.set('cursor', params.cursor);
    }

    const url = `${this.horizonUrl}/effects?${searchParams.toString()}`;
    return this.makeRequest<HorizonResponse<HorizonEventEffect>>(url);
  }

  /**
   * Fetch contract operations from Horizon /operations endpoint
   * This provides invoke_contract operations which contain event data
   */
  async fetchOperations(params: {
    cursor?: string;
    limit?: number;
    order?: 'asc' | 'desc';
    includeFailed?: boolean;
  } = {}): Promise<HorizonResponse<HorizonOperation>> {
    const searchParams = new URLSearchParams({
      account: this.contractId,
      limit: String(params.limit ?? 200),
      order: params.order ?? 'asc'
    });

    if (params.cursor) {
      searchParams.set('cursor', params.cursor);
    }

    if (params.includeFailed) {
      searchParams.set('include_failed', 'true');
    }

    const url = `${this.horizonUrl}/operations?${searchParams.toString()}`;
    return this.makeRequest<HorizonResponse<HorizonOperation>>(url);
  }

  /**
   * Fetch events for a specific ledger range using effects endpoint
   */
  async fetchEventsInLedgerRange(
    fromLedger: number, 
    toLedger: number,
    onProgress?: (ledger: number, eventsFound: number) => void
  ): Promise<ParsedHorizonEvent[]> {
    console.log(`[horizon-client] Fetching events for ledgers ${fromLedger} to ${toLedger}`);
    
    const allEvents: ParsedHorizonEvent[] = [];
    let cursor: string | undefined;
    let currentLedger = fromLedger;
    let consecutiveEmptyBatches = 0;
    const maxEmptyBatches = 5; // Stop if we get too many empty responses

    try {
      while (currentLedger <= toLedger && consecutiveEmptyBatches < maxEmptyBatches) {
        const response = await this.fetchEffects({
          cursor,
          limit: 200,
          order: 'asc'
        });

        const effects = response._embedded?.records || [];
        
        if (effects.length === 0) {
          consecutiveEmptyBatches++;
          console.log(`[horizon-client] No effects found (empty batch ${consecutiveEmptyBatches}/${maxEmptyBatches})`);
          break;
        }

        consecutiveEmptyBatches = 0;
        const batchEvents: ParsedHorizonEvent[] = [];

        for (const effect of effects) {
          const parsed = this.parseHorizonEffect(effect);
          if (parsed && parsed.ledger >= fromLedger && parsed.ledger <= toLedger) {
            batchEvents.push(parsed);
            currentLedger = Math.max(currentLedger, parsed.ledger);
          } else if (parsed && parsed.ledger > toLedger) {
            // We've gone past our target range
            console.log(`[horizon-client] Reached ledger ${parsed.ledger}, stopping (target: ${toLedger})`);
            return allEvents;
          }
        }

        allEvents.push(...batchEvents);
        
        if (onProgress) {
          onProgress(currentLedger, batchEvents.length);
        }

        console.log(`[horizon-client] Processed batch: ${batchEvents.length} events, current ledger: ${currentLedger}`);

        // Check if we have a next page
        const nextHref = response._links?.next?.href;
        if (!nextHref) {
          console.log(`[horizon-client] No more pages available`);
          break;
        }

        // Extract cursor from next page URL
        const nextUrl = new URL(nextHref);
        cursor = nextUrl.searchParams.get('cursor') || undefined;
      }
    } catch (error) {
      console.error(`[horizon-client] Error fetching ledger range ${fromLedger}-${toLedger}:`, error);
      throw error;
    }

    console.log(`[horizon-client] Completed ledger range ${fromLedger}-${toLedger}: found ${allEvents.length} events`);
    return allEvents;
  }

  /**
   * Parse a Horizon effect into our event format
   */
  private parseHorizonEffect(effect: HorizonEventEffect): ParsedHorizonEvent | null {
    // Filter for contract events only
    if (effect.type !== 'contract_debited' && effect.type !== 'contract_credited') {
      return null;
    }

    // Ensure this effect is from our target contract
    if (effect.account !== this.contractId) {
      return null;
    }

    // Try to extract event data from the effect
    // Note: Horizon's effect format may vary, so this parsing may need adjustment
    // based on the actual Horizon response structure for Soroban contract events
    
    try {
      // Extract ledger number from the effect ID (format: "ledger-operation-effect")
      const idParts = effect.id.split('-');
      const ledger = parseInt(idParts[0], 10);
      
      if (isNaN(ledger)) {
        console.warn(`[horizon-client] Could not parse ledger from effect ID: ${effect.id}`);
        return null;
      }

      // For now, we'll create a basic event structure
      // This may need to be enhanced based on actual Horizon contract event format
      const parsed: ParsedHorizonEvent = {
        id: effect.id,
        ledger,
        ledger_closed_at: effect.created_at,
        contract_id: this.contractId,
        topic: effect.topic || [],
        value: effect.value || {},
        operation_index: parseInt(idParts[1] || '0', 10),
        paging_token: effect.paging_token
      };

      return parsed;
    } catch (error) {
      console.warn(`[horizon-client] Failed to parse effect:`, effect, error);
      return null;
    }
  }

  /**
   * Get the ledger range that Horizon has archived data for
   */
  async getArchiveDataRange(): Promise<{ oldestLedger: number; newestLedger: number }> {
    try {
      // Get the oldest available ledger
      const oldestResponse = await this.makeRequest<HorizonResponse<any>>(
        `${this.horizonUrl}/ledgers?order=asc&limit=1`
      );
      
      // Get the newest available ledger  
      const newestResponse = await this.makeRequest<HorizonResponse<any>>(
        `${this.horizonUrl}/ledgers?order=desc&limit=1`
      );

      const oldestRecords = oldestResponse._embedded?.records || [];
      const newestRecords = newestResponse._embedded?.records || [];

      if (oldestRecords.length === 0 || newestRecords.length === 0) {
        throw new Error('No ledgers found in Horizon');
      }

      return {
        oldestLedger: oldestRecords[0].sequence,
        newestLedger: newestRecords[0].sequence
      };
    } catch (error) {
      console.error('[horizon-client] Failed to get archive data range:', error);
      throw error;
    }
  }

  /**
   * Check if a ledger range is available in Horizon archives
   */
  async isLedgerRangeAvailable(fromLedger: number, toLedger: number): Promise<boolean> {
    try {
      const range = await this.getArchiveDataRange();
      return fromLedger >= range.oldestLedger && toLedger <= range.newestLedger;
    } catch (error) {
      console.warn('[horizon-client] Could not check ledger range availability:', error);
      return false;
    }
  }
}

/**
 * Factory function to create a Horizon client with default configuration
 */
export function createHorizonClient(config: HorizonClientConfig = {}): HorizonClient {
  return new HorizonClient(config);
}

/**
 * Utility to determine if a ledger range should use Horizon (archive) vs RPC
 * Based on RPC retention window (typically ~17,000 ledgers on mainnet)
 */
export async function shouldUseHorizonForRange(
  fromLedger: number,
  toLedger: number,
  network?: NetworkName,
  rpcRetentionLedgers = 17000
): Promise<{ useHorizon: boolean; reason: string }> {
  try {
    const horizonClient = createHorizonClient({ network });
    const currentLedger = await horizonClient.makeRequest<any>(
      `${horizonClient.horizonUrl}/ledgers?order=desc&limit=1`
    );
    
    const latestLedger = currentLedger._embedded?.records[0]?.sequence || 0;
    const rpcCutoff = latestLedger - rpcRetentionLedgers;
    
    if (toLedger < rpcCutoff) {
      return {
        useHorizon: true,
        reason: `Ledger range ${fromLedger}-${toLedger} is outside RPC retention window (cutoff: ${rpcCutoff})`
      };
    } else if (fromLedger < rpcCutoff && toLedger >= rpcCutoff) {
      return {
        useHorizon: true,
        reason: `Ledger range ${fromLedger}-${toLedger} spans RPC retention window (cutoff: ${rpcCutoff})`
      };
    } else {
      return {
        useHorizon: false,
        reason: `Ledger range ${fromLedger}-${toLedger} is within RPC retention window (cutoff: ${rpcCutoff})`
      };
    }
  } catch (error) {
    console.warn('[horizon-client] Could not determine data source, defaulting to Horizon:', error);
    return {
      useHorizon: true,
      reason: 'Could not determine RPC retention window, defaulting to Horizon'
    };
  }
}