import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  Contract,
  TransactionBuilder,
  BASE_FEE,
  rpc as StellarRpc,
} from "@stellar/stellar-sdk";
import {
  CONTRACT_ID,
  NETWORK,
  RPC_URL,
  NETWORK_PASSPHRASE,
} from "@/lib/stellar";
import { createIpBasedRateLimiter } from "@/lib/rateLimit";
import { withLogging } from "@/lib/requestLogger";
import { createVersionedHandler } from "@/lib/versionedRoute";

const rateLimiter = createIpBasedRateLimiter(60000, 30);

const STELLAR_ACCOUNT_RE = /^G[A-Z2-7]{55}$/;
// Issued asset contract IDs are C-addresses; native XLM wraps as a C-address too.
const TOKEN_RE = /^[GC][A-Z2-7]{55}$/;
const SECONDS_PER_DAY = 86400;

// Short-lived cache: identical configs within 5s reuse the same result.
const CACHE_TTL_MS = 5000;
interface CacheEntry {
  expiresAt: number;
  body: Record<string, unknown>;
}
const simulateCache = new Map<string, CacheEntry>();

function configHash(canonical: string): string {
  return createHash("sha256").update(canonical).digest("hex");
}

function getCached(hash: string): Record<string, unknown> | null {
  const entry = simulateCache.get(hash);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    simulateCache.delete(hash);
    return null;
  }
  return entry.body;
}

function setCached(hash: string, body: Record<string, unknown>): void {
  simulateCache.set(hash, { expiresAt: Date.now() + CACHE_TTL_MS, body });
  if (simulateCache.size > 500) {
    const oldest = simulateCache.keys().next().value;
    if (oldest) simulateCache.delete(oldest);
  }
}

interface ReceiverInput {
  address?: unknown;
  share?: unknown;
  rate_per_sec?: unknown;
}

/**
 * Estimate the submission fee with a read-only Soroban simulation.
 * No state is changed: we simulate a lightweight view call and derive the
 * fee from the simulation's resource footprint, falling back to BASE_FEE
 * when the RPC is unreachable.
 */
async function estimateFeeViaSimulation(sender: string): Promise<string> {
  const fallback = String(BASE_FEE);
  try {
    const estimate = (async (): Promise<string> => {
      const server = new StellarRpc.Server(RPC_URL);
      const contract = new Contract(CONTRACT_ID);
      const account = await server.getAccount(sender);
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(contract.call("schedule_count"))
        .setTimeout(30)
        .build();

      const result = await server.simulateTransaction(tx);
      if (StellarRpc.Api.isSimulationError(result)) return fallback;
      const sim = result as unknown as {
        minResourceFee?: string | number;
      };
      if (sim.minResourceFee != null) return String(sim.minResourceFee);
      return fallback;
    })();
    const timeout = new Promise<string>((resolve) =>
      setTimeout(() => resolve(fallback), 3000)
    );
    return await Promise.race([estimate, timeout]);
  } catch (error) {
    console.error("Error estimating simulate fee:", error);
    return fallback;
  }
}

/**
 * POST /api/streams/simulate
 *
 * Preview stream state without submitting anything on-chain.
 *
 * Body:
 *   { sender: "G...",
 *     token: "C...",
 *     balance: "1000000000",        // stroops, decimal string
 *     receivers: [{ address: "G...", share: 1 }] }
 *
 * - `share` is a relative weight (defaults to 1, equal split).
 * - Alternatively each receiver may carry `rate_per_sec` directly.
 *
 * Response:
 *   { max_end_time, receivers: [{ address, daily_amount }], estimated_fee,
 *     cached: boolean }
 */
