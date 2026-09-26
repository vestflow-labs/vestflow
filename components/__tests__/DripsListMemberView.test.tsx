// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import DripsListMemberView, {
  calculateMemberMonthlyEarnings,
  SECONDS_PER_MONTH,
} from "../DripsListMemberView";

describe("DripsListMemberView (#650)", () => {
  const member1 = {
    address: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBYM",
    joined_at: 1700000000,
  };
  const member2 = {
    address: "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCOA",
    joined_at: 1700001000,
  };
  const member3 = {
    address: "GDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDG",
    joined_at: 1700002000,
  };

  it("calculates monthly earnings correctly: (total_rate / member_count) * seconds_per_month", () => {
    // 100 stroops/sec total funding rate with 2 members
    // per-member rate = 50 stroops/sec
    // monthly stroops = 50 * 2,592,000 = 129,600,000 stroops = 12.96 XLM
    const res = calculateMemberMonthlyEarnings(100n, 2);
    expect(res.perMemberRatePerSec).toBe(50n);
    expect(res.monthlyEarningsStroops).toBe(129600000n);
    expect(res.monthlyEarningsFormatted).toBe("12.96");
  });

  it("renders estimated monthly earnings in token units", () => {
    render(
      <DripsListMemberView
        members={[member1, member2]}
        totalFundingRatePerSec="100"
        tokenSymbol="USDC"
      />
    );

    // Summary heading
    expect(screen.getByText(/estimated per-member monthly earnings/i)).toBeInTheDocument();
    // Monthly formatted tokens in summary and member rows
    const matches = screen.getAllByText(/12.96\s+USDC/i);
    expect(matches.length).toBeGreaterThanOrEqual(1);
    // Members count display
    expect(screen.getByText(/2 members/i)).toBeInTheDocument();
  });

  it("updates monthly earnings dynamically when membership changes", () => {
    const { rerender } = render(
      <DripsListMemberView
        members={[member1, member2]}
        totalFundingRatePerSec="100"
        tokenSymbol="XLM"
      />
    );

    expect(screen.getAllByText(/12.96\s+XLM/i).length).toBeGreaterThanOrEqual(1);

    // Rerender with 1 member: per-member rate = 100 stroops/sec -> 25.92 XLM
    rerender(
      <DripsListMemberView
        members={[member1]}
        totalFundingRatePerSec="100"
        tokenSymbol="XLM"
      />
    );

    expect(screen.getAllByText(/25.92\s+XLM/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/1 member/i)).toBeInTheDocument();

    // Rerender with 4 members: per-member rate = 25 stroops/sec -> 6.48 XLM
    rerender(
      <DripsListMemberView
        members={[member1, member2, member3, { address: "GEEE", joined_at: 100 }]}
        totalFundingRatePerSec="100"
        tokenSymbol="XLM"
      />
    );

    expect(screen.getAllByText(/6.48\s+XLM/i).length).toBeGreaterThanOrEqual(1);
  });
});
