const TOKEN_KEY = "vestflow-auth-token";
const EXPIRY_KEY = "vestflow-auth-expiry";

export function getStoredToken(): string | null {
  if (typeof window === "undefined") return null;
  const token = localStorage.getItem(TOKEN_KEY);
  const expiry = localStorage.getItem(EXPIRY_KEY);
  if (!token || !expiry) return null;
  if (Date.now() > parseInt(expiry, 10)) {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(EXPIRY_KEY);
    return null;
  }
  return token;
}

export async function authenticateWithWallet(publicKey: string): Promise<string> {
  const res = await fetch("/api/auth/challenge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publicKey }),
  });
  if (!res.ok) throw new Error("Failed to get auth challenge");
  const { challenge } = await res.json();

  const { signTransaction } = await import("@stellar/freighter-api");
  const signed = await signTransaction(challenge, { networkPassphrase: "Test SDF Network ; September 2015" });

  const verifyRes = await fetch("/api/auth/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publicKey, signedChallenge: signed }),
  });
  if (!verifyRes.ok) throw new Error("Authentication failed");
  const { token, expiresAt } = await verifyRes.json();

  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(EXPIRY_KEY, String(expiresAt));
  return token;
}

export function logout(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(EXPIRY_KEY);
}
