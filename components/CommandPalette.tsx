"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getAllSchedules, ScheduleData, truncate } from "@/lib/stellar";
import { useWallet } from "@/lib/WalletContext";
import { useAddressBook } from "@/hooks/useAddressBook";

const MAX_RESULTS = 8;

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

export default function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const router = useRouter();
  const { publicKey } = useWallet();
  const { getLabel } = useAddressBook();
  const [query, setQuery] = useState("");
  const [schedules, setSchedules] = useState<ScheduleData[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setLoading(true);
    inputRef.current?.focus();

    let cancelled = false;
    getAllSchedules(publicKey ?? undefined)
      .then((all) => {
        if (cancelled) return;
        const relevant = publicKey
          ? all.filter((s) => s.grantor === publicKey || s.beneficiary === publicKey)
          : all;
        setSchedules(relevant);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, publicKey]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const q = query.trim().toLowerCase();
  const results = (
    q
      ? schedules.filter(
          (s) =>
            String(s.id).includes(q) ||
            s.grantor.toLowerCase().includes(q) ||
            s.beneficiary.toLowerCase().includes(q) ||
            (getLabel(s.grantor) ?? "").toLowerCase().includes(q) ||
            (getLabel(s.beneficiary) ?? "").toLowerCase().includes(q)
        )
      : schedules
  ).slice(0, MAX_RESULTS);

  const goToSchedule = (id: number) => {
    onClose();
    router.push(`/app/schedule/${id}`);
  };

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-start justify-center pt-24 px-4"
      role="dialog"
      aria-modal="true"
      aria-label="Search schedules"
    >
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="relative w-full max-w-lg card p-0 overflow-hidden z-10 flex flex-col">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && results.length > 0) {
              goToSchedule(results[0].id);
            }
          }}
          placeholder="Search schedules by ID, address, or label…"
          className="w-full bg-transparent px-4 py-3.5 text-sm text-zinc-200 placeholder:text-zinc-500 outline-none border-b border-white/10"
          aria-label="Search schedules by ID, address, or label"
        />
        <div className="max-h-80 overflow-y-auto py-2">
          {loading ? (
            <p className="px-4 py-3 text-sm text-zinc-500">Loading schedules…</p>
          ) : results.length === 0 ? (
            <p className="px-4 py-3 text-sm text-zinc-500">
              {publicKey
                ? "No matching schedules."
                : "Connect your wallet to search your schedules."}
            </p>
          ) : (
            results.map((s) => {
              const label = getLabel(s.grantor) ?? getLabel(s.beneficiary);
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => goToSchedule(s.id)}
                  className="w-full flex items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-white/5 transition-colors"
                >
                  <span className="text-sm font-medium text-zinc-200">
                    Schedule #{s.id}
                  </span>
                  <span className="text-xs font-mono text-zinc-500 truncate">
                    {label ?? truncate(s.beneficiary, 6, 4)}
                  </span>
                </button>
              );
            })
          )}
        </div>
        <div className="border-t border-white/10 px-4 py-2 flex items-center justify-between text-[11px] text-zinc-600">
          <span>↵ to open</span>
          <span>Esc to close</span>
        </div>
      </div>
    </div>
  );
}
