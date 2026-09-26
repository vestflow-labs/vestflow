// Runs CSV parsing/validation off the main thread so a 500-row upload never
// blocks the UI. Kept dependency-free of lib/stellar.ts (which pulls in
// Freighter/RPC code that assumes a `window`) — see lib/stroops.ts.
import { validateCsv, CsvValidationResult } from "@/lib/csv-validation";

// Typed locally instead of pulling in the "webworker" lib, which conflicts
// with the project's "dom" lib when both are loaded in one TS program.
const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<string>) => void) | null;
  postMessage: (data: CsvValidationResult) => void;
};

ctx.onmessage = (event) => {
  const result = validateCsv(event.data);
  ctx.postMessage(result);
};
