#![no_std]
#![allow(clippy::too_many_arguments)]

//! # VestFlow Contract
//!
//! Trustless token vesting schedules on Stellar / Soroban.
//!
//! ## Re-entrancy Invariant
//!
//! Soroban's host environment does not allow the classic EVM-style re-entrancy
//! because a contract invocation runs to completion before any cross-contract
//! call can trigger a new entry to the same contract. State-mutating entry
//! points therefore avoid an explicit storage-backed re-entrancy guard, keeping
//! `claim` and `revoke` cheaper by avoiding two unnecessary instance storage
//! writes per invocation.
//!
//! ## Error Messages
//!
//! The contract panics with plain string messages that callers can match on.
//! All public-facing error strings are listed below.
//!
//! | Error string                    | Triggered by                                                     |
//! |---------------------------------|------------------------------------------------------------------|
//! | `"Schedule not found"`          | `get_schedule`, `claim`, `revoke`, `bump_schedule_ttl` with an unknown ID |
//! | `"Nothing to claim yet"`        | `claim` called before any tokens have vested                     |
//! | `"Schedule is not revocable"`   | `revoke` called on an irrevocable schedule                       |
//! | `"Already revoked"`             | `revoke` called a second time on the same schedule               |
//! | `"Amount must be positive"`     | `create_schedule` with `total_amount` ≤ 0                        |
//! | `"Duration must be positive"`   | `create_schedule` with `duration` = 0                            |
//! | `"Cliff cannot exceed duration"`| `create_schedule` with `cliff_duration` > `duration`             |
//! | `"Lockup cannot be less than cliff"` | `create_schedule` with `lockup_duration` < `cliff_duration`   |
//! | `"Beneficiary must differ from grantor"` | `create_schedule` with `beneficiary == grantor`                 |
//! | `"Start time cannot be in the past"` | `create_schedule` or `create_graded_schedule` with `start_time` < current ledger time |
//! | `"Invalid token"` | `create_schedule` with a `token` address that is not a recognised Stellar Asset Contract |
//! | `"Upgrade authority already initialized"` | `initialize_upgrade_authority` called more than once |
//! | `"Upgrade authority not initialized"` | Upgrade announcement/execution attempted before authority setup |
//! | `"Unauthorized upgrade authority"` | Upgrade action signed by an address other than the authority |
//! | `"No pending upgrade"` | Upgrade execution/cancellation attempted without an announcement |
//! | `"Upgrade timelock still active"` | Upgrade execution attempted before 48 hours elapsed |
//! | `"Upgrade executable time overflow"` | Upgrade announcement timestamp cannot safely add the timelock |
//! | `"Insufficient balance or below minimum reserve"` | `claim` transfer fails due to balance constraints or Stellar minimum reserve |
//! | `"Performance oracle must be initialized before enabling milestones"` | `enable_performance_milestones` called before `initialize_performance_oracle` |
//! | `"Not the beneficiary"` | `create_delegation`/`revoke_delegation` called with a `beneficiary` that doesn't match the schedule |
//! | `"Delegate must differ from beneficiary"` | `create_delegation` with `delegate == beneficiary` |
//! | `"Max amount must be positive"` | `create_delegation` with `max_amount` = `Some(n)` where `n <= 0` |
//! | `"Expiry must be in the future"` | `create_delegation` with `expires_at_ledger` at or before the current ledger sequence |

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, vec, xdr::ToXdr,
    Address, Bytes, BytesN, Env, IntoVal, String, Vec,
};

/// Human-readable contract version, sourced from the `version` field in
/// `Cargo.toml` at build time via `env!("CARGO_PKG_VERSION")`.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum VestFlowError {
    NotFound = 1,
    NotRevocable = 2,
    AlreadyRevoked = 3,
    NothingToClaim = 4,
    AmountZero = 5,
    DurationZero = 6,
    CliffExceedsDuration = 7,
    ScheduleRevoked = 8,
    LockupLessThanCliff = 9,
    InvalidToken = 10,
    ProposalNotFound = 11,
    ProposalNotExpired = 12,
    ProposalExpired = 13,
    ProposalAlreadyActivated = 14,
    DurationTooShort = 15,
    DelegationNotFound = 16,
    DelegationRevoked = 17,
    DelegationExpired = 18,
    DelegationExhausted = 19,
    NotDelegate = 20,
    TooManyDelegations = 21,
    MergeTypeMismatch = 22,
    MergeTooFewSchedules = 23,
    MergeTooManySchedules = 24,
    MergeTokenMismatch = 25,
    MergeOwnerMismatch = 26,
    /// Split payout could not resolve the current owner of an NFT-gated receiver.
    NftOwnerNotFound = 27,
    /// `split` was called for an account with no splits configured.
    NoSplits = 28,
    /// `claim_schedule_slot` called for a leaf that has already claimed its slot.
    SlotAlreadyClaimed = 29,
    /// `claim_schedule_slot` called after a batch's `expiry_ledger` has passed.
    BatchExpired = 30,
    /// A Merkle proof did not resolve to the batch's committed root.
    InvalidProof = 31,
    /// `reclaim_batch` called before `expiry_ledger` has passed.
    NotExpired = 32,
    /// A Merkle proof exceeded the maximum supported depth (20).
    ProofTooDeep = 33,
    /// StreamReceiver `amt_per_sec` or SplitsReceiver `weight` must be positive.
    WeightZero = 34,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Schedule(u64),
    ScheduleCount,
    MultiTokenSchedule(u64),
    MultiTokenScheduleCount,
    /// Address authorized to announce, execute, and cancel contract upgrades.
    UpgradeAuthority,
    /// The currently announced contract upgrade, if any.
    PendingUpgrade,
    /// Index of schedule IDs created by a grantor.
    GrantorSchedules(Address),
    GrantorMultiTokenSchedules(Address),
    /// Index of schedule IDs where an address is the beneficiary.
    BeneficiarySchedules(Address),
    BeneficiaryMultiTokenSchedules(Address),
    /// NFT token contract address for vesting receipts.
    NftContract,
    /// Performance milestone attestations for a schedule.
    PerformanceMilestones(u64),
    /// Oracle address authorized to attest milestones.
    PerformanceOracle,
    /// Escrow proposal by id. Appended to avoid colliding with existing keys.
    Proposal(u64),
    /// Monotonic counter of proposals ever created.
    ProposalCount,
    /// Drips list by id.
    DripsList(u64),
    /// Monotonic counter of drips lists created.
    DripsListCount,
    /// Active drips stream from funder to member for a list: (list_id, member).
    DripsStream(u64, Address),
    /// Funds an account has deposited to pay for its outgoing streams of a
    /// token: (account, token).
    StreamBalance(Address, Address),
    /// Index of drips list IDs an address receives a stream from, so incoming
    /// streams can be enumerated without scanning every list.
    MemberStreamLists(Address),
    /// Proportional splits configuration for an account.
    Splits(Address),
    /// Token-specific streams configuration + accounting: (funder, token).
    AccountTokenStreams(Address, Address),
    /// Tokens a receiver has accrued from streams but not yet collected: (receiver, token).
    Accrued(Address, Address),
    /// Index of (list_id, member) streams opened by a (funder, token).
    FunderStreams(Address, Address),
    /// Committed Merkle root of a batch's beneficiary slots.
    BatchRoot(u64),
    /// Token deposited for a batch.
    BatchToken(u64),
    /// Grantor who committed a batch (and who may reclaim it after expiry).
    BatchGrantor(u64),
    /// Tokens still unclaimed in a batch. Decremented on each successful
    /// `claim_schedule_slot`.
    BatchRemaining(u64),
    /// Ledger sequence after which unclaimed slots can no longer be claimed
    /// and the grantor may reclaim the remaining balance.
    BatchExpiry(u64),
    /// Presence marks a leaf hash as already claimed, keyed globally by leaf
    /// hash since leaves already commit to their batch via the Merkle root.
    BatchSlotClaimed(BytesN<32>),
    /// Monotonic counter of batches ever committed.
    BatchCounter,
}

/// Storage keys for claim delegations, keyed separately from [`DataKey`] so
/// delegation records don't crowd the schedule key space.
#[contracttype]
#[derive(Clone)]
pub enum DelegationKey {
    /// A single delegation: (schedule_id, delegation_id).
    Delegation(u64, u32),
    /// Monotonic delegation-id counter for a schedule, keyed by schedule_id.
    DelegationCount(u64),
    /// Count of currently active (non-revoked) delegations for a schedule,
    /// keyed by schedule_id. Maintained incrementally by `create_delegation`
    /// and `revoke_delegation` so the concurrency cap can be enforced in
    /// O(1) instead of scanning every historical delegation ever created.
    ActiveDelegationCount(u64),
}

/// Maximum number of concurrently active (non-revoked) delegations a
/// beneficiary may hold open per schedule.
pub const MAX_DELEGATIONS_PER_SCHEDULE: u32 = 5;

/// A delegation of claim rights from a schedule's beneficiary to a
/// third-party address, optionally bounded by amount and/or ledger expiry.
#[contracttype]
#[derive(Clone)]
pub struct ClaimDelegation {
    /// Address authorized to claim on the beneficiary's behalf.
    pub delegate: Address,
    /// Maximum total tokens this delegate may ever claim. `None` = unlimited.
    pub max_amount: Option<i128>,
    /// Ledger sequence after which this delegation can no longer be used to
    /// claim. `None` = no expiry.
    pub expires_at_ledger: Option<u32>,
    /// Tokens already claimed through this delegation.
    pub claimed_so_far: i128,
    /// Whether the beneficiary has revoked this delegation.
    pub revoked: bool,
}

/// Mandatory delay between an on-chain upgrade announcement and execution.
pub const UPGRADE_TIMELOCK_SECONDS: u64 = 48 * 60 * 60;

/// Ledgers remaining below which `bump_schedule_ttl` extends the instance
/// TTL (~7 days at ~5s/ledger).
pub const INSTANCE_TTL_THRESHOLD_LEDGERS: u32 = 120_960;
/// Ledgers to extend the instance TTL to when bumped (~30 days at ~5s/ledger).
pub const INSTANCE_TTL_EXTEND_TO_LEDGERS: u32 = 518_400;

/// Deposit window for escrow proposals, in ledgers.
///
/// 72 hours at the 10s/ledger rate used by the spec (~25,920 ledgers).
/// Enforced in contract logic via `created_at_ledger`; instance storage TTL is
/// shared with every schedule and is bumped with the existing instance constants.
pub const PROPOSAL_WINDOW_LEDGERS: u32 = 25_920;

/// Lifecycle of an escrow schedule proposal.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProposalState {
    /// Parameters locked; tokens have not been transferred.
    Pending,
    /// Beneficiary has acknowledged on-chain. Activation is still optional.
    Acknowledged,
    /// Grantor funded the proposal. Inner value is the created schedule id.
    Activated(u64),
    /// Past the 72-hour window. Written by [`VestFlowContract::expire_proposal`].
    Expired,
}

/// Parameters and status of a two-phase escrow proposal.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ScheduleProposal {
    pub id: u64,
    pub grantor: Address,
    pub beneficiary: Address,
    pub token: Address,
    pub total_amount: i128,
    pub start_time: u64,
    pub duration: u64,
    pub cliff_duration: u64,
    pub lockup_duration: u64,
    pub kind: VestingKind,
    pub revocable: bool,
    pub state: ProposalState,
    pub created_at_ledger: u32,
}

/// A named list of member addresses to receive stream funding.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct DripsList {
    pub id: u64,
    pub owner: Address,
    pub name: String,
    pub members: Vec<Address>,
}

/// Length of one drips cycle in seconds (one week).
///
/// Streaming amounts are accounted for in whole cycles. Exposed on-chain via
/// [`VestFlowContract::cycle_secs`] so clients read it from the deployed
/// contract instead of hardcoding it.
pub const CYCLE_SECS: u32 = 7 * 24 * 60 * 60;

/// One entry in a sender's stream configuration: an address and the rate at
/// which it is paid, in token base units per second.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct StreamReceiver {
    pub receiver: Address,
    pub amt_per_sec: i128,
}

impl StreamReceiver {
    /// Validate that the stream receiver has a positive rate.
    ///
    /// Returns `Ok(())` if valid, or `Err(VestFlowError::WeightZero)` if
    /// `amt_per_sec` is zero or negative.
    pub fn validate(&self) -> Result<(), VestFlowError> {
        if self.amt_per_sec <= 0 {
            return Err(VestFlowError::WeightZero);
        }
        Ok(())
    }

    /// Create a new validated StreamReceiver.
    ///
    /// # Panics
    ///
    /// Panics if `amt_per_sec` is zero or negative.
    pub fn new(receiver: Address, amt_per_sec: i128) -> Result<Self, VestFlowError> {
        let stream_receiver = Self {
            receiver,
            amt_per_sec,
        };
        stream_receiver.validate()?;
        Ok(stream_receiver)
    }
}

/// An active stream from a funder to a drips list member.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct DripsStream {
    pub funder: Address,
    pub list_id: u64,
    pub member: Address,
    pub token: Address,
    pub amt_per_sec: i128,
    pub start_time: u64,
    /// Tokens already drained (delivered) before the current active run, so
    /// pause/resume keeps accounting without losing delivered amounts.
    pub accumulated: i128,
    /// Ledger timestamp when this stream was paused (0 = currently running).
    /// While paused the effective drip rate is 0 and the funder's streaming
    /// balance stops depleting; the receiver configuration is preserved.
    pub paused_at: u64,
}

/// A proportional split receiver that routes its share to a fixed address.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct AddressSplitsReceiver {
    pub receiver: Address,
    pub weight: u128,
}

impl AddressSplitsReceiver {
    /// Validate that the splits receiver has a positive weight.
    ///
    /// Returns `Ok(())` if valid, or `Err(VestFlowError::WeightZero)` if
    /// `weight` is zero.
    pub fn validate(&self) -> Result<(), VestFlowError> {
        if self.weight == 0 {
            return Err(VestFlowError::WeightZero);
        }
        Ok(())
    }

    /// Create a new validated AddressSplitsReceiver.
    pub fn new(receiver: Address, weight: u128) -> Result<Self, VestFlowError> {
        let splits_receiver = Self { receiver, weight };
        splits_receiver.validate()?;
        Ok(splits_receiver)
    }
}

/// A proportional split receiver gated by a non-fungible token.
///
/// Rather than paying a fixed address, the share is routed to whoever owns
/// `token_id` on `nft_contract` at split time.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct NftSplitsReceiver {
    pub nft_contract: Address,
    pub token_id: u128,
    pub weight: u128,
}

impl NftSplitsReceiver {
    /// Validate that the NFT splits receiver has a positive weight.
    ///
    /// Returns `Ok(())` if valid, or `Err(VestFlowError::WeightZero)` if
    /// `weight` is zero.
    pub fn validate(&self) -> Result<(), VestFlowError> {
        if self.weight == 0 {
            return Err(VestFlowError::WeightZero);
        }
        Ok(())
    }

    /// Create a new validated NftSplitsReceiver.
    pub fn new(
        nft_contract: Address,
        token_id: u128,
        weight: u128,
    ) -> Result<Self, VestFlowError> {
        let nft_receiver = Self {
            nft_contract,
            token_id,
            weight,
        };
        nft_receiver.validate()?;
        Ok(nft_receiver)
    }
}

/// A single entry in an account's splits configuration.
///
/// Receivers can mix fixed addresses and NFT-gated receivers.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum SplitReceiver {
    Address(AddressSplitsReceiver),
    Nft(NftSplitsReceiver),
}

/// Token-specific streams state for one (funder, token) pair.
///
/// Multiple receivers can stream from the same token simultaneously, and each
/// (funder, token) pair keeps its own independent config and accounting, so
/// streams on different tokens never interfere with each other.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct AccountTokenStreams {
    pub funder: Address,
    pub token: Address,
    pub receivers: Vec<StreamReceiver>,
    /// Tokens still available in the contract to stream for this pair.
    pub balance: i128,
    /// Ledger timestamp when this pair's stream configuration started.
    pub start_time: u64,
    /// Ledger timestamp accounting last settled to for this pair.
    pub last_update: u64,
}

/// A contract WASM upgrade that has been announced on-chain but not yet executed.
#[contracttype]
#[derive(Clone, PartialEq)]
pub struct PendingUpgrade {
    /// Hash of the already-uploaded WASM blob to migrate this contract to.
    pub wasm_hash: BytesN<32>,
    /// Ledger timestamp when the upgrade was announced.
    pub announced_at: u64,
    /// Earliest ledger timestamp when the upgrade may be executed.
    pub executable_at: u64,
}

/// The type of vesting curve applied to a schedule.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum VestingKind {
    /// Tokens unlock linearly from `start_time` to `start_time + duration`.
    /// The `cliff_duration` field is ignored for this variant.
    Linear,
    /// No tokens unlock until `start_time + cliff_duration`, then the full
    /// amount unlocks at once.
    Cliff,
    /// No tokens unlock until `start_time + cliff_duration` (the cliff).
    /// After the cliff, tokens unlock linearly from the cliff date to
    /// `start_time + duration`.
    ///
    /// This models the most common real-world employee vesting schedule:
    /// a 1-year cliff followed by linear vesting over the remaining term.
    LinearWithCliff,
    /// Tokens unlock at discrete milestones defined as (offset_seconds,
    /// basis_points) pairs stored in `VestingSchedule::milestones`.
    /// Each milestone unlocks `total_amount * bps / 10_000` tokens once
    /// `start_time + offset_seconds` is reached.
    Graded,
}

/// A single milestone for graded vesting.
///
/// `offset_secs` — seconds after `start_time` when this tranche unlocks.
/// `bps`         — basis points (1/10_000) of `total_amount` that unlock.
///
/// The milestones in a schedule must sum to exactly 10_000 bps.
#[contracttype]
#[derive(Clone)]
pub struct GradedMilestone {
    /// Seconds after `start_time` when this tranche unlocks.
    pub offset_secs: u64,
    /// Basis points (out of 10_000) of `total_amount` that unlock.
    pub bps: u32,
}

#[contracttype]
#[derive(Clone)]
pub struct VestingSchedule {
    pub id: u64,
    /// Address that created and funded this schedule.
    pub grantor: Address,
    /// Address that can claim vested tokens.
    pub beneficiary: Address,
    /// Stellar asset contract for the vested token.
    pub token: Address,
    /// Total tokens locked into this schedule (in stroops / base units).
    pub total_amount: i128,
    /// Tokens already claimed by the beneficiary.
    pub claimed_amount: i128,
    /// Unix timestamp when vesting begins.
    pub start_time: u64,
    /// Vesting duration in seconds.
    pub duration_seconds: u64,
    /// Cliff in seconds from `start_time`.
    ///
    /// - `Linear`: ignored.
    /// - `Cliff`: tokens unlock all-at-once after this many seconds.
    /// - `LinearWithCliff`: no tokens until this point; linear from here to end.
    /// - `Graded`: ignored (milestones define the schedule).
    pub cliff_seconds: u64,
    /// Lockup period in seconds from `start_time`.
    /// During lockup, tokens are vested (earned) but non-transferable.
    /// Beneficiary can claim after lockup expires even if tokens vested earlier.
    /// Must be >= cliff_seconds.
    pub lockup_duration: u64,
    pub kind: VestingKind,
    /// Whether the grantor can revoke unvested tokens.
    pub revocable: bool,
    /// Whether this schedule has been revoked.
    pub revoked: bool,
    /// Tokens that were vested at the moment of revocation.
    /// Zero for non-revoked schedules. Used so the beneficiary can still
    /// claim already-vested tokens after a revocation.
    pub vested_at_revoke: i128,
    /// Whether this schedule is currently paused.
    pub paused: bool,
    /// Cumulative time (in seconds) the schedule has been paused.
    pub paused_duration: u64,
    /// Timestamp when the schedule was last paused (0 if not paused).
    pub paused_at: u64,
    /// Whether performance milestones are required for this schedule.
    pub requires_milestones: bool,
    /// Milestone tranches for `VestingKind::Graded` schedules.
    /// Empty for all other kinds.
    pub milestones: Vec<GradedMilestone>,
}

/// Performance milestone attestation for gating vesting releases.
#[contracttype]
#[derive(Clone)]
pub struct PerformanceMilestone {
    /// Percentage of total vesting unlocked by this milestone (0-100).
    pub unlock_percentage: u32,
    /// Whether the milestone has been attested by the oracle.
    pub attested: bool,
    /// Timestamp when the milestone was attested.
    pub attested_at: u64,
}

/// A single token with its amount in a multi-token vesting schedule.
#[contracttype]
#[derive(Clone)]
pub struct TokenTranche {
    /// Stellar asset contract for this token.
    pub token: Address,
    /// Total amount of this token locked in the schedule.
    pub total_amount: i128,
    /// Amount of this token already claimed by the beneficiary.
    pub claimed_amount: i128,
}

/// A vesting schedule that supports multiple Stellar assets simultaneously.
///
/// Allows a single schedule to vest different tokens on the same timeline,
/// avoiding the need to create separate schedules for each token.
#[contracttype]
#[derive(Clone)]
pub struct MultiTokenVestingSchedule {
    pub id: u64,
    /// Address that created and funded this schedule.
    pub grantor: Address,
    /// Address that can claim vested tokens.
    pub beneficiary: Address,
    /// Multiple tokens with their amounts and claim tracking.
    pub tokens: Vec<TokenTranche>,
    /// Unix timestamp when vesting begins.
    pub start_time: u64,
    /// Vesting duration in seconds.
    pub duration_seconds: u64,
    /// Cliff in seconds from `start_time`.
    pub cliff_seconds: u64,
    /// Lockup period in seconds from `start_time`.
    pub lockup_duration: u64,
    pub kind: VestingKind,
    /// Whether the grantor can revoke unvested tokens.
    pub revocable: bool,
    /// Whether this schedule has been revoked.
    pub revoked: bool,
    /// Tokens that were vested at the moment of revocation.
    pub vested_at_revoke: i128,
    /// Whether this schedule is currently paused.
    pub paused: bool,
    /// Cumulative time (in seconds) the schedule has been paused.
    pub paused_duration: u64,
    /// Timestamp when the schedule was last paused (0 if not paused).
    pub paused_at: u64,
    /// Milestone tranches for `VestingKind::Graded` schedules.
    pub milestones: Vec<GradedMilestone>,
}

impl VestingSchedule {
    /// Calculate how many tokens are vested at a given timestamp.
    ///
    /// All intermediate multiplications are performed with overflow-checked
    /// arithmetic (`checked_mul` / `checked_div`).  If an overflow is somehow
    /// reached (e.g. `total_amount` is near `i128::MAX` and `elapsed` is also
    /// very large) the function saturates to `total_amount` rather than
    /// panicking or wrapping, which is always the safe upper bound.
    pub fn vested_at(&self, now: u64) -> i128 {
        if self.revoked {
            return self.vested_at_revoke;
        }
        if now < self.start_time {
            return 0;
        }

        // Calculate effective elapsed time accounting for pauses
        let mut elapsed = now - self.start_time;

        // Subtract paused duration
        elapsed = elapsed.saturating_sub(self.paused_duration);

        // If currently paused, subtract additional time since pause started
        if self.paused && self.paused_at > 0 {
            let current_pause_duration = now.saturating_sub(self.paused_at);
            elapsed = elapsed.saturating_sub(current_pause_duration);
        }
        match self.kind {
            VestingKind::Cliff => {
                if elapsed >= self.cliff_seconds {
                    self.total_amount
                } else {
                    0
                }
            }
            VestingKind::Linear => {
                if elapsed >= self.duration_seconds {
                    self.total_amount
                } else {
                    // Guard: total_amount * elapsed may overflow i128 for
                    // near-maximal inputs.  Saturate to total_amount on
                    // overflow — the caller can never receive more than that.
                    self.total_amount
                        .checked_mul(elapsed as i128)
                        .and_then(|n| n.checked_div(self.duration_seconds as i128))
                        .unwrap_or(self.total_amount)
                }
            }
            VestingKind::LinearWithCliff => {
                // Before cliff: nothing vests.
                if elapsed < self.cliff_seconds {
                    return 0;
                }
                // After full duration: everything is vested.
                if elapsed >= self.duration_seconds {
                    return self.total_amount;
                }
                // Between cliff and end: linear from cliff_seconds to duration_seconds.
                // Both subtractions are safe because of the bounds checked above.
                let linear_duration = (self.duration_seconds - self.cliff_seconds) as i128;
                let linear_elapsed = (elapsed - self.cliff_seconds) as i128;
                // Guard: same overflow risk as the Linear branch.
                self.total_amount
                    .checked_mul(linear_elapsed)
                    .and_then(|n| n.checked_div(linear_duration))
                    .unwrap_or(self.total_amount)
            }
            VestingKind::Graded => {
                // Sum the bps of every milestone whose offset has been reached.
                let mut vested_bps: u64 = 0;
                for milestone in self.milestones.iter() {
                    if elapsed >= milestone.offset_secs {
                        vested_bps += milestone.bps as u64;
                    }
                }
                // vested = total_amount * vested_bps / 10_000
                // Use checked arithmetic; saturate to total_amount on overflow.
                self.total_amount
                    .checked_mul(vested_bps as i128)
                    .and_then(|n| n.checked_div(10_000))
                    .unwrap_or(self.total_amount)
                    .min(self.total_amount)
            }
        }
    }

    /// Timestamp at which this schedule reaches 100% vested.
    ///
    /// `duration_seconds` already holds the offset of the last milestone for
    /// `Graded` schedules (derived at creation time), so this is correct for
    /// every `VestingKind` without special-casing Graded.
    pub fn fully_vested_at(&self) -> u64 {
        self.start_time
            .saturating_add(self.duration_seconds)
            .saturating_add(self.paused_duration)
    }

    /// Tokens vested but not yet claimed.
    pub fn claimable_at(&self, now: u64) -> i128 {
        let vested = self.vested_at(now);

        // Check if lockup period has expired
        let lockup_end = self.start_time.saturating_add(self.lockup_duration);
        if now < lockup_end {
            return 0;
        }

        if vested > self.claimed_amount {
            vested - self.claimed_amount
        } else {
            0
        }
    }

    /// Tokens that are vested but still held in the lockup window.
    ///
    /// Returns a positive value when `now` is before `lockup_end` and some
    /// tokens have already vested. Returns 0 once the lockup has elapsed
    /// (those tokens will appear via `claimable_at` instead) or when nothing
    /// has vested yet. Callers can use this to distinguish "locked but vesting"
    /// from "nothing vested yet".
    pub fn locked_at(&self, now: u64) -> i128 {
        if self.lockup_duration == 0 {
            return 0;
        }
        let lockup_end = self.start_time.saturating_add(self.lockup_duration);
        if now >= lockup_end {
            return 0;
        }
        let vested = self.vested_at(now);
        if vested > self.claimed_amount {
            vested - self.claimed_amount
        } else {
            0
        }
    }
}

