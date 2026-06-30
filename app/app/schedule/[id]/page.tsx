"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import Navbar from "@/components/Navbar";
import { useToast } from "@/components/Toast";
import VestingChart from "@/components/VestingChart";
import ClaimModal from "@/components/ClaimModal";
import AddressLabel from "@/components/AddressLabel";
import {
  getSchedule,
  getClaimableAtTimestamp,
  getMilestones,
  transferGrantor,
  ScheduleData,
  PerformanceMilestoneData,
  stroopsToXlm,
  vestingProgress,
  formatDate,
  formatCliffDate,
  revokeSchedule,
  parseContractError,
  NETWORK,
  NATIVE_TOKEN,
} from "@/lib/stellar";
import { useWallet } from "@/lib/WalletContext";
import { useXlmPrice, formatUsd } from "@/lib/price";
import { ScheduleDetailSkeleton } from "@/components/ScheduleCardSkeleton";

export default function ScheduleDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { publicKey } = useWallet();
  const { addToast, updateToast } = useToast();
  const [schedule, setSchedule] = useState<ScheduleData | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<"claim" | "revoke" | null>(null);
  const [showClaimModal, setShowClaimModal] = useState(false);
  const [err, setErr] = useState("");
  const [lastTxHash, setLastTxHash] = useState<string | null>(null);
  const [milestones, setMilestones] = useState<PerformanceMilestoneData[] | null>(null);
  const [milestonesLoading, setMilestonesLoading] = useState(false);
  const xlmPrice = useXlmPrice();

  // Future preview state (#258)
  const [previewDate, setPreviewDate] = useState("");
  const [previewAmount, setPreviewAmount] = useState<bigint | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  // Transfer grantor state (#262)
  const [showTransferGrantor, setShowTransferGrantor] = useState(false);
  const [newGrantorInput, setNewGrantorInput] = useState("");
  const [transferGrantorLoading, setTransferGrantorLoading] = useState(false);
  const [transferGrantorErr, setTransferGrantorErr] = useState("");

  const load = async () => {
    setLoading(true);
    const s = await getSchedule(Number(id), publicKey ?? undefined);
    setSchedule(s);
    setLoading(false);
    if (s?.requires_milestones) {
      setMilestonesLoading(true);
      const ms = await getMilestones(s.id, publicKey ?? undefined);
      setMilestones(ms);
      setMilestonesLoading(false);
    } else {
      setMilestones(null);
    }
  };

  useEffect(() => { load(); }, [id]);

  const now = Math.floor(Date.now() / 1000);

  const handleRevoke = async () => {
    if (!publicKey || !schedule) return;
    setActionLoading("revoke"); setErr(""); setLastTxHash(null);
    const toastId = addToast({
      status: "pending",
      title: "Revoke pending…",
      message: "Waiting for transaction to confirm.",
    });
    try {
      const hash = await revokeSchedule(publicKey, schedule.id);
      setLastTxHash(hash);
      updateToast(toastId, {
        status: "success",
        title: "Schedule revoked",
        message: "Unvested tokens returned to your wallet.",
        txHash: hash,
        network: NETWORK,
      });
      await load();
    }
    catch (e: any) {
      setErr(parseContractError(e));
      updateToast(toastId, { status: "error", title: "Revoke failed", message: parseContractError(e) });
    }
    finally { setActionLoading(null); }
  };

  const handlePreviewDate = async (date: string) => {
    setPreviewDate(date);
    if (!date || !schedule) { setPreviewAmount(null); return; }
    setPreviewLoading(true);
    const ts = Math.floor(new Date(date).getTime() / 1000);
    const amount = await getClaimableAtTimestamp(schedule.id, ts, publicKey ?? undefined);
    setPreviewAmount(amount);
    setPreviewLoading(false);
  };

  const handleTransferGrantor = async () => {
    if (!publicKey || !schedule || !newGrantorInput.trim()) return;
    setTransferGrantorLoading(true);
    setTransferGrantorErr("");
    const toastId = addToast({ status: "pending", title: "Transfer pending…", message: "Waiting for transaction to confirm." });
    try {
      const hash = await transferGrantor(publicKey, schedule.id, newGrantorInput.trim());
      setLastTxHash(hash);
      updateToast(toastId, { status: "success", title: "Grantor transferred", message: "Rights moved to the new address.", txHash: hash, network: NETWORK });
      setShowTransferGrantor(false);
      setNewGrantorInput("");
      await load();
    } catch (e: any) {
      const msg = parseContractError(e);
      setTransferGrantorErr(msg);
      updateToast(toastId, { status: "error", title: "Transfer failed", message: msg });
    } finally {
      setTransferGrantorLoading(false);
    }
  };

  if (loading) return (
    <>
      <Navbar />
      <main className="max-w-3xl mx-auto px-6 pt-28 pb-20">
        <ScheduleDetailSkeleton />
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
  const isNative = schedule.token === NATIVE_TOKEN;
  const tokenSymbol = isNative ? "XLM" : `Token (${schedule.token.slice(0, 4)}...${schedule.token.slice(-4)})`;

  // Claimed percentage for the dual progress bar
  const claimedPct = schedule.total_amount > 0n
    ? Math.min(100, Math.round((Number(schedule.claimed) / Number(schedule.total_amount)) * 100))
    : 0;

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

          {/* Progress bar — dual layer: vested + claimed */}
          <div>
            <div className="flex justify-between text-sm text-zinc-400 mb-2">
              <div className="flex items-center gap-3 text-xs">
                <span className="flex items-center gap-1">
                  <span className="inline-block w-2 h-2 rounded-full bg-gradient-to-r from-violet-500 to-cyan-500" aria-hidden="true" />
                  Vested {progress}%
                </span>
                <span className="flex items-center gap-1">
                  <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" aria-hidden="true" />
                  Claimed {claimedPct}%
                </span>
              </div>
            </div>
            <div
              className="relative h-2.5 rounded-full bg-white/5 overflow-hidden"
              role="progressbar"
              aria-label={`Vesting progress: ${progress}% vested, ${claimedPct}% claimed`}
              aria-valuenow={progress}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              {/* Vested layer */}
              <div
                className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-violet-500 to-cyan-500 transition-all duration-700"
                style={{ width: `${progress}%` }}
              />
              {/* Claimed layer */}
              {claimedPct > 0 && (
                <div
                  className="absolute inset-y-0 left-0 rounded-full bg-emerald-500/80 transition-all duration-700"
                  style={{ width: `${claimedPct}%` }}
                />
              )}
            </div>
          </div>

          {/* Details grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-zinc-500 text-xs uppercase tracking-wider mb-1">Grantor</p>
              <AddressLabel
                address={schedule.grantor}
                fullAddress
                editable
                secondaryClassName="text-xs font-mono text-zinc-500 break-all"
              />
              <a
                href={`https://stellar.expert/explorer/${NETWORK}/account/${schedule.grantor}`}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 inline-block text-xs text-violet-300 hover:text-violet-200 transition-colors"
              >
                View on Stellar Expert →
              </a>
            </div>
            <div>
              <p className="text-zinc-500 text-xs uppercase tracking-wider mb-1">Beneficiary</p>
              <AddressLabel
                address={schedule.beneficiary}
                fullAddress
                editable
                secondaryClassName="text-xs font-mono text-zinc-500 break-all"
              />
              <a
                href={`https://stellar.expert/explorer/${NETWORK}/account/${schedule.beneficiary}`}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 inline-block text-xs text-violet-300 hover:text-violet-200 transition-colors"
              >
                View on Stellar Expert →
              </a>
            </div>
            <div>
              <p className="text-zinc-500 text-xs uppercase tracking-wider mb-1">Total Amount</p>
              <p className="text-zinc-300">{stroopsToXlm(schedule.total_amount)} XLM</p>
              {xlmPrice !== null && (
                <p className="text-zinc-500 text-xs mt-0.5">{formatUsd(schedule.total_amount, xlmPrice)}</p>
              )}
            </div>
            <div>
              <p className="text-zinc-500 text-xs uppercase tracking-wider mb-1">Claimed</p>
              <p className="text-zinc-300">{stroopsToXlm(schedule.claimed)} XLM</p>
              {xlmPrice !== null && (
                <p className="text-zinc-500 text-xs mt-0.5">{formatUsd(schedule.claimed, xlmPrice)}</p>
              )}
            </div>
            <div>
              <p className="text-zinc-500 text-xs uppercase tracking-wider mb-1">Start Date</p>
              <p className="text-zinc-300">{formatDate(schedule.start_time)}</p>
            </div>
            <div>
              <p className="text-zinc-500 text-xs uppercase tracking-wider mb-1">End Date</p>
              <p className="text-zinc-300">{formatDate(schedule.start_time + schedule.duration)}</p>
            </div>
            {schedule.kind !== "Linear" && schedule.cliff_duration > 0 && (
              <div>
                <p className="text-zinc-500 text-xs uppercase tracking-wider mb-1">Cliff Date</p>
                <p className="text-zinc-300">{formatCliffDate(schedule.cliff_duration, schedule.start_time)}</p>
              </div>
            )}
            <div>
              <p className="text-zinc-500 text-xs uppercase tracking-wider mb-1">Token</p>
              <a href={`https://stellar.expert/explorer/${NETWORK}/asset/${schedule.token}`} target="_blank" rel="noopener noreferrer" className="font-mono text-zinc-300 hover:text-violet-300 transition-colors">
                {schedule.token}
              </a>
            </div>
          </div>

          {/* Performance milestones (oracle-attested) */}
          {schedule.requires_milestones && (
            <div className="border-t border-white/5 pt-4">
              <p className="text-zinc-500 text-xs uppercase tracking-wider mb-3">Performance Milestones</p>
              {milestonesLoading ? (
                <p className="text-xs text-zinc-500">Loading milestones…</p>
              ) : milestones && milestones.length > 0 ? (
                <div className="flex flex-col gap-2">
                  {milestones.map((m, i) => (
                    <div
                      key={i}
                      className={`flex items-center justify-between rounded-lg px-3 py-2 text-sm ${
                        m.attested
                          ? "bg-emerald-500/10 border border-emerald-500/20"
                          : "bg-zinc-800/40 border border-zinc-700/50"
                      }`}
                    >
                      <div className="flex items-center gap-2.5">
                        <span
                          className={`flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold ${
                            m.attested
                              ? "bg-emerald-500/20 text-emerald-400"
                              : "bg-zinc-700 text-zinc-500"
                          }`}
                        >
                          {m.attested ? "✓" : i + 1}
                        </span>
                        <div>
                          <p className={m.attested ? "text-zinc-200" : "text-zinc-400"}>
                            {m.unlock_percentage}% unlock
                          </p>
                          {m.attested && m.attested_at > 0 && (
                            <p className="text-[11px] text-zinc-500 mt-0.5">
                              Attested {formatDate(m.attested_at)}
                            </p>
                          )}
                        </div>
                      </div>
                      <span
                        className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                          m.attested
                            ? "bg-emerald-500/10 text-emerald-400"
                            : "bg-amber-500/10 text-amber-400"
                        }`}
                      >
                        {m.attested ? "Attested" : "Pending"}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-zinc-500">No milestones configured.</p>
              )}
            </div>
          )}

          {/* Future claimable preview (#258) */}
          {!schedule.revoked && (
            <div className="border-t border-white/5 pt-4">
              <p className="text-zinc-500 text-xs uppercase tracking-wider mb-2">Preview Claimable At Date</p>
              <div className="flex items-center gap-3 flex-wrap">
                <input
                  type="date"
                  value={previewDate}
                  onChange={(e) => handlePreviewDate(e.target.value)}
                  className="input text-sm px-3 py-1.5 rounded-lg bg-zinc-800/60 border border-zinc-700 text-zinc-200 focus:outline-none focus:border-violet-500"
                />
                {previewLoading && <span className="text-xs text-zinc-500">Calculating…</span>}
                {!previewLoading && previewAmount !== null && (
                  <span className="text-sm text-zinc-300">
                    <span className="font-semibold text-violet-300">{stroopsToXlm(previewAmount)} XLM</span>
                    {xlmPrice !== null && previewAmount > 0n && (
                      <span className="text-zinc-500 ml-1">({(Number(previewAmount) / 10_000_000 * xlmPrice).toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 })})</span>
                    )}
                    <span className="text-zinc-500 ml-1">claimable</span>
                  </span>
                )}
              </div>
            </div>
          )}

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

          {lastTxHash && (
            <div className="text-sm bg-green-500/10 border border-green-500/20 rounded-lg px-3 py-2 flex flex-col gap-1">
              <span className="text-green-400 font-medium">Transaction confirmed</span>
              <a
                href={`https://stellar.expert/explorer/${NETWORK}/tx/${lastTxHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-xs text-violet-400 hover:underline break-all"
              >
                {lastTxHash}
              </a>
            </div>
          )}

          {publicKey && !schedule.revoked && (
            <div className="flex gap-3 flex-wrap">
              {isBeneficiary && claimableAmt > 0n && (
                <button
                  onClick={() => setShowClaimModal(true)}
                  className="btn-primary rounded-xl px-5 py-2.5 font-semibold text-white text-sm"
                >
                  Claim {stroopsToXlm(claimableAmt)} XLM{xlmPrice !== null ? ` (${formatUsd(claimableAmt, xlmPrice)})` : ""}
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
              {isGrantor && (
                <button
                  onClick={() => { setShowTransferGrantor((v) => !v); setTransferGrantorErr(""); }}
                  className="rounded-xl px-5 py-2.5 border border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200 transition-colors text-sm"
                >
                  Transfer Grantor Rights
                </button>
              )}
            </div>
          )}

          {/* Transfer grantor form (#262) */}
          {showTransferGrantor && isGrantor && (
            <div className="flex flex-col gap-3 bg-zinc-900/50 rounded-xl p-4 border border-zinc-800">
              <p className="text-sm text-zinc-300 font-medium">Transfer Grantor Rights</p>
              <p className="text-xs text-zinc-500">Move revocation and pause rights to a new address. This action requires your wallet signature.</p>
              <input
                type="text"
                placeholder="New grantor address (G…)"
                value={newGrantorInput}
                onChange={(e) => setNewGrantorInput(e.target.value)}
                className="input text-sm"
              />
              {transferGrantorErr && (
                <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{transferGrantorErr}</p>
              )}
              <div className="flex gap-2">
                <button
                  onClick={handleTransferGrantor}
                  disabled={transferGrantorLoading || !newGrantorInput.trim()}
                  className="btn-primary rounded-xl px-4 py-2 text-sm font-semibold disabled:opacity-60"
                >
                  {transferGrantorLoading ? "Processing…" : "Confirm Transfer"}
                </button>
                <button
                  onClick={() => { setShowTransferGrantor(false); setNewGrantorInput(""); setTransferGrantorErr(""); }}
                  className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors px-4 py-2"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </main>

      <ClaimModal
        schedule={schedule}
        claimableAmt={claimableAmt}
        tokenSymbol={tokenSymbol}
        open={showClaimModal}
        onClose={() => setShowClaimModal(false)}
        onSuccess={() => { setShowClaimModal(false); load(); }}
      />
    </>
  );
}
