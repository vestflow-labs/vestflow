// ─── CSV bulk-create validation for the /app/bulk-create flow ─────────────
// Parses and validates up to 500 beneficiary schedule rows client-side.
// Expected header: beneficiary,token,amount_xlm,start_time_iso,duration_days,
// cliff_days,kind,revocable (cliff_days and revocable are optional).

import { StrKey } from "@stellar/stellar-sdk";
import { xlmToStroops } from "@/lib/stroops";

export const MAX_BULK_CREATE_ROWS = 500;
export const BULK_CREATE_BATCH_SIZE = 50;

export type ScheduleKind = "Linear" | "Cliff" | "LinearWithCliff";
const VALID_KINDS = new Set<ScheduleKind>(["Linear", "Cliff", "LinearWithCliff"]);

const REQUIRED_HEADERS = [
  "beneficiary",
  "token",
  "amount_xlm",
  "start_time_iso",
  "duration_days",
  "kind",
] as const;

export interface RawCsvRow {
  rowIndex: number;
  beneficiary: string;
  token: string;
  amount_xlm: string;
  start_time_iso: string;
  duration_days: string;
  cliff_days: string;
  kind: string;
  revocable: string;
}

export interface ValidatedRow {
  rowIndex: number;
  beneficiary: string;
  token: string;
  amountXlm: string;
  amountStroops: bigint;
  startTime: number;
  durationDays: number;
  cliffDays: number;
  kind: ScheduleKind;
  revocable: boolean;
}

export interface InvalidRow {
  rowIndex: number;
  raw: RawCsvRow;
  errors: string[];
}

export interface CsvValidationResult {
  validRows: ValidatedRow[];
  invalidRows: InvalidRow[];
  headerError: string | null;
}

/** Strips a leading UTF-8 BOM marker, if present. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Splits CSV text into lines, normalizing CRLF and dropping trailing blank lines. */
function splitLines(text: string): string[] {
  const normalized = stripBom(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  return lines;
}

/** Parses a single CSV line into cells, honoring double-quoted fields (with "" escaping). */
function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells.map((c) => c.trim());
}

function validateRow(raw: RawCsvRow): string[] {
  const errors: string[] = [];

  if (!raw.beneficiary) {
    errors.push("beneficiary: required.");
  } else if (!StrKey.isValidEd25519PublicKey(raw.beneficiary)) {
    errors.push("beneficiary: must be a valid Stellar G-address.");
  }

  if (!raw.token) {
    errors.push("token: required.");
  } else if (!StrKey.isValidContract(raw.token)) {
    errors.push("token: must be a valid Stellar C-address.");
  }

  if (!raw.amount_xlm) {
    errors.push("amount_xlm: required.");
  } else if (!/^[0-9]+(?:\.[0-9]+)?$/.test(raw.amount_xlm) || Number(raw.amount_xlm) <= 0) {
    errors.push("amount_xlm: must be a positive decimal number.");
  } else {
    try {
      xlmToStroops(raw.amount_xlm);
    } catch {
      errors.push("amount_xlm: could not be converted to stroops (overflow or invalid format).");
    }
  }

  if (!raw.start_time_iso) {
    errors.push("start_time_iso: required.");
  } else {
    const parsed = Date.parse(raw.start_time_iso);
    if (Number.isNaN(parsed)) {
      errors.push("start_time_iso: must be a parseable ISO 8601 timestamp.");
    } else if (parsed <= Date.now()) {
      errors.push("start_time_iso: must be in the future.");
    }
  }

  let durationDays: number | null = null;
  if (!raw.duration_days) {
    errors.push("duration_days: required.");
  } else if (!/^[0-9]+$/.test(raw.duration_days) || Number(raw.duration_days) <= 0) {
    errors.push("duration_days: must be a positive integer.");
  } else {
    durationDays = Number(raw.duration_days);
  }

  let cliffDays = 0;
  const cliffRaw = raw.cliff_days || "0";
  if (!/^[0-9]+$/.test(cliffRaw) || Number(cliffRaw) < 0) {
    errors.push("cliff_days: must be a non-negative integer.");
  } else {
    cliffDays = Number(cliffRaw);
    if (durationDays !== null && cliffDays >= durationDays) {
      errors.push("cliff_days: must be less than duration_days.");
    }
  }

  if (!raw.kind) {
    errors.push("kind: required.");
  } else if (!VALID_KINDS.has(raw.kind as ScheduleKind)) {
    errors.push(
      raw.kind === "Graded"
        ? "kind: Graded schedules require milestones and are not supported by bulk CSV upload."
        : "kind: must be one of Linear, Cliff, LinearWithCliff."
    );
  }

  const revocableRaw = (raw.revocable || "true").toLowerCase();
  if (!["true", "false", ""].includes(revocableRaw)) {
    errors.push("revocable: must be true or false.");
  }

  return errors;
}

