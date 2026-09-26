"use client";

import { useEffect, useState, useCallback } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { NATIVE_TOKEN, NETWORK, stroopsToXlm } from "@/lib/stellar";
import StreamListSkeleton from "@/components/StreamListSkeleton";

interface IncomingStream {
  sender: string;
  token: string;
  ratePerSec: bigint;
  maxEndTime: number;
}

const PAGE_SIZE = 20;

function tokenLabel(token: string): string {
  if (token === NATIVE_TOKEN) return "XLM";
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

function truncateAddress(addr: string): string {
  if (addr.length <= 14) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

interface IncomingStreamsListProps {
  publicKey: string;
  refreshKey: number;
}

export default function IncomingStreamsList({ publicKey, refreshKey }: IncomingStreamsListProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const currentPage = parseInt(searchParams.get('incomingPage') || '1', 10);
  const [streams, setStreams] = useState<IncomingStream[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchStreams = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/streams/incoming?account=${publicKey}&network=${NETWORK}`);
      if (!res.ok) {
        setStreams([]);
        return;
      }
      const data = await res.json();
      const items = Array.isArray(data.streams) ? data.streams : [];
      setStreams(
        items.map((s: any) => ({
          sender: String(s.sender ?? ""),
          token: String(s.token ?? NATIVE_TOKEN),
          ratePerSec: BigInt(String(s.rate_per_sec ?? s.ratePerSec ?? 0)),
          maxEndTime: Number(s.max_end_time ?? s.maxEndTime ?? 0),
        })),
      );
    } catch {
      setStreams([]);
    } finally {
      setLoading(false);
    }
  }, [publicKey]);

  useEffect(() => {
    fetchStreams();
  }, [fetchStreams, refreshKey]);

  if (loading) {
    return <StreamListSkeleton />;
  }

  if (streams.length === 0) return null;

  const totalPages = Math.ceil(streams.length / PAGE_SIZE);
  const startIdx = (currentPage - 1) * PAGE_SIZE;
  const endIdx = startIdx + PAGE_SIZE;
  const paginatedStreams = streams.slice(startIdx, endIdx);
  const canGoNext = currentPage < totalPages;
  const canGoPrev = currentPage > 1;

  const handlePrevPage = () => {
    const params = new URLSearchParams(searchParams);
    params.set('incomingPage', String(currentPage - 1));
    router.push(`?${params.toString()}`);
  };

  const handleNextPage = () => {
    const params = new URLSearchParams(searchParams);
    params.set('incomingPage', String(currentPage + 1));
    router.push(`?${params.toString()}`);
  };

  return (
    <div className="card p-5 mb-6">
      <div className="flex items-center justify-between gap-3 mb-4">
        <div>
          <h2 className="text-lg font-semibold">Incoming Streams</h2>
          <p className="text-sm text-zinc-500">Accounts streaming tokens to your wallet</p>
        </div>
          <button
            onClick={fetchStreams}
            disabled={loading}
            className="text-sm text-zinc-400 hover:text-white border border-white/10 rounded-lg px-3 py-1.5 min-h-[44px] transition-colors disabled:opacity-40 inline-flex items-center"
            aria-label="Refresh incoming streams"
          >
          ↻ Refresh
        </button>
      </div>
      <div className="divide-y divide-white/10">
        {paginatedStreams.map((stream, i) => {
          const ratePerDay = stream.ratePerSec * 86400n;
          const hasEnd = stream.maxEndTime > 0;
          const isExpired = hasEnd && stream.maxEndTime <= Math.floor(Date.now() / 1000);
          return (
            <div key={`${stream.sender}-${stream.token}-${i}`} className="flex items-start justify-between gap-4 py-3 text-sm">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-zinc-300 text-xs" title={stream.sender}>
                    {truncateAddress(stream.sender)}
                  </span>
                  {isExpired && (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-red-500/10 text-red-400 border border-red-500/20">
                      Expired
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-zinc-500">
                  <span>
                    Rate:{" "}
                    <span className="text-zinc-300">
                      {stroopsToXlm(stream.ratePerSec)}/s
                    </span>
                  </span>
                  <span>
                    Daily:{" "}
                    <span className="text-zinc-300">
                      {stroopsToXlm(ratePerDay)} {tokenLabel(stream.token)}
                    </span>
                  </span>
                  <span>
                    Token:{" "}
                    <span className="text-zinc-300">{tokenLabel(stream.token)}</span>
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-4 mt-4 pt-4 border-t border-white/10">
          <button
            onClick={handlePrevPage}
            disabled={!canGoPrev}
            className="px-4 py-2 text-sm font-medium border border-white/10 rounded-lg text-zinc-300 hover:border-white/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            aria-label="Previous page"
          >
            ← Previous
          </button>
          <span className="text-sm text-zinc-400">
            Page {currentPage} of {totalPages}
          </span>
          <button
            onClick={handleNextPage}
            disabled={!canGoNext}
            className="px-4 py-2 text-sm font-medium border border-white/10 rounded-lg text-zinc-300 hover:border-white/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            aria-label="Next page"
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
