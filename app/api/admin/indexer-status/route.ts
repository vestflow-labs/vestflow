/**
 * Admin endpoint for detailed indexer status including gap detection and replay diagnostics.
 * This provides more detailed information than the basic health endpoint.
 */

import { NextRequest, NextResponse } from "next/server";
import { 
  getDb, 
  getCheckpoint, 
  getPendingReplayCount, 
  getReplayQueueItems, 
  getLastGapDetection,
  type ReplayQueueItem 
} from "@/indexer/src/db";
import { 
  getGapDetectionHealth, 
  getCurrentLedgerFromHorizon,
  type GapDetectionConfig 
} from "@/indexer/src/gap-detector";
import { parseNetwork, getNetworkConfig } from "@/indexer/src/config";
import { withLogging } from "@/lib/requestLogger";

const NETWORK = parseNetwork(process.env.NEXT_PUBLIC_NETWORK);

export const GET = withLogging(async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const { searchParams } = new URL(request.url);
    const includeQueueDetails = searchParams.get('queue_details') === 'true';
    const queueLimit = parseInt(searchParams.get('queue_limit') || '50');

    // Basic indexer status
    const checkpoint = getCheckpoint(NETWORK);
    const pendingReplays = getPendingReplayCount(NETWORK);
    const lastGapDetection = getLastGapDetection(NETWORK);
    const gapDetectionHealth = getGapDetectionHealth(NETWORK);

    // Get current Horizon ledger for lag calculation
    let currentLedger = 0;
    let horizonError: string | null = null;
    try {
      const config = getNetworkConfig(NETWORK);
      const horizonUrl = NETWORK === "mainnet" 
        ? "https://horizon.stellar.org" 
        : "https://horizon-testnet.stellar.org";
      currentLedger = await getCurrentLedgerFromHorizon(horizonUrl, 10000);
    } catch (error) {
      horizonError = error instanceof Error ? error.message : String(error);
    }

    const indexerLag = currentLedger > 0 ? Math.max(0, currentLedger - checkpoint) : 0;

    // Replay queue summary statistics
    const allQueueItems = getReplayQueueItems(NETWORK);
    const queueStats = {
      total: allQueueItems.length,
      pending: allQueueItems.filter(item => item.status === 'pending').length,
      in_progress: allQueueItems.filter(item => item.status === 'in_progress').length,
      completed: allQueueItems.filter(item => item.status === 'completed').length,
      failed: allQueueItems.filter(item => item.status === 'failed').length,
    };

    // Calculate ledger ranges being processed
    const pendingLedgers = allQueueItems
      .filter(item => item.status === 'pending' || item.status === 'in_progress')
      .reduce((sum, item) => sum + (item.to_ledger - item.from_ledger + 1), 0);

    // Recent gap detection history
    const recentGapDetections: any[] = [];
    try {
      const db = getDb(NETWORK);
      const rows = db
        .prepare("SELECT * FROM gap_detection_log ORDER BY checked_at DESC LIMIT 10")
        .all() as any[];
      
      recentGapDetections.push(...rows.map(row => ({
        ...row,
        checked_at: new Date(row.checked_at * 1000).toISOString(),
        gap_size: row.current_ledger - row.last_checkpoint
      })));
    } catch (error) {
      console.error("Failed to get gap detection history:", error);
    }

    // Detailed queue information (optional)
    let queueDetails: any[] = [];
    if (includeQueueDetails) {
      queueDetails = allQueueItems
        .slice(0, queueLimit)
        .map(item => ({
          id: item.id,
          from_ledger: item.from_ledger,
          to_ledger: item.to_ledger,
          ledger_count: item.to_ledger - item.from_ledger + 1,
          status: item.status,
          retry_count: item.retry_count,
          completed_ledger: item.completed_ledger,
          progress_percent: item.completed_ledger 
            ? Math.round(((item.completed_ledger - item.from_ledger) / (item.to_ledger - item.from_ledger)) * 100)
            : 0,
          created_at: new Date(item.created_at * 1000).toISOString(),
          started_at: item.started_at ? new Date(item.started_at * 1000).toISOString() : null,
          completed_at: item.completed_at ? new Date(item.completed_at * 1000).toISOString() : null,
          error_message: item.error_message,
          duration_ms: item.started_at && item.completed_at 
            ? (item.completed_at - item.started_at) * 1000 
            : null
        }));
    }

    const response = {
      timestamp: new Date().toISOString(),
      network: NETWORK,
      
      // Current state
      indexer: {
        checkpoint_ledger: checkpoint,
        current_ledger: currentLedger,
        indexer_lag_ledgers: indexerLag,
        indexer_lag_healthy: indexerLag < 100,
        horizon_error: horizonError
      },

      // Gap detection status
      gap_detection: {
        is_healthy: gapDetectionHealth.isHealthy,
        status: gapDetectionHealth.status,
        last_check_at: gapDetectionHealth.lastDetection 
          ? new Date(gapDetectionHealth.lastDetection.checked_at * 1000).toISOString() 
          : null,
        time_since_last_check_seconds: gapDetectionHealth.timeSinceLastCheck,
        recent_detections: recentGapDetections
      },

      // Replay queue status
      replay_queue: {
        statistics: queueStats,
        pending_ledgers: pendingLedgers,
        is_healthy: queueStats.failed < 3 && pendingLedgers < 50000, // Configurable thresholds
        details: includeQueueDetails ? queueDetails : undefined
      }
    };

    return NextResponse.json(response, {
      headers: {
        "Cache-Control": "no-store",
      },
    });

  } catch (error) {
    console.error("Indexer status check failed:", error);
    return NextResponse.json(
      {
        error: "Failed to get indexer status",
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      },
      {
        status: 500,
        headers: {
          "Cache-Control": "no-store",
        },
      }
    );
  }
});

/**
 * POST endpoint for administrative actions
 */
export const POST = withLogging(async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.json();
    const { action } = body;

    switch (action) {
      case 'trigger_gap_detection':
        // This would trigger a manual gap detection run
        // For now, just return success - the actual implementation would
        // need to integrate with the running poller process
        return NextResponse.json({ 
          success: true, 
          message: "Gap detection triggered (manual trigger not yet implemented)" 
        });

      case 'clear_failed_replays':
        // Clear failed replay entries older than 24 hours
        try {
          const db = getDb(NETWORK);
          const cutoff = Math.floor(Date.now() / 1000) - (24 * 60 * 60);
          const result = db
            .prepare("DELETE FROM replay_queue WHERE status = 'failed' AND completed_at < ?")
            .run(cutoff);
          
          return NextResponse.json({ 
            success: true, 
            message: `Cleared ${result.changes} failed replay entries` 
          });
        } catch (error) {
          throw new Error(`Failed to clear failed replays: ${error}`);
        }

      case 'retry_failed_replays':
        // Reset failed replays to pending status
        try {
          const db = getDb(NETWORK);
          const result = db
            .prepare(
              `UPDATE replay_queue 
               SET status = 'pending', error_message = NULL, retry_count = 0, started_at = NULL, completed_at = NULL
               WHERE status = 'failed'`
            )
            .run();
          
          return NextResponse.json({ 
            success: true, 
            message: `Reset ${result.changes} failed replays to pending` 
          });
        } catch (error) {
          throw new Error(`Failed to retry failed replays: ${error}`);
        }

      default:
        return NextResponse.json(
          { error: "Unknown action", action },
          { status: 400 }
        );
    }

  } catch (error) {
    console.error("Admin action failed:", error);
    return NextResponse.json(
      {
        error: "Action failed",
        message: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
});