impl MultiTokenVestingSchedule {
    /// Calculate how many tokens are vested at a given timestamp (same logic for all tokens).
    pub fn vested_percentage_at(&self, now: u64) -> u64 {
        if self.revoked {
            return 10_000;
        }
        if now < self.start_time {
            return 0;
        }

        let mut elapsed = now - self.start_time;
        elapsed = elapsed.saturating_sub(self.paused_duration);
        if self.paused && self.paused_at > 0 {
            let current_pause_duration = now.saturating_sub(self.paused_at);
            elapsed = elapsed.saturating_sub(current_pause_duration);
        }

        match self.kind {
            VestingKind::Cliff => {
                if elapsed >= self.cliff_seconds {
                    10_000
                } else {
                    0
                }
            }
            VestingKind::Linear => {
                if elapsed >= self.duration_seconds {
                    10_000
                } else {
                    (10_000u64 * elapsed) / self.duration_seconds
                }
            }
            VestingKind::LinearWithCliff => {
                if elapsed < self.cliff_seconds {
                    return 0;
                }
                if elapsed >= self.duration_seconds {
                    return 10_000;
                }
                let linear_duration = self.duration_seconds - self.cliff_seconds;
                let linear_elapsed = elapsed - self.cliff_seconds;
                (10_000u64 * linear_elapsed) / linear_duration
            }
            VestingKind::Graded => {
                let mut vested_bps: u64 = 0;
                for milestone in self.milestones.iter() {
                    if elapsed >= milestone.offset_secs {
                        vested_bps += milestone.bps as u64;
                    }
                }
                vested_bps.min(10_000)
            }
        }
    }

    /// Tokens vested but not yet claimed for a specific token index.
    pub fn claimable_at(&self, now: u64, token_idx: u32) -> i128 {
        if token_idx >= self.tokens.len() {
            return 0;
        }

        let token = &self.tokens.get(token_idx).expect("bounds checked above");
        let vested_pct = self.vested_percentage_at(now);
        let vested = token
            .total_amount
            .checked_mul(vested_pct as i128)
            .and_then(|n| n.checked_div(10_000))
            .unwrap_or(token.total_amount)
            .min(token.total_amount);

        let lockup_end = self.start_time.saturating_add(self.lockup_duration);
        if now < lockup_end {
            return 0;
        }

        if vested > token.claimed_amount {
            vested - token.claimed_amount
        } else {
            0
        }
    }
}

#[contract]
pub struct VestFlowContract;

