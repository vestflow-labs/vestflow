import { NextRequest, NextResponse } from "next/server";
import {
  Contract,
  TransactionBuilder,
  BASE_FEE,
  rpc as StellarRpc,
  nativeToScVal,
  scValToNative,
} from "@stellar/stellar-sdk";
import { createIpBasedRateLimiter } from "@/lib/rateLimit";
import {
  CONTRACT_ID,
  NETWORK,
  RPC_URL,
  NETWORK_PASSPHRASE,
} from "@/lib/stellar";

/**
 * GET /api/splits?account=G...
 *
 * Returns the current splits configuration for a Stellar address.
 *
 * Response shape:
 *   { receivers: Array<{ receiver: string; weight_bps: number }>, hash: string }
 *
 * - 200 with the splits config when found
 * - 200 with `{ receivers: [], hash: "0x0000000000000000000000000000000000000000000000000000000000000000" }` when not configured
 * - 400 when `account` is missing or not a valid Stellar public key
 * - 500 on unexpected errors
 */

const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;

// Canonical zero hash returned when the account has no splits configured.
const ZERO_HASH =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

// Well-known funded testnet account used as fallback source for simulations.
const FALLBACK_ACCOUNT =
  "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";

const rateLimiter = createIpBasedRateLimiter(60_000, 30);

interface SplitReceiver {
  receiver: string;
  weight_bps: number;
}

interface SplitsConfig {
  receivers: SplitReceiver[];
  hash: string;
}

async function getSplitsFromContract(account: string): Promise<SplitsConfig> {
  const server = new StellarRpc.Server(RPC_URL);
  const contract = new Contract(CONTRACT_ID);
  const source = account ?? FALLBACK_ACCOUNT;

  const accountData = await server.getAccount(source);
  const tx = new TransactionBuilder(accountData, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      contract.call(
        "get_splits",
        nativeToScVal(account, { type: "address" })
      )
    )
    .setTimeout(30)
    .build();

  const result = await server.simulateTransaction(tx);

  if (StellarRpc.Api.isSimulationError(result)) {
    // Contract returns an error when the account has no splits configured —
    // treat it as an empty config rather than a server error.
    return { receivers: [], hash: ZERO_HASH };
  }

  const retval = (result as any).result?.retval;
  if (!retval) {
    return { receivers: [], hash: ZERO_HASH };
  }

  const native = scValToNative(retval) as any;
  if (!native) {
    return { receivers: [], hash: ZERO_HASH };
  }

  // The contract returns a map/struct with `receivers` (Vec of {receiver, weight_bps})
  // and `hash` (Bytes32). Normalise defensively.
  const receivers: SplitReceiver[] = Array.isArray(native.receivers)
    ? (native.receivers as any[]).map((r: any) => ({
        receiver: String(r.receiver ?? r.address ?? ""),
        weight_bps: Number(r.weight_bps ?? r.bps ?? 0),
      }))
    : [];

  const hash: string = native.hash
    ? `0x${Buffer.from(native.hash).toString("hex")}`
    : ZERO_HASH;

  return { receivers, hash };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
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

  try {
    const splits = await getSplitsFromContract(account);

    return NextResponse.json(
      { ...splits, account, network: NETWORK },
      {
        headers: {
          "Cache-Control": "public, max-age=30, stale-while-revalidate=120",
        },
      }
    );
  } catch (error) {
    console.error("Error fetching splits config:", error);
    return NextResponse.json(
      { error: "Failed to fetch splits configuration" },
      { status: 500 }
    );
  }
}
