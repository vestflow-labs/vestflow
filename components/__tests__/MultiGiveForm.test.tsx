// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import MultiGiveForm from "../MultiGiveForm";
import { tokenAmountToBaseUnits } from "@/lib/stroops";

const { NATIVE_TOKEN, USDC_TOKEN, RECEIVER_A, RECEIVER_B, RECEIVER_C } = vi.hoisted(() => ({
  NATIVE_TOKEN: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  USDC_TOKEN: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  RECEIVER_A: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  RECEIVER_B: "GD6WU64OEP5C6LRBHINCMZTIVAKISPAAH6ISU2UOMNWCJAPUSOMUTMVX",
  RECEIVER_C: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
}));

const mockBatchGive = vi.fn();

vi.mock("@/lib/WalletContext", () => ({
  useWallet: () => ({ publicKey: RECEIVER_A }),
}));

vi.mock("@/components/Toast", () => ({
  useToast: () => ({
    addToast: vi.fn().mockReturnValue("toast-1"),
    updateToast: vi.fn(),
  }),
}));

vi.mock("@/lib/stellar", () => ({
  NATIVE_TOKEN,
  batchGive: (...args: any[]) => mockBatchGive(...args),
  tokenAmountToBaseUnits: (amount: string) =>
    BigInt(Math.round(parseFloat(amount) * 10_000_000)),
}));

// The real selector pulls wallet balances; the form's contract is what is under test here.
vi.mock("@/components/TokenSelector", () => ({
  default: ({ value, onChange }: { value: string; onChange: (t: string, s: string) => void }) => (
    <select
      aria-label="Token"
      value={value}
      onChange={(e) => onChange(e.target.value, e.target.value === NATIVE_TOKEN ? "XLM" : "USDC")}
    >
      <option value={NATIVE_TOKEN}>XLM</option>
      <option value={USDC_TOKEN}>USDC</option>
    </select>
  ),
}));

function fillRow(index: number, receiver: string, amount: string) {
  fireEvent.change(screen.getByLabelText(`Receiver address ${index + 1}`), {
    target: { value: receiver },
  });
  fireEvent.change(screen.getByLabelText(`Amount ${index + 1}`), { target: { value: amount } });
}

function tokenSelect(index: number) {
  return screen.getAllByLabelText("Token")[index];
}

describe("MultiGiveForm row management (#811)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts with a single row and can add and remove receivers", () => {
    render(<MultiGiveForm onSuccess={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getAllByTestId("multi-give-row")).toHaveLength(1);

    // The only row cannot be removed.
    expect(screen.getByRole("button", { name: /Remove receiver 1/i })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /Add receiver/i }));
    fireEvent.click(screen.getByRole("button", { name: /Add receiver/i }));
    expect(screen.getAllByTestId("multi-give-row")).toHaveLength(3);

    fireEvent.click(screen.getByRole("button", { name: /Remove receiver 2/i }));
    expect(screen.getAllByTestId("multi-give-row")).toHaveLength(2);
    expect(screen.queryByLabelText("Receiver address 3")).not.toBeInTheDocument();
  });

  it("gives each row its own token selector", () => {
    render(<MultiGiveForm onSuccess={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Add receiver/i }));

    fireEvent.change(tokenSelect(1), { target: { value: USDC_TOKEN } });

    expect((tokenSelect(0) as HTMLSelectElement).value).toBe(NATIVE_TOKEN);
    expect((tokenSelect(1) as HTMLSelectElement).value).toBe(USDC_TOKEN);
  });
});