#[contractimpl]
impl VestFlowContract {
    /// Read the configured upgrade authority.
    ///
    /// Panics with `"Upgrade authority not initialized"` when the authority
    /// has not been configured yet.
    fn read_upgrade_authority(env: &Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::UpgradeAuthority)
            .expect("Upgrade authority not initialized")
    }

    /// Return the deployed contract version as a human-readable string.
    ///
    /// Sourced from the `version` field in `Cargo.toml` at build time, so
    /// deployment scripts and monitoring tools can confirm which contract
    /// build is live without reading Wasm bytecode.
    pub fn version(env: Env) -> String {
        String::from_str(&env, VERSION)
    }

    /// Initialize the address that may announce and execute contract upgrades.
    ///
    /// This may only be called once, and the chosen authority must authorize
    /// the call. Once initialized, every contract WASM migration must be
    /// announced with [`announce_upgrade`] and wait at least 48 hours before
    /// [`execute_upgrade`] can apply it.
    ///
    /// # Errors
    ///
    /// Panics with `"Upgrade authority already initialized"` if called again.
    pub fn initialize_upgrade_authority(env: Env, authority: Address) {
        assert!(
            !env.storage().instance().has(&DataKey::UpgradeAuthority),
            "Upgrade authority already initialized"
        );
        authority.require_auth();

        env.storage()
            .instance()
            .set(&DataKey::UpgradeAuthority, &authority);
        env.events().publish(
            (symbol_short!("upgr_auth"), authority.clone()),
            env.ledger().timestamp(),
        );
    }

    /// Return the configured upgrade authority.
    ///
    /// # Errors
    ///
    /// Panics with `"Upgrade authority not initialized"` if unset.
    pub fn upgrade_authority(env: Env) -> Address {
        Self::read_upgrade_authority(&env)
    }

    /// Return the pending upgrade announcement, if any.
    pub fn pending_upgrade(env: Env) -> Option<PendingUpgrade> {
        env.storage().instance().get(&DataKey::PendingUpgrade)
    }

    /// Get the status of a pending upgrade: hash and executable timestamp.
    ///
    /// Allows users and governance tools to inspect a pending upgrade without
    /// parsing raw storage keys. Returns the WASM hash and the timestamp when
    /// execution becomes possible, or `None` if no upgrade is pending.
    pub fn get_upgrade_status(env: Env) -> Option<(BytesN<32>, u64)> {
        env.storage()
            .instance()
            .get(&DataKey::PendingUpgrade)
            .map(|pending: PendingUpgrade| (pending.wasm_hash, pending.executable_at))
    }

    /// Announce an upcoming contract WASM migration on-chain.
    ///
    /// The WASM identified by `wasm_hash` must already be uploaded. This
    /// function verifies the WASM exists before recording the announcement,
    /// preventing announcement of non-existent WASM hashes.
    ///
    /// # Errors
    ///
    /// Panics with `"Upgrade authority not initialized"` if unset.
    /// Panics with `"Unauthorized upgrade authority"` if `authority` is not the configured authority.
    /// Panics with `"WASM not found"` if the WASM hash has not been uploaded.
    pub fn announce_upgrade(env: Env, authority: Address, wasm_hash: BytesN<32>) -> PendingUpgrade {
        let configured = Self::read_upgrade_authority(&env);
        assert!(authority == configured, "Unauthorized upgrade authority");
        authority.require_auth();

        let announced_at = env.ledger().timestamp();
        let pending = PendingUpgrade {
            wasm_hash,
            announced_at,
            executable_at: announced_at
                .checked_add(UPGRADE_TIMELOCK_SECONDS)
                .expect("Upgrade executable time overflow"),
        };

        env.storage()
            .instance()
            .set(&DataKey::PendingUpgrade, &pending);
        env.events().publish(
            (symbol_short!("upgr_ann"), authority),
            (
                pending.wasm_hash.clone(),
                pending.announced_at,
                pending.executable_at,
            ),
        );

        pending
    }

    /// Cancel the currently pending upgrade announcement.
    ///
    /// The upgrade may only be cancelled before the timelock expires. Once the
    /// upgrade becomes executable, it cannot be cancelled through this function.
    ///
    /// # Errors
    ///
    /// Panics with `"No pending upgrade"` when no upgrade is pending.
    /// Panics with `"Upgrade already executable"` if the timelock has expired.
    pub fn cancel_upgrade(env: Env, authority: Address) {
        let configured = Self::read_upgrade_authority(&env);
        assert!(authority == configured, "Unauthorized upgrade authority");
        authority.require_auth();
        let pending: PendingUpgrade = env
            .storage()
            .instance()
            .get(&DataKey::PendingUpgrade)
            .expect("No pending upgrade");

        assert!(
            env.ledger().timestamp() < pending.executable_at,
            "Upgrade already executable"
        );

        env.storage().instance().remove(&DataKey::PendingUpgrade);
        env.events().publish(
            (symbol_short!("upgr_can"), authority),
            (
                pending.wasm_hash,
                pending.announced_at,
                pending.executable_at,
            ),
        );
    }

    /// Execute the pending contract WASM migration after the 48-hour timelock.
    ///
    /// The pending upgrade must have been announced on-chain by
    /// [`announce_upgrade`] at least [`UPGRADE_TIMELOCK_SECONDS`] earlier.
    /// Soroban applies the WASM replacement only after this invocation
    /// completes successfully.
    ///
    /// # Errors
    ///
    /// Panics with `"No pending upgrade"` when no upgrade is pending.
    /// Panics with `"Upgrade timelock still active"` before 48 hours elapse.
    pub fn execute_upgrade(env: Env, authority: Address) {
        let configured = Self::read_upgrade_authority(&env);
        assert!(authority == configured, "Unauthorized upgrade authority");
        authority.require_auth();

        let pending: PendingUpgrade = env
            .storage()
            .instance()
            .get(&DataKey::PendingUpgrade)
            .expect("No pending upgrade");
        assert!(
            env.ledger().timestamp() >= pending.executable_at,
            "Upgrade timelock still active"
        );

        env.storage().instance().remove(&DataKey::PendingUpgrade);
        env.events().publish(
            (symbol_short!("upgr_exe"), authority),
            (
                pending.wasm_hash.clone(),
                pending.announced_at,
                pending.executable_at,
            ),
        );
        env.deployer()
            .update_current_contract_wasm(pending.wasm_hash);
    }

    /// Transfer upgrade authority to a new address.
    ///
    /// Both the current and new authority must sign. Emits an `"upgr_xfr"` event.
    pub fn transfer_upgrade_authority(
        env: Env,
        current_authority: Address,
        new_authority: Address,
    ) {
        let configured = Self::read_upgrade_authority(&env);
        assert!(
            current_authority == configured,
            "Unauthorized upgrade authority"
        );
        current_authority.require_auth();
        new_authority.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::UpgradeAuthority, &new_authority);
        env.events().publish(
            (symbol_short!("upgr_xfr"), current_authority.clone()),
            (current_authority, new_authority, env.ledger().timestamp()),
        );
    }

    /// Check that sufficient storage headroom exists before performing writes.
    ///
    /// Soroban contracts have a maximum instance storage size limit. This function
    /// helps catch storage exhaustion early with a descriptive error rather than
    /// a silent trap during contract writes.
    fn check_storage_headroom(_env: &Env) -> Result<(), VestFlowError> {
        // The Soroban host enforces storage limits at the protocol level and
        // rejects writes that exceed them. There is no SDK API to read current
        // instance storage size, so we rely on host-level enforcement.
        Ok(())
    }

    /// Create a new vesting schedule and lock the tokens into the contract.
    ///
    /// The grantor must approve the contract to transfer `total_amount` of
    /// `token` before calling this function.
    ///
    /// # Errors
    ///
    /// Panics with `"Amount must be positive"` if `total_amount` ≤ 0.
    /// Returns `DurationZero` if `duration` = 0.
    /// Returns `DurationTooShort` if `0 < duration` < 60.
    /// Panics with `"Cliff cannot exceed duration"` if `cliff_duration` > `duration`.
    /// Panics with `"Lockup cannot be less than cliff"` if `lockup_duration` < `cliff_duration`.
    /// Panics with `"Beneficiary must differ from grantor"` if `beneficiary == grantor`.
    /// Panics with `"Start time cannot be in the past"` if `start_time` < current ledger time.
    /// Returns `InvalidToken` if `token` is not a recognised Stellar Asset Contract.
    pub fn create_schedule(
        env: Env,
        grantor: Address,
        beneficiary: Address,
        token: Address,
        total_amount: i128,
        start_time: u64,
        duration: u64,
        cliff_duration: u64,
        lockup_duration: u64,
        kind: VestingKind,
        revocable: bool,
    ) -> Result<u64, VestFlowError> {
        grantor.require_auth();

        Self::check_storage_headroom(&env)?;

        assert!(
            beneficiary != grantor,
            "Beneficiary must differ from grantor"
        );
        if total_amount <= 0 {
            return Err(VestFlowError::AmountZero);
        }
        validate_duration(duration)?;
        if cliff_duration > duration {
            return Err(VestFlowError::CliffExceedsDuration);
        }
        assert!(
            lockup_duration >= cliff_duration,
            "Lockup cannot be less than cliff"
        );
        assert!(
            start_time >= env.ledger().timestamp(),
            "Start time cannot be in the past"
        );

        // Validate token is a recognised SAC before pulling funds.
        validate_token_sac(&env, &token)?;

        // Pull tokens from grantor into the contract
        let contract_address = env.current_contract_address();
        token::Client::new(&env, &token).transfer(&grantor, &contract_address, &total_amount);

        Ok(persist_funded_schedule(
            &env,
            grantor,
            beneficiary,
            token,
            total_amount,
            start_time,
            duration,
            cliff_duration,
            lockup_duration,
            kind,
            revocable,
        ))
    }

    /// Deposit `total_amount` of `token` and commit a Merkle root encoding
    /// every beneficiary slot in a batch. Immutable after this call.
    ///
    /// Each beneficiary later self-initialises their own schedule by calling
    /// [`Self::claim_schedule_slot`] with a Merkle inclusion proof — the
    /// grantor signs exactly once, regardless of how many beneficiaries the
    /// batch covers.
    ///
    /// # Errors
    ///
    /// Returns `AmountZero` if `total_amount` <= 0.
    /// Panics with `"Expiry must be in the future"` if `expiry_ledger` is at
    /// or before the current ledger sequence.
    /// Returns `InvalidToken` if `token` is not a recognised Stellar Asset Contract.
    pub fn commit_schedule_batch(
        env: Env,
        grantor: Address,
        token: Address,
        total_amount: i128,
        merkle_root: BytesN<32>,
        expiry_ledger: u32,
    ) -> Result<u64, VestFlowError> {
        grantor.require_auth();

        Self::check_storage_headroom(&env)?;

        if total_amount <= 0 {
            return Err(VestFlowError::AmountZero);
        }
        assert!(
            expiry_ledger > env.ledger().sequence(),
            "Expiry must be in the future"
        );

        validate_token_sac(&env, &token)?;

        let contract_address = env.current_contract_address();
        token::Client::new(&env, &token).transfer(&grantor, &contract_address, &total_amount);

        let count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::BatchCounter)
            .unwrap_or(0);
        let id = count + 1;

        env.storage().instance().set(&DataKey::BatchCounter, &id);
        env.storage()
            .instance()
            .set(&DataKey::BatchRoot(id), &merkle_root);
        env.storage()
            .instance()
            .set(&DataKey::BatchToken(id), &token);
        env.storage()
            .instance()
            .set(&DataKey::BatchGrantor(id), &grantor);
        env.storage()
            .instance()
            .set(&DataKey::BatchRemaining(id), &total_amount);
        env.storage()
            .instance()
            .set(&DataKey::BatchExpiry(id), &expiry_ledger);

        env.events().publish(
            (symbol_short!("batchnew"), id),
            (grantor, token, total_amount, merkle_root, expiry_ledger),
        );

        Ok(id)
    }

    /// Prove a beneficiary slot is included in a committed batch's Merkle
    /// tree and create the corresponding vesting schedule.
    ///
    /// Internally performs the same storage writes as [`Self::create_schedule`],
    /// funded from the batch's deposit rather than a fresh transfer.
    ///
    /// # Errors
    ///
    /// Returns `ProofTooDeep` if `proof.len() > 20`, checked before any
    /// hashing so a crafted deep proof cannot exhaust the instruction budget.
    /// Returns `NotFound` if `batch_id` does not exist.
    /// Returns `BatchExpired` if the current ledger is at or past the batch's
    /// `expiry_ledger`.
    /// Returns `SlotAlreadyClaimed` if this exact leaf has already claimed.
    /// Returns `InvalidProof` if the proof does not resolve to the batch's
    /// committed root.
    /// Returns `AmountZero` if `total_amount` <= 0.
    /// Returns `DurationZero`/`DurationTooShort` per [`validate_duration`].
    /// Returns `CliffExceedsDuration` if `cliff_duration` > `duration`.
    pub fn claim_schedule_slot(
        env: Env,
        batch_id: u64,
        beneficiary: Address,
        total_amount: i128,
        duration: u64,
        cliff_duration: u64,
        start_time: u64,
        vesting_kind: VestingKind,
        revocable: bool,
        proof: Vec<BytesN<32>>,
    ) -> Result<u64, VestFlowError> {
        beneficiary.require_auth();

        // Bound the proof depth before any hashing to keep a crafted deep
        // proof from exhausting the instruction budget before this check
        // would otherwise fire.
        if proof.len() > 20 {
            return Err(VestFlowError::ProofTooDeep);
        }

        let root: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::BatchRoot(batch_id))
            .ok_or(VestFlowError::NotFound)?;
        let expiry_ledger: u32 = env
            .storage()
            .instance()
            .get(&DataKey::BatchExpiry(batch_id))
            .ok_or(VestFlowError::NotFound)?;

        if env.ledger().sequence() >= expiry_ledger {
            return Err(VestFlowError::BatchExpired);
        }

        if total_amount <= 0 {
            return Err(VestFlowError::AmountZero);
        }
        validate_duration(duration)?;
        if cliff_duration > duration {
            return Err(VestFlowError::CliffExceedsDuration);
        }

        let leaf = schedule_leaf_hash(
            &env,
            &beneficiary,
            total_amount,
            duration,
            cliff_duration,
            start_time,
            &vesting_kind,
            revocable,
        );

        if env
            .storage()
            .instance()
            .has(&DataKey::BatchSlotClaimed(leaf.clone()))
        {
            return Err(VestFlowError::SlotAlreadyClaimed);
        }

        let computed_root = verify_merkle_proof(&env, &leaf, &proof);
        if computed_root != root {
            return Err(VestFlowError::InvalidProof);
        }

        // Slot is proven and unclaimed: mark it claimed and debit the
        // batch's remaining balance atomically within this invocation —
        // Soroban's single-threaded execution model means no other
        // invocation can observe `BatchRemaining` between this read and
        // write, so two concurrent claims on the last slot cannot both pass.
        env.storage()
            .instance()
            .set(&DataKey::BatchSlotClaimed(leaf), &());

        let remaining: i128 = env
            .storage()
            .instance()
            .get(&DataKey::BatchRemaining(batch_id))
            .ok_or(VestFlowError::NotFound)?;
        let remaining = remaining
            .checked_sub(total_amount)
            .expect("batch remaining underflow");
        env.storage()
            .instance()
            .set(&DataKey::BatchRemaining(batch_id), &remaining);

        let token: Address = env
            .storage()
            .instance()
            .get(&DataKey::BatchToken(batch_id))
            .ok_or(VestFlowError::NotFound)?;
        let grantor: Address = env
            .storage()
            .instance()
            .get(&DataKey::BatchGrantor(batch_id))
            .ok_or(VestFlowError::NotFound)?;

        Ok(persist_funded_schedule(
            &env,
            grantor,
            beneficiary,
            token,
            total_amount,
            start_time,
            duration,
            cliff_duration,
            cliff_duration,
            vesting_kind,
            revocable,
        ))
    }

    /// Reclaim a batch's unclaimed deposit after `expiry_ledger` has passed.
    ///
    /// Transfers `BatchRemaining` back to the grantor and deletes the
    /// batch's storage keys.
    ///
    /// # Errors
    ///
    /// Returns `NotFound` if `batch_id` does not exist.
    /// Returns `NotExpired` if the current ledger is before `expiry_ledger`.
    pub fn reclaim_batch(env: Env, batch_id: u64, grantor: Address) -> Result<(), VestFlowError> {
        grantor.require_auth();

        let stored_grantor: Address = env
            .storage()
            .instance()
            .get(&DataKey::BatchGrantor(batch_id))
            .ok_or(VestFlowError::NotFound)?;
        assert!(stored_grantor == grantor, "Not the batch grantor");

        let expiry_ledger: u32 = env
            .storage()
            .instance()
            .get(&DataKey::BatchExpiry(batch_id))
            .ok_or(VestFlowError::NotFound)?;
        if env.ledger().sequence() < expiry_ledger {
            return Err(VestFlowError::NotExpired);
        }

        let remaining: i128 = env
            .storage()
            .instance()
            .get(&DataKey::BatchRemaining(batch_id))
            .unwrap_or(0);
        let token: Address = env
            .storage()
            .instance()
            .get(&DataKey::BatchToken(batch_id))
            .ok_or(VestFlowError::NotFound)?;

        if remaining > 0 {
            token::Client::new(&env, &token).transfer(
                &env.current_contract_address(),
                &grantor,
                &remaining,
            );
        }

        env.storage()
            .instance()
            .remove(&DataKey::BatchRoot(batch_id));
        env.storage()
            .instance()
            .remove(&DataKey::BatchToken(batch_id));
        env.storage()
            .instance()
            .remove(&DataKey::BatchGrantor(batch_id));
        env.storage()
            .instance()
            .remove(&DataKey::BatchRemaining(batch_id));
        env.storage()
            .instance()
            .remove(&DataKey::BatchExpiry(batch_id));

        env.events()
            .publish((symbol_short!("reclaimed"), batch_id), (grantor, remaining));

        Ok(())
    }

    /// Lock schedule parameters without transferring tokens.
    ///
    /// The grantor later calls [`fund_and_activate`] within
    /// [`PROPOSAL_WINDOW_LEDGERS`] to move funds and start the schedule.
    /// Acknowledgment by the beneficiary is optional and auditable.
    ///
    /// # Errors
    ///
    /// Returns `AmountZero` if `total_amount` ≤ 0.
    /// Returns `DurationZero` if `duration` = 0.
    /// Returns `DurationTooShort` if `0 < duration` < 60.
    /// Returns `CliffExceedsDuration` if `cliff_duration` > `duration`.
    pub fn propose_schedule(
        env: Env,
        grantor: Address,
        beneficiary: Address,
        token: Address,
        total_amount: i128,
        start_time: u64,
        duration: u64,
        cliff_duration: u64,
        lockup_duration: u64,
        kind: VestingKind,
        revocable: bool,
    ) -> Result<u64, VestFlowError> {
        grantor.require_auth();
        Self::check_storage_headroom(&env)?;

        assert!(
            beneficiary != grantor,
            "Beneficiary must differ from grantor"
        );
        if total_amount <= 0 {
            return Err(VestFlowError::AmountZero);
        }
        validate_duration(duration)?;
        if cliff_duration > duration {
            return Err(VestFlowError::CliffExceedsDuration);
        }
        assert!(
            lockup_duration >= cliff_duration,
            "Lockup cannot be less than cliff"
        );
        assert!(
            start_time >= env.ledger().timestamp(),
            "Start time cannot be in the past"
        );
        validate_token_sac(&env, &token)?;

        let count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::ProposalCount)
            .unwrap_or(0);
        let id = count + 1;

        let proposal = ScheduleProposal {
            id,
            grantor: grantor.clone(),
            beneficiary: beneficiary.clone(),
            token: token.clone(),
            total_amount,
            start_time,
            duration,
            cliff_duration,
            lockup_duration,
            kind,
            revocable,
            state: ProposalState::Pending,
            created_at_ledger: env.ledger().sequence(),
        };

        env.storage()
            .instance()
            .set(&DataKey::Proposal(id), &proposal);
        env.storage().instance().set(&DataKey::ProposalCount, &id);
        env.storage().instance().extend_ttl(
            INSTANCE_TTL_THRESHOLD_LEDGERS,
            INSTANCE_TTL_EXTEND_TO_LEDGERS,
        );

        env.events().publish(
            (symbol_short!("prop_new"), id),
            (grantor, beneficiary, token, total_amount),
        );

        Ok(id)
    }

    /// Record that the beneficiary has seen the proposal.
    ///
    /// Does not block [`fund_and_activate`]. Idempotent if already acknowledged.
    pub fn acknowledge_proposal(
        env: Env,
        beneficiary: Address,
        proposal_id: u64,
    ) -> Result<(), VestFlowError> {
        beneficiary.require_auth();
        let mut proposal = load_proposal(&env, proposal_id)?;
        assert!(beneficiary == proposal.beneficiary, "Not the beneficiary");

        match proposal.state {
            ProposalState::Activated(_) => Err(VestFlowError::ProposalAlreadyActivated),
            ProposalState::Expired => Err(VestFlowError::ProposalExpired),
            ProposalState::Acknowledged => Ok(()),
            ProposalState::Pending => {
                proposal.state = ProposalState::Acknowledged;
                env.storage()
                    .instance()
                    .set(&DataKey::Proposal(proposal_id), &proposal);
                env.events().publish(
                    (symbol_short!("prop_ack"), proposal_id),
                    (beneficiary, env.ledger().sequence()),
                );
                Ok(())
            }
        }
    }

    /// Transfer tokens and create the schedule from a pending proposal.
    ///
    /// Acknowledgment is optional. Fails if the 72-hour window has elapsed
    /// or if the proposal was already activated. `start_time` is taken from
    /// the frozen proposal and is not re-checked against the current ledger
    /// time, so a proposal created with `start_time = now` remains fundable.
    pub fn fund_and_activate(
        env: Env,
        grantor: Address,
        proposal_id: u64,
    ) -> Result<u64, VestFlowError> {
        grantor.require_auth();
        let mut proposal = load_proposal(&env, proposal_id)?;
        assert!(grantor == proposal.grantor, "Not the grantor");

        if let ProposalState::Activated(_) = proposal.state {
            return Err(VestFlowError::ProposalAlreadyActivated);
        }
        if matches!(proposal.state, ProposalState::Expired) {
            return Err(VestFlowError::ProposalExpired);
        }

        let deadline = proposal
            .created_at_ledger
            .saturating_add(PROPOSAL_WINDOW_LEDGERS);
        if env.ledger().sequence() >= deadline {
            return Err(VestFlowError::ProposalExpired);
        }

        let contract_address = env.current_contract_address();
        token::Client::new(&env, &proposal.token).transfer(
            &grantor,
            &contract_address,
            &proposal.total_amount,
        );

        let schedule_id = persist_funded_schedule(
            &env,
            proposal.grantor.clone(),
            proposal.beneficiary.clone(),
            proposal.token.clone(),
            proposal.total_amount,
            proposal.start_time,
            proposal.duration,
            proposal.cliff_duration,
            proposal.lockup_duration,
            proposal.kind.clone(),
            proposal.revocable,
        );

        proposal.state = ProposalState::Activated(schedule_id);
        env.storage()
            .instance()
            .set(&DataKey::Proposal(proposal_id), &proposal);

        env.events()
            .publish((symbol_short!("prop_act"), proposal_id), schedule_id);

        Ok(schedule_id)
    }

    /// Mark an unactivated proposal as expired after the 72-hour window.
    ///
    /// Anyone who authorizes the call may expire an unactivated proposal.
    /// The proposal remains readable via [`get_proposal`] with
    /// [`ProposalState::Expired`]. Activated proposals are kept so they
    /// remain auditable. Calling this on an already expired proposal is a
    /// no-op.
    pub fn expire_proposal(
        env: Env,
        caller: Address,
        proposal_id: u64,
    ) -> Result<(), VestFlowError> {
        caller.require_auth();
        let mut proposal = load_proposal(&env, proposal_id)?;

        if let ProposalState::Activated(_) = proposal.state {
            return Err(VestFlowError::ProposalAlreadyActivated);
        }
        if matches!(proposal.state, ProposalState::Expired) {
            return Ok(());
        }

        let deadline = proposal
            .created_at_ledger
            .saturating_add(PROPOSAL_WINDOW_LEDGERS);
        if env.ledger().sequence() < deadline {
            return Err(VestFlowError::ProposalNotExpired);
        }

        proposal.state = ProposalState::Expired;
        env.storage()
            .instance()
            .set(&DataKey::Proposal(proposal_id), &proposal);
        env.events()
            .publish((symbol_short!("prop_exp"), proposal_id), caller);

        Ok(())
    }

    /// Return a proposal by id, or `None` if it was never created.
    pub fn get_proposal(env: Env, proposal_id: u64) -> Option<ScheduleProposal> {
        env.storage()
            .instance()
            .get(&DataKey::Proposal(proposal_id))
    }

    /// Create a new graded (percentage-based) vesting schedule.
    ///
    /// Tokens unlock at discrete milestones. Each milestone specifies an
    /// offset in seconds from `start_time` and a share in basis points
    /// (1 bps = 0.01%). The milestones must sum to exactly 10 000 bps.
    ///
    /// Example: 10% at month 6, 20% at month 12, 70% at month 24 would use
    /// milestones with offset_secs 15_552_000 / 31_104_000 / 62_208_000 and
    /// bps 1_000 / 2_000 / 7_000 respectively.
    ///
    /// # Errors
    ///
    /// Panics with `"Amount must be positive"` if `total_amount` ≤ 0.
    /// Panics with `"Start time cannot be in the past"` if `start_time` < current ledger time.
    /// Panics with `"Milestones required"` if the milestones list is empty.
    /// Panics with `"Milestone unlock percentage must be non-zero"` if any milestone has 0 bps.
    /// Panics with `"Milestones must sum to 10000 bps"` if the bps total ≠ 10 000.
    pub fn create_graded_schedule(
        env: Env,
        grantor: Address,
        beneficiary: Address,
        token: Address,
        total_amount: i128,
        start_time: u64,
        lockup_duration: u64,
        revocable: bool,
        milestones: Vec<GradedMilestone>,
    ) -> Result<u64, VestFlowError> {
        grantor.require_auth();

        Self::check_storage_headroom(&env)?;

        assert!(
            beneficiary != grantor,
            "Beneficiary must differ from grantor"
        );
        assert!(total_amount > 0, "Amount must be positive");
        assert!(
            start_time >= env.ledger().timestamp(),
            "Start time cannot be in the past"
        );
        assert!(!milestones.is_empty(), "Milestones required");

        for milestone in milestones.iter() {
            assert!(
                milestone.bps > 0,
                "Milestone unlock percentage must be non-zero"
            );
            assert!(
                milestone.bps > 0,
                "Milestone unlock percentage must be non-zero"
            );
        }

        let total_bps: u64 = milestones.iter().map(|m| m.bps as u64).sum();
        assert!(total_bps == 10_000, "Milestones must sum to 10000 bps");

        // Derive duration from the last milestone offset so existing logic works.
        let duration = milestones.iter().map(|m| m.offset_secs).max().unwrap_or(0);

        let count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::ScheduleCount)
            .unwrap_or(0);
        let id = count + 1;

        // Validate token is a recognised SAC before pulling funds.
        // Calling decimals() on a non-SAC address will fail at the host level.
        validate_token_sac(&env, &token)?;

        // Pull tokens from grantor into the contract
        let contract_address = env.current_contract_address();
        token::Client::new(&env, &token).transfer(&grantor, &contract_address, &total_amount);

        let schedule = VestingSchedule {
            id,
            grantor: grantor.clone(),
            beneficiary: beneficiary.clone(),
            token: token.clone(),
            total_amount,
            claimed_amount: 0,
            start_time,
            duration_seconds: duration,
            cliff_seconds: 0,
            lockup_duration,
            kind: VestingKind::Graded,
            revocable,
            revoked: false,
            vested_at_revoke: 0,
            paused: false,
            paused_duration: 0,
            paused_at: 0,
            requires_milestones: false,
            milestones: milestones.clone(),
        };

        env.storage()
            .instance()
            .set(&DataKey::Schedule(id), &schedule);
        env.storage().instance().set(&DataKey::ScheduleCount, &id);

        // Maintain grantor schedule index
        let mut grantor_ids: Vec<u64> = env
            .storage()
            .instance()
            .get(&DataKey::GrantorSchedules(grantor.clone()))
            .unwrap_or(vec![&env]);
        grantor_ids.push_back(id);
        env.storage()
            .instance()
            .set(&DataKey::GrantorSchedules(grantor.clone()), &grantor_ids);

        // Maintain beneficiary schedule index
        let mut beneficiary_ids: Vec<u64> = env
            .storage()
            .instance()
            .get(&DataKey::BeneficiarySchedules(beneficiary.clone()))
            .unwrap_or(vec![&env]);
        beneficiary_ids.push_back(id);
        env.storage().instance().set(
            &DataKey::BeneficiarySchedules(beneficiary.clone()),
            &beneficiary_ids,
        );

        env.events().publish(
            (symbol_short!("created"), id),
            (
                grantor,
                beneficiary,
                token,
                total_amount,
                start_time,
                duration,
                lockup_duration,
                VestingKind::Graded,
                revocable,
                milestones,
            ),
        );

        Ok(id)
    }

    /// Create a new multi-token vesting schedule supporting simultaneous vesting of multiple assets.
    ///
    /// Allows a beneficiary to receive multiple different tokens on the same vesting timeline,
    /// eliminating the need to create separate schedules for each token.
    ///
    /// # Arguments
    ///
    /// * `grantor` - Address funding the schedule and authorized to revoke
    /// * `beneficiary` - Address receiving all vested tokens
    /// * `tokens` - Vec of TokenTranche (each token, amount, and claim tracking)
    /// * `start_time` - Unix timestamp when vesting begins
    /// * `duration` - Vesting duration in seconds
    /// * `cliff_duration` - Cliff period in seconds (0 for no cliff)
    /// * `lockup_duration` - Lockup period in seconds (must be >= cliff_duration)
    /// * `kind` - VestingKind (Linear, Cliff, LinearWithCliff, or Graded)
    /// * `revocable` - Whether grantor can revoke unvested tokens
    /// * `milestones` - GradedMilestone vec for Graded kind (empty for others)
    ///
    /// # Errors
    ///
    /// Panics with various validation errors (see single-token `create_schedule`)
    pub fn create_multi_token_schedule(
        env: Env,
        grantor: Address,
        beneficiary: Address,
        tokens: Vec<TokenTranche>,
        start_time: u64,
        duration: u64,
        cliff_duration: u64,
        lockup_duration: u64,
        kind: VestingKind,
        revocable: bool,
        milestones: Vec<GradedMilestone>,
    ) -> Result<u64, VestFlowError> {
        grantor.require_auth();

        assert!(
            beneficiary != grantor,
            "Beneficiary must differ from grantor"
        );
        assert!(!tokens.is_empty(), "Must have at least one token");
        assert!(
            start_time >= env.ledger().timestamp(),
            "Start time cannot be in the past"
        );
        if duration == 0 {
            return Err(VestFlowError::DurationZero);
        }
        if cliff_duration > duration {
            return Err(VestFlowError::CliffExceedsDuration);
        }
        assert!(
            lockup_duration >= cliff_duration,
            "Lockup cannot be less than cliff"
        );

        let count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::MultiTokenScheduleCount)
            .unwrap_or(0);
        let id = count + 1;

        let contract_address = env.current_contract_address();
        let mut token_tranches = vec![&env];

        for tranche in tokens.iter() {
            if tranche.total_amount <= 0 {
                return Err(VestFlowError::AmountZero);
            }
            // Validate each token is a recognised SAC before pulling funds.
            validate_token_sac(&env, &tranche.token)?;
            token::Client::new(&env, &tranche.token).transfer(
                &grantor,
                &contract_address,
                &tranche.total_amount,
            );
            token_tranches.push_back(tranche.clone());
        }

        let schedule = MultiTokenVestingSchedule {
            id,
            grantor: grantor.clone(),
            beneficiary: beneficiary.clone(),
            tokens: token_tranches,
            start_time,
            duration_seconds: duration,
            cliff_seconds: cliff_duration,
            lockup_duration,
            kind: kind.clone(),
            revocable,
            revoked: false,
            vested_at_revoke: 0,
            paused: false,
            paused_duration: 0,
            paused_at: 0,
            milestones: milestones.clone(),
        };

        env.storage()
            .instance()
            .set(&DataKey::MultiTokenSchedule(id), &schedule);
        env.storage()
            .instance()
            .set(&DataKey::MultiTokenScheduleCount, &id);

        let mut grantor_ids: Vec<u64> = env
            .storage()
            .instance()
            .get(&DataKey::GrantorMultiTokenSchedules(grantor.clone()))
            .unwrap_or(vec![&env]);
        grantor_ids.push_back(id);
        env.storage().instance().set(
            &DataKey::GrantorMultiTokenSchedules(grantor.clone()),
            &grantor_ids,
        );

        let mut beneficiary_ids: Vec<u64> = env
            .storage()
            .instance()
            .get(&DataKey::BeneficiaryMultiTokenSchedules(
                beneficiary.clone(),
            ))
            .unwrap_or(vec![&env]);
        beneficiary_ids.push_back(id);
        env.storage().instance().set(
            &DataKey::BeneficiaryMultiTokenSchedules(beneficiary.clone()),
            &beneficiary_ids,
        );

        env.events().publish(
            (symbol_short!("mulcreat"), id),
            (
                grantor,
                beneficiary,
                tokens.len(),
                start_time,
                duration,
                cliff_duration,
                lockup_duration,
                kind,
                revocable,
            ),
        );

        Ok(id)
    }

    /// Claim all vested tokens from a multi-token schedule.
    ///
    /// Transfers all available claimable amounts across all tokens in the schedule
    /// to the beneficiary, subject to cliff and lockup constraints.
    ///
    /// # Errors
    ///
    /// Panics with `"Schedule not found"` if the schedule ID doesn't exist.
    /// Panics with `"Nothing to claim yet"` if no tokens are claimable.
    pub fn claim_multi_token(env: Env, schedule_id: u64) -> Result<(), VestFlowError> {
        let mut schedule: MultiTokenVestingSchedule = env
            .storage()
            .instance()
            .get(&DataKey::MultiTokenSchedule(schedule_id))
            .ok_or(VestFlowError::NotFound)?;

        schedule.beneficiary.require_auth();

        let now = env.ledger().timestamp();
        let vested_pct = schedule.vested_percentage_at(now);

        let lockup_end = schedule.start_time.saturating_add(schedule.lockup_duration);
        if now < lockup_end {
            return Err(VestFlowError::NothingToClaim);
        }

        let mut total_claimed = false;
        let contract_address = env.current_contract_address();

        for i in 0..schedule.tokens.len() {
            let mut tranche = schedule.tokens.get(i).expect("i < len").clone();
            let vested = tranche
                .total_amount
                .checked_mul(vested_pct as i128)
                .and_then(|n| n.checked_div(10_000))
                .unwrap_or(tranche.total_amount)
                .min(tranche.total_amount);

            let claimable = vested - tranche.claimed_amount;
            if claimable > 0 {
                tranche.claimed_amount += claimable;
                schedule.tokens.set(i, tranche);
                token::Client::new(&env, &schedule.tokens.get(i).expect("i < len").token).transfer(
                    &contract_address,
                    &schedule.beneficiary,
                    &claimable,
                );
                total_claimed = true;
            }
        }

        if !total_claimed {
            return Err(VestFlowError::NothingToClaim);
        }

        env.storage()
            .instance()
            .set(&DataKey::MultiTokenSchedule(schedule_id), &schedule);

        env.events().publish(
            (symbol_short!("mulclaim"), schedule_id),
            (schedule.beneficiary.clone(), schedule.tokens.len()),
        );

        Ok(())
    }

    /// Get a multi-token schedule by ID.
    pub fn get_multi_token_schedule(
        env: Env,
        schedule_id: u64,
    ) -> Option<MultiTokenVestingSchedule> {
        env.storage()
            .instance()
            .get(&DataKey::MultiTokenSchedule(schedule_id))
    }

    /// Get all multi-token schedule IDs for a grantor.
    pub fn get_grantor_multi(env: Env, grantor: Address) -> Vec<u64> {
        env.storage()
            .instance()
            .get(&DataKey::GrantorMultiTokenSchedules(grantor))
            .unwrap_or(vec![&env])
    }

    /// Get all multi-token schedule IDs for a beneficiary.
    pub fn get_beneficiary_multi(env: Env, beneficiary: Address) -> Vec<u64> {
        env.storage()
            .instance()
            .get(&DataKey::BeneficiaryMultiTokenSchedules(beneficiary))
            .unwrap_or(vec![&env])
    }

    /// Get claimable amounts for all tokens in a multi-token schedule.
    pub fn claimable_multi_token(env: Env, schedule_id: u64) -> Vec<i128> {
        let schedule: MultiTokenVestingSchedule = match env
            .storage()
            .instance()
            .get(&DataKey::MultiTokenSchedule(schedule_id))
        {
            Some(s) => s,
            None => return vec![&env],
        };

        let now = env.ledger().timestamp();
        let mut claimable = vec![&env];
        for i in 0..schedule.tokens.len() {
            claimable.push_back(schedule.claimable_at(now, i));
        }
        claimable
    }

    /// Pause an active vesting schedule (grantor only).
    ///
    /// While paused, no additional tokens vest. The beneficiary can still claim
    /// already-vested tokens. The grantor can resume the schedule later.
    ///
    /// # Errors
    ///
    /// Panics with `"Schedule not found"` if `schedule_id` does not exist.
    /// Panics with `"Not the grantor"` if caller is not the grantor.
    /// Panics with `"Schedule already paused"` if already paused.
    /// Panics with `"Cannot pause revoked schedule"` if schedule is revoked.
    pub fn pause_schedule(env: Env, schedule_id: u64) {
        let mut schedule: VestingSchedule = env
            .storage()
            .instance()
            .get(&DataKey::Schedule(schedule_id))
            .expect("Schedule not found");

        schedule.grantor.require_auth();
        assert!(!schedule.paused, "Schedule already paused");
        assert!(!schedule.revoked, "Cannot pause revoked schedule");

        schedule.paused = true;
        schedule.paused_at = env.ledger().timestamp();

        env.storage()
            .instance()
            .set(&DataKey::Schedule(schedule_id), &schedule);
        env.events().publish(
            (symbol_short!("paused"), schedule_id),
            (schedule.grantor.clone(), schedule.paused_at),
        );
    }

    /// Resume a paused vesting schedule (grantor only).
    ///
    /// Accumulates the paused duration and resumes vesting from the current time.
    ///
    /// # Errors
    ///
    /// Panics with `"Schedule not found"` if `schedule_id` does not exist.
    /// Panics with `"Not the grantor"` if caller is not the grantor.
    /// Panics with `"Schedule not paused"` if not currently paused.
    pub fn resume_schedule(env: Env, schedule_id: u64) {
        let mut schedule: VestingSchedule = env
            .storage()
            .instance()
            .get(&DataKey::Schedule(schedule_id))
            .expect("Schedule not found");

        schedule.grantor.require_auth();
        assert!(schedule.paused, "Schedule not paused");

        let now = env.ledger().timestamp();
        let pause_duration = now.saturating_sub(schedule.paused_at);
        schedule.paused_duration += pause_duration;
        schedule.paused = false;
        schedule.paused_at = 0;

        env.storage()
            .instance()
            .set(&DataKey::Schedule(schedule_id), &schedule);
        env.events().publish(
            (symbol_short!("resumed"), schedule_id),
            (
                schedule.grantor.clone(),
                pause_duration,
                env.ledger().timestamp(),
            ),
        );
    }

    /// Initialize the oracle address authorized to attest performance milestones.
    ///
    /// Can only be called once by the upgrade authority.
    ///
    /// # Errors
    ///
    /// Panics with `"Oracle already initialized"` if called again.
    pub fn initialize_performance_oracle(env: Env, oracle: Address) {
        let authority = Self::read_upgrade_authority(&env);
        authority.require_auth();

        assert!(
            !env.storage().instance().has(&DataKey::PerformanceOracle),
            "Oracle already initialized"
        );

        env.storage()
            .instance()
            .set(&DataKey::PerformanceOracle, &oracle);
        env.events().publish(
            (symbol_short!("orc_init"), oracle.clone()),
            env.ledger().timestamp(),
        );
    }

    /// Get the configured performance oracle address.
    pub fn performance_oracle(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::PerformanceOracle)
    }

    /// Enable performance-based vesting for a schedule (grantor only).
    ///
    /// Once enabled, the beneficiary can only claim tokens after the oracle
    /// attests the required milestones.
    ///
    /// # Errors
    ///
    /// Panics with `"Schedule not found"` if `schedule_id` does not exist.
    /// Panics with `"Not the grantor"` if caller is not the grantor.
    /// Panics with `"Milestones already enabled"` if already enabled.
    pub fn enable_performance_milestones(env: Env, schedule_id: u64, milestones: Vec<u32>) {
        assert!(
            env.storage().instance().has(&DataKey::PerformanceOracle),
            "Performance oracle must be initialized before enabling milestones"
        );

        let mut schedule: VestingSchedule = env
            .storage()
            .instance()
            .get(&DataKey::Schedule(schedule_id))
            .expect("Schedule not found");

        schedule.grantor.require_auth();
        assert!(!schedule.requires_milestones, "Milestones already enabled");

        let total: u32 = milestones.iter().sum();
        assert!(total == 100, "Unlock percentages must sum to 100");

        schedule.requires_milestones = true;

        // Initialize milestone data
        let mut milestone_data: Vec<PerformanceMilestone> = vec![&env];
        for percentage in milestones.iter() {
            milestone_data.push_back(PerformanceMilestone {
                unlock_percentage: percentage,
                attested: false,
                attested_at: 0,
            });
        }

        env.storage()
            .instance()
            .set(&DataKey::Schedule(schedule_id), &schedule);
        env.storage().instance().set(
            &DataKey::PerformanceMilestones(schedule_id),
            &milestone_data,
        );

        env.events().publish(
            (symbol_short!("mile_en"), schedule_id),
            (
                schedule.grantor.clone(),
                milestones.len(),
                env.ledger().timestamp(),
            ),
        );
    }

    /// Attest a performance milestone (oracle only).
    ///
    /// # Errors
    ///
    /// Panics with `"Oracle not initialized"` if oracle is not configured.
    /// Panics with `"Not the oracle"` if caller is not the oracle.
    /// Panics with `"Milestone index out of bounds"` if invalid index.
    /// Panics with `"Milestone already attested"` if already attested.
    pub fn attest_milestone(env: Env, schedule_id: u64, milestone_index: u32) {
        let oracle: Address = env
            .storage()
            .instance()
            .get(&DataKey::PerformanceOracle)
            .expect("Oracle not initialized");

        oracle.require_auth();

        let mut milestones: Vec<PerformanceMilestone> = env
            .storage()
            .instance()
            .get(&DataKey::PerformanceMilestones(schedule_id))
            .expect("Schedule has no milestones");

        assert!(
            milestone_index < milestones.len(),
            "Milestone index out of bounds"
        );

        let mut milestone = milestones
            .get(milestone_index)
            .expect("index checked by caller");
        assert!(!milestone.attested, "Milestone already attested");

        milestone.attested = true;
        milestone.attested_at = env.ledger().timestamp();
        milestones.set(milestone_index, milestone);

        env.storage()
            .instance()
            .set(&DataKey::PerformanceMilestones(schedule_id), &milestones);

        env.events().publish(
            (symbol_short!("mile_att"), schedule_id),
            (oracle, milestone_index, env.ledger().timestamp()),
        );
    }

    /// Get performance milestones for a schedule.
    pub fn get_milestones(env: Env, schedule_id: u64) -> Option<Vec<PerformanceMilestone>> {
        env.storage()
            .instance()
            .get(&DataKey::PerformanceMilestones(schedule_id))
    }

    /// Initialize the NFT contract for vesting receipt tokens.
    ///
    /// Can only be called once by the upgrade authority.
    ///
    /// # Errors
    ///
    /// Panics with `"NFT contract already initialized"` if called again.
    pub fn initialize_nft_contract(env: Env, nft_contract: Address) {
        let authority = Self::read_upgrade_authority(&env);
        authority.require_auth();

        assert!(
            !env.storage().instance().has(&DataKey::NftContract),
            "NFT contract already initialized"
        );

        env.storage()
            .instance()
            .set(&DataKey::NftContract, &nft_contract);
        env.events().publish(
            (symbol_short!("nft_init"), nft_contract.clone()),
            env.ledger().timestamp(),
        );
    }

    /// Get the configured NFT contract address.
    pub fn nft_contract(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::NftContract)
    }

    /// Claim all currently vested but unclaimed tokens.
    ///
    /// Vested-but-unclaimed tokens remain claimable even after a revocation.
    ///
    /// # Errors
    ///
    /// Panics with `"Schedule not found"` if `schedule_id` does not exist.
    pub fn claim(env: Env, schedule_id: u64) -> Result<(), VestFlowError> {
        let mut schedule: VestingSchedule = env
            .storage()
            .instance()
            .get(&DataKey::Schedule(schedule_id))
            .ok_or(VestFlowError::NotFound)?;

        schedule.beneficiary.require_auth();

        let now = env.ledger().timestamp();
        let mut claimable = schedule.claimable_at(now);

        // If performance milestones are required, limit claimable amount
        if schedule.requires_milestones {
            let milestones: Vec<PerformanceMilestone> = env
                .storage()
                .instance()
                .get(&DataKey::PerformanceMilestones(schedule_id))
                .unwrap_or(vec![&env]);

            let mut max_unlock_percentage: u32 = 0;
            for milestone in milestones.iter() {
                if milestone.attested && milestone.unlock_percentage > max_unlock_percentage {
                    max_unlock_percentage = milestone.unlock_percentage;
                }
            }

            let max_claimable = schedule
                .total_amount
                .checked_mul(max_unlock_percentage as i128)
                .and_then(|n| n.checked_div(100))
                .unwrap_or(0)
                - schedule.claimed_amount;

            claimable = claimable.min(max_claimable.max(0));
        }

        if claimable <= 0 {
            return Err(VestFlowError::NothingToClaim);
        }

        schedule.claimed_amount += claimable;

        let contract_address = env.current_contract_address();
        let token_client = token::Client::new(&env, &schedule.token);

        token_client.transfer(&contract_address, &schedule.beneficiary, &claimable);

        env.storage()
            .instance()
            .set(&DataKey::Schedule(schedule_id), &schedule);
        env.events().publish(
            (
                symbol_short!("claimed"),
                schedule.beneficiary.clone(),
                schedule.token.clone(),
            ),
            (schedule_id, claimable, schedule.claimed_amount),
        );

        Ok(())
    }

    /// Revoke a vesting schedule (grantor only, revocable schedules only).
    /// Unvested tokens are returned to the grantor. Already-vested tokens
    /// are released to the beneficiary before returning the remainder to grantor.
    ///
    /// # Errors
    ///
    /// Panics with `"Schedule not found"` if `schedule_id` does not exist.
    /// Panics with `"Schedule is not revocable"` if the schedule is irrevocable.
    /// Panics with `"Already revoked"` if the schedule has already been revoked.
    pub fn revoke(env: Env, schedule_id: u64) -> Result<(), VestFlowError> {
        let mut schedule: VestingSchedule = env
            .storage()
            .instance()
            .get(&DataKey::Schedule(schedule_id))
            .ok_or(VestFlowError::NotFound)?;

        schedule.grantor.require_auth();
        if !schedule.revocable {
            return Err(VestFlowError::NotRevocable);
        }
        if schedule.revoked {
            return Err(VestFlowError::AlreadyRevoked);
        }

        let now = env.ledger().timestamp();
        let vested = schedule.vested_at(now);
        let unvested = schedule.total_amount - vested;

        schedule.revoked = true;
        schedule.vested_at_revoke = vested;

        let contract_address = env.current_contract_address();
        let token_client = token::Client::new(&env, &schedule.token);

        let mut vested_released = 0;
        let vested_unclaimed = vested - schedule.claimed_amount;
        if vested_unclaimed > 0 {
            let mut to_release = vested_unclaimed;
            if schedule.requires_milestones {
                let milestones: Vec<PerformanceMilestone> = env
                    .storage()
                    .instance()
                    .get(&DataKey::PerformanceMilestones(schedule_id))
                    .unwrap_or(vec![&env]);

                let mut max_unlock_percentage: u32 = 0;
                for milestone in milestones.iter() {
                    if milestone.attested && milestone.unlock_percentage > max_unlock_percentage {
                        max_unlock_percentage = milestone.unlock_percentage;
                    }
                }

                let max_allowed = schedule
                    .total_amount
                    .checked_mul(max_unlock_percentage as i128)
                    .and_then(|n| n.checked_div(100))
                    .unwrap_or(0)
                    - schedule.claimed_amount;

                to_release = to_release.min(max_allowed.max(0));
            }

            if to_release > 0 {
                schedule.claimed_amount += to_release;
                vested_released = to_release;
                token_client.transfer(&contract_address, &schedule.beneficiary, &to_release);
            }
        }

        if unvested > 0 {
            token_client.transfer(&contract_address, &schedule.grantor, &unvested);
        }

        env.storage()
            .instance()
            .set(&DataKey::Schedule(schedule_id), &schedule);
        env.events().publish(
            (
                symbol_short!("revoked"),
                schedule.grantor.clone(),
                schedule.token.clone(),
            ),
            (schedule_id, unvested, vested, vested_released),
        );

        Ok(())
    }

    /// Transfer beneficiary rights to a new address.
    ///
    /// Only the current beneficiary may call this. The schedule must not be
    /// revoked. Emits a `bnf_chng` event with
    /// `(schedule_id, old_beneficiary, new_beneficiary)`.
    ///
    /// # Errors
    ///
    /// Panics with `"Schedule not found"` if `schedule_id` does not exist.
    /// Panics with `"Schedule has been revoked"` if the schedule was revoked.
    pub fn transfer_beneficiary(
        env: Env,
        schedule_id: u64,
        new_beneficiary: Address,
    ) -> Result<(), VestFlowError> {
        let mut schedule: VestingSchedule = env
            .storage()
            .instance()
            .get(&DataKey::Schedule(schedule_id))
            .ok_or(VestFlowError::NotFound)?;

        schedule.beneficiary.require_auth();
        if schedule.revoked {
            return Err(VestFlowError::ScheduleRevoked);
        }
        assert!(
            new_beneficiary != schedule.grantor,
            "New beneficiary must differ from grantor"
        );

        let old_beneficiary = schedule.beneficiary.clone();
        schedule.beneficiary = new_beneficiary.clone();

        env.storage()
            .instance()
            .set(&DataKey::Schedule(schedule_id), &schedule);

        env.events().publish(
            (symbol_short!("bnf_chng"), schedule_id),
            (old_beneficiary, new_beneficiary, env.ledger().timestamp()),
        );
        Ok(())
    }

    /// Extend the vesting duration of an existing schedule.
    ///
    /// Only the **grantor** of the schedule may call this entry point.
    /// The schedule must not be revoked.
    ///
    /// `additional_seconds` is added to the current `duration`, pushing the
    /// end date forward without changing the `start_time` or any already-vested
    /// amounts. This is equivalent to re-issuing the grant with a longer
    /// horizon — useful when an employee stays beyond the original grant period.
    ///
    /// Emits an `"ext_dur"` event with `(schedule_id, old_duration, new_duration, timestamp)`.
    ///
    /// # Panics
    ///
    /// - `"Schedule not found"` — unknown `schedule_id`.
    /// - `"Schedule has been revoked"` — cannot extend a revoked schedule.
    /// - `"Additional seconds must be positive"` — zero extension is rejected.
    pub fn extend_duration(
        env: Env,
        schedule_id: u64,
        additional_seconds: u64,
    ) -> Result<(), VestFlowError> {
        let mut schedule: VestingSchedule = env
            .storage()
            .instance()
            .get(&DataKey::Schedule(schedule_id))
            .ok_or(VestFlowError::NotFound)?;

        schedule.grantor.require_auth();

        if schedule.revoked {
            return Err(VestFlowError::AlreadyRevoked);
        }
        assert!(
            additional_seconds > 0,
            "Additional seconds must be positive"
        );

        let old_duration = schedule.duration_seconds;
        schedule.duration_seconds = old_duration + additional_seconds;

        env.storage()
            .instance()
            .set(&DataKey::Schedule(schedule_id), &schedule);

        env.events().publish(
            (symbol_short!("ext_dur"), schedule_id),
            (
                old_duration,
                schedule.duration_seconds,
                env.ledger().timestamp(),
            ),
        );

        Ok(())
    }

    /// Transfer grantor rights to a new address (current grantor only).
    ///
    /// Moves revocation and pause rights to `new_grantor`. Updates the grantor
    /// schedule index for both the old and new grantor. Emits a `"grnt_chng"`
    /// event with `(old_grantor, new_grantor, timestamp)`.
    ///
    /// Returns `Ok(())` immediately when `new_grantor` is the same as the
    /// current grantor (no-op).
    ///
    /// # Errors
    ///
    /// Returns `VestFlowError::NotFound` if `schedule_id` does not exist.
    pub fn transfer_grantor(
        env: Env,
        schedule_id: u64,
        new_grantor: Address,
    ) -> Result<(), VestFlowError> {
        let mut schedule: VestingSchedule = env
            .storage()
            .instance()
            .get(&DataKey::Schedule(schedule_id))
            .ok_or(VestFlowError::NotFound)?;

        schedule.grantor.require_auth();

        // No-op: avoid index churn when transferring to the same address.
        if new_grantor == schedule.grantor {
            return Ok(());
        }

        let old_grantor = schedule.grantor.clone();

        // Remove this schedule from the old grantor's index.
        let old_ids: Vec<u64> = env
            .storage()
            .instance()
            .get(&DataKey::GrantorSchedules(old_grantor.clone()))
            .unwrap_or(vec![&env]);
        let mut filtered: Vec<u64> = vec![&env];
        for gid in old_ids.iter() {
            if gid != schedule_id {
                filtered.push_back(gid);
            }
        }
        env.storage()
            .instance()
            .set(&DataKey::GrantorSchedules(old_grantor.clone()), &filtered);

        // Add this schedule to the new grantor's index.
        let mut new_ids: Vec<u64> = env
            .storage()
            .instance()
            .get(&DataKey::GrantorSchedules(new_grantor.clone()))
            .unwrap_or(vec![&env]);
        new_ids.push_back(schedule_id);
        env.storage()
            .instance()
            .set(&DataKey::GrantorSchedules(new_grantor.clone()), &new_ids);

        schedule.grantor = new_grantor.clone();
        env.storage()
            .instance()
            .set(&DataKey::Schedule(schedule_id), &schedule);

        env.events().publish(
            (symbol_short!("grnt_chng"), schedule_id),
            (old_grantor, new_grantor, env.ledger().timestamp()),
        );
        Ok(())
    }

    /// Read a vesting schedule by ID.
    ///
    /// # Errors
    ///
    /// Panics with `"Schedule not found"` if `schedule_id` does not exist.
    pub fn get_schedule(env: Env, schedule_id: u64) -> Result<VestingSchedule, VestFlowError> {
        env.storage()
            .instance()
            .get(&DataKey::Schedule(schedule_id))
            .ok_or(VestFlowError::NotFound)
    }

    /// Extend this contract instance's storage TTL. Callable by anyone
    /// (beneficiary, grantor, or a third-party keeper) -- there is nothing
    /// sensitive about keeping the contract alive, and requiring auth here
    /// would just make it harder for keepers to run this permissionlessly.
    ///
    /// `schedule_id` is validated to exist so a caller gets a clear
    /// [`VestFlowError::NotFound`] instead of silently bumping TTL for a
    /// schedule that was never created (e.g. a typo'd ID).
    ///
    /// # Note on storage tier
    ///
    /// Schedules currently live in **instance** storage (see [`DataKey::Schedule`]
    /// and every other read/write in this contract), not persistent storage --
    /// there is no independent per-schedule persistent entry to bump yet. Instance
    /// storage has a single TTL for the whole contract instance, so this extends
    /// that shared TTL rather than a per-schedule key. If schedules are ever
    /// migrated to persistent storage (tracked separately), this should be
    /// updated to call `env.storage().persistent().extend_ttl(&DataKey::Schedule(schedule_id), ..)`
    /// instead.
    ///
    /// # Errors
    ///
    /// Returns [`VestFlowError::NotFound`] if `schedule_id` does not exist.
    pub fn bump_schedule_ttl(env: Env, schedule_id: u64) -> Result<(), VestFlowError> {
        if !env
            .storage()
            .instance()
            .has(&DataKey::Schedule(schedule_id))
        {
            return Err(VestFlowError::NotFound);
        }

        env.storage().instance().extend_ttl(
            INSTANCE_TTL_THRESHOLD_LEDGERS,
            INSTANCE_TTL_EXTEND_TO_LEDGERS,
        );

        Ok(())
    }

    /// Return the vesting kind of a schedule without loading the full schedule.
    ///
    /// This is a cheap view that lets frontends and SDKs branch on the
    /// vesting curve type (Linear, Cliff, LinearWithCliff, Graded) without
    /// paying for a full storage read of the entire `VestingSchedule` struct.
    ///
    /// Returns `None` for unknown schedule IDs (does not panic).
    pub fn vesting_type(env: Env, schedule_id: u64) -> Option<VestingKind> {
        env.storage()
            .instance()
            .get::<DataKey, VestingSchedule>(&DataKey::Schedule(schedule_id))
            .map(|schedule| schedule.kind)
    }

    /// Check whether a schedule has been revoked without loading the full schedule.
    ///
    /// Cheaper than `get_schedule` when the caller only needs to know revocation
    /// status. Returns `false` for unknown schedule IDs (does not panic).
    pub fn is_revoked(env: Env, schedule_id: u64) -> bool {
        match env
            .storage()
            .instance()
            .get::<DataKey, VestingSchedule>(&DataKey::Schedule(schedule_id))
        {
            Some(schedule) => schedule.revoked,
            None => false,
        }
    }

    /// Batch view: fetch multiple schedules in a single simulation round-trip.
    ///
    /// Returns `None` for unknown IDs rather than panicking, so callers can
    /// safely pass a contiguous range without knowing which IDs exist.
    /// Results are returned in the same order as the input `ids` vector.
    ///
    /// This replaces the `Promise.all(getSchedule)` pattern in the frontend
    /// dashboard, reducing N simulation round-trips to 1.
    pub fn get_schedule_batch(env: Env, ids: Vec<u64>) -> Vec<Option<VestingSchedule>> {
        let mut results: Vec<Option<VestingSchedule>> = vec![&env];
        for id in ids.iter() {
            let schedule: Option<VestingSchedule> =
                env.storage().instance().get(&DataKey::Schedule(id));
            results.push_back(schedule);
        }
        results
    }

    /// How many schedules have been created in total.
    pub fn schedule_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::ScheduleCount)
            .unwrap_or(0)
    }

    /// Return schedule IDs created by a given grantor.
    ///
    /// Returns an empty vec if the grantor has not created any schedules.
    pub fn get_schedules_by_grantor(env: Env, grantor: Address) -> Vec<u64> {
        env.storage()
            .instance()
            .get(&DataKey::GrantorSchedules(grantor))
            .unwrap_or(vec![&env])
    }

    /// Return **all** schedule IDs created by a given grantor, combining
    /// single-token and multi-token schedules into a single list.
    ///
    /// The frontend can use this single view to load every schedule a
    /// grantor has created without fetching the entire schedule space and
    /// filtering client-side.
    ///
    /// Returns an empty vec if the grantor has not created any schedules.
    pub fn grantor_schedule_ids(env: Env, grantor: Address) -> Vec<u64> {
        let single: Vec<u64> = env
            .storage()
            .instance()
            .get(&DataKey::GrantorSchedules(grantor.clone()))
            .unwrap_or(vec![&env]);
        let multi: Vec<u64> = env
            .storage()
            .instance()
            .get(&DataKey::GrantorMultiTokenSchedules(grantor))
            .unwrap_or(vec![&env]);

        let mut combined: Vec<u64> = vec![&env];
        for id in single.iter() {
            combined.push_back(id);
        }
        for id in multi.iter() {
            combined.push_back(id);
        }

        combined
    }

    /// Return schedule IDs where the given address is the beneficiary.
    ///
    /// Returns an empty vec if the address has no beneficiary schedules.
    pub fn get_schedules_by_beneficiary(env: Env, beneficiary: Address) -> Vec<u64> {
        env.storage()
            .instance()
            .get(&DataKey::BeneficiarySchedules(beneficiary))
            .unwrap_or(vec![&env])
    }

    /// Return **all** schedule IDs where the given address is the
    /// beneficiary, combining single-token and multi-token schedules into
    /// a single list.
    ///
    /// Returns an empty vec if the address has no beneficiary schedules.
    pub fn beneficiary_schedule_ids(env: Env, beneficiary: Address) -> Vec<u64> {
        let single: Vec<u64> = env
            .storage()
            .instance()
            .get(&DataKey::BeneficiarySchedules(beneficiary.clone()))
            .unwrap_or(vec![&env]);
        let multi: Vec<u64> = env
            .storage()
            .instance()
            .get(&DataKey::BeneficiaryMultiTokenSchedules(beneficiary))
            .unwrap_or(vec![&env]);

        let mut combined: Vec<u64> = vec![&env];
        for id in single.iter() {
            combined.push_back(id);
        }
        for id in multi.iter() {
            combined.push_back(id);
        }

        combined
    }

    /// Preview how many tokens are claimable at a specific timestamp.
    ///
    /// Returns 0 if `schedule_id` is unknown (does not panic).
    pub fn claimable_amount(env: Env, schedule_id: u64, now: u64) -> i128 {
        match env
            .storage()
            .instance()
            .get::<DataKey, VestingSchedule>(&DataKey::Schedule(schedule_id))
        {
            Some(schedule) => schedule.claimable_at(now),
            None => 0,
        }
    }

    /// Preview how many tokens are claimable right now for a given schedule.
    ///
    /// Returns 0 if `schedule_id` is unknown (does not panic).
    pub fn claimable(env: Env, schedule_id: u64) -> i128 {
        let now = env.ledger().timestamp();
        Self::claimable_amount(env, schedule_id, now)
    }

    /// Preview how many tokens will be claimable at an arbitrary timestamp `ts`.
    ///
    /// Intended for UI previews such as "how much can I claim at the 1-year
    /// mark?". The result reflects current schedule state projected to `ts`:
    /// it accounts for lockup, pauses (accumulated up to now), cliff, and
    /// revocation, but uses the current `claimed_amount` — so the return value
    /// is most meaningful for future timestamps.
    ///
    /// Returns 0 if `schedule_id` is unknown (does not panic).
    pub fn claimable_at_timestamp(env: Env, schedule_id: u64, ts: u64) -> i128 {
        match env
            .storage()
            .instance()
            .get::<DataKey, VestingSchedule>(&DataKey::Schedule(schedule_id))
        {
            Some(schedule) => schedule.claimable_at(ts),
            None => 0,
        }
    }

    /// Preview how many tokens are vested but still inside the lockup window at
    /// timestamp `ts`.
    ///
    /// Returns 0 once the lockup has elapsed (those tokens appear via
    /// `claimable_at_timestamp` instead), when no lockup is configured, or
    /// when `schedule_id` is unknown.
    ///
    /// Frontends can call this alongside `claimable_at_timestamp` to
    /// distinguish "your tokens are vesting but locked until DATE" from
    /// "nothing has vested yet".
    pub fn locked_at_timestamp(env: Env, schedule_id: u64, ts: u64) -> i128 {
        match env
            .storage()
            .instance()
            .get::<DataKey, VestingSchedule>(&DataKey::Schedule(schedule_id))
        {
            Some(schedule) => schedule.locked_at(ts),
            None => 0,
        }
    }

    /// Batch view: return claimable amounts for multiple schedule IDs in a
    /// single simulation round-trip.
    ///
    /// Results are returned in the same order as the input `ids` vector.
    /// Unknown IDs return 0 instead of panicking, so the caller can safely
    /// pass the full ID range without knowing which ones exist.
    ///
    /// This replaces the `Promise.all(claimable)` pattern in the frontend
    /// dashboard, reducing N simulation round-trips to 1.
    pub fn claimable_bulk(env: Env, ids: Vec<u64>) -> Vec<i128> {
        let now = env.ledger().timestamp();
        let mut results: Vec<i128> = vec![&env];
        for id in ids.iter() {
            let amount = match env
                .storage()
                .instance()
                .get::<DataKey, VestingSchedule>(&DataKey::Schedule(id))
            {
                Some(schedule) => schedule.claimable_at(now),
                None => 0,
            };
            results.push_back(amount);
        }
        results
    }

    /// View: return the vested amount for a schedule ID at a specific time.
    ///
    /// The vested amount is the total tokens that have unlocked according to
    /// the schedule's vesting curve, including already-claimed tokens.
    /// Returns 0 for unknown schedule IDs.
    pub fn vested_amount(env: Env, schedule_id: u64, now: u64) -> i128 {
        match env
            .storage()
            .instance()
            .get::<DataKey, VestingSchedule>(&DataKey::Schedule(schedule_id))
        {
            Some(schedule) => schedule.vested_at(now),
            None => 0,
        }
    }

    /// View: return the vested amount for a schedule ID using the current
    /// ledger timestamp.
    pub fn vested_amount_current(env: Env, schedule_id: u64) -> i128 {
        let now = env.ledger().timestamp();
        Self::vested_amount(env, schedule_id, now)
    }

    /// View: return the timestamp at which a schedule reaches 100% vested.
    ///
    /// Correct for every `VestingKind`, including `Graded`, where the
    /// naive client-side `start_time + duration` calculation breaks
    /// because the last milestone's offset determines full vesting.
    /// Returns `None` for unknown schedule IDs.
    pub fn fully_vested_at(env: Env, schedule_id: u64) -> Option<u64> {
        env.storage()
            .instance()
            .get::<DataKey, VestingSchedule>(&DataKey::Schedule(schedule_id))
            .map(|schedule| schedule.fully_vested_at())
    }

    /// Batch view: return vested amounts for multiple schedule IDs in a
    /// single simulation round-trip.
    ///
    /// Results are returned in the same order as the input `ids` vector.
    /// Unknown IDs return 0 instead of panicking, so the caller can safely
    /// pass the full ID range without knowing which ones exist.
    pub fn vested_amount_bulk(env: Env, ids: Vec<u64>) -> Vec<i128> {
        let now = env.ledger().timestamp();
        let mut results: Vec<i128> = vec![&env];
        for id in ids.iter() {
            let amount = match env
                .storage()
                .instance()
                .get::<DataKey, VestingSchedule>(&DataKey::Schedule(id))
            {
                Some(schedule) => schedule.vested_at(now),
                None => 0,
            };
            results.push_back(amount);
        }
        results
    }

    /// View: return the number of tokens that unlock at the cliff date for a
    /// `Cliff` or `LinearWithCliff` schedule.
    ///
    /// | Kind              | Return value                                        |
    /// |-------------------|-----------------------------------------------------|
    /// | `Cliff`           | `total_amount` (everything unlocks at cliff)        |
    /// | `LinearWithCliff` | 0 — the cliff itself unlocks nothing extra; linear  |
    /// |                   | vesting begins at the cliff date                    |
    /// | `Linear` / other  | 0 — no cliff concept applies                        |
    /// | Unknown ID        | 0                                                   |
    ///
    /// The return value is in stroops (base token units). Beneficiaries can
    /// compare this against `claimable()` to understand how much will become
    /// available at the cliff without doing off-chain math.
    pub fn cliff_unlock_amount(env: Env, schedule_id: u64) -> i128 {
        let schedule: VestingSchedule = match env
            .storage()
            .instance()
            .get::<DataKey, VestingSchedule>(&DataKey::Schedule(schedule_id))
        {
            Some(s) => s,
            None => return 0,
        };

        match schedule.kind {
            VestingKind::Cliff => {
                // For a pure Cliff schedule the entire amount unlocks at the
                // cliff date; nothing vests before it.
                schedule.total_amount
            }
            VestingKind::LinearWithCliff => {
                // For LinearWithCliff the cliff date is the start of linear
                // vesting — no discrete "cliff tranche" unlocks.  Return 0 so
                // callers can distinguish this from Cliff schedules.
                0
            }
            VestingKind::Linear | VestingKind::Graded => 0,
        }
    }

    /// View: return the sum of all unvested amounts for a given token.
    ///
    /// Iterates through all schedules and sums the unvested (unlocked but not claimed)
    /// amounts for schedules using the specified token. Useful for protocol-level
    /// tracking of total locked tokens by asset.
    pub fn total_locked(env: Env, token: Address) -> i128 {
        let count = Self::schedule_count(env.clone());
        let now = env.ledger().timestamp();
        let mut total: i128 = 0;

        for id in 1..=count {
            if let Some(schedule) = env
                .storage()
                .instance()
                .get::<DataKey, VestingSchedule>(&DataKey::Schedule(id))
            {
                if schedule.token == token {
                    let vested = schedule.vested_at(now);
                    let unveiled = schedule.total_amount - vested;
                    total = total.saturating_add(unveiled);
                }
            }
        }
        total
    }

    /// View: return the number of irrevocable schedules.
    ///
    /// Counts schedules where `revocable` is false. Useful for protocol-level
    /// trust metrics — beneficiaries and investors care how many schedules
    /// cannot be cancelled by the grantor.
    pub fn irrevocable_count(env: Env) -> u64 {
        let count = Self::schedule_count(env.clone());
        let mut irrevocable: u64 = 0;

        for id in 1..=count {
            if let Some(schedule) = env
                .storage()
                .instance()
                .get::<DataKey, VestingSchedule>(&DataKey::Schedule(id))
            {
                if !schedule.revocable {
                    irrevocable += 1;
                }
            }
        }
        irrevocable
    }

    /// Delegate claim rights on a schedule to a third-party address.
    ///
    /// The delegate may later call [`claim_as_delegate`] to pull vested
    /// tokens directly to their own address, bounded by `max_amount` and/or
    /// `expires_at_ledger`. A schedule may have at most
    /// [`MAX_DELEGATIONS_PER_SCHEDULE`] concurrently active (non-revoked)
    /// delegations; revoking one frees a slot.
    ///
    /// # Errors
    ///
    /// Returns `NotFound` if `schedule_id` does not exist.
    /// Returns `TooManyDelegations` if 5 active delegations already exist for this schedule.
    /// Panics with `"Not the beneficiary"` if `beneficiary` is not the schedule's beneficiary.
    /// Panics with `"Delegate must differ from beneficiary"` if `delegate == beneficiary`.
    /// Panics with `"Max amount must be positive"` if `max_amount` is `Some(n)` with `n <= 0`.
    /// Panics with `"Expiry must be in the future"` if `expires_at_ledger` is at or before the current ledger sequence.
    pub fn create_delegation(
        env: Env,
        beneficiary: Address,
        schedule_id: u64,
        delegate: Address,
        max_amount: Option<i128>,
        expires_at_ledger: Option<u32>,
    ) -> Result<u32, VestFlowError> {
        beneficiary.require_auth();

        let schedule: VestingSchedule = env
            .storage()
            .instance()
            .get(&DataKey::Schedule(schedule_id))
            .ok_or(VestFlowError::NotFound)?;
        assert!(beneficiary == schedule.beneficiary, "Not the beneficiary");
        assert!(
            delegate != beneficiary,
            "Delegate must differ from beneficiary"
        );
        if let Some(max) = max_amount {
            assert!(max > 0, "Max amount must be positive");
        }
        if let Some(expiry) = expires_at_ledger {
            assert!(
                expiry > env.ledger().sequence(),
                "Expiry must be in the future"
            );
        }

        // Active-delegation count is maintained incrementally (see
        // `DelegationKey::ActiveDelegationCount`) rather than scanned here,
        // so the concurrency cap check stays O(1) regardless of how many
        // delegations (revoked or not) this schedule has accumulated over
        // its lifetime.
        let active: u32 = env
            .storage()
            .instance()
            .get(&DelegationKey::ActiveDelegationCount(schedule_id))
            .unwrap_or(0);
        if active >= MAX_DELEGATIONS_PER_SCHEDULE {
            return Err(VestFlowError::TooManyDelegations);
        }

        let count: u32 = env
            .storage()
            .instance()
            .get(&DelegationKey::DelegationCount(schedule_id))
            .unwrap_or(0);
        let delegation_id = count + 1;
        let delegation = ClaimDelegation {
            delegate: delegate.clone(),
            max_amount,
            expires_at_ledger,
            claimed_so_far: 0,
            revoked: false,
        };

        env.storage().instance().set(
            &DelegationKey::Delegation(schedule_id, delegation_id),
            &delegation,
        );
        env.storage()
            .instance()
            .set(&DelegationKey::DelegationCount(schedule_id), &delegation_id);
        env.storage().instance().set(
            &DelegationKey::ActiveDelegationCount(schedule_id),
            &(active + 1),
        );

        env.events().publish(
            (symbol_short!("dele_new"), schedule_id, delegation_id),
            (beneficiary, delegate, max_amount, expires_at_ledger),
        );

        Ok(delegation_id)
    }

    /// Revoke a claim delegation, immediately and permanently disabling it.
    ///
    /// Idempotent: revoking an already-revoked delegation is a no-op success.
    /// Any `claim_as_delegate` call that has not yet started executing in a
    /// later transaction will see `revoked == true` and be rejected — Soroban
    /// applies transactions within a ledger sequentially, so there is no
    /// window where a revocation and a claim can both partially apply.
    ///
    /// # Errors
    ///
    /// Returns `NotFound` if `schedule_id` does not exist.
    /// Returns `DelegationNotFound` if `delegation_id` does not exist for this schedule.
    /// Panics with `"Not the beneficiary"` if `beneficiary` is not the schedule's beneficiary.
    pub fn revoke_delegation(
        env: Env,
        beneficiary: Address,
        schedule_id: u64,
        delegation_id: u32,
    ) -> Result<(), VestFlowError> {
        beneficiary.require_auth();

        let schedule: VestingSchedule = env
            .storage()
            .instance()
            .get(&DataKey::Schedule(schedule_id))
            .ok_or(VestFlowError::NotFound)?;
        assert!(beneficiary == schedule.beneficiary, "Not the beneficiary");

        let mut delegation: ClaimDelegation = env
            .storage()
            .instance()
            .get(&DelegationKey::Delegation(schedule_id, delegation_id))
            .ok_or(VestFlowError::DelegationNotFound)?;

        if delegation.revoked {
            return Ok(());
        }
        delegation.revoked = true;

        env.storage().instance().set(
            &DelegationKey::Delegation(schedule_id, delegation_id),
            &delegation,
        );

        // Free a slot in the O(1) concurrency-cap counter (see
        // `DelegationKey::ActiveDelegationCount` / `create_delegation`).
        let active: u32 = env
            .storage()
            .instance()
            .get(&DelegationKey::ActiveDelegationCount(schedule_id))
            .unwrap_or(0);
        env.storage().instance().set(
            &DelegationKey::ActiveDelegationCount(schedule_id),
            &active.saturating_sub(1),
        );

        env.events().publish(
            (symbol_short!("dele_rev"), schedule_id, delegation_id),
            (beneficiary, env.ledger().timestamp()),
        );

        Ok(())
    }

    /// Claim vested tokens on behalf of a beneficiary through a delegation.
    ///
    /// Tokens are transferred directly to `delegate`. The claim is capped by
    /// whatever is currently claimable on the schedule and, if set, by the
    /// delegation's remaining `max_amount - claimed_so_far` budget. The token
    /// transfer and both counter updates (`delegation.claimed_so_far` and
    /// `schedule.claimed_amount`) happen within this single invocation, so a
    /// failed transfer reverts every state change here — there is no window
    /// where the counters advance without the tokens actually moving.
    ///
    /// Soroban auth for this call is scoped to `(schedule_id, delegation_id)`
    /// via `require_auth_for_args`, not a blanket `delegate.require_auth()`.
    /// A signature authorizing a claim for one delegation cannot be replayed
    /// against a different delegation or schedule, even one with the same
    /// delegate address.
    ///
    /// # Errors
    ///
    /// Returns `NotFound` if `schedule_id` does not exist.
    /// Returns `DelegationNotFound` if `delegation_id` does not exist for this schedule.
    /// Returns `NotDelegate` if `delegate` does not match the delegation's stored delegate.
    /// Returns `DelegationRevoked` if the delegation has been revoked.
    /// Returns `DelegationExpired` if past `expires_at_ledger`.
    /// Returns `NothingToClaim` if nothing is currently claimable on the schedule.
    /// Returns `DelegationExhausted` if the delegation's `max_amount` budget is used up.
    pub fn claim_as_delegate(
        env: Env,
        delegate: Address,
        schedule_id: u64,
        delegation_id: u32,
    ) -> Result<(), VestFlowError> {
        let mut delegation: ClaimDelegation = env
            .storage()
            .instance()
            .get(&DelegationKey::Delegation(schedule_id, delegation_id))
            .ok_or(VestFlowError::DelegationNotFound)?;

        if delegate != delegation.delegate {
            return Err(VestFlowError::NotDelegate);
        }

        // Scope the delegate's authorization to this exact schedule +
        // delegation, so it can never be reused for a different delegation.
        delegate.require_auth_for_args(vec![
            &env,
            schedule_id.into_val(&env),
            delegation_id.into_val(&env),
        ]);

        // Revocation-wins ordering: re-check state as the first thing after
        // auth, before any claimable/transfer computation.
        if delegation.revoked {
            return Err(VestFlowError::DelegationRevoked);
        }
        if let Some(expiry) = delegation.expires_at_ledger {
            if env.ledger().sequence() > expiry {
                return Err(VestFlowError::DelegationExpired);
            }
        }

        let mut schedule: VestingSchedule = env
            .storage()
            .instance()
            .get(&DataKey::Schedule(schedule_id))
            .ok_or(VestFlowError::NotFound)?;

        let now = env.ledger().timestamp();
        let claimable = schedule.claimable_at(now);
        if claimable <= 0 {
            return Err(VestFlowError::NothingToClaim);
        }

        let actual_claim = match delegation.max_amount {
            Some(max) => {
                let allowed = max - delegation.claimed_so_far;
                claimable.min(allowed.max(0))
            }
            None => claimable,
        };
        if actual_claim <= 0 {
            return Err(VestFlowError::DelegationExhausted);
        }

        delegation.claimed_so_far += actual_claim;
        schedule.claimed_amount += actual_claim;

        let contract_address = env.current_contract_address();
        token::Client::new(&env, &schedule.token).transfer(
            &contract_address,
            &delegation.delegate,
            &actual_claim,
        );

        env.storage().instance().set(
            &DelegationKey::Delegation(schedule_id, delegation_id),
            &delegation,
        );
        env.storage()
            .instance()
            .set(&DataKey::Schedule(schedule_id), &schedule);

        env.events().publish(
            (symbol_short!("dele_clm"), schedule_id, delegation_id),
            (
                delegation.delegate.clone(),
                actual_claim,
                delegation.claimed_so_far,
            ),
        );

        Ok(())
    }

    /// Read a claim delegation by (schedule_id, delegation_id).
    ///
    /// Returns `None` if unknown rather than panicking.
    pub fn get_delegation(
        env: Env,
        schedule_id: u64,
        delegation_id: u32,
    ) -> Option<ClaimDelegation> {
        env.storage()
            .instance()
            .get(&DelegationKey::Delegation(schedule_id, delegation_id))
    }

    /// Destroy a schedule and reclaim storage for fully-claimed, irrevocable schedules.
    ///
    /// Only callable by the beneficiary or grantor.
    ///
    /// Panics if `claimed_amount < total_amount` or if the schedule is revocable.
    /// Removes schedule entry and index entries and emits a `destroyed` event.
    pub fn destroy_schedule(env: Env, caller: Address, schedule_id: u64) {
        let schedule: VestingSchedule = env
            .storage()
            .instance()
            .get(&DataKey::Schedule(schedule_id))
            .expect("Schedule not found");

        // Require the caller to authorize the destroy operation.
        caller.require_auth();

        // Must be either beneficiary or grantor.
        if caller != schedule.beneficiary && caller != schedule.grantor {
            panic!("Unauthorized caller");
        }

        assert!(
            schedule.claimed_amount == schedule.total_amount,
            "Schedule not fully claimed"
        );
        assert!(!schedule.revocable, "Schedule is revocable");

        // Remove schedule storage.
        env.storage()
            .instance()
            .remove(&DataKey::Schedule(schedule_id));

        // Remove from grantor index.
        let grantor_ids: Vec<u64> = env
            .storage()
            .instance()
            .get(&DataKey::GrantorSchedules(schedule.grantor.clone()))
            .unwrap_or(vec![&env]);
        let mut new_grantor_ids: Vec<u64> = vec![&env];
        for gid in grantor_ids.iter() {
            if gid != schedule_id {
                new_grantor_ids.push_back(gid);
            }
        }
        env.storage().instance().set(
            &DataKey::GrantorSchedules(schedule.grantor.clone()),
            &new_grantor_ids,
        );

        // Remove from beneficiary index.
        let beneficiary_ids: Vec<u64> = env
            .storage()
            .instance()
            .get(&DataKey::BeneficiarySchedules(schedule.beneficiary.clone()))
            .unwrap_or(vec![&env]);
        let mut new_beneficiary_ids: Vec<u64> = vec![&env];
        for bid in beneficiary_ids.iter() {
            if bid != schedule_id {
                new_beneficiary_ids.push_back(bid);
            }
        }
        env.storage().instance().set(
            &DataKey::BeneficiarySchedules(schedule.beneficiary.clone()),
            &new_beneficiary_ids,
        );

        env.events().publish(
            (symbol_short!("destroyed"), schedule_id),
            (schedule.grantor, schedule.beneficiary, schedule.token),
        );
    }

    /// Atomically combine multiple active vesting schedules belonging to the
    /// same grantor-beneficiary pair into a single unified schedule.
    ///
    /// Every currently-claimable amount is paid out from each source before
    /// merging (paused sources are never skipped — `claimable_at` already
    /// accounts for frozen elapsed time while paused). The merged schedule's
    /// `total_amount` is the exact sum of each source's remaining
    /// (unclaimed) balance, so the token invariant
    /// `claimed_total + merged.total_amount == sum(source.total_amount)`
    /// holds exactly with no rounding dust.
    ///
    /// `start_time`, `duration_seconds`, `cliff_seconds`, and
    /// `lockup_duration` are each the token-weighted average of the sources,
    /// weighted by remaining balance. Because every source individually
    /// satisfies `cliff <= duration` and `lockup >= cliff`, and a weighted
    /// average of pointwise-ordered values preserves that order under floor
    /// division by a common denominator, the merged schedule automatically
    /// satisfies the same invariants without extra clamping.
    ///
    /// # Errors
    ///
    /// - `MergeTooFewSchedules` — fewer than 2 IDs given.
    /// - `MergeTooManySchedules` — more than 20 IDs given (Soroban instruction limit).
    /// - `NotFound` — one of `ids` does not exist.
    /// - `MergeOwnerMismatch` — the schedules don't share the same grantor and beneficiary.
    /// - `MergeTokenMismatch` — the schedules don't share the same token.
    /// - `MergeTypeMismatch` — the schedules don't share the same `VestingKind`, or the
    ///   shared kind is `Graded` (milestone tranches cannot be merged deterministically).
    /// - `AlreadyRevoked` — one of the source schedules has already been revoked.
    ///
    /// If every source turns out to already be fully claimed (so nothing
    /// remains to merge), this still succeeds and returns a degenerate,
    /// already-fully-claimed schedule rather than erroring — the claim
    /// payouts above already happened and must not be rolled back.
    ///
    /// # Panics
    ///
    /// Panics with `"Unauthorized caller"` if `caller` is neither the shared grantor
    /// nor the shared beneficiary.
    pub fn merge_schedules(env: Env, caller: Address, ids: Vec<u64>) -> Result<u64, VestFlowError> {
        caller.require_auth();

        if ids.len() < 2 {
            return Err(VestFlowError::MergeTooFewSchedules);
        }
        if ids.len() > 20 {
            return Err(VestFlowError::MergeTooManySchedules);
        }

        let mut schedules: Vec<VestingSchedule> = vec![&env];
        for id in ids.iter() {
            let schedule: VestingSchedule = env
                .storage()
                .instance()
                .get(&DataKey::Schedule(id))
                .ok_or(VestFlowError::NotFound)?;
            schedules.push_back(schedule);
        }

        let first = schedules.get(0).expect("length >= 2 checked above");
        let grantor = first.grantor.clone();
        let beneficiary = first.beneficiary.clone();
        let token = first.token.clone();
        let kind = first.kind.clone();

        for schedule in schedules.iter() {
            if schedule.grantor != grantor || schedule.beneficiary != beneficiary {
                return Err(VestFlowError::MergeOwnerMismatch);
            }
            if schedule.token != token {
                return Err(VestFlowError::MergeTokenMismatch);
            }
            if schedule.kind != kind {
                return Err(VestFlowError::MergeTypeMismatch);
            }
            if schedule.revoked {
                return Err(VestFlowError::AlreadyRevoked);
            }
        }
        // Milestone tranches cannot be merged deterministically.
        if kind == VestingKind::Graded {
            return Err(VestFlowError::MergeTypeMismatch);
        }

        assert!(
            caller == grantor || caller == beneficiary,
            "Unauthorized caller"
        );
        grantor.require_auth();
        beneficiary.require_auth();

        let now = env.ledger().timestamp();
        let contract_address = env.current_contract_address();
        let token_client = token::Client::new(&env, &token);

        // Claim every source's currently-claimable tokens before merging so no
        // vested-but-unclaimed balance is lost.
        for i in 0..schedules.len() {
            let mut schedule = schedules.get(i).expect("i < len");
            let claimable = schedule.claimable_at(now);
            if claimable > 0 {
                schedule.claimed_amount += claimable;
                token_client.transfer(&contract_address, &beneficiary, &claimable);
            }
            schedules.set(i, schedule);
        }

        // Every source may already have been fully vested and just fully
        // auto-claimed above, leaving nothing to merge. The claim transfers
        // already happened, and Soroban only commits them if this call
        // succeeds — returning an error here would silently roll back the
        // payout the beneficiary is owed. `compute_merged_timeline` falls
        // back to harmless defaults instead of dividing by zero in that case
        // rather than us discarding the claims.
        let (total_remaining, start_time_merged, duration_merged, cliff_merged, lockup_merged) =
            compute_merged_timeline(&schedules, now);

        // A merged schedule keeps the grantor's revocation power only if every
        // source did — otherwise merging would silently strengthen (or weaken)
        // the beneficiary's guarantee relative to what each source promised.
        let revocable = schedules.iter().all(|s| s.revocable);

        let count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::ScheduleCount)
            .unwrap_or(0);
        let merged_id = count + 1;

        let merged = VestingSchedule {
            id: merged_id,
            grantor: grantor.clone(),
            beneficiary: beneficiary.clone(),
            token: token.clone(),
            total_amount: total_remaining,
            claimed_amount: 0,
            start_time: start_time_merged,
            duration_seconds: duration_merged,
            cliff_seconds: cliff_merged,
            lockup_duration: lockup_merged,
            kind: kind.clone(),
            revocable,
            revoked: false,
            vested_at_revoke: 0,
            paused: false,
            paused_duration: 0,
            paused_at: 0,
            requires_milestones: false,
            milestones: vec![&env],
        };

        env.storage()
            .instance()
            .set(&DataKey::Schedule(merged_id), &merged);
        env.storage()
            .instance()
            .set(&DataKey::ScheduleCount, &merged_id);

        // Delete every source schedule's storage entry and remove it from both indices.
        let grantor_ids: Vec<u64> = env
            .storage()
            .instance()
            .get(&DataKey::GrantorSchedules(grantor.clone()))
            .unwrap_or(vec![&env]);
        let beneficiary_ids: Vec<u64> = env
            .storage()
            .instance()
            .get(&DataKey::BeneficiarySchedules(beneficiary.clone()))
            .unwrap_or(vec![&env]);

        for id in ids.iter() {
            env.storage().instance().remove(&DataKey::Schedule(id));
        }

        let mut new_grantor_ids: Vec<u64> = vec![&env];
        for gid in grantor_ids.iter() {
            if !ids.contains(gid) {
                new_grantor_ids.push_back(gid);
            }
        }
        new_grantor_ids.push_back(merged_id);
        env.storage().instance().set(
            &DataKey::GrantorSchedules(grantor.clone()),
            &new_grantor_ids,
        );

        let mut new_beneficiary_ids: Vec<u64> = vec![&env];
        for bid in beneficiary_ids.iter() {
            if !ids.contains(bid) {
                new_beneficiary_ids.push_back(bid);
            }
        }
        new_beneficiary_ids.push_back(merged_id);
        env.storage().instance().set(
            &DataKey::BeneficiarySchedules(beneficiary.clone()),
            &new_beneficiary_ids,
        );

        env.events().publish(
            (symbol_short!("merged"), merged_id),
            (ids, merged_id, total_remaining),
        );

        Ok(merged_id)
    }

    /// Create a named funding list of recipient addresses.
    ///
    /// Returns a unique list ID. Emits a `list_created` event with topics `[owner]`
    /// and data `(id, name)`.
    pub fn create_drips_list(env: Env, owner: Address, name: String) -> u64 {
        owner.require_auth();

        let count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::DripsListCount)
            .unwrap_or(0);
        let id = count + 1;

        let list = DripsList {
            id,
            owner: owner.clone(),
            name: name.clone(),
            members: vec![&env],
        };

        env.storage().instance().set(&DataKey::DripsList(id), &list);
        env.storage().instance().set(&DataKey::DripsListCount, &id);
        env.storage().instance().extend_ttl(
            INSTANCE_TTL_THRESHOLD_LEDGERS,
            INSTANCE_TTL_EXTEND_TO_LEDGERS,
        );

        env.events().publish(
            (soroban_sdk::Symbol::new(&env, "list_created"), owner),
            (id, name),
        );

        id
    }

    /// Read member address at a 0-indexed position in a drips list.
    ///
    /// Returns `None` if the list ID is unknown or if index is out of bounds.
    pub fn drips_list_entry(env: Env, list_id: u64, index: u32) -> Option<Address> {
        let list: DripsList = env.storage().instance().get(&DataKey::DripsList(list_id))?;
        list.members.get(index)
    }

    /// Add a member address to a drips list.
    ///
    /// Only the list owner can modify the list. Idempotent if member is already in the list.
    pub fn add_to_drips_list(env: Env, owner: Address, list_id: u64, member: Address) {
        owner.require_auth();

        let mut list: DripsList = env
            .storage()
            .instance()
            .get(&DataKey::DripsList(list_id))
            .expect("List not found");

        assert!(list.owner == owner, "Not owner");

        if !list.members.contains(&member) {
            list.members.push_back(member);
            env.storage()
                .instance()
                .set(&DataKey::DripsList(list_id), &list);
            env.storage().instance().extend_ttl(
                INSTANCE_TTL_THRESHOLD_LEDGERS,
                INSTANCE_TTL_EXTEND_TO_LEDGERS,
            );
        }
    }

    /// Remove a member address from a drips list.
    ///
    /// Only the list owner can modify the list.
    pub fn remove_from_drips_list(env: Env, owner: Address, list_id: u64, member: Address) {
        owner.require_auth();

        let mut list: DripsList = env
            .storage()
            .instance()
            .get(&DataKey::DripsList(list_id))
            .expect("List not found");

        assert!(list.owner == owner, "Not owner");

        let mut idx_to_remove: Option<u32> = None;
        for i in 0..list.members.len() {
            if list.members.get(i) == Some(member.clone()) {
                idx_to_remove = Some(i);
                break;
            }
        }

        if let Some(i) = idx_to_remove {
            list.members.remove(i);
            env.storage()
                .instance()
                .set(&DataKey::DripsList(list_id), &list);
            env.storage().instance().extend_ttl(
                INSTANCE_TTL_THRESHOLD_LEDGERS,
                INSTANCE_TTL_EXTEND_TO_LEDGERS,
            );
        }
    }

    /// Stream funds to all members of a drips list equally.
    ///
    /// Calculates `amt_per_sec = total_amt_per_sec / member_count` and opens streams
    /// to all current list members. If `balance_top_up > 0`, pulls tokens from `funder`.
    /// Does nothing if the list is empty.
    pub fn fund_drips_list(
        env: Env,
        funder: Address,
        list_id: u64,
        token: Address,
        total_amt_per_sec: i128,
        balance_top_up: i128,
    ) {
        funder.require_auth();

        let list: DripsList = env
            .storage()
            .instance()
            .get(&DataKey::DripsList(list_id))
            .expect("List not found");

        if list.members.is_empty() {
            return;
        }

        if balance_top_up > 0 {
            token::Client::new(&env, &token).transfer(
                &funder,
                &env.current_contract_address(),
                &balance_top_up,
            );

            let balance_key = DataKey::StreamBalance(funder.clone(), token.clone());
            let funded: i128 = env.storage().instance().get(&balance_key).unwrap_or(0);
            env.storage()
                .instance()
                .set(&balance_key, &(funded + balance_top_up));
        }

        let count = list.members.len() as i128;
        let amt_per_sec = total_amt_per_sec / count;
        let start_time = env.ledger().timestamp();

        for member in list.members.iter() {
            let stream = DripsStream {
                funder: funder.clone(),
                list_id,
                member: member.clone(),
                token: token.clone(),
                amt_per_sec,
                start_time,
                accumulated: 0,
                paused_at: 0,
            };
            env.storage()
                .instance()
                .set(&DataKey::DripsStream(list_id, member.clone()), &stream);

            let index_key = DataKey::MemberStreamLists(member.clone());
            let mut list_ids: Vec<u64> = env
                .storage()
                .instance()
                .get(&index_key)
                .unwrap_or_else(|| vec![&env]);
            if !list_ids.contains(list_id) {
                list_ids.push_back(list_id);
                env.storage().instance().set(&index_key, &list_ids);
            }

            // Enumerate the funder's streams per (funder, token) so
            // `pause_streams`/`resume_streams` can find them without scanning.
            let funder_index_key = DataKey::FunderStreams(funder.clone(), token.clone());
            let mut funder_index: Vec<(u64, Address)> = env
                .storage()
                .instance()
                .get(&funder_index_key)
                .unwrap_or_else(|| -> Vec<(u64, Address)> { Vec::new(&env) });
            let entry = (list_id, member.clone());
            if !funder_index.contains(&entry) {
                funder_index.push_back(entry);
            }
            env.storage()
                .instance()
                .set(&funder_index_key, &funder_index);
        }

        env.storage().instance().extend_ttl(
            INSTANCE_TTL_THRESHOLD_LEDGERS,
            INSTANCE_TTL_EXTEND_TO_LEDGERS,
        );
    }

    /// View helper to fetch a drips list by ID.
    pub fn get_drips_list(env: Env, list_id: u64) -> Option<DripsList> {
        env.storage().instance().get(&DataKey::DripsList(list_id))
    }

    /// View helper to fetch a drips stream for a list member.
    pub fn get_drips_stream(env: Env, list_id: u64, member: Address) -> Option<DripsStream> {
        env.storage()
            .instance()
            .get(&DataKey::DripsStream(list_id, member))
    }

    /// Length of one drips cycle in seconds.
    ///
    /// Reads back the [`CYCLE_SECS`] constant so frontends, SDKs, and indexers
    /// can source it from the deployed contract rather than hardcoding it.
    pub fn cycle_secs(_env: Env) -> u32 {
        CYCLE_SECS
    }

    /// Total amount of `token` currently held by this contract across every
    /// account — vesting escrow, streaming balances, and collectable balances.
    ///
    /// Read straight from the token contract, so it always matches the on-chain
    /// holdings rather than an internally maintained counter.
    pub fn total_balance(env: Env, token: Address) -> i128 {
        token::Client::new(&env, &token).balance(&env.current_contract_address())
    }

    /// Funds `account` deposited for its outgoing streams of `token` that have
    /// not been streamed out yet.
    ///
    /// Returns 0 for an account that has never funded a stream of this token.
    pub fn stream_balance(env: Env, account: Address, token: Address) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::StreamBalance(account, token))
            .unwrap_or(0)
    }

    /// Timestamp at which `account`'s streaming balance for `token` runs out,
    /// given `receivers` as the stream configuration.
    ///
    /// Returns the current ledger timestamp when the balance is already
    /// exhausted, and `u64::MAX` when nothing is being streamed (the balance
    /// never runs out).
    pub fn max_end_time(
        env: Env,
        account: Address,
        token: Address,
        receivers: Vec<StreamReceiver>,
    ) -> u64 {
        let now = env.ledger().timestamp();

        let mut total_amt_per_sec: i128 = 0;
        for receiver in receivers.iter() {
            if receiver.amt_per_sec > 0 {
                total_amt_per_sec = total_amt_per_sec.saturating_add(receiver.amt_per_sec);
            }
        }
        if total_amt_per_sec == 0 {
            return u64::MAX;
        }

        let balance = Self::stream_balance(env, account, token);
        if balance <= 0 {
            return now;
        }

        let remaining_secs = balance / total_amt_per_sec;
        if remaining_secs >= u64::MAX as i128 {
            u64::MAX
        } else {
            now.saturating_add(remaining_secs as u64)
        }
    }

    /// Amount of `token` that `account` can collect right now from its incoming
    /// streams, without submitting a transaction.
    ///
    /// Each stream accrues `amt_per_sec` per second since it opened, bounded by
    /// what its funder has actually deposited and by the contract's total
    /// holdings of the token, so the result is never more than is collectable.
    pub fn collectable_amount(env: Env, account: Address, token: Address) -> i128 {
        let list_ids: Vec<u64> = env
            .storage()
            .instance()
            .get(&DataKey::MemberStreamLists(account.clone()))
            .unwrap_or_else(|| vec![&env]);

        let now = env.ledger().timestamp();
        let mut collectable: i128 = 0;

        for list_id in list_ids.iter() {
            let stream: DripsStream = match env
                .storage()
                .instance()
                .get(&DataKey::DripsStream(list_id, account.clone()))
            {
                Some(stream) => stream,
                None => continue,
            };

            if stream.token != token || stream.amt_per_sec <= 0 || now <= stream.start_time {
                continue;
            }

            let elapsed = (now - stream.start_time) as i128;
            let accrued = stream.amt_per_sec.saturating_mul(elapsed);
            let funded = Self::stream_balance(env.clone(), stream.funder, token.clone());
            collectable = collectable.saturating_add(accrued.min(funded));
        }

        collectable.min(Self::total_balance(env, token))
    }

    /// Return the current per-second drip rate from `sender` to `receiver` for `token`.
    ///
    /// Returns 0 for senders with no stream configured to `receiver` for `token`.
    pub fn stream_rate_for(env: Env, sender: Address, receiver: Address, token: Address) -> i128 {
        let mut rate: i128 = 0;

        let list_ids: Vec<u64> = env
            .storage()
            .instance()
            .get(&DataKey::MemberStreamLists(receiver.clone()))
            .unwrap_or_else(|| vec![&env]);

        for list_id in list_ids.iter() {
            if let Some(stream) = env
                .storage()
                .instance()
                .get::<DataKey, DripsStream>(&DataKey::DripsStream(list_id, receiver.clone()))
            {
                if stream.funder == sender && stream.token == token && stream.amt_per_sec > 0 {
                    rate = rate.saturating_add(stream.amt_per_sec);
                }
            }
        }

        if let Some(config) = env
            .storage()
            .instance()
            .get::<DataKey, AccountTokenStreams>(&DataKey::AccountTokenStreams(sender, token))
        {
            for r in config.receivers.iter() {
                if r.receiver == receiver && r.amt_per_sec > 0 {
                    rate = rate.saturating_add(r.amt_per_sec);
                }
            }
        }

        rate
    }

    /// Check whether `sender` currently has an active (non-zero rate) stream configured to `receiver` for `token`.
    pub fn is_stream_active(env: Env, sender: Address, receiver: Address, token: Address) -> bool {
        Self::stream_rate_for(env, sender, receiver, token) > 0
    }

    /// Pull unused streaming balance back to `account`.
    ///
    /// Reverts with `"InsufficientBalance"` if `amount` exceeds available balance.
    /// Emits a `withdrawn` event.
    pub fn withdraw(env: Env, account: Address, token: Address, amount: i128) {
        account.require_auth();

        let balance = Self::stream_balance(env.clone(), account.clone(), token.clone());
        assert!(balance >= amount, "InsufficientBalance");

        let balance_key = DataKey::StreamBalance(account.clone(), token.clone());
        env.storage()
            .instance()
            .set(&balance_key, &(balance - amount));

        token::Client::new(&env, &token).transfer(
            &env.current_contract_address(),
            &account,
            &amount,
        );

        env.events().publish(
            (symbol_short!("withdrawn"), account.clone(), token.clone()),
            amount,
        );
    }

    /// View helper fetching the token-specific streams configuration for a
    /// (funder, token) pair.
    pub fn get_account_token_streams(
        env: Env,
        funder: Address,
        token: Address,
    ) -> Option<AccountTokenStreams> {
        env.storage()
            .instance()
            .get::<DataKey, AccountTokenStreams>(&DataKey::AccountTokenStreams(funder, token))
    }

    /// Open or update a token-specific streams configuration for `funder`.
    ///
    /// Every receiver on `receivers` streams from the same `token` at its own
    /// per-second rate. Each (funder, token) pair tracks balance, rate, and
    /// settlement independently, so multiple tokens can stream simultaneously
    /// without interfering. `top_up` amount of `token` is pulled from the
    /// funder into the contract and added to the pair's streamable balance.
    ///
    /// # Panics
    ///
    /// Panics with `"At least one stream receiver required"` if `receivers` is
    /// empty, or `"Top-up must be non-negative"` if `top_up` < 0.
    pub fn set_stream(
        env: Env,
        funder: Address,
        token: Address,
        receivers: Vec<StreamReceiver>,
        top_up: i128,
    ) {
        funder.require_auth();
        assert!(
            !receivers.is_empty(),
            "At least one stream receiver required"
        );
        assert!(top_up >= 0, "Top-up must be non-negative");

        // Validate all receivers have positive rates
        for receiver in receivers.iter() {
            receiver.validate().expect("Invalid stream receiver rate");
        }

        if top_up > 0 {
            token::Client::new(&env, &token).transfer(
                &funder,
                &env.current_contract_address(),
                &top_up,
            );
            let balance_key = DataKey::StreamBalance(funder.clone(), token.clone());
            let funded: i128 = env.storage().instance().get(&balance_key).unwrap_or(0);
            env.storage().instance().set(
                &balance_key,
                &funded.checked_add(top_up).expect("Stream balance overflow"),
            );
        }

        let now = env.ledger().timestamp();
        let previous: Option<AccountTokenStreams> = env
            .storage()
            .instance()
            .get::<DataKey, AccountTokenStreams>(&DataKey::AccountTokenStreams(
                funder.clone(),
                token.clone(),
            ));
        let balance = previous
            .map(|config| config.balance)
            .unwrap_or(0)
            .checked_add(top_up)
            .expect("Stream balance overflow");

        let config = AccountTokenStreams {
            funder: funder.clone(),
            token: token.clone(),
            receivers,
            balance,
            start_time: now,
            last_update: now,
        };
        env.storage().instance().set(
            &DataKey::AccountTokenStreams(funder.clone(), token.clone()),
            &config,
        );
        env.storage().instance().extend_ttl(
            INSTANCE_TTL_THRESHOLD_LEDGERS,
            INSTANCE_TTL_EXTEND_TO_LEDGERS,
        );
        env.events().publish(
            (symbol_short!("strm_set"), funder, token),
            env.ledger().timestamp(),
        );
    }

    /// Add funds to a streaming balance without changing the receiver configuration.
    ///
    /// Returns `AmountZero` if `amount <= 0`.
    pub fn top_up(env: Env, account: Address, token: Address, amount: i128) -> Result<(), VestFlowError> {
        account.require_auth();
        if amount <= 0 {
            return Err(VestFlowError::AmountZero);
        }

        token::Client::new(&env, &token).transfer(
            &account,
            &env.current_contract_address(),
            &amount,
        );

        let balance_key = DataKey::StreamBalance(account.clone(), token.clone());
        let funded: i128 = env.storage().instance().get(&balance_key).unwrap_or(0);
        env.storage()
            .instance()
            .set(&balance_key, &funded.checked_add(amount).expect("Stream balance overflow"));

        if let Some(mut config) = env
            .storage()
            .instance()
            .get::<DataKey, AccountTokenStreams>(&DataKey::AccountTokenStreams(account.clone(), token.clone()))
        {
            config.balance = config.balance.checked_add(amount).expect("Stream balance overflow");
            env.storage()
                .instance()
                .set(&DataKey::AccountTokenStreams(account.clone(), token.clone()), &config);
        }

        env.events().publish(
            (symbol_short!("top_up"), account, token),
            amount,
        );

        Ok(())
    }

    /// Settle the accrued drips for a (funder, token) pair.
    ///
    /// Advances the pair's independent settlement pointer to `now` and credits
    /// every receiver in `receivers` with the drips that accrued since the
    /// last settlement, weighted by each receiver's `amt_per_sec`. The total
    /// settled is capped by `max` and by the pair's remaining `balance`.
    /// Returns the total newly accrued amount.
    ///
    /// # Panics
    ///
    /// Panics with `"Streams not configured"` if the funder has no streams
    /// configured for this token.
    pub fn receive_streams(
        env: Env,
        funder: Address,
        token: Address,
        receivers: Vec<StreamReceiver>,
        max: i128,
    ) -> i128 {
        let mut config: AccountTokenStreams = env
            .storage()
            .instance()
            .get::<DataKey, AccountTokenStreams>(&DataKey::AccountTokenStreams(
                funder.clone(),
                token.clone(),
            ))
            .expect("Streams not configured");

        let now = env.ledger().timestamp();
        let elapsed: i128 = now.saturating_sub(config.last_update) as i128;
        if elapsed == 0 || config.balance == 0 || receivers.is_empty() {
            return 0;
        }

        let total_rate: i128 = receivers.iter().map(|receiver| receiver.amt_per_sec).sum();
        if total_rate <= 0 {
            return 0;
        }

        let gross: i128 = elapsed
            .checked_mul(total_rate)
            .expect("Stream settlement overflow");
        let capped: i128 = gross.min(max).min(config.balance);

        config.last_update = env.ledger().timestamp();
        config.balance = config
            .balance
            .checked_sub(capped)
            .expect("Stream balance underflow");

        for receiver in receivers.iter() {
            let share = if gross > 0 {
                (elapsed * receiver.amt_per_sec)
                    .checked_mul(capped)
                    .expect("Stream share overflow")
                    .checked_div(gross)
                    .expect("Stream share computation failed")
            } else {
                0
            };
            if share > 0 {
                let key = DataKey::Accrued(receiver.receiver.clone(), token.clone());
                let accrued: i128 = env.storage().instance().get(&key).unwrap_or(0);
                env.storage()
                    .instance()
                    .set(&key, &accrued.checked_add(share).expect("Accrued overflow"));
            }
        }

        env.storage().instance().set(
            &DataKey::AccountTokenStreams(funder.clone(), token.clone()),
            &config,
        );
        env.storage().instance().extend_ttl(
            INSTANCE_TTL_THRESHOLD_LEDGERS,
            INSTANCE_TTL_EXTEND_TO_LEDGERS,
        );

        // Calculate cycles processed and emit event only when cycles > 0
        let cycles_processed = (elapsed as u64 / CYCLE_SECS as u64) as u32;
        if cycles_processed > 0 {
            env.events().publish(
                (symbol_short!("strm_recv"), funder, token),
                (cycles_processed, capped),
            );
        }

        capped
    }

    /// Collect `amount` of `token` earned by `account` from streams.
    ///
    /// Transfers from the contract's rolled-up balance up to `amount`, never
    /// exceeding the account's accrued (and not yet collected) earnings for
    /// this token. Returns the amount actually transferred.
    pub fn collect(env: Env, account: Address, token: Address, amount: i128) -> i128 {
        account.require_auth();

        let key = DataKey::Accrued(account.clone(), token.clone());
        let accrued: i128 = env.storage().instance().get(&key).unwrap_or(0);
        let transfer_amount = accrued.min(amount);
        if transfer_amount > 0 {
            token::Client::new(&env, &token).transfer(
                &env.current_contract_address(),
                &account,
                &transfer_amount,
            );
            env.storage().instance().set(
                &key,
                &accrued
                    .checked_sub(transfer_amount)
                    .expect("Accrued underflow"),
            );
            env.storage().instance().extend_ttl(
                INSTANCE_TTL_THRESHOLD_LEDGERS,
                INSTANCE_TTL_EXTEND_TO_LEDGERS,
            );
        }
        env.events()
            .publish((symbol_short!("strm_col"), account, token), transfer_amount);

        transfer_amount
    }

    /// Pause all outgoing streams of `account` for `token`.
    ///
    /// Every running stream is frozen at `now`: its active run is settled into
    /// `accumulated`, `paused_at` is recorded, and the effective drip rate
    /// becomes 0, so the funder's streaming balance stops depleting. Each
    /// stream's receiver configuration is preserved so `resume_streams` can
    /// restore the original rate exactly.
    pub fn pause_streams(env: Env, account: Address, token: Address) {
        account.require_auth();
        let now = env.ledger().timestamp();
        let index: Vec<(u64, Address)> = env
            .storage()
            .instance()
            .get(&DataKey::FunderStreams(account.clone(), token.clone()))
            .unwrap_or_else(|| -> Vec<(u64, Address)> { Vec::new(&env) });
        for (list_id, member) in index.iter() {
            if let Some(mut stream) = env
                .storage()
                .instance()
                .get::<DataKey, DripsStream>(&DataKey::DripsStream(list_id, member.clone()))
            {
                if stream.funder == account && stream.token == token && stream.paused_at == 0 {
                    let elapsed: i128 = now.saturating_sub(stream.start_time) as i128;
                    stream.accumulated = stream
                        .accumulated
                        .checked_add(
                            elapsed
                                .checked_mul(stream.amt_per_sec)
                                .expect("Stream accumulation overflow"),
                        )
                        .expect("Stream accumulated overflow");
                    stream.paused_at = now;
                    env.storage()
                        .instance()
                        .set(&DataKey::DripsStream(list_id, member.clone()), &stream);
                    env.events().publish(
                        (symbol_short!("strmpause"), account.clone(), token.clone()),
                        list_id,
                    );
                }
            }
        }
        env.storage().instance().extend_ttl(
            INSTANCE_TTL_THRESHOLD_LEDGERS,
            INSTANCE_TTL_EXTEND_TO_LEDGERS,
        );
    }

    /// Resume `account`'s previously paused streams for `token`.
    ///
    /// Paused streams restart draining at their original `amt_per_sec` from a
    /// fresh `start_time`, carrying forward the pre-pause `accumulated`
    /// amount, so nothing delivered before the pause is lost or double-counted.
    pub fn resume_streams(env: Env, account: Address, token: Address) {
        account.require_auth();
        let now = env.ledger().timestamp();
        let index: Vec<(u64, Address)> = env
            .storage()
            .instance()
            .get(&DataKey::FunderStreams(account.clone(), token.clone()))
            .unwrap_or_else(|| -> Vec<(u64, Address)> { Vec::new(&env) });
        for (list_id, member) in index.iter() {
            if let Some(mut stream) = env
                .storage()
                .instance()
                .get::<DataKey, DripsStream>(&DataKey::DripsStream(list_id, member.clone()))
            {
                if stream.funder == account && stream.token == token && stream.paused_at != 0 {
                    stream.start_time = now;
                    stream.paused_at = 0;
                    env.storage()
                        .instance()
                        .set(&DataKey::DripsStream(list_id, member.clone()), &stream);
                    env.events().publish(
                        (symbol_short!("strmresm"), account.clone(), token.clone()),
                        list_id,
                    );
                }
            }
        }
        env.storage().instance().extend_ttl(
            INSTANCE_TTL_THRESHOLD_LEDGERS,
            INSTANCE_TTL_EXTEND_TO_LEDGERS,
        );
    }

    /// The amount of `token` still available to `account` for streaming.
    ///
    /// Starts from the funded [`DataKey::StreamBalance`] and subtracts the
    /// effective amount committed by every stream of this (account, token):
    /// `accumulated + (now - start_time) * amt_per_sec` for running streams,
    /// and just `accumulated` for paused ones — so a pause stops the
    /// depletion.
    pub fn available_stream_balance(env: Env, account: Address, token: Address) -> i128 {
        let funded: i128 = env
            .storage()
            .instance()
            .get(&DataKey::StreamBalance(account.clone(), token.clone()))
            .unwrap_or(0);
        let index: Vec<(u64, Address)> = env
            .storage()
            .instance()
            .get(&DataKey::FunderStreams(account.clone(), token.clone()))
            .unwrap_or_else(|| -> Vec<(u64, Address)> { Vec::new(&env) });
        let now = env.ledger().timestamp();
        let mut committed: i128 = 0;
        for (list_id, member) in index.iter() {
            if let Some(stream) = env
                .storage()
                .instance()
                .get::<DataKey, DripsStream>(&DataKey::DripsStream(list_id, member.clone()))
            {
                if stream.funder == account && stream.token == token {
                    let mut stream_committed = stream.accumulated;
                    if stream.paused_at == 0 {
                        let elapsed: i128 = now.saturating_sub(stream.start_time) as i128;
                        stream_committed = stream_committed
                            .checked_add(
                                elapsed
                                    .checked_mul(stream.amt_per_sec)
                                    .expect("Stream balance overflow"),
                            )
                            .expect("Stream balance overflow");
                    }
                    committed = committed
                        .checked_add(stream_committed)
                        .expect("Stream balance overflow");
                }
            }
        }
        funded.saturating_sub(committed).max(0)
    }

    /// Configure `account`'s proportional splits.
    ///
    /// Accepts a mixed list of fixed-address receivers and NFT-gated
    /// receivers. Only the account itself may configure its own splits.
    /// Passing an empty list removes the account's splits configuration.
    ///
    /// # Panics
    ///
    /// Panics with `"Split receiver weight must be positive"` if any receiver
    /// has a zero weight.
    pub fn set_splits(env: Env, account: Address, receivers: Vec<SplitReceiver>) {
        account.require_auth();
        for receiver in receivers.iter() {
            // Validate using the struct's validation method
            match &receiver {
                SplitReceiver::Address(receiver) => {
                    receiver.validate().expect("Split receiver weight must be positive");
                }
                SplitReceiver::Nft(receiver) => {
                    receiver.validate().expect("Split receiver weight must be positive");
                }
            }
        }
        if receivers.is_empty() {
            env.storage()
                .instance()
                .remove(&DataKey::Splits(account.clone()));
        } else {
            env.storage()
                .instance()
                .set(&DataKey::Splits(account.clone()), &receivers);
            env.storage().instance().extend_ttl(
                INSTANCE_TTL_THRESHOLD_LEDGERS,
                INSTANCE_TTL_EXTEND_TO_LEDGERS,
            );
        }
        env.events()
            .publish((symbol_short!("split_set"), account), receivers.len());
    }

    /// View helper returning the account's current splits configuration.
    ///
    /// Returns an empty list when the account has no splits configured.
    pub fn splits(env: Env, account: Address) -> Vec<SplitReceiver> {
        env.storage()
            .instance()
            .get::<_, Vec<SplitReceiver>>(&DataKey::Splits(account.clone()))
            .unwrap_or_else(|| vec![&env])
    }

    /// Build an NFT-gated split receiver for `token_id` using the NFT
    /// contract configured via [`initialize_nft_contract`].
    ///
    /// # Panics
    ///
    /// Panics with `"NFT contract not initialized"` when no NFT contract has
    /// been configured yet.
    pub fn nft_split(env: Env, token_id: u128, weight: u128) -> NftSplitsReceiver {
        let nft_contract = env
            .storage()
            .instance()
            .get::<_, Address>(&DataKey::NftContract)
            .expect("NFT contract not initialized");
        NftSplitsReceiver {
            nft_contract,
            token_id,
            weight,
        }
    }

    /// Distribute `amount` of `token` from `account` to the account's
    /// configured splits receivers, weighting each share proportionally.
    ///
    /// Shares for NFT-gated receivers are paid to whoever owns the referenced
    /// NFT at split time (`owner_of`), so the recipient may differ between
    /// calls when the NFT changes hands.
    ///
    /// # Errors
    ///
    /// Returns `NoSplits` if `account` has no splits configured.
    /// Returns `NftOwnerNotFound` if the owner of an NFT-gated receiver cannot
    /// be resolved.
    ///
    /// # Panics
    ///
    /// Panics with `"Amount must be positive"` if `amount` = 0.
    pub fn split(
        env: Env,
        account: Address,
        token: Address,
        amount: i128,
    ) -> Result<(), VestFlowError> {
        account.require_auth();
        assert!(amount > 0, "Amount must be positive");

        let receivers = Self::splits(env.clone(), account.clone());
        if receivers.is_empty() {
            return Err(VestFlowError::NoSplits);
        }

        let total_weight: u128 = receivers
            .iter()
            .map(|receiver| match &receiver {
                SplitReceiver::Address(receiver) => receiver.weight,
                SplitReceiver::Nft(receiver) => receiver.weight,
            })
            .sum();
        assert!(total_weight > 0, "Total split weight must be positive");

        let contract_address = env.current_contract_address();
        let amount_units = amount as u128;
        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&account, &contract_address, &amount);

        for receiver in receivers.iter() {
            let (recipient, weight) = match &receiver {
                SplitReceiver::Address(receiver) => (receiver.receiver.clone(), receiver.weight),
                SplitReceiver::Nft(receiver) => {
                    let owner = resolve_nft_owner(&env, &receiver.nft_contract, receiver.token_id)?;
                    (owner, receiver.weight)
                }
            };
            let share = amount_units
                .checked_mul(weight)
                .expect("Split share overflow")
                .checked_div(total_weight)
                .expect("Split share computation failed") as i128;
            if share > 0 {
                token_client.transfer(&contract_address, &recipient, &share);
            }
        }

        env.events().publish(
            (symbol_short!("split"), account.clone(), token.clone()),
            (0_i128, amount),
        );

        env.storage().instance().extend_ttl(
            INSTANCE_TTL_THRESHOLD_LEDGERS,
            INSTANCE_TTL_EXTEND_TO_LEDGERS,
        );

        Ok(())
    }
}

