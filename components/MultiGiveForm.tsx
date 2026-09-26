"use client";
import { useMemo, useState } from "react";
import { useWallet } from "@/lib/WalletContext";
import { useToast } from "@/components/Toast";
import TokenSelector from "@/components/TokenSelector";
import { NATIVE_TOKEN, batchGive, tokenAmountToBaseUnits } from "@/lib/stellar";

const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;
const DECIMAL_RE = /^[0-9]+(?:\.[0-9]+)?$/;

export interface MultiGiveRow {
  id: number;
  receiver: string;
  token: string;
  tokenSymbol: string;
  amount: string;
}

interface RowErrors {
  receiver?: string;
  amount?: string;
}

interface TokenGroup {
  token: string;
  symbol: string;
  rows: MultiGiveRow[];
  total: number;
}

interface MultiGiveFormProps {
  onSuccess: () => void;
  onCancel: () => void;
}

let rowCounter = 0;

/** A blank row defaulting to the native token, so the common case needs no token pick. */
export function createMultiGiveRow(): MultiGiveRow {
  rowCounter += 1;
  return {
    id: rowCounter,
    receiver: "",
    token: NATIVE_TOKEN,
    tokenSymbol: "XLM",
    amount: "",
  };
}

export function validateMultiGiveRow(row: MultiGiveRow): RowErrors {
  const errors: RowErrors = {};
  const receiver = row.receiver.trim();
  if (!receiver) {
    errors.receiver = "Recipient address is required.";
  } else if (!STELLAR_ADDRESS_RE.test(receiver)) {
    errors.receiver = "Must be a valid Stellar address starting with G.";
  }

  const amount = row.amount.trim();
  if (!amount) {
    errors.amount = "Amount is required.";
  } else if (!DECIMAL_RE.test(amount) || Number(amount) <= 0) {
    errors.amount = "Amount must be greater than zero.";
  }

  return errors;
}

/**
 * Group rows by token so each token is submitted with a single `batch_give`,
 * as the contract call takes one token for the whole receiver/amount batch.
 */
export function groupRowsByToken(rows: MultiGiveRow[]): TokenGroup[] {
  const groups = new Map<string, TokenGroup>();
  for (const row of rows) {
    const existing = groups.get(row.token);
    const group =
      existing ??
      ({
        token: row.token,
        symbol: row.tokenSymbol || `${row.token.slice(0, 4)}…`,
        rows: [],
        total: 0,
      } satisfies TokenGroup);
    group.rows.push(row);
    group.total += Number(row.amount) || 0;
    groups.set(row.token, group);
  }
  return Array.from(groups.values());
}

function formatTotal(value: number): string {
  return value.toFixed(4).replace(/\.?0+$/, "");
}

