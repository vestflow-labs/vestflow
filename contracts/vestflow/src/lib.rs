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
//! | `"Schedule not found"`          | `get_schedule`, `claim`, `revoke` with an unknown ID             |
//! | `"Nothing to claim yet"`        | `claim` called before any tokens have vested                     |
//! | `"Schedule is not revocable"`   | `revoke` called on an irrevocable schedule                       |
//! | `"Already revoked"`             | `revoke` called a second time on the same schedule               |
//! | `"Amount must be positive"`     | `create_schedule` with `total_amount` ≤ 0                        |
//! | `"Duration must be positive"`   | `create_schedule` with `duration` = 0                            |
//! | `"Cliff cannot exceed duration"`| `create_schedule` with `cliff_duration` > `duration`             |
//! | `"Lockup cannot be less than cliff"` | `create_schedule` with `lockup_duration` < `cliff_duration`   |
//! | `"Beneficiary must differ from grantor"` | `create_schedule` with `beneficiary == grantor`                 |
//! | `"Start time cannot be in the past"` | `create_schedule` or `create_graded_schedule` with `start_time` < current ledger time |
//! | `"Upgrade authority already initialized"` | `initialize_upgrade_authority` called more than once |
//! | `"Upgrade authority not initialized"` | Upgrade announcement/execution attempted before authority setup |
//! | `"Unauthorized upgrade authority"` | Upgrade action signed by an address other than the authority |
//! | `"No pending upgrade"` | Upgrade execution/cancellation attempted without an announcement |
//! | `"Upgrade timelock still active"` | Upgrade execution attempted before 48 hours elapsed |
//! | `"Upgrade executable time overflow"` | Upgrade announcement timestamp cannot safely add the timelock |
//! | `"Insufficient balance or below minimum reserve"` | `claim` transfer fails due to balance constraints or Stellar minimum reserve |
//! | `"Performance oracle must be initialized before enabling milestones"` | `enable_performance_milestones` called before `initialize_performance_oracle` |

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, vec, Address, BytesN,
    Env, Vec,
};

pub const VERSION: u32 = 1;

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
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Schedule(u64),
    ScheduleCount,
    /// Address authorized to announce, execute, and cancel contract upgrades.
    UpgradeAuthority,
    /// The currently announced contract upgrade, if any.
    PendingUpgrade,
    /// Index of schedule IDs created by a grantor.
    GrantorSchedules(Address),
    /// Index of schedule IDs where an address is the beneficiary.
    BeneficiarySchedules(Address),
    /// NFT token contract address for vesting receipts.
    NftContract,
    /// Performance milestone attestations for a schedule.
    PerformanceMilestones(u64),
    /// Oracle address authorized to attest milestones.
    PerformanceOracle,
}

/// Mandatory delay between an on-chain upgrade announcement and execution.
pub const UPGRADE_TIMELOCK_SECONDS: u64 = 48 * 60 * 60;

