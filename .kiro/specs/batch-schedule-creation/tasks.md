# Implementation Plan: Batch Schedule Creation

## Overview

Eleven tasks implement the `create_schedules_batch` entry point. Tasks 1–2 lay the structural groundwork (new struct, refactored helper). Task 3 adds the entry point itself. Task 4 updates documentation. Tasks 5–10 add the six required tests. Task 11 runs final verification.

---

## Tasks

- [ ] 1. Define `CreateScheduleParams` struct
  - Add `#[contracttype] #[derive(Clone)] pub struct CreateScheduleParams` with fields `beneficiary: Address`, `token: Address`, `total_amount: i128`, `start_time: u64`, `duration: u64`, `cliff_duration: u64`, `kind: VestingKind`, `revocable: bool` to `lib.rs`, immediately after the `VestingKind` enum.
  - Confirm the struct is `pub` so tests and off-chain clients can import it.
  - _Requirements: 2.1, 2.2_

- [ ] 2. Extract `create_one` private helper from `create_schedule`
  - Add `fn create_one(env: &Env, grantor: &Address, params: CreateScheduleParams) -> u64` inside `impl VestFlowContract`.
  - Move the body of `create_schedule` (everything after `grantor.require_auth()`) into `create_one`, accessing fields via `params`.
  - Update `create_schedule` to build a `CreateScheduleParams` from its flat arguments and call `Self::create_one`.
  - Run `cargo test` to confirm all existing tests pass before continuing.
  - _Requirements: 2.1, 5.1, 5.2, 5.3, 5.4_

- [ ] 3. Implement `create_schedules_batch` entry point
  - Add the doc comment stating: Safe_Batch_Limit is 20, enforced as a runtime panic, and grantor must pre-approve each token's summed batch amount.
  - Implement guard ordering: oversized check (`> 20`) first, empty check (`== 0`) second, `grantor.require_auth()` third.
  - Iterate `schedules`, call `Self::create_one(&env, &grantor, params)` per entry, collect IDs into `Vec<u64>`, return it.
  - _Requirements: 1.1–1.5, 3.1–3.4, 4.1–4.6, 5.1–5.4, 6.1–6.3, 7.1–7.3_

- [ ] 4. Update module-level error table
  - Append two rows to the `//!` doc error table in `lib.rs`:
    - `"Batch must not be empty"` — `create_schedules_batch` with zero entries
    - `"Batch size exceeds safe limit of 20"` — `create_schedules_batch` with > 20 entries
  - _Requirements: 7.1, 7.2_

- [ ] 5. Write test `test_batch_of_one`
  - Record contract token balance before the call via `TokenClient::balance`.
  - Call `create_schedules_batch` with 1 valid `CreateScheduleParams`.
  - Assert returned vec length is 1, `get_schedule(id)` returns matching fields, and contract balance increased by exactly `total_amount`.
  - _Requirements: 8.1_

- [ ] 6. Write test `test_batch_of_five`
  - Generate 5 distinct beneficiary addresses.
  - Call `create_schedules_batch` with 5 valid entries.
  - Assert returned vec length is 5, all IDs distinct, IDs consecutive, all schedules retrievable via `get_schedule`.
  - _Requirements: 8.2_

- [ ] 7. Write test `test_batch_empty_panics`
  - Add `#[should_panic(expected = "Batch must not be empty")]`.
  - Call `create_schedules_batch` with an empty `vec![&env]`.
  - _Requirements: 8.3_

- [ ] 8. Write test `test_batch_exceeds_limit_panics`
  - Add `#[should_panic(expected = "Batch size exceeds safe limit of 20")]`.
  - Build a vec of 21 valid entries and call `create_schedules_batch`.
  - _Requirements: 8.4_

- [ ] 9. Write test `test_batch_invalid_entry_panics`
  - Add `#[should_panic(expected = "Amount must be positive")]`.
  - Build a batch of 1 entry with `total_amount = 0` and call `create_schedules_batch`.
  - _Requirements: 8.5_

- [ ] 10. Write test `test_batch_grantor_index`
  - Call `create_schedules_batch` with 3 valid entries (different beneficiaries).
  - Call `get_schedules_by_grantor(grantor)` and assert all 3 IDs are present.
  - _Requirements: 8.6_

- [ ] 11. Final verification
  - Run `cargo test` from `contracts/` — all existing and new tests must pass.
  - Run `cargo build --target wasm32-unknown-unknown --release` — contract must compile to WASM without errors.
  - Run `cargo clippy` — no new warnings introduced.

---

## Task Dependency Graph

```json
{
  "waves": [
    { "wave": 1, "tasks": [1] },
    { "wave": 2, "tasks": [2] },
    { "wave": 3, "tasks": [3] },
    { "wave": 4, "tasks": [4, 5, 6, 7, 8, 9, 10] },
    { "wave": 5, "tasks": [11] }
  ]
}
```

Tasks 4–10 are independent of each other and can be written in any order once Task 3 is complete. Task 11 must be last.

---

## Notes

- The `create_one` refactor in Task 2 must not change `create_schedule`'s observable behaviour — the existing test suite is the regression gate.
- Soroban's `Vec<T>` is not a Rust `std::vec::Vec`; use `soroban_sdk::vec![&env]` to construct empty vecs in tests.
- Each `#[should_panic]` test runs in a fresh `Env::default()` with `mock_all_auths()`. State assertions after a panicking call must use a separate `Env` or be placed in a sibling non-panicking test.
- The `setup` helper already mints 10,000 tokens to the grantor. For the batch-of-five test, mint a larger amount (e.g. `5 * total_amount`) before the call.
