// @vitest-environment jsdom
import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import CopyLinkButton from "../CopyLinkButton";

describe("CopyLinkButton (#648)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders with custom label", () => {
    render(<CopyLinkButton label="Copy Profile Link" />);
    expect(screen.getByRole("button", { name: /copy profile link/i })).toBeInTheDocument();
  });

  it("copies URL to clipboard and shows Copied! tooltip for 2 seconds", async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: {
        writeText: writeTextMock,
      },
    });

    render(<CopyLinkButton url="https://vestflow.app/profile/GBBB" label="Copy Link" />);

    const button = screen.getByRole("button", { name: /copy link/i });
    
    await act(async () => {
      fireEvent.click(button);
    });

    expect(writeTextMock).toHaveBeenCalledWith("https://vestflow.app/profile/GBBB");
    expect(screen.getByText("Copied!")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Copied to clipboard!");

    // Fast-forward 1.9s (still showing)
    act(() => {
      vi.advanceTimersByTime(1900);
    });
    expect(screen.getByText("Copied!")).toBeInTheDocument();

    // Fast-forward past 2 seconds (reverts)
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByText("Copied!")).not.toBeInTheDocument();
    expect(screen.getByText("Copy Link")).toBeInTheDocument();
  });

  it("shows fallback modal when clipboard API is unavailable/fails", async () => {
    // Break clipboard and execCommand
    Object.assign(navigator, {
      clipboard: undefined,
    });
    document.execCommand = vi.fn().mockReturnValue(false);

    render(<CopyLinkButton url="https://vestflow.app/schedule/42" label="Copy Link" />);

    const button = screen.getByRole("button", { name: /copy link/i });
    
    await act(async () => {
      fireEvent.click(button);
    });

    // Fallback modal should open
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Share Link")).toBeInTheDocument();
    expect(screen.getByDisplayValue("https://vestflow.app/schedule/42")).toBeInTheDocument();

    // Close modal
    const closeBtn = screen.getByRole("button", { name: /close modal/i });
    fireEvent.click(closeBtn);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
