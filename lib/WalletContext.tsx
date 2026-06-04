"use client";
import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  ReactNode,
} from "react";
import { getAddress, isConnected } from "@stellar/freighter-api";
import { connectWallet } from "./stellar";

interface WalletCtx {
  publicKey: string | null;
  setPublicKey: (k: string | null) => void;
  /** True when the session was lost silently (show reconnect prompt). */
  sessionExpired: boolean;
  /** Dismiss the reconnect prompt without reconnecting. */
  dismissExpired: () => void;
  /** Attempt to reconnect after session expiry. */
  reconnect: () => Promise<void>;
}

const WalletContext = createContext<WalletCtx>({
  publicKey: null,
  setPublicKey: () => {},
  sessionExpired: false,
  dismissExpired: () => {},
  reconnect: async () => {},
});

const LS_KEY = "vestflow-wallet";

/**
 * How often (ms) to silently verify the Freighter session is still alive.
 * 60 s is short enough to catch expiry well before users notice, but cheap
 * because getAddress() is a lightweight local IPC call to the extension.
 */
const HEARTBEAT_INTERVAL_MS = 60_000;

export function WalletProvider({ children }: { children: ReactNode }) {
  const [publicKey, setPublicKeyState] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  // Track whether we intentionally disconnected so the heartbeat doesn't
  // immediately flag it as a silent expiry.
  const intentionalDisconnect = useRef(false);

  const setPublicKey = useCallback((k: string | null) => {
    setPublicKeyState(k);
    if (k) {
      localStorage.setItem(LS_KEY, k);
      intentionalDisconnect.current = false;
    } else {
      localStorage.removeItem(LS_KEY);
      intentionalDisconnect.current = true;
    }
    // Clear any stale expiry banner whenever key changes.
    setSessionExpired(false);
  }, []);

  const dismissExpired = useCallback(() => setSessionExpired(false), []);

  const reconnect = useCallback(async () => {
    try {
      const key = await connectWallet();
      setPublicKey(key);
    } catch {
      // Swallow — user may have dismissed the Freighter popup.
    }
  }, [setPublicKey]);

  // ── Initial mount: restore from localStorage, then verify with extension ──
  useEffect(() => {
    const cached = localStorage.getItem(LS_KEY);
    if (cached) setPublicKeyState(cached);

    // Use getAddress() (not requestAccess) so we never pop a permission
    // dialog on page load. If the extension has an active session it will
    // return the address silently; if not, we clear the stale cached key.
    isConnected().then(async (connected) => {
      if (!connected) {
        // Extension not installed / disabled — clear stale cache silently.
        if (cached) {
          setPublicKeyState(null);
          localStorage.removeItem(LS_KEY);
        }
        return;
      }

      try {
        const result = await getAddress();
        const address = result?.address ?? null;
        if (address) {
          setPublicKeyState(address);
          localStorage.setItem(LS_KEY, address);
        } else if (cached) {
          // Extension present but session already expired at load time.
          setPublicKeyState(null);
          localStorage.removeItem(LS_KEY);
        }
      } catch {
        // getAddress() can throw if the extension rejects silently.
        if (cached) {
          setPublicKeyState(null);
          localStorage.removeItem(LS_KEY);
        }
      }
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Heartbeat: poll Freighter every minute while a session is active ──
  useEffect(() => {
    const check = async () => {
      // Don't run if the user manually disconnected or never connected.
      if (intentionalDisconnect.current) return;

      const currentKey = localStorage.getItem(LS_KEY);
      if (!currentKey) return;

      try {
        const result = await getAddress();
        const liveAddress = result?.address ?? null;

        if (!liveAddress) {
          // Session silently dropped — show reconnect prompt.
          setPublicKeyState(null);
          localStorage.removeItem(LS_KEY);
          setSessionExpired(true);
        } else if (liveAddress !== currentKey) {
          // Account switched inside Freighter — sync the new address.
          setPublicKeyState(liveAddress);
          localStorage.setItem(LS_KEY, liveAddress);
          setSessionExpired(false);
        }
      } catch {
        // If getAddress() throws, treat it as a session drop.
        setPublicKeyState(null);
        localStorage.removeItem(LS_KEY);
        setSessionExpired(true);
      }
    };

    const id = setInterval(check, HEARTBEAT_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  return (
    <WalletContext.Provider
      value={{ publicKey, setPublicKey, sessionExpired, dismissExpired, reconnect }}
    >
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet() {
  return useContext(WalletContext);
}
