"use client";
import { createContext, useContext, useState, useEffect, ReactNode } from "react";
import { isConnected } from "@stellar/freighter-api";
import { connectWallet } from "./stellar";

interface WalletCtx { publicKey: string | null; setPublicKey: (k: string | null) => void; }
const WalletContext = createContext<WalletCtx>({ publicKey: null, setPublicKey: () => {} });

const LS_KEY = "vestflow-wallet";

export function WalletProvider({ children }: { children: ReactNode }) {
  const [publicKey, setPublicKeyState] = useState<string | null>(null);

  const setPublicKey = (k: string | null) => {
    setPublicKeyState(k);
    if (k) localStorage.setItem(LS_KEY, k);
    else localStorage.removeItem(LS_KEY);
  };

  useEffect(() => {
    if (process.env.NODE_ENV === "development") {
      (window as any).setPublicKey = setPublicKey;
    }
    const cached = localStorage.getItem(LS_KEY);
    if (cached) setPublicKeyState(cached);
    isConnected().then(connected => {
      if (connected) connectWallet().then(k => {
        setPublicKeyState(k);
        localStorage.setItem(LS_KEY, k);
      }).catch(() => {});
    });
  }, []);

  return <WalletContext.Provider value={{ publicKey, setPublicKey }}>{children}</WalletContext.Provider>;
}

export function useWallet() { return useContext(WalletContext); }