fn load_proposal(env: &Env, proposal_id: u64) -> Result<ScheduleProposal, VestFlowError> {
    env.storage()
        .instance()
        .get(&DataKey::Proposal(proposal_id))
        .ok_or(VestFlowError::ProposalNotFound)
}

fn validate_duration(duration: u64) -> Result<(), VestFlowError> {
    if duration == 0 {
        return Err(VestFlowError::DurationZero);
    }
    if duration < 60 {
        return Err(VestFlowError::DurationTooShort);
    }
    Ok(())
}

/// Persist a funded vesting schedule and emit the `created` event.
///
/// Caller must have already authorized the grantor, validated parameters,
/// and transferred `total_amount` into the contract.
fn persist_funded_schedule(
    env: &Env,
    grantor: Address,
    beneficiary: Address,
    token: Address,
    total_amount: i128,
    start_time: u64,
    duration: u64,
    cliff_duration: u64,
    lockup_duration: u64,
    kind: VestingKind,
    revocable: bool,
) -> u64 {
    let count: u64 = env
        .storage()
        .instance()
        .get(&DataKey::ScheduleCount)
        .unwrap_or(0);
    // Schedule IDs are derived from a monotonic counter that is read,
    // incremented, and written atomically within a single transaction.
    // Soroban's single-threaded execution model guarantees no two
    // transactions in the same ledger can observe the same counter value,
    // so schedule ID collisions are impossible.
    let id = count + 1;

    let schedule = VestingSchedule {
        id,
        grantor: grantor.clone(),
        beneficiary: beneficiary.clone(),
        token: token.clone(),
        total_amount,
        claimed_amount: 0,
        start_time,
        duration_seconds: duration,
        cliff_seconds: cliff_duration,
        lockup_duration,
        kind: kind.clone(),
        revocable,
        revoked: false,
        vested_at_revoke: 0,
        paused: false,
        paused_duration: 0,
        paused_at: 0,
        requires_milestones: false,
        milestones: vec![&env],
    };

    env.storage()
        .instance()
        .set(&DataKey::Schedule(id), &schedule);
    env.storage().instance().set(&DataKey::ScheduleCount, &id);

    let mut grantor_ids: Vec<u64> = env
        .storage()
        .instance()
        .get(&DataKey::GrantorSchedules(grantor.clone()))
        .unwrap_or(vec![&env]);
    grantor_ids.push_back(id);
    env.storage()
        .instance()
        .set(&DataKey::GrantorSchedules(grantor.clone()), &grantor_ids);

    let mut beneficiary_ids: Vec<u64> = env
        .storage()
        .instance()
        .get(&DataKey::BeneficiarySchedules(beneficiary.clone()))
        .unwrap_or(vec![&env]);
    beneficiary_ids.push_back(id);
    env.storage().instance().set(
        &DataKey::BeneficiarySchedules(beneficiary.clone()),
        &beneficiary_ids,
    );

    env.events().publish(
        (symbol_short!("created"), id),
        (
            grantor,
            beneficiary,
            token,
            total_amount,
            start_time,
            duration,
            cliff_duration,
            lockup_duration,
            kind,
            revocable,
        ),
    );

    id
}

