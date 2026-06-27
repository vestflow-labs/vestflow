"use client";

import { useState } from "react";
import {
  NETWORK,
  ScheduleData,
  parseContractError,
  pauseSchedule,
  resumeSchedule,
} from "@/lib/stellar";
import { useWallet } from "@/lib/WalletContext";
import { useToast } from "@/components/Toast";

interface PauseResumeModalProps {
  schedule: ScheduleData;
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export default function PauseResumeModal({
  schedule,
  open,
  onClose,
  onSuccess,
}: PauseResumeModalProps) {
  const { publicKey } = useWallet();
  const { addToast, updateToast } = useToast();
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const isResume = schedule.paused;
  const action = isResume ? "Resume" : "Pause";

  const handleConfirm = async () => {
    if (!publicKey) return;

    setLoading(true);
    setErr("");

    const toastId = addToast({
      status: "pending",
      title: `${action} pending…`,
      message: "Waiting for transaction to confirm.",
    });

    try {
      const hash = isResume
        ? await resumeSchedule(publicKey, schedule.id)
        : await pauseSchedule(publicKey, schedule.id);

      updateToast(toastId, {
        status: "success",
        title: `Schedule ${isResume ? "resumed" : "paused"}`,
        message: isResume
          ? "Tokens will continue vesting from now."
          : "No additional tokens will vest until this schedule is resumed.",
        txHash: hash,
        network: NETWORK,
      });
      onSuccess();
    } catch (e: unknown) {
      const msg = parseContractError(e as Error);
      setErr(msg);
      updateToast(toastId, {
        status: "error",
        title: `${action} failed`,
        message: msg,
        retryLabel: "Try again",
        onRetry: handleConfirm,
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
      aria-label={`${action} schedule confirmation`}
    >
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={loading ? undefined : onClose}
      />
      <div className="relative w-full max-w-md card p-6 flex flex-col gap-5 z-10 sm:rounded-2xl rounded-t-2xl sm:m-0 mt-auto max-h-[90vh] overflow-y-auto sm:max-h-none">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold">{action} Schedule</h2>
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

        <p className="text-sm text-zinc-300">
          {isResume
            ? "Vesting will continue from where it stopped. Time spent paused will not count toward the vesting period."
            : "Vesting will stop at its current point. The beneficiary can still claim tokens that have already vested."}
        </p>

        <p className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
          {isResume
            ? "This schedule will begin vesting again as soon as the transaction confirms."
            : "You can resume this schedule later. Its end date will be extended by the time it remains paused."}
        </p>

        <div className="flex gap-3">
          <button
            onClick={onClose}
            disabled={loading}
            className="flex-1 rounded-xl py-2.5 border border-white/10 text-zinc-400 hover:text-white transition-colors text-sm font-semibold disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={loading}
            className="flex-1 rounded-xl py-2.5 bg-violet-500/10 border border-violet-500/30 text-violet-300 hover:bg-violet-500/20 hover:border-violet-500/60 transition-colors text-sm font-semibold disabled:opacity-60"
          >
            {loading ? `${isResume ? "Resuming" : "Pausing"}…` : `${action} Schedule`}
          </button>
        </div>
      </div>
    </div>
  );
}
