// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import DashboardPage from "../../app/app/page";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGetAllSchedules = vi.fn();

vi.mock("@/lib/stellar", () => ({
  getAllSchedules: (...args: any[]) => mockGetAllSchedules(...args),
  getClaimableBulk: vi.fn().mockResolvedValue([]),
  getVestedAmountBulk: vi.fn().mockResolvedValue([]),
  isRpcError: (e: unknown) => {
    // Mirror the real implementation so tests stay close to production
    if (!(e instanceof Error)) return false;
    const msg = (e as Error).message.toLowerCase();
    if (e instanceof TypeError) return true;
    if (msg.includes("networkerror") || msg.includes("network error")) return true;
    if (msg.includes("failed to fetch") || msg.includes("fetch failed")) return true;
    if (msg.includes("econnrefused") || msg.includes("enotfound")) return true;
    return false;
  },
  vestingProgress: vi.fn().mockReturnValue(50),
  NATIVE_TOKEN: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  stroopsToXlm: (s: bigint) => (Number(s) / 10_000_000).toString(),
  buildCombinedExportCSV: vi.fn().mockReturnValue(""),
  downloadCSV: vi.fn(),
}));

vi.mock("@/lib/csvExport", () => ({
  buildCombinedExportCSV: vi.fn().mockReturnValue(""),
  downloadCSV: vi.fn(),
}));

vi.mock("@/lib/WalletContext", () => ({
  useWallet: () => ({ publicKey: null }),
}));

vi.mock("@/hooks/useCountUp", () => ({
  useCountUp: (value: number) => value,
}));

vi.mock("@/hooks/useAddressBook", () => ({
  useAddressBook: () => ({ getLabel: () => null }),
}));

vi.mock("@/components/Navbar", () => ({
  default: () => <nav data-testid="navbar" />,
}));

vi.mock("@/components/ScheduleCard", () => ({
  default: ({ schedule }: { schedule: { id: number } }) => (
    <div data-testid={`schedule-${schedule.id}`} />
  ),
}));

vi.mock("@/components/ScheduleCardSkeleton", () => ({
  ScheduleListSkeleton: () => <div data-testid="skeleton" />,
}));

vi.mock("@/components/EmptyState", () => ({
  NoSchedulesEmptyState: () => <div data-testid="empty-state" />,
  NoSearchResultsEmptyState: () => <div data-testid="no-results" />,
  NoGrantorSchedulesEmptyState: () => <div data-testid="no-grantor" />,
  NoBeneficiarySchedulesEmptyState: () => <div data-testid="no-beneficiary" />,
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DashboardPage — RPC error banner (#278)", () => {
  beforeEach(() => {
    mockGetAllSchedules.mockReset();
    // Default: successful load with no schedules
    mockGetAllSchedules.mockResolvedValue([]);
  });

  it("does NOT show the error banner on a successful load", async () => {
    render(<DashboardPage />);

    await waitFor(() => expect(mockGetAllSchedules).toHaveBeenCalledTimes(1));

    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the RPC error banner when getAllSchedules throws a TypeError (fetch failed)", async () => {
    mockGetAllSchedules.mockRejectedValueOnce(
      Object.assign(new TypeError("fetch failed"), {})
    );

    render(<DashboardPage />);

    await waitFor(() => {
      expect(
        screen.getByText(/could not reach the stellar rpc/i)
      ).toBeInTheDocument();
    });

    const alert = screen.getByRole("alert");
    expect(alert).toBeInTheDocument();
  });

  it("shows the banner for a network error message even when error is not TypeError", async () => {
    const networkErr = new Error("Network error: connection refused (ECONNREFUSED)");
    mockGetAllSchedules.mockRejectedValueOnce(networkErr);

    render(<DashboardPage />);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    expect(
      screen.getByText(/could not reach the stellar rpc/i)
    ).toBeInTheDocument();
  });

  it("does NOT show the banner for a contract-level error", async () => {
    // A plain Error (not TypeError) that doesn't match any network pattern
    const contractErr = new Error("Contract error: Schedule not found");
    mockGetAllSchedules.mockRejectedValueOnce(contractErr);

    render(<DashboardPage />);

    // Wait for the load attempt to settle
    await waitFor(() => expect(mockGetAllSchedules).toHaveBeenCalledTimes(1));
    // Give React a tick to flush any state updates
    await new Promise(r => setTimeout(r, 50));

    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("dismisses the banner when the × button is clicked", async () => {
    const user = userEvent.setup();
    mockGetAllSchedules.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    render(<DashboardPage />);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    const dismissBtn = screen.getByRole("button", { name: /dismiss error/i });
    await user.click(dismissBtn);

    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("clears the banner on a subsequent successful refresh", async () => {
    // First call fails, second succeeds
    mockGetAllSchedules
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce([]);

    const user = userEvent.setup();
    render(<DashboardPage />);

    // Banner should appear after first (failed) load
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    // Click the Refresh button to trigger load() again
    const refreshBtn = screen.getByRole("button", { name: /refresh/i });
    await user.click(refreshBtn);

    // Banner should disappear once the second load succeeds
    await waitFor(() => {
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });
});
