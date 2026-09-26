// Pure XLM <-> stroops conversion, kept free of wallet/RPC imports so it can
// be safely imported from contexts without `window` (e.g. a Web Worker).

export function xlmToStroops(amountXlm: string): bigint {
  const normalized = amountXlm.trim();
  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(normalized)) {
    throw new Error("Invalid amount");
  }

  const [whole, fraction = ""] = normalized.split(".");
  const fractionPadded = (fraction + "0000000").slice(0, 7);
  return BigInt(whole) * 10_000_000n + BigInt(fractionPadded);
}

/**
 * Convert a decimal token amount into its integer base units.
 *
 * Stellar assets carry 7 decimal places, the same scale as stroops for the
 * native token, so `xlmToStroops` is this helper's `decimals = 7` case. The
 * vestflow contract takes `i128` amounts, and 7 dp is the scale it expects for
 * every token, which is why the default is 7 rather than a per-token lookup.
 */
export function tokenAmountToBaseUnits(amount: string, decimals = 7): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error("Invalid decimals");
  }

  const normalized = amount.trim();
  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(normalized)) {
    throw new Error("Invalid amount");
  }

  const scale = 10n ** BigInt(decimals);
  const [whole, fraction = ""] = normalized.split(".");
  const fractionPadded = (fraction + "0".repeat(decimals)).slice(0, decimals || 1);
  return BigInt(whole) * scale + BigInt(fractionPadded || "0");
}
