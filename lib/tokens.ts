import { NATIVE_TOKEN } from "./stellar";

export function getTokenSymbol(tokenAddress?: string | null): string {
  if (!tokenAddress) return "XLM";
  if (tokenAddress === NATIVE_TOKEN || tokenAddress === "native" || tokenAddress.toUpperCase() === "XLM") {
    return "XLM";
  }
  // Shorten contract ID if long
  if (tokenAddress.length > 12) {
    return `${tokenAddress.slice(0, 4)}...${tokenAddress.slice(-4)}`;
  }
  return tokenAddress;
}

export function matchesAddressOrToken(
  query: string,
  addresses: (string | null | undefined)[],
  tokens: (string | null | undefined)[],
  labels: (string | null | undefined)[] = []
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;

  // 1. Matches address prefix or substring
  for (const addr of addresses) {
    if (addr && addr.toLowerCase().startsWith(q)) return true;
    if (addr && addr.toLowerCase().includes(q)) return true;
  }

  // 2. Matches token symbol or address
  for (const token of tokens) {
    if (!token) continue;
    const lowerToken = token.toLowerCase();
    const symbol = getTokenSymbol(token).toLowerCase();
    if (lowerToken.startsWith(q) || lowerToken.includes(q)) return true;
    if (symbol.startsWith(q) || symbol.includes(q)) return true;
    if (token === NATIVE_TOKEN && ("xlm".startsWith(q) || "stellar".includes(q))) return true;
  }

  // 3. Matches address book labels
  for (const label of labels) {
    if (label && label.toLowerCase().includes(q)) return true;
  }

  return false;
}
