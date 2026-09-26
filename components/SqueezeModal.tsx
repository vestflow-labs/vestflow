"use client";

import { useState, useEffect } from "react";
import { ScheduleData, squeezeStream, getClaimableBulk, stroopsToXlm } from "@/lib/stellar";
import { useToast } from "@/components/Toast";

interface SqueezeModalProps {
  schedule: ScheduleData;
  publicKey: string;
  onClose: () => void;
  onSuccess: () => void;
}

/**
 * Modal for squeezing (collecting) tokens dripped in the current cycle.
 * Shows estimated amount that can be collected and executes the squeeze_streams contract call.
 */
export function SqueezeModal({ schedule, publicKey, onClose, onSuccess }: SqueezeModalProps) {
  const { addToast, updateToast } = useToast();
  const [claimableAmount, setClaimableAmount] = useState<bigint | null>(null);
  const [loading, setLoading] = useState(true);
  const [squeezing, setSqueeping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load claimable amount
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const amounts = await getClaimableBulk([schedule.id], publicKey);
        if (!cancelled) {
          setClaimableAmount(amounts[0] ?? 0n);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load claimable amount");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [schedule.id, publicKey]);

  const handleSqueeze = async () => {
    setSqueeping(true);
    setError(null);

    const toastId = addToast({
      status: "pending",
      title: "Squeezing stream…",
      message: `Collecting ${stroopsToXlm(claimableAmount || 0n)} tokens`,
      duration: 0,
    });

    try {
      const txHash = await squeezeStream(publicKey, schedule.id);

      updateToast(toastId, {
        status: "success",
        title: "Stream squeezed!",
        message: `Successfully collected ${stroopsToXlm(claimableAmount || 0n)} tokens`,
        txHash,
        network: "testnet",
        duration: 5000,
      });

      onSuccess();
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);

      updateToast(toastId, {
        status: "error",
        title: "Squeeze failed",
        message,
        duration: 5000,
      });
    } finally {
      setSqueeping(false);
    }
  };

  const isTokenNative = schedule.token === "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
  const tokenSym = isTokenNative ? "XLM" : `${schedule.token.slice(0, 5)}…`;
  const claimableXlm = stroopsToXlm(claimableAmount ?? 0n);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="rounded-xl shadow-2xl max-w-sm w-full"
           style={{ background: "var(--card-bg)", border: "1px solid var(--card-border)" }}>
        <div className="border-b px-6 py-4 flex items-center justify-between"
             style={{ borderColor: "var(--border-subtle)" }}>
          <h2 className="text-lg font-semibold" style={{ color: "var(--foreground)" }}>Squeeze Stream</h2>
          <button
            onClick={onClose}
            disabled={squeezing}
            className="transition-colors disabled:opacity-50"
            style={{ color: "var(--muted-light)" }}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="p-6 space-y-6">
          {/* Info Section */}
          <div className="space-y-4">
            <div className="p-4 rounded-lg" 
                 style={{ background: "var(--input-bg)", border: "1px solid var(--border-subtle)" }}>
              <p className="text-xs font-medium mb-1.5" style={{ color: "var(--muted)" }}>Schedule</p>
              <p className="text-sm font-semibold" style={{ color: "var(--foreground)" }}>
                #{schedule.id}
              </p>
              <p className="text-xs font-mono mt-1" style={{ color: "var(--muted)" }}>
                From: {schedule.grantor.slice(0, 10)}…{schedule.grantor.slice(-6)}
              </p>
            </div>

            {/* Loading State */}
            {loading ? (
              <div className="p-4 rounded-lg"
                   style={{ background: "var(--input-bg)", border: "1px solid var(--border-subtle)" }}>
                <div className="flex items-center gap-2">
                  <div className="w-4 h-4 rounded-full border-2 border-violet-400 border-t-transparent animate-spin" />
                  <span className="text-sm" style={{ color: "var(--muted)" }}>Loading claimable amount…</span>
                </div>
              </div>
            ) : error ? (
              <div className="p-4 rounded-lg"
                   style={{ background: "var(--accent-error)", color: "white", opacity: 0.15 }}>
                <p className="text-sm">{error}</p>
              </div>
            ) : (
              <div className="p-4 rounded-lg"
                   style={{ background: "var(--accent-success)", color: "white", opacity: 0.15 }}>
                <p className="text-xs font-medium mb-1" style={{ color: "var(--accent-success)" }}>Estimated to collect</p>
                <p className="text-2xl font-bold" style={{ color: "var(--accent-success)" }}>
                  {claimableXlm} {tokenSym}
                </p>
              </div>
            )}
          </div>

          {/* Description */}
          <div className="space-y-2 text-sm" style={{ color: "var(--muted)" }}>
            <p>
              Squeezing collects all tokens dripped so far in the current cycle. You won't have to wait until the
              stream settles to access your tokens.
            </p>
          </div>

          {/* Actions */}
          <div className="flex gap-3 pt-4">
            <button
              onClick={onClose}
              disabled={squeezing}
              className="flex-1 px-4 py-2 rounded-lg font-medium text-sm transition-colors disabled:opacity-50"
              style={{
                border: "1px solid var(--border-default)",
                color: "var(--foreground)",
              }}
            >
              Cancel
            </button>
            <button
              onClick={handleSqueeze}
              disabled={squeezing || loading || error !== null || claimableAmount === null}
              className="flex-1 px-4 py-2 rounded-lg font-medium text-sm transition-colors disabled:opacity-50 flex items-center justify-center gap-2 text-white"
              style={{ background: "var(--accent-success)" }}
            >
              {squeezing ? (
                <>
                  <div className="w-4 h-4 rounded-full border-2 border-white border-t-transparent animate-spin" />
                  Squeezing…
                </>
              ) : (
                "Squeeze Now"
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
