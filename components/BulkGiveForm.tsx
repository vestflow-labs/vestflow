"use client";
import { useState, useRef } from "react";
import { useWallet } from "@/lib/WalletContext";
import { useToast } from "@/components/Toast";
import {
  parseBulkGiveCSV,
  ParsedBulkGiveRow,
  BULK_GIVE_CSV_TEMPLATE,
} from "@/lib/csvImport";
import { downloadCSV } from "@/lib/csvExport";
import { batchGive, xlmToStroops, NATIVE_TOKEN } from "@/lib/stellar";

interface BulkGiveFormProps {
  onSuccess: () => void;
  onCancel: () => void;
}

export default function BulkGiveForm({ onSuccess, onCancel }: BulkGiveFormProps) {
  const { publicKey } = useWallet();
  const { addToast, updateToast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<ParsedBulkGiveRow[]>([]);
  const [headerError, setHeaderError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setFileName(file.name);
    setSubmitError("");
    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result;
      if (typeof content === "string") {
        const parsed = parseBulkGiveCSV(content);
        setHeaderError(parsed.headerError);
        setRows(parsed.rows);
      }
    };
    reader.readAsText(file);
  };

  const handleDownloadTemplate = () => {
    downloadCSV(BULK_GIVE_CSV_TEMPLATE, "vestflow-bulk-give-template.csv");
  };

  const validRows = rows.filter((r) => r.isValid);
  const invalidRows = rows.filter((r) => !r.isValid);
  const totalXlm = validRows.reduce((sum, r) => sum + (parseFloat(r.amount) || 0), 0);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!publicKey) {
      setSubmitError("Wallet not connected.");
      return;
    }
    if (rows.length === 0) {
      setSubmitError("Please upload a CSV file with receiver addresses and amounts.");
      return;
    }
    if (invalidRows.length > 0) {
      setSubmitError(`Please fix the ${invalidRows.length} invalid row(s) before submitting.`);
      return;
    }

    setSubmitting(true);
    setSubmitError("");
    const toastId = addToast({
      status: "pending",
      title: "Submitting bulk give…",
      message: `Sending ${totalXlm.toFixed(4)} XLM to ${rows.length} receivers`,
    });

    try {
      const receivers = rows.map((r) => r.receiver);
      const amounts = rows.map((r) => xlmToStroops(r.amount));

      await batchGive(publicKey, receivers, amounts, NATIVE_TOKEN);

      updateToast(toastId, {
        status: "success",
        title: "Bulk give completed",
        message: `Successfully transferred ${totalXlm.toFixed(4)} XLM to ${rows.length} receivers`,
      });
      onSuccess();
    } catch (err: any) {
      const msg = err?.message || "Bulk give transaction failed";
      setSubmitError(msg);
      updateToast(toastId, {
        status: "error",
        title: "Bulk give failed",
        message: msg,
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <label htmlFor="bulk-give-file-input" className="block text-xs font-medium text-zinc-400">
            Upload CSV (receiver_address, amount_xlm)
          </label>
          <span className="text-[11px] text-zinc-500">
            Accepts UTF-8, BOM, CRLF, and quoted fields.
          </span>
        </div>
        <button
          type="button"
          onClick={handleDownloadTemplate}
          className="text-xs text-violet-400 hover:text-violet-300 transition-colors underline"
        >
          ↓ Download Template
        </button>
      </div>

      <div
        onClick={() => fileInputRef.current?.click()}
        className="cursor-pointer border-2 border-dashed border-white/10 hover:border-violet-500/40 rounded-xl p-4 text-center transition-colors bg-white/[0.02]"
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,text/csv"
          onChange={handleFileChange}
          className="hidden"
          id="bulk-give-file-input"
          data-testid="bulk-give-file-input"
        />
        <div className="flex flex-col items-center gap-1.5">
          <svg className="w-6 h-6 text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
          </svg>
          <p className="text-xs text-zinc-300">
            {fileName ? (
              <span className="font-semibold text-violet-300">{fileName}</span>
            ) : (
              "Click to browse or drop CSV file here"
            )}
          </p>
        </div>
      </div>

      {headerError && (
        <div className="p-3 text-xs bg-red-500/10 border border-red-500/20 text-red-300 rounded-lg">
          {headerError}
        </div>
      )}

      {rows.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-zinc-400">
            <span>
              Preview: <strong className="text-zinc-200">{rows.length}</strong> rows
              {" ("}
              <span className="text-emerald-400">{validRows.length} valid</span>
              {invalidRows.length > 0 && (
                <span className="text-red-400">, {invalidRows.length} invalid</span>
              )}
              {")"}
            </span>
            <span>
              Total: <strong className="text-violet-300">{totalXlm.toFixed(4)} XLM</strong>
            </span>
          </div>

          <div className="max-h-52 overflow-y-auto rounded-lg border border-white/10 bg-black/40 text-xs">
            <table className="w-full border-collapse">
              <thead className="sticky top-0 bg-zinc-900 border-b border-white/10 text-zinc-400">
                <tr>
                  <th className="py-2 px-2.5 text-left font-medium w-12">#</th>
                  <th className="py-2 px-2.5 text-left font-medium">Receiver Address</th>
                  <th className="py-2 px-2.5 text-right font-medium w-28">Amount (XLM)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {rows.map((row) => {
                  const hasAddressError = !!row.addressError;
                  const hasAmountError = !!row.amountError;

                  return (
                    <tr
                      key={row.lineNumber}
                      className={row.isValid ? "hover:bg-white/[0.02]" : "bg-red-500/5 hover:bg-red-500/10"}
                    >
                      <td className="py-2 px-2.5 text-zinc-500 font-mono align-top">
                        {row.lineNumber}
                      </td>
                      <td className="py-2 px-2.5 align-top">
                        <div className="font-mono text-zinc-200 break-all">
                          {row.receiver || <span className="text-zinc-600 italic">Empty</span>}
                        </div>
                        {hasAddressError && (
                          <div className="text-[11px] text-red-400 mt-0.5 flex items-center gap-1 font-sans">
                            <span>⚠</span> {row.addressError}
                          </div>
                        )}
                      </td>
                      <td className="py-2 px-2.5 text-right font-mono align-top">
                        <div className={hasAmountError ? "text-red-400 font-bold" : "text-zinc-200"}>
                          {row.amount || <span className="text-zinc-600 italic">—</span>}
                        </div>
                        {hasAmountError && (
                          <div className="text-[11px] text-red-400 mt-0.5 font-sans">
                            {row.amountError}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {submitError && (
        <div className="p-3 text-xs bg-red-500/10 border border-red-500/20 text-red-300 rounded-lg">
          {submitError}
        </div>
      )}

      <div className="flex gap-3 pt-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="flex-1 min-h-[44px] rounded-xl border border-white/10 py-2.5 text-sm font-semibold text-zinc-300 hover:border-white/20 transition-colors disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting || rows.length === 0 || invalidRows.length > 0}
          className="flex-1 min-h-[44px] btn-primary rounded-xl py-2.5 font-semibold text-white transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {submitting ? (
            <>
              <span className="inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              <span>Submitting Batch…</span>
            </>
          ) : (
            `Send Bulk Give (${validRows.length})`
          )}
        </button>
      </div>
    </form>
  );
}