export function validateCsv(text: string): CsvValidationResult {
  const lines = splitLines(text);
  if (lines.length === 0) {
    return { validRows: [], invalidRows: [], headerError: "The CSV file is empty." };
  }

  const header = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
  const missing = REQUIRED_HEADERS.filter((h) => !header.includes(h));
  if (missing.length > 0) {
    return {
      validRows: [],
      invalidRows: [],
      headerError: `Missing required column${missing.length !== 1 ? "s" : ""}: ${missing.join(", ")}.`,
    };
  }

  const dataLines = lines.slice(1);
  if (dataLines.length > MAX_BULK_CREATE_ROWS) {
    return {
      validRows: [],
      invalidRows: [],
      headerError: `Too many rows (${dataLines.length}). The bulk-create flow supports up to ${MAX_BULK_CREATE_ROWS} rows per file.`,
    };
  }

  const col = (name: string) => header.indexOf(name);
  const idx = {
    beneficiary: col("beneficiary"),
    token: col("token"),
    amount_xlm: col("amount_xlm"),
    start_time_iso: col("start_time_iso"),
    duration_days: col("duration_days"),
    cliff_days: col("cliff_days"),
    kind: col("kind"),
    revocable: col("revocable"),
  };

  const validRows: ValidatedRow[] = [];
  const invalidRows: InvalidRow[] = [];

  dataLines.forEach((line, i) => {
    if (line.trim() === "") return;
    const cells = parseCsvLine(line);
    const raw: RawCsvRow = {
      rowIndex: i + 1,
      beneficiary: cells[idx.beneficiary] ?? "",
      token: cells[idx.token] ?? "",
      amount_xlm: cells[idx.amount_xlm] ?? "",
      start_time_iso: cells[idx.start_time_iso] ?? "",
      duration_days: cells[idx.duration_days] ?? "",
      cliff_days: idx.cliff_days >= 0 ? cells[idx.cliff_days] ?? "" : "",
      kind: cells[idx.kind] ?? "",
      revocable: idx.revocable >= 0 ? cells[idx.revocable] ?? "" : "",
    };

    const errors = validateRow(raw);
    if (errors.length > 0) {
      invalidRows.push({ rowIndex: raw.rowIndex, raw, errors });
      return;
    }

    validRows.push({
      rowIndex: raw.rowIndex,
      beneficiary: raw.beneficiary,
      token: raw.token,
      amountXlm: raw.amount_xlm,
      amountStroops: xlmToStroops(raw.amount_xlm),
      startTime: Math.floor(Date.parse(raw.start_time_iso) / 1000),
      durationDays: Number(raw.duration_days),
      cliffDays: Number(raw.cliff_days || "0"),
      kind: raw.kind as ScheduleKind,
      revocable: (raw.revocable || "true").toLowerCase() !== "false",
    });
  });

  return { validRows, invalidRows, headerError: null };
}

export const BULK_CREATE_CSV_TEMPLATE =
  "beneficiary,token,amount_xlm,start_time_iso,duration_days,cliff_days,kind,revocable\n";

/**
 * Greedily marks valid rows as fundable from the top down until `availableStroops`
 * is exhausted. Rows beyond that point are returned as unfundable so the UI can
 * flag them ("Cannot fund — insufficient balance") without blocking the rows
 * that do fit.
 */
export function splitByAvailableBalance(
  rows: ValidatedRow[],
  availableStroops: bigint
): { fundable: ValidatedRow[]; unfundable: ValidatedRow[] } {
  let running = 0n;
  const fundable: ValidatedRow[] = [];
  const unfundable: ValidatedRow[] = [];

  for (const row of rows) {
    running += row.amountStroops;
    if (running <= availableStroops) {
      fundable.push(row);
    } else {
      unfundable.push(row);
    }
  }

  return { fundable, unfundable };
}

/**
 * Splits rows into fixed-size chunks for batch-shaped submission/progress UI.
 * Note: Soroban only allows one invokeHostFunction operation per Stellar
 * transaction, so each row within a "batch" is still submitted as its own
 * transaction/signature — batching here is a UI/progress grouping, not a
 * single on-chain transaction.
 */
export function chunkRows<T>(rows: T[], size: number = BULK_CREATE_BATCH_SIZE): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += size) {
    chunks.push(rows.slice(i, i + size));
  }
  return chunks;
}
