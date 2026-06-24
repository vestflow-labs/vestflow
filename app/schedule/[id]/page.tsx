"use client";
import Navbar from "@/components/Navbar";
import VestingChart from "@/components/VestingChart";
import NotificationSubscription from "@/components/NotificationSubscription";
import { formatDate, NETWORK } from "@/lib/stellar";
import { useXlmPrice, formatUsd } from "@/lib/price";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

interface ScheduleData {
  id: number;
  grantor: string;
  beneficiary: string;
  token: string;
  total_amount: string;
  claimed: string;
  start_time: number;
  duration: number;
  cliff_duration: number;
  kind: string;
  revocable: boolean;
  revoked: boolean;
}

export default function PublicSchedulePage() {
  const params = useParams();
  const scheduleId = params?.id as string;
  
  const [schedule, setSchedule] = useState<ScheduleData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [claimable, setClaimable] = useState("0");
  const xlmPrice = useXlmPrice();

  useEffect(() => {
    if (!scheduleId) return;

    async function loadSchedule() {
      try {
        setLoading(true);
        const response = await fetch(`/api/schedules/${scheduleId}`);
        
        if (!response.ok) {
          if (response.status === 404) {
            setError("Schedule not found");
          } else {
            setError("Failed to load schedule");
          }
          return;
        }

        const data = await response.json();
        setSchedule(data.schedule);
        setClaimable(data.claimable || "0");
      } catch (err) {
        setError("Failed to load schedule details");
        console.error(err);
      } finally {
        setLoading(false);
      }
    }

    loadSchedule();
  }, [scheduleId]);

  const formatAddress = (addr: string) => {
    return addr.slice(0, 6) + "..." + addr.slice(-4);
  };

  const vestingProgress = () => {
    if (!schedule) return 0;
    const now = Math.floor(Date.now() / 1000);
    const elapsed = Math.max(0, now - schedule.start_time);
    const progress = Math.min(100, (elapsed / schedule.duration) * 100);
    return progress;
  };

  const formatAmount = (amount: string) => {
    const num = Number(amount) / 10_000_000; // Convert stroops to XLM
    return num.toLocaleString("en-US", { maximumFractionDigits: 7, minimumFractionDigits: 2 });
  };

  if (loading) {
    return (
      <>
        <Navbar />
        <main className="max-w-4xl mx-auto px-6 py-12">
          <div className="card p-8 text-center">
            <div className="inline-block">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-violet-500"></div>
            </div>
            <p className="text-zinc-400 mt-4">Loading schedule details...</p>
          </div>
        </main>
      </>
    );
  }

  if (error) {
    return (
      <>
        <Navbar />
        <main className="max-w-4xl mx-auto px-6 py-12">
          <div className="card p-8 text-center border-red-500/20">
            <p className="text-red-400 font-semibold mb-4">{error}</p>
            <Link href="/" className="text-violet-400 hover:text-violet-300 transition-colors">
              ← Back to home
            </Link>
          </div>
        </main>
      </>
    );
  }

  if (!schedule) {
    return (
      <>
        <Navbar />
        <main className="max-w-4xl mx-auto px-6 py-12">
          <div className="card p-8 text-center">
            <p className="text-zinc-400">Schedule not found</p>
            <Link href="/" className="text-violet-400 hover:text-violet-300 transition-colors mt-4">
              ← Back to home
            </Link>
          </div>
        </main>
      </>
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const endTime = schedule.start_time + schedule.duration;
  const cliffTime = schedule.cliff_duration > 0 ? schedule.start_time + schedule.cliff_duration : null;
  const isRevoked = schedule.revoked;
  const isFulVested = now >= endTime && !isRevoked;
  const isVesting = now >= schedule.start_time && now < endTime && !isRevoked;
  const notStarted = now < schedule.start_time;

  let status = "Not Started";
  let statusColor = "text-yellow-400";
  if (isRevoked) {
    status = "Revoked";
    statusColor = "text-red-400";
  } else if (isFulVested) {
    status = "Fully Vested";
    statusColor = "text-green-400";
  } else if (isVesting) {
    status = "Vesting";
    statusColor = "text-blue-400";
  }

  return (
    <>
      <Navbar />
      <main className="max-w-4xl mx-auto px-6 py-12">
        {/* Header */}
        <div className="mb-8">
          <Link href="/" className="text-zinc-400 hover:text-zinc-300 transition-colors text-sm mb-4 inline-block">
            ← Back to home
          </Link>
          <div className="flex items-center justify-between mb-4">
            <h1 className="text-3xl font-bold">Vesting Schedule #{schedule.id}</h1>
            <span className={`text-sm font-semibold px-3 py-1 rounded-full border ${statusColor} border-current/20 bg-current/5`}>
              {status}
            </span>
          </div>
          <p className="text-zinc-400">Network: {NETWORK === "mainnet" ? "Stellar Mainnet" : "Stellar Testnet"}</p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
          {/* Summary Cards */}
          <div className="card p-6">
            <p className="text-zinc-400 text-sm mb-2">Total Amount</p>
            <p className="text-2xl font-bold mb-1">{formatAmount(schedule.total_amount)} XLM</p>
            {xlmPrice !== null && (
              <p className="text-zinc-400 text-sm">{formatUsd(BigInt(schedule.total_amount), xlmPrice)}</p>
            )}
            <p className="text-xs text-zinc-500 mt-1">{schedule.total_amount} stroops</p>
          </div>

          <div className="card p-6">
            <p className="text-zinc-400 text-sm mb-2">Claimed</p>
            <p className="text-2xl font-bold mb-1">{formatAmount(schedule.claimed)} XLM</p>
            {xlmPrice !== null && (
              <p className="text-zinc-400 text-sm">{formatUsd(BigInt(schedule.claimed), xlmPrice)}</p>
            )}
            <p className="text-xs text-zinc-500 mt-1">{schedule.claimed} stroops</p>
          </div>

          <div className="card p-6">
            <p className="text-zinc-400 text-sm mb-2">Remaining</p>
            <p className="text-2xl font-bold mb-1">
              {formatAmount(String(BigInt(schedule.total_amount) - BigInt(schedule.claimed)))} XLM
            </p>
            {xlmPrice !== null && (
              <p className="text-zinc-400 text-sm">
                {formatUsd(BigInt(schedule.total_amount) - BigInt(schedule.claimed), xlmPrice)}
              </p>
            )}
            <p className="text-xs text-zinc-500 mt-1">
              {(BigInt(schedule.total_amount) - BigInt(schedule.claimed)).toString()} stroops
            </p>
          </div>
        </div>

        {/* Vesting Chart */}
        <div className="card p-6 mb-8">
          <h2 className="text-lg font-semibold mb-4">Vesting Timeline</h2>
          <VestingChart schedule={schedule as any} />
        </div>

        {/* Schedule Details */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
          <div className="card p-6">
            <h3 className="font-semibold mb-4">Schedule Info</h3>
            <div className="space-y-3">
              <div>
                <p className="text-xs text-zinc-500 mb-1">Schedule ID</p>
                <div className="flex items-center gap-2">
                  <p className="font-mono text-sm">{schedule.id}</p>
                  <CopyButton value={String(schedule.id)} label={`Copy schedule ${schedule.id}`} />
                </div>
              </div>
              <div>
                <p className="text-xs text-zinc-500 mb-1">Type</p>
                <p className="text-sm capitalize">{schedule.kind === "LinearWithCliff" ? "Linear with Cliff" : schedule.kind}</p>
              </div>
              <div>
                <p className="text-xs text-zinc-500 mb-1">Revocable</p>
                <p className="text-sm">{schedule.revocable ? "Yes" : "No"}</p>
              </div>
            </div>
          </div>

          <div className="card p-6">
            <h3 className="font-semibold mb-4">Timeline</h3>
            <div className="space-y-3">
              <div>
                <p className="text-xs text-zinc-500 mb-1">Start Date</p>
                <p className="text-sm">{formatDate(schedule.start_time)}</p>
              </div>
              <div>
                <p className="text-xs text-zinc-500 mb-1">End Date</p>
                <p className="text-sm">{formatDate(endTime)}</p>
              </div>
              {cliffTime && (
                <div>
                  <p className="text-xs text-zinc-500 mb-1">Cliff Date</p>
                  <p className="text-sm">{formatCliffDate(schedule.cliff_duration, schedule.start_time)}</p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Addresses */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="card p-6">
            <div className="flex items-start justify-between gap-3 mb-2">
              <h3 className="font-semibold">Grantor (Issuer)</h3>
              <CopyButton value={schedule.grantor} label="Copy grantor address" />
            </div>
            <p className="font-mono text-sm break-all text-zinc-300">{schedule.grantor}</p>
            <a
              href={`https://stellar.expert/explorer/${NETWORK}/account/${schedule.grantor}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-violet-400 hover:text-violet-300 transition-colors text-sm mt-2 inline-block"
            >
              View on Stellar Expert →
            </a>
          </div>

          <div className="card p-6">
            <div className="flex items-start justify-between gap-3 mb-2">
              <h3 className="font-semibold">Beneficiary (Recipient)</h3>
              <CopyButton value={schedule.beneficiary} label="Copy beneficiary address" />
            </div>
            <p className="font-mono text-sm break-all text-zinc-300">{schedule.beneficiary}</p>
            <a
              href={`https://stellar.expert/explorer/${NETWORK}/account/${schedule.beneficiary}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-violet-400 hover:text-violet-300 transition-colors text-sm mt-2 inline-block"
            >
              View on Stellar Expert →
            </a>
          </div>
        </div>

        {/* Notification Subscription */}
        <NotificationSubscription
          scheduleId={schedule.id}
          beneficiaryAddress={schedule.beneficiary}
        />

        {/* Share Section */}
        <div className="card p-6 border-violet-500/20 bg-violet-500/5">
          <h3 className="font-semibold mb-3">Share This Schedule</h3>
          <p className="text-sm text-zinc-400 mb-4">Copy the link below to share this public schedule view:</p>
          <div className="flex gap-2">
            <input
              type="text"
              value={`${typeof window !== "undefined" ? window.location.origin : ""}/schedule/${schedule.id}`}
              readOnly
              className="flex-1 px-3 py-2 bg-zinc-900 border border-zinc-700 rounded text-sm font-mono text-zinc-300"
            />
            <button
              onClick={() => {
                navigator.clipboard.writeText(`${typeof window !== "undefined" ? window.location.origin : ""}/schedule/${schedule.id}`);
                alert("Link copied to clipboard!");
              }}
              className="px-4 py-2 bg-violet-600 hover:bg-violet-700 rounded font-semibold transition-colors"
            >
              Copy
            </button>
          </div>
        </div>
      </main>
    </>
  );
}
