"use client";
import { useState } from "react";
import {
  ScheduleData,
  stroopsToXlm,
  revokeSchedule,
  parseContractError,
  NETWORK,
} from "@/lib/stellar";
import { useWallet } from "@/lib/WalletContext";
import { useToast } from "@/components/Toast";
import AddressLabel from "@/components/AddressLabel";
import { useXlmPrice, formatUsd } from "@/lib/price";

interface RevokeModalProps {
  schedule: ScheduleData;
  vestedAmt: bigint;
  tokenSymbol: string;
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export default function RevokeModal({
  schedule,
  vestedAmt,
  tokenSymbol,
  open,
  onClose,
  onSuccess,
}: RevokeModalProps) {
  const { publicKey } = useWallet();
  const { addToast, updateToast } = useToast();
  const [loading, setLoading] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [err, setErr] = useState("");

  const xlmPrice = useXlmPrice();
  const estimatedFee = "0.0015";

  const toReturn = schedule.total_amount - vestedAmt;
  const alreadyVested = vestedAmt;

  const handleRevoke = async () => {
    if (!publicKey) return;
    setLoading(true);
    setErr("");
    setTxHash(null);

    const toastId = addToast({
      status: "pending",
      title: "Revoke pending…",
      message: "Waiting for transaction to confirm.",
    });

    try {
      const hash = await revokeSchedule(publicKey, schedule.id);
      setTxHash(hash);
      updateToast(toastId, {
        status: "success",
        title: "Schedule revoked",
        message: "Unvested tokens have been returned to your wallet.",
        txHash: hash,
        network: NETWORK,
      });
      onSuccess();
    } catch (e: unknown) {
      const msg = parseContractError(e as Error);
      setErr(msg);
      updateToast(toastId, {
        status: "error",
        title: "Revoke failed",
        message: msg,
        retryLabel: "Try again",
        onRetry: handleRevoke,
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
      aria-label="Revoke schedule confirmation"
    >
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={loading ? undefined : onClose}
      />
      <div className="relative w-full max-w-md card p-6 flex flex-col gap-5 z-10 sm:rounded-2xl rounded-t-2xl sm:m-0 mt-auto max-h-[90vh] overflow-y-auto sm:max-h-none">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold">Revoke Schedule</h2>
          <button
            onClick={onClose}
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
          <p className="text-sm text-zinc-300 font-mono">
            {schedule.kind} vesting
          </p>
        </div>

        {err && (
          <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
            {err}
          </p>
        )}

        <div className="flex flex-col gap-3">
          <div className="flex justify-between items-center py-1">
            <span className="text-sm text-zinc-400">
              Tokens Returned to You
            </span>
            <div className="text-right">
              <span className="text-xl font-bold text-emerald-400">
                {stroopsToXlm(toReturn)} {tokenSymbol}
              </span>
              {xlmPrice !== null && (
                <p className="text-xs text-zinc-500">
                  {formatUsd(toReturn, xlmPrice)}
                </p>
              )}
            </div>
          </div>
          <div className="flex justify-between items-center py-1">
            <span className="text-sm text-zinc-400">Already Vested</span>
            <span className="text-sm text-zinc-300">
              {stroopsToXlm(alreadyVested)} {tokenSymbol}
            </span>
          </div>
          <div className="flex justify-between items-center py-1">
            <span className="text-sm text-zinc-400">Estimated Fee</span>
            <span className="text-sm text-zinc-300">{estimatedFee} XLM</span>
          </div>
          <div className="border-t border-white/5 my-1" />
          <div className="flex justify-between items-center py-1">
            <span className="text-sm text-zinc-400">Beneficiary</span>
            <AddressLabel
              address={schedule.beneficiary}
              compact
              className="items-end text-right"
              secondaryClassName="text-[11px] font-mono text-zinc-500"
            />
          </div>
        </div>

        <p className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
          This action is permanent and cannot be undone.
        </p>

        {txHash && (
          <div className="text-sm bg-green-500/10 border border-green-500/20 rounded-lg px-3 py-2 flex flex-col gap-1">
            <span className="text-green-400 font-medium">
              Transaction confirmed
            </span>
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
            onClick={onClose}
            disabled={loading}
            className="flex-1 rounded-xl py-2.5 border border-white/10 text-zinc-400 hover:text-white transition-colors text-sm font-semibold disabled:opacity-40"
          >
            {txHash ? "Close" : "Cancel"}
          </button>
          {!txHash && (
            <button
              onClick={handleRevoke}
              disabled={loading}
              className="flex-1 rounded-xl py-2.5 bg-red-500/10 border border-red-500/30 text-red-400 hover:bg-red-500/20 hover:border-red-500/60 transition-colors text-sm font-semibold disabled:opacity-60"
            >
              {loading ? "Revoking…" : "Revoke Schedule"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