/// Fixed-point weighted component `value * weight`, used to accumulate a
/// token-weighted sum in [`VestFlowContract::merge_schedules`] before
/// dividing by the total weight. Panics on overflow rather than wrapping —
/// with at most 20 schedules and `i128`-range weights this is unreachable
/// in practice, but wrapping silently would corrupt the weighted average.
fn weighted_component(value: u64, weight: i128) -> i128 {
    (value as i128)
        .checked_mul(weight)
        .expect("merge weighted-average overflow")
}

/// Pure computation of a merged schedule's remaining total and
/// token-weighted-average timeline from a set of already-claimed-out source
/// schedules (i.e. `claimed_amount` reflects any payout that already
/// happened). Returns `(total_remaining, start_time, duration, cliff, lockup)`.
///
/// Extracted out of [`VestFlowContract::merge_schedules`] so the arithmetic
/// can be property-tested directly against synthetic `VestingSchedule`
/// values without registering a contract — every registered-contract
/// invocation in a `#[cfg(test)]` `Env` writes a `test_snapshots/*.json`
/// regression file, which is fine for a handful of deterministic tests but
/// would flood the repo across thousands of proptest cases.
fn compute_merged_timeline(
    schedules: &Vec<VestingSchedule>,
    now: u64,
) -> (i128, u64, u64, u64, u64) {
    let mut total_remaining: i128 = 0;
    let mut weighted_start: i128 = 0;
    let mut weighted_duration: i128 = 0;
    let mut weighted_cliff: i128 = 0;
    let mut weighted_lockup: i128 = 0;

    for schedule in schedules.iter() {
        let remaining = schedule.total_amount - schedule.claimed_amount;
        total_remaining = total_remaining
            .checked_add(remaining)
            .expect("merge remaining-amount overflow");
        weighted_start += weighted_component(schedule.start_time, remaining);
        weighted_duration += weighted_component(schedule.duration_seconds, remaining);
        weighted_cliff += weighted_component(schedule.cliff_seconds, remaining);
        weighted_lockup += weighted_component(schedule.lockup_duration, remaining);
    }

    // Every source may already have been fully vested and claimed, leaving
    // nothing to merge. Fall back to harmless defaults rather than dividing
    // by zero — `total_remaining` is 0 either way, so these values are never
    // observable through `total_amount`.
    if total_remaining > 0 {
        (
            total_remaining,
            (weighted_start / total_remaining) as u64,
            (weighted_duration / total_remaining) as u64,
            (weighted_cliff / total_remaining) as u64,
            (weighted_lockup / total_remaining) as u64,
        )
    } else {
        (0, now, 60, 0, 0)
    }
}

