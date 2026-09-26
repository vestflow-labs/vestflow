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
  NATIVE_TOKEN,
} from "@/lib/stellar";
import { useWallet } from "@/lib/WalletContext";
import CopyButton from "@/components/CopyButton";
import ClaimModal from "@/components/ClaimModal";
import RevokeModal from "@/components/RevokeModal";
import TransferBeneficiaryModal from "@/components/TransferBeneficiaryModal";
import { SqueezeModal } from "@/components/SqueezeModal";
import VestingChart from "@/components/VestingChart";
import AddressLabel from "@/components/AddressLabel";
import { useXlmPrice, formatUsd } from "@/lib/price";
import { useCountdown, formatCountdown } from "@/hooks/useCountdown";
import WalletConnectionGuard from "@/components/WalletConnectionGuard";

export default function ScheduleCard({
  schedule,
  onAction,
}: {
  schedule: ScheduleData;
  onAction?: () => void;
}) {
  const { publicKey } = useWallet();
  const [showChart, setShowChart] = useState(false);
  const [showClaimModal, setShowClaimModal] = useState(false);
  const [showRevokeModal, setShowRevokeModal] = useState(false);
  const [showTransferModal, setShowTransferModal] = useState(false);
  const [showSqueezeModal, setShowSqueezeModal] = useState(false);
  const xlmPrice = useXlmPrice();

  const now = Math.floor(Date.now() / 1000);
  const progress = vestingProgress(schedule, now);
  const lockupEndsAt = schedule.start_time + schedule.lockup_duration;
  const isInLockup = schedule.lockup_duration > 0 && now < lockupEndsAt;

  const cliffUnlockAt = schedule.start_time + schedule.cliff_duration;
  const inCliffPeriod =
    schedule.kind === "Cliff" && schedule.cliff_duration > 0 && now < cliffUnlockAt && !schedule.revoked;
  const cliffCountdown = useCountdown(inCliffPeriod ? cliffUnlockAt : now);

  // Claimed percentage relative to total (for the dual progress bar)
  const claimedPct =
    schedule.total_amount > 0n
      ? Math.min(100, Number((schedule.claimed * 100n) / schedule.total_amount))
      : 0;

  const isBeneficiary = publicKey === schedule.beneficiary;
  const isGrantor = publicKey === schedule.grantor;
  const vested = (schedule.total_amount * BigInt(progress)) / 100n;
  const claimableAmt = !isInLockup && vested > schedule.claimed ? vested - schedule.claimed : 0n;

  // SEP-41 token symbol support
  const isNative = schedule.token === NATIVE_TOKEN;
  const tokenSymbol = isNative ? "XLM" : `Token (${truncate(schedule.token, 4, 4)})`;

  const vestingEndTime = schedule.start_time + schedule.duration;
  const isFullyVested = progress >= 100;

  const statusColor = schedule.revoked
    ? "bg-red-500/10 text-red-400"
    : isFullyVested
    ? "bg-green-500/10 text-green-400"
    : "bg-violet-500/10 text-violet-400";

  const statusLabel = schedule.revoked
    ? "Revoked"
    : isFullyVested
    ? "Fully Vested"
    : "Vesting";

  const KIND_BADGE: Record<string, string> = {
    Linear:          "bg-blue-500/10 text-blue-400 border border-blue-500/20",
    Cliff:           "bg-amber-500/10 text-amber-400 border border-amber-500/20",
    LinearWithCliff: "bg-cyan-500/10 text-cyan-400 border border-cyan-500/20",
    Graded:          "bg-purple-500/10 text-purple-400 border border-purple-500/20",
  };
  const kindStyle = KIND_BADGE[schedule.kind] ?? "bg-zinc-500/10 text-zinc-400 border border-zinc-500/20";

  return (
    <div className="card p-5 flex flex-col gap-3" data-tour="schedule-card">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Link href={`/app/schedule/${schedule.id}`} className="text-sm font-semibold text-white hover:text-violet-300 transition-colors">
              Schedule #{schedule.id}
            </Link>
            <CopyButton value={String(schedule.id)} label={`Copy schedule ${schedule.id}`} />
          </div>
          <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
            <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${kindStyle}`}>
              {schedule.kind}
            </span>
            {schedule.revocable && (
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-zinc-700/40 text-zinc-400 border border-zinc-700/60">
                revocable
              </span>
            )}
            {isFullyVested && !schedule.revoked && (
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-green-500/10 text-green-400 border border-green-500/20">
                ✓ {formatDate(vestingEndTime)}
              </span>
            )}
          </div>
        </div>
        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${statusColor}`}>
          {statusLabel}
        </span>
      </div>

      {/* Details grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs text-zinc-400">
        <div>
          <span className="text-zinc-600">Grantor</span>
          <AddressLabel
            address={schedule.grantor}
            compact
            className="mt-0.5"
            secondaryClassName="text-[11px] font-mono text-zinc-500 break-all"
          />
        </div>
        <div>
          <span className="text-zinc-600">Beneficiary</span>
          <AddressLabel
            address={schedule.beneficiary}
            compact
            className="mt-0.5"
            secondaryClassName="text-[11px] font-mono text-zinc-500 break-all"
          />
        </div>
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

      {/* ── Progress / Milestones ────────────────────────────────────────── */}
      <div>
        {schedule.kind === "Graded" && schedule.milestones && schedule.milestones.length > 0 ? (
          /* Graded milestone checklist (#280) */
          <div className="flex flex-col gap-1.5">
            <p className="text-xs text-zinc-600 uppercase tracking-wider mb-0.5">Milestones</p>
            {schedule.milestones.map((m, i) => {
              const done = now >= m.timestamp;
              const label = new Date(m.timestamp * 1000).toLocaleDateString(undefined, {
                month: "short",
                year: "numeric",
              });
              return (
                <div key={i} className="flex items-center gap-2 text-xs">
                  <span className={done ? "text-emerald-400" : "text-zinc-600"} aria-hidden="true">
                    {done ? "✓" : "○"}
                  </span>
                  <span className={done ? "text-zinc-300" : "text-zinc-500"}>
                    {m.pct}% — {label}
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <>
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
            {inCliffPeriod && (
              <p className="text-xs text-zinc-500 mt-1.5">
                Unlocks on{" "}
                <span className="text-zinc-300">
                  {formatCliffDate(schedule.cliff_duration, schedule.start_time)}
                </span>
                {" "}
                <span className="text-violet-400">({formatCountdown(cliffCountdown)})</span>
              </p>
            )}
          </>
        )}

        {/* Lockup expiry (#279) */}
        {schedule.lockup_duration > 0 &&
          now < schedule.start_time + schedule.lockup_duration &&
          !schedule.revoked && (
            <p className="text-xs text-zinc-500 mt-1.5">
              Locked until:{" "}
              <span className="text-zinc-300">
                {formatDate(schedule.start_time + schedule.lockup_duration)}
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
      {!schedule.revoked && (
        <div className="flex flex-col sm:flex-row gap-2 mt-1">
          {isBeneficiary && claimableAmt > 0n && (
            <WalletConnectionGuard
              onAction={() => setShowClaimModal(true)}
              actionName="claim tokens"
            >
              {({ onClick }) => (
                <button onClick={onClick} className="btn-primary text-xs rounded-lg px-3 py-1.5 font-semibold text-white flex-1 sm:flex-auto truncate">
                  <span className="sm:hidden">Claim {stroopsToXlm(claimableAmt)} XLM</span>
                  <span className="hidden sm:inline">Claim {stroopsToXlm(claimableAmt)} XLM{xlmPrice !== null ? ` (${formatUsd(claimableAmt, xlmPrice)})` : ""}</span>
                </button>
              )}
            </WalletConnectionGuard>
          )}
          {isGrantor && schedule.revocable && progress < 100 && (
            <WalletConnectionGuard
              onAction={() => setShowRevokeModal(true)}
              actionName="revoke schedule"
            >
              {({ onClick }) => (
                <button
                  onClick={onClick}
                  className="text-xs rounded-lg px-3 py-1.5 border border-red-500/30 text-red-400 hover:border-red-500/60 transition-colors"
                >
                  Revoke
                </button>
              )}
            </WalletConnectionGuard>
          )}
          {isBeneficiary && !schedule.revoked && (
            <button
              onClick={() => setShowTransferModal(true)}
              className="text-xs rounded-lg px-3 py-1.5 border border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200 transition-colors"
            >
              Transfer
            </button>
          )}
          {isBeneficiary && !schedule.revoked && progress > 0 && progress < 100 && (
            <WalletConnectionGuard
              onAction={() => setShowSqueezeModal(true)}
              actionName="squeeze stream"
            >
              {({ onClick }) => (
                <button
                  onClick={onClick}
                  className="text-xs rounded-lg px-3 py-1.5 border border-emerald-500/30 text-emerald-400 hover:border-emerald-500/60 transition-colors"
                >
                  Squeeze
                </button>
              )}
            </WalletConnectionGuard>
          )}
        </div>
      )}

      <ClaimModal
        schedule={schedule}
        claimableAmt={claimableAmt}
        tokenSymbol={tokenSymbol}
        open={showClaimModal}
        onClose={() => setShowClaimModal(false)}
        onSuccess={() => { setShowClaimModal(false); onAction?.(); }}
      />
      <RevokeModal
        schedule={schedule}
        vestedAmt={vested}
        tokenSymbol={tokenSymbol}
        open={showRevokeModal}
        onClose={() => setShowRevokeModal(false)}
        onSuccess={() => { setShowRevokeModal(false); onAction?.(); }}
      />
      <TransferBeneficiaryModal
        schedule={schedule}
        open={showTransferModal}
        onClose={() => setShowTransferModal(false)}
        onSuccess={() => { setShowTransferModal(false); onAction?.(); }}
      />
      {showSqueezeModal && publicKey && (
        <SqueezeModal
          schedule={schedule}
          publicKey={publicKey}
          onClose={() => setShowSqueezeModal(false)}
          onSuccess={() => { setShowSqueezeModal(false); onAction?.(); }}
        />
      )}
    </div>
  );
}
