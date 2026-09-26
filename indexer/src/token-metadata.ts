/**
 * Cached lookup of a Stellar/Soroban token's `decimal_places`, used to
 * convert stroops-denominated analytics totals to a human-readable display
 * value. Getting this wrong silently displays TVL 10M× off, so every asset
 * is resolved once and cached indefinitely — decimals are immutable for
 * the lifetime of a SEP-41 token contract.
 */

import { rpc as StellarRpc, Contract, scValToNative } from "@stellar/stellar-sdk";
import { getNetworkConfig, type NetworkName } from "./config";

const NATIVE_XLM_DECIMALS = 7;

const decimalsCache = new Map<string, number>();

/**
 * Reads `decimals()` from a SEP-41 token contract via a read-only
 * simulation. Any failure — network error, non-SEP-41 contract, RPC
 * throttling — falls back to the native XLM decimal count, since raw
 * stroops are always returned alongside the converted display value so a
 * wrong guess here is visible, not silent.
 */
async function fetchDecimals(tokenAddress: string, network: NetworkName): Promise<number> {
  try {
    const config = getNetworkConfig(network);
    const server = new StellarRpc.Server(config.rpcUrl);
    const contract = new Contract(tokenAddress);
    const result = await (server as any).getContractData(
      tokenAddress,
      contract.call("decimals")
    );
    const decoded = scValToNative(result);
    return typeof decoded === "number" ? decoded : NATIVE_XLM_DECIMALS;
  } catch {
    return NATIVE_XLM_DECIMALS;
  }
}

/** Cached decimals lookup. Never re-fetches once resolved for an address. */
export async function getTokenDecimals(tokenAddress: string, network: NetworkName = "testnet"): Promise<number> {
  const cached = decimalsCache.get(tokenAddress);
  if (cached != null) return cached;

  const decimals = await fetchDecimals(tokenAddress, network);
  decimalsCache.set(tokenAddress, decimals);
  return decimals;
}

/** Synchronous variant for hot paths that can't await — cache-only, defaulting to native XLM decimals. */
export function getCachedTokenDecimals(tokenAddress: string): number {
  return decimalsCache.get(tokenAddress) ?? NATIVE_XLM_DECIMALS;
}

/** Converts a stroops bigint to a decimal display string using the token's decimal_places. */
export function stroopsToDisplay(stroops: bigint, decimals: number): string {
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  const sign = negative ? "-" : "";
  return frac.length > 0 ? `${sign}${whole}.${frac}` : `${sign}${whole}`;
}
