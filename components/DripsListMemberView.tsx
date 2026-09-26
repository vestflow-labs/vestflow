"use client";

import { useMemo } from "react";
import AddressLabel from "@/components/AddressLabel";
import { stroopsToXlm } from "@/lib/stellar";
import { useXlmPrice, formatUsd } from "@/lib/price";
import { getTokenSymbol } from "@/lib/tokens";

export const SECONDS_PER_MONTH = 2592000n; // 30 days * 24 hours * 3600 seconds

export interface DripsMember {
  address: string;
  joined_at: number;
}

interface DripsListMemberViewProps {
  members: DripsMember[];
  totalFundingRatePerSec: string | bigint | number;
  token?: string;
  tokenSymbol?: string;
  className?: string;
}

export function calculateMemberMonthlyEarnings(
  totalFundingRatePerSec: string | bigint | number,
  memberCount: number
): {
  perMemberRatePerSec: bigint;
  monthlyEarningsStroops: bigint;
  monthlyEarningsFormatted: string;
} {
  const count = BigInt(Math.max(1, memberCount));
  let totalRate = 0n;
  try {
    totalRate = BigInt(totalFundingRatePerSec.toString());
  } catch {
    totalRate = 0n;
  }

  const perMemberRatePerSec = count > 0n ? totalRate / count : 0n;
  const monthlyEarningsStroops = perMemberRatePerSec * SECONDS_PER_MONTH;
  const monthlyEarningsFormatted = stroopsToXlm(monthlyEarningsStroops);

  return {
    perMemberRatePerSec,
    monthlyEarningsStroops,
    monthlyEarningsFormatted,
  };
}

export default function DripsListMemberView({
  members,
  totalFundingRatePerSec,
  token,
  tokenSymbol: tokenSymbolOverride,
  className = "",
}: DripsListMemberViewProps) {
  const xlmPrice = useXlmPrice();
  const tokenSymbol = tokenSymbolOverride || getTokenSymbol(token);

  // Dynamic recalculation of monthly earnings whenever member count or funding rate updates (Issue #650)
  const earnings = useMemo(() => {
    return calculateMemberMonthlyEarnings(totalFundingRatePerSec, members.length);
  }, [totalFundingRatePerSec, members.length]);

  return (
    <div className={`space-y-4 ${className}`}>
      {/* Monthly earnings summary card */}
      <div className="p-4 rounded-xl bg-violet-500/10 border border-violet-500/20 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <p className="text-xs text-violet-300 font-medium uppercase tracking-wider">
            Estimated Per-Member Monthly Earnings
          </p>
          <div className="flex items-baseline gap-2 mt-1 flex-wrap">
            <span className="text-2xl font-bold text-white tabular-nums">
              {earnings.monthlyEarningsFormatted} {tokenSymbol}
            </span>
            <span className="text-xs text-zinc-400">/ month</span>
            {xlmPrice !== null && (
              <span className="text-xs text-emerald-400 font-medium">
                ≈ {formatUsd(earnings.monthlyEarningsStroops, xlmPrice)}
              </span>
            )}
          </div>
        </div>

        <div className="text-xs text-zinc-400 text-right sm:border-l sm:border-white/10 sm:pl-4 space-y-0.5">
          <div>
            Flow rate: <span className="font-mono text-zinc-200">{stroopsToXlm(earnings.perMemberRatePerSec)} {tokenSymbol}/s</span>
          </div>
          <div>
            Equal split among: <span className="font-semibold text-zinc-200">{members.length} {members.length === 1 ? "member" : "members"}</span>
          </div>
        </div>
      </div>

      {/* Member list */}
      <div className="space-y-2">
        <div className="flex items-center justify-between px-2 text-xs text-zinc-500 font-medium uppercase tracking-wider">
          <span>Member ({members.length})</span>
          <span>Joined / Share</span>
        </div>

        {members.length === 0 ? (
          <div className="card p-8 text-center text-zinc-400 text-sm">
            No active receivers found in this drips list.
          </div>
        ) : (
          <div className="divide-y divide-white/5 border border-white/10 rounded-xl overflow-hidden bg-white/2">
            {members.map((member, index) => (
              <div
                key={member.address}
                className="p-3.5 flex items-center justify-between gap-4 hover:bg-white/4 transition-colors flex-wrap sm:flex-nowrap"
              >
                <div className="flex items-center gap-3">
                  <div className="w-7 h-7 rounded-full bg-violet-500/20 text-violet-300 font-mono text-xs flex items-center justify-center font-bold">
                    {index + 1}
                  </div>
                  <AddressLabel address={member.address} />
                </div>

                <div className="flex items-center gap-4 text-right">
                  <div>
                    <div className="text-xs font-semibold text-white tabular-nums">
                      {earnings.monthlyEarningsFormatted} {tokenSymbol}/mo
                    </div>
                    <div className="text-[10px] text-zinc-400">
                      Equal 1/{members.length} share
                    </div>
                  </div>
                  {member.joined_at > 0 && (
                    <div className="text-[11px] text-zinc-500 font-mono hidden sm:block">
                      {new Date(member.joined_at * 1000).toLocaleDateString()}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
