// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import BulkImportForm from "../BulkImportForm";

const mockCreateSchedule = vi.fn();

vi.mock("@/lib/stellar", () => ({
  createSchedule: (...args: any[]) => mockCreateSchedule(...args),
  parseContractError: (e: Error) => e.message,
  NETWORK: "testnet",
  NATIVE_TOKEN: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  truncate: (addr: string, prefixLen = 6, suffixLen = 4) =>
    `${addr.slice(0, prefixLen)}…${addr.slice(-suffixLen)}`,
}));

const { walletState } = vi.hoisted(() => ({
  walletState: {
    publicKey: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN" as string | null,
  },
}));

vi.mock("@/lib/WalletContext", () => ({
  useWallet: () => ({ publicKey: walletState.publicKey }),
}));

const VALID_ADDR = "G" + "A".repeat(55);

function futureDateString() {
  const d = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);
  return d.toISOString().split("T")[0];
}

function makeCsvFile(content: string) {
  return new File([content], "schedules.csv", { type: "text/csv" });
}

describe("BulkImportForm", () => {
  beforeEach(() => {
    mockCreateSchedule.mockReset();
    walletState.publicKey = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
  });

  it("prompts to connect a wallet when none is connected", () => {
    walletState.publicKey = null;
    render(<BulkImportForm />);
    expect(screen.getByText(/wallet not connected/i)).toBeInTheDocument();
  });

  it("renders the bulk import form when a wallet is connected", () => {
    render(<BulkImportForm />);
    expect(screen.getByText(/bulk import from csv/i)).toBeInTheDocument();
  });

  it("parses an uploaded CSV and renders a preview with valid row count", async () => {
    render(<BulkImportForm />);
    const csv = `beneficiary,amount,duration,cliff\n${VALID_ADDR},1000,365,90\n`;
    const input = screen.getByLabelText(/csv file/i);
    await userEvent.upload(input, makeCsvFile(csv));

    await waitFor(() => {
      expect(screen.getByText(/1 valid row/i)).toBeInTheDocument();
    });
  });

  it("shows a header error for a CSV missing required columns", async () => {
    render(<BulkImportForm />);
    const csv = `beneficiary,amount\n${VALID_ADDR},1000\n`;
    const input = screen.getByLabelText(/csv file/i);
    await userEvent.upload(input, makeCsvFile(csv));

    await waitFor(() => {
      expect(screen.getByText(/missing required column/i)).toBeInTheDocument();
    });
  });

  it("creates schedules for each valid row when submitted", async () => {
    mockCreateSchedule.mockResolvedValue("abc123hash");
    render(<BulkImportForm />);

    const csv = `beneficiary,amount,duration,cliff\n${VALID_ADDR},1000,365,90\n`;
    const input = screen.getByLabelText(/csv file/i);
    await userEvent.upload(input, makeCsvFile(csv));
    await waitFor(() => expect(screen.getByText(/1 valid row/i)).toBeInTheDocument());

    await userEvent.type(screen.getByLabelText(/^start date$/i), futureDateString());

    const submitButton = await screen.findByRole("button", { name: /create 1 schedule/i });
    await waitFor(() => expect(submitButton).toBeEnabled());
    await userEvent.click(submitButton);

    await waitFor(() => expect(mockCreateSchedule).toHaveBeenCalledTimes(1));
    expect(mockCreateSchedule).toHaveBeenCalledWith(
      expect.any(String),
      VALID_ADDR,
      "1000",
      expect.any(String),
      expect.any(Number),
      365,
      90,
      "LinearWithCliff",
      true
    );
  });
});
