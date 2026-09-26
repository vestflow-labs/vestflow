// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import BulkGiveForm from "../BulkGiveForm";
import { parseBulkGiveCSV, BULK_GIVE_CSV_TEMPLATE } from "@/lib/csvImport";
import { buildTransactionHistoryCSV } from "@/lib/csvExport";

const mockBatchGive = vi.fn();

vi.mock("@/lib/WalletContext", () => ({
  useWallet: () => ({
    publicKey: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  }),
}));

vi.mock("@/components/Toast", () => ({
  useToast: () => ({
    addToast: vi.fn().mockReturnValue("toast-1"),
    updateToast: vi.fn(),
  }),
}));

vi.mock("@/lib/stellar", () => ({
  NATIVE_TOKEN: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  xlmToStroops: (val: string) => BigInt(Math.round(parseFloat(val) * 10_000_000)),
  batchGive: (...args: any[]) => mockBatchGive(...args),
}));

describe("Bulk Give CSV Parsing (#793)", () => {
  it("parses valid CSV with CRLF, quoted fields and handles BOM", () => {
    const csvWithBomAndCrlf =
      "\uFEFF\"receiver_address\",\"amount_xlm\"\r\n" +
      "\"GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5\",\"10.5\"\r\n" +
      "GD6WU64OEP5C6LRBHINCMZTIVAKISPAAH6ISU2UOMNWCJAPUSOMUTMVX,25\r\n";

    const result = parseBulkGiveCSV(csvWithBomAndCrlf);
    expect(result.headerError).toBeNull();
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].receiver).toBe("GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
    expect(result.rows[0].amount).toBe("10.5");
    expect(result.rows[0].isValid).toBe(true);
    expect(result.rows[1].receiver).toBe("GD6WU64OEP5C6LRBHINCMZTIVAKISPAAH6ISU2UOMNWCJAPUSOMUTMVX");
    expect(result.rows[1].amount).toBe("25");
    expect(result.rows[1].isValid).toBe(true);
  });

  it("highlights invalid addresses or amounts inline", () => {
    const invalidCsv =
      "receiver_address,amount_xlm\n" +
      "invalid-address,10\n" +
      "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5,-5\n" +
      "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5,abc\n";

    const result = parseBulkGiveCSV(invalidCsv);
    expect(result.rows).toHaveLength(3);
    // Row 1: invalid address
    expect(result.rows[0].isValid).toBe(false);
    expect(result.rows[0].addressError).toContain("valid Stellar address");
    expect(result.rows[0].amountError).toBeNull();

    // Row 2: negative amount
    expect(result.rows[1].isValid).toBe(false);
    expect(result.rows[1].addressError).toBeNull();
    expect(result.rows[1].amountError).toContain("positive number");

    // Row 3: non-numeric amount
    expect(result.rows[2].isValid).toBe(false);
    expect(result.rows[2].amountError).toContain("positive number");
  });

  it("handles empty CSV", () => {
    const result = parseBulkGiveCSV("");
    expect(result.headerError).toBe("The CSV file is empty.");
    expect(result.rows).toHaveLength(0);
  });
});

describe("Transaction History CSV Export (#798)", () => {
  it("generates CSV with BOM, correct headers and rows", () => {
    const rows = [
      {
        type: "Stream opened",
        counterparty: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
        token: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
        amount: "100.00",
        timestamp: "2026-09-25T12:00:00Z",
      },
    ];

    const csv = buildTransactionHistoryCSV(rows);
    // Starts with UTF-8 BOM
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('"type","counterparty","token","amount","timestamp"');
    expect(csv).toContain('"Stream opened"');
    expect(csv).toContain('"100.00"');
  });
});

describe("BulkGiveForm Component (#793)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders upload area and template download link", () => {
    render(<BulkGiveForm onSuccess={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText(/Upload CSV/i)).toBeInTheDocument();
    expect(screen.getByText(/Download Template/i)).toBeInTheDocument();
  });

  it("loads CSV, displays preview table, and submits via batch_give", async () => {
    mockBatchGive.mockResolvedValue("mock-tx-hash");
    const onSuccess = vi.fn();
    render(<BulkGiveForm onSuccess={onSuccess} onCancel={vi.fn()} />);

    const validCsv =
      "receiver_address,amount_xlm\n" +
      "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5,15.5\n";

    const file = new File([validCsv], "gives.csv", { type: "text/csv" });
    const input = screen.getByLabelText(/Upload CSV/i).parentElement?.parentElement?.querySelector("input[type='file']") as HTMLInputElement;

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getAllByText(/15.5/).length).toBeGreaterThan(0);
      expect(screen.getByText(/GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5/)).toBeInTheDocument();
    });

    const submitBtn = screen.getByRole("button", { name: /Send Bulk Give/i });
    expect(submitBtn).toBeEnabled();

    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(mockBatchGive).toHaveBeenCalledTimes(1);
      expect(mockBatchGive).toHaveBeenCalledWith(
        "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
        ["GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"],
        [155000000n],
        "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"
      );
      expect(onSuccess).toHaveBeenCalled();
    });
  });
});
