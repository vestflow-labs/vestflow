"use client";
import { useState, useEffect } from "react";
import { NATIVE_TOKEN, getWalletXlmBalance, stroopsToXlm } from "@/lib/stellar";
import { useWallet } from "@/lib/WalletContext";

interface Token {
  address: string;
  symbol: string;
  name: string;
  icon?: string;
}

// Supported tokens - can be extended with more tokens
const SUPPORTED_TOKENS: Token[] = [
  {
    address: NATIVE_TOKEN,
    symbol: "XLM",
    name: "Stellar Lumens",
    icon: "⭐",
  },
];

interface TokenSelectorProps {
  value: string;
  onChange: (tokenAddress: string, tokenSymbol: string) => void;
  error?: string;
}

export default function TokenSelector({
  value,
  onChange,
  error,
}: TokenSelectorProps) {
  const { publicKey } = useWallet();
  const [balances, setBalances] = useState<Map<string, bigint>>(new Map());
  const [loading, setLoading] = useState(false);
  const [showCustom, setShowCustom] = useState(false);
  const [customAddress, setCustomAddress] = useState("");

  useEffect(() => {
    if (!publicKey) return;

    const fetchBalances = async () => {
      setLoading(true);
      const newBalances = new Map<string, bigint>();

      try {
        // Fetch XLM balance
        const xlmBalance = await getWalletXlmBalance(publicKey);
        newBalances.set(NATIVE_TOKEN, xlmBalance);
      } catch (err) {
        console.error("Failed to fetch balances:", err);
      }

      setBalances(newBalances);
      setLoading(false);
    };

    fetchBalances();
  }, [publicKey]);

  const handleTokenSelect = (token: Token) => {
    onChange(token.address, token.symbol);
    setShowCustom(false);
  };

  const handleCustomSubmit = () => {
    if (customAddress && /^[CG][A-Z2-7]{55}$/.test(customAddress.trim())) {
      onChange(customAddress.trim(), customAddress.slice(0, 8) + "...");
      setShowCustom(false);
      setCustomAddress("");
    }
  };

  const selectedToken = SUPPORTED_TOKENS.find(t => t.address === value);
  const isCustomToken = !selectedToken && value;

  return (
    <div className="flex flex-col gap-2">
      <label className="text-sm font-medium text-zinc-300">
        Token <span className="text-red-400">*</span>
      </label>
      
      <div className="flex flex-col gap-2">
        {/* Token options */}
        <div className="grid grid-cols-1 gap-2">
          {SUPPORTED_TOKENS.map((token) => {
            const balance = balances.get(token.address);
            const isSelected = value === token.address;
            
            return (
              <button
                key={token.address}
                type="button"
                onClick={() => handleTokenSelect(token)}
                className={`flex items-center justify-between p-3 rounded-lg border transition-all text-left ${
                  isSelected
                    ? "border-violet-500/50 bg-violet-500/10"
                    : "border-white/10 hover:border-white/20 bg-zinc-900/50"
                }`}
              >
                <div className="flex items-center gap-3">
                  {token.icon && (
                    <span className="text-2xl" aria-hidden="true">
                      {token.icon}
                    </span>
                  )}
                  <div className="flex flex-col">
                    <span className="font-semibold text-white">
                      {token.symbol}
                    </span>
                    <span className="text-xs text-zinc-500">{token.name}</span>
                  </div>
                </div>
                
                <div className="flex flex-col items-end">
                  {publicKey && balance !== undefined ? (
                    <>
                      <span className="text-sm font-mono text-zinc-300">
                        {stroopsToXlm(balance)}
                      </span>
                      <span className="text-xs text-zinc-500">Balance</span>
                    </>
                  ) : loading ? (
                    <span className="text-xs text-zinc-500">Loading...</span>
                  ) : (
                    <span className="text-xs text-zinc-500">Connect wallet</span>
                  )}
                </div>
              </button>
            );
          })}
        </div>

        {/* Custom token option */}
        {!showCustom && (
          <button
            type="button"
            onClick={() => setShowCustom(true)}
            className="flex items-center justify-center gap-2 p-3 rounded-lg border border-white/10 hover:border-white/20 bg-zinc-900/50 transition-all text-sm text-zinc-400 hover:text-white"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Use Custom Token Address
          </button>
        )}

        {showCustom && (
          <div className="flex flex-col gap-2 p-3 rounded-lg border border-white/10 bg-zinc-900/50">
            <label htmlFor="custom-token" className="text-xs text-zinc-400">
              Custom SEP-41 Token Contract Address
            </label>
            <div className="flex gap-2">
              <input
                id="custom-token"
                type="text"
                value={customAddress}
                onChange={(e) => setCustomAddress(e.target.value)}
                placeholder="CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
                className="flex-1 px-3 py-2 bg-black/20 border border-white/10 rounded-lg text-sm font-mono text-zinc-300 focus:outline-none focus:ring-2 focus:ring-violet-500/50"
              />
              <button
                type="button"
                onClick={handleCustomSubmit}
                className="px-4 py-2 bg-violet-600/20 border border-violet-500/50 rounded-lg text-sm font-semibold text-violet-300 hover:bg-violet-600/30 transition-colors"
              >
                Add
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowCustom(false);
                  setCustomAddress("");
                }}
                className="px-4 py-2 border border-white/10 rounded-lg text-sm text-zinc-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {isCustomToken && (
          <div className="flex items-center justify-between p-3 rounded-lg border border-violet-500/50 bg-violet-500/10">
            <div className="flex flex-col">
              <span className="text-xs text-zinc-500">Custom Token</span>
              <span className="text-sm font-mono text-white break-all">
                {value}
              </span>
            </div>
            <button
              type="button"
              onClick={() => onChange("", "")}
              className="text-xs text-red-400 hover:text-red-300 transition-colors"
            >
              Remove
            </button>
          </div>
        )}
      </div>

      {error && (
        <p className="text-xs text-red-400">{error}</p>
      )}
    </div>
  );
}
