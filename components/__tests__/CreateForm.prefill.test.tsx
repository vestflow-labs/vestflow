// @vitest-environment jsdom
//
// Receiver pre-fill on the Stream Setup form (#812).
//
// The profile "Fund this project" button links to
// `/app/streams/new?beneficiary=<address>`; the page hands that value to this
// form, which must open with the receiver already filled in. A malformed value
// must never be seeded into a field that gets submitted on-chain.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import CreateForm from "../CreateForm";

const mockCreateSchedule = vi.fn();

vi.mock("@/lib/stellar", () => ({
  createSchedule: (...args: any[]) => mockCreateSchedule(...args),
  parseContractError: (e: Error) => e.message,
  CONTRACT_ID: "CCZ6AE75C27DMB3SOIHK7WZSBUG3NQPVLHSVEBQ2FSAEVGRJ5TXAZWCX",
  NETWORK: "testnet",
  NATIVE_TOKEN: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  getWalletXlmBalance: vi.fn().mockResolvedValue(10_000_000_000n),
  xlmToStroops: (x: string) => BigInt(parseFloat(x) * 10_000_000),
}));

vi.mock("@/lib/WalletContext", () => ({
  useWallet: () => ({
    publicKey: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
  }),
}));

vi.mock("@/lib/price", () => ({
  useXlmPrice: () => 0.12,
}));

const RECEIVER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

const beneficiaryInput = () =>
  screen.getByLabelText(/beneficiary address/i) as HTMLInputElement;

describe("CreateForm receiver pre-fill", () => {
  beforeEach(() => {
    mockCreateSchedule.mockReset();
  });

  it("starts empty without a pre-filled receiver", () => {
    render(<CreateForm />);

    expect(beneficiaryInput().value).toBe("");
  });

  it("starts with the receiver pre-filled from the profile button", () => {
    render(<CreateForm initialBeneficiary={RECEIVER} />);

    expect(beneficiaryInput().value).toBe(RECEIVER);
  });

  it("trims surrounding whitespace from the pre-filled receiver", () => {
    render(<CreateForm initialBeneficiary={`  ${RECEIVER}  `} />);

    expect(beneficiaryInput().value).toBe(RECEIVER);
  });

  it("ignores a malformed receiver instead of seeding an invalid submission", () => {
    render(<CreateForm initialBeneficiary="not-an-address" />);

    expect(beneficiaryInput().value).toBe("");
  });

  it("ignores an empty or whitespace-only receiver", () => {
    render(<CreateForm initialBeneficiary="   " />);

    expect(beneficiaryInput().value).toBe("");
  });

  it("adopts a receiver that arrives after mount while the field is untouched", () => {
    const { rerender } = render(<CreateForm />);
    expect(beneficiaryInput().value).toBe("");

    rerender(<CreateForm initialBeneficiary={RECEIVER} />);

    expect(beneficiaryInput().value).toBe(RECEIVER);
  });

  it("does not overwrite a receiver the user already typed", () => {
    const { rerender } = render(<CreateForm />);
    const typed = "GD6WU64OEP5C6LRBHINCMZTIVAKISPAAH6ISU2UOMNWCJAPUSOMUTMVX";

    fireEvent.change(beneficiaryInput(), { target: { value: typed } });
    rerender(<CreateForm initialBeneficiary={RECEIVER} />);

    expect(beneficiaryInput().value).toBe(typed);
  });
});
