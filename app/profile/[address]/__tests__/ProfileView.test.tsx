// @vitest-environment jsdom
// Snapshot tests for the public profile page in every activity state (#861, #862)
//
// Covers: empty profile, outgoing streams only, incoming streams only, and a
// fully active profile (streams + splits + gives). Each snapshot captures the
// whole rendered ProfileView, so unintended visual regressions show up as diffs.
//
// Updating snapshots: after an intentional UI change, regenerate them with
//   npx vitest run ProfileView -u
// then review the diff in __snapshots__/ProfileView.test.tsx.snap before committing.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import ProfileView from "../ProfileView";
import {
  getBeneficiaryScheduleIds,
  getGrantorScheduleIds,
  getScheduleBatch,
  NATIVE_TOKEN,
  type ScheduleData,
} from "@/lib/stellar";

// ── Mocks ──────────────────────────────────────────────────────────────────

// The navbar opens wallet and notification connections of its own; it is
// not part of the profile content under test.
vi.mock("@/components/Navbar", () => ({
  default: function Navbar() {
    return null;
  },
}));

// A visitor without a connected wallet viewing someone else's profile.
vi.mock("@/lib/WalletContext", () => ({
  useWallet: () => ({ publicKey: null }),
}));

// Mock price hook to return a stable value.
vi.mock("@/lib/price", () => ({
  useXlmPrice: () => 0.12,
  formatUsd: (amount: bigint, price: number) =>
    `$${((Number(amount) / 10_000_000) * price).toFixed(2)}`,
}));

// Mock countdown hook.
vi.mock("@/hooks/useCountdown", () => ({
  useCountdown: () => ({ days: 0, hours: 0, minutes: 0, seconds: 0 }),
  formatCountdown: () => "0d 0h 0m",
}));

// Schedules come from contract simulations; stub just those reads.
vi.mock("@/lib/stellar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stellar")>()),
  getGrantorScheduleIds: vi.fn(),
  getBeneficiaryScheduleIds: vi.fn(),
  getScheduleBatch: vi.fn(),
}));

// ── Fixtures ───────────────────────────────────────────────────────────────

// Fixed clock so vesting progress and dates render identically on every run.
const NOW = 1_767_225_600; // 2026-01-01T00:00:00Z

const PROFILE_ADDRESS = "GPROFILEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPRFL";
const COUNTERPARTY = "GCOUNTERPARTYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACPTY";
const SPLIT_RECEIVER = "GSPLITRECEIVERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAASPLT";

function makeSchedule(overrides: Partial<ScheduleData>): ScheduleData {
  return {
    id: 1,
    grantor: PROFILE_ADDRESS,
    beneficiary: COUNTERPARTY,
    token: NATIVE_TOKEN,
    total_amount: 100_000_000n, // 10 XLM
    claimed: 0n,
    start_time: NOW - 86400 * 30, // started 30 days ago
    duration: 86400 * 365, // 1 year
    cliff_duration: 0,
    lockup_duration: 0,
    kind: "Linear",
    revocable: true,
    revoked: false,
    paused: false,
    paused_duration: 0,
    paused_at: 0,
    requires_milestones: false,
    vested_at_revoke: 0n,
    ...overrides,
  };
}

const OUTGOING_SCHEDULE = makeSchedule({ id: 1, grantor: PROFILE_ADDRESS, beneficiary: COUNTERPARTY });
const INCOMING_SCHEDULE = makeSchedule({
  id: 2,
  grantor: COUNTERPARTY,
  beneficiary: PROFILE_ADDRESS,
  total_amount: 50_000_000n, // 5 XLM
});

const OUTGOING_STREAM = {
  receiver: COUNTERPARTY,
  token: NATIVE_TOKEN,
  rate_per_second: "1000",
  estimated_end_time: NOW + 86400 * 30,
};

const EMPTY_PROFILE = { outgoing_streams: [], drips_lists: [], gives: { records: [] } };
const NO_SPLITS = { receivers: [] };

interface ProfileState {
  grantorIds?: number[];
  beneficiaryIds?: number[];
  schedules?: ScheduleData[];
  profile?: object;
  splits?: object;
}

/** Serves one profile state from the contract reads and the activity APIs. */
function mockProfileState({
  grantorIds = [],
  beneficiaryIds = [],
  schedules = [],
  profile = EMPTY_PROFILE,
  splits = NO_SPLITS,
}: ProfileState) {
  vi.mocked(getGrantorScheduleIds).mockResolvedValue(grantorIds);
  vi.mocked(getBeneficiaryScheduleIds).mockResolvedValue(beneficiaryIds);
  vi.mocked(getScheduleBatch).mockResolvedValue(schedules);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const body = String(input).startsWith("/api/splits") ? splits : profile;
      return { ok: true, json: async () => body } as unknown as Response;
    })
  );
}

/** Renders the page and waits until the given text is on screen for each loaded section. */
async function renderProfile(...loadedMarkers: string[]) {
  const { container } = render(<ProfileView address={PROFILE_ADDRESS} />);
  for (const marker of loadedMarkers) {
    await screen.findByText(marker);
  }
  return container;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("ProfileView snapshots", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("renders an empty profile", async () => {
    mockProfileState({});
    const container = await renderProfile("No activity yet");
    expect(container).toMatchSnapshot("profile-empty");
  });

  it("renders a profile with outgoing streams only", async () => {
    mockProfileState({
      grantorIds: [1],
      schedules: [OUTGOING_SCHEDULE],
      profile: { ...EMPTY_PROFILE, outgoing_streams: [OUTGOING_STREAM] },
    });
    const container = await renderProfile("Schedule #1", "Splits configuration");
    expect(container).toMatchSnapshot("profile-outgoing-only");
  });

  it("renders a profile with incoming streams only", async () => {
    mockProfileState({
      beneficiaryIds: [2],
      schedules: [INCOMING_SCHEDULE],
    });
    const container = await renderProfile("Schedule #2", "Splits configuration");
    expect(container).toMatchSnapshot("profile-incoming-only");
  });

  it("renders a fully active profile (streams + splits + gives)", async () => {
    mockProfileState({
      grantorIds: [1],
      beneficiaryIds: [2],
      schedules: [OUTGOING_SCHEDULE, INCOMING_SCHEDULE],
      profile: {
        ...EMPTY_PROFILE,
        outgoing_streams: [OUTGOING_STREAM],
        gives: {
          records: [
            {
              id: "give-1",
              sender: PROFILE_ADDRESS,
              receiver: COUNTERPARTY,
              token: NATIVE_TOKEN,
              amount_stroops: "250000000", // 25 XLM
              timestamp: NOW - 86400 * 2,
            },
            {
              id: "give-2",
              sender: SPLIT_RECEIVER,
              receiver: PROFILE_ADDRESS,
              token: NATIVE_TOKEN,
              amount_stroops: "100000000", // 10 XLM
              timestamp: NOW - 86400,
            },
          ],
        },
      },
      splits: {
        receivers: [
          { receiver: SPLIT_RECEIVER, weight_bps: 6000 },
          { receiver: COUNTERPARTY, weight_bps: 4000 },
        ],
      },
    });
    const container = await renderProfile("Schedule #1", "Schedule #2", "Splits configuration");
    expect(container).toMatchSnapshot("profile-fully-active");
  });
});
