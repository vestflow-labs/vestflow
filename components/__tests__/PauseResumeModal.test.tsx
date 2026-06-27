// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PauseResumeModal from "../PauseResumeModal";
import type { ScheduleData } from "@/lib/stellar";

const mockPauseSchedule = vi.fn();
const mockResumeSchedule = vi.fn();
const mockAddToast = vi.fn(() => "toast-1");
const mockUpdateToast = vi.fn();

vi.mock("@/lib/stellar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stellar")>();
  return {
    ...actual,
    pauseSchedule: (...args: unknown[]) => mockPauseSchedule(...args),
    resumeSchedule: (...args: unknown[]) => mockResumeSchedule(...args),
  };
});

vi.mock("@/lib/WalletContext", () => ({
  useWallet: () => ({ publicKey: "GGRANTOR" }),
}));

vi.mock("@/components/Toast", () => ({
  useToast: () => ({ addToast: mockAddToast, updateToast: mockUpdateToast }),
}));

const schedule: ScheduleData = {
  id: 7,
  grantor: "GGRANTOR",
  beneficiary: "GBENEFICIARY",
  token: "CTOKEN",
  total_amount: 100n,
  claimed: 0n,
  start_time: 1,
  duration: 100,
  cliff_duration: 0,
  lockup_duration: 0,
  kind: "Linear",
  revocable: true,
  revoked: false,
  paused: false,
  paused_duration: 0,
  paused_at: 0,
};

describe("PauseResumeModal", () => {
  beforeEach(() => {
    mockPauseSchedule.mockReset();
    mockResumeSchedule.mockReset();
    mockAddToast.mockClear();
    mockUpdateToast.mockClear();
  });

  it("pauses an active schedule and refreshes after confirmation", async () => {
    const onSuccess = vi.fn();
    mockPauseSchedule.mockResolvedValue("pause-hash");
    render(
      <PauseResumeModal
        schedule={schedule}
        open
        onClose={vi.fn()}
        onSuccess={onSuccess}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: "Pause Schedule" }));

    await waitFor(() => {
      expect(mockPauseSchedule).toHaveBeenCalledWith("GGRANTOR", 7);
      expect(onSuccess).toHaveBeenCalledOnce();
    });
    expect(mockResumeSchedule).not.toHaveBeenCalled();
  });

  it("resumes a paused schedule and refreshes after confirmation", async () => {
    const onSuccess = vi.fn();
    mockResumeSchedule.mockResolvedValue("resume-hash");
    render(
      <PauseResumeModal
        schedule={{ ...schedule, paused: true, paused_at: 50 }}
        open
        onClose={vi.fn()}
        onSuccess={onSuccess}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: "Resume Schedule" }));

    await waitFor(() => {
      expect(mockResumeSchedule).toHaveBeenCalledWith("GGRANTOR", 7);
      expect(onSuccess).toHaveBeenCalledOnce();
    });
    expect(mockPauseSchedule).not.toHaveBeenCalled();
  });
});
