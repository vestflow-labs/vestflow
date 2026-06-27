import { NextResponse } from "next/server";
import { rpc as StellarRpc } from "@stellar/stellar-sdk";
import { getDb } from "@/indexer/src/db";

const RPC_URL = process.env.NEXT_PUBLIC_NETWORK === "mainnet"
  ? "https://mainnet.sorobanrpc.com"
  : "https://soroban-testnet.stellar.org";

export async function GET(): Promise<NextResponse> {
  const checks: Record<string, string> = {};
  let allHealthy = true;

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
    const server = new StellarRpc.Server(RPC_URL);
    await server.getLatestLedger();
    checks.rpc = "healthy";
  } catch (error) {
    console.error("RPC check failed:", error);
    checks.rpc = "unhealthy";
    allHealthy = false;
  }

  const status = {
    ok: allHealthy,
    timestamp: new Date().toISOString(),
    checks,
  };

  return NextResponse.json(status, {
    status: allHealthy ? 200 : 503,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
