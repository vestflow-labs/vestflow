// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import DripsListDetail from "../DripsListDetail";

// Mock WalletContext
const mockPublicKey = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBYM";
vi.mock("@/lib/WalletContext", () => ({
  useWallet: () => ({
    publicKey: mockPublicKey,
  }),
}));

describe("DripsListDetail (#649, #650)", () => {
  const mockList = {
    id: "list-1",
    name: "Core Engineering",
    owner: mockPublicKey,
    token: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    total_funding_rate_per_sec: "1000",
    target_rate_per_sec: "1000",
    member_count: 2,
  };

  const mockMembers = [
    { address: mockPublicKey, joined_at: 1700000000 },
    { address: "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCOA", joined_at: 1700001000 },
  ];

  it("renders list details and Fully Funded badge when rate meets target", () => {
    render(<DripsListDetail list={mockList} members={mockMembers} />);

    expect(screen.getByText("Core Engineering")).toBeInTheDocument();
    expect(screen.getByText("Fully Funded")).toBeInTheDocument();
    expect(screen.getByText(/copy list link/i)).toBeInTheDocument();
  });

  it("allows list owner to edit and save target rate", async () => {
    const onUpdateTargetRate = vi.fn().mockResolvedValue(undefined);

    render(
      <DripsListDetail
        list={mockList}
        members={mockMembers}
        onUpdateTargetRate={onUpdateTargetRate}
      />
    );

    // Click Edit button
    const editBtn = screen.getByRole("button", { name: /edit target rate/i });
    fireEvent.click(editBtn);

    const input = screen.getByLabelText(/target rate input/i);
    expect(input).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "2000" } });

    const saveBtn = screen.getByRole("button", { name: /save/i });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(onUpdateTargetRate).toHaveBeenCalledWith("2000");
    });
  });
});
