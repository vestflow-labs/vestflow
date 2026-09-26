/**
 * Gap Detection Module
 * 
 * Detects missing ledger ranges by comparing the database checkpoint 
 * against Horizon's current ledger. Enqueues gaps for replay processing.
 * 
 * Key responsibilities:
 * - Startup gap detection when indexer starts
 * - Periodic gap detection to catch live polling failures
 * - Horizon API integration to get current ledger
 * - Gap range calculation and queuing
 */

import { parseNetwork, getNetworkConfig, type NetworkName } from "./config";
import { 
  getCheckpoint, 
  enqueueReplayRange, 
  logGapDetection, 
  getLastGapDetection,
  type GapDetectionLogEntry 
} from "./db";

// Horizon API endpoints by network
const HORIZON_URLS: Record<NetworkName, string> = {
  testnet: "https://horizon-testnet.stellar.org",
  mainnet: "https://horizon.stellar.org"
};

export interface GapDetectionResult {
  lastCheckpoint: number;
  currentLedger: number;
  gaps: Array<{ from: number; to: number }>;
  gapsDetected: number;
}

export interface GapDetectionConfig {
  network?: NetworkName;
  horizonUrl?: string;
  maxGapSize?: number;        // Split large gaps into smaller chunks
  minGapSize?: number;        // Ignore very small gaps (e.g., 1-2 ledgers)
  timeoutMs?: number;         // HTTP request timeout
}

/**
 * Fetch the current ledger sequence from Horizon
 */
export async function getCurrentLedgerFromHorizon(
  horizonUrl: string, 
  timeoutMs = 30000
): Promise<number> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${horizonUrl}/ledgers?order=desc&limit=1`, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'VestFlow-Indexer/1.0'
      }
    });

    if (!response.ok) {
      throw new Error(`Horizon API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as {
      _embedded?: { records?: Array<{ sequence?: unknown }> };
    };
    const records = data._embedded?.records;
    
    if (!Array.isArray(records) || records.length === 0) {
      throw new Error('No ledgers found in Horizon response');
    }

    const currentLedger = records[0]?.sequence;
    if (typeof currentLedger !== 'number' || currentLedger <= 0) {
      throw new Error('Invalid ledger sequence in Horizon response');
    }

    return currentLedger;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to fetch current ledger from Horizon: ${error.message}`);
    }
    throw new Error('Failed to fetch current ledger from Horizon: Unknown error');
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Split a large gap into smaller, manageable chunks
 */
function splitGapIntoChunks(
  fromLedger: number, 
  toLedger: number, 
  maxChunkSize: number
): Array<{ from: number; to: number }> {
  const chunks: Array<{ from: number; to: number }> = [];
  let start = fromLedger;
  
  while (start <= toLedger) {
    const end = Math.min(start + maxChunkSize - 1, toLedger);
    chunks.push({ from: start, to: end });
    start = end + 1;
  }
  
  return chunks;
}

/**
 * Detect gaps between the database checkpoint and current Horizon ledger
 */
export async function detectGaps(config: GapDetectionConfig = {}): Promise<GapDetectionResult> {
  const network = config.network ?? parseNetwork(process.env.INDEXER_NETWORK);
  const horizonUrl = config.horizonUrl ?? HORIZON_URLS[network];
  const maxGapSize = config.maxGapSize ?? 10000;   // Split gaps larger than 10k ledgers
  const minGapSize = config.minGapSize ?? 1;       // Process all gaps by default
  const timeoutMs = config.timeoutMs ?? 30000;

  console.log(`[gap-detector] Starting gap detection for ${network} network`);
  
  // Get current state
  const lastCheckpoint = getCheckpoint(network);
  const currentLedger = await getCurrentLedgerFromHorizon(horizonUrl, timeoutMs);
  
  console.log(`[gap-detector] Checkpoint: ${lastCheckpoint}, Current: ${currentLedger}`);
  
  const gaps: Array<{ from: number; to: number }> = [];
  
  // Calculate gap range
  if (currentLedger > lastCheckpoint) {
    const gapStart = lastCheckpoint + 1;
    const gapEnd = currentLedger - 1; // Don't include the current ledger in replay
    const gapSize = gapEnd - gapStart + 1;
    
    if (gapSize >= minGapSize) {
      console.log(`[gap-detector] Gap detected: ledgers ${gapStart} to ${gapEnd} (${gapSize} ledgers)`);
      
      // Split large gaps into manageable chunks
      if (gapSize > maxGapSize) {
        const chunks = splitGapIntoChunks(gapStart, gapEnd, maxGapSize);
        console.log(`[gap-detector] Splitting gap into ${chunks.length} chunks of max ${maxGapSize} ledgers`);
        gaps.push(...chunks);
      } else {
        gaps.push({ from: gapStart, to: gapEnd });
      }
    } else if (gapSize > 0) {
      console.log(`[gap-detector] Gap too small to process: ${gapSize} ledgers (min: ${minGapSize})`);
    }
  } else if (currentLedger < lastCheckpoint) {
    console.warn(
      `[gap-detector] WARNING: Current ledger (${currentLedger}) is behind checkpoint (${lastCheckpoint}). ` +
      'This could indicate a chain rollback or Horizon API issue.'
    );
  } else {
    console.log(`[gap-detector] No gap detected - indexer is up to date`);
  }
  
  // Enqueue gaps for replay
  let enqueuedCount = 0;
  for (const gap of gaps) {
    try {
      const queueId = enqueueReplayRange(gap.from, gap.to, network);
      console.log(`[gap-detector] Enqueued gap ${gap.from}-${gap.to} as replay queue item #${queueId}`);
      enqueuedCount++;
    } catch (error) {
      console.error(`[gap-detector] Failed to enqueue gap ${gap.from}-${gap.to}:`, error);
    }
  }
  
  // Log the detection run
  try {
    logGapDetection(lastCheckpoint, currentLedger, enqueuedCount, network);
  } catch (error) {
    console.error('[gap-detector] Failed to log gap detection:', error);
  }
  
  console.log(`[gap-detector] Gap detection complete: ${enqueuedCount} ranges enqueued for replay`);
  
  return {
    lastCheckpoint,
    currentLedger,
    gaps,
    gapsDetected: enqueuedCount
  };
}

