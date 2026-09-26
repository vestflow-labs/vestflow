// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CommandPalette from "../CommandPalette";

const mockPush = vi.fn();

const { SCHEDULES } = vi.hoisted(() => ({
  SCHEDULES: [
    {
      id: 1,
      grantor: "GGRANTORONE00000000000000000000000000000000000000000001",
      beneficiary: "GBENEFICIARYONE0000000000000000000000000000000000000001",
    },
    {
      id: 2,
      grantor: "GGRANTORTWO00000000000000000000000000000000000000000002",
      beneficiary: "GBENEFICIARYTWO0000000000000000000000000000000000000002",
    },
  ],
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock("@/lib/stellar", () => ({
  getAllSchedules: vi.fn().mockResolvedValue(SCHEDULES),
  truncate: (addr: string, prefixLen = 6, suffixLen = 4) =>
    `${addr.slice(0, prefixLen)}…${addr.slice(-suffixLen)}`,
}));

vi.mock("@/lib/WalletContext", () => ({
  useWallet: () => ({ publicKey: null }),
}));

vi.mock("@/hooks/useAddressBook", () => ({
  useAddressBook: () => ({ getLabel: () => null }),
}));

describe("CommandPalette", () => {
  beforeEach(() => {
    mockPush.mockReset();
  });

  it("renders nothing when closed", () => {
    const { container } = render(
      <CommandPalette open={false} onClose={() => {}} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("loads and lists schedules when opened", async () => {
    render(<CommandPalette open={true} onClose={() => {}} />);
    await waitFor(() => {
      expect(screen.getByText(/schedule #1/i)).toBeInTheDocument();
      expect(screen.getByText(/schedule #2/i)).toBeInTheDocument();
    });
  });

  it("filters results by search query", async () => {
    render(<CommandPalette open={true} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/schedule #1/i)).toBeInTheDocument());

    const input = screen.getByPlaceholderText(/search schedules by id/i);
    await userEvent.type(input, "2");

    expect(screen.queryByText(/schedule #1/i)).not.toBeInTheDocument();
    expect(screen.getByText(/schedule #2/i)).toBeInTheDocument();
  });

  it("navigates to the schedule when a result is clicked", async () => {
    render(<CommandPalette open={true} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/schedule #1/i)).toBeInTheDocument());

    await userEvent.click(screen.getByText(/schedule #1/i));
    expect(mockPush).toHaveBeenCalledWith("/app/schedule/1");
  });

  it("navigates to the first result on Enter", async () => {
    render(<CommandPalette open={true} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/schedule #1/i)).toBeInTheDocument());

    const input = screen.getByPlaceholderText(/search schedules by id/i);
    await userEvent.type(input, "{Enter}");
    expect(mockPush).toHaveBeenCalledWith("/app/schedule/1");
  });

  it("calls onClose on Escape", async () => {
    const onClose = vi.fn();
    render(<CommandPalette open={true} onClose={onClose} />);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