export const POST = withLogging(async function POST(
  request: NextRequest
): Promise<NextResponse> {
  const rateLimitResponse = await rateLimiter(request);
  if (rateLimitResponse) return rateLimitResponse;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON" },
      { status: 400 }
    );
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json(
      { error: "Request body must be a JSON object" },
      { status: 400 }
    );
  }

  const { sender, token, receivers, balance } = body as Record<string, unknown>;

  if (typeof sender !== "string" || !STELLAR_ACCOUNT_RE.test(sender)) {
    return NextResponse.json(
      { error: "Invalid sender: must be a Stellar G-address" },
      { status: 400 }
    );
  }
  if (typeof token !== "string" || !TOKEN_RE.test(token)) {
    return NextResponse.json(
      { error: "Invalid token: must be a Stellar contract/token address" },
      { status: 400 }
    );
  }
  if (!Array.isArray(receivers) || receivers.length === 0) {
    return NextResponse.json(
      { error: "Invalid receivers: must be a non-empty array" },
      { status: 400 }
    );
  }
  if (receivers.length > 100) {
    return NextResponse.json(
      { error: "Invalid receivers: at most 100 receivers supported" },
      { status: 400 }
    );
  }

  let balanceStroops: bigint;
  try {
    if (typeof balance !== "string" && typeof balance !== "number") {
      throw new Error("bad balance");
    }
    balanceStroops = BigInt(String(balance));
    if (balanceStroops <= 0n) throw new Error("bad balance");
  } catch {
    return NextResponse.json(
      { error: "Invalid balance: must be a positive integer string (stroops)" },
      { status: 400 }
    );
  }

  const parsedReceivers: { address: string; weight: number }[] = [];
  const seen = new Set<string>();
  for (const entry of receivers as ReceiverInput[]) {
    if (typeof entry !== "object" || entry === null) {
      return NextResponse.json(
        { error: "Invalid receivers: each entry must be an object" },
        { status: 400 }
      );
    }
    const address = (entry as Record<string, unknown>).address;
    if (typeof address !== "string" || !STELLAR_ACCOUNT_RE.test(address)) {
      return NextResponse.json(
        { error: "Invalid receivers: each entry needs a valid address" },
        { status: 400 }
      );
    }
    if (seen.has(address)) {
      return NextResponse.json(
        { error: "Invalid receivers: duplicate addresses are not allowed" },
        { status: 400 }
      );
    }
    seen.add(address);

    const rawShare = (entry as Record<string, unknown>).share;
    const rawRate = (entry as Record<string, unknown>).rate_per_sec;
    let weight = 1;
    if (rawShare != null) {
      const share = Number(rawShare);
      if (!Number.isFinite(share) || share <= 0) {
        return NextResponse.json(
          { error: "Invalid receivers: share must be a positive number" },
          { status: 400 }
        );
      }
      weight = share;
    } else if (rawRate != null) {
      const rate = Number(rawRate);
      if (!Number.isFinite(rate) || rate <= 0) {
        return NextResponse.json(
          { error: "Invalid receivers: rate_per_sec must be a positive number" },
          { status: 400 }
        );
      }
      weight = rate;
    }
    parsedReceivers.push({ address, weight });
  }

  const canonical = JSON.stringify({
    sender,
    token,
    balance: balanceStroops.toString(),
    receivers: parsedReceivers
      .slice()
      .sort((a, b) => (a.address < b.address ? -1 : 1)),
  });
  const hash = configHash(canonical);
  const cached = getCached(hash);
  if (cached) {
    return NextResponse.json(
      { ...cached, cached: true },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  const totalWeight = parsedReceivers.reduce((sum, r) => sum + r.weight, 0);
  const now = Math.floor(Date.now() / 1000);

  // Pro-rata split of the balance across receivers (remainder to the last
  // receiver so the parts always sum to the full balance).
  const totalWeightMicro = BigInt(Math.floor(totalWeight * 1e6));
  let allocated = 0n;
  const receiverAmounts = parsedReceivers.map((r, index) => {
    const isLast = index === parsedReceivers.length - 1;
    const amount = isLast
      ? balanceStroops - allocated
      : (balanceStroops * BigInt(Math.floor(r.weight * 1e6))) /
        totalWeightMicro;
    allocated += amount;
    return { address: r.address, amount };
  });

  // Horizon: assume the sender streams the whole balance at the aggregate
  // configured rate when explicit rates are given, otherwise project a
  // 30-day linear distribution for share-based configs.
  const hasExplicitRates = (receivers as ReceiverInput[]).every(
    (r) =>
      typeof r === "object" &&
      r !== null &&
      (r as Record<string, unknown>).rate_per_sec != null
  );
  let maxEndTime: number;
  if (hasExplicitRates) {
    const totalRatePerSec = (receivers as ReceiverInput[]).reduce(
      (sum, r) =>
        sum + Number((r as Record<string, unknown>).rate_per_sec),
      0
    );
    maxEndTime =
      totalRatePerSec > 0
        ? now + Math.floor(Number(balanceStroops) / totalRatePerSec)
        : now + 30 * SECONDS_PER_DAY;
  } else {
    maxEndTime = now + 30 * SECONDS_PER_DAY;
  }

  const perReceiver = receiverAmounts.map(({ address, amount }) => ({
    address,
    daily_amount: ((amount * BigInt(SECONDS_PER_DAY)) / BigInt(30 * SECONDS_PER_DAY)).toString(),
    total_amount: amount.toString(),
  }));

  const estimatedFee = await estimateFeeViaSimulation(sender);

  const responseBody = {
    sender,
    token,
    balance: balanceStroops.toString(),
    max_end_time: maxEndTime,
    receivers: perReceiver,
    estimated_fee: estimatedFee,
    network: NETWORK,
  };
  setCached(hash, responseBody);

  return NextResponse.json(
    { ...responseBody, cached: false },
    { headers: { "Cache-Control": "no-store" } }
  );
});

export const POST_VERSIONED = createVersionedHandler(POST);
