"use client";
import { useState, useEffect, useRef } from "react";
import { useWallet } from "@/lib/WalletContext";
import { stroopsToXlm, NATIVE_TOKEN } from "@/lib/stellar";
import { useToast } from "@/components/Toast";
import {
  GiveDraft,
  loadGiveDraft,
  saveGiveDraft,
  clearGiveDraft,
  isDraftEmpty,
} from "@/lib/giveDraft";
import BulkGiveForm from "@/components/BulkGiveForm";
import MultiGiveForm from "@/components/MultiGiveForm";

interface GiveModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export default function GiveModal({ open, onClose, onSuccess }: GiveModalProps) {
  const { publicKey } = useWallet();
  const [mode, setMode] = useState<"single" | "multi" | "bulk">("single");
  const [amount, setAmount] = useState("");
  const [recipient, setRecipient] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [txHash, setTxHash] = useState<string | null>(null);
  const [pendingDraft, setPendingDraft] = useState<GiveDraft | null>(null);
  const { addToast, updateToast } = useToast();

  // The modal only transfers the native token today; it's stored with the
  // draft so a future token picker can restore it too.
  const token = NATIVE_TOKEN;

  // Latest field values, read when the modal closes to persist a draft (#808)
  const fieldsRef = useRef({ recipient, amount });
  fieldsRef.current = { recipient, amount };
  const submittedRef = useRef(false);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      submittedRef.current = false;
      setPendingDraft(loadGiveDraft());
      return;
    }
    // Only overwrite storage when there's something to save, so opening and
    // closing without touching the form keeps an unanswered draft around.
    if (
      wasOpenRef.current &&
      !submittedRef.current &&
      !isDraftEmpty({ receiver: fieldsRef.current.recipient, amount: fieldsRef.current.amount })
    ) {
      saveGiveDraft({
        receiver: fieldsRef.current.recipient,
        token,
        amount: fieldsRef.current.amount,
      });
    }
    wasOpenRef.current = false;
    setAmount("");
    setRecipient("");
    setErr("");
    setTxHash(null);
    setPendingDraft(null);
  }, [open, token]);

  if (!open) return null;

  const handleRestoreDraft = () => {
    if (!pendingDraft) return;
    setRecipient(pendingDraft.receiver);
    setAmount(pendingDraft.amount);
    setPendingDraft(null);
  };

  const handleDiscardDraft = () => {
    clearGiveDraft();
    setPendingDraft(null);
  };

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
      submittedRef.current = true;
      clearGiveDraft();
      updateToast(toastId, {
        status: "success",
        title: "Transfer successful",
        message: `${amount} XLM transferred to ${recipient}`,
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
      <div className={`relative z-10 w-full ${mode === "single" ? "max-w-md" : "max-w-2xl"} rounded-2xl border border-white/10 bg-zinc-900 p-6 shadow-2xl transition-all`}>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-bold">Give Tokens</h2>
            <p className="text-sm text-zinc-400">
              {mode === "bulk"
                ? "Upload CSV to send tokens to multiple addresses at once"
                : mode === "multi"
                  ? "Give different tokens to different receivers in one session"
                  : "Send vested tokens to another address"}
            </p>
          </div>
          <button onClick={onClose} className="flex items-center justify-center text-zinc-500 hover:text-zinc-300 transition-colors shrink-0 min-h-[44px] min-w-[44px] -mr-2" aria-label="Close">
            ✕
          </button>
        </div>

        {/* Mode selector (#793, #811) */}
        <div className="flex border-b border-white/10 mb-5">
          {(
            [
              ["single", "Single Give"],
              ["multi", "Multi Give"],
              ["bulk", "Bulk Give (CSV)"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setMode(value)}
              className={`pb-2.5 px-3 text-xs font-semibold border-b-2 transition-colors ${
                mode === value
                  ? "border-violet-500 text-violet-300"
                  : "border-transparent text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {mode === "bulk" ? (
          <BulkGiveForm
            onSuccess={() => {
              onSuccess();
              onClose();
            }}
            onCancel={onClose}
          />
        ) : mode === "multi" ? (
          <MultiGiveForm
            onSuccess={() => {
              onSuccess();
              onClose();
            }}
            onCancel={onClose}
          />
        ) : (
          <>
            {pendingDraft && (
              <div
                role="alertdialog"
                aria-label="Restore draft"
                className="mb-4 rounded-xl border border-violet-500/30 bg-violet-500/10 p-3 text-sm"
              >
                <p className="font-medium text-violet-200">Restore draft?</p>
                <p className="mt-1 text-xs text-zinc-400 break-all">
                  {pendingDraft.amount ? `${pendingDraft.amount} XLM` : "No amount"}
                  {pendingDraft.receiver ? ` → ${pendingDraft.receiver.slice(0, 10)}…${pendingDraft.receiver.slice(-6)}` : ""}
                  {" · saved "}{new Date(pendingDraft.savedAt).toLocaleString()}
                </p>
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    onClick={handleRestoreDraft}
                    className="flex-1 min-h-[36px] rounded-lg bg-violet-600 hover:bg-violet-500 text-xs font-semibold text-white transition-colors"
                  >
                    Restore
                  </button>
                  <button
                    type="button"
                    onClick={handleDiscardDraft}
                    className="flex-1 min-h-[36px] rounded-lg border border-white/10 text-xs font-semibold text-zinc-300 hover:border-white/20 transition-colors"
                  >
                    Discard
                  </button>
                </div>
              </div>
            )}

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
        </>
        )}
      </div>
    </div>
  );
}