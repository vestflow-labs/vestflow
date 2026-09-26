"use client";
import { useState } from "react";
import {
  ScheduleData,
  transferBeneficiary,
  parseContractError,
  NETWORK,
} from "@/lib/stellar";
import { useWallet } from "@/lib/WalletContext";
import { useToast } from "@/components/Toast";
import AddressLabel from "@/components/AddressLabel";

interface TransferBeneficiaryModalProps {
  schedule: ScheduleData;
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export default function TransferBeneficiaryModal({
  schedule,
  open,
  onClose,
  onSuccess,
}: TransferBeneficiaryModalProps) {
  const { publicKey } = useWallet();
  const { addToast, updateToast } = useToast();
  const [newAddress, setNewAddress] = useState("");
  const [loading, setLoading] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [err, setErr] = useState("");

  const handleClose = () => {
    if (loading) return;
    setNewAddress("");
    setErr("");
    setTxHash(null);
    onClose();
  };

  const handleTransfer = async () => {
    if (!publicKey || !newAddress.trim()) return;
    setLoading(true);
    setErr("");

    const toastId = addToast({
      status: "pending",
      title: "Transfer pending…",
      message: "Waiting for transaction to confirm.",
    });

    try {
      const hash = await transferBeneficiary(publicKey, schedule.id, newAddress.trim());
      setTxHash(hash);
      updateToast(toastId, {
        status: "success",
        title: "Ownership transferred",
        message: "Vesting rights moved to the new address.",
        txHash: hash,
        network: NETWORK,
      });
      onSuccess();
    } catch (e: unknown) {
      const msg = parseContractError(e as Error);
      setErr(msg);
      updateToast(toastId, {
        status: "error",
        title: "Transfer failed",
        message: msg,
        retryLabel: "Try again",
        onRetry: handleTransfer,
      });
    } finally {
      setLoading(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[9998] flex items-center justify-center sm:p-4 p-0"
      role="dialog"
      aria-modal="true"
      aria-label="Transfer beneficiary ownership"
    >
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={handleClose}
      />
      <div className="relative w-full max-w-md card p-6 flex flex-col gap-5 z-10 sm:rounded-2xl rounded-t-2xl sm:m-0 mt-auto max-h-[90vh] overflow-y-auto sm:max-h-none">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold">Transfer Ownership</h2>
          <button
            onClick={handleClose}
            disabled={loading}
            className="text-zinc-500 hover:text-white transition-colors text-xl leading-none disabled:opacity-40"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="flex flex-col gap-1 bg-zinc-900/50 rounded-xl p-4 border border-zinc-800">
          <p className="text-xs text-zinc-500 uppercase tracking-wider">
            Schedule #{schedule.id}
          </p>
          <p className="text-sm text-zinc-300 font-mono">{schedule.kind} vesting</p>
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex justify-between items-center py-1">
            <span className="text-sm text-zinc-400">Current beneficiary</span>
            <AddressLabel
              address={schedule.beneficiary}
              compact
              className="items-end text-right"
              secondaryClassName="text-[11px] font-mono text-zinc-500"
            />
          </div>
        </div>

        {err && (
          <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
            {err}
          </p>
        )}

        {!txHash && (
          <>
            <div className="flex flex-col gap-2">
              <label htmlFor="new-beneficiary" className="text-sm text-zinc-400">
                New beneficiary address
              </label>
              <input
                id="new-beneficiary"
                type="text"
                placeholder="G…"
                value={newAddress}
                onChange={(e) => setNewAddress(e.target.value)}
                disabled={loading}
                className="input text-sm"
                autoComplete="off"
                spellCheck={false}
              />
            </div>

            <p className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
              The new address will receive all future vested tokens. This cannot be undone.
            </p>
          </>
        )}

        {txHash && (
          <div className="text-sm bg-green-500/10 border border-green-500/20 rounded-lg px-3 py-2 flex flex-col gap-1">
            <span className="text-green-400 font-medium">Transfer confirmed</span>
            <a
              href={`https://stellar.expert/explorer/${NETWORK}/tx/${txHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-xs text-violet-400 hover:underline break-all"
            >
              {txHash}
            </a>
          </div>
        )}

        <div className="flex gap-3">
          <button
            onClick={handleClose}
            disabled={loading}
            className="flex-1 rounded-xl py-2.5 border border-white/10 text-zinc-400 hover:text-white transition-colors text-sm font-semibold disabled:opacity-40"
          >
            {txHash ? "Close" : "Cancel"}
          </button>
          {!txHash && (
            <button
              onClick={handleTransfer}
              disabled={loading || !newAddress.trim()}
              className="flex-1 rounded-xl py-2.5 bg-violet-500/10 border border-violet-500/30 text-violet-400 hover:bg-violet-500/20 hover:border-violet-500/60 transition-colors text-sm font-semibold disabled:opacity-60"
            >
              {loading ? "Processing…" : "Confirm Transfer"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
