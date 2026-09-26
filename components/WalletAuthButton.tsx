"use client";

import { useWallet } from "@/lib/WalletContext";
import { authenticateWithWallet, logout, getStoredToken } from "@/lib/auth";
import { useEffect, useState } from "react";
import { useToast } from "@/components/Toast";

/**
 * WalletAuthButton component
 * Handles wallet signature-based authentication with JWT token management.
 * Shows different UI based on authentication state.
 */
export default function WalletAuthButton() {
  const { publicKey } = useWallet();
  const { addToast } = useToast();
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [tokenExpiry, setTokenExpiry] = useState<number | null>(null);

  // Check for stored token on mount and when publicKey changes
  useEffect(() => {
    const token = getStoredToken();
    if (token) {
      // Parse expiry from localStorage
      const expiry = localStorage.getItem("vestflow-auth-expiry");
      if (expiry) {
        setTokenExpiry(parseInt(expiry, 10));
      }
      setIsAuthenticated(true);
    } else {
      setIsAuthenticated(false);
      setTokenExpiry(null);
    }
  }, [publicKey]);

  const handleAuthenticate = async () => {
    if (!publicKey) {
      addToast({
        status: "error",
        title: "Wallet not connected",
        message: "Please connect your Freighter wallet first",
        duration: 4000,
      });
      return;
    }

    setIsLoading(true);
    try {
      await authenticateWithWallet(publicKey);
      setIsAuthenticated(true);

      const expiry = localStorage.getItem("vestflow-auth-expiry");
      if (expiry) {
        setTokenExpiry(parseInt(expiry, 10));
      }

      addToast({
        status: "success",
        title: "Authentication successful",
        message: "You are now authenticated for write operations",
        duration: 4000,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Authentication failed";
      addToast({
        status: "error",
        title: "Authentication failed",
        message,
        duration: 5000,
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleLogout = () => {
    logout();
    setIsAuthenticated(false);
    setTokenExpiry(null);
    addToast({
      status: "info",
      title: "Logged out",
      message: "Your authentication token has been cleared",
      duration: 3000,
    });
  };

  // Format time remaining
  const getTimeRemaining = () => {
    if (!tokenExpiry) return null;
    const remaining = tokenExpiry - Date.now();
    if (remaining <= 0) return "expired";
    const minutes = Math.floor(remaining / 60000);
    const seconds = Math.floor((remaining % 60000) / 1000);
    if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
    }
    return `${seconds}s`;
  };

  const timeRemaining = getTimeRemaining();

  return (
    <div className="flex items-center gap-3">
      {isAuthenticated && publicKey ? (
        <div className="flex items-center gap-2">
          <div className="text-xs text-zinc-400">
            <div className="flex items-center gap-1">
              <span className="inline-block w-2 h-2 bg-emerald-400 rounded-full"></span>
              Authenticated
            </div>
            {timeRemaining && (
              <div className="text-zinc-500 text-[10px]">
                Token expires in {timeRemaining}
              </div>
            )}
          </div>
          <button
            onClick={handleLogout}
            className="text-xs px-3 py-1.5 border border-white/10 rounded-lg hover:border-white/20 transition-colors text-zinc-400 hover:text-white"
          >
            Logout
          </button>
        </div>
      ) : (
        <button
          onClick={handleAuthenticate}
          disabled={!publicKey || isLoading}
          className="text-xs px-3 py-1.5 bg-violet-600/20 border border-violet-500/50 rounded-lg hover:bg-violet-600/30 hover:border-violet-500/70 transition-colors text-violet-300 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isLoading ? "Signing..." : "Authenticate"}
        </button>
      )}
    </div>
  );
}
