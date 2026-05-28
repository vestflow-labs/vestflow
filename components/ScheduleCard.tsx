"use client";
import { useState } from "react";
import { ScheduleData, stroopsToXlm, truncate, vestingProgress, formatDate, claimVested, revokeSchedule } from "@/lib/stellar";
import { useWallet } from "@/lib/WalletContext";

export default function ScheduleCard({ schedule, onAction }: { schedule: ScheduleData; onAction: () => void }) {
  const { publicKey } = useWallet();
  const [loading, setLoading] = useState<"claim" | "revoke" | null>(null);
  const [err, setErr] = useState("");

  const now = Math.floor(Date.now() / 1000);
  const progress = vestingProgress(schedule, now);
  const isBeneficiary = publicKey === schedule.beneficiary;
  const isGrantor = publicKey === schedule.grantor;
  const vested = BigInt(Math.floor(Number(schedule.total_amount) * progress / 100));
  const claimableAmt = vested > schedule.claimed ? vested - schedule.claimed : BigInt(0);
  const cliffUnlockTime = schedule.start_time + schedule.cliff_duration;
  const showCliffUnlock = schedule.kind === "Cliff" && now < cliffUnlockTime;

  const handleClaim = async () => {
    if (!publicKey) return;
    setLoading("claim"); setErr("");
    try { await claimVested(publicKey, schedule.id); onAction(); }
    catch (e: any) { setErr(e.message); }
    finally { setLoading(null); }
  };

  const handleRevoke = async () => {
    if (!publicKey) return;
    setLoading("revoke"); setErr("");
    try { await revokeSchedule(publicKey, schedule.id); onAction(); }
    catch (e: any) { setErr(e.message); }
    finally { setLoading(null); }
  };

  const statusColor = schedule.revoked
    ? "bg-red-500/10 text-red-400"
    : progress >= 100
    ? "bg-green-500/10 text-green-400"
    : "bg-violet-500/10 text-violet-400";

  const statusLabel = schedule.revoked ? "Revoked" : progress >= 100 ? "Fully Vested" : "Vesting";

  return (
    <div className="card p-5 flex flex-col gap-3">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm font-semibold text-white">Schedule #{schedule.id}</p>
          <p className="text-xs text-zinc-500 mt-0.5">{schedule.kind} vesting{schedule.revocable ? " · revocable" : ""}</p>
        </div>
        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${statusColor}`}>{statusLabel}</span>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs text-zinc-400">
        <div><span className="text-zinc-600">Grantor</span><p className="font-mono text-zinc-300 mt-0.5">{truncate(schedule.grantor)}</p></div>
        <div><span className="text-zinc-600">Beneficiary</span><p className="font-mono text-zinc-300 mt-0.5">{truncate(schedule.beneficiary)}</p></div>
        <div><span className="text-zinc-600">Total</span><p className="text-zinc-300 mt-0.5">{stroopsToXlm(schedule.total_amount)} XLM</p></div>
        <div><span className="text-zinc-600">Claimed</span><p className="text-zinc-300 mt-0.5">{stroopsToXlm(schedule.claimed)} XLM</p></div>
        <div><span className="text-zinc-600">Starts</span><p className="text-zinc-300 mt-0.5">{formatDate(schedule.start_time)}</p></div>
        <div><span className="text-zinc-600">Ends</span><p className="text-zinc-300 mt-0.5">{formatDate(schedule.start_time + schedule.duration)}</p></div>
      </div>

      <div>
        <div className="flex justify-between text-xs text-zinc-500 mb-1">
          <span>Vested</span><span>{progress}%</span>
        </div>
        <div className="h-1.5 rounded-full bg-white/5 overflow-hidden">
          <div className="h-full rounded-full bg-gradient-to-r from-violet-500 to-cyan-500 transition-all" style={{ width: `${progress}%` }} />
        </div>
        {showCliffUnlock && (
          <p className="text-xs text-zinc-500 mt-2">Unlocks on {formatDate(cliffUnlockTime)}</p>
        )}
      </div>

      {err && <p className="text-xs text-red-400">{err}</p>}

      {publicKey && !schedule.revoked && (
        <div className="flex gap-2 mt-1">
          {isBeneficiary && claimableAmt > 0n && (
            <button onClick={handleClaim} disabled={!!loading} className="btn-primary text-xs rounded-lg px-3 py-1.5 font-semibold text-white disabled:opacity-60">
              {loading === "claim" ? "Processing…" : `Claim ${stroopsToXlm(claimableAmt)} XLM`}
            </button>
          )}
          {isGrantor && schedule.revocable && progress < 100 && (
            <button onClick={handleRevoke} disabled={!!loading} className="text-xs rounded-lg px-3 py-1.5 border border-red-500/30 text-red-400 hover:border-red-500/60 transition-colors disabled:opacity-60">
              {loading === "revoke" ? "Processing…" : "Revoke"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
