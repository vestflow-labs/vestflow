// @vitest-environment jsdom
//
// "Fund this project" entry point on the public profile page (#812).
//
// The button must be reachable by a signed-out visitor (the Stream Setup form
// is what asks for a wallet), and must not be shown on the viewer's own profile.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import FundProjectButton from "../FundProjectButton";

// The connected wallet is the only thing that varies between these cases.
const wallet = vi.hoisted(() => ({ publicKey: null as string | null }));

vi.mock("@/lib/WalletContext", () => ({
  useWallet: () => ({ publicKey: wallet.publicKey }),
}));

const PROFILE_ADDRESS = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const OTHER_WALLET = "GD6WU64OEP5C6LRBHINCMZTIVAKISPAAH6ISU2UOMNWCJAPUSOMUTMVX";

const findButton = () => screen.getByRole("link", { name: /fund this project/i });

describe("FundProjectButton", () => {
  beforeEach(() => {
    wallet.publicKey = null;
  });

  it("opens the Stream Setup form with the profile address pre-filled", () => {
    render(<FundProjectButton address={PROFILE_ADDRESS} />);

    expect(findButton()).toHaveAttribute(
      "href",
      `/app/streams/new?beneficiary=${PROFILE_ADDRESS}`
    );
    expect(findButton()).toHaveTextContent("Fund this project");
  });

  it("is visible to a visitor with no wallet connected", () => {
    wallet.publicKey = null;
    render(<FundProjectButton address={PROFILE_ADDRESS} />);

    expect(findButton()).toBeInTheDocument();
  });

  it("is visible when a different account is connected", () => {
    wallet.publicKey = OTHER_WALLET;
    render(<FundProjectButton address={PROFILE_ADDRESS} />);

    expect(findButton()).toBeInTheDocument();
  });

  it("is hidden on the viewer's own profile", () => {
    wallet.publicKey = PROFILE_ADDRESS;
    render(<FundProjectButton address={PROFILE_ADDRESS} />);

    expect(screen.queryByRole("link", { name: /fund this project/i })).not.toBeInTheDocument();
  });

  it("treats a differently-cased own address as the same profile", () => {
    wallet.publicKey = PROFILE_ADDRESS.toLowerCase();
    render(<FundProjectButton address={PROFILE_ADDRESS} />);

    expect(screen.queryByRole("link", { name: /fund this project/i })).not.toBeInTheDocument();
  });

  it("renders nothing when there is no address to fund", () => {
    render(<FundProjectButton address="" />);

    expect(screen.queryByRole("link", { name: /fund this project/i })).not.toBeInTheDocument();
  });
});