export default function MultiGiveForm({ onSuccess, onCancel }: MultiGiveFormProps) {
  const { publicKey } = useWallet();
  const { addToast, updateToast } = useToast();

  const [rows, setRows] = useState<MultiGiveRow[]>(() => [createMultiGiveRow()]);
  const [touched, setTouched] = useState(false);
  const [stage, setStage] = useState<"edit" | "review">("edit");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");

  const rowErrors = useMemo(() => rows.map((row) => validateMultiGiveRow(row)), [rows]);
  const invalidRowCount = rowErrors.filter((errors) => Object.keys(errors).length > 0).length;
  const groups = useMemo(() => groupRowsByToken(rows), [rows]);
  const totalReceivers = rows.length;

  const updateRow = (id: number, patch: Partial<MultiGiveRow>) => {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)));
    setSubmitError("");
  };

  const addRow = () => setRows((current) => [...current, createMultiGiveRow()]);

  const removeRow = (id: number) => {
    setRows((current) => (current.length === 1 ? current : current.filter((row) => row.id !== id)));
    setSubmitError("");
  };

  const handleReview = (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (invalidRowCount > 0) {
      setSubmitError(
        `Fix the ${invalidRowCount} incomplete row${invalidRowCount === 1 ? "" : "s"} before continuing.`,
      );
      return;
    }
    setSubmitError("");
    setStage("review");
  };

  const handleSubmit = async () => {
    if (!publicKey) {
      setSubmitError("Wallet not connected.");
      setStage("edit");
      return;
    }

    setSubmitting(true);
    setSubmitError("");
    const toastId = addToast({
      status: "pending",
      title: "Submitting multi-token give…",
      message: `${totalReceivers} receiver${totalReceivers === 1 ? "" : "s"} across ${groups.length} token${
        groups.length === 1 ? "" : "s"
      }`,
    });

    try {
      // One batch_give per token: the contract call is scoped to a single token.
      for (const group of groups) {
        await batchGive(
          publicKey,
          group.rows.map((row) => row.receiver.trim()),
          group.rows.map((row) => tokenAmountToBaseUnits(row.amount)),
          group.token,
        );
      }

      updateToast(toastId, {
        status: "success",
        title: "Multi-token give completed",
        message: `Sent to ${totalReceivers} receiver${totalReceivers === 1 ? "" : "s"} via ${groups.length} batch_give call${
          groups.length === 1 ? "" : "s"
        }`,
      });
      onSuccess();
    } catch (err: any) {
      const message = err?.message || "Multi-token give failed";
      setSubmitError(message);
      setStage("edit");
      updateToast(toastId, { status: "error", title: "Multi-token give failed", message });
    } finally {
      setSubmitting(false);
    }
  };

  if (stage === "review") {
    return (
      <div className="flex flex-col gap-4" data-testid="multi-give-review">
        <div>
          <h3 className="text-sm font-semibold text-zinc-200">Review before sending</h3>
          <p className="mt-1 text-xs text-zinc-400">
            {totalReceivers} receiver{totalReceivers === 1 ? "" : "s"} across {groups.length} token
            {groups.length === 1 ? "" : "s"}. This will submit {groups.length} <code>batch_give</code> call
            {groups.length === 1 ? "" : "s"}.
          </p>
        </div>

        <div className="space-y-2">
          {groups.map((group) => (
            <div
              key={group.token}
              className="rounded-xl border border-white/10 bg-black/30 p-3 text-xs"
              data-testid="multi-give-review-group"
            >
              <div className="flex items-center justify-between">
                <span className="font-semibold text-zinc-200">
                  {group.symbol}{" "}
                  <span className="font-mono font-normal text-zinc-500">
                    {group.token.slice(0, 6)}…{group.token.slice(-4)}
                  </span>
                </span>
                <span className="text-violet-300 font-semibold">
                  Total {formatTotal(group.total)} {group.symbol}
                </span>
              </div>
              <p className="mt-1 text-zinc-400">
                {group.rows.length} receiver{group.rows.length === 1 ? "" : "s"} · one batch_give call
              </p>
            </div>
          ))}
        </div>

        <div className="rounded-xl border border-violet-500/30 bg-violet-500/10 p-3 text-xs text-violet-100">
          <p className="font-semibold">Total cost</p>
          <ul className="mt-1 space-y-0.5">
            {groups.map((group) => (
              <li key={group.token} data-testid="multi-give-total-line">
                {formatTotal(group.total)} {group.symbol}
              </li>
            ))}
          </ul>
        </div>

        {submitError && (
          <div className="p-3 text-xs bg-red-500/10 border border-red-500/20 text-red-300 rounded-lg">
            {submitError}
          </div>
        )}

        <div className="flex gap-3 pt-1">
          <button
            type="button"
            onClick={() => setStage("edit")}
            disabled={submitting}
            className="flex-1 min-h-[44px] rounded-xl border border-white/10 py-2.5 text-sm font-semibold text-zinc-300 hover:border-white/20 transition-colors disabled:opacity-50"
          >
            Back
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            className="flex-1 min-h-[44px] btn-primary rounded-xl py-2.5 font-semibold text-white transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {submitting ? (
              <>
                <span className="inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                <span>Sending…</span>
              </>
            ) : (
              `Confirm & Send (${groups.length})`
            )}
          </button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleReview} className="flex flex-col gap-4">
      <p className="text-xs text-zinc-400">
        Add a row per receiver, pick the token for each row, then submit. Rows sharing a token are sent in
        one <code>batch_give</code> call.
      </p>

      <div className="space-y-3">
        {rows.map((row, index) => {
          const errors = touched ? rowErrors[index] : {};
          return (
            <div
              key={row.id}
              className="rounded-xl border border-white/10 bg-white/[0.02] p-3"
              data-testid="multi-give-row"
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-zinc-400">Receiver {index + 1}</span>
                <button
                  type="button"
                  onClick={() => removeRow(row.id)}
                  disabled={rows.length === 1}
                  aria-label={`Remove receiver ${index + 1}`}
                  className="text-xs text-zinc-500 hover:text-red-300 transition-colors disabled:opacity-40 disabled:hover:text-zinc-500"
                >
                  Remove
                </button>
              </div>

              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  type="text"
                  aria-label={`Receiver address ${index + 1}`}
                  placeholder="GABC…"
                  value={row.receiver}
                  onChange={(e) => updateRow(row.id, { receiver: e.target.value })}
                  className="input w-full min-h-[44px] sm:flex-[2]"
                />
                <div className="sm:flex-1">
                  <TokenSelector
                    value={row.token}
                    onChange={(token, symbol) => updateRow(row.id, { token, tokenSymbol: symbol })}
                  />
                </div>
                <input
                  type="text"
                  inputMode="decimal"
                  aria-label={`Amount ${index + 1}`}
                  placeholder="10.00"
                  value={row.amount}
                  onChange={(e) => updateRow(row.id, { amount: e.target.value })}
                  className="input w-full min-h-[44px] sm:flex-1"
                />
              </div>

              {(errors.receiver || errors.amount) && (
                <div className="mt-1.5 text-[11px] text-red-400">
                  {errors.receiver ?? errors.amount}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <button
        type="button"
        onClick={addRow}
        className="self-start text-xs text-violet-400 hover:text-violet-300 transition-colors"
      >
        + Add receiver
      </button>

      <div className="rounded-xl border border-white/10 bg-black/30 p-3 text-xs" data-testid="multi-give-summary">
        <p className="font-semibold text-zinc-200">Summary</p>
        {groups.length === 0 || totalReceivers === 0 ? (
          <p className="mt-1 text-zinc-500">No receivers yet.</p>
        ) : (
          <ul className="mt-1 space-y-0.5 text-zinc-300">
            {groups.map((group) => (
              <li key={group.token} data-testid="multi-give-summary-line">
                {group.rows.length} × {group.symbol} · total {formatTotal(group.total)} {group.symbol}
              </li>
            ))}
            <li className="pt-1 text-zinc-400">
              {groups.length} <code>batch_give</code> call{groups.length === 1 ? "" : "s"} on submit
            </li>
          </ul>
        )}
      </div>

      {submitError && (
        <div className="p-3 text-xs bg-red-500/10 border border-red-500/20 text-red-300 rounded-lg">
          {submitError}
        </div>
      )}

      <div className="flex gap-3 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 min-h-[44px] rounded-xl border border-white/10 py-2.5 text-sm font-semibold text-zinc-300 hover:border-white/20 transition-colors"
        >
          Cancel
        </button>
        <button
          type="submit"
          className="flex-1 min-h-[44px] btn-primary rounded-xl py-2.5 font-semibold text-white transition-colors"
        >
          Review & Send
        </button>
      </div>
    </form>
  );
}
