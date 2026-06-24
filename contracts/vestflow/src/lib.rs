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
//! call can trigger a new entry to the same contract.  Despite this guarantee
//! we still include an explicit storage-level re-entrancy guard on the two
//! state-mutating entry points — `claim` and `revoke` — as a defence-in-depth
//! measure and to make the invariant visible in the code.
//!
//! The guard is a simple boolean flag stored under `DataKey::Locked`.  Every
//! mutating entry point acquires the lock on entry and releases it on exit.
//! If a nested call somehow tried to re-enter, the guard would panic with
//! `"Re-entrant call detected"`.
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
//! | `"Beneficiary must differ from grantor"` | `create_schedule` with `beneficiary == grantor`                 |
//! | `"Re-entrant call detected"`    | A state-mutating entry point is called while already executing   |
//! | `"Upgrade authority already initialized"` | `initialize_upgrade_authority` called more than once |
//! | `"Upgrade authority not initialized"` | Upgrade announcement/execution attempted before authority setup |
//! | `"Unauthorized upgrade authority"` | Upgrade action signed by an address other than the authority |
//! | `"No pending upgrade"` | Upgrade execution/cancellation attempted without an announcement |
//! | `"Upgrade timelock still active"` | Upgrade execution attempted before 48 hours elapsed |
//! | `"Upgrade executable time overflow"` | Upgrade announcement timestamp cannot safely add the timelock |
//! | `"Recovery request already pending"` | `request_admin_recovery` called while a request is already open |
//! | `"Not the grantor"` | `request_admin_recovery` called by someone other than the schedule's grantor |
//! | `"No pending recovery"` | `execute_admin_recovery` or `cancel_admin_recovery` with no open request |
//! | `"Recovery timelock still active"` | `execute_admin_recovery` called before 7-day window elapses |
//! | `"New beneficiary must differ from current"` | Recovery request targets the current beneficiary address |

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, token, vec, Address, BytesN, Env, Vec,
};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Schedule(u64),
    ScheduleCount,
    /// Re-entrancy guard flag.
    /// Set to `true` while a state-mutating entry point is executing.
    Locked,
    /// Address authorized to announce, execute, and cancel contract upgrades.
    UpgradeAuthority,
    /// The currently announced contract upgrade, if any.
    PendingUpgrade,
    /// Index of schedule IDs created by a grantor.
    GrantorSchedules(Address),
    /// Index of schedule IDs where an address is the beneficiary.
    BeneficiarySchedules(Address),
    /// A pending admin recovery request for a specific schedule.
    RecoveryRequest(u64),
}

/// Mandatory delay between an on-chain upgrade announcement and execution.
pub const UPGRADE_TIMELOCK_SECONDS: u64 = 48 * 60 * 60;

/// Mandatory delay between a recovery request and admin execution (7 days).
pub const RECOVERY_TIMELOCK_SECONDS: u64 = 7 * 24 * 60 * 60;

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

