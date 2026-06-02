"use client";
import { useState } from "react";
import { createSchedule, CONTRACT_ID, parseContractError, NETWORK, NATIVE_TOKEN } from "@/lib/stellar";
import { useWallet } from "@/lib/WalletContext";

export default function CreateForm() {
  const { publicKey } = useWallet();
  const [step, setStep] = useState<"form" | "confirm">("form");
  const [form, setForm] = useState({
    beneficiary: "", tokenAddress: NATIVE_TOKEN, amount: "", startDate: "", startTime: "00:00", durationDays: "",
    cliffDays: "0", kind: "Linear" as "Linear" | "Cliff", revocable: true,
  });
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [txHash, setTxHash] = useState("");
  const [errMsg, setErrMsg] = useState("");

  const set = (k: string, v: any) => setForm((f) => ({ ...f, [k]: v }));

  const handleShowConfirm = (e: React.FormEvent) => {
    e.preventDefault();
    setStep("confirm");
  };

  const handleConfirmSign = async () => {
    if (!publicKey) return;
    setStatus("loading"); setErrMsg("");
    try {
      // Combine date and time into a single timestamp
      const [hours, minutes] = form.startTime.split(":").map(Number);
      const startDateTime = new Date(form.startDate);
      startDateTime.setHours(hours, minutes, 0, 0);
      const startTs = Math.floor(startDateTime.getTime() / 1000);

      const hash = await createSchedule(
        publicKey, form.beneficiary, form.tokenAddress, parseFloat(form.amount),
        startTs, parseInt(form.durationDays), parseInt(form.cliffDays),
        form.kind, form.revocable,
      );
      setTxHash(hash); setStatus("done");
    } catch (e: any) {
      setErrMsg(parseContractError(e));
      setStatus("error");
      setStep("form"); // Go back to form on error so they can fix it
    }
  };

  if (!publicKey) return (
    <div className="card p-8 flex flex-col items-center gap-3 text-center">
      <span className="text-4xl">🔒</span>
      <p className="text-zinc-400 text-sm">Connect your Freighter wallet to create a vesting schedule.</p>
    </div>
  );

  if (status === "done") return (
    <div className="card p-8 text-center flex flex-col gap-3">
      <div className="text-4xl">✓</div>
      <p className="text-green-400 font-semibold">Schedule Created!</p>
      <p className="text-zinc-400 text-sm">Tokens are now locked and vesting has started.</p>
      <a href={`https://stellar.expert/explorer/${NETWORK}/tx/${txHash}`} target="_blank" rel="noopener noreferrer"
        className="text-xs font-mono text-violet-400 hover:underline break-all">{txHash}</a>
      <button onClick={() => { setStatus("idle"); setStep("form"); setTxHash(""); }} className="mt-2 text-violet-400 text-sm hover:underline">Create another</button>
    </div>
  );

  if (step === "confirm") {
    return (
      <div className="card p-6 flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold">Confirm Vesting Schedule</h2>
          <p className="text-sm text-zinc-400">Review the details below before signing the transaction.</p>
        </div>

        <div className="flex flex-col gap-4 bg-zinc-900/50 rounded-xl p-4 border border-zinc-800">
          <SummaryItem label="Beneficiary" value={form.beneficiary} full />
          <SummaryItem label="Token Address" value={form.tokenAddress} full />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <SummaryItem label="Amount" value={`${form.amount} ${form.tokenAddress === NATIVE_TOKEN ? "XLM" : "Tokens"}`} />
            <SummaryItem label="Vesting Type" value={form.kind} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <SummaryItem label="Start Date" value={`${form.startDate} ${form.startTime}`} />
            <SummaryItem label="Duration" value={`${form.durationDays} days`} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <SummaryItem label="Cliff" value={form.kind === "Cliff" ? `${form.cliffDays} days` : "None"} />
            <SummaryItem label="Revocable" value={form.revocable ? "Yes" : "No"} />
          </div>
        </div>

        {status === "error" && <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{errMsg}</p>}

        <div className="flex flex-col gap-3">
          <button
            onClick={handleConfirmSign}
            disabled={status === "loading"}
            className="btn-primary rounded-xl py-3 font-semibold text-white disabled:opacity-60"
          >
            {status === "loading" ? "Waiting for signature…" : "Confirm & Sign"}
          </button>
          <button
            onClick={() => setStep("form")}
            disabled={status === "loading"}
            className="text-sm text-zinc-400 hover:text-white transition-colors"
          >
            ← Back to Edit
          </button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleShowConfirm} className="card p-6 flex flex-col gap-5">
      <h2 className="text-lg font-semibold">New Vesting Schedule</h2>

      <Field label="Beneficiary Address">
        <input type="text" placeholder="G..." value={form.beneficiary} onChange={e => set("beneficiary", e.target.value)} required className="input" />
      </Field>

      <Field label="Token Address (SEP-41)">
        <input type="text" placeholder="CDLZ..." value={form.tokenAddress} onChange={e => set("tokenAddress", e.target.value)} required className="input" />
      </Field>

      <Field label={`Total Amount (${form.tokenAddress === NATIVE_TOKEN ? "XLM" : "Tokens"})`}>
        <input type="number" placeholder="0.00" min="0.0000001" step="any" value={form.amount} onChange={e => set("amount", e.target.value)} required className="input" />
      </Field>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Start Date">
          <input type="date" value={form.startDate} onChange={e => set("startDate", e.target.value)} required className="input" />
        </Field>
        <Field label="Start Time">
          <input type="time" value={form.startTime} onChange={e => set("startTime", e.target.value)} required className="input" />
        </Field>
      </div>

      <Field label="Duration (days)">
        <input type="number" placeholder="365" min="1" value={form.durationDays} onChange={e => set("durationDays", e.target.value)} required className="input" />
      </Field>

      <Field label="Vesting Type">
        <div className="flex gap-3">
          {(["Linear", "Cliff"] as const).map(k => (
            <label key={k} className="flex items-center gap-2 cursor-pointer">
              <input type="radio" name="kind" value={k} checked={form.kind === k} onChange={() => set("kind", k)} className="accent-violet-500" />
              <span className="text-sm text-zinc-300">{k}</span>
            </label>
          ))}
        </div>
        <p className="text-xs text-zinc-500 mt-1">
          {form.kind === "Linear" ? "Tokens unlock gradually over the full duration." : "All tokens unlock at once after the cliff period."}
        </p>
      </Field>

      {form.kind === "Cliff" && (
        <Field label="Cliff (days)">
          <input type="number" placeholder="180" min="0" value={form.cliffDays} onChange={e => set("cliffDays", e.target.value)} className="input" />
        </Field>
      )}

      <label className="flex items-center gap-2 cursor-pointer">
        <input type="checkbox" checked={form.revocable} onChange={e => set("revocable", e.target.checked)} className="accent-violet-500" />
        <span className="text-sm text-zinc-300">Revocable <span className="text-zinc-500">(you can cancel and recover unvested tokens)</span></span>
      </label>

      {status === "error" && <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{errMsg}</p>}

      <button type="submit" disabled={status === "loading"} className="btn-primary rounded-xl py-3 font-semibold text-white disabled:opacity-60">
        Review & Create
      </button>

      {!CONTRACT_ID && <p className="text-xs text-yellow-400 text-center">Set NEXT_PUBLIC_CONTRACT_ID in .env.local</p>}
    </form>
  );
}

function SummaryItem({ label, value, full }: { label: string; value: string; full?: boolean }) {
  return (
    <div className={`flex flex-col gap-1 ${full ? "col-span-2" : ""}`}>
      <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">{label}</span>
      <span className={`text-sm ${full ? "font-mono break-all" : "font-medium"} text-zinc-200`}>{value}</span>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-sm text-zinc-400">{label}</label>
      {children}
    </div>
  );
}
