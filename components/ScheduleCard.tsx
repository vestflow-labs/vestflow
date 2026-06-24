"use client";
import { useState } from "react";
import Link from "next/link";
import {
  ScheduleData,
  stroopsToXlm,
  truncate,
  vestingProgress,
  formatDate,
  formatCliffDate,
  claimVested,
  revokeSchedule,
  parseContractError,
  NETWORK,
  NATIVE_TOKEN,
} from "@/lib/stellar";
import { useWallet } from "@/lib/WalletContext";
import { useToast } from "@/components/Toast";
import VestingChart from "@/components/VestingChart";
import { useXlmPrice, formatUsd } from "@/lib/price";

export default function ScheduleCard({
  schedule,
  onAction,
}: {
  schedule: ScheduleData;
  onAction: () => void;
}) {
  const { publicKey } = useWallet();
  const { addToast, updateToast } = useToast();
  const [loading, setLoading] = useState<"claim" | "revoke" | null>(null);
  const [showChart, setShowChart] = useState(false);
  const xlmPrice = useXlmPrice();

  const now = Math.floor(Date.now() / 1000);
  const progress = vestingProgress(schedule, now);

  // Claimed percentage relative to total (for the dual progress bar)
  const claimedPct =
    schedule.total_amount > 0n
      ? Math.min(
          100,
          Math.round(
            (Number(schedule.claimed) / Number(schedule.total_amount)) * 100
          )
        )
      : 0;

  const isBeneficiary = publicKey === schedule.beneficiary;
  const isGrantor = publicKey === schedule.grantor;
  const vested = BigInt(
    Math.floor((Number(schedule.total_amount) * progress) / 100)
  );
  const claimableAmt = vested > schedule.claimed ? vested - schedule.claimed : 0n;

  // SEP-41 token symbol support
  const isNative = schedule.token === NATIVE_TOKEN;
  const tokenSymbol = isNative ? "XLM" : `Token (${truncate(schedule.token, 4, 4)})`;

  // ── Claim ──────────────────────────────────────────────────────────────────
  const handleClaim = async () => {
    if (!publicKey) return;
    setLoading("claim");

    const toastId = addToast({
      status: "pending",
      title: "Claim pending…",
      message: "Waiting for transaction to confirm.",
    });

    try {
      const hash = await claimVested(publicKey, schedule.id);
      updateToast(toastId, {
        status: "success",
        title: "Tokens claimed!",
        message: `${stroopsToXlm(claimableAmt)} ${tokenSymbol} transferred to your wallet.`,
        txHash: hash,
        network: NETWORK,
      });
      onAction();
    } catch (e: any) {
      updateToast(toastId, {
        status: "error",
        title: "Claim failed",
        message: parseContractError(e),
      });
    } finally {
      setLoading(null);
    }
  };

  // ── Revoke ─────────────────────────────────────────────────────────────────
  const handleRevoke = async () => {
    if (!publicKey) return;
    setLoading("revoke");

    const toastId = addToast({
      status: "pending",
      title: "Revoke pending…",
      message: "Waiting for transaction to confirm.",
    });

    try {
      const hash = await revokeSchedule(publicKey, schedule.id);
      updateToast(toastId, {
        status: "success",
        title: "Schedule revoked",
        message: "Unvested tokens have been returned.",
        txHash: hash,
        network: NETWORK,
      });
      onAction();
    } catch (e: any) {
      updateToast(toastId, {
        status: "error",
        title: "Revoke failed",
        message: parseContractError(e),
      });
    } finally {
      setLoading(null);
    }
  };

  const statusColor = schedule.revoked
    ? "bg-red-500/10 text-red-400"
    : progress >= 100
    ? "bg-green-500/10 text-green-400"
    : "bg-violet-500/10 text-violet-400";

  const statusLabel = schedule.revoked
    ? "Revoked"
    : progress >= 100
    ? "Fully Vested"
    : "Vesting";

  return (
    <div className="card p-5 flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Link href={`/app/schedule/${schedule.id}`} className="text-sm font-semibold text-white hover:text-violet-300 transition-colors">
              Schedule #{schedule.id}
            </Link>
            <CopyButton value={String(schedule.id)} label={`Copy schedule ${schedule.id}`} />
          </div>
          <p className="text-xs text-zinc-500 mt-0.5">{schedule.kind} vesting{schedule.revocable ? " · revocable" : ""}</p>
        </div>
        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${statusColor}`}>
          {statusLabel}
        </span>
      </div>

      {/* Details grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs text-zinc-400">
        <div><span className="text-zinc-600">Grantor</span><p className="font-mono text-zinc-300 mt-0.5"><span className="sm:hidden">{truncate(schedule.grantor, 4, 3)}</span><span className="hidden sm:inline">{truncate(schedule.grantor)}</span></p></div>
        <div><span className="text-zinc-600">Beneficiary</span><p className="font-mono text-zinc-300 mt-0.5"><span className="sm:hidden">{truncate(schedule.beneficiary, 4, 3)}</span><span className="hidden sm:inline">{truncate(schedule.beneficiary)}</span></p></div>
        <div>
          <span className="text-zinc-600">Total</span>
          <p className="text-zinc-300 mt-0.5">{stroopsToXlm(schedule.total_amount)} XLM</p>
          {xlmPrice !== null && (
            <p className="text-zinc-500 text-xs">{formatUsd(schedule.total_amount, xlmPrice)}</p>
          )}
        </div>
        <div>
          <span className="text-zinc-600">Claimed</span>
          <p className="text-zinc-300 mt-0.5">{stroopsToXlm(schedule.claimed)} XLM</p>
          {xlmPrice !== null && (
            <p className="text-zinc-500 text-xs">{formatUsd(schedule.claimed, xlmPrice)}</p>
          )}
        </div>
        <div><span className="text-zinc-600">Starts</span><p className="text-zinc-300 mt-0.5">{formatDate(schedule.start_time)}</p></div>
        <div><span className="text-zinc-600">Ends</span><p className="text-zinc-300 mt-0.5">{formatDate(schedule.start_time + schedule.duration)}</p></div>
        {!isNative && (
          <div className="col-span-2">
            <span className="text-zinc-600">Token Contract</span>
            <p className="font-mono text-zinc-300 mt-0.5 break-all">{schedule.token}</p>
          </div>
        )}
      </div>

      {/* ── Dual progress bar (#86) ─────────────────────────────────────────── */}
      <div>
        {/* Legend row */}
        <div className="flex justify-between items-center text-xs text-zinc-500 mb-1.5">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <span
                className="inline-block w-2 h-2 rounded-full bg-gradient-to-r from-violet-500 to-cyan-500"
                aria-hidden="true"
              />
              Vested {progress}%
            </span>
            <span className="flex items-center gap-1">
              <span
                className="inline-block w-2 h-2 rounded-full bg-emerald-500"
                aria-hidden="true"
              />
              Claimed {claimedPct}%
            </span>
          </div>
          <span className="text-zinc-600">
            {stroopsToXlm(schedule.total_amount)} {tokenSymbol}
          </span>
        </div>

        {/* Track */}
        <div
          className="relative h-2.5 rounded-full bg-white/5 overflow-hidden"
          role="progressbar"
          aria-label={`Vesting progress: ${progress}% vested, ${claimedPct}% claimed`}
          aria-valuenow={progress}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          {/* Vested layer (gradient) */}
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-violet-500 to-cyan-500 transition-all duration-700"
            style={{ width: `${progress}%` }}
          />
          {/* Claimed layer (solid emerald, sits on top) */}
          {claimedPct > 0 && (
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-emerald-500/80 transition-all duration-700"
              style={{ width: `${claimedPct}%` }}
            />
          )}
        </div>

        {/* Cliff label */}
        {schedule.kind === "Cliff" &&
          schedule.cliff_duration > 0 &&
          now < schedule.start_time + schedule.cliff_duration &&
          !schedule.revoked && (
            <p className="text-xs text-zinc-500 mt-1.5">
              Unlocks on{" "}
              <span className="text-zinc-300">
                {formatCliffDate(schedule.cliff_duration, schedule.start_time)}
              </span>
            </p>
          )}
      </div>

      {/* Chart toggle */}
      <div>
        <button
          onClick={() => setShowChart((v) => !v)}
          className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          {showChart ? "Hide chart ▲" : "Show chart ▼"}
        </button>
        {showChart && (
          <div className="mt-2">
            <VestingChart schedule={schedule} />
          </div>
        )}
      </div>

      {/* Actions */}
      {publicKey && !schedule.revoked && (
        <div className="flex gap-2 mt-1">
          {isBeneficiary && claimableAmt > 0n && (
            <button onClick={handleClaim} disabled={!!loading} className="btn-primary text-xs rounded-lg px-3 py-1.5 font-semibold text-white disabled:opacity-60">
              {loading === "claim"
                ? "Processing…"
                : `Claim ${stroopsToXlm(claimableAmt)} XLM${xlmPrice !== null ? ` (${formatUsd(claimableAmt, xlmPrice)})` : ""}`}
            </button>
          )}
          {isGrantor && schedule.revocable && progress < 100 && (
            <button
              onClick={handleRevoke}
              disabled={!!loading}
              className="text-xs rounded-lg px-3 py-1.5 border border-red-500/30 text-red-400 hover:border-red-500/60 transition-colors disabled:opacity-60"
            >
              {loading === "revoke" ? "Processing…" : "Revoke"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
