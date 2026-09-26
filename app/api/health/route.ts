import { NextResponse } from "next/server";
import { 
  getDb, 
  getCheckpoint, 
  getPendingReplayCount, 
  getReplayQueueItems, 
  getLastGapDetection 
} from "@/indexer/src/db";
import { getGapDetectionHealth } from "@/indexer/src/gap-detector";
import { parseNetwork } from "@/indexer/src/config";
import { withLogging } from "@/lib/requestLogger";

const NETWORK = parseNetwork(process.env.NEXT_PUBLIC_NETWORK);
const RPC_URL = process.env.NEXT_PUBLIC_NETWORK === "mainnet"
  ? "https://mainnet.sorobanrpc.com"
  : "https://soroban-testnet.stellar.org";

export const GET = withLogging(async function GET(): Promise<NextResponse> {
  const checks: Record<string, string> = {};
  let allHealthy = true;

  // Basic health checks
  try {
    const db = getDb();
    db.prepare("SELECT 1").get();
    checks.database = "healthy";
  } catch (error) {
    console.error("Database check failed:", error);
    checks.database = "unhealthy";
    allHealthy = false;
  }

  try {
    const { rpc: StellarRpc } = await import("@stellar/stellar-sdk");
    const server = new StellarRpc.Server(RPC_URL);
    await server.getLatestLedger();
    checks.rpc = "healthy";
  } catch (error) {
    console.error("RPC check failed:", error);
    checks.rpc = "unhealthy";
    allHealthy = false;
  }

  // Indexer lag and gap detection status
  let indexerLag = 0;
  let pendingReplayRanges = 0;
  let lastGapDetectedAt: string | null = null;
  let gapDetectionHealth: any = null;

  try {
    // Calculate indexer lag
    const checkpoint = getCheckpoint(NETWORK);
    const { rpc: StellarRpc } = await import("@stellar/stellar-sdk");
    const server = new StellarRpc.Server(RPC_URL);
    const latestLedger = await server.getLatestLedger();
    indexerLag = Math.max(0, latestLedger.sequence - checkpoint);

    // Get replay queue status
    pendingReplayRanges = getPendingReplayCount(NETWORK);

    // Get gap detection status
    gapDetectionHealth = getGapDetectionHealth(NETWORK);
    
    const lastGapDetection = getLastGapDetection(NETWORK);
    if (lastGapDetection) {
      lastGapDetectedAt = new Date(lastGapDetection.checked_at * 1000).toISOString();
    }

    // Mark as unhealthy if significant lag or gap detection issues
    if (indexerLag > 100) { // More than 100 ledgers behind
      checks.indexer_lag = "unhealthy";
      allHealthy = false;
    } else if (indexerLag > 10) {
      checks.indexer_lag = "warning";
    } else {
      checks.indexer_lag = "healthy";
    }

    // Check gap detection health
    if (!gapDetectionHealth.isHealthy) {
      checks.gap_detection = "unhealthy";
      allHealthy = false;
    } else {
      checks.gap_detection = "healthy";
    }

    // Check replay queue
    if (pendingReplayRanges > 10) { // Many pending ranges might indicate issues
      checks.replay_queue = "warning";
    } else {
      checks.replay_queue = "healthy";
    }

  } catch (error) {
    console.error("Indexer status check failed:", error);
    checks.indexer_status = "unhealthy";
    allHealthy = false;
  }

  // Get detailed replay queue information for diagnostics
  let replayQueueDetails: any[] = [];
  try {
    const queueItems = getReplayQueueItems(NETWORK);
    replayQueueDetails = queueItems.slice(0, 10).map(item => ({
      id: item.id,
      from_ledger: item.from_ledger,
      to_ledger: item.to_ledger,
      status: item.status,
      retry_count: item.retry_count,
      started_at: item.started_at ? new Date(item.started_at * 1000).toISOString() : null,
      error_message: item.error_message || null
    }));
  } catch (error) {
    console.error("Failed to get replay queue details:", error);
  }

  const status = {
    ok: allHealthy,
    timestamp: new Date().toISOString(),
    checks,
    indexer: {
      network: NETWORK,
      checkpoint_ledger: getCheckpoint(NETWORK),
      indexer_lag_ledgers: indexerLag,
      pending_replay_ranges: pendingReplayRanges,
      last_gap_detected_at: lastGapDetectedAt,
      gap_detection: {
        is_healthy: gapDetectionHealth?.isHealthy || false,
        status: gapDetectionHealth?.status || 'unknown',
        time_since_last_check: gapDetectionHealth?.timeSinceLastCheck || null
      },
      replay_queue: {
        pending_count: pendingReplayRanges,
        recent_items: replayQueueDetails
      }
    }
  };

  return NextResponse.json(status, {
    status: allHealthy ? 200 : 503,
    headers: {
      "Cache-Control": "no-store",
    },
  });
});
