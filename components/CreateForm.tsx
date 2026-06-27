"use client";
import { useState, type FormEvent, type ReactNode } from "react";
import { useToast } from "@/components/Toast";
import {
  createSchedule,
  CONTRACT_ID,
  parseContractError,
  NETWORK,
  NATIVE_TOKEN,
  stroopsToXlm,
  xlmToStroops,
} from "@/lib/stellar";
import { useWallet } from "@/lib/WalletContext";

// ─── Types ────────────────────────────────────────────────────────────────────

type VestingKind = "Linear" | "Cliff" | "LinearWithCliff";

interface FormState {
  beneficiary: string;
  tokenAddress: string;
  amount: string;
  startDate: string;
  startTime: string;
  durationDays: string;
  cliffDays: string;
  lockupDays: string;
  kind: VestingKind;
  revocable: boolean;
}

type FormErrors = Partial<Record<keyof FormState, string>>;

// ─── Validation ───────────────────────────────────────────────────────────────

/** Minimal Stellar address check: starts with G, length 56, alphanumeric. */
function isValidStellarAddress(addr: string): boolean {
  return /^G[A-Z2-7]{55}$/.test(addr.trim());
}

function validateForm(form: FormState): FormErrors {
  const errors: FormErrors = {};

  if (!form.beneficiary.trim()) {
    errors.beneficiary = "Beneficiary address is required.";
  } else if (!isValidStellarAddress(form.beneficiary)) {
    errors.beneficiary =
      "Must be a valid Stellar address starting with G (56 characters).";
  }

  if (!form.tokenAddress.trim()) {
    errors.tokenAddress = "Token address is required.";
  } else if (!isValidStellarAddress(form.tokenAddress)) {
    errors.tokenAddress =
      "Must be a valid SEP-41 token contract address (starts with G, 56 characters).";
  }

  const amt = parseFloat(form.amount);
  if (!form.amount) {
    errors.amount = "Total amount is required.";
  } else if (isNaN(amt) || amt <= 0) {
    errors.amount = "Amount must be a positive number.";
  }

  if (!form.startDate) {
    errors.startDate = "Start date is required.";
  } else {
    const [hours, minutes] = form.startTime.split(":").map(Number);
    const dt = new Date(form.startDate);
    dt.setHours(hours, minutes, 0, 0);
    if (dt.getTime() < Date.now()) {
      errors.startDate = "Start date/time must be in the future.";
    }
  }

  const dur = parseInt(form.durationDays);
  if (!form.durationDays) {
    errors.durationDays = "Total duration is required.";
  } else if (isNaN(dur) || dur < 1) {
    errors.durationDays = "Duration must be at least 1 day.";
  }

  if (form.kind === "Cliff" || form.kind === "LinearWithCliff") {
    const cliff = parseInt(form.cliffDays);
    if (!form.cliffDays && form.cliffDays !== "0") {
      errors.cliffDays = "Cliff duration is required for this vesting type.";
    } else if (isNaN(cliff) || cliff < 0) {
      errors.cliffDays = "Cliff must be 0 or more days.";
    } else if (!isNaN(cliff) && !isNaN(dur) && cliff > dur) {
      errors.cliffDays = "Cliff cannot exceed total duration.";
    }
  }

  // Lockup: tokens stay non-transferable until this many days after start.
  // The contract requires lockup >= cliff, so mirror that here.
  const cliffForLockup = parseInt(form.cliffDays || "0");
  const lockup = parseInt(form.lockupDays);
  if (!form.lockupDays && form.lockupDays !== "0") {
    errors.lockupDays = "Lockup duration is required.";
  } else if (isNaN(lockup) || lockup < 0) {
    errors.lockupDays = "Lockup must be 0 or more days.";
  } else if (!isNaN(cliffForLockup) && lockup < cliffForLockup) {
    errors.lockupDays = "Lockup must be greater than or equal to the cliff duration.";
  } else if (!isNaN(dur) && lockup > dur) {
    errors.lockupDays = "Lockup cannot exceed total duration.";
  }

  return errors;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Field({
  label,
  htmlFor,
  error,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  error?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm text-zinc-400">
        {label}
      </label>
      {children}
      {hint && !error && <p className="text-xs text-zinc-500">{hint}</p>}
      {error && (
        <p className="text-xs text-red-400" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function SummaryItem({
  label,
  value,
  full,
}: {
  label: string;
  value: string;
  full?: boolean;
}) {
  return (
    <div className={`flex flex-col gap-1 ${full ? "col-span-2" : ""}`}>
      <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">
        {label}
      </span>
      <span
        className={`text-sm ${full ? "font-mono break-all" : "font-medium"} text-zinc-200`}
      >
        {value}
      </span>
    </div>
  );
}

// ─── Vesting kind descriptions ────────────────────────────────────────────────

const KIND_OPTIONS: {
  value: VestingKind;
  label: string;
  description: string;
}[] = [
  {
    value: "Linear",
    label: "Linear",
    description: "Tokens unlock gradually and continuously from start to end.",
  },
  {
    value: "Cliff",
    label: "Cliff",
    description:
      "No tokens are claimable until the cliff date, then the full amount unlocks at once.",
  },
  {
    value: "LinearWithCliff",
    label: "Linear with Cliff",
    description:
      "No tokens unlock until the cliff date (typical 1-year cliff), then linear vesting for the remainder.",
  },
];

function estimateClaimable(
  totalStroops: bigint,
  startTs: number,
  durationSecs: number,
  cliffSecs: number,
  kind: VestingKind,
  previewTs: number,
): bigint {
  if (previewTs <= startTs || durationSecs <= 0) return 0n;
  const elapsed = previewTs - startTs;
  if (kind === "Cliff") {
    return elapsed >= cliffSecs ? totalStroops : 0n;
  }
  if (kind === "LinearWithCliff") {
    if (elapsed < cliffSecs) return 0n;
    if (elapsed >= durationSecs) return totalStroops;
    const linearDuration = durationSecs - cliffSecs;
    if (linearDuration <= 0) return 0n;
    const linearElapsed = elapsed - cliffSecs;
    return (totalStroops * BigInt(linearElapsed)) / BigInt(linearDuration);
  }
  if (elapsed >= durationSecs) return totalStroops;
  return (totalStroops * BigInt(elapsed)) / BigInt(durationSecs);
}

export default function CreateForm() {
  const { publicKey } = useWallet();
  const { addToast, updateToast } = useToast();
  const [step, setStep] = useState<"form" | "confirm">("form");
  const [form, setForm] = useState<FormState>({
    beneficiary: "",
    tokenAddress: NATIVE_TOKEN,
    amount: "",
    startDate: "",
    startTime: "00:00",
    durationDays: "",
    cliffDays: "0",
    lockupDays: "0",
    kind: "Linear",
    revocable: true,
  });
  const [touched, setTouched] = useState<
    Partial<Record<keyof FormState, boolean>>
  >({});
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">(
    "idle",
  );
  const [txHash, setTxHash] = useState("");
  const [errMsg, setErrMsg] = useState("");
  const [previewDate, setPreviewDate] = useState("");
  const [balanceError, setBalanceError] = useState("");

  const set = (k: keyof FormState, v: string | boolean) =>
    setForm((f) => ({ ...f, [k]: v }) as FormState);

  const touch = (k: keyof FormState) =>
    setTouched(
      (t) => ({ ...t, [k]: true }) as Partial<Record<keyof FormState, boolean>>,
    );

  // Update the cliff value, keeping the (un-edited) lockup in lockstep so the
  // default behaviour matches the old hard-coded `lockup = cliff` mirror.
  const setCliffDays = (v: string) =>
    setForm((f) => ({
      ...f,
      cliffDays: v,
      lockupDays: lockupEdited ? f.lockupDays : v,
    }));

  const errors = validateForm(form);

  const visibleErrors: FormErrors = {};
  for (const key of Object.keys(errors) as (keyof FormState)[]) {
    if (submitAttempted || touched[key]) {
      visibleErrors[key] = errors[key];
    }
  }

  const isValid = Object.keys(errors).length === 0;
  const showCliffField =
    form.kind === "Cliff" || form.kind === "LinearWithCliff";
  const tokenLabel =
    form.tokenAddress.trim() === NATIVE_TOKEN ? "XLM" : "Tokens";

  const handleShowConfirm = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSubmitAttempted(true);
    setBalanceError("");
    if (!isValid) return;

    // Balance check (#276): only for native XLM; non-native tokens use a
    // different token contract and we cannot read their balance here.
    if (publicKey && form.tokenAddress.trim() === NATIVE_TOKEN) {
      try {
        const amtStroops = xlmToStroops(form.amount);
        const spendable = await getWalletXlmBalance(publicKey);
        if (amtStroops > spendable) {
          const spendableXlm = (Number(spendable) / 10_000_000).toFixed(7).replace(/\.?0+$/, "");
          setBalanceError(
            `Insufficient balance. Your wallet has ${spendableXlm} XLM available (after minimum reserve).`
          );
          return;
        }
      } catch {
        // If balance fetch fails, proceed and let the network surface the error.
      }
    }

    setStep("confirm");
  };

  const handleConfirmSign = async () => {
    if (!publicKey) return;
    setStatus("loading");
    setErrMsg("");

    const toastId = addToast({
      status: "pending",
      title: "Creating schedule…",
      message: "Waiting for Freighter approval and transaction confirmation.",
    });

    try {
      const [hours, minutes] = form.startTime.split(":").map(Number);
      const startDateTime = new Date(form.startDate);
      startDateTime.setHours(hours, minutes, 0, 0);
      const startTs = Math.floor(startDateTime.getTime() / 1000);

      const hash = await createSchedule(
        publicKey,
        form.beneficiary.trim(),
        form.amount,
        form.tokenAddress,
        startTs,
        parseInt(form.durationDays),
        parseInt(form.cliffDays),
        form.kind,
        form.revocable,
        parseInt(form.lockupDays),
      );
      setTxHash(hash);
      setStatus("done");
      updateToast(toastId, {
        status: "success",
        title: "Schedule created",
        message: "Vesting schedule created successfully.",
        txHash: hash,
        network: NETWORK,
      });
    } catch (e: any) {
      const errorMessage = parseContractError(e);
      setErrMsg(errorMessage);
      setStatus("error");
      setStep("form");
      updateToast(toastId, {
        status: "error",
        title: "Schedule creation failed",
        message: errorMessage,
        retryLabel: "Try again",
        onRetry: handleConfirmSign,
      });
    }
  };

  const handleReset = () => {
    setStatus("idle");
    setStep("form");
    setTxHash("");
    setErrMsg("");
    setSubmitAttempted(false);
    setTouched({});
    setLockupEdited(false);
    setForm({
      beneficiary: "",
      tokenAddress: NATIVE_TOKEN,
      amount: "",
      startDate: "",
      startTime: "00:00",
      durationDays: "",
      cliffDays: "0",
      lockupDays: "0",
      kind: "Linear",
      revocable: true,
    });
    setPreviewDate("");
  };

  if (!publicKey) {
    return (
      <div className="card p-8 flex flex-col items-center gap-3 text-center">
        <span className="text-4xl" aria-hidden="true">
          🔒
        </span>
        <p className="font-semibold text-zinc-200">Wallet not connected</p>
        <p className="text-zinc-400 text-sm">
          Connect your Freighter wallet to create a vesting schedule.
        </p>
      </div>
    );
  }

  if (status === "done") {
    return (
      <div className="card p-8 text-center flex flex-col gap-3">
        <div className="text-4xl" aria-hidden="true">
          ✅
        </div>
        <p className="text-green-400 font-semibold text-lg">
          Schedule Created!
        </p>
        <p className="text-zinc-400 text-sm">
          Tokens are now locked on-chain and vesting has started.
        </p>
        <a
          href={`https://stellar.expert/explorer/${NETWORK}/tx/${txHash}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs font-mono text-violet-400 hover:underline break-all"
          aria-label="View transaction on Stellar Expert"
        >
          {txHash}
        </a>
        <button
          onClick={handleReset}
          className="mt-2 text-violet-400 text-sm hover:underline"
        >
          Create another schedule
        </button>
      </div>
    );
  }

  if (step === "confirm") {
    const cliffDisplay = showCliffField
      ? `${form.cliffDays || "0"} days`
      : "None";
    const kindDisplay =
      KIND_OPTIONS.find((o) => o.value === form.kind)?.label ?? form.kind;

    return (
      <div className="card p-6 flex flex-col gap-6">
        <div>
          <h2 className="text-lg font-semibold">Confirm Vesting Schedule</h2>
          <p className="text-sm text-zinc-400 mt-1">
            Review all details carefully. This transaction cannot be undone once
            signed.
          </p>
        </div>

        <div className="flex flex-col gap-4 bg-black/20 rounded-xl p-4 border border-white/8">
          <SummaryItem
            label="Beneficiary Address"
            value={form.beneficiary.trim()}
            full
          />
          <SummaryItem
            label="Token Address"
            value={form.tokenAddress.trim()}
            full
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <SummaryItem
              label="Total Amount"
              value={`${form.amount} ${tokenLabel}`}
            />
            <SummaryItem label="Vesting Type" value={kindDisplay} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <SummaryItem
              label="Start Date & Time"
              value={`${form.startDate} ${form.startTime}`}
            />
            <SummaryItem
              label="Total Duration"
              value={`${form.durationDays} days`}
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <SummaryItem label="Cliff Duration" value={cliffDisplay} />
            <SummaryItem
              label="Revocable"
              value={
                form.revocable
                  ? "Yes — you can recover unvested tokens"
                  : "No — tokens are permanently locked"
              }
            />
          </div>
          <div className="pt-1 border-t border-white/5">
            <p className="text-xs text-zinc-500">
              Contract: <span className="font-mono text-zinc-400">{CONTRACT_ID}</span>
            </p>
          </div>

          <div className="border-t border-zinc-700/50 pt-3 flex flex-col gap-2">
            <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">
              Preview Claimable At Date
            </span>
            <input
              type="date"
              value={previewDate}
              onChange={(e) => setPreviewDate(e.target.value)}
              className="input text-sm px-3 py-1.5 rounded-lg bg-zinc-800/60 border border-zinc-700 text-zinc-200 focus:outline-none focus:border-violet-500 w-full"
            />
            {previewDate &&
              form.amount &&
              form.startDate &&
              form.durationDays &&
              (() => {
                try {
                  const totalStroops = xlmToStroops(form.amount);
                  const [hours, minutes] = form.startTime
                    .split(":")
                    .map(Number);
                  const startDt = new Date(form.startDate);
                  startDt.setHours(hours, minutes, 0, 0);
                  const startTs = Math.floor(startDt.getTime() / 1000);
                  const durationSecs = parseInt(form.durationDays) * 86400;
                  const cliffSecs = parseInt(form.cliffDays || "0") * 86400;
                  const previewTs = Math.floor(
                    new Date(previewDate).getTime() / 1000,
                  );
                  const estimated = estimateClaimable(
                    totalStroops,
                    startTs,
                    durationSecs,
                    cliffSecs,
                    form.kind,
                    previewTs,
                  );
                  return (
                    <p className="text-sm text-zinc-400">
                      At this date you could claim approximately{" "}
                      <span className="font-semibold text-violet-300">
                        {stroopsToXlm(estimated)} {tokenLabel}
                      </span>
                    </p>
                  );
                } catch {
                  return null;
                }
              })()}
          </div>
        </div>

        {status === "error" && (
          <p
            className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2"
            role="alert"
          >
            {errMsg}
          </p>
        )}

        <div className="flex flex-col gap-3">
          <button
            onClick={handleConfirmSign}
            disabled={status === "loading"}
            className="btn-primary rounded-xl py-3 font-semibold text-white disabled:opacity-60"
            aria-busy={status === "loading"}
          >
            {status === "loading" ? (
              <span className="flex items-center justify-center gap-2">
                <span
                  className="inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"
                  aria-hidden="true"
                />
                Waiting for signature…
              </span>
            ) : (
              "Confirm & Sign Transaction"
            )}
          </button>
          <button
            onClick={() => setStep("form")}
            disabled={status === "loading"}
            className="text-sm text-zinc-400 hover:text-white transition-colors disabled:opacity-40"
          >
            ← Back to Edit
          </button>
        </div>
      </div>
    );
  }

  return (
    <form
      onSubmit={handleShowConfirm}
      noValidate
      className="card p-6 flex flex-col gap-5"
    >
      <div>
        <h2 className="text-lg font-semibold">New Vesting Schedule</h2>
        <p className="text-sm text-zinc-400 mt-1">
          Lock tokens on-chain and define how they unlock over time.
        </p>
      </div>

      <Field
        label="Beneficiary Address"
        htmlFor="beneficiary"
        error={visibleErrors.beneficiary}
        hint="The Stellar address that will receive the vested tokens."
      >
        <input
          id="beneficiary"
          type="text"
          placeholder="GABC…"
          value={form.beneficiary}
          onChange={(e) => set("beneficiary", e.target.value)}
          onBlur={() => touch("beneficiary")}
          required
          autoComplete="off"
          spellCheck={false}
          aria-invalid={!!visibleErrors.beneficiary}
          className={`input ${visibleErrors.beneficiary ? "border-red-500/60 focus:border-red-500" : ""}`}
        />
      </Field>

      <Field
        label="Token Address (SEP-41)"
        htmlFor="tokenAddress"
        error={visibleErrors.tokenAddress}
        hint="The contract address of the token to vest. Defaults to native XLM."
      >
        <input
          id="tokenAddress"
          type="text"
          placeholder="CDLZ…"
          value={form.tokenAddress}
          onChange={(e) => set("tokenAddress", e.target.value)}
          onBlur={() => touch("tokenAddress")}
          required
          autoComplete="off"
          spellCheck={false}
          aria-invalid={!!visibleErrors.tokenAddress}
          className={`input ${visibleErrors.tokenAddress ? "border-red-500/60 focus:border-red-500" : ""}`}
        />
      </Field>

      <Field
        label={`Total Amount (${tokenLabel})`}
        htmlFor="amount"
        error={visibleErrors.amount ?? (balanceError || undefined)}
        hint="The total number of tokens to lock into this schedule."
      >
        <input
          id="amount"
          type="number"
          placeholder="1000.00"
          min="0.0000001"
          step="any"
          value={form.amount}
          onChange={(e) => { set("amount", e.target.value); setBalanceError(""); }}
          onBlur={() => touch("amount")}
          required
          aria-invalid={!!(visibleErrors.amount || balanceError)}
          className={`input ${(visibleErrors.amount || balanceError) ? "border-red-500/60 focus:border-red-500" : ""}`}
        />
      </Field>

      <fieldset className="grid grid-cols-1 sm:grid-cols-2 gap-4 border-0 p-0 m-0">
        <legend className="sr-only">Schedule start date and time</legend>
        <Field
          label="Start Date"
          htmlFor="startDate"
          error={visibleErrors.startDate}
        >
          <input
            id="startDate"
            type="date"
            value={form.startDate}
            onChange={(e) => set("startDate", e.target.value)}
            onBlur={() => touch("startDate")}
            required
            aria-invalid={!!visibleErrors.startDate}
            className={`input ${visibleErrors.startDate ? "border-red-500/60 focus:border-red-500" : ""}`}
          />
        </Field>
        <Field label="Start Time" htmlFor="startTime">
          <input
            id="startTime"
            type="time"
            value={form.startTime}
            onChange={(e) => set("startTime", e.target.value)}
            onBlur={() => touch("startTime")}
            required
            className="input"
          />
        </Field>
      </fieldset>

      <Field
        label="Total Duration (days)"
        htmlFor="durationDays"
        error={visibleErrors.durationDays}
        hint="How many days from start until all tokens are fully vested."
      >
        <input
          id="durationDays"
          type="number"
          placeholder="365"
          min="1"
          step="1"
          value={form.durationDays}
          onChange={(e) => set("durationDays", e.target.value)}
          onBlur={() => touch("durationDays")}
          required
          aria-invalid={!!visibleErrors.durationDays}
          className={`input ${visibleErrors.durationDays ? "border-red-500/60 focus:border-red-500" : ""}`}
        />
      </Field>

      <fieldset className="flex flex-col gap-3 border-0 p-0 m-0">
        <legend className="text-sm text-zinc-400">Vesting Type</legend>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {KIND_OPTIONS.map(({ value, label, description }) => (
            <label
              key={value}
              className={`flex flex-col gap-1.5 p-3 rounded-xl border cursor-pointer transition-colors ${
                form.kind === value
                  ? "border-violet-500/60 bg-violet-500/10"
                  : "border-white/8 hover:border-white/20"
              }`}
            >
              <div className="flex items-center gap-2">
                <input
                  type="radio"
                  name="kind"
                  value={value}
                  checked={form.kind === value}
                  onChange={() => {
                    set("kind", value);
                    if (value === "Linear") set("cliffDays", "0");
                  }}
                  className="accent-violet-500"
                  aria-label={label}
                />
                <span className="text-sm font-medium text-zinc-200">
                  {label}
                </span>
              </div>
              <p className="text-xs text-zinc-500 leading-relaxed">
                {description}
              </p>
            </label>
          ))}
        </div>
      </fieldset>

      {showCliffField && (
        <Field
          label="Cliff Duration (days)"
          htmlFor="cliffDays"
          error={visibleErrors.cliffDays}
          hint={
            form.kind === "Cliff"
              ? "Tokens unlock all at once after this many days."
              : "No tokens are claimable before this point. Linear vesting begins after the cliff."
          }
        >
          <input
            id="cliffDays"
            type="number"
            placeholder="180"
            min="0"
            step="1"
            value={form.cliffDays}
            onChange={(e) => setCliffDays(e.target.value)}
            onBlur={() => touch("cliffDays")}
            aria-invalid={!!visibleErrors.cliffDays}
            className={`input ${visibleErrors.cliffDays ? "border-red-500/60 focus:border-red-500" : ""}`}
          />
        </Field>
      )}

      <div className="flex items-start gap-3 p-3 rounded-xl border border-white/8 bg-white/2">
        <input
          id="revocable"
          type="checkbox"
          checked={form.revocable}
          onChange={(e) => set("revocable", e.target.checked)}
          className="accent-violet-500 mt-0.5 shrink-0"
          aria-describedby="revocable-description"
        />
        <div className="flex flex-col gap-0.5">
          <label
            htmlFor="revocable"
            className="text-sm font-medium text-zinc-200 cursor-pointer"
          >
            Revocable schedule
          </label>
          <p id="revocable-description" className="text-xs text-zinc-500">
            {form.revocable
              ? "You (the grantor) can cancel this schedule and recover any unvested tokens."
              : "Tokens are permanently locked — you cannot cancel or recover unvested tokens."}
          </p>
        </div>
      </div>

      {status === "error" && (
        <p
          className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2"
          role="alert"
        >
          {errMsg}
        </p>
      )}

      {submitAttempted && !isValid && (
        <p
          className="text-sm text-yellow-400 bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-3 py-2"
          role="alert"
        >
          Please fix the errors above before continuing.
        </p>
      )}

      <button
        type="submit"
        disabled={status === "loading"}
        className="btn-primary rounded-xl py-3 font-semibold text-white disabled:opacity-60"
      >
        Review &amp; Create
      </button>

      {!CONTRACT_ID && (
        <p className="text-xs text-yellow-400 text-center">
          Set <code className="font-mono">NEXT_PUBLIC_CONTRACT_ID</code> in{' '}
          <code className="font-mono">.env.local</code>
        </p>
      )}
    </form>
  );
}
