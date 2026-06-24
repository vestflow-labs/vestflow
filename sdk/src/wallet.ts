// ===========================================================================
// VestFlow SDK — Wallet
// Issue #95: @vestflow/sdk
//
// Freighter wallet helpers. Only works in browser environments where
// @stellar/freighter-api is installed as a peer dependency.
// ===========================================================================

/**
 * Connect to the Freighter browser extension and return the user's
 * Stellar public key.
 *
 * Requires @stellar/freighter-api to be installed in the host project.
 *
 * @throws if Freighter is not installed or access is denied
 */
export async function connectWallet(): Promise<string> {
  const freighter = await import("@stellar/freighter-api");
  const connected = await freighter.isConnected();
  if (!connected) throw new Error("Freighter not found. Install from freighter.app");
  await freighter.requestAccess();
  const result = await freighter.getAddress();
  if (!result?.address) throw new Error("Could not get address from Freighter");
  return result.address;
}
