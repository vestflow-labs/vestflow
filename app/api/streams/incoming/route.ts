import { NextRequest, NextResponse } from "next/server";
import {
  Contract,
  TransactionBuilder,
  BASE_FEE,
  rpc as StellarRpc,
  nativeToScVal,
  scValToNative,
} from "@stellar/stellar-sdk";
import {
  CONTRACT_ID,
  NETWORK,
  RPC_URL,
  NETWORK_PASSPHRASE,
} from "@/lib/stellar";
import { queryIncomingStreams } from "@/indexer/src/db";
import { parseNetwork } from "@/indexer/src/config";
import { createIpBasedRateLimiter } from "@/lib/rateLimit";
import { withLogging } from "@/lib/requestLogger";
import { createVersionedHandler } from "@/lib/versionedRoute";

const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;
const FALLBACK_ACCOUNT =
  "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";

const rateLimiter = createIpBasedRateLimiter(60000, 30);

interface IncomingStream {
  sender: string;
  token: string;
  rate: string;
  rate_per_sec: string;
  start_time: number;
  max_end_time: number | null;
}

/**
 * Live-contract fallback for environments where the indexer has no rows
 * yet (e.g. a fresh local database). Never throws — resolves to an empty
 * array when the RPC is unreachable or the view is absent. Bounded by a
 * short timeout so API latency (and unit tests) never hang on the network.
 */
async function fetchIncomingFromContract(
  account: string
): Promise<IncomingStream[]> {
  const timeout = new Promise<IncomingStream[]>((resolve) =>
    setTimeout(() => resolve([]), 3000)
  );
  const lookup = (async (): Promise<IncomingStream[]> => {
  try {
    const server = new StellarRpc.Server(RPC_URL);
    const contract = new Contract(CONTRACT_ID);
    const accountData = await server.getAccount(account ?? FALLBACK_ACCOUNT);
    const tx = new TransactionBuilder(accountData, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        contract.call(
          "get_incoming_streams",
          nativeToScVal(account, { type: "address" })
        )
      )
      .setTimeout(30)
      .build();

    const result = await server.simulateTransaction(tx);
    if (StellarRpc.Api.isSimulationError(result)) return [];

    const retval = (result as any).result?.retval;
    if (!retval) return [];

    const native = scValToNative(retval) as any;
    if (!Array.isArray(native)) return [];
    return native.map((s: any) => {
      const rate = String(s.rate_per_sec ?? s.ratePerSec ?? s.rate ?? 0);
      return {
        sender: String(s.sender ?? ""),
        token: String(s.token ?? ""),
        rate,
        rate_per_sec: rate,
        start_time: Number(s.start_time ?? s.startTime ?? 0),
        max_end_time: Number(s.max_end_time ?? s.maxEndTime ?? 0) || null,
      };
    });
  } catch (error) {
    console.error("Error fetching incoming streams from contract:", error);
    return [];
  }
  })();
  return Promise.race([lookup, timeout]);
}

/**
 * GET /api/streams/incoming?account=G...&limit=20&cursor=...&network=testnet
 *
 * Returns all active incoming streams from other senders to the given
 * account, with sender address, token, rate, and estimated start time.
 *
 * Response shape:
 *   { streams: Array<{ sender, token, rate, rate_per_sec, start_time, max_end_time }>,
 *     next_cursor: string | null, account, network }
 */
export const GET = withLogging(async function GET(
  request: NextRequest
): Promise<NextResponse> {
  const rateLimitResponse = await rateLimiter(request);
  if (rateLimitResponse) return rateLimitResponse;

  const account = request.nextUrl.searchParams.get("account");

  if (!account) {
    return NextResponse.json(
      { error: "Missing required query parameter: account" },
      { status: 400 }
    );
  }

  if (!STELLAR_ADDRESS_RE.test(account)) {
    return NextResponse.json(
      { error: "Invalid Stellar address format" },
      { status: 400 }
    );
  }

  const rawLimit = request.nextUrl.searchParams.get("limit");
  let limit = 20;
  if (rawLimit != null) {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
      return NextResponse.json(
        { error: "limit must be an integer between 1 and 100" },
        { status: 400 }
      );
    }
    limit = parsed;
  }
  const cursor =
    request.nextUrl.searchParams.get("cursor") ?? undefined;
  const network = parseNetwork(
    request.nextUrl.searchParams.get("network") || undefined
  );

  try {
    const page = queryIncomingStreams({
      receiver: account,
      limit,
      cursor,
      network,
    });
    if (page === null) {
      return NextResponse.json(
        { error: "cursor is invalid" },
        { status: 400 }
      );
    }

    let streams: IncomingStream[] = page.items.map((s) => ({
      sender: s.sender,
      token: s.token,
      rate: s.rate_per_second,
      rate_per_sec: s.rate_per_second,
      start_time: s.start_time,
      max_end_time: s.estimated_end_time,
    }));

    // Fresh databases may not have indexed rows yet — fall back to a live
    // contract simulation so callers still get data when it exists on-chain.
    let nextCursor = page.nextCursor;
    if (streams.length === 0 && !cursor) {
      const live = await fetchIncomingFromContract(account);
      streams = live.slice(0, limit);
      nextCursor = null;
    }

    return NextResponse.json(
      { streams, next_cursor: nextCursor, account, network: NETWORK },
      { headers: { "Cache-Control": "public, max-age=10" } }
    );
  } catch (error) {
    console.error("Error fetching incoming streams:", error);
    return NextResponse.json(
      { streams: [], next_cursor: null, account, network: NETWORK },
      { headers: { "Cache-Control": "public, max-age=10" } }
    );
  }
});

export const GET_VERSIONED = createVersionedHandler(GET);