/**
 * Run startup gap detection - more comprehensive check when indexer starts
 */
export async function runStartupGapDetection(config: GapDetectionConfig = {}): Promise<GapDetectionResult> {
  console.log('[gap-detector] Running startup gap detection...');
  
  const lastDetection = getLastGapDetection(config.network);
  if (lastDetection) {
    const timeSinceLastCheck = Math.floor(Date.now() / 1000) - lastDetection.checked_at;
    console.log(`[gap-detector] Last gap detection was ${timeSinceLastCheck} seconds ago`);
  }
  
  try {
    const result = await detectGaps({
      ...config,
      minGapSize: 1,  // On startup, process even single-ledger gaps
    });
    
    if (result.gapsDetected > 0) {
      console.log(
        `[gap-detector] Startup gap detection found ${result.gapsDetected} gap(s) ` +
        `spanning ${result.currentLedger - result.lastCheckpoint} ledgers`
      );
    } else {
      console.log('[gap-detector] Startup gap detection: indexer is current');
    }
    
    return result;
  } catch (error) {
    console.error('[gap-detector] Startup gap detection failed:', error);
    throw error;
  }
}

/**
 * Run periodic gap detection - lighter check during normal operation
 */
export async function runPeriodicGapDetection(config: GapDetectionConfig = {}): Promise<GapDetectionResult> {
  try {
    const result = await detectGaps({
      ...config,
      minGapSize: 2,      // During operation, ignore single ledger gaps (likely race conditions)
      timeoutMs: 10000,   // Shorter timeout for periodic checks
    });
    
    if (result.gapsDetected > 0) {
      console.warn(
        `[gap-detector] Periodic check found ${result.gapsDetected} gap(s) - ` +
        'this may indicate the live poller is missing events'
      );
    }
    
    return result;
  } catch (error) {
    console.error('[gap-detector] Periodic gap detection failed:', error);
    // Don't throw - periodic failures shouldn't crash the indexer
    return {
      lastCheckpoint: getCheckpoint(config.network),
      currentLedger: 0,
      gaps: [],
      gapsDetected: 0
    };
  }
}

/**
 * Get gap detection health status for monitoring
 */
export function getGapDetectionHealth(network?: NetworkName): {
  lastDetection: GapDetectionLogEntry | null;
  timeSinceLastCheck: number | null;
  isHealthy: boolean;
  status: string;
} {
  const lastDetection = getLastGapDetection(network);
  
  if (!lastDetection) {
    return {
      lastDetection: null,
      timeSinceLastCheck: null,
      isHealthy: false,
      status: 'No gap detection runs recorded'
    };
  }
  
  const now = Math.floor(Date.now() / 1000);
  const timeSinceLastCheck = now - lastDetection.checked_at;
  
  // Consider unhealthy if no gap detection in the last 5 minutes
  const isHealthy = timeSinceLastCheck < 300;
  
  return {
    lastDetection,
    timeSinceLastCheck,
    isHealthy,
    status: isHealthy 
      ? 'Gap detection is current'
      : `Last gap detection was ${Math.floor(timeSinceLastCheck / 60)} minutes ago`
  };
}