/// A pending admin recovery request that will redirect a schedule's
/// beneficiary after the [`RECOVERY_TIMELOCK_SECONDS`] window elapses.
///
/// Filed by the grantor, executed by the upgrade authority.
#[contracttype]
#[derive(Clone, PartialEq)]
pub struct RecoveryRequest {
    /// The schedule whose beneficiary will be replaced.
    pub schedule_id: u64,
    /// The new beneficiary address to redirect tokens to.
    pub new_beneficiary: Address,
    /// Address of the grantor who filed this request.
    pub requested_by: Address,
    /// Ledger timestamp when the request was filed.
    pub requested_at: u64,
    /// Earliest ledger timestamp when the admin may execute the recovery.
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
    pub claimed: i128,
    /// Unix timestamp when vesting begins.
    pub start_time: u64,
    /// Vesting duration in seconds.
    pub duration: u64,
    /// Cliff in seconds from `start_time`.
    ///
    /// - `Linear`: ignored.
    /// - `Cliff`: tokens unlock all-at-once after this many seconds.
    /// - `LinearWithCliff`: no tokens until this point; linear from here to end.
    pub cliff_duration: u64,
    pub kind: VestingKind,
    /// Whether the grantor can revoke unvested tokens.
    pub revocable: bool,
    /// Whether this schedule has been revoked.
    pub revoked: bool,
    /// Tokens that were vested at the moment of revocation.
    /// Zero for non-revoked schedules. Used so the beneficiary can still
    /// claim already-vested tokens after a revocation.
    pub vested_at_revoke: i128,
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
        let elapsed = now - self.start_time;
        match self.kind {
            VestingKind::Cliff => {
                if elapsed >= self.cliff_duration {
                    self.total_amount
                } else {
                    0
                }
            }
            VestingKind::Linear => {
                if elapsed >= self.duration {
                    self.total_amount
                } else {
                    // Guard: total_amount * elapsed may overflow i128 for
                    // near-maximal inputs.  Saturate to total_amount on
                    // overflow — the caller can never receive more than that.
                    self.total_amount
                        .checked_mul(elapsed as i128)
                        .and_then(|n| n.checked_div(self.duration as i128))
                        .unwrap_or(self.total_amount)
                }
            }
            VestingKind::LinearWithCliff => {
                // Before cliff: nothing vests.
                if elapsed < self.cliff_duration {
                    return 0;
                }
                // After full duration: everything is vested.
                if elapsed >= self.duration {
                    return self.total_amount;
                }
                // Between cliff and end: linear from cliff_duration to duration.
                // Both subtractions are safe because of the bounds checked above.
                let linear_duration = (self.duration - self.cliff_duration) as i128;
                let linear_elapsed = (elapsed - self.cliff_duration) as i128;
                // Guard: same overflow risk as the Linear branch.
                self.total_amount
                    .checked_mul(linear_elapsed)
                    .and_then(|n| n.checked_div(linear_duration))
                    .unwrap_or(self.total_amount)
            }
        }
    }

    /// Tokens vested but not yet claimed.
    pub fn claimable_at(&self, now: u64) -> i128 {
        let vested = self.vested_at(now);
        if vested > self.claimed {
            vested - self.claimed
        } else {
            0
        }
    }
}

#[contract]
pub struct VestFlowContract;

#[contractimpl]
impl VestFlowContract {
    /// Acquire the re-entrancy lock.
    ///
    /// Panics with `"Re-entrant call detected"` if the lock is already held.
    fn acquire_lock(env: &Env) {
        assert!(
            !env.storage().instance().has(&DataKey::Locked),
            "Re-entrant call detected"
        );
        env.storage().instance().set(&DataKey::Locked, &true);
    }

    /// Release the re-entrancy lock.
    fn release_lock(env: &Env) {
        env.storage().instance().remove(&DataKey::Locked);
    }

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
        env.events()
            .publish((symbol_short!("upgr_auth"), authority), ());
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
    /// Panics with `"Beneficiary must differ from grantor"` if `beneficiary == grantor`.
    pub fn create_schedule(
        env: Env,
        grantor: Address,
        beneficiary: Address,
        token: Address,
        total_amount: i128,
        start_time: u64,
        duration: u64,
        cliff_duration: u64,
        kind: VestingKind,
        revocable: bool,
    ) -> u64 {
        grantor.require_auth();

        assert!(beneficiary != grantor, "Beneficiary must differ from grantor");
        assert!(total_amount > 0, "Amount must be positive");
        assert!(duration > 0, "Duration must be positive");
        assert!(cliff_duration <= duration, "Cliff cannot exceed duration");

        let count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::ScheduleCount)
            .unwrap_or(0);
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
            claimed: 0,
            start_time,
            duration,
            cliff_duration,
            kind,
            revocable,
            revoked: false,
            vested_at_revoke: 0,
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
        env.storage()
            .instance()
            .set(&DataKey::BeneficiarySchedules(beneficiary.clone()), &beneficiary_ids);

        env.events().publish(
            (symbol_short!("created"), grantor, beneficiary, token),
            (id, total_amount),
        );

