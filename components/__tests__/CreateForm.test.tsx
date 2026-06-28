// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CreateForm from "../CreateForm";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockCreateSchedule = vi.fn();

vi.mock("@/lib/stellar", () => ({
  createSchedule: (...args: any[]) => mockCreateSchedule(...args),
  parseContractError: (e: Error) => e.message,
  CONTRACT_ID: "CCZ6AE75C27DMB3SOIHK7WZSBUG3NQPVLHSVEBQ2FSAEVGRJ5TXAZWCX",
  NETWORK: "testnet",
  NATIVE_TOKEN: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  getWalletXlmBalance: vi.fn().mockResolvedValue(10_000_000_000n),
  xlmToStroops: (x: string) => BigInt(parseFloat(x) * 10_000_000),
}));

vi.mock("@/lib/WalletContext", () => ({
  useWallet: () => ({
    publicKey: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
  }),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CreateForm", () => {
  beforeEach(() => {
    mockCreateSchedule.mockReset();
  });

  it("renders the form when wallet is connected", () => {
    render(<CreateForm />);
    expect(screen.getByRole("heading", { name: /new vesting schedule/i })).toBeInTheDocument();
  });

  describe("empty beneficiary validation", () => {
    it("does not advance to confirm step when beneficiary is empty", async () => {
      const user = userEvent.setup();
      render(<CreateForm />);

      const submitBtn = screen.getByRole("button", { name: /review & create/i });
      await user.click(submitBtn);

      expect(screen.queryByText(/confirm vesting schedule/i)).not.toBeInTheDocument();
      expect(mockCreateSchedule).not.toHaveBeenCalled();
    });
  });

  describe("duration validation", () => {
    it("does not advance to confirm step when duration is 0", async () => {
      const user = userEvent.setup();
      render(<CreateForm />);

      await user.type(
        screen.getByPlaceholderText("GABC…"),
        "GBSOV3F63VBMLDKD3JV5HQC5KPVXJQEQHP5TPUMZWNMCZZQ6SKF2OL3A"
      );
      await user.type(screen.getByPlaceholderText("1000.00"), "100");

      fireEvent.change(screen.getByPlaceholderText("365"), { target: { value: "0" } });

      await user.click(screen.getByRole("button", { name: /review & create/i }));

      expect(screen.queryByText(/confirm vesting schedule/i)).not.toBeInTheDocument();
      expect(mockCreateSchedule).not.toHaveBeenCalled();
    });
  });

  describe("cliff > duration error", () => {
    it("shows contract error when cliff exceeds duration", async () => {
      mockCreateSchedule.mockRejectedValueOnce(
        new Error("Cliff cannot exceed duration")
      );

      const user = userEvent.setup();
      render(<CreateForm />);

      await user.type(
        screen.getByPlaceholderText("GABC…"),
        "GBSOV3F63VBMLDKD3JV5HQC5KPVXJQEQHP5TPUMZWNMCZZQ6SKF2OL3A"
      );
      await user.type(screen.getByPlaceholderText("1000.00"), "100");

      const dateInputs = document.querySelectorAll('input[type="date"]');
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      fireEvent.change(dateInputs[0], {
        target: { value: tomorrow.toISOString().split("T")[0] },
      });

      fireEvent.change(screen.getByPlaceholderText("365"), { target: { value: "100" } });

      await user.click(screen.getByRole("radio", { name: "Cliff" }));
      fireEvent.change(screen.getByPlaceholderText("180"), { target: { value: "90" } });

      await user.click(screen.getByRole("button", { name: /review & create/i }));

      const confirmBtn = await screen.findByRole("button", { name: /confirm & sign/i });
      await user.click(confirmBtn);

      await waitFor(() => {
        expect(screen.getByText(/cliff cannot exceed duration/i)).toBeInTheDocument();
      });
    });
  });

  describe("confirm step summary", () => {
    it("renders schedule summary with the entered values", async () => {
      const user = userEvent.setup();
      render(<CreateForm />);

      const beneficiary = "GBSOV3F63VBMLDKD3JV5HQC5KPVXJQEQHP5TPUMZWNMCZZQ6SKF2OL3A";
      await user.type(screen.getByPlaceholderText("GABC…"), beneficiary);
      await user.type(screen.getByPlaceholderText("1000.00"), "500");

      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const dateInputs = document.querySelectorAll('input[type="date"]');
      fireEvent.change(dateInputs[0], { target: { value: tomorrow.toISOString().split("T")[0] } });

      fireEvent.change(screen.getByPlaceholderText("365"), { target: { value: "365" } });

      await user.click(screen.getByRole("button", { name: /review & create/i }));

      expect(await screen.findByText(/confirm vesting schedule/i)).toBeInTheDocument();
      expect(screen.getByText(beneficiary)).toBeInTheDocument();
      expect(screen.getByText("365 days")).toBeInTheDocument();
      expect(screen.getByText(/500/)).toBeInTheDocument();
    });
  });
});
