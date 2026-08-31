"use client";
import { useState, useEffect } from "react";
import { useWallet } from "@/lib/WalletContext";
import { stroopsToXlm } from "@/lib/stellar";
import { useToast } from "@/components/Toast";

interface GiveModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export default function GiveModal({ open, onClose, onSuccess }: GiveModalProps) {
  const { publicKey } = useWallet();
  const [amount, setAmount] = useState("");
  const [recipient, setRecipient] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [txHash, setTxHash] = useState<string | null>(null);
  const { addToast, updateToast } = useToast();

  useEffect(() => {
    if (!open) {
      setAmount("");
      setRecipient("");
      setErr("");
      setTxHash(null);
    }
  }, [open]);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!publicKey) {
      setErr("Wallet not connected.");
      return;
    }

    if (!recipient.trim()) {
      setErr("Recipient address is required.");
      return;
    }

    if (!/^G[A-Z2-7]{55}$/.test(recipient.trim())) {
      setErr("Must be a valid Stellar address starting with G.");
      return;
    }

    const parsed = parseFloat(amount);
    if (isNaN(parsed) || parsed <= 0) {
      setErr("Amount must be greater than zero.");
      return;
    }

    setErr("");
    setLoading(true);
    const toastId = addToast({ status: "pending", title: "Transfer pending…" });

    try {
      // TODO: implement actual transfer contract call
      // For now, simulate success after a brief delay
      await new Promise((resolve) => setTimeout(resolve, 1500));
      setTxHash("SIMULATED_TX_HASH");
      updateToast(toastId, {
        status: "success",
        title: "Transfer successful",
        message: `${stroopsToXlm(parseFloat(amount)!)} XLM transferred to ${recipient}`,
      });
      onSuccess();
      onClose();
    } catch (e: any) {
      const msg = e?.message || "Transfer failed";
      setErr(msg);
      updateToast(toastId, { status: "error", title: "Transfer failed", message: msg });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Give Tokens"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-full max-w-md rounded-2xl border border-white/10 bg-zinc-900 p-6 shadow-2xl">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="text-lg font-bold">Give Tokens</h2>
            <p className="text-sm text-zinc-400">Send vested tokens to another address</p>
          </div>
          <button onClick={onClose} className="flex items-center justify-center text-zinc-500 hover:text-zinc-300 transition-colors shrink-0 min-h-[44px] min-w-[44px] -mr-2" aria-label="Close">
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label className="text-sm text-zinc-400">Recipient Address</label>
            <input
              type="text"
              placeholder="GABC..."
              value={recipient}
              onChange={(e) => {
                setRecipient(e.target.value);
                setErr("");
              }}
              required
              className="input w-full min-h-[44px]"
            />
          </div>

          <div>
            <label className="text-sm text-zinc-400">Amount (XLM)</label>
            <input
              type="number"
              placeholder="10.00"
              min="0.0000001"
              step="any"
              value={amount}
              onChange={(e) => {
                const val = e.target.value;
                setAmount(val);
                if (val) setErr("");
              }}
              required
              className="input w-full min-h-[44px]"
            />
          </div>

          <div className="flex gap-3 pt-1">
            <button type="button" onClick={onClose} className="flex-1 min-h-[44px] rounded-xl border border-white/10 py-2.5 text-sm font-semibold text-zinc-300 hover:border-white/20 transition-colors disabled:opacity-50">
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !amount.trim()}
              className="flex-1 min-h-[44px] btn-primary rounded-xl py-2.5 font-semibold disabled:opacity-50">
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Transferring…
                </span>
              ) : "Transfer"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}