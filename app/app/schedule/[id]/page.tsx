"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import Navbar from "@/components/Navbar";
import VestingChart from "@/components/VestingChart";
import {
  getSchedule,
  ScheduleData,
  stroopsToXlm,
  vestingProgress,
  formatDate,
  claimVested,
  revokeSchedule,
  parseContractError,
  NETWORK,
} from "@/lib/stellar";
import { useWallet } from "@/lib/WalletContext";

export default function ScheduleDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { publicKey } = useWallet();
  const [schedule, setSchedule] = useState<ScheduleData | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<"claim" | "revoke" | null>(null);
  const [err, setErr] = useState("");

  const load = async () => {
    setLoading(true);
    const s = await getSchedule(Number(id), publicKey ?? undefined);
    setSchedule(s);
    setLoading(false);
  };

  useEffect(() => { load(); }, [id]);

  const now = Math.floor(Date.now() / 1000);

  const handleClaim = async () => {
    if (!publicKey || !schedule) return;
    setActionLoading("claim"); setErr("");
    try { await claimVested(publicKey, schedule.id); await load(); }
    catch (e: any) { setErr(parseContractError(e)); }
    finally { setActionLoading(null); }
  };

  const handleRevoke = async () => {
    if (!publicKey || !schedule) return;
    setActionLoading("revoke"); setErr("");
    try { await revokeSchedule(publicKey, schedule.id); await load(); }
    catch (e: any) { setErr(parseContractError(e)); }
    finally { setActionLoading(null); }
  };

  if (loading) return (
    <>
      <Navbar />
      <main className="max-w-3xl mx-auto px-6 pt-28 pb-20">
        <div className="h-96 rounded-2xl bg-white/3 animate-pulse" />
      </main>
    </>
  );

  if (!schedule) return (
    <>
      <Navbar />
      <main className="max-w-3xl mx-auto px-6 pt-28 pb-20 text-center">
        <p className="text-zinc-400 text-lg">Schedule not found.</p>
        <Link href="/app" className="mt-4 inline-block text-violet-400 hover:underline text-sm">
          ← Back to Dashboard
        </Link>
      </main>
    </>
  );

  const progress = vestingProgress(schedule, now);
  const isBeneficiary = publicKey === schedule.beneficiary;
  const isGrantor = publicKey === schedule.grantor;
  const vested = BigInt(Math.floor(Number(schedule.total_amount) * progress / 100));
  const claimableAmt = vested > schedule.claimed ? vested - schedule.claimed : 0n;

  const statusColor = schedule.revoked
    ? "bg-red-500/10 text-red-400"
    : progress >= 100
    ? "bg-green-500/10 text-green-400"
    : "bg-violet-500/10 text-violet-400";
  const statusLabel = schedule.revoked ? "Revoked" : progress >= 100 ? "Fully Vested" : "Vesting";

  return (
    <>
      <Navbar />
      <main className="max-w-3xl mx-auto px-6 pt-28 pb-20 flex flex-col gap-6">
        <Link href="/app" className="text-zinc-500 hover:text-zinc-300 text-sm transition-colors w-fit">
          ← Dashboard
        </Link>

        <div className="card p-6 flex flex-col gap-6">
          {/* Header */}
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-2xl font-bold">Schedule #{schedule.id}</h1>
              <p className="text-zinc-400 mt-1 text-sm">
                {schedule.kind} vesting{schedule.revocable ? " · revocable" : ""}
              </p>
            </div>
            <span className={`text-sm font-medium px-3 py-1 rounded-full ${statusColor}`}>
              {statusLabel}
            </span>
          </div>

          {/* Vesting Curve — always visible on the detail page */}
          <div>
            <p className="text-xs text-zinc-500 mb-3 uppercase tracking-wider">Vesting Curve</p>
            <VestingChart schedule={schedule} />
          </div>

          {/* Progress bar */}
          <div>
            <div className="flex justify-between text-sm text-zinc-400 mb-2">
              <span>Vested</span>
              <span>{progress}%</span>
            </div>
            <div className="h-2 rounded-full bg-white/5 overflow-hidden">
              <div
                className="h-full rounded-full bg-gradient-to-r from-violet-500 to-cyan-500 transition-all"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>

          {/* Details grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-zinc-500 text-xs uppercase tracking-wider mb-1">Grantor</p>
              <a href={`https://stellar.expert/explorer/${NETWORK}/account/${schedule.grantor}`} target="_blank" rel="noopener noreferrer" className="font-mono text-zinc-300 hover:text-violet-300 break-all transition-colors">
                {schedule.grantor}
              </a>
            </div>
            <div>
              <p className="text-zinc-500 text-xs uppercase tracking-wider mb-1">Beneficiary</p>
              <a href={`https://stellar.expert/explorer/${NETWORK}/account/${schedule.beneficiary}`} target="_blank" rel="noopener noreferrer" className="font-mono text-zinc-300 hover:text-violet-300 break-all transition-colors">
                {schedule.beneficiary}
              </a>
            </div>
            <div>
              <p className="text-zinc-500 text-xs uppercase tracking-wider mb-1">Total Amount</p>
              <p className="text-zinc-300">{stroopsToXlm(schedule.total_amount)} XLM</p>
            </div>
            <div>
              <p className="text-zinc-500 text-xs uppercase tracking-wider mb-1">Claimed</p>
              <p className="text-zinc-300">{stroopsToXlm(schedule.claimed)} XLM</p>
            </div>
            <div>
              <p className="text-zinc-500 text-xs uppercase tracking-wider mb-1">Start Date</p>
              <p className="text-zinc-300">{formatDate(schedule.start_time)}</p>
            </div>
            <div>
              <p className="text-zinc-500 text-xs uppercase tracking-wider mb-1">End Date</p>
              <p className="text-zinc-300">{formatDate(schedule.start_time + schedule.duration)}</p>
            </div>
            {schedule.cliff_duration > 0 && (
              <div>
                <p className="text-zinc-500 text-xs uppercase tracking-wider mb-1">Cliff Date</p>
                <p className="text-zinc-300">{formatDate(schedule.start_time + schedule.cliff_duration)}</p>
              </div>
            )}
            <div>
              <p className="text-zinc-500 text-xs uppercase tracking-wider mb-1">Token</p>
              <a href={`https://stellar.expert/explorer/${NETWORK}/asset/${schedule.token}`} target="_blank" rel="noopener noreferrer" className="font-mono text-zinc-300 hover:text-violet-300 transition-colors">
                {schedule.token}
              </a>
            </div>
          </div>

          {/* Share link */}
          <div className="border-t border-white/5 pt-4">
            <p className="text-zinc-500 text-xs uppercase tracking-wider mb-1">Shareable Link</p>
            <p className="font-mono text-xs text-zinc-400 break-all select-all">
              {typeof window !== "undefined" ? window.location.href : `/app/schedule/${schedule.id}`}
            </p>
          </div>

          {err && (
            <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              {err}
            </p>
          )}

          {publicKey && !schedule.revoked && (
            <div className="flex gap-3 flex-wrap">
              {isBeneficiary && claimableAmt > 0n && (
                <button
                  onClick={handleClaim}
                  disabled={!!actionLoading}
                  className="btn-primary rounded-xl px-5 py-2.5 font-semibold text-white text-sm disabled:opacity-60"
                >
                  {actionLoading === "claim" ? "Processing…" : `Claim ${stroopsToXlm(claimableAmt)} XLM`}
                </button>
              )}
              {isGrantor && schedule.revocable && progress < 100 && (
                <button
                  onClick={handleRevoke}
                  disabled={!!actionLoading}
                  className="rounded-xl px-5 py-2.5 border border-red-500/30 text-red-400 hover:border-red-500/60 transition-colors text-sm disabled:opacity-60"
                >
                  {actionLoading === "revoke" ? "Processing…" : "Revoke Schedule"}
                </button>
              )}
            </div>
          )}
        </div>
      </main>
    </>
  );
}
