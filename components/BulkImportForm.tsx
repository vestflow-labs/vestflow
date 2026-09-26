"use client";
import { useRef, useState } from "react";
import Link from "next/link";
import { useToast } from "@/components/Toast";
import {
  createSchedule,
  NETWORK,
  NATIVE_TOKEN,
  parseContractError,
  truncate,
} from "@/lib/stellar";
import { useWallet } from "@/lib/WalletContext";
import {
  parseSchedulesCSV,
  ParsedScheduleRow,
  SCHEDULE_CSV_TEMPLATE,
} from "@/lib/csvImport";
import { downloadCSV } from "@/lib/csvExport";

type RowStatus = "idle" | "pending" | "success" | "error";

interface RowResult {
  status: RowStatus;
  hash?: string;
  error?: string;
}

/** Minimal Stellar contract or account address check: starts with C or G, length 56, alphanumeric. */
function isValidTokenAddress(addr: string): boolean {
  return /^[CG][A-Z2-7]{55}$/.test(addr.trim());
}

export default function BulkImportForm() {
  const { publicKey } = useWallet();
  const { addToast, updateToast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<ParsedScheduleRow[]>([]);
  const [headerError, setHeaderError] = useState<string | null>(null);
  const [fileError, setFileError] = useState("");

  const [tokenAddress, setTokenAddress] = useState(NATIVE_TOKEN);
  const [startDate, setStartDate] = useState("");
  const [startTime, setStartTime] = useState("00:00");
  const [revocable, setRevocable] = useState(true);

  const [results, setResults] = useState<Record<number, RowResult>>({});
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });

  const validRows = rows.filter((r) => r.errors.length === 0);
  const invalidRows = rows.filter((r) => r.errors.length > 0);

  const tokenValid = isValidTokenAddress(tokenAddress);
  const startValid = (() => {
    if (!startDate) return false;
    const [hours, minutes] = startTime.split(":").map(Number);
    const dt = new Date(startDate);
    dt.setHours(hours, minutes, 0, 0);
    return dt.getTime() >= Date.now();
  })();

  const canSubmit =
    !!publicKey &&
    !running &&
    validRows.length > 0 &&
    tokenValid &&
    startValid;

  const handleFile = async (file: File) => {
    setFileName(file.name);
    setFileError("");
    setResults({});
    try {
      const text = await file.text();
      const parsed = parseSchedulesCSV(text);
      setRows(parsed.rows);
      setHeaderError(parsed.headerError);
    } catch {
      setRows([]);
      setHeaderError(null);
      setFileError("Could not read that file. Please upload a plain-text CSV.");
    }
  };

  const handleReset = () => {
    setFileName("");
    setRows([]);
    setHeaderError(null);
    setFileError("");
    setResults({});
    setProgress({ done: 0, total: 0 });
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleDownloadTemplate = () => {
    downloadCSV(SCHEDULE_CSV_TEMPLATE, "vestflow-bulk-import-template.csv");
  };

  const runRows = async (rowsToRun: ParsedScheduleRow[]) => {
    if (!publicKey || rowsToRun.length === 0) return;
    setRunning(true);
    setProgress({ done: 0, total: rowsToRun.length });

    const [hours, minutes] = startTime.split(":").map(Number);
    const startDt = new Date(startDate);
    startDt.setHours(hours, minutes, 0, 0);
    const startTs = Math.floor(startDt.getTime() / 1000);

    const toastId = addToast({
      status: "pending",
      title: `Creating ${rowsToRun.length} schedule${rowsToRun.length !== 1 ? "s" : ""}…`,
      message: "Approve each transaction in Freighter as it's requested.",
    });

    let succeeded = 0;
    let failed = 0;

    for (let i = 0; i < rowsToRun.length; i++) {
      const row = rowsToRun[i];
      setResults((r) => ({ ...r, [row.lineNumber]: { status: "pending" } }));

      const cliffDays = parseInt(row.cliffDays || "0", 10);
      const kind = cliffDays > 0 ? "LinearWithCliff" : "Linear";

      try {
        const hash = await createSchedule(
          publicKey,
          row.beneficiary,
          row.amount,
          tokenAddress,
          startTs,
          parseInt(row.durationDays, 10),
          cliffDays,
          kind,
          revocable
        );
        setResults((r) => ({ ...r, [row.lineNumber]: { status: "success", hash } }));
        succeeded++;
      } catch (e: any) {
        const message = parseContractError(e);
        setResults((r) => ({ ...r, [row.lineNumber]: { status: "error", error: message } }));
        failed++;
      } finally {
        setProgress({ done: i + 1, total: rowsToRun.length });
      }
    }

    setRunning(false);
    updateToast(toastId, {
      status: failed === 0 ? "success" : succeeded === 0 ? "error" : "success",
      title: "Bulk import finished",
      message:
        failed === 0
          ? `All ${succeeded} schedules created successfully.`
          : `${succeeded} created, ${failed} failed. See the table for details.`,
    });
  };

  const handleCreateAll = () => runRows(validRows);
  const handleRetryFailed = () => {
    const failedRows = rows.filter((r) => results[r.lineNumber]?.status === "error");
    runRows(failedRows);
  };

  const hasFailures = Object.values(results).some((r) => r.status === "error");
  const hasCompletedRun = progress.total > 0 && progress.done === progress.total && !running;

  if (!publicKey) {
    return (
      <div className="card p-8 flex flex-col items-center gap-3 text-center">
        <span className="text-4xl" aria-hidden="true">
          🔒
        </span>
        <p className="font-semibold text-zinc-200">Wallet not connected</p>
        <p className="text-zinc-400 text-sm">
          Connect your Freighter wallet to bulk-create vesting schedules.
        </p>
      </div>
    );
  }

  return (
    <div className="card p-6 flex flex-col gap-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold">Bulk Import from CSV</h2>
          <p className="text-sm text-zinc-400 mt-1">
            Upload a spreadsheet of beneficiaries to create many schedules at once. Need per-row
            tokens, start times, or up to 500 rows?{" "}
            <Link href="/app/bulk-create" className="text-violet-400 hover:underline">
              Try the large-batch bulk creator
            </Link>
            .
          </p>
        </div>
        <button
          type="button"
          onClick={handleDownloadTemplate}
          className="text-sm text-violet-400 hover:underline shrink-0"
        >
          Download CSV template
        </button>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="csv-file" className="text-sm text-zinc-400">
          CSV File
        </label>
        <input
          id="csv-file"
          ref={fileInputRef}
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
          }}
          disabled={running}
          className="input file:mr-3 file:rounded-lg file:border-0 file:bg-violet-500/15 file:text-violet-200 file:px-3 file:py-1.5 file:text-sm"
        />
        <p className="text-xs text-zinc-500">
          Required columns: <code className="font-mono">beneficiary, amount, duration</code>.
          Optional: <code className="font-mono">cliff</code> (days, defaults to 0).
        </p>
        {fileError && (
          <p className="text-xs text-red-400" role="alert">
            {fileError}
          </p>
        )}
        {headerError && (
          <p className="text-xs text-red-400" role="alert">
            {headerError}
          </p>
        )}
      </div>

      {rows.length > 0 && !headerError && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="bulk-token" className="text-sm text-zinc-400">
                Token Address (SEP-41)
              </label>
              <input
                id="bulk-token"
                type="text"
                value={tokenAddress}
                onChange={(e) => setTokenAddress(e.target.value)}
                disabled={running}
                autoComplete="off"
                spellCheck={false}
                className={`input ${!tokenValid ? "border-red-500/60 focus:border-red-500" : ""}`}
              />
              {!tokenValid && (
                <p className="text-xs text-red-400" role="alert">
                  Must be a valid SEP-41 token contract address.
                </p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-sm text-zinc-400">Start Date &amp; Time</span>
              <div className="flex gap-2">
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  disabled={running}
                  aria-label="Start date"
                  className={`input ${!startValid ? "border-red-500/60 focus:border-red-500" : ""}`}
                />
                <input
                  type="time"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  disabled={running}
                  aria-label="Start time"
                  className="input"
                />
              </div>
              {!startValid && (
                <p className="text-xs text-red-400" role="alert">
                  Start date/time must be in the future.
                </p>
              )}
            </div>
          </div>

          <div className="flex items-start gap-3 p-3 rounded-xl border border-white/8 bg-white/2">
            <input
              id="bulk-revocable"
              type="checkbox"
              checked={revocable}
              onChange={(e) => setRevocable(e.target.checked)}
              disabled={running}
              className="accent-violet-500 mt-0.5 shrink-0"
            />
            <label htmlFor="bulk-revocable" className="text-sm font-medium text-zinc-200 cursor-pointer">
              Make all imported schedules revocable
            </label>
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <p className="text-sm text-zinc-300">
                {fileName} — {validRows.length} valid row{validRows.length !== 1 ? "s" : ""}
                {invalidRows.length > 0 && (
                  <span className="text-red-400"> · {invalidRows.length} with errors</span>
                )}
              </p>
              <button
                type="button"
                onClick={handleReset}
                disabled={running}
                className="text-xs text-zinc-500 hover:text-white transition-colors disabled:opacity-40"
              >
                Clear file
              </button>
            </div>

            <div className="overflow-x-auto rounded-xl border border-white/8">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-white/8 text-zinc-500 text-left">
                    <th className="px-3 py-2 font-medium">Line</th>
                    <th className="px-3 py-2 font-medium">Beneficiary</th>
                    <th className="px-3 py-2 font-medium">Amount</th>
                    <th className="px-3 py-2 font-medium">Duration</th>
                    <th className="px-3 py-2 font-medium">Cliff</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const result = results[row.lineNumber];
                    return (
                      <tr key={row.lineNumber} className="border-b border-white/5 last:border-0">
                        <td className="px-3 py-2 text-zinc-500">{row.lineNumber}</td>
                        <td className="px-3 py-2 font-mono text-zinc-300">
                          {row.beneficiary ? truncate(row.beneficiary, 6, 4) : "—"}
                        </td>
                        <td className="px-3 py-2 text-zinc-300">{row.amount || "—"}</td>
                        <td className="px-3 py-2 text-zinc-300">{row.durationDays || "—"}d</td>
                        <td className="px-3 py-2 text-zinc-300">{row.cliffDays}d</td>
                        <td className="px-3 py-2">
                          {result?.status === "pending" && (
                            <span className="text-zinc-400">Creating…</span>
                          )}
                          {result?.status === "success" && (
                            <a
                              href={`https://stellar.expert/explorer/${NETWORK}/tx/${result.hash}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-emerald-400 hover:underline"
                            >
                              ✓ Created
                            </a>
                          )}
                          {result?.status === "error" && (
                            <span className="text-red-400" title={result.error}>
                              ✕ {result.error}
                            </span>
                          )}
                          {!result && row.errors.length > 0 && (
                            <span className="text-red-400" title={row.errors.join(" ")}>
                              {row.errors[0]}
                            </span>
                          )}
                          {!result && row.errors.length === 0 && (
                            <span className="text-zinc-500">Ready</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {running && (
            <p className="text-sm text-zinc-400">
              Creating schedule {progress.done + 1} of {progress.total}…
            </p>
          )}

          <div className="flex gap-3 flex-wrap">
            <button
              onClick={handleCreateAll}
              disabled={!canSubmit}
              className="btn-primary rounded-xl py-3 px-5 font-semibold text-white disabled:opacity-60"
            >
              {running
                ? "Creating…"
                : `Create ${validRows.length} Schedule${validRows.length !== 1 ? "s" : ""}`}
            </button>
            {hasCompletedRun && hasFailures && (
              <button
                onClick={handleRetryFailed}
                disabled={running}
                className="rounded-xl py-3 px-5 border border-white/10 text-zinc-300 hover:border-white/30 transition-colors text-sm disabled:opacity-60"
              >
                Retry Failed Rows
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
