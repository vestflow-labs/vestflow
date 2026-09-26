"use client";
import { useState } from "react";
import { topUpSchedule, getWalletXlmBalance, parseContractError, NETWORK } from "@/lib/stellar";
import { useWallet } from "@/lib/WalletContext";
import { useToast } from "@/components/Toast";

interface Props {
  scheduleId: number;
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export default function TopUpModal({ scheduleId, open, onClose, onSuccess }: Props) {
  const { publicKey } = useWallet();
  const { addToast, updateToast } = useToast();
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [txHash, setTxHash] = useState<string | null>(null);
  const [walletBalance, setWalletBalance] = useState<bigint | null>(null);

  const handleOpen = () => {
    setErr("");
    setAmount("");
    setTxHash(null);
    if (publicKey) {
      getWalletXlmBalance(publicKey)
        .then(setWalletBalance)
        .catch(() => setWalletBalance(null));
    }
  };

  if (!open) return null;

  const formatBalance = (stroops: bigint) => {
    const xlm = Number(stroops) / 10_000_000;
    return xlm.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 7 });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!publicKey) return;
    const parsed = parseFloat(amount);
    if (isNaN(parsed) || parsed <= 0) {
      setErr("Amount must be greater than zero.");
      return;
    }
    setErr("");
    setLoading(true);
    const toastId = addToast({ status: "pending", title: "Top Up pending…", message: "Waiting for transaction to confirm." });
    try {
      const hash = await topUpSchedule(publicKey, scheduleId, amount);
      setTxHash(hash);
      updateToast(toastId, { status: "success", title: "Top Up confirmed!", message: "Balance has been added to the schedule." });
      onSuccess();
    } catch (e: unknown) {
      const msg = parseContractError(e instanceof Error ? e : new Error(String(e)));
      setErr(msg);
      updateToast(toastId, { status: "error", title: "Top Up failed", message: msg });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Top Up Balance"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      ref={(el) => { if (el) handleOpen(); }}
    >
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-full max-w-md rounded-2xl border border-white/10 bg-zinc-900 p-6 shadow-2xl">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="text-lg font-bold">Top Up Balance</h2>
            <p className="text-sm text-zinc-400">Add more XLM to schedule #{scheduleId}</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-zinc-500 hover:text-zinc-300 transition-colors p-1"
          >
            ✕
          </button>
        </div>

        {walletBalance !== null && (
          <div className="mb-4 rounded-lg bg-zinc-800/60 px-4 py-3 text-sm">
            <span className="text-zinc-500">Available wallet balance: </span>
            <span className="font-semibold text-zinc-200">{formatBalance(walletBalance)} XLM</span>
          </div>
        )}

        {txHash ? (
          <div className="text-center py-4">
            <p className="text-emerald-400 font-semibold mb-2">Top Up Successful!</p>
            <a
              href={`https://stellar.expert/explorer/${NETWORK}/tx/${txHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs font-mono text-violet-400 hover:underline break-all"
            >
              {txHash}
            </a>
            <button onClick={onClose} className="mt-4 w-full btn-primary rounded-xl py-2.5 font-semibold">
              Close
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="topup-amount" className="text-sm text-zinc-400">
                Amount (XLM)
              </label>
              <input
                id="topup-amount"
                type="number"
                placeholder="0.00"
                min="0.0000001"
                step="any"
                value={amount}
                onChange={(e) => { setAmount(e.target.value); setErr(""); }}
                required
                autoFocus
                className="input"
                aria-invalid={!!err}
              />
              {err && <p className="text-xs text-red-400" role="alert">{err}</p>}
            </div>

            <div className="flex gap-3 pt-1">
              <button
                type="button"
                onClick={onClose}
                disabled={loading}
                className="flex-1 rounded-xl border border-white/10 py-2.5 text-sm font-semibold text-zinc-300 hover:border-white/20 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading || !amount}
                className="flex-1 btn-primary rounded-xl py-2.5 font-semibold disabled:opacity-50"
              >
                {loading ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    Topping Up…
                  </span>
                ) : "Top Up"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
