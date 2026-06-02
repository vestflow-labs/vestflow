import { Buffer } from "buffer";
import { Address } from "@stellar/stellar-sdk";
import {
  AssembledTransaction,
  Client as ContractClient,
  ClientOptions as ContractClientOptions,
  MethodOptions,
  Result,
  Spec as ContractSpec,
} from "@stellar/stellar-sdk/contract";
import type {
  u32,
  i32,
  u64,
  i64,
  u128,
  i128,
  u256,
  i256,
  Option,
  Timepoint,
  Duration,
} from "@stellar/stellar-sdk/contract";
export * from "@stellar/stellar-sdk";
export * as contract from "@stellar/stellar-sdk/contract";
export * as rpc from "@stellar/stellar-sdk/rpc";

if (typeof window !== "undefined") {
  //@ts-ignore Buffer exists
  window.Buffer = window.Buffer || Buffer;
}




export type DataKey = {tag: "Schedule", values: readonly [u64]} | {tag: "ScheduleCount", values: void} | {tag: "Locked", values: void} | {tag: "UpgradeAuthority", values: void} | {tag: "PendingUpgrade", values: void} | {tag: "GrantorSchedules", values: readonly [string]} | {tag: "BeneficiarySchedules", values: readonly [string]};

/**
 * The type of vesting curve applied to a schedule.
 */
export type VestingKind = {tag: "Linear", values: void} | {tag: "Cliff", values: void} | {tag: "LinearWithCliff", values: void};


/**
 * A contract WASM upgrade that has been announced on-chain but not yet executed.
 */
export interface PendingUpgrade {
  /**
 * Ledger timestamp when the upgrade was announced.
 */
announced_at: u64;
  /**
 * Earliest ledger timestamp when the upgrade may be executed.
 */
executable_at: u64;
  /**
 * Hash of the already-uploaded WASM blob to migrate this contract to.
 */
wasm_hash: Buffer;
}


export interface VestingSchedule {
  /**
 * Address that can claim vested tokens.
 */
beneficiary: string;
  /**
 * Tokens already claimed by the beneficiary.
 */
claimed: i128;
  /**
 * Cliff in seconds from `start_time`.
 *
 * - `Linear`: ignored.
 * - `Cliff`: tokens unlock all-at-once after this many seconds.
 * - `LinearWithCliff`: no tokens until this point; linear from here to end.
 */
cliff_duration: u64;
  /**
 * Vesting duration in seconds.
 */
duration: u64;
  /**
 * Address that created and funded this schedule.
 */
grantor: string;
  id: u64;
  kind: VestingKind;
  /**
 * Whether the grantor can revoke unvested tokens.
 */
revocable: boolean;
  /**
 * Whether this schedule has been revoked.
 */
revoked: boolean;
  /**
 * Unix timestamp when vesting begins.
 */
start_time: u64;
  /**
 * Stellar asset contract for the vested token.
 */
token: string;
  /**
 * Total tokens locked into this schedule (in stroops / base units).
 */
total_amount: i128;
  /**
 * Tokens that were vested at the moment of revocation.
 * Zero for non-revoked schedules. Used so the beneficiary can still
 * claim already-vested tokens after a revocation.
 */
vested_at_revoke: i128;
}