        id
    }

    /// Claim all currently vested but unclaimed tokens.
    ///
    /// Vested-but-unclaimed tokens remain claimable even after a revocation.
    ///
    /// # Errors
    ///
    /// Panics with `"Schedule not found"` if `schedule_id` does not exist.
    /// Panics with `"Nothing to claim yet"` if no tokens are currently claimable.
    pub fn claim(env: Env, schedule_id: u64) {
        Self::acquire_lock(&env);

        let mut schedule: VestingSchedule = env
            .storage()
            .instance()
            .get(&DataKey::Schedule(schedule_id))
            .expect("Schedule not found");

        schedule.beneficiary.require_auth();

        let now = env.ledger().timestamp();
        let claimable = schedule.claimable_at(now);
        assert!(claimable > 0, "Nothing to claim yet");

        schedule.claimed += claimable;

        let contract_address = env.current_contract_address();
        token::Client::new(&env, &schedule.token).transfer(
            &contract_address,
            &schedule.beneficiary,
            &claimable,
        );

        env.storage()
            .instance()
            .set(&DataKey::Schedule(schedule_id), &schedule);
        env.events().publish(
            (symbol_short!("claimed"), schedule.beneficiary.clone(), schedule.token.clone()),
            (schedule_id, claimable, schedule.claimed),
        );

        Self::release_lock(&env);
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
    pub fn revoke(env: Env, schedule_id: u64) {
        Self::acquire_lock(&env);

        let mut schedule: VestingSchedule = env
            .storage()
            .instance()
            .get(&DataKey::Schedule(schedule_id))
            .expect("Schedule not found");

        schedule.grantor.require_auth();
        assert!(schedule.revocable, "Schedule is not revocable");
        assert!(!schedule.revoked, "Already revoked");

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
            (symbol_short!("revoked"), schedule.grantor.clone(), schedule.token.clone()),
            (schedule_id, unvested, vested),
        );

        Self::release_lock(&env);
    }

    // -----------------------------------------------------------------------
    // Admin recovery
    // -----------------------------------------------------------------------

    /// Read the pending recovery request for a given schedule, if any.
    pub fn recovery_request(env: Env, schedule_id: u64) -> Option<RecoveryRequest> {
        env.storage()
            .instance()
            .get(&DataKey::RecoveryRequest(schedule_id))
    }

    /// File an emergency recovery request to redirect a schedule's beneficiary.
    ///
    /// Only the schedule's **grantor** may open a recovery request. This is
    /// an escape hatch for the case where the beneficiary's private key has
    /// been permanently lost, rendering the tokens unclaimable.
    ///
    /// After [`RECOVERY_TIMELOCK_SECONDS`] (7 days) the upgrade authority
    /// may execute the recovery via [`execute_admin_recovery`]. During the
    /// window either the grantor or the authority may cancel it.
    ///
    /// The 7-day public window gives the beneficiary a chance to object or
    /// prove their key is still accessible.
    ///
    /// # Errors
    ///
    /// Panics with `"Schedule not found"` if `schedule_id` does not exist.
    /// Panics with `"Not the grantor"` if `caller` is not the schedule's grantor.
    /// Panics with `"Recovery request already pending"` if a request is already open.
    /// Panics with `"New beneficiary must differ from current"` if `new_beneficiary` equals the current one.
    pub fn request_admin_recovery(
        env: Env,
        caller: Address,
        schedule_id: u64,
        new_beneficiary: Address,
    ) {
        caller.require_auth();

        let schedule: VestingSchedule = env
            .storage()
            .instance()
            .get(&DataKey::Schedule(schedule_id))
            .expect("Schedule not found");

        assert!(caller == schedule.grantor, "Not the grantor");
        assert!(
            !env.storage()
                .instance()
                .has(&DataKey::RecoveryRequest(schedule_id)),
            "Recovery request already pending"
        );
        assert!(
            new_beneficiary != schedule.beneficiary,
            "New beneficiary must differ from current"
        );

        let requested_at = env.ledger().timestamp();
        let request = RecoveryRequest {
            schedule_id,
            new_beneficiary: new_beneficiary.clone(),
            requested_by: caller.clone(),
            requested_at,
            executable_at: requested_at
                .checked_add(RECOVERY_TIMELOCK_SECONDS)
                .expect("Recovery executable time overflow"),
        };

        env.storage()
            .instance()
            .set(&DataKey::RecoveryRequest(schedule_id), &request);

        env.events().publish(
            (symbol_short!("adm_req"), schedule_id),
            (
                caller,
                schedule.beneficiary,
                new_beneficiary,
                request.requested_at,
                request.executable_at,
            ),
        );
    }

    /// Cancel a pending admin recovery request.
    ///
    /// May be called by **either** the schedule's grantor (who filed it) or
    /// the upgrade authority. This lets the admin abort a suspicious request,
    /// and lets the grantor withdraw their own request if the situation
    /// resolves (e.g. the beneficiary recovers their key).
    ///
    /// # Errors
    ///
    /// Panics with `"No pending recovery"` if no request exists for `schedule_id`.
    pub fn cancel_admin_recovery(env: Env, caller: Address, schedule_id: u64) {
        caller.require_auth();

        let request: RecoveryRequest = env
            .storage()
            .instance()
            .get(&DataKey::RecoveryRequest(schedule_id))
            .expect("No pending recovery");

        // Only the grantor who filed the request OR the upgrade authority may cancel.
        let is_grantor = caller == request.requested_by;
        let is_authority = env
            .storage()
            .instance()
            .get::<DataKey, Address>(&DataKey::UpgradeAuthority)
            .map(|a| a == caller)
            .unwrap_or(false);
        assert!(is_grantor || is_authority, "Unauthorized");

        env.storage()
            .instance()
            .remove(&DataKey::RecoveryRequest(schedule_id));

        env.events().publish(
            (symbol_short!("adm_can"), schedule_id),
            (caller, request.new_beneficiary, request.requested_at),
        );
    }

    /// Execute a pending admin recovery after the 7-day timelock.
    ///
    /// Only the **upgrade authority** may execute a recovery. The request
    /// must have been filed by the grantor via [`request_admin_recovery`] at
    /// least [`RECOVERY_TIMELOCK_SECONDS`] ago.
    ///
    /// On success the schedule's beneficiary is updated to `new_beneficiary`
    /// and the pending request is cleared.
    ///
    /// # Errors
    ///
    /// Panics with `"Upgrade authority not initialized"` if the authority is not configured.
    /// Panics with `"Unauthorized upgrade authority"` if `caller` is not the authority.
    /// Panics with `"No pending recovery"` if no request exists for `schedule_id`.
    /// Panics with `"Recovery timelock still active"` if 7 days have not yet elapsed.
    /// Panics with `"Schedule not found"` if the schedule was deleted (should not happen in normal operation).
    pub fn execute_admin_recovery(env: Env, caller: Address, schedule_id: u64) {
        let authority = Self::read_upgrade_authority(&env);
        assert!(caller == authority, "Unauthorized upgrade authority");
        caller.require_auth();

        let request: RecoveryRequest = env
            .storage()
            .instance()
            .get(&DataKey::RecoveryRequest(schedule_id))
            .expect("No pending recovery");

        assert!(
            env.ledger().timestamp() >= request.executable_at,
            "Recovery timelock still active"
        );

        let mut schedule: VestingSchedule = env
            .storage()
            .instance()
            .get(&DataKey::Schedule(schedule_id))
            .expect("Schedule not found");

        let old_beneficiary = schedule.beneficiary.clone();
        schedule.beneficiary = request.new_beneficiary.clone();

        env.storage()
            .instance()
            .set(&DataKey::Schedule(schedule_id), &schedule);
        env.storage()
            .instance()
            .remove(&DataKey::RecoveryRequest(schedule_id));

        env.events().publish(
            (symbol_short!("adm_exe"), schedule_id),
            (
                caller,
                old_beneficiary,
                request.new_beneficiary,
                request.requested_at,
            ),
        );
    }

    /// Transfer beneficiary rights to a new address.
    ///
    /// # Errors
    ///
    /// Panics with `"Schedule not found"` if `schedule_id` does not exist.
    /// Panics with `"Schedule has been revoked"` if the schedule was revoked.
    pub fn transfer_beneficiary(env: Env, schedule_id: u64, new_beneficiary: Address) {
        let mut schedule: VestingSchedule = env
            .storage()
            .instance()
            .get(&DataKey::Schedule(schedule_id))
            .expect("Schedule not found");

        schedule.beneficiary.require_auth();
        assert!(!schedule.revoked, "Schedule has been revoked");

        let old_beneficiary = schedule.beneficiary.clone();
        schedule.beneficiary = new_beneficiary.clone();

        env.storage()
            .instance()
            .set(&DataKey::Schedule(schedule_id), &schedule);

        env.events().publish(
            (symbol_short!("bnf_chng"), schedule_id),
            (old_beneficiary, new_beneficiary),
        );
    }

    /// Read a vesting schedule by ID.
    ///
    /// # Errors
    ///
    /// Panics with `"Schedule not found"` if `schedule_id` does not exist.
    pub fn get_schedule(env: Env, schedule_id: u64) -> VestingSchedule {
        env.storage()
            .instance()
            .get(&DataKey::Schedule(schedule_id))
            .expect("Schedule not found")
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
}

