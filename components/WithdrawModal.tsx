"use client";
import { useState } from "react";
import { withdrawSchedule, parseContractError, stroopsToXlm, NETWORK } from "@/lib/stellar";
import { useWallet } from "@/lib/WalletContext";
import { useToast } from "@/components/Toast";

interface Props {
  scheduleId: number;
  /** Remaining unclaimed balance in stroops (total - claimed). */
  availableStroops: bigint;
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export default function WithdrawModal({
  scheduleId,
  availableStroops,
  open,
  onClose,
  onSuccess,
}: Props) {
  const { publicKey } = useWallet();
  const { addToast, updateToast } = useToast();

  const availableXlm = Number(stroopsToXlm(availableStroops)).toFixed(7).replace(/\.?0+$/, "");

  const [amount, setAmount] = useState(availableXlm);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [txHash, setTxHash] = useState<string | null>(null);

  if (!open) return null;

  const isDisabled = availableStroops === 0n;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!publicKey) return;
    const parsed = parseFloat(amount);
    if (isNaN(parsed) || parsed <= 0) {
      setErr("Amount must be greater than zero.");
      return;
    }
    const maxXlm = parseFloat(availableXlm);
    if (parsed > maxXlm) {
      setErr(`Cannot exceed available balance of ${availableXlm} XLM.`);
      return;
    }
    setErr("");
    setLoading(true);
    const toastId = addToast({ status: "pending", title: "Withdraw pending…", message: "Waiting for transaction to confirm." });
    try {
      const hash = await withdrawSchedule(publicKey, scheduleId, amount);
      setTxHash(hash);
      updateToast(toastId, { status: "success", title: "Withdraw confirmed!", message: "Tokens returned to your wallet." });
      onSuccess();
    } catch (e: unknown) {
      const msg = parseContractError(e instanceof Error ? e : new Error(String(e)));
      setErr(msg);
      updateToast(toastId, { status: "error", title: "Withdraw failed", message: msg });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Withdraw Balance"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-full max-w-md rounded-2xl border border-white/10 bg-zinc-900 p-6 shadow-2xl">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="text-lg font-bold">Withdraw Balance</h2>
            <p className="text-sm text-zinc-400">Pull unused tokens from schedule #{scheduleId}</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-zinc-500 hover:text-zinc-300 transition-colors p-1"
          >
            ✕
          </button>
        </div>

        <div className="mb-4 rounded-lg bg-zinc-800/60 px-4 py-3 text-sm">
          <span className="text-zinc-500">Available to withdraw: </span>
          <span className={`font-semibold ${isDisabled ? "text-zinc-500" : "text-zinc-200"}`}>
            {availableXlm} XLM
          </span>
        </div>

        {isDisabled ? (
          <div className="py-4 text-center">
            <p className="text-zinc-500 text-sm">No balance available to withdraw.</p>
            <button onClick={onClose} className="mt-4 w-full rounded-xl border border-white/10 py-2.5 text-sm font-semibold text-zinc-300 hover:border-white/20 transition-colors">
              Close
            </button>
          </div>
        ) : txHash ? (
          <div className="text-center py-4">
            <p className="text-emerald-400 font-semibold mb-2">Withdraw Successful!</p>
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
              <div className="flex items-center justify-between">
                <label htmlFor="withdraw-amount" className="text-sm text-zinc-400">
                  Amount (XLM)
                </label>
                <button
                  type="button"
                  onClick={() => setAmount(availableXlm)}
                  className="text-xs text-violet-400 hover:text-violet-300 transition-colors"
                >
                  Max
                </button>
              </div>
              <input
                id="withdraw-amount"
                type="number"
                placeholder="0.00"
                min="0.0000001"
                max={availableXlm}
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
                    Withdrawing…
                  </span>
                ) : "Withdraw"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
