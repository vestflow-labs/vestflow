// ─── CSV bulk-import parsing for schedule creation ─────────────────────────
// Expects a header row with (at least) beneficiary, amount, duration columns.
// A cliff column is optional and defaults to 0 days.

export interface ParsedScheduleRow {
  lineNumber: number;
  beneficiary: string;
  amount: string;
  durationDays: string;
  cliffDays: string;
  errors: string[];
}

export interface ParsedSchedulesCSV {
  rows: ParsedScheduleRow[];
  headerError: string | null;
}

const REQUIRED_HEADERS = ["beneficiary", "amount", "duration"];

/** Minimal Stellar address check: starts with G, length 56, alphanumeric. */
function isValidStellarAddress(addr: string): boolean {
  return /^G[A-Z2-7]{55}$/.test(addr.trim());
}

/** Parses a single CSV line into cells, honoring double-quoted fields. */
function parseCSVLine(line: string): string[] {
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
  return cells;
}

function validateRow(
  beneficiary: string,
  amount: string,
  durationDays: string,
  cliffDays: string
): string[] {
  const errors: string[] = [];

  if (!beneficiary) {
    errors.push("Beneficiary address is required.");
  } else if (!isValidStellarAddress(beneficiary)) {
    errors.push("Beneficiary must be a valid Stellar address starting with G (56 characters).");
  }

  const amt = parseFloat(amount);
  if (!amount) {
    errors.push("Amount is required.");
  } else if (isNaN(amt) || amt <= 0) {
    errors.push("Amount must be a positive number.");
  }

  const dur = parseInt(durationDays, 10);
  if (!durationDays) {
    errors.push("Duration (days) is required.");
  } else if (isNaN(dur) || dur < 1) {
    errors.push("Duration must be at least 1 day.");
  }

  if (cliffDays) {
    const cliff = parseInt(cliffDays, 10);
    if (isNaN(cliff) || cliff < 0) {
      errors.push("Cliff must be 0 or more days.");
    } else if (!isNaN(dur) && cliff > dur) {
      errors.push("Cliff cannot exceed the total duration.");
    }
  }

  return errors;
}

/** Parses a beneficiary/amount/duration/cliff CSV for bulk schedule creation. */
export function parseSchedulesCSV(text: string): ParsedSchedulesCSV {
  const lines = text.split(/\r\n|\n|\r/).filter((line) => line.trim().length > 0);

  if (lines.length === 0) {
    return { rows: [], headerError: "The CSV file is empty." };
  }

  const headers = parseCSVLine(lines[0]).map((h) => h.trim().toLowerCase());
  const missing = REQUIRED_HEADERS.filter((h) => !headers.includes(h));
  if (missing.length > 0) {
    return {
      rows: [],
      headerError: `Missing required column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}. Expected headers: beneficiary, amount, duration, cliff (optional).`,
    };
  }

  if (lines.length === 1) {
    return { rows: [], headerError: "The CSV file has no data rows." };
  }

  const colIndex = {
    beneficiary: headers.indexOf("beneficiary"),
    amount: headers.indexOf("amount"),
    duration: headers.indexOf("duration"),
    cliff: headers.indexOf("cliff"),
  };

  const rows: ParsedScheduleRow[] = lines.slice(1).map((line, i) => {
    const cells = parseCSVLine(line);
    const beneficiary = (cells[colIndex.beneficiary] ?? "").trim();
    // Strip thousands separators so "1,000" doesn't silently parseFloat to 1.
    const amount = (cells[colIndex.amount] ?? "").trim().replace(/,/g, "");
    const durationDays = (cells[colIndex.duration] ?? "").trim().replace(/,/g, "");
    const cliffDays =
      colIndex.cliff >= 0
        ? (cells[colIndex.cliff] ?? "").trim().replace(/,/g, "")
        : "";

    return {
      lineNumber: i + 2, // account for the header row and 1-based line numbers
      beneficiary,
      amount,
      durationDays,
      cliffDays: cliffDays || "0",
      errors: validateRow(beneficiary, amount, durationDays, cliffDays),
    };
  });

  return { rows, headerError: null };
}

/** A sample CSV grantors can download and fill in. */
export const SCHEDULE_CSV_TEMPLATE =
  "beneficiary,amount,duration,cliff\n" +
  "GABC...EXAMPLE1,1000,365,90\n" +
  "GABC...EXAMPLE2,2500,730,180\n";

// ─── Bulk Give CSV Parsing (#793) ──────────────────────────────────────────

export interface ParsedBulkGiveRow {
  lineNumber: number;
  receiver: string;
  amount: string;
  addressError: string | null;
  amountError: string | null;
  isValid: boolean;
}

export interface ParsedBulkGiveCSV {
  rows: ParsedBulkGiveRow[];
  headerError: string | null;
}

export function parseBulkGiveCSV(text: string): ParsedBulkGiveCSV {
  // Strip BOM if present for Excel compatibility
  const cleanText = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  // Handle CRLF, LF, and CR line endings
  const lines = cleanText.split(/\r\n|\n|\r/).filter((line) => line.trim().length > 0);

  if (lines.length === 0) {
    return { rows: [], headerError: "The CSV file is empty." };
  }

  const firstCells = parseCSVLine(lines[0]).map((c) => c.trim().toLowerCase());
  const hasHeader =
    firstCells.some((c) => c.includes("receiver") || c.includes("recipient") || c.includes("address")) &&
    firstCells.some((c) => c.includes("amount"));

  let dataLines = lines;
  let receiverIdx = 0;
  let amountIdx = 1;

  if (hasHeader) {
    receiverIdx = firstCells.findIndex((c) => c.includes("receiver") || c.includes("recipient") || c.includes("address"));
    amountIdx = firstCells.findIndex((c) => c.includes("amount"));
    if (receiverIdx === -1) receiverIdx = 0;
    if (amountIdx === -1) amountIdx = 1;
    dataLines = lines.slice(1);
  }

  if (dataLines.length === 0) {
    return { rows: [], headerError: "The CSV file has no data rows." };
  }

  const rows: ParsedBulkGiveRow[] = dataLines.map((line, i) => {
    const cells = parseCSVLine(line);
    const receiver = (cells[receiverIdx] ?? "").trim();
    const amount = (cells[amountIdx] ?? "").trim().replace(/,/g, "");

    let addressError: string | null = null;
    if (!receiver) {
      addressError = "Receiver address is required.";
    } else if (!isValidStellarAddress(receiver)) {
      addressError = "Must be a valid Stellar address starting with G (56 characters).";
    }

    let amountError: string | null = null;
    const parsedAmount = parseFloat(amount);
    if (!amount) {
      amountError = "Amount is required.";
    } else if (isNaN(parsedAmount) || parsedAmount <= 0) {
      amountError = "Amount must be a positive number.";
    }

    return {
      lineNumber: hasHeader ? i + 2 : i + 1,
      receiver,
      amount,
      addressError,
      amountError,
      isValid: !addressError && !amountError,
    };
  });

  return { rows, headerError: null };
}

export const BULK_GIVE_CSV_TEMPLATE =
  "receiver_address,amount_xlm\n" +
  "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5,10.5\n" +
  "GD6WU64OEP5C6LRBHINCMZTIVAKISPAAH6ISU2UOMNWCJAPUSOMUTMVX,25.0\n";