#[cfg(test)]
mod test {
    use super::*;
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
    #[should_panic(expected = "Nothing to claim yet")]
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
            &VestingKind::Linear,
            &false,
        );
        client.claim(&id);
    }

    #[test]
    #[should_panic(expected = "Schedule is not revocable")]
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
            claimed: 0,
            start_time: 0,
            duration: 1_000,
            cliff_duration: 0,
            kind: VestingKind::Linear,
            revocable: false,
            revoked: false,
            vested_at_revoke: 0,
        };
        // elapsed >> duration — must return exactly total_amount, not overflow
        assert_eq!(schedule.vested_at(u64::MAX), 1_000_000);
    }

    /// Near-maximal `total_amount` with a large elapsed value must not panic or
    /// wrap; the result must be clamped to `total_amount`.
    #[test]
    fn test_linear_near_max_i128_no_overflow() {
        let env = Env::default();
        // Use i128::MAX / 2 so the multiplication would overflow without the guard.
        let big_amount = i128::MAX / 2;
        let schedule = VestingSchedule {
            id: 1,
            grantor: Address::generate(&env),
            beneficiary: Address::generate(&env),
            token: Address::generate(&env),
            total_amount: big_amount,
            claimed: 0,
            start_time: 0,
            duration: u64::MAX,
            cliff_duration: 0,
            kind: VestingKind::Linear,
            revocable: false,
            revoked: false,
            vested_at_revoke: 0,
        };
        // elapsed = duration / 2 → would overflow without checked_mul
        let half_elapsed = u64::MAX / 2;
        let vested = schedule.vested_at(half_elapsed);
        // Must be ≤ total_amount and ≥ 0
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
            claimed: 0,
            start_time: 0,
            duration,
            cliff_duration: cliff,
            kind: VestingKind::LinearWithCliff,
            revocable: false,
            revoked: false,
            vested_at_revoke: 0,
        };
        // Midpoint between cliff and end
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
            claimed: 500, // already fully claimed
            start_time: 0,
            duration: 1_000,
            cliff_duration: 0,
            kind: VestingKind::Linear,
            revocable: false,
            revoked: false,
            vested_at_revoke: 0,
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
            claimed: 0,
            start_time: 0,
            duration: 1,
            cliff_duration: 0,
            kind: VestingKind::Linear,
            revocable: false,
            revoked: false,
            vested_at_revoke: 0,
        };
        // Before end: 0 elapsed → 0 vested
        assert_eq!(schedule.vested_at(0), 0);
        // At or after end: fully vested
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
            &VestingKind::Linear,
            &false,
        );
    }

    // --- Issue #11: double-claim same ledger ---

    #[test]
    #[should_panic(expected = "Nothing to claim yet")]
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
            &VestingKind::Linear,
            &false,
        );

        client.transfer_beneficiary(&id, &new_beneficiary);

        let schedule = client.get_schedule(&id);
        assert_eq!(schedule.beneficiary, new_beneficiary);
    }

    #[test]
    #[should_panic(expected = "Schedule has been revoked")]
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
                    soroban_sdk::IntoVal::<soroban_sdk::Env, soroban_sdk::Val>::into_val(&attacker, &env),
                ]
                .into(),
                sub_invokes: &[],
            },
        }]);
        client.transfer_beneficiary(&id, &attacker);
    }

    // -----------------------------------------------------------------------
    // Admin recovery tests
    // -----------------------------------------------------------------------

    fn setup_with_authority(
        env: &Env,
    ) -> (
        VestFlowContractClient<'_>,
        Address, // grantor
        Address, // beneficiary
        Address, // token_addr
        Address, // authority
    ) {
        let (client, grantor, beneficiary, token_addr, token_admin) = setup(env);
        let authority = token_admin; // reuse as upgrade authority
        client.initialize_upgrade_authority(&authority);
        (client, grantor, beneficiary, token_addr, authority)
    }

    #[test]
    fn test_request_admin_recovery_success() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, token_addr, _) = setup_with_authority(&env);
        let new_beneficiary = Address::generate(&env);

        set_time(&env, 1_000);
        let id = client.create_schedule(
            &grantor,
            &beneficiary,
            &token_addr,
            &1000,
            &1000,
            &1000,
            &0,
            &VestingKind::Linear,
            &false,
        );

        client.request_admin_recovery(&grantor, &id, &new_beneficiary);

        let req = client.recovery_request(&id).unwrap();
        assert_eq!(req.schedule_id, id);
        assert_eq!(req.new_beneficiary, new_beneficiary);
        assert_eq!(req.requested_by, grantor);
        assert_eq!(req.requested_at, 1_000);
        assert_eq!(req.executable_at, 1_000 + RECOVERY_TIMELOCK_SECONDS);
    }

    #[test]
    #[should_panic(expected = "Not the grantor")]
    fn test_request_admin_recovery_rejects_non_grantor() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, token_addr, _) = setup_with_authority(&env);
        let attacker = Address::generate(&env);
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
            &VestingKind::Linear,
            &false,
        );

        client.request_admin_recovery(&attacker, &id, &new_beneficiary);
    }

    #[test]
    #[should_panic(expected = "Recovery request already pending")]
    fn test_request_admin_recovery_rejects_duplicate() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, token_addr, _) = setup_with_authority(&env);
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
            &VestingKind::Linear,
            &false,
        );

        client.request_admin_recovery(&grantor, &id, &new_beneficiary);
        // Second call should panic
        client.request_admin_recovery(&grantor, &id, &new_beneficiary);
    }

    #[test]
    #[should_panic(expected = "New beneficiary must differ from current")]
    fn test_request_admin_recovery_rejects_same_beneficiary() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, token_addr, _) = setup_with_authority(&env);

        set_time(&env, 0);
        let id = client.create_schedule(
            &grantor,
            &beneficiary,
            &token_addr,
            &1000,
            &0,
            &1000,
            &0,
            &VestingKind::Linear,
            &false,
        );

        // new_beneficiary == current beneficiary
        client.request_admin_recovery(&grantor, &id, &beneficiary);
    }

    #[test]
    fn test_execute_admin_recovery_success() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, token_addr, authority) = setup_with_authority(&env);
        let new_beneficiary = Address::generate(&env);
        let token = TokenClient::new(&env, &token_addr);

        set_time(&env, 1_000);
        let id = client.create_schedule(
            &grantor,
            &beneficiary,
            &token_addr,
            &1000,
            &1000,
            &1000,
            &0,
            &VestingKind::Linear,
            &false,
        );

        // File recovery request
        client.request_admin_recovery(&grantor, &id, &new_beneficiary);

        // Advance past timelock
        set_time(&env, 1_000 + RECOVERY_TIMELOCK_SECONDS + 1);
        client.execute_admin_recovery(&authority, &id);

        // Beneficiary should be updated
        let schedule = client.get_schedule(&id);
        assert_eq!(schedule.beneficiary, new_beneficiary);

        // Pending request cleared
        assert!(client.recovery_request(&id).is_none());

        // New beneficiary can now claim once tokens vest
        set_time(&env, 2_000);
        client.claim(&id);
        assert_eq!(token.balance(&new_beneficiary), 1000);
        assert_eq!(token.balance(&beneficiary), 0);
    }

    #[test]
    #[should_panic(expected = "Recovery timelock still active")]
    fn test_execute_admin_recovery_rejects_before_timelock() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, token_addr, authority) = setup_with_authority(&env);
        let new_beneficiary = Address::generate(&env);

        set_time(&env, 1_000);
        let id = client.create_schedule(
            &grantor,
            &beneficiary,
            &token_addr,
            &1000,
            &1000,
            &1000,
            &0,
            &VestingKind::Linear,
            &false,
        );

        client.request_admin_recovery(&grantor, &id, &new_beneficiary);

        // One second before timelock expires
        set_time(&env, 1_000 + RECOVERY_TIMELOCK_SECONDS - 1);
        client.execute_admin_recovery(&authority, &id);
    }

    #[test]
    #[should_panic(expected = "Unauthorized upgrade authority")]
    fn test_execute_admin_recovery_rejects_non_authority() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, token_addr, _) = setup_with_authority(&env);
        let attacker = Address::generate(&env);
        let new_beneficiary = Address::generate(&env);

        set_time(&env, 1_000);
        let id = client.create_schedule(
            &grantor,
            &beneficiary,
            &token_addr,
            &1000,
            &1000,
            &1000,
            &0,
            &VestingKind::Linear,
            &false,
        );

        client.request_admin_recovery(&grantor, &id, &new_beneficiary);
        set_time(&env, 1_000 + RECOVERY_TIMELOCK_SECONDS + 1);

        // Attacker tries to execute — should panic
        client.execute_admin_recovery(&attacker, &id);
    }

    #[test]
    fn test_cancel_admin_recovery_by_grantor() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, token_addr, _) = setup_with_authority(&env);
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
            &VestingKind::Linear,
            &false,
        );

        client.request_admin_recovery(&grantor, &id, &new_beneficiary);
        assert!(client.recovery_request(&id).is_some());

        client.cancel_admin_recovery(&grantor, &id);
        assert!(client.recovery_request(&id).is_none());

        // Original beneficiary unchanged
        assert_eq!(client.get_schedule(&id).beneficiary, beneficiary);
    }

    #[test]
    fn test_cancel_admin_recovery_by_authority() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, token_addr, authority) = setup_with_authority(&env);
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
            &VestingKind::Linear,
            &false,
        );

        client.request_admin_recovery(&grantor, &id, &new_beneficiary);
        assert!(client.recovery_request(&id).is_some());

        // Authority vetoes the request
        client.cancel_admin_recovery(&authority, &id);
        assert!(client.recovery_request(&id).is_none());
    }

    #[test]
    #[should_panic(expected = "No pending recovery")]
    fn test_execute_admin_recovery_no_pending() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, token_addr, authority) = setup_with_authority(&env);

        set_time(&env, 0);
        let id = client.create_schedule(
            &grantor,
            &beneficiary,
            &token_addr,
            &1000,
            &0,
            &1000,
            &0,
            &VestingKind::Linear,
            &false,
        );

        // No request was filed
        client.execute_admin_recovery(&authority, &id);
    }

    #[test]
    #[should_panic(expected = "No pending recovery")]
    fn test_cancel_admin_recovery_no_pending() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, token_addr, _) = setup_with_authority(&env);

        set_time(&env, 0);
        let id = client.create_schedule(
            &grantor,
            &beneficiary,
            &token_addr,
            &1000,
            &0,
            &1000,
            &0,
            &VestingKind::Linear,
            &false,
        );

        client.cancel_admin_recovery(&grantor, &id);
    }

    /// After a recovery, the new beneficiary can claim vested tokens and
    /// the old address can no longer claim.
    #[test]
    fn test_recovered_schedule_old_beneficiary_cannot_claim() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, grantor, beneficiary, token_addr, authority) = setup_with_authority(&env);
        let new_beneficiary = Address::generate(&env);
        let token = TokenClient::new(&env, &token_addr);

        // Schedule that starts immediately
        set_time(&env, 0);
        let id = client.create_schedule(
            &grantor,
            &beneficiary,
            &token_addr,
            &1000,
            &0,
            &1000,
            &0,
            &VestingKind::Linear,
            &false,
        );

        // File and execute recovery
        client.request_admin_recovery(&grantor, &id, &new_beneficiary);
        set_time(&env, RECOVERY_TIMELOCK_SECONDS + 1);
        client.execute_admin_recovery(&authority, &id);

        // Fully vested
        set_time(&env, 1001);
        assert_eq!(token.balance(&beneficiary), 0);

        // New beneficiary claims successfully
        client.claim(&id);
        assert_eq!(token.balance(&new_beneficiary), 1000);
        assert_eq!(token.balance(&beneficiary), 0);
    }
}
