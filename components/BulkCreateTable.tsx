"use client";
import { useRef, useState } from "react";
import { truncate } from "@/lib/stellar";
import { InvalidRow, ValidatedRow } from "@/lib/csv-validation";

export type SubmitStatus = "idle" | "pending" | "success" | "error";

export interface DisplayRow {
  rowIndex: number;
  valid: ValidatedRow | null;
  invalid: InvalidRow | null;
  fundable: boolean;
  status?: SubmitStatus;
  statusMessage?: string;
}

const ROW_HEIGHT = 44;
const OVERSCAN = 8;

/**
 * Lightweight windowed list (no external dependency) so a 500-row CSV renders
 * without layout thrashing: only rows near the visible scroll range are mounted.
 */
export default function BulkCreateTable({ rows }: { rows: DisplayRow[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const viewportHeight = 480;

  const totalHeight = rows.length * ROW_HEIGHT;
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const endIndex = Math.min(
    rows.length,
    Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN
  );
  const visibleRows = rows.slice(startIndex, endIndex);

  const validCount = rows.filter((r) => r.valid && r.fundable).length;
  const errorCount = rows.length - validCount;

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-zinc-300">
        <span className="text-emerald-400 font-medium">{validCount} valid</span>
        {" / "}
        <span className="text-red-400 font-medium">{errorCount} errors</span>
      </p>

      <div
        ref={containerRef}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        className="rounded-xl border border-white/8 overflow-y-auto overflow-x-auto"
        style={{ height: viewportHeight }}
      >
        <div style={{ height: totalHeight, position: "relative" }}>
          <table className="w-full text-xs" style={{ position: "absolute", top: startIndex * ROW_HEIGHT }}>
            <tbody>
              {visibleRows.map((row) => {
                const isValid = !!row.valid && row.fundable;
                const borderColor = isValid ? "border-l-emerald-500/60" : "border-l-red-500/70";
                return (
                  <tr
                    key={row.rowIndex}
                    style={{ height: ROW_HEIGHT }}
                    className={`border-l-2 ${borderColor} border-b border-white/5`}
                  >
                    <td className="px-3 py-2 text-zinc-500 w-10">{row.rowIndex}</td>
                    <td className="px-3 py-2 font-mono text-zinc-300">
                      {row.valid
                        ? truncate(row.valid.beneficiary, 6, 4)
                        : truncate(row.invalid?.raw.beneficiary || "—", 6, 4)}
                    </td>
                    <td className="px-3 py-2 text-zinc-300">
                      {row.valid ? row.valid.amountXlm : row.invalid?.raw.amount_xlm || "—"}
                    </td>
                    <td className="px-3 py-2 text-zinc-300">
                      {row.valid ? row.valid.kind : row.invalid?.raw.kind || "—"}
                    </td>
                    <td className="px-3 py-2">
                      {row.status === "pending" && <span className="text-zinc-400">Creating…</span>}
                      {row.status === "success" && <span className="text-emerald-400">✓ Created</span>}
                      {row.status === "error" && (
                        <span className="text-red-400" title={row.statusMessage}>
                          ✕ {row.statusMessage}
                        </span>
                      )}
                      {!row.status && !isValid && (
                        <span className="text-red-400" title={row.invalid?.errors.join(" ")}>
                          {row.invalid ? row.invalid.errors[0] : "Cannot fund (insufficient balance)"}
                        </span>
                      )}
                      {!row.status && isValid && <span className="text-emerald-400">✓ Ready</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
