"use client";

import { useState } from "react";
import Link from "next/link";
import AddressLabel from "@/components/AddressLabel";
import CopyLinkButton from "@/components/CopyLinkButton";
import FullyFundedBadge from "@/components/FullyFundedBadge";
import DripsListMemberView, { DripsMember } from "@/components/DripsListMemberView";
import { stroopsToXlm } from "@/lib/stellar";
import { getTokenSymbol } from "@/lib/tokens";
import { useWallet } from "@/lib/WalletContext";

export interface DripsListData {
  id: string;
  name: string;
  owner: string;
  token: string;
  total_funding_rate_per_sec: string;
  target_rate_per_sec: string;
  member_count: number;
}

interface DripsListDetailProps {
  list: DripsListData;
  members: DripsMember[];
  onUpdateTargetRate?: (newTargetRate: string) => Promise<void>;
  className?: string;
}

export default function DripsListDetail({
  list: initialList,
  members: initialMembers,
  onUpdateTargetRate,
  className = "",
}: DripsListDetailProps) {
  const { publicKey } = useWallet();
  const [list, setList] = useState<DripsListData>(initialList);
  const [members, setMembers] = useState<DripsMember[]>(initialMembers);
  const [isEditingTarget, setIsEditingTarget] = useState(false);
  const [targetInput, setTargetInput] = useState(initialList.target_rate_per_sec || "0");
  const [savingTarget, setSavingTarget] = useState(false);
  const [targetError, setTargetError] = useState("");

  const isOwner = publicKey && publicKey.toLowerCase() === list.owner.toLowerCase();
  const tokenSymbol = getTokenSymbol(list.token);

  const handleSaveTargetRate = async () => {
    try {
      setSavingTarget(true);
      setTargetError("");

      // Validate numeric value
      const parsed = BigInt(targetInput.trim() || "0");
      if (parsed < 0n) {
        throw new Error("Target rate cannot be negative");
      }

      if (onUpdateTargetRate) {
        await onUpdateTargetRate(parsed.toString());
      } else {
        // Fallback local update / API call
        const res = await fetch(`/api/lists/${list.id}/target-rate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            target_rate_per_sec: parsed.toString(),
            owner: publicKey,
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error((err as { error?: string }).error || "Failed to update target rate");
        }
      }

      setList(prev => ({ ...prev, target_rate_per_sec: parsed.toString() }));
      setIsEditingTarget(false);
    } catch (e: any) {
      setTargetError(e.message || "Failed to save target rate");
    } finally {
      setSavingTarget(false);
    }
  };

  return (
    <div className={`space-y-6 ${className}`}>
      {/* Header card */}
      <div className="card p-6 sm:p-8 space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-2xl sm:text-3xl font-bold text-white">{list.name}</h1>
              {/* Fully Funded Badge (Issue #649) */}
              <FullyFundedBadge
                fundingRate={list.total_funding_rate_per_sec}
                targetRate={list.target_rate_per_sec}
                tokenSymbol={tokenSymbol}
              />
            </div>
            <p className="text-xs text-zinc-400 mt-1 font-mono">List ID: {list.id}</p>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {/* Copy Link sharing button (Issue #648) */}
            <CopyLinkButton label="Copy List Link" />
          </div>
        </div>

        {/* Info & Stats Bar */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 pt-4 border-t border-white/5">
          <div className="p-3.5 bg-white/3 rounded-xl border border-white/5">
            <p className="text-xs text-zinc-400 uppercase tracking-wider mb-1">List Owner</p>
            <AddressLabel address={list.owner} />
          </div>

          <div className="p-3.5 bg-white/3 rounded-xl border border-white/5">
            <p className="text-xs text-zinc-400 uppercase tracking-wider mb-1">Incoming Flow Rate</p>
            <p className="text-lg font-bold text-white tabular-nums">
              {stroopsToXlm(BigInt(list.total_funding_rate_per_sec))} {tokenSymbol}/s
            </p>
          </div>

          {/* Target Rate & Editable control (Issue #649) */}
          <div className="p-3.5 bg-white/3 rounded-xl border border-white/5">
            <div className="flex items-center justify-between gap-2 mb-1">
              <p className="text-xs text-zinc-400 uppercase tracking-wider">Target Rate</p>
              {isOwner && !isEditingTarget && (
              <button
                type="button"
                onClick={() => {
                  setTargetInput(list.target_rate_per_sec);
                  setIsEditingTarget(true);
                }}
                className="text-[11px] text-violet-400 hover:text-violet-300 font-medium underline min-h-[44px] flex items-center"
                aria-label="Edit target rate"
              >
                Edit
              </button>
              )}
            </div>

            {isEditingTarget ? (
              <div className="space-y-2 mt-1">
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="text"
                    value={targetInput}
                    onChange={e => setTargetInput(e.target.value)}
                    placeholder="Base units / sec"
                    className="flex-1 min-w-0 text-xs font-mono bg-black/50 border border-violet-500/50 rounded px-2 py-2 min-h-[44px] text-white outline-none"
                    aria-label="Target rate input in base units per second"
                  />
                  <button
                    type="button"
                    disabled={savingTarget}
                    onClick={handleSaveTargetRate}
                    className="btn-primary rounded px-3 py-2 text-[11px] font-semibold text-white disabled:opacity-50 min-h-[44px] shrink-0"
                  >
                    {savingTarget ? "…" : "Save"}
                  </button>
                  <button
                    type="button"
                    disabled={savingTarget}
                    onClick={() => setIsEditingTarget(false)}
                    className="text-[11px] text-zinc-400 hover:text-white px-2 min-h-[44px] shrink-0 flex items-center"
                  >
                    ✕
                  </button>
                </div>
                {targetError && <p className="text-[10px] text-red-400">{targetError}</p>}
              </div>
            ) : (
              <p className="text-lg font-bold text-zinc-200 tabular-nums">
                {list.target_rate_per_sec !== "0"
                  ? `${stroopsToXlm(BigInt(list.target_rate_per_sec))} ${tokenSymbol}/s`
                  : "Not configured"}
              </p>
            )}
          </div>

          <div className="p-3.5 bg-white/3 rounded-xl border border-white/5">
            <p className="text-xs text-zinc-400 uppercase tracking-wider mb-1">Active Members</p>
            <p className="text-lg font-bold text-violet-300 tabular-nums">
              {members.length}
            </p>
          </div>
        </div>
      </div>

      {/* Drips List Member View & Estimated Monthly Earnings (Issue #650) */}
      <div className="card p-6 sm:p-8 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">Receivers & Monthly Allocation</h2>
        </div>
        <DripsListMemberView
          members={members}
          totalFundingRatePerSec={list.total_funding_rate_per_sec}
          token={list.token}
          tokenSymbol={tokenSymbol}
        />
      </div>
    </div>
  );
}
