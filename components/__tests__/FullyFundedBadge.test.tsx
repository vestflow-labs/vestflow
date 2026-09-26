// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import FullyFundedBadge, { isFullyFunded } from "../FullyFundedBadge";

describe("FullyFundedBadge (#649)", () => {
  it("shows Fully Funded badge when funding rate >= target rate", () => {
    render(<FullyFundedBadge fundingRate="1000" targetRate="1000" />);
    expect(screen.getByText("Fully Funded")).toBeInTheDocument();
  });

  it("shows Fully Funded badge when funding rate > target rate", () => {
    render(<FullyFundedBadge fundingRate="1500" targetRate="1000" />);
    expect(screen.getByText("Fully Funded")).toBeInTheDocument();
  });

  it("hides badge when underfunded (funding rate < target rate)", () => {
    const { container } = render(<FullyFundedBadge fundingRate="500" targetRate="1000" />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByText("Fully Funded")).not.toBeInTheDocument();
  });

  it("hides badge when target rate is zero or unconfigured", () => {
    const { container } = render(<FullyFundedBadge fundingRate="500" targetRate="0" />);
    expect(container.firstChild).toBeNull();
  });

  it("shows tooltip explaining Fully Funded meaning on hover/focus", () => {
    render(<FullyFundedBadge fundingRate="2000" targetRate="1000" />);

    const badge = screen.getByRole("status");
    expect(badge).toBeInTheDocument();

    // Trigger mouse enter
    fireEvent.mouseEnter(badge);

    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    expect(screen.getByText(/total incoming stream rate covers all list members completely/i)).toBeInTheDocument();

    // Trigger mouse leave
    fireEvent.mouseLeave(badge);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("isFullyFunded helper correctly compares BigInt values", () => {
    expect(isFullyFunded("1000", "1000")).toBe(true);
    expect(isFullyFunded("2000", "1000")).toBe(true);
    expect(isFullyFunded("500", "1000")).toBe(false);
    expect(isFullyFunded("1000", "0")).toBe(false);
    expect(isFullyFunded("0", "0")).toBe(false);
  });
});