/// Maximum number of milestones allowed in a graded vesting schedule.
/// Bounds the stored schedule size and the per-claim iteration cost so a
/// `create_graded_schedule` call cannot exceed the transaction instruction
/// limit with an unbounded milestone vector.
pub const MAX_MILESTONES: u32 = 100;

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
#[derive(Clone, PartialEq)]
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

    /// Return the contract version.
    pub fn version(_env: Env) -> u32 {
        VERSION
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

    /// Announce an upcoming contract WASM migration on-chain.
    ///
    /// The WASM identified by `wasm_hash` should already be uploaded. This
    /// function does not migrate the contract; it stores the pending upgrade
    /// and emits an announcement event with an execution time 48 hours in the
    /// future so users and monitoring systems can react before the change.
    ///
    /// # Errors
    ///
    /// Panics with `"Upgrade authority not initialized"` if unset.
    /// Panics with `"Unauthorized upgrade authority"` if `authority` is not the configured authority.
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
    /// # Errors
    ///
    /// Panics with `"No pending upgrade"` when no upgrade is pending.
    pub fn cancel_upgrade(env: Env, authority: Address) {
        let configured = Self::read_upgrade_authority(&env);
        assert!(authority == configured, "Unauthorized upgrade authority");
        authority.require_auth();
        let pending: PendingUpgrade = env
            .storage()
            .instance()
            .get(&DataKey::PendingUpgrade)
            .expect("No pending upgrade");

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

    /// Create a new vesting schedule and lock the tokens into the contract.
    ///
    /// The grantor must approve the contract to transfer `total_amount` of
    /// `token` before calling this function.
    ///
    /// # Errors
    ///
    /// Panics with `"Amount must be positive"` if `total_amount` ≤ 0.
    /// Panics with `"Duration must be positive"` if `duration` = 0.
    /// Panics with `"Cliff cannot exceed duration"` if `cliff_duration` > `duration`.
    /// Panics with `"Lockup cannot be less than cliff"` if `lockup_duration` < `cliff_duration`.
    /// Panics with `"Beneficiary must differ from grantor"` if `beneficiary == grantor`.
    /// Panics with `"Start time cannot be in the past"` if `start_time` < current ledger time.
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

        assert!(
            beneficiary != grantor,
            "Beneficiary must differ from grantor"
        );
        if total_amount <= 0 {
            return Err(VestFlowError::AmountZero);
        }
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
        assert!(
            start_time >= env.ledger().timestamp(),
            "Start time cannot be in the past"
        );

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
                cliff_duration,
                lockup_duration,
                kind,
                revocable,
            ),
        );

        Ok(id)
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
    /// Panics with `"Too many milestones"` if the list exceeds `MAX_MILESTONES`.
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
    ) -> u64 {
        grantor.require_auth();

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
        assert!(milestones.len() <= MAX_MILESTONES, "Too many milestones");

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

        id
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

        let mut milestone = milestones.get(milestone_index).unwrap();
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

        let prev_claimed = schedule.claimed_amount;
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

        // For Graded schedules, emit a `mile_unl` event for each milestone
        // whose cumulative threshold is crossed for the first time this claim.
        if matches!(schedule.kind, VestingKind::Graded) {
            let mut cumulative_bps: u64 = 0;
            for milestone in schedule.milestones.iter() {
                cumulative_bps += milestone.bps as u64;
                let threshold = schedule
                    .total_amount
                    .checked_mul(cumulative_bps as i128)
                    .and_then(|n| n.checked_div(10_000))
                    .unwrap_or(schedule.total_amount);
                // Emit only when this claim crosses the threshold for the first time
                if prev_claimed < threshold && schedule.claimed_amount >= threshold {
                    env.events().publish(
                        (symbol_short!("mile_unl"), schedule_id),
                        (milestone.offset_secs, milestone.bps, cumulative_bps),
                    );
                }
            }
        }

        Ok(())
    }

    /// Revoke a vesting schedule (grantor only, revocable schedules only).
    /// Unvested tokens are returned to the grantor. Already-vested tokens
    /// remain claimable by the beneficiary.
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

        // Return unvested tokens to grantor
        if unvested > 0 {
            let contract_address = env.current_contract_address();
            token::Client::new(&env, &schedule.token).transfer(
                &contract_address,
                &schedule.grantor,
                &unvested,
            );
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
            (schedule_id, unvested, vested),
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

    /// Return schedule IDs where the given address is the beneficiary.
    ///
    /// Returns an empty vec if the address has no beneficiary schedules.
    pub fn get_schedules_by_beneficiary(env: Env, beneficiary: Address) -> Vec<u64> {
        env.storage()
            .instance()
            .get(&DataKey::BeneficiarySchedules(beneficiary))
            .unwrap_or(vec![&env])
    }

    /// Preview how many tokens are claimable right now for a given schedule.
    ///
    /// Returns 0 if `schedule_id` is unknown (does not panic).
    pub fn claimable(env: Env, schedule_id: u64) -> i128 {
        match env
            .storage()
            .instance()
            .get::<DataKey, VestingSchedule>(&DataKey::Schedule(schedule_id))
        {
            Some(schedule) => schedule.claimable_at(env.ledger().timestamp()),
            None => 0,
        }
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

    /// View: return the vested amount for a schedule ID using linear
    /// interpolation after the cliff.
    ///
    /// The vested amount is the total tokens that have unlocked according to
    /// the schedule's vesting curve, including already-claimed tokens.
    /// Returns 0 for unknown schedule IDs.
    pub fn vested_amount(env: Env, schedule_id: u64) -> i128 {
        match env
            .storage()
            .instance()
            .get::<DataKey, VestingSchedule>(&DataKey::Schedule(schedule_id))
        {
            Some(schedule) => schedule.vested_at(env.ledger().timestamp()),
            None => 0,
        }
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
}

#[cfg(test)]
mod test {
    use super::*;
    use proptest::prelude::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger, LedgerInfo},
        token::{Client as TokenClient, StellarAssetClient},
        Env,
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

        // Revoke after full vest — grantor gets nothing back
        let grantor_before = token.balance(&grantor);
        client.revoke(&id);
        assert_eq!(token.balance(&grantor), grantor_before);
        assert!(client.get_schedule(&id).revoked);

        // Beneficiary can still claim the full amount
        client.claim(&id);
        assert_eq!(token.balance(&beneficiary), 1000);
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
        assert_eq!(client.claimable(&id), 250);

        client.claim(&id);
        assert_eq!(token.balance(&beneficiary), 250);
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

    #[test]
    #[should_panic(expected = "Too many milestones")]
    fn test_graded_vesting_rejects_too_many_milestones() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, token_addr, _) = setup(&env);

        set_time(&env, 0);
        // MAX_MILESTONES + 1 entries — should panic before the bps-sum check.
        let mut milestones: soroban_sdk::Vec<GradedMilestone> = soroban_sdk::vec![&env];
        for i in 0..(MAX_MILESTONES + 1) {
            milestones.push_back(GradedMilestone {
                offset_secs: (i as u64 + 1) * 600,
                bps: 1,
            });
        }
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
    fn test_graded_vesting_accepts_max_milestones() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, token_addr, _) = setup(&env);

        set_time(&env, 0);
        // Exactly MAX_MILESTONES entries summing to 10 000 bps — should succeed.
        let mut milestones: soroban_sdk::Vec<GradedMilestone> = soroban_sdk::vec![&env];
        for i in 0..MAX_MILESTONES {
            milestones.push_back(GradedMilestone {
                offset_secs: (i as u64 + 1) * 600,
                bps: 100, // 100 bps × 100 milestones = 10 000 bps
            });
        }
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
        assert_eq!(client.get_schedule(&id).milestones.len(), MAX_MILESTONES);
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

    // --- Issue #264: performance milestone flows ---

    /// Helper: set up a contract with an oracle and a basic linear schedule.
    /// Returns (client, schedule_id, grantor, beneficiary, token_addr, oracle).
    fn setup_with_oracle(
        env: &Env,
    ) -> (
        VestFlowContractClient<'_>,
        u64,
        Address,
        Address,
        Address,
        Address,
    ) {
        let (client, grantor, beneficiary, token_addr, token_admin) = setup(env);

        // The upgrade authority and performance oracle must be the same address
        // in our helper because initialize_upgrade_authority requires its own auth.
        client.initialize_upgrade_authority(&token_admin);

        let oracle = Address::generate(env);
        client.initialize_performance_oracle(&oracle);

        set_time(env, 0);
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

        (client, id, grantor, beneficiary, token_addr, oracle)
    }

    /// `enable_performance_milestones` happy path: the schedule should have
    /// `requires_milestones = true` after the call, and `get_milestones` should
    /// return a Vec of un-attested milestones matching the input percentages.
    #[test]
    fn test_enable_performance_milestones_happy_path() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, id, _, _, _, _) = setup_with_oracle(&env);

        let percentages = soroban_sdk::vec![&env, 25_u32, 50_u32, 25_u32];
        client.enable_performance_milestones(&id, &percentages);

        // Schedule must be marked as requiring milestones.
        let schedule = client.get_schedule(&id);
        assert!(schedule.requires_milestones);

        // Stored milestones must mirror the input percentages and be un-attested.
        let milestones = client
            .get_milestones(&id)
            .expect("milestones must be present");
        assert_eq!(milestones.len(), 3);
        assert_eq!(milestones.get(0).unwrap().unlock_percentage, 25);
        assert!(!milestones.get(0).unwrap().attested);
        assert_eq!(milestones.get(1).unwrap().unlock_percentage, 50);
        assert!(!milestones.get(1).unwrap().attested);
        assert_eq!(milestones.get(2).unwrap().unlock_percentage, 25);
        assert!(!milestones.get(2).unwrap().attested);
    }

    /// `attest_milestone` should flip `attested = true` and record the timestamp
    /// for the targeted index, leaving other milestones unchanged.
    #[test]
    fn test_attest_milestone_updates_stored_record() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, id, _, _, _, oracle) = setup_with_oracle(&env);

        let percentages = soroban_sdk::vec![&env, 50_u32, 50_u32];
        client.enable_performance_milestones(&id, &percentages);

        // Advance time so the attestation timestamp is non-zero.
        set_time(&env, 500);
        client.attest_milestone(&id, &0);

        let milestones = client.get_milestones(&id).unwrap();
        // Index 0: attested, timestamp set.
        assert!(milestones.get(0).unwrap().attested);
        assert_eq!(milestones.get(0).unwrap().attested_at, 500);
        // Index 1: still un-attested, timestamp still 0.
        assert!(!milestones.get(1).unwrap().attested);
        assert_eq!(milestones.get(1).unwrap().attested_at, 0);

        // Suppress the "unused variable" warning in the oracle binding.
        let _ = oracle;
    }

    /// Claim must be capped by the highest attested `unlock_percentage`.
    ///
    /// Setup: 1000 tokens, three milestones at 25/50/25 percent.
    /// After attesting only the first milestone (25%), claiming at full vest
    /// should yield at most 25% of total = 250 tokens.
    #[test]
    fn test_claim_capped_by_max_unlock_percentage() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, id, _, beneficiary, token_addr, _) = setup_with_oracle(&env);
        let token = TokenClient::new(&env, &token_addr);

        let percentages = soroban_sdk::vec![&env, 25_u32, 50_u32, 25_u32];
        client.enable_performance_milestones(&id, &percentages);

        // Attest only the first milestone (25%).
        set_time(&env, 0);
        client.attest_milestone(&id, &0);

        // Move to full vest (all 1000 tokens would otherwise be claimable).
        set_time(&env, 1000);

        // Claim should be capped at 25% = 250.
        client.claim(&id);
        assert_eq!(token.balance(&beneficiary), 250);

        // A second claim must fail (nothing left within the milestone cap).
        let result = client.try_claim(&id);
        assert!(result.is_err());
    }

    /// Claim after partial attestation: some milestones attested, others not.
    ///
    /// Setup: 1000 tokens, two milestones at 50/50.
    /// Attest milestone 0 (50%) then milestone 1 (50%).
    /// After attesting both, the full 1000 tokens should be claimable
    /// (i.e. the gate does not permanently block once all are attested).
    #[test]
    fn test_claim_after_partial_then_full_attestation() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, id, _, beneficiary, token_addr, _) = setup_with_oracle(&env);
        let token = TokenClient::new(&env, &token_addr);

        let percentages = soroban_sdk::vec![&env, 50_u32, 50_u32];
        client.enable_performance_milestones(&id, &percentages);

        // Only first milestone attested at start.
        set_time(&env, 0);
        client.attest_milestone(&id, &0);

        // At full vest, only 50% (500) should be claimable.
        set_time(&env, 1000);
        client.claim(&id);
        assert_eq!(token.balance(&beneficiary), 500);

        // Attest the second milestone.
        client.attest_milestone(&id, &1);

        // Now the remaining 50% should unlock.
        client.claim(&id);
        assert_eq!(token.balance(&beneficiary), 1000);
    }
}
