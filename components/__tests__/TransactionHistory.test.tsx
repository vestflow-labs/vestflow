// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import TransactionHistory from "../TransactionHistory";
import * as csvExport from "@/lib/csvExport";

vi.mock("@/lib/WalletContext", () => ({
  useWallet: () => ({
    publicKey: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  }),
}));

vi.mock("@/lib/stellar", () => ({
  NETWORK: "testnet",
  stroopsToXlm: (val: bigint) => (Number(val) / 10_000_000).toFixed(2),
}));

vi.mock("@/lib/csvExport", () => ({
  exportTransactionHistoryCSV: vi.fn(),
  downloadCSV: vi.fn(),
}));

describe("TransactionHistory Component with CSV Export (#798)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders Download CSV button and triggers export with filtered events", async () => {
    const mockEvents = [
      {
        id: "evt-1",
        event_type: "schedule_created",
        ledger: 12345,
        ledger_closed_at: "2026-09-25T12:00:00Z",
        schedule_id: 1,
        grantor: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
        beneficiary: "GD6WU64OEP5C6LRBHINCMZTIVAKISPAAH6ISU2UOMNWCJAPUSOMUTMVX",
        amount: "1000000000",
        token: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
        created_amount: null,
        created_at: 1727265600,
      },
    ];

    global.fetch = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({ events: mockEvents }),
    } as any);

    render(<TransactionHistory />);

    await waitFor(() => {
      expect(screen.getByText("Stream opened")).toBeInTheDocument();
    });

    const downloadBtn = screen.getByRole("button", { name: /Download CSV/i });
    expect(downloadBtn).toBeInTheDocument();
    expect(downloadBtn).toBeEnabled();

    fireEvent.click(downloadBtn);

    expect(csvExport.exportTransactionHistoryCSV).toHaveBeenCalledTimes(1);
    expect(csvExport.exportTransactionHistoryCSV).toHaveBeenCalledWith(
      [
        {
          type: "Stream opened",
          counterparty: "GD6WU64OEP5C6LRBHINCMZTIVAKISPAAH6ISU2UOMNWCJAPUSOMUTMVX",
          token: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
          amount: "100.00",
          timestamp: "2026-09-25T12:00:00Z",
        },
      ],
      "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
    );
  });
});