describe("MultiGiveForm validation and summary (#811)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("blocks the review step while rows are incomplete", () => {
    render(<MultiGiveForm onSuccess={vi.fn()} onCancel={vi.fn()} />);
    fillRow(0, RECEIVER_A, "10");
    fireEvent.click(screen.getByRole("button", { name: /Add receiver/i }));
    // second row left empty

    fireEvent.click(screen.getByRole("button", { name: /Review & Send/i }));

    expect(screen.getByText(/Fix the 1 incomplete row/i)).toBeInTheDocument();
    expect(screen.queryByTestId("multi-give-review")).not.toBeInTheDocument();
    expect(mockBatchGive).not.toHaveBeenCalled();
  });

  it("rejects a malformed address and a non-positive amount", () => {
    render(<MultiGiveForm onSuccess={vi.fn()} onCancel={vi.fn()} />);
    fillRow(0, "not-an-address", "0");
    fireEvent.click(screen.getByRole("button", { name: /Review & Send/i }));

    expect(screen.getByText(/valid Stellar address/i)).toBeInTheDocument();
    expect(screen.queryByTestId("multi-give-review")).not.toBeInTheDocument();
  });

  it("shows the per-token total cost in the summary before confirming", () => {
    render(<MultiGiveForm onSuccess={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Add receiver/i }));
    fireEvent.change(tokenSelect(1), { target: { value: USDC_TOKEN } });
    fillRow(0, RECEIVER_A, "10");
    fillRow(1, RECEIVER_B, "2.5");

    const summary = screen.getByTestId("multi-give-summary");
    expect(summary).toHaveTextContent("1 × XLM · total 10 XLM");
    expect(summary).toHaveTextContent("1 × USDC · total 2.5 USDC");
    expect(summary).toHaveTextContent("2 batch_give calls on submit");

    fireEvent.click(screen.getByRole("button", { name: /Review & Send/i }));

    const review = screen.getByTestId("multi-give-review");
    expect(review).toHaveTextContent("Total 10 XLM");
    expect(review).toHaveTextContent("Total 2.5 USDC");
    expect(screen.getByRole("button", { name: /Confirm & Send \(2\)/i })).toBeInTheDocument();
  });
});

describe("MultiGiveForm submission (#811)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBatchGive.mockResolvedValue("mock-tx-hash");
  });

  it("sends one batch_give per token, grouped by token", async () => {
    const onSuccess = vi.fn();
    render(<MultiGiveForm onSuccess={onSuccess} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /Add receiver/i }));
    fireEvent.click(screen.getByRole("button", { name: /Add receiver/i }));

    // rows 1 and 3 use XLM, row 2 uses USDC
    fireEvent.change(tokenSelect(1), { target: { value: USDC_TOKEN } });

    fillRow(0, RECEIVER_A, "10");
    fillRow(1, RECEIVER_B, "2.5");
    fillRow(2, RECEIVER_C, "1");

    fireEvent.click(screen.getByRole("button", { name: /Review & Send/i }));
    fireEvent.click(screen.getByRole("button", { name: /Confirm & Send/i }));

    await waitFor(() => {
      expect(mockBatchGive).toHaveBeenCalledTimes(2);
    });

    expect(mockBatchGive).toHaveBeenNthCalledWith(
      1,
      RECEIVER_A,
      [RECEIVER_A, RECEIVER_C],
      [100000000n, 10000000n],
      NATIVE_TOKEN,
    );
    expect(mockBatchGive).toHaveBeenNthCalledWith(
      2,
      RECEIVER_A,
      [RECEIVER_B],
      [25000000n],
      USDC_TOKEN,
    );
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
  });

  it("returns to the edit step and surfaces the error when a batch fails", async () => {
    mockBatchGive.mockRejectedValueOnce(new Error("insufficient balance"));
    render(<MultiGiveForm onSuccess={vi.fn()} onCancel={vi.fn()} />);
    fillRow(0, RECEIVER_A, "10");

    fireEvent.click(screen.getByRole("button", { name: /Review & Send/i }));
    fireEvent.click(screen.getByRole("button", { name: /Confirm & Send/i }));

    await waitFor(() => {
      expect(screen.getByText("insufficient balance")).toBeInTheDocument();
    });
    expect(screen.getByTestId("multi-give-summary")).toBeInTheDocument();
  });
});

describe("tokenAmountToBaseUnits", () => {
  it("converts token amounts at the 7-decimal Stellar scale", () => {
    expect(tokenAmountToBaseUnits("1")).toBe(10_000_000n);
    expect(tokenAmountToBaseUnits("2.5")).toBe(25_000_000n);
    expect(tokenAmountToBaseUnits("0.0000001")).toBe(1n);
    expect(tokenAmountToBaseUnits("10", 0)).toBe(10n);
    expect(tokenAmountToBaseUnits("1.5", 2)).toBe(150n);
  });

  it("rejects malformed amounts and invalid decimals", () => {
    expect(() => tokenAmountToBaseUnits("abc")).toThrow(/Invalid amount/);
    expect(() => tokenAmountToBaseUnits("1.2.3")).toThrow(/Invalid amount/);
    expect(() => tokenAmountToBaseUnits("1", 99)).toThrow(/Invalid decimals/);
  });
});
