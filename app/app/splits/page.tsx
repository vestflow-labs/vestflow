"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import Navbar from "@/components/Navbar";
import { useWallet } from "@/lib/WalletContext";
import { NETWORK, setSplits, parseContractError } from "@/lib/stellar";
import { useToast } from "@/components/Toast";

interface SplitReceiver {
  receiver: string;
  weightBps: number;
}

interface SplitsConfig {
  receivers: SplitReceiver[];
  hash: string;
}

export default function SplitsPage() {
  const { publicKey } = useWallet();
  const { addToast, updateToast } = useToast();
  const [splits, setSplitsState] = useState<SplitsConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const fetchSplits = useCallback(async () => {
    if (!publicKey) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(
        `/api/splits?account=${publicKey}&network=${NETWORK}`,
      );
      if (res.ok) {
        const data = await res.json();
        setSplitsState({
          receivers: Array.isArray(data.receivers)
            ? data.receivers.map(
                (receiver: {
                  receiver?: string;
                  address?: string;
                  weight_bps?: number;
                }) => ({
                  receiver: receiver.receiver ?? receiver.address ?? "",
                  weightBps: Number(receiver.weight_bps ?? 0),
                }),
              )
            : [],
          hash: data.hash ?? "",
        });
      } else {
        setSplitsState({ receivers: [], hash: "" });
      }
    } catch {
      setSplitsState({ receivers: [], hash: "" });
    } finally {
      setLoading(false);
    }
  }, [publicKey]);

  useEffect(() => {
    fetchSplits();
  }, [fetchSplits]);

  const receivers = splits?.receivers ?? [];
  const totalBps = receivers.reduce(
    (sum, receiver) => sum + receiver.weightBps,
    0,
  );
  const remainingBps = 10000 - totalBps;

  const updateReceiver = (index: number, update: Partial<SplitReceiver>) => {
    setSplitsState(
      (current) =>
        current && {
          ...current,
          receivers: current.receivers.map((receiver, receiverIndex) =>
            receiverIndex === index ? { ...receiver, ...update } : receiver,
          ),
        },
    );
    setError("");
  };

  const addReceiver = () => {
    setSplitsState(
      (current) =>
        current && {
          ...current,
          receivers: [...current.receivers, { receiver: "", weightBps: 0 }],
        },
    );
  };

  const removeReceiver = (index: number) => {
    setSplitsState(
      (current) =>
        current && {
          ...current,
          receivers: current.receivers.filter(
            (_, receiverIndex) => receiverIndex !== index,
          ),
        },
    );
    setError("");
  };

  const handleSave = async () => {
    if (!publicKey || !splits) return;
    if (receivers.length > 0 && totalBps !== 10000) {
      setError("Receiver weights must add up to 100%.");
      return;
    }
    if (
      receivers.some(
        (receiver) => !/^G[A-Z2-7]{55}$/.test(receiver.receiver.trim()),
      )
    ) {
      setError("Every receiver must be a valid Stellar address.");
      return;
    }
    if (receivers.some((receiver) => receiver.weightBps <= 0)) {
      setError("Every receiver must have a weight greater than 0%.");
      return;
    }
    setError("");
    setSaving(true);
    const toastId = addToast({
      status: "pending",
      title: "Saving splits…",
      message: "Approve the transaction in Freighter.",
    });
    try {
      await setSplits(
        publicKey,
        receivers.map((receiver) => ({
          receiver: receiver.receiver.trim(),
          weightBps: receiver.weightBps,
        })),
      );
      updateToast(toastId, { status: "success", title: "Splits saved" });
      await fetchSplits();
    } catch (saveError: unknown) {
      const message = parseContractError(saveError);
      setError(message);
      updateToast(toastId, {
        status: "error",
        title: "Could not save splits",
        message,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Navbar />
      <main className="max-w-4xl mx-auto px-4 sm:px-6 pt-24 sm:pt-28 pb-20">
        <div className="flex items-center justify-between mb-8 flex-wrap gap-4">
          <div>
            <h1 className="text-3xl font-bold text-white">
              Splits Configuration
            </h1>
            <p className="text-zinc-400 mt-1 text-sm">
              Visualize how incoming funds are distributed among your split
              receivers.
            </p>
          </div>
          <Link
            href="/app"
            className="text-sm text-zinc-400 hover:text-white border border-white/10 rounded-lg px-3.5 py-2 min-h-[44px] inline-flex items-center transition-colors"
          >
            ← Dashboard
          </Link>
        </div>

        {!publicKey ? (
          <div className="card p-12 text-center text-zinc-400">
            Connect your wallet to view splits configuration.
          </div>
        ) : loading ? (
          <div className="card p-12 text-center text-zinc-400 animate-pulse">
            Loading splits configuration...
          </div>
        ) : (
          <div className="card p-6 sm:p-8 space-y-6">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <h2 className="text-lg font-semibold text-white">Receivers</h2>
                <p className="text-sm text-zinc-500">
                  {receivers.length} receiver{receivers.length !== 1 ? "s" : ""}{" "}
                  configured
                </p>
              </div>
            </div>

            <div className="space-y-4">
              {receivers.map((receiver, index) => (
                <div
                  key={`${index}-${receiver.receiver}`}
                  className="rounded-xl border border-white/10 bg-white/[0.02] p-4 space-y-3"
                >
                  <div className="flex items-start gap-3">
                    <label className="flex-1 space-y-1.5">
                      <span className="text-xs text-zinc-500">
                        Receiver address
                      </span>
                      <input
                        value={receiver.receiver}
                        onChange={(event) =>
                          updateReceiver(index, {
                            receiver: event.target.value,
                          })
                        }
                        placeholder="G..."
                        className="input w-full min-h-[44px] font-mono text-sm"
                        aria-label={`Receiver ${index + 1} address`}
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => removeReceiver(index)}
                      className="mt-5 min-h-[44px] min-w-[44px] rounded-lg border border-white/10 text-zinc-400 hover:text-red-300 hover:border-red-400/40"
                      aria-label={`Remove receiver ${index + 1}`}
                    >
                      ×
                    </button>
                  </div>
                  <div className="flex items-center gap-3">
                    <input
                      type="range"
                      min="0"
                      max="10000"
                      step="1"
                      value={receiver.weightBps}
                      onChange={(event) =>
                        updateReceiver(index, {
                          weightBps: Number(event.target.value),
                        })
                      }
                      className="w-full accent-violet-400"
                      aria-label={`Receiver ${index + 1} weight`}
                    />
                    <span className="w-16 text-right text-sm tabular-nums text-zinc-200">
                      {(receiver.weightBps / 100).toFixed(2)}%
                    </span>
                  </div>
                </div>
              ))}
            </div>

            <div
              className={`rounded-xl border p-4 flex items-center justify-between ${remainingBps === 0 ? "border-emerald-400/30 bg-emerald-400/5" : "border-amber-400/30 bg-amber-400/5"}`}
            >
              <span className="text-sm text-zinc-300">Remaining weight</span>
              <span
                className={`font-semibold tabular-nums ${remainingBps === 0 ? "text-emerald-300" : "text-amber-300"}`}
              >
                {(remainingBps / 100).toFixed(2)}%
              </span>
            </div>

            {error && (
              <p className="text-sm text-red-400" role="alert">
                {error}
              </p>
            )}

            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={addReceiver}
                className="min-h-[44px] rounded-lg border border-white/10 px-4 text-sm text-zinc-300 hover:border-white/20 hover:text-white"
              >
                + Add receiver
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={
                  saving || (receivers.length > 0 && totalBps !== 10000)
                }
                className="min-h-[44px] btn-primary rounded-lg px-5 text-sm font-semibold disabled:opacity-50"
              >
                {saving ? "Saving…" : "Save splits"}
              </button>
            </div>
          </div>
        )}
      </main>
    </>
  );
}
