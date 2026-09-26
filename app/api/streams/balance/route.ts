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
import {
  getOrSetBalanceCache,
  type BalanceCacheValue,
} from "@/indexer/src/balance-cache";

const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;

const emptyBalance = (): BalanceCacheValue => ({
  streamingBalance: "0",
  collectableAmount: "0",
  streamingRatePerSec: "0",
});

async function fetchBalance(
  account: string,
  token: string,
): Promise<BalanceCacheValue> {
  try {
    const server = new StellarRpc.Server(RPC_URL);
    const contract = new Contract(CONTRACT_ID);
    const accountData = await server.getAccount(account);
    const tx = new TransactionBuilder(accountData, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        contract.call(
          "streaming_balance",
          nativeToScVal(account, { type: "address" }),
          nativeToScVal(token, { type: "address" }),
        ),
      )
      .setTimeout(30)
      .build();

    const result = await server.simulateTransaction(tx);
    if (StellarRpc.Api.isSimulationError(result)) return emptyBalance();

    const retval = (result as any).result?.retval;
    if (!retval) return emptyBalance();

    const native = scValToNative(retval) as any;
    return {
      streamingBalance: String(native?.streaming_balance ?? 0),
      collectableAmount: String(native?.collectable_amount ?? 0),
      streamingRatePerSec: String(native?.streaming_rate_per_sec ?? 0),
    };
  } catch (error) {
    console.error("Error fetching streaming balance:", error);
    return emptyBalance();
  }
}

/**
 * GET /api/streams/balance?account=G...&token=G...
 *
 * Returns the live streaming balance for an account/token pair.
 *
 * Response shape:
 *   { streamingBalance: string; collectableAmount: string; streamingRatePerSec: string }
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const account = request.nextUrl.searchParams.get("account");
  const token = request.nextUrl.searchParams.get("token");

  if (!account || !token) {
    return NextResponse.json(
      { error: "Missing required query parameters: account, token" },
      { status: 400 },
    );
  }

  if (!STELLAR_ADDRESS_RE.test(account)) {
    return NextResponse.json(
      { error: "Invalid Stellar address format" },
      { status: 400 },
    );
  }

  const balance = await getOrSetBalanceCache(account, token, NETWORK, () =>
    fetchBalance(account, token),
  );

  return NextResponse.json(balance, {
    headers: { "Cache-Control": "public, max-age=5" },
  });
}