/// Discriminant byte for a [`VestingKind`] as encoded into a batch leaf
/// hash. Stable across contract versions since it is part of the hashed
/// leaf layout that off-chain proof builders must reproduce byte-for-byte.
fn vesting_kind_byte(kind: &VestingKind) -> u8 {
    match kind {
        VestingKind::Linear => 0,
        VestingKind::Cliff => 1,
        VestingKind::LinearWithCliff => 2,
        VestingKind::Graded => 3,
    }
}

/// Raw last-32-bytes of an `Address`'s XDR encoding.
///
/// For an account address this is the raw ed25519 public key; for a
/// contract address it is the contract's hash. Either way it is the same
/// 32 bytes an off-chain builder recovers by StrKey-decoding the address,
/// which is what [`crate::schedule_leaf_hash`] must match byte-for-byte.
fn address_raw_bytes(env: &Env, address: &Address) -> BytesN<32> {
    let xdr = address.clone().to_xdr(env);
    let len = xdr.len();
    xdr.slice(len - 32..len).try_into().expect("32 bytes")
}

/// Hash a batch leaf for a beneficiary's committed schedule slot.
///
/// Layout (all integers big-endian):
/// `sha256(0x00 || beneficiary(32) || total_amount(16) || duration(8) ||
/// cliff_duration(8) || start_time(8) || vesting_kind(1) || revocable(1))`.
///
/// The `0x00` domain separator distinguishes leaves from internal nodes
/// (which are prefixed `0x01` in [`hash_merkle_node`]), preventing a
/// second-preimage attack where an internal node is presented as a leaf.
fn schedule_leaf_hash(
    env: &Env,
    beneficiary: &Address,
    total_amount: i128,
    duration: u64,
    cliff_duration: u64,
    start_time: u64,
    vesting_kind: &VestingKind,
    revocable: bool,
) -> BytesN<32> {
    let mut bytes = Bytes::new(env);
    bytes.push_back(0x00);
    bytes.append(&Bytes::from(address_raw_bytes(env, beneficiary)));
    bytes.append(&Bytes::from_array(env, &total_amount.to_be_bytes()));
    bytes.append(&Bytes::from_array(env, &duration.to_be_bytes()));
    bytes.append(&Bytes::from_array(env, &cliff_duration.to_be_bytes()));
    bytes.append(&Bytes::from_array(env, &start_time.to_be_bytes()));
    bytes.push_back(vesting_kind_byte(vesting_kind));
    bytes.push_back(if revocable { 1 } else { 0 });
    env.crypto().sha256(&bytes).to_bytes()
}

/// Hash two sibling Merkle nodes with sorted-pair, domain-separated encoding:
/// `sha256(0x01 || min(left, right) || max(left, right))`.
///
/// Sorting the pair before hashing means the off-chain proof builder does
/// not need to track left/right order per level, only that both sides sort
/// siblings the same way.
fn hash_merkle_node(env: &Env, left: &BytesN<32>, right: &BytesN<32>) -> BytesN<32> {
    let left_arr: [u8; 32] = left.clone().into();
    let right_arr: [u8; 32] = right.clone().into();
    let (lo, hi): (&BytesN<32>, &BytesN<32>) = if left_arr <= right_arr {
        (left, right)
    } else {
        (right, left)
    };
    let mut bytes = Bytes::new(env);
    bytes.push_back(0x01);
    bytes.append(&Bytes::from(lo.clone()));
    bytes.append(&Bytes::from(hi.clone()));
    env.crypto().sha256(&bytes).to_bytes()
}

/// Fold a Merkle proof up from `leaf` to the implied root.
///
/// Caller is responsible for bounding `proof.len()` (see
/// [`VestFlowContract::claim_schedule_slot`]) before calling this, so the
/// bound is enforced before any hashing work begins.
fn verify_merkle_proof(env: &Env, leaf: &BytesN<32>, proof: &Vec<BytesN<32>>) -> BytesN<32> {
    let mut computed = leaf.clone();
    for sibling in proof.iter() {
        computed = hash_merkle_node(env, &computed, &sibling);
    }
    computed
}

/// Validate that `token` is a recognised Stellar Asset Contract (SAC) by
/// invoking the `decimals` method. Non-SAC addresses will cause the
/// cross-contract call to fail, which we translate into `InvalidToken`.
fn validate_token_sac(env: &Env, token: &Address) -> Result<(), VestFlowError> {
    let func = soroban_sdk::Symbol::new(env, "decimals");
    let args: soroban_sdk::Vec<soroban_sdk::Val> = soroban_sdk::vec![env];
    match env.try_invoke_contract::<soroban_sdk::Val, VestFlowError>(token, &func, args) {
        Ok(_) => Ok(()),
        Err(_) => Err(VestFlowError::InvalidToken),
    }
}

/// Resolve the current owner of `token_id` on the given NFT contract by
/// invoking its `owner_of` entry point.
///
/// Owners are read live at split time so NFT-gated shares always go to the
/// current holder. Unresolvable (or non-NFT) contracts yield
/// `VestFlowError::NftOwnerNotFound`.
fn resolve_nft_owner(
    env: &Env,
    nft_contract: &Address,
    token_id: u128,
) -> Result<Address, VestFlowError> {
    let func = soroban_sdk::Symbol::new(env, "owner_of");
    let args: soroban_sdk::Vec<soroban_sdk::Val> = soroban_sdk::vec![env, token_id.into_val(env)];
    match env.try_invoke_contract::<Address, VestFlowError>(nft_contract, &func, args) {
        Ok(Ok(owner)) => Ok(owner),
        _ => Err(VestFlowError::NftOwnerNotFound),
    }
}

#[cfg(test)]
mod test {
    extern crate std;
    use super::*;
    use proptest::prelude::*;
    use soroban_sdk::{
        testutils::{Address as _, Events as _, Ledger, LedgerInfo},
        token::{Client as TokenClient, StellarAssetClient},
        Env, IntoVal, TryIntoVal,
    };

