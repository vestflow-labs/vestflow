"use client";
import { ReactNode } from "react";
import { useWallet } from "@/lib/WalletContext";
import { connectWallet } from "@/lib/stellar";
import { useToast } from "@/components/Toast";

interface WalletConnectionGuardProps {
  children: (props: { onClick: () => Promise<void> | void }) => ReactNode;
  onAction: () => Promise<void> | void;
  actionName?: string;
}

/**
 * WalletConnectionGuard wraps write actions and ensures wallet is connected.
 * If not connected, shows "Connect Wallet" button instead of the action.
 * After connection, automatically triggers the intended action.
 */
export default function WalletConnectionGuard({
  children,
  onAction,
  actionName = "this action",
}: WalletConnectionGuardProps) {
  const { publicKey, setPublicKey } = useWallet();
  const { addToast } = useToast();

  const handleConnect = async () => {
    try {
      const address = await connectWallet();
      setPublicKey(address);
      addToast({
        status: "success",
        title: "Wallet connected",
        message: `Now you can perform ${actionName}`,
        duration: 3000,
      });
      // After successful connection, trigger the action
      await onAction();
    } catch (error) {
      addToast({
        status: "error",
        title: "Connection failed",
        message: error instanceof Error ? error.message : "Could not connect wallet",
        duration: 4000,
      });
    }
  };

  if (!publicKey) {
    return (
      <button
        onClick={handleConnect}
        className="btn-primary rounded-lg px-4 py-2 text-sm font-semibold text-white"
      >
        Connect Wallet
      </button>
    );
  }

  return <>{children({ onClick: onAction })}</>;
}
