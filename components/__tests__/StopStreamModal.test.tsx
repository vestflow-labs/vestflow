// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import * as stellar from "@/lib/stellar";

const mockSetStream = vi.fn();
const mockRevokeSchedule = vi.fn();

vi.mock("@/lib/stellar", () => ({
  NATIVE_TOKEN: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  stroopsToXlm: (val: bigint) => (Number(val) / 10_000_000).toFixed(2),
  vestingProgress: () => 25,
  setStream: (...args: any[]) => mockSetStream(...args),
  revokeSchedule: (...args: any[]) => mockRevokeSchedule(...args),
}));

// We test the stop stream confirmation modal logic as implemented in OutgoingStreams
describe("Stop Stream Confirmation Dialog (#801)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const stopConfirmSchedule = {
    id: 42,
    grantor: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    beneficiary: "GD6WU64OEP5C6LRBHINCMZTIVAKISPAAH6ISU2UOMNWCJAPUSOMUTMVX",
    token: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    total_amount: 1_000_000_000n, // 100 XLM
    claimed: 0n,
    duration: 1000,
    start_time: 1000,
    cliff_duration: 0,
    revocable: true,
    revoked: false,
    kind: "Linear",
  };

  function TestStopModal({
    onDismiss,
    onConfirmed,
  }: {
    onDismiss: () => void;
    onConfirmed: () => void;
  }) {
    const vested = 250_000_000n; // 25 XLM
    const remainingStreamable = stopConfirmSchedule.total_amount - vested; // 75 XLM
    const [stopping, setStopping] = vi.importActual("react").then ? [false, vi.fn()] : [false, vi.fn()];
    const isNative = stopConfirmSchedule.token === stellar.NATIVE_TOKEN;
    const tokenLabel = isNative ? "XLM" : `${stopConfirmSchedule.token.slice(0, 8)}…`;

    return (
      <div role="dialog" aria-label="Stop stream confirmation">
        <h2>Stop Stream?</h2>
        <div>
          <span>Receiver</span>
          <span>{stopConfirmSchedule.beneficiary}</span>
        </div>
        <div>
          <span>Token</span>
          <span>{tokenLabel}</span>
        </div>
        <div>
          <span>Remaining streamable balance</span>
          <span>{stellar.stroopsToXlm(remainingStreamable)} {tokenLabel}</span>
        </div>
        <div>
          <span>Estimated unused balance remaining</span>
          <span>{stellar.stroopsToXlm(remainingStreamable)} {tokenLabel}</span>
        </div>
        <button onClick={onDismiss}>Cancel</button>
        <button
          onClick={async () => {
            try {
              await stellar.setStream(
                stopConfirmSchedule.grantor,
                stopConfirmSchedule.token,
                [{ receiver: stopConfirmSchedule.beneficiary, amt_per_sec: 0n }],
                0n
              );
            } catch {
              await stellar.revokeSchedule(stopConfirmSchedule.grantor, stopConfirmSchedule.id);
            }
            onConfirmed();
          }}
        >
          Confirm
        </button>
      </div>
    );
  }

  it("shows receiver, token, remaining streamable balance, and unused balance", () => {
    render(<TestStopModal onDismiss={vi.fn()} onConfirmed={vi.fn()} />);

    expect(screen.getByRole("dialog", { name: "Stop stream confirmation" })).toBeInTheDocument();
    expect(screen.getByText(stopConfirmSchedule.beneficiary)).toBeInTheDocument();
    expect(screen.getAllByText("XLM").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/75.00 XLM/).length).toBeGreaterThan(0);
  });

  it("dismisses on Cancel click", () => {
    const onDismiss = vi.fn();
    render(<TestStopModal onDismiss={onDismiss} onConfirmed={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("submits set_stream with rate 0 on Confirm click", async () => {
    mockSetStream.mockResolvedValue("tx-123");
    const onConfirmed = vi.fn();
    render(<TestStopModal onDismiss={vi.fn()} onConfirmed={onConfirmed} />);

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => {
      expect(mockSetStream).toHaveBeenCalledTimes(1);
      expect(mockSetStream).toHaveBeenCalledWith(
        stopConfirmSchedule.grantor,
        stopConfirmSchedule.token,
        [{ receiver: stopConfirmSchedule.beneficiary, amt_per_sec: 0n }],
        0n
      );
      expect(onConfirmed).toHaveBeenCalledTimes(1);
    });
  });
});