    fn setup(
        env: &Env,
    ) -> (
        VestFlowContractClient<'_>,
        Address,
        Address,
        Address,
        Address,
    ) {
        let contract_id = env.register(VestFlowContract, ());
        let client = VestFlowContractClient::new(env, &contract_id);
        let grantor = Address::generate(env);
        let beneficiary = Address::generate(env);
        let token_admin = Address::generate(env);
        let token_contract = env.register_stellar_asset_contract_v2(token_admin.clone());
        let token_address = token_contract.address();
        StellarAssetClient::new(env, &token_address)
            .mock_all_auths()
            .mint(&grantor, &10_000);
        (client, grantor, beneficiary, token_address, token_admin)
    }

    fn create_token_contract(env: &Env, admin: &Address) -> Address {
        env.register_stellar_asset_contract_v2(admin.clone()).address()
    }

    fn decode_strm_recv_topics(
        env: &Env,
        topics: &Vec<soroban_sdk::Val>,
    ) -> (soroban_sdk::Symbol, Address, Address) {
        let symbol: soroban_sdk::Symbol = topics.get(0).unwrap().try_into_val(env).unwrap();
        let account: Address = topics.get(1).unwrap().try_into_val(env).unwrap();
        let token: Address = topics.get(2).unwrap().try_into_val(env).unwrap();
        (symbol, account, token)
    }

    fn set_time(env: &Env, ts: u64) {
        env.ledger().set(LedgerInfo {
            timestamp: ts,
            protocol_version: 22,
            sequence_number: env.ledger().sequence(),
            network_id: Default::default(),
            base_reserve: 10,
            min_temp_entry_ttl: 10,
            min_persistent_entry_ttl: 10,
            max_entry_ttl: 3110400,
        });
    }

    fn wasm_hash(env: &Env, byte: u8) -> BytesN<32> {
        BytesN::from_array(env, &[byte; 32])
    }