export interface Client {
  /**
   * Construct and simulate a claim transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Claim all currently vested but unclaimed tokens.
   *
   * Vested-but-unclaimed tokens remain claimable even after a revocation.
   *
   * # Errors
   *
   * Panics with `"Schedule not found"` if `schedule_id` does not exist.
   * Panics with `"Nothing to claim yet"` if no tokens are currently claimable.
   */
  claim: ({schedule_id}: {schedule_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a revoke transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Revoke a vesting schedule (grantor only, revocable schedules only).
   * Unvested tokens are returned to the grantor. Already-vested tokens
   * remain claimable by the beneficiary.
   *
   * # Errors
   *
   * Panics with `"Schedule not found"` if `schedule_id` does not exist.
   * Panics with `"Schedule is not revocable"` if the schedule is irrevocable.
   * Panics with `"Already revoked"` if the schedule has already been revoked.
   */
  revoke: ({schedule_id}: {schedule_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a claimable transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Preview how many tokens are claimable right now for a given schedule.
   *
   * Returns 0 if `schedule_id` is unknown (does not panic).
   */
  claimable: ({schedule_id}: {schedule_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a get_schedule transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Read a vesting schedule by ID.
   *
   * # Errors
   *
   * Panics with `"Schedule not found"` if `schedule_id` does not exist.
   */
  get_schedule: ({schedule_id}: {schedule_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<VestingSchedule>>

  /**
   * Construct and simulate a cancel_upgrade transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Cancel the currently pending upgrade announcement.
   *
   * # Errors
   *
   * Panics with `"No pending upgrade"` when no upgrade is pending.
   */
  cancel_upgrade: ({authority}: {authority: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a claimable_bulk transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Batch view: return claimable amounts for multiple schedule IDs in a
   * single simulation round-trip.
   *
   * Results are returned in the same order as the input `ids` vector.
   * Unknown IDs return 0 instead of panicking, so the caller can safely
   * pass the full ID range without knowing which ones exist.
   *
   * This replaces the `Promise.all(claimable)` pattern in the frontend
   * dashboard, reducing N simulation round-trips to 1.
   */
  claimable_bulk: ({ids}: {ids: Array<u64>}, options?: MethodOptions) => Promise<AssembledTransaction<Array<i128>>>

  /**
   * Construct and simulate a schedule_count transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * How many schedules have been created in total.
   */
  schedule_count: (options?: MethodOptions) => Promise<AssembledTransaction<u64>>

  /**
   * Construct and simulate a create_schedule transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Create a new vesting schedule and lock the tokens into the contract.
   *
   * The grantor must approve the contract to transfer `total_amount` of
   * `token` before calling this function.
   *
   * # Errors
   *
   * Panics with `"Amount must be positive"` if `total_amount` ≤ 0.
   * Panics with `"Duration must be positive"` if `duration` = 0.
   * Panics with `"Cliff cannot exceed duration"` if `cliff_duration` > `duration`.
   * Panics with `"Beneficiary must differ from grantor"` if `beneficiary == grantor`.
   */
  create_schedule: ({grantor, beneficiary, token, total_amount, start_time, duration, cliff_duration, kind, revocable}: {grantor: string, beneficiary: string, token: string, total_amount: i128, start_time: u64, duration: u64, cliff_duration: u64, kind: VestingKind, revocable: boolean}, options?: MethodOptions) => Promise<AssembledTransaction<u64>>

  /**
   * Construct and simulate a execute_upgrade transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Execute the pending contract WASM migration after the 48-hour timelock.
   *
   * The pending upgrade must have been announced on-chain by
   * [`announce_upgrade`] at least [`UPGRADE_TIMELOCK_SECONDS`] earlier.
   * Soroban applies the WASM replacement only after this invocation
   * completes successfully.
   *
   * # Errors
   *
   * Panics with `"No pending upgrade"` when no upgrade is pending.
   * Panics with `"Upgrade timelock still active"` before 48 hours elapse.
   */
  execute_upgrade: ({authority}: {authority: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a pending_upgrade transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return the pending upgrade announcement, if any.
   */
  pending_upgrade: (options?: MethodOptions) => Promise<AssembledTransaction<Option<PendingUpgrade>>>

  /**
   * Construct and simulate a announce_upgrade transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Announce an upcoming contract WASM migration on-chain.
   *
   * The WASM identified by `wasm_hash` should already be uploaded. This
   * function does not migrate the contract; it stores the pending upgrade
   * and emits an announcement event with an execution time 48 hours in the
   * future so users and monitoring systems can react before the change.
   *
   * # Errors
   *
   * Panics with `"Upgrade authority not initialized"` if unset.
   * Panics with `"Unauthorized upgrade authority"` if `authority` is not the configured authority.
   */
  announce_upgrade: ({authority, wasm_hash}: {authority: string, wasm_hash: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<PendingUpgrade>>

  /**
   * Construct and simulate a upgrade_authority transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return the configured upgrade authority.
   *
   * # Errors
   *
   * Panics with `"Upgrade authority not initialized"` if unset.
   */
  upgrade_authority: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a transfer_beneficiary transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Transfer beneficiary rights to a new address.
   *
   * Only the current beneficiary may call this. The schedule must not be
   * revoked. Emits a `bnf_chng` event with
   * `(schedule_id, old_beneficiary, new_beneficiary)`.
   *
   * # Errors
   *
   * Panics with `"Schedule not found"` if `schedule_id` does not exist.
   * Panics with `"Schedule has been revoked"` if the schedule was revoked.
   */
  transfer_beneficiary: ({schedule_id, new_beneficiary}: {schedule_id: u64, new_beneficiary: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a get_schedules_by_grantor transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return schedule IDs created by a given grantor.
   *
   * Returns an empty vec if the grantor has not created any schedules.
   */
  get_schedules_by_grantor: ({grantor}: {grantor: string}, options?: MethodOptions) => Promise<AssembledTransaction<Array<u64>>>

  /**
   * Construct and simulate a get_schedules_by_beneficiary transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return schedule IDs where the given address is the beneficiary.
   *
   * Returns an empty vec if the address has no beneficiary schedules.
   */
  get_schedules_by_beneficiary: ({beneficiary}: {beneficiary: string}, options?: MethodOptions) => Promise<AssembledTransaction<Array<u64>>>

  /**
   * Construct and simulate a initialize_upgrade_authority transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Initialize the address that may announce and execute contract upgrades.
   *
   * This may only be called once, and the chosen authority must authorize
   * the call. Once initialized, every contract WASM migration must be
   * announced with [`announce_upgrade`] and wait at least 48 hours before
   * [`execute_upgrade`] can apply it.
   *
   * # Errors
   *
   * Panics with `"Upgrade authority already initialized"` if called again.
   */
  initialize_upgrade_authority: ({authority}: {authority: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
    /** Options for initializing a Client as well as for calling a method, with extras specific to deploying. */
    options: MethodOptions &
      Omit<ContractClientOptions, "contractId"> & {
        /** The hash of the Wasm blob, which must already be installed on-chain. */
        wasmHash: Buffer | string;
        /** Salt used to generate the contract's ID. Passed through to {@link Operation.createCustomContract}. Default: random. */
        salt?: Buffer | Uint8Array;
        /** The format used to decode `wasmHash`, if it's provided as a string. */
        format?: "hex" | "base64";
      }
  ): Promise<AssembledTransaction<T>> {
    return ContractClient.deploy(null, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAAAAAAARFDbGFpbSBhbGwgY3VycmVudGx5IHZlc3RlZCBidXQgdW5jbGFpbWVkIHRva2Vucy4KClZlc3RlZC1idXQtdW5jbGFpbWVkIHRva2VucyByZW1haW4gY2xhaW1hYmxlIGV2ZW4gYWZ0ZXIgYSByZXZvY2F0aW9uLgoKIyBFcnJvcnMKClBhbmljcyB3aXRoIGAiU2NoZWR1bGUgbm90IGZvdW5kImAgaWYgYHNjaGVkdWxlX2lkYCBkb2VzIG5vdCBleGlzdC4KUGFuaWNzIHdpdGggYCJOb3RoaW5nIHRvIGNsYWltIHlldCJgIGlmIG5vIHRva2VucyBhcmUgY3VycmVudGx5IGNsYWltYWJsZS4AAAAAAAAFY2xhaW0AAAAAAAABAAAAAAAAAAtzY2hlZHVsZV9pZAAAAAAGAAAAAA==",
        "AAAAAAAAAY5SZXZva2UgYSB2ZXN0aW5nIHNjaGVkdWxlIChncmFudG9yIG9ubHksIHJldm9jYWJsZSBzY2hlZHVsZXMgb25seSkuClVudmVzdGVkIHRva2VucyBhcmUgcmV0dXJuZWQgdG8gdGhlIGdyYW50b3IuIEFscmVhZHktdmVzdGVkIHRva2VucwpyZW1haW4gY2xhaW1hYmxlIGJ5IHRoZSBiZW5lZmljaWFyeS4KCiMgRXJyb3JzCgpQYW5pY3Mgd2l0aCBgIlNjaGVkdWxlIG5vdCBmb3VuZCJgIGlmIGBzY2hlZHVsZV9pZGAgZG9lcyBub3QgZXhpc3QuClBhbmljcyB3aXRoIGAiU2NoZWR1bGUgaXMgbm90IHJldm9jYWJsZSJgIGlmIHRoZSBzY2hlZHVsZSBpcyBpcnJldm9jYWJsZS4KUGFuaWNzIHdpdGggYCJBbHJlYWR5IHJldm9rZWQiYCBpZiB0aGUgc2NoZWR1bGUgaGFzIGFscmVhZHkgYmVlbiByZXZva2VkLgAAAAAABnJldm9rZQAAAAAAAQAAAAAAAAALc2NoZWR1bGVfaWQAAAAABgAAAAA=",
        "AAAAAAAAAH5QcmV2aWV3IGhvdyBtYW55IHRva2VucyBhcmUgY2xhaW1hYmxlIHJpZ2h0IG5vdyBmb3IgYSBnaXZlbiBzY2hlZHVsZS4KClJldHVybnMgMCBpZiBgc2NoZWR1bGVfaWRgIGlzIHVua25vd24gKGRvZXMgbm90IHBhbmljKS4AAAAAAAljbGFpbWFibGUAAAAAAAABAAAAAAAAAAtzY2hlZHVsZV9pZAAAAAAGAAAAAQAAAAs=",
        "AAAAAgAAAAAAAAAAAAAAB0RhdGFLZXkAAAAABwAAAAEAAAAAAAAACFNjaGVkdWxlAAAAAQAAAAYAAAAAAAAAAAAAAA1TY2hlZHVsZUNvdW50AAAAAAAAAAAAAFZSZS1lbnRyYW5jeSBndWFyZCBmbGFnLgpTZXQgdG8gYHRydWVgIHdoaWxlIGEgc3RhdGUtbXV0YXRpbmcgZW50cnkgcG9pbnQgaXMgZXhlY3V0aW5nLgAAAAAABkxvY2tlZAAAAAAAAAAAAEZBZGRyZXNzIGF1dGhvcml6ZWQgdG8gYW5ub3VuY2UsIGV4ZWN1dGUsIGFuZCBjYW5jZWwgY29udHJhY3QgdXBncmFkZXMuAAAAAAAQVXBncmFkZUF1dGhvcml0eQAAAAAAAAAxVGhlIGN1cnJlbnRseSBhbm5vdW5jZWQgY29udHJhY3QgdXBncmFkZSwgaWYgYW55LgAAAAAAAA5QZW5kaW5nVXBncmFkZQAAAAAAAQAAACtJbmRleCBvZiBzY2hlZHVsZSBJRHMgY3JlYXRlZCBieSBhIGdyYW50b3IuAAAAABBHcmFudG9yU2NoZWR1bGVzAAAAAQAAABMAAAABAAAAOkluZGV4IG9mIHNjaGVkdWxlIElEcyB3aGVyZSBhbiBhZGRyZXNzIGlzIHRoZSBiZW5lZmljaWFyeS4AAAAAABRCZW5lZmljaWFyeVNjaGVkdWxlcwAAAAEAAAAT",
        "AAAAAAAAAG1SZWFkIGEgdmVzdGluZyBzY2hlZHVsZSBieSBJRC4KCiMgRXJyb3JzCgpQYW5pY3Mgd2l0aCBgIlNjaGVkdWxlIG5vdCBmb3VuZCJgIGlmIGBzY2hlZHVsZV9pZGAgZG9lcyBub3QgZXhpc3QuAAAAAAAADGdldF9zY2hlZHVsZQAAAAEAAAAAAAAAC3NjaGVkdWxlX2lkAAAAAAYAAAABAAAH0AAAAA9WZXN0aW5nU2NoZWR1bGUA",
        "AAAAAgAAADBUaGUgdHlwZSBvZiB2ZXN0aW5nIGN1cnZlIGFwcGxpZWQgdG8gYSBzY2hlZHVsZS4AAAAAAAAAC1Zlc3RpbmdLaW5kAAAAAAMAAAAAAAAAfFRva2VucyB1bmxvY2sgbGluZWFybHkgZnJvbSBgc3RhcnRfdGltZWAgdG8gYHN0YXJ0X3RpbWUgKyBkdXJhdGlvbmAuClRoZSBgY2xpZmZfZHVyYXRpb25gIGZpZWxkIGlzIGlnbm9yZWQgZm9yIHRoaXMgdmFyaWFudC4AAAAGTGluZWFyAAAAAAAAAAAAW05vIHRva2VucyB1bmxvY2sgdW50aWwgYHN0YXJ0X3RpbWUgKyBjbGlmZl9kdXJhdGlvbmAsIHRoZW4gdGhlIGZ1bGwKYW1vdW50IHVubG9ja3MgYXQgb25jZS4AAAAABUNsaWZmAAAAAAAAAAAAAR9ObyB0b2tlbnMgdW5sb2NrIHVudGlsIGBzdGFydF90aW1lICsgY2xpZmZfZHVyYXRpb25gICh0aGUgY2xpZmYpLgpBZnRlciB0aGUgY2xpZmYsIHRva2VucyB1bmxvY2sgbGluZWFybHkgZnJvbSB0aGUgY2xpZmYgZGF0ZSB0bwpgc3RhcnRfdGltZSArIGR1cmF0aW9uYC4KClRoaXMgbW9kZWxzIHRoZSBtb3N0IGNvbW1vbiByZWFsLXdvcmxkIGVtcGxveWVlIHZlc3Rpbmcgc2NoZWR1bGU6CmEgMS15ZWFyIGNsaWZmIGZvbGxvd2VkIGJ5IGxpbmVhciB2ZXN0aW5nIG92ZXIgdGhlIHJlbWFpbmluZyB0ZXJtLgAAAAAPTGluZWFyV2l0aENsaWZmAA==",
        "AAAAAAAAAHxDYW5jZWwgdGhlIGN1cnJlbnRseSBwZW5kaW5nIHVwZ3JhZGUgYW5ub3VuY2VtZW50LgoKIyBFcnJvcnMKClBhbmljcyB3aXRoIGAiTm8gcGVuZGluZyB1cGdyYWRlImAgd2hlbiBubyB1cGdyYWRlIGlzIHBlbmRpbmcuAAAADmNhbmNlbF91cGdyYWRlAAAAAAABAAAAAAAAAAlhdXRob3JpdHkAAAAAAAATAAAAAA==",
        "AAAAAAAAAZhCYXRjaCB2aWV3OiByZXR1cm4gY2xhaW1hYmxlIGFtb3VudHMgZm9yIG11bHRpcGxlIHNjaGVkdWxlIElEcyBpbiBhCnNpbmdsZSBzaW11bGF0aW9uIHJvdW5kLXRyaXAuCgpSZXN1bHRzIGFyZSByZXR1cm5lZCBpbiB0aGUgc2FtZSBvcmRlciBhcyB0aGUgaW5wdXQgYGlkc2AgdmVjdG9yLgpVbmtub3duIElEcyByZXR1cm4gMCBpbnN0ZWFkIG9mIHBhbmlja2luZywgc28gdGhlIGNhbGxlciBjYW4gc2FmZWx5CnBhc3MgdGhlIGZ1bGwgSUQgcmFuZ2Ugd2l0aG91dCBrbm93aW5nIHdoaWNoIG9uZXMgZXhpc3QuCgpUaGlzIHJlcGxhY2VzIHRoZSBgUHJvbWlzZS5hbGwoY2xhaW1hYmxlKWAgcGF0dGVybiBpbiB0aGUgZnJvbnRlbmQKZGFzaGJvYXJkLCByZWR1Y2luZyBOIHNpbXVsYXRpb24gcm91bmQtdHJpcHMgdG8gMS4AAAAOY2xhaW1hYmxlX2J1bGsAAAAAAAEAAAAAAAAAA2lkcwAAAAPqAAAABgAAAAEAAAPqAAAACw==",
        "AAAAAAAAAC5Ib3cgbWFueSBzY2hlZHVsZXMgaGF2ZSBiZWVuIGNyZWF0ZWQgaW4gdG90YWwuAAAAAAAOc2NoZWR1bGVfY291bnQAAAAAAAAAAAABAAAABg==",
        "AAAAAAAAAdlDcmVhdGUgYSBuZXcgdmVzdGluZyBzY2hlZHVsZSBhbmQgbG9jayB0aGUgdG9rZW5zIGludG8gdGhlIGNvbnRyYWN0LgoKVGhlIGdyYW50b3IgbXVzdCBhcHByb3ZlIHRoZSBjb250cmFjdCB0byB0cmFuc2ZlciBgdG90YWxfYW1vdW50YCBvZgpgdG9rZW5gIGJlZm9yZSBjYWxsaW5nIHRoaXMgZnVuY3Rpb24uCgojIEVycm9ycwoKUGFuaWNzIHdpdGggYCJBbW91bnQgbXVzdCBiZSBwb3NpdGl2ZSJgIGlmIGB0b3RhbF9hbW91bnRgIOKJpCAwLgpQYW5pY3Mgd2l0aCBgIkR1cmF0aW9uIG11c3QgYmUgcG9zaXRpdmUiYCBpZiBgZHVyYXRpb25gID0gMC4KUGFuaWNzIHdpdGggYCJDbGlmZiBjYW5ub3QgZXhjZWVkIGR1cmF0aW9uImAgaWYgYGNsaWZmX2R1cmF0aW9uYCA+IGBkdXJhdGlvbmAuClBhbmljcyB3aXRoIGAiQmVuZWZpY2lhcnkgbXVzdCBkaWZmZXIgZnJvbSBncmFudG9yImAgaWYgYGJlbmVmaWNpYXJ5ID09IGdyYW50b3JgLgAAAAAAAA9jcmVhdGVfc2NoZWR1bGUAAAAACQAAAAAAAAAHZ3JhbnRvcgAAAAATAAAAAAAAAAtiZW5lZmljaWFyeQAAAAATAAAAAAAAAAV0b2tlbgAAAAAAABMAAAAAAAAADHRvdGFsX2Ftb3VudAAAAAsAAAAAAAAACnN0YXJ0X3RpbWUAAAAAAAYAAAAAAAAACGR1cmF0aW9uAAAABgAAAAAAAAAOY2xpZmZfZHVyYXRpb24AAAAAAAYAAAAAAAAABGtpbmQAAAfQAAAAC1Zlc3RpbmdLaW5kAAAAAAAAAAAJcmV2b2NhYmxlAAAAAAAAAQAAAAEAAAAG",
        "AAAAAAAAAa1FeGVjdXRlIHRoZSBwZW5kaW5nIGNvbnRyYWN0IFdBU00gbWlncmF0aW9uIGFmdGVyIHRoZSA0OC1ob3VyIHRpbWVsb2NrLgoKVGhlIHBlbmRpbmcgdXBncmFkZSBtdXN0IGhhdmUgYmVlbiBhbm5vdW5jZWQgb24tY2hhaW4gYnkKW2Bhbm5vdW5jZV91cGdyYWRlYF0gYXQgbGVhc3QgW2BVUEdSQURFX1RJTUVMT0NLX1NFQ09ORFNgXSBlYXJsaWVyLgpTb3JvYmFuIGFwcGxpZXMgdGhlIFdBU00gcmVwbGFjZW1lbnQgb25seSBhZnRlciB0aGlzIGludm9jYXRpb24KY29tcGxldGVzIHN1Y2Nlc3NmdWxseS4KCiMgRXJyb3JzCgpQYW5pY3Mgd2l0aCBgIk5vIHBlbmRpbmcgdXBncmFkZSJgIHdoZW4gbm8gdXBncmFkZSBpcyBwZW5kaW5nLgpQYW5pY3Mgd2l0aCBgIlVwZ3JhZGUgdGltZWxvY2sgc3RpbGwgYWN0aXZlImAgYmVmb3JlIDQ4IGhvdXJzIGVsYXBzZS4AAAAAAAAPZXhlY3V0ZV91cGdyYWRlAAAAAAEAAAAAAAAACWF1dGhvcml0eQAAAAAAABMAAAAA",
        "AAAAAAAAADBSZXR1cm4gdGhlIHBlbmRpbmcgdXBncmFkZSBhbm5vdW5jZW1lbnQsIGlmIGFueS4AAAAPcGVuZGluZ191cGdyYWRlAAAAAAAAAAABAAAD6AAAB9AAAAAOUGVuZGluZ1VwZ3JhZGUAAA==",
        "AAAAAAAAAfJBbm5vdW5jZSBhbiB1cGNvbWluZyBjb250cmFjdCBXQVNNIG1pZ3JhdGlvbiBvbi1jaGFpbi4KClRoZSBXQVNNIGlkZW50aWZpZWQgYnkgYHdhc21faGFzaGAgc2hvdWxkIGFscmVhZHkgYmUgdXBsb2FkZWQuIFRoaXMKZnVuY3Rpb24gZG9lcyBub3QgbWlncmF0ZSB0aGUgY29udHJhY3Q7IGl0IHN0b3JlcyB0aGUgcGVuZGluZyB1cGdyYWRlCmFuZCBlbWl0cyBhbiBhbm5vdW5jZW1lbnQgZXZlbnQgd2l0aCBhbiBleGVjdXRpb24gdGltZSA0OCBob3VycyBpbiB0aGUKZnV0dXJlIHNvIHVzZXJzIGFuZCBtb25pdG9yaW5nIHN5c3RlbXMgY2FuIHJlYWN0IGJlZm9yZSB0aGUgY2hhbmdlLgoKIyBFcnJvcnMKClBhbmljcyB3aXRoIGAiVXBncmFkZSBhdXRob3JpdHkgbm90IGluaXRpYWxpemVkImAgaWYgdW5zZXQuClBhbmljcyB3aXRoIGAiVW5hdXRob3JpemVkIHVwZ3JhZGUgYXV0aG9yaXR5ImAgaWYgYGF1dGhvcml0eWAgaXMgbm90IHRoZSBjb25maWd1cmVkIGF1dGhvcml0eS4AAAAAABBhbm5vdW5jZV91cGdyYWRlAAAAAgAAAAAAAAAJYXV0aG9yaXR5AAAAAAAAEwAAAAAAAAAJd2FzbV9oYXNoAAAAAAAD7gAAACAAAAABAAAH0AAAAA5QZW5kaW5nVXBncmFkZQAA",
        "AAAAAQAAAE5BIGNvbnRyYWN0IFdBU00gdXBncmFkZSB0aGF0IGhhcyBiZWVuIGFubm91bmNlZCBvbi1jaGFpbiBidXQgbm90IHlldCBleGVjdXRlZC4AAAAAAAAAAAAOUGVuZGluZ1VwZ3JhZGUAAAAAAAMAAAAwTGVkZ2VyIHRpbWVzdGFtcCB3aGVuIHRoZSB1cGdyYWRlIHdhcyBhbm5vdW5jZWQuAAAADGFubm91bmNlZF9hdAAAAAYAAAA7RWFybGllc3QgbGVkZ2VyIHRpbWVzdGFtcCB3aGVuIHRoZSB1cGdyYWRlIG1heSBiZSBleGVjdXRlZC4AAAAADWV4ZWN1dGFibGVfYXQAAAAAAAAGAAAAQ0hhc2ggb2YgdGhlIGFscmVhZHktdXBsb2FkZWQgV0FTTSBibG9iIHRvIG1pZ3JhdGUgdGhpcyBjb250cmFjdCB0by4AAAAACXdhc21faGFzaAAAAAAAA+4AAAAg",
        "AAAAAAAAAG9SZXR1cm4gdGhlIGNvbmZpZ3VyZWQgdXBncmFkZSBhdXRob3JpdHkuCgojIEVycm9ycwoKUGFuaWNzIHdpdGggYCJVcGdyYWRlIGF1dGhvcml0eSBub3QgaW5pdGlhbGl6ZWQiYCBpZiB1bnNldC4AAAAAEXVwZ3JhZGVfYXV0aG9yaXR5AAAAAAAAAAAAAAEAAAAT",
        "AAAAAQAAAAAAAAAAAAAAD1Zlc3RpbmdTY2hlZHVsZQAAAAANAAAAJUFkZHJlc3MgdGhhdCBjYW4gY2xhaW0gdmVzdGVkIHRva2Vucy4AAAAAAAALYmVuZWZpY2lhcnkAAAAAEwAAACpUb2tlbnMgYWxyZWFkeSBjbGFpbWVkIGJ5IHRoZSBiZW5lZmljaWFyeS4AAAAAAAdjbGFpbWVkAAAAAAsAAADBQ2xpZmYgaW4gc2Vjb25kcyBmcm9tIGBzdGFydF90aW1lYC4KCi0gYExpbmVhcmA6IGlnbm9yZWQuCi0gYENsaWZmYDogdG9rZW5zIHVubG9jayBhbGwtYXQtb25jZSBhZnRlciB0aGlzIG1hbnkgc2Vjb25kcy4KLSBgTGluZWFyV2l0aENsaWZmYDogbm8gdG9rZW5zIHVudGlsIHRoaXMgcG9pbnQ7IGxpbmVhciBmcm9tIGhlcmUgdG8gZW5kLgAAAAAAAA5jbGlmZl9kdXJhdGlvbgAAAAAABgAAABxWZXN0aW5nIGR1cmF0aW9uIGluIHNlY29uZHMuAAAACGR1cmF0aW9uAAAABgAAAC5BZGRyZXNzIHRoYXQgY3JlYXRlZCBhbmQgZnVuZGVkIHRoaXMgc2NoZWR1bGUuAAAAAAAHZ3JhbnRvcgAAAAATAAAAAAAAAAJpZAAAAAAABgAAAAAAAAAEa2luZAAAB9AAAAALVmVzdGluZ0tpbmQAAAAAL1doZXRoZXIgdGhlIGdyYW50b3IgY2FuIHJldm9rZSB1bnZlc3RlZCB0b2tlbnMuAAAAAAlyZXZvY2FibGUAAAAAAAABAAAAJ1doZXRoZXIgdGhpcyBzY2hlZHVsZSBoYXMgYmVlbiByZXZva2VkLgAAAAAHcmV2b2tlZAAAAAABAAAAI1VuaXggdGltZXN0YW1wIHdoZW4gdmVzdGluZyBiZWdpbnMuAAAAAApzdGFydF90aW1lAAAAAAAGAAAALFN0ZWxsYXIgYXNzZXQgY29udHJhY3QgZm9yIHRoZSB2ZXN0ZWQgdG9rZW4uAAAABXRva2VuAAAAAAAAEwAAAEFUb3RhbCB0b2tlbnMgbG9ja2VkIGludG8gdGhpcyBzY2hlZHVsZSAoaW4gc3Ryb29wcyAvIGJhc2UgdW5pdHMpLgAAAAAAAAx0b3RhbF9hbW91bnQAAAALAAAAplRva2VucyB0aGF0IHdlcmUgdmVzdGVkIGF0IHRoZSBtb21lbnQgb2YgcmV2b2NhdGlvbi4KWmVybyBmb3Igbm9uLXJldm9rZWQgc2NoZWR1bGVzLiBVc2VkIHNvIHRoZSBiZW5lZmljaWFyeSBjYW4gc3RpbGwKY2xhaW0gYWxyZWFkeS12ZXN0ZWQgdG9rZW5zIGFmdGVyIGEgcmV2b2NhdGlvbi4AAAAAABB2ZXN0ZWRfYXRfcmV2b2tlAAAACw==",
        "AAAAAAAAAWNUcmFuc2ZlciBiZW5lZmljaWFyeSByaWdodHMgdG8gYSBuZXcgYWRkcmVzcy4KCk9ubHkgdGhlIGN1cnJlbnQgYmVuZWZpY2lhcnkgbWF5IGNhbGwgdGhpcy4gVGhlIHNjaGVkdWxlIG11c3Qgbm90IGJlCnJldm9rZWQuIEVtaXRzIGEgYGJuZl9jaG5nYCBldmVudCB3aXRoCmAoc2NoZWR1bGVfaWQsIG9sZF9iZW5lZmljaWFyeSwgbmV3X2JlbmVmaWNpYXJ5KWAuCgojIEVycm9ycwoKUGFuaWNzIHdpdGggYCJTY2hlZHVsZSBub3QgZm91bmQiYCBpZiBgc2NoZWR1bGVfaWRgIGRvZXMgbm90IGV4aXN0LgpQYW5pY3Mgd2l0aCBgIlNjaGVkdWxlIGhhcyBiZWVuIHJldm9rZWQiYCBpZiB0aGUgc2NoZWR1bGUgd2FzIHJldm9rZWQuAAAAABR0cmFuc2Zlcl9iZW5lZmljaWFyeQAAAAIAAAAAAAAAC3NjaGVkdWxlX2lkAAAAAAYAAAAAAAAAD25ld19iZW5lZmljaWFyeQAAAAATAAAAAA==",
        "AAAAAAAAAHNSZXR1cm4gc2NoZWR1bGUgSURzIGNyZWF0ZWQgYnkgYSBnaXZlbiBncmFudG9yLgoKUmV0dXJucyBhbiBlbXB0eSB2ZWMgaWYgdGhlIGdyYW50b3IgaGFzIG5vdCBjcmVhdGVkIGFueSBzY2hlZHVsZXMuAAAAABhnZXRfc2NoZWR1bGVzX2J5X2dyYW50b3IAAAABAAAAAAAAAAdncmFudG9yAAAAABMAAAABAAAD6gAAAAY=",
        "AAAAAAAAAIJSZXR1cm4gc2NoZWR1bGUgSURzIHdoZXJlIHRoZSBnaXZlbiBhZGRyZXNzIGlzIHRoZSBiZW5lZmljaWFyeS4KClJldHVybnMgYW4gZW1wdHkgdmVjIGlmIHRoZSBhZGRyZXNzIGhhcyBubyBiZW5lZmljaWFyeSBzY2hlZHVsZXMuAAAAAAAcZ2V0X3NjaGVkdWxlc19ieV9iZW5lZmljaWFyeQAAAAEAAAAAAAAAC2JlbmVmaWNpYXJ5AAAAABMAAAABAAAD6gAAAAY=",
        "AAAAAAAAAYpJbml0aWFsaXplIHRoZSBhZGRyZXNzIHRoYXQgbWF5IGFubm91bmNlIGFuZCBleGVjdXRlIGNvbnRyYWN0IHVwZ3JhZGVzLgoKVGhpcyBtYXkgb25seSBiZSBjYWxsZWQgb25jZSwgYW5kIHRoZSBjaG9zZW4gYXV0aG9yaXR5IG11c3QgYXV0aG9yaXplCnRoZSBjYWxsLiBPbmNlIGluaXRpYWxpemVkLCBldmVyeSBjb250cmFjdCBXQVNNIG1pZ3JhdGlvbiBtdXN0IGJlCmFubm91bmNlZCB3aXRoIFtgYW5ub3VuY2VfdXBncmFkZWBdIGFuZCB3YWl0IGF0IGxlYXN0IDQ4IGhvdXJzIGJlZm9yZQpbYGV4ZWN1dGVfdXBncmFkZWBdIGNhbiBhcHBseSBpdC4KCiMgRXJyb3JzCgpQYW5pY3Mgd2l0aCBgIlVwZ3JhZGUgYXV0aG9yaXR5IGFscmVhZHkgaW5pdGlhbGl6ZWQiYCBpZiBjYWxsZWQgYWdhaW4uAAAAAAAcaW5pdGlhbGl6ZV91cGdyYWRlX2F1dGhvcml0eQAAAAEAAAAAAAAACWF1dGhvcml0eQAAAAAAABMAAAAA" ]),
      options
    )
  }
  public readonly fromJSON = {
    claim: this.txFromJSON<null>,
        revoke: this.txFromJSON<null>,
        claimable: this.txFromJSON<i128>,
        get_schedule: this.txFromJSON<VestingSchedule>,
        cancel_upgrade: this.txFromJSON<null>,
        claimable_bulk: this.txFromJSON<Array<i128>>,
        schedule_count: this.txFromJSON<u64>,
        create_schedule: this.txFromJSON<u64>,
        execute_upgrade: this.txFromJSON<null>,
        pending_upgrade: this.txFromJSON<Option<PendingUpgrade>>,
        announce_upgrade: this.txFromJSON<PendingUpgrade>,
        upgrade_authority: this.txFromJSON<string>,
        transfer_beneficiary: this.txFromJSON<null>,
        get_schedules_by_grantor: this.txFromJSON<Array<u64>>,
        get_schedules_by_beneficiary: this.txFromJSON<Array<u64>>,
        initialize_upgrade_authority: this.txFromJSON<null>
  }
}