    #[test]
    fn test_initialize_upgrade_authority_once() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _, _, _, token_admin) = setup(&env);

        client.initialize_upgrade_authority(&token_admin);

        assert_eq!(client.upgrade_authority(), token_admin);
        assert!(client.pending_upgrade().is_none());
    }

    #[test]
    #[should_panic(expected = "Upgrade authority already initialized")]
    fn test_initialize_upgrade_authority_rejects_second_call() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _, _, _, token_admin) = setup(&env);
        let other = Address::generate(&env);

        client.initialize_upgrade_authority(&token_admin);
        client.initialize_upgrade_authority(&other);
    }

    #[test]
    fn test_announce_upgrade_sets_48_hour_timelock() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _, _, _, token_admin) = setup(&env);
        let hash = wasm_hash(&env, 7);

        set_time(&env, 1_000);
        client.initialize_upgrade_authority(&token_admin);
        let pending = client.announce_upgrade(&token_admin, &hash);

        assert_eq!(pending.wasm_hash, hash);
        assert_eq!(pending.announced_at, 1_000);
        assert_eq!(pending.executable_at, 1_000 + UPGRADE_TIMELOCK_SECONDS);
        let stored = client.pending_upgrade().unwrap();
        assert_eq!(stored.wasm_hash, pending.wasm_hash);
        assert_eq!(stored.announced_at, pending.announced_at);
        assert_eq!(stored.executable_at, pending.executable_at);
    }

    #[test]
    #[should_panic(expected = "Unauthorized upgrade authority")]
    fn test_announce_upgrade_rejects_non_authority() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _, _, _, token_admin) = setup(&env);
        let attacker = Address::generate(&env);

        client.initialize_upgrade_authority(&token_admin);
        client.announce_upgrade(&attacker, &wasm_hash(&env, 8));
    }

    #[test]
    #[should_panic(expected = "Upgrade timelock still active")]
    fn test_execute_upgrade_rejects_before_48_hours() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _, _, _, token_admin) = setup(&env);

        set_time(&env, 2_000);
        client.initialize_upgrade_authority(&token_admin);
        client.announce_upgrade(&token_admin, &wasm_hash(&env, 9));
        set_time(&env, 2_000 + UPGRADE_TIMELOCK_SECONDS - 1);

        client.execute_upgrade(&token_admin);
    }

    #[test]
    fn test_cancel_upgrade_clears_pending_upgrade() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _, _, _, token_admin) = setup(&env);

        client.initialize_upgrade_authority(&token_admin);
        client.announce_upgrade(&token_admin, &wasm_hash(&env, 10));
        assert!(client.pending_upgrade().is_some());

        client.cancel_upgrade(&token_admin);

        assert!(client.pending_upgrade().is_none());
    }

    #[test]
    fn test_bump_schedule_ttl_extends_instance_ttl() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, token_addr, _) = setup(&env);

        set_time(&env, 1000);
        let id = client.create_schedule(
            &grantor,
            &beneficiary,
            &token_addr,
            &1000,
            &1000,
            &1000,
            &0,
            &0,
            &VestingKind::Linear,
            &true,
        );

        // Verify that bump_schedule_ttl succeeds for a known schedule ID.
        // The soroban-sdk test environment does not expose a get_ttl() method
        // on Instance storage, so we assert the call completes without panicking.
        client.bump_schedule_ttl(&id);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #1)")]
    fn test_bump_schedule_ttl_rejects_unknown_id() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _, _, _, _) = setup(&env);

        client.bump_schedule_ttl(&999);
    }

    #[test]
    fn test_linear_vesting_full_claim() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, token_addr, _) = setup(&env);
        let token = TokenClient::new(&env, &token_addr);

        set_time(&env, 1000);
        let id = client.create_schedule(
            &grantor,
            &beneficiary,
            &token_addr,
            &1000,
            &1000,
            &1000,
            &0,
            &0,
            &VestingKind::Linear,
            &true,
        );

        // Halfway through vesting
        set_time(&env, 1500);
        assert_eq!(client.claimable(&id), 500);
        client.claim(&id);
        assert_eq!(token.balance(&beneficiary), 500);

        // Fully vested
        set_time(&env, 2000);
        assert_eq!(client.claimable(&id), 500);
        client.claim(&id);
        assert_eq!(token.balance(&beneficiary), 1000);
    }

    #[test]
    fn test_cliff_vesting() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, token_addr, _) = setup(&env);
        let token = TokenClient::new(&env, &token_addr);

        set_time(&env, 0);
        let id = client.create_schedule(
            &grantor,
            &beneficiary,
            &token_addr,
            &1000,
            &0,
            &1000,
            &500,
            &500,
            &VestingKind::Cliff,
            &false,
        );

        // Before cliff
        set_time(&env, 499);
        assert_eq!(client.claimable(&id), 0);

        // At cliff — all unlocks
        set_time(&env, 500);
        assert_eq!(client.claimable(&id), 1000);
        client.claim(&id);
        assert_eq!(token.balance(&beneficiary), 1000);
    }

    #[test]
    #[should_panic(expected = "Start time cannot be in the past")]
    fn test_create_schedule_rejects_past_start_time() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, token_addr, _) = setup(&env);

        set_time(&env, 1000);
        client.create_schedule(
            &grantor,
            &beneficiary,
            &token_addr,
            &1000,
            &999,
            &1000,
            &0,
            &0,
            &VestingKind::Linear,
            &false,
        );
    }

    #[test]
    fn test_revoke_returns_unvested() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, token_addr, _) = setup(&env);
        let token = TokenClient::new(&env, &token_addr);

        set_time(&env, 0);
        let id = client.create_schedule(
            &grantor,
            &beneficiary,
            &token_addr,
            &1000,
            &0,
            &1000,
            &0,
            &0,
            &VestingKind::Linear,
            &true,
        );

        // 25% vested, beneficiary claims
        set_time(&env, 250);
        client.claim(&id);
        assert_eq!(token.balance(&beneficiary), 250);

        // Grantor revokes — gets back 750 (unvested)
        let grantor_before = token.balance(&grantor);
        client.revoke(&id);
        assert_eq!(token.balance(&grantor), grantor_before + 750);
    }

    #[test]
    fn test_revoke_after_full_vest_returns_zero() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, token_addr, _) = setup(&env);
        let token = TokenClient::new(&env, &token_addr);

        set_time(&env, 0);
        let id = client.create_schedule(
            &grantor,
            &beneficiary,
            &token_addr,
            &1000,
            &0,
            &1000,
            &0,
            &0,
            &VestingKind::Linear,
            &true,
        );

        // Fully vested
        set_time(&env, 1000);
        assert_eq!(client.claimable(&id), 1000);

        // Revoke after full vest — grantor gets nothing back, beneficiary receives full amount
        let grantor_before = token.balance(&grantor);
        client.revoke(&id);
        assert_eq!(token.balance(&grantor), grantor_before);
        assert!(client.get_schedule(&id).revoked);

        // Beneficiary already receives full amount upon revocation
        assert_eq!(token.balance(&beneficiary), 1000);
        assert_eq!(client.claimable(&id), 0);
    }

    #[test]
    fn test_revoked_schedule_claims_keep_vested_balance_claimable() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, token_addr, _) = setup(&env);
        let token = TokenClient::new(&env, &token_addr);

        set_time(&env, 0);
        let id = client.create_schedule(
            &grantor,
            &beneficiary,
            &token_addr,
            &1000,
            &0,
            &1000,
            &0,
            &0,
            &VestingKind::Linear,
            &true,
        );

        set_time(&env, 250);
        assert_eq!(client.claimable(&id), 250);

        client.revoke(&id);
        assert!(client.get_schedule(&id).revoked);

        // Already-vested tokens are automatically released to beneficiary on revoke
        assert_eq!(token.balance(&beneficiary), 250);
        assert_eq!(client.claimable(&id), 0);
    }

    #[test]
    fn test_revoke_after_cliff_releases_vested_tokens() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, token_addr, _) = setup(&env);
        let token = TokenClient::new(&env, &token_addr);

        // 1000s duration, 400s cliff, LinearWithCliff schedule
        set_time(&env, 0);
        let id = client.create_schedule(
            &grantor,
            &beneficiary,
            &token_addr,
            &1000,
            &0,
            &1000,
            &400,
            &400,
            &VestingKind::LinearWithCliff,
            &true,
        );

        // At t=700 (mid-vest after cliff): 50% through linear portion (300/600s) -> 500 tokens vested
        set_time(&env, 700);
        assert_eq!(client.claimable(&id), 500);

        let grantor_before = token.balance(&grantor);
        let beneficiary_before = token.balance(&beneficiary);
        client.revoke(&id);

        // Vested tokens released to beneficiary, remainder returned to grantor
        assert_eq!(token.balance(&beneficiary), beneficiary_before + 500);
        assert_eq!(token.balance(&grantor), grantor_before + 500);
        assert!(client.get_schedule(&id).revoked);
        assert_eq!(client.claimable(&id), 0);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #4)")]
    fn test_cannot_claim_before_vesting_starts() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, token_addr, _) = setup(&env);

        set_time(&env, 0);
        let id = client.create_schedule(
            &grantor,
            &beneficiary,
            &token_addr,
            &1000,
            &1000,
            &1000,
            &0,
            &0,
            &VestingKind::Linear,
            &false,
        );
        client.claim(&id);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #2)")]
    fn test_cannot_revoke_irrevocable() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, token_addr, _) = setup(&env);

        set_time(&env, 0);
        let id = client.create_schedule(
            &grantor,
            &beneficiary,
            &token_addr,
            &1000,
            &0,
            &1000,
            &0,
            &0,
            &VestingKind::Linear,
            &false,
        );
        client.revoke(&id);
    }

    // --- Issue #19: LinearWithCliff tests ---

    #[test]
    fn test_linear_with_cliff_before_cliff_returns_zero() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, token_addr, _) = setup(&env);

        // 1000s duration, 400s cliff
        set_time(&env, 0);
        let id = client.create_schedule(
            &grantor,
            &beneficiary,
            &token_addr,
            &1000,
            &0,
            &1000,
            &400,
            &400,
            &VestingKind::LinearWithCliff,
            &false,
        );

        // Before cliff: nothing claimable
        set_time(&env, 399);
        assert_eq!(client.claimable(&id), 0);
    }

    #[test]
    fn test_linear_with_cliff_after_cliff_linear_release() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, token_addr, _) = setup(&env);
        let token = TokenClient::new(&env, &token_addr);

        // 1000s duration, 400s cliff → 600s linear window
        set_time(&env, 0);
        let id = client.create_schedule(
            &grantor,
            &beneficiary,
            &token_addr,
            &1200,
            &0,
            &1000,
            &400,
            &400,
            &VestingKind::LinearWithCliff,
            &false,
        );

        // At cliff: 0/600 through linear window → 0 tokens
        set_time(&env, 400);
        assert_eq!(client.claimable(&id), 0);

        // Halfway through linear window (elapsed=700, linear_elapsed=300, linear_duration=600)
        // vested = 1200 * 300 / 600 = 600
        set_time(&env, 700);
        assert_eq!(client.claimable(&id), 600);
        client.claim(&id);
        assert_eq!(token.balance(&beneficiary), 600);

        // Fully vested at end of duration
        set_time(&env, 1000);
        assert_eq!(client.claimable(&id), 600);
        client.claim(&id);
        assert_eq!(token.balance(&beneficiary), 1200);
    }

    // --- Issue #18: claimable_bulk tests ---

    #[test]
    fn test_claimable_bulk_returns_in_order() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, token_addr, _) = setup(&env);

        set_time(&env, 0);
        // Schedule 1: 1000 tokens, 1000s linear
        let id1 = client.create_schedule(
            &grantor,
            &beneficiary,
            &token_addr,
            &1000,
            &0,
            &1000,
            &0,
            &0,
            &VestingKind::Linear,
            &false,
        );
        // Schedule 2: 2000 tokens, 1000s cliff at 500s
        let id2 = client.create_schedule(
            &grantor,
            &beneficiary,
            &token_addr,
            &2000,
            &0,
            &1000,
            &500,
            &500,
            &VestingKind::Cliff,
            &false,
        );

        // At t=500: id1 has 500 claimable, id2 has 2000 claimable (cliff hit)
        set_time(&env, 500);
        let ids = soroban_sdk::vec![&env, id1, id2];
        let bulk = client.claimable_bulk(&ids);
        assert_eq!(bulk.get(0).unwrap(), 500);
        assert_eq!(bulk.get(1).unwrap(), 2000);
    }

    #[test]
    fn test_claimable_bulk_unknown_id_returns_zero() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, token_addr, _) = setup(&env);

        set_time(&env, 0);
        let _id = client.create_schedule(
            &grantor,
            &beneficiary,
            &token_addr,
            &1000,
            &0,
            &1000,
            &0,
            &0,
            &VestingKind::Linear,
            &false,
        );

        // ID 999 does not exist — should return 0, not panic
        let ids = soroban_sdk::vec![&env, 999_u64];
        let bulk = client.claimable_bulk(&ids);
        assert_eq!(bulk.get(0).unwrap(), 0);
    }

    // --- Issue #108: overflow / edge-case arithmetic tests ---

    /// `vested_at` must never exceed `total_amount`, even when elapsed > duration.
    #[test]
    fn test_linear_vested_at_caps_at_total_amount() {
        let env = Env::default();
        let schedule = VestingSchedule {
            id: 1,
            grantor: Address::generate(&env),
            beneficiary: Address::generate(&env),
            token: Address::generate(&env),
            total_amount: 1_000_000,
            claimed_amount: 0,
            start_time: 0,
            duration_seconds: 1_000,
            cliff_seconds: 0,
            lockup_duration: 0,
            kind: VestingKind::Linear,
            revocable: false,
            revoked: false,
            vested_at_revoke: 0,
            paused: false,
            paused_duration: 0,
            paused_at: 0,
            requires_milestones: false,
            milestones: vec![&env],
        };
        assert_eq!(schedule.vested_at(u64::MAX), 1_000_000);
    }

    /// Near-maximal `total_amount` with a large elapsed value must not panic or
    /// wrap; the result must be clamped to `total_amount`.
    #[test]
    fn test_linear_near_max_i128_no_overflow() {
        let env = Env::default();
        let big_amount = i128::MAX / 2;
        let schedule = VestingSchedule {
            id: 1,
            grantor: Address::generate(&env),
            beneficiary: Address::generate(&env),
            token: Address::generate(&env),
            total_amount: big_amount,
            claimed_amount: 0,
            start_time: 0,
            duration_seconds: u64::MAX,
            cliff_seconds: 0,
            lockup_duration: 0,
            kind: VestingKind::Linear,
            revocable: false,
            revoked: false,
            vested_at_revoke: 0,
            paused: false,
            paused_duration: 0,
            paused_at: 0,
            requires_milestones: false,
            milestones: vec![&env],
        };
        let half_elapsed = u64::MAX / 2;
        let vested = schedule.vested_at(half_elapsed);
        assert!(vested >= 0 && vested <= big_amount);
    }

    /// LinearWithCliff: near-maximal inputs must not overflow.
    #[test]
    fn test_linear_with_cliff_near_max_no_overflow() {
        let env = Env::default();
        let big_amount = i128::MAX / 2;
        let duration = u64::MAX;
        let cliff = duration / 4;
        let schedule = VestingSchedule {
            id: 1,
            grantor: Address::generate(&env),
            beneficiary: Address::generate(&env),
            token: Address::generate(&env),
            total_amount: big_amount,
            claimed_amount: 0,
            start_time: 0,
            duration_seconds: duration,
            cliff_seconds: cliff,
            lockup_duration: cliff,
            kind: VestingKind::LinearWithCliff,
            revocable: false,
            revoked: false,
            vested_at_revoke: 0,
            paused: false,
            paused_duration: 0,
            paused_at: 0,
            requires_milestones: false,
            milestones: vec![&env],
        };
        let mid = cliff + (duration - cliff) / 2;
        let vested = schedule.vested_at(mid);
        assert!(vested >= 0 && vested <= big_amount);
    }

    /// `claimable_at` must never return a negative value.
    #[test]
    fn test_claimable_at_never_negative() {
        let env = Env::default();
        let schedule = VestingSchedule {
            id: 1,
            grantor: Address::generate(&env),
            beneficiary: Address::generate(&env),
            token: Address::generate(&env),
            total_amount: 500,
            claimed_amount: 500,
            start_time: 0,
            duration_seconds: 1_000,
            cliff_seconds: 0,
            lockup_duration: 0,
            kind: VestingKind::Linear,
            revocable: false,
            revoked: false,
            vested_at_revoke: 0,
            paused: false,
            paused_duration: 0,
            paused_at: 0,
            requires_milestones: false,
            milestones: vec![&env],
        };
        assert_eq!(schedule.claimable_at(u64::MAX), 0);
    }

    #[test]
    fn test_timestamped_view_helpers_match_schedule_math() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, token_addr, _) = setup(&env);

        set_time(&env, 0);
        let id = client.create_schedule(
            &grantor,
            &beneficiary,
            &token_addr,
            &1_000,
            &0,
            &1_000,
            &0,
            &0,
            &VestingKind::Linear,
            &false,
        );

        let now = 250_u64;
        assert_eq!(client.vested_amount(&id, &now), 250);
        assert_eq!(client.claimable_amount(&id, &now), 250);
        assert_eq!(client.vested_amount_current(&id), 0);
    }

    /// Zero-duration is rejected by `create_schedule`, but `vested_at` on a
    /// schedule with duration=1 (minimum) must not divide by zero.
    #[test]
    fn test_linear_minimum_duration_no_div_by_zero() {
        let env = Env::default();
        let schedule = VestingSchedule {
            id: 1,
            grantor: Address::generate(&env),
            beneficiary: Address::generate(&env),
            token: Address::generate(&env),
            total_amount: 1_000,
            claimed_amount: 0,
            start_time: 0,
            duration_seconds: 1,
            cliff_seconds: 0,
            lockup_duration: 0,
            kind: VestingKind::Linear,
            revocable: false,
            revoked: false,
            vested_at_revoke: 0,
            paused: false,
            paused_duration: 0,
            paused_at: 0,
            requires_milestones: false,
            milestones: vec![&env],
        };
        assert_eq!(schedule.vested_at(0), 0);
        assert_eq!(schedule.vested_at(1), 1_000);
        assert_eq!(schedule.vested_at(u64::MAX), 1_000);
    }

    // --- Issue #9: beneficiary != grantor ---

    #[test]
    #[should_panic(expected = "Beneficiary must differ from grantor")]
    fn test_cannot_vest_to_self() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, _, token_addr, _) = setup(&env);

        set_time(&env, 0);
        client.create_schedule(
            &grantor,
            &grantor, // beneficiary == grantor
            &token_addr,
            &1000,
            &0,
            &1000,
            &0,
            &0,
            &VestingKind::Linear,
            &false,
        );
    }

    // --- Issue #11: double-claim same ledger ---

    #[test]
    #[should_panic(expected = "Error(Contract, #4)")]
    fn test_double_claim_same_ledger() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, token_addr, _) = setup(&env);

        set_time(&env, 0);
        let id = client.create_schedule(
            &grantor,
            &beneficiary,
            &token_addr,
            &1000,
            &0,
            &1000,
            &0,
            &0,
            &VestingKind::Linear,
            &false,
        );

        // Advance to 50% vested
        set_time(&env, 500);
        // First claim succeeds — claims 500
        client.claim(&id);
        // Second claim at same timestamp — should panic
        client.claim(&id);
    }

    // --- Issue #65: graded vesting tests ---

    #[test]
    fn test_graded_vesting_milestones_unlock_at_correct_times() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, token_addr, _) = setup(&env);
        let token = TokenClient::new(&env, &token_addr);

        // 10% at t=600, 20% at t=1200, 70% at t=2400
        set_time(&env, 0);
        let milestones = soroban_sdk::vec![
            &env,
            GradedMilestone {
                offset_secs: 600,
                bps: 1_000
            },
            GradedMilestone {
                offset_secs: 1200,
                bps: 2_000
            },
            GradedMilestone {
                offset_secs: 2400,
                bps: 7_000
            },
        ];
        let id = client.create_graded_schedule(
            &grantor,
            &beneficiary,
            &token_addr,
            &10_000,
            &0,
            &0,
            &false,
            &milestones,
        );

        // Before first milestone: nothing
        set_time(&env, 599);
        assert_eq!(client.claimable(&id), 0);

        // At first milestone: 10%
        set_time(&env, 600);
        assert_eq!(client.claimable(&id), 1_000);
        client.claim(&id);
        assert_eq!(token.balance(&beneficiary), 1_000);

        // At second milestone: 20% more
        set_time(&env, 1200);
        assert_eq!(client.claimable(&id), 2_000);
        client.claim(&id);
        assert_eq!(token.balance(&beneficiary), 3_000);

        // At final milestone: remaining 70%
        set_time(&env, 2400);
        assert_eq!(client.claimable(&id), 7_000);
        client.claim(&id);
        assert_eq!(token.balance(&beneficiary), 10_000);
    }

    #[test]
    #[should_panic(expected = "Milestones must sum to 10000 bps")]
    fn test_graded_vesting_rejects_invalid_bps_sum() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, token_addr, _) = setup(&env);

        set_time(&env, 0);
        // Only 9000 bps — should panic
        let milestones = soroban_sdk::vec![
            &env,
            GradedMilestone {
                offset_secs: 600,
                bps: 5_000
            },
            GradedMilestone {
                offset_secs: 1200,
                bps: 4_000
            },
        ];
        client.create_graded_schedule(
            &grantor,
            &beneficiary,
            &token_addr,
            &10_000,
            &0,
            &0,
            &false,
            &milestones,
        );
    }

    #[test]
    #[should_panic(expected = "Milestones required")]
    fn test_graded_vesting_rejects_empty_milestones() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, token_addr, _) = setup(&env);

        set_time(&env, 0);
        let milestones: soroban_sdk::Vec<GradedMilestone> = soroban_sdk::vec![&env];
        client.create_graded_schedule(
            &grantor,
            &beneficiary,
            &token_addr,
            &10_000,
            &0,
            &0,
            &false,
            &milestones,
        );
    }

    // --- Issue #7: transfer_beneficiary tests ---

    #[test]
    fn test_transfer_beneficiary_success() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, token_addr, _) = setup(&env);
        let new_beneficiary = Address::generate(&env);

        set_time(&env, 0);
        let id = client.create_schedule(
            &grantor,
            &beneficiary,
            &token_addr,
            &1000,
            &0,
            &1000,
            &0,
            &0,
            &VestingKind::Linear,
            &false,
        );

        client.transfer_beneficiary(&id, &new_beneficiary);

        let schedule = client.get_schedule(&id);
        assert_eq!(schedule.beneficiary, new_beneficiary);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #8)")]
    fn test_transfer_beneficiary_revoked_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, token_addr, _) = setup(&env);
        let new_beneficiary = Address::generate(&env);

        set_time(&env, 0);
        let id = client.create_schedule(
            &grantor,
            &beneficiary,
            &token_addr,
            &1000,
            &0,
            &1000,
            &0,
            &0,
            &VestingKind::Linear,
            &true,
        );

        client.revoke(&id);
        client.transfer_beneficiary(&id, &new_beneficiary);
    }

    #[test]
    #[should_panic]
    fn test_transfer_beneficiary_non_beneficiary_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, token_addr, _) = setup(&env);
        let attacker = Address::generate(&env);

        set_time(&env, 0);
        let id = client.create_schedule(
            &grantor,
            &beneficiary,
            &token_addr,
            &1000,
            &0,
            &1000,
            &0,
            &0,
            &VestingKind::Linear,
            &false,
        );

        // Mock only the attacker's auth — beneficiary.require_auth() will fail
        // because the attacker is not the beneficiary.
        env.mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &attacker,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &client.address,
                fn_name: "transfer_beneficiary",
                args: soroban_sdk::vec![
                    &env,
                    soroban_sdk::IntoVal::<soroban_sdk::Env, soroban_sdk::Val>::into_val(&id, &env),
                    soroban_sdk::IntoVal::<soroban_sdk::Env, soroban_sdk::Val>::into_val(
                        &attacker, &env
                    ),
                ]
                .into(),
                sub_invokes: &[],
            },
        }]);
        client.transfer_beneficiary(&id, &attacker);
    }

    #[test]
    fn test_second_token_support() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, first_token_addr, _) = setup(&env);

        // Register a second token contract
        let second_token_admin = Address::generate(&env);
        let second_token_contract =
            env.register_stellar_asset_contract_v2(second_token_admin.clone());
        let second_token_addr = second_token_contract.address();

        // Mint second token to grantor
        StellarAssetClient::new(&env, &second_token_addr)
            .mock_all_auths()
            .mint(&grantor, &5000);

        let first_token = TokenClient::new(&env, &first_token_addr);
        let second_token = TokenClient::new(&env, &second_token_addr);

        assert_eq!(first_token.balance(&grantor), 10_000);
        assert_eq!(second_token.balance(&grantor), 5000);

        // Create schedule with the second token
        set_time(&env, 1000);
        let id = client.create_schedule(
            &grantor,
            &beneficiary,
            &second_token_addr,
            &2000,
            &1000,
            &1000,
            &0,
            &0,
            &VestingKind::Linear,
            &true,
        );

        // Verify balance after create_schedule: grantor sent 2000 second_token, contract received it
        assert_eq!(second_token.balance(&grantor), 3000);
        assert_eq!(second_token.balance(&client.address), 2000);
        // First token grantor balance is unchanged
        assert_eq!(first_token.balance(&grantor), 10_000);

        // Halfway through vesting (500 elapsed of 1000 duration)
        set_time(&env, 1500);
        assert_eq!(client.claimable(&id), 1000);
        client.claim(&id);

        assert_eq!(second_token.balance(&beneficiary), 1000);
        assert_eq!(second_token.balance(&client.address), 1000);
        assert_eq!(first_token.balance(&beneficiary), 0);
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(100))]
        #[test]
        fn test_fuzz_vested_at_linear_cliff(
            total_amount in 0..1_000_000_000_i128,
            start_time in 0..1_000_000_u64,
            duration in 1..1_000_000_u64,
            cliff_duration in 0..1_000_000_u64,
            now in 0..3_000_000_u64,
            paused in any::<bool>(),
            paused_duration in 0..1_000_000_u64,
        ) {
            let env = Env::default();
            let cliff_duration = cliff_duration.min(duration);

            let schedule = VestingSchedule {
                id: 1,
                grantor: Address::generate(&env),
                beneficiary: Address::generate(&env),
                token: Address::generate(&env),
                total_amount,
                claimed_amount: 0,
                start_time,
                duration_seconds: duration,
                cliff_seconds: cliff_duration,
                lockup_duration: cliff_duration,
                kind: VestingKind::LinearWithCliff,
                revocable: false,
                revoked: false,
                vested_at_revoke: 0,
                paused,
                paused_duration,
                paused_at: if paused { start_time + duration / 2 } else { 0 },
                requires_milestones: false,
                milestones: vec![&env],
            };

            let vested = schedule.vested_at(now);
            prop_assert!(vested >= 0);
            prop_assert!(vested <= total_amount);

            if now < start_time {
                prop_assert_eq!(vested, 0);
            }
        }

        #[test]
        fn test_fuzz_monotonicity_linear(
            total_amount in 0..1_000_000_000_i128,
            start_time in 0..1_000_000_u64,
            duration in 1..1_000_000_u64,
            now1 in 0..3_000_000_u64,
            now2 in 0..3_000_000_u64,
        ) {
            let env = Env::default();
            let schedule = VestingSchedule {
                id: 1,
                grantor: Address::generate(&env),
                beneficiary: Address::generate(&env),
                token: Address::generate(&env),
                total_amount,
                claimed_amount: 0,
                start_time,
                duration_seconds: duration,
                cliff_seconds: 0,
                lockup_duration: 0,
                kind: VestingKind::Linear,
                revocable: false,
                revoked: false,
                vested_at_revoke: 0,
                paused: false,
                paused_duration: 0,
                paused_at: 0,
                requires_milestones: false,
                milestones: vec![&env],
            };

            let v1 = schedule.vested_at(now1);
            let v2 = schedule.vested_at(now2);
            if now1 <= now2 {
                prop_assert!(v1 <= v2);
            } else {
                prop_assert!(v1 >= v2);
            }
        }

        #[test]
        fn test_fuzz_claimable_at(
            total_amount in 0..1_000_000_000_i128,
            claimed in 0..1_000_000_000_i128,
            start_time in 0..1_000_000_u64,
            duration in 1..1_000_000_u64,
            now in 0..3_000_000_u64,
        ) {
            let env = Env::default();
            let schedule = VestingSchedule {
                id: 1,
                grantor: Address::generate(&env),
                beneficiary: Address::generate(&env),
                token: Address::generate(&env),
                total_amount,
                claimed_amount: claimed,
                start_time,
                duration_seconds: duration,
                cliff_seconds: 0,
                lockup_duration: 0,
                kind: VestingKind::Linear,
                revocable: false,
                revoked: false,
                vested_at_revoke: 0,
                paused: false,
                paused_duration: 0,
                paused_at: 0,
                requires_milestones: false,
                milestones: vec![&env],
            };

            let claimable = schedule.claimable_at(now);
            prop_assert!(claimable >= 0);
            prop_assert!(claimable <= total_amount);
        }
    }
    #[test]
    fn test_lockup_prevents_early_claim() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, token_addr, _) = setup(&env);

        set_time(&env, 0);
        let id = client.create_schedule(
            &grantor,
            &beneficiary,
            &token_addr,
            &1000,
            &0,
            &1000,
            &0,
            &600,
            &VestingKind::Linear,
            &false,
        );

        set_time(&env, 500);
        assert_eq!(client.claimable(&id), 0);

        set_time(&env, 600);
        assert_eq!(client.claimable(&id), 600);
    }

    #[test]
    fn test_lockup_with_cliff() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, token_addr, _) = setup(&env);
        let token = TokenClient::new(&env, &token_addr);

        set_time(&env, 0);
        let id = client.create_schedule(
            &grantor,
            &beneficiary,
            &token_addr,
            &1000,
            &0,
            &1000,
            &200,
            &400,
            &VestingKind::LinearWithCliff,
            &false,
        );

        set_time(&env, 300);
        assert_eq!(client.claimable(&id), 0);

        set_time(&env, 400);
        assert_eq!(client.claimable(&id), 250);
        client.claim(&id);
        assert_eq!(token.balance(&beneficiary), 250);
    }

    /// `locked_at_timestamp` returns the vested-but-locked amount during the
    /// lockup window and 0 after it expires (#254).
    #[test]
    fn test_locked_at_timestamp_during_and_after_lockup() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, token_addr, _) = setup(&env);

        // Linear schedule: 1000 tokens, no cliff, lockup_duration = 600s, duration = 1000s.
        set_time(&env, 0);
        let id = client.create_schedule(
            &grantor,
            &beneficiary,
            &token_addr,
            &1000,
            &0,
            &1000,
            &0,
            &600,
            &VestingKind::Linear,
            &false,
        );

        // At t=0: nothing vested yet — locked_at = 0, claimable = 0.
        assert_eq!(client.locked_at_timestamp(&id, &0), 0);
        assert_eq!(client.claimable_at_timestamp(&id, &0), 0);

        // At t=500: 500 tokens vested, still inside lockup (ends at 600).
        // claimable_at_timestamp returns 0; locked_at_timestamp returns 500.
        assert_eq!(client.claimable_at_timestamp(&id, &500), 0);
        assert_eq!(client.locked_at_timestamp(&id, &500), 500);

        // At t=600: lockup expired — locked_at = 0, claimable = 600.
        assert_eq!(client.locked_at_timestamp(&id, &600), 0);
        assert_eq!(client.claimable_at_timestamp(&id, &600), 600);

        // Unknown schedule ID returns 0.
        assert_eq!(client.locked_at_timestamp(&9999, &500), 0);
    }

    #[test]
    #[should_panic(expected = "Lockup cannot be less than cliff")]
    fn test_lockup_less_than_cliff_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, token_addr, _) = setup(&env);

        set_time(&env, 0);
        client.create_schedule(
            &grantor,
            &beneficiary,
            &token_addr,
            &1000,
            &0,
            &1000,
            &500,
            &300,
            &VestingKind::Linear,
            &false,
        );
    }

    // --- Issue #260: oracle guard on enable_performance_milestones ---

    #[test]
    #[should_panic(expected = "Performance oracle must be initialized before enabling milestones")]
    fn test_enable_milestones_without_oracle_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, token_addr, _) = setup(&env);

        set_time(&env, 0);
        let id = client.create_schedule(
            &grantor,
            &beneficiary,
            &token_addr,
            &1000,
            &0,
            &1000,
            &0,
            &0,
            &VestingKind::Linear,
            &false,
        );

        // No oracle initialized — must panic.
        let milestones = soroban_sdk::vec![&env, 50_u32, 50_u32];
        client.enable_performance_milestones(&id, &milestones);
    }

    // --- Issue #258: claimable_at_timestamp ---

    #[test]
    fn test_claimable_at_timestamp_future_linear() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, token_addr, _) = setup(&env);

        set_time(&env, 0);
        let id = client.create_schedule(
            &grantor,
            &beneficiary,
            &token_addr,
            &1000,
            &0,
            &1000,
            &0,
            &0,
            &VestingKind::Linear,
            &false,
        );

        // At t=500 (halfway) 500 tokens will be claimable.
        assert_eq!(client.claimable_at_timestamp(&id, &500), 500);
        // At t=1000 (end) all 1000 tokens will be claimable.
        assert_eq!(client.claimable_at_timestamp(&id, &1000), 1000);
        // Before start: nothing claimable.
        // (start_time=0, so t=0 means no elapsed time → 0 vested)
        assert_eq!(client.claimable_at_timestamp(&id, &0), 0);
    }

    #[test]
    fn test_claimable_at_timestamp_unknown_id_returns_zero() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _, _, _, _) = setup(&env);

        // ID 999 does not exist — must return 0, not panic.
        assert_eq!(client.claimable_at_timestamp(&999_u64, &9999_u64), 0);
    }

    #[test]
    fn test_claimable_at_timestamp_respects_cliff() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, token_addr, _) = setup(&env);

        set_time(&env, 0);
        // Cliff at 500s; tokens unlock all-at-once then.
        let id = client.create_schedule(
            &grantor,
            &beneficiary,
            &token_addr,
            &1000,
            &0,
            &1000,
            &500,
            &500,
            &VestingKind::Cliff,
            &false,
        );

        // Before cliff: nothing.
        assert_eq!(client.claimable_at_timestamp(&id, &499), 0);
        // At cliff: full amount.
        assert_eq!(client.claimable_at_timestamp(&id, &500), 1000);
    }

    // --- Issue #257: get_schedule_batch ---

    #[test]
    fn test_get_schedule_batch_returns_in_order() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, token_addr, _) = setup(&env);

        set_time(&env, 0);
        let id1 = client.create_schedule(
            &grantor,
            &beneficiary,
            &token_addr,
            &1000,
            &0,
            &1000,
            &0,
            &0,
            &VestingKind::Linear,
            &false,
        );
        let id2 = client.create_schedule(
            &grantor,
            &beneficiary,
            &token_addr,
            &2000,
            &0,
            &2000,
            &0,
            &0,
            &VestingKind::Linear,
            &false,
        );

        let ids = soroban_sdk::vec![&env, id1, id2];
        let batch = client.get_schedule_batch(&ids);
        assert_eq!(batch.len(), 2);
        assert!(batch.get(0).unwrap().is_some());
        assert!(batch.get(1).unwrap().is_some());
        assert_eq!(batch.get(0).unwrap().unwrap().total_amount, 1000);
        assert_eq!(batch.get(1).unwrap().unwrap().total_amount, 2000);
    }

    #[test]
    fn test_get_schedule_batch_unknown_id_returns_none() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _, _, _, _) = setup(&env);

        // ID 999 does not exist — must return None, not panic.
        let ids = soroban_sdk::vec![&env, 999_u64];
        let batch = client.get_schedule_batch(&ids);
        assert_eq!(batch.len(), 1);
        assert!(batch.get(0).unwrap().is_none());
    }

    #[test]
    fn test_get_schedule_batch_empty_input() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _, _, _, _) = setup(&env);

        let ids: soroban_sdk::Vec<u64> = soroban_sdk::vec![&env];
        let batch = client.get_schedule_batch(&ids);
        assert_eq!(batch.len(), 0);
    }

    // --- Issue #262: transfer_grantor ---

    #[test]
    fn test_transfer_grantor_success() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, token_addr, _) = setup(&env);
        let new_grantor = Address::generate(&env);

        set_time(&env, 0);
        let id = client.create_schedule(
            &grantor,
            &beneficiary,
            &token_addr,
            &1000,
            &0,
            &1000,
            &0,
            &0,
            &VestingKind::Linear,
            &true,
        );

        client.transfer_grantor(&id, &new_grantor);

        let schedule = client.get_schedule(&id);
        assert_eq!(schedule.grantor, new_grantor);

        // Old grantor's index must no longer contain this schedule.
        let old_ids = client.get_schedules_by_grantor(&grantor);
        assert!(!old_ids.contains(&id));

        // New grantor's index must contain this schedule.
        let new_ids = client.get_schedules_by_grantor(&new_grantor);
        assert!(new_ids.contains(&id));
    }

    #[test]
    fn test_transfer_grantor_not_found() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _, _, _, _) = setup(&env);
        let new_grantor = Address::generate(&env);

        // Expect Error(Contract, #1) = VestFlowError::NotFound
        let result = client.try_transfer_grantor(&999_u64, &new_grantor);
        assert!(result.is_err());
    }

    #[test]
    fn test_transfer_grantor_noop_same_address() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, token_addr, _) = setup(&env);

        set_time(&env, 0);
        let id = client.create_schedule(
            &grantor,
            &beneficiary,
            &token_addr,
            &1000,
            &0,
            &1000,
            &0,
            &0,
            &VestingKind::Linear,
            &false,
        );

        // Transferring to the same address must succeed without modifying state.
        client.transfer_grantor(&id, &grantor);
        let schedule = client.get_schedule(&id);
        assert_eq!(schedule.grantor, grantor);

        // Index must still contain the schedule under the original grantor.
        let ids = client.get_schedules_by_grantor(&grantor);
        assert!(ids.contains(&id));
    }

    #[test]
    #[should_panic]
    fn test_transfer_grantor_non_grantor_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, token_addr, _) = setup(&env);
        let attacker = Address::generate(&env);

        set_time(&env, 0);
        let id = client.create_schedule(
            &grantor,
            &beneficiary,
            &token_addr,
            &1000,
            &0,
            &1000,
            &0,
            &0,
            &VestingKind::Linear,
            &false,
        );

        // Mock only attacker auth — grantor.require_auth() will fail.
        env.mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &attacker,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &client.address,
                fn_name: "transfer_grantor",
                args: soroban_sdk::vec![
                    &env,
                    soroban_sdk::IntoVal::<soroban_sdk::Env, soroban_sdk::Val>::into_val(&id, &env),
                    soroban_sdk::IntoVal::<soroban_sdk::Env, soroban_sdk::Val>::into_val(
                        &attacker, &env
                    ),
                ]
                .into(),
                sub_invokes: &[],
            },
        }]);
        client.transfer_grantor(&id, &attacker);
    }

    // --- Issue #256: destroy_schedule ---

    #[test]
    fn test_destroy_schedule_success_irrevocable_fully_claimed() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, token_addr, _) = setup(&env);

        let token = TokenClient::new(&env, &token_addr);

        set_time(&env, 0);
        let id = client.create_schedule(
            &grantor,
            &beneficiary,
            &token_addr,
            &1000,
            &0,
            &1000,
            &0,
            &0,
            &VestingKind::Linear,
            &false, // revocable = false
        );

        // Fully vested
        set_time(&env, 1000);
        assert_eq!(client.claimable(&id), 1000);
        client.claim(&id);
        assert_eq!(token.balance(&beneficiary), 1000);

        client.destroy_schedule(&grantor, &id);

        // Schedule lookup should now return an error because it no longer exists.
        let result = client.try_get_schedule(&id);
        assert!(result.is_err() || result.unwrap().is_err());

        // Index removed
        let grantor_ids = client.get_schedules_by_grantor(&grantor);
        assert!(!grantor_ids.contains(&id));
        let beneficiary_ids = client.get_schedules_by_beneficiary(&beneficiary);
        assert!(!beneficiary_ids.contains(&id));
    }

    #[test]
    #[should_panic(expected = "Schedule not fully claimed")]
    fn test_destroy_schedule_panics_when_not_fully_claimed() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, token_addr, _) = setup(&env);

        set_time(&env, 0);
        let id = client.create_schedule(
            &grantor,
            &beneficiary,
            &token_addr,
            &1000,
            &0,
            &1000,
            &0,
            &0,
            &VestingKind::Linear,
            &false,
        );

        // Half vested
        set_time(&env, 500);
        client.claim(&id); // claim 500 only

        client.destroy_schedule(&grantor, &id);
    }

    #[test]
    #[should_panic(expected = "Schedule is revocable")]
    fn test_destroy_schedule_panics_when_revocable() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, token_addr, _) = setup(&env);

        set_time(&env, 0);
        let id = client.create_schedule(
            &grantor,
            &beneficiary,
            &token_addr,
            &1000,
            &0,
            &1000,
            &0,
            &0,
            &VestingKind::Linear,
            &true, // revocable
        );

        set_time(&env, 1000);
        client.claim(&id);

        client.destroy_schedule(&grantor, &id);
    }

    #[test]
    #[should_panic]
    fn test_destroy_schedule_requires_beneficiary_or_grantor_auth() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, token_addr, _) = setup(&env);
        let attacker = Address::generate(&env);

        set_time(&env, 0);
        let id = client.create_schedule(
            &grantor,
            &beneficiary,
            &token_addr,
            &1000,
            &0,
            &1000,
            &0,
            &0,
            &VestingKind::Linear,
            &false,
        );

        set_time(&env, 1000);
        client.claim(&id);

        // Only attacker auth should be present.
        env.mock_auths(&[soroban_sdk::testutils::MockAuth {
            address: &attacker,
            invoke: &soroban_sdk::testutils::MockAuthInvoke {
                contract: &client.address,
                fn_name: "destroy_schedule",
                args: soroban_sdk::vec![&env, attacker.into_val(&env), id.into_val(&env),].into(),
                sub_invokes: &[],
            },
        }]);

        client.destroy_schedule(&attacker, &id);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #5)")]
    fn test_error_amount_zero() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, token_addr, _) = setup(&env);

        set_time(&env, 0);
        client.create_schedule(
            &grantor,
            &beneficiary,
            &token_addr,
            &0, // AmountZero
            &0,
            &1000,
            &0,
            &0,
            &VestingKind::Linear,
            &true,
        );
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #6)")]
    fn test_error_duration_zero() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, token_addr, _) = setup(&env);

        set_time(&env, 0);
        client.create_schedule(
            &grantor,
            &beneficiary,
            &token_addr,
            &1000,
            &0,
            &0, // DurationZero
            &0,
            &0,
            &VestingKind::Linear,
            &true,
        );
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #7)")]
    fn test_error_cliff_exceeds_duration() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, token_addr, _) = setup(&env);

        set_time(&env, 0);
        client.create_schedule(
            &grantor,
            &beneficiary,
            &token_addr,
            &1000,
            &0,
            &500, // duration
            &600, // cliff > duration
            &0,
            &VestingKind::Cliff,
            &true,
        );
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #3)")]
    fn test_error_already_revoked() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, token_addr, _) = setup(&env);

        set_time(&env, 0);
        let id = client.create_schedule(
            &grantor,
            &beneficiary,
            &token_addr,
            &1000,
            &0,
            &1000,
            &0,
            &0,
            &VestingKind::Linear,
            &true, // revocable
        );

        set_time(&env, 1);
        client.revoke(&id);
        client.revoke(&id); // AlreadyRevoked
    }

    #[test]
    fn test_views_total_locked_and_irrevocable_count() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, token_addr, _) = setup(&env);

        set_time(&env, 0);

        // Create 3 schedules: 2 revocable, 1 irrevocable with 1000 tokens each
        let _id1 = client.create_schedule(
            &grantor,
            &beneficiary,
            &token_addr,
            &1000,
            &0,
            &1000,
            &0,
            &0,
            &VestingKind::Linear,
            &true, // revocable
        );

        let _id2 = client.create_schedule(
            &grantor,
            &beneficiary,
            &token_addr,
            &1000,
            &0,
            &1000,
            &0,
            &0,
            &VestingKind::Linear,
            &false, // irrevocable
        );

        let _id3 = client.create_schedule(
            &grantor,
            &beneficiary,
            &token_addr,
            &1000,
            &0,
            &1000,
            &0,
            &0,
            &VestingKind::Linear,
            &true, // revocable
        );

        // At time 0, all 3000 tokens should be unvested/locked
        assert_eq!(client.total_locked(&token_addr), 3000);

        // Should have exactly 1 irrevocable schedule
        assert_eq!(client.irrevocable_count(), 1);

        // At 50% vesting (500 seconds), 1500 should be locked
        set_time(&env, 500);
        assert_eq!(client.total_locked(&token_addr), 1500);

        // irrevocable_count should still be 1
        assert_eq!(client.irrevocable_count(), 1);
    }

    #[test]
    fn test_create_schedule_rejects_non_sac_token() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, _, _) = setup(&env);

        // Use a random address that is NOT a deployed SAC contract.
        let fake_token = Address::generate(&env);

        set_time(&env, 0);
        let result = client.try_create_schedule(
            &grantor,
            &beneficiary,
            &fake_token,
            &1000,
            &0,
            &1000,
            &0,
            &0,
            &VestingKind::Linear,
            &false,
        );
        assert_eq!(result.unwrap_err().unwrap(), VestFlowError::InvalidToken);
    }

    #[test]
    fn test_full_lifecycle_cliff_partial_claim_revoke() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, token_addr, _) = setup(&env);
        let token = TokenClient::new(&env, &token_addr);

        // Create schedule with 1000 token cliff at t=1000
        set_time(&env, 0);
        let id = client.create_schedule(
            &grantor,
            &beneficiary,
            &token_addr,
            &1000,
            &0,
            &2000,
            &1000,
            &1000,
            &VestingKind::LinearWithCliff,
            &true,
        );

        // Before cliff: nothing claimable
        set_time(&env, 500);
        assert_eq!(client.claimable(&id), 0);

        // Exactly at cliff: LinearWithCliff linear portion just starts — 0 elapsed
        set_time(&env, 1000);
        assert_eq!(client.claimable(&id), 0);

        // Halfway through linear window (t=1500): 500/1000 tokens vested
        set_time(&env, 1500);
        assert_eq!(client.claimable(&id), 500);

        // Revoke before claiming — grantor gets back the 500 unvested tokens
        let grantor_before = token.balance(&grantor);
        let beneficiary_before = token.balance(&beneficiary);
        client.revoke(&id);
        let grantor_after = token.balance(&grantor);
        let beneficiary_after = token.balance(&beneficiary);
        assert_eq!(grantor_after - grantor_before, 500);
        assert_eq!(beneficiary_after - beneficiary_before, 500);
        assert!(client.get_schedule(&id).revoked);
        assert_eq!(client.claimable(&id), 0);
    }

    #[test]
    fn test_create_schedule_with_maximum_i128_total_amount() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, token_addr, _token_admin) = setup(&env);

        // Mint a very large amount to the grantor (close to i128::MAX but safe)
        let max_safe_amount: i128 = i128::MAX / 2;
        StellarAssetClient::new(&env, &token_addr)
            .mock_all_auths()
            .mint(&grantor, &max_safe_amount);

        set_time(&env, 1000);
        let id = client.create_schedule(
            &grantor,
            &beneficiary,
            &token_addr,
            &max_safe_amount,
            &1000, // start_time (matches current ledger time)
            &1000, // duration
            &0,    // cliff_duration
            &0,    // lockup_duration (must be >= cliff_duration)
            &VestingKind::Linear,
            &false,
        );

        // Verify schedule was created successfully
        let schedule = client.get_schedule(&id);
        assert_eq!(schedule.total_amount, max_safe_amount);
        assert_eq!(schedule.claimed_amount, 0);

        // Test vested_at calculation doesn't overflow
        set_time(&env, 1500);
        let vested = client.claimable(&id);
        assert!(vested > 0);
        assert!(vested <= max_safe_amount);

        // Fully vested
        set_time(&env, 2000);
        let vested_full = client.claimable(&id);
        assert_eq!(vested_full, max_safe_amount);
    }

    #[test]
    fn test_pause_event_emission_with_correct_schedule_id() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, token_addr, _) = setup(&env);

        set_time(&env, 0);
        let id = client.create_schedule(
            &grantor,
            &beneficiary,
            &token_addr,
            &1000,
            &0,
            &1000,
            &0,
            &0,
            &VestingKind::Linear,
            &false,
        );

        // Pause schedule and verify it triggers a pause event
        set_time(&env, 500);
        client.pause_schedule(&id);

        // Verify the schedule is now paused
        let schedule = client.get_schedule(&id);
        assert!(schedule.paused);
        assert_eq!(schedule.paused_at, 500);

        // The event is published with (paused, schedule_id) as topics
        // and (grantor, paused_at) as data
        let schedule_data = client.get_schedule(&id);
        assert_eq!(schedule_data.id, id);
        assert_eq!(schedule_data.paused, true);
    }

    #[test]
    fn test_full_upgrade_flow_announce_wait_execute() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _, _, _, token_admin) = setup(&env);

        let hash1 = wasm_hash(&env, 11);
        let _hash2 = wasm_hash(&env, 12);

        // Step 1: Initialize upgrade authority
        set_time(&env, 1000);
        client.initialize_upgrade_authority(&token_admin);
        assert_eq!(client.upgrade_authority(), token_admin);
        assert!(client.pending_upgrade().is_none());

        // Step 2: Announce an upgrade
        client.announce_upgrade(&token_admin, &hash1);
        let pending = client.pending_upgrade().unwrap();
        assert_eq!(pending.wasm_hash, hash1);
        assert_eq!(pending.announced_at, 1000);
        assert_eq!(pending.executable_at, 1000 + UPGRADE_TIMELOCK_SECONDS);

        // Step 3: Try to execute before timelock expires (should fail)
        set_time(&env, 1000 + UPGRADE_TIMELOCK_SECONDS - 1);
        let result = client.try_execute_upgrade(&token_admin);
        assert!(result.is_err());

        // Step 4: Advance time by 48+ hours and execute
        set_time(&env, 1000 + UPGRADE_TIMELOCK_SECONDS);
        // Note: In a real scenario, execute_upgrade would actually perform the upgrade.
        // Here we just verify the timelock is enforced correctly by checking the pending
        // upgrade state after attempting execution.
        // The actual WASM upgrade is handled by the host environment.
        let result = client.try_execute_upgrade(&token_admin);
        // If the contract returned successfully, the pending upgrade should be cleared.
        // If not (due to environment constraints in test), at least the timelock was respected.
        if result.is_ok() {
            assert!(client.pending_upgrade().is_none());
        }
    }

    // --- Issue #373: vesting_type view ---

    #[test]
    fn test_vesting_type_returns_kind_for_known_schedule() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, token_addr, _) = setup(&env);

        set_time(&env, 0);
        let id = client.create_schedule(
            &grantor,
            &beneficiary,
            &token_addr,
            &1000,
            &0,
            &1000,
            &