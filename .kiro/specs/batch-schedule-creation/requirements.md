# Requirements Document

## Introduction

This feature adds a `create_schedules_batch` entry point to the VestFlow Soroban smart contract. It allows a grantor to create multiple vesting schedules in a single transaction by providing a `Vec<CreateScheduleParams>`, and returns a `Vec<u64>` of the newly created schedule IDs. This replaces the pattern of calling `create_schedule` N times with N separate token approvals and N separate transaction fees, making bulk vesting grants (e.g., employee onboarding) practical on-chain.

## Glossary

- **VestFlow_Contract**: The Soroban smart contract at `contracts/vestflow/src/lib.rs` that manages vesting schedules.
- **Grantor**: The address that creates and funds vesting schedules.
- **Beneficiary**: The address entitled to claim vested tokens from a schedule.
- **CreateScheduleParams**: A Soroban `contracttype` struct grouping all parameters needed to create one vesting schedule (`beneficiary`, `token`, `total_amount`, `start_time`, `duration`, `cliff_duration`, `kind`, `revocable`).
- **Batch**: A `Vec<CreateScheduleParams>` passed to `create_schedules_batch` in a single transaction.
- **Schedule_ID**: A monotonically increasing `u64` assigned to each vesting schedule by the VestFlow_Contract.
- **Per-Token_Batch_Amount**: The sum of `total_amount` across all `CreateScheduleParams` entries in a batch that share the same `token` address.
- **Instruction_Budget**: Soroban's per-transaction CPU instruction limit. Larger batches consume proportionally more budget.
- **Safe_Batch_Limit**: The documented maximum recommended batch size (≤ 20 entries) that fits comfortably within the instruction budget.

---

## Requirements

### Requirement 1: Batch Entry Point

**User Story:** As a grantor, I want to create multiple vesting schedules in one transaction, so that I can onboard many beneficiaries efficiently without paying per-schedule transaction fees.

#### Acceptance Criteria

1. THE VestFlow_Contract SHALL expose a public entry point `create_schedules_batch(env: Env, grantor: Address, schedules: Vec<CreateScheduleParams>) -> Vec<u64>`.
2. IF `create_schedules_batch` is called with an empty `Vec<CreateScheduleParams>`, THEN THE VestFlow_Contract SHALL panic with the message `"Batch must not be empty"` before invoking `grantor.require_auth()` or processing any entry.
3. IF `create_schedules_batch` is called with a `Vec<CreateScheduleParams>` containing more than 20 entries, THEN THE VestFlow_Contract SHALL panic with the message `"Batch size exceeds safe limit of 20"` before invoking `grantor.require_auth()`, before any per-entry validation, and before any token transfer.
4. WHEN `create_schedules_batch` is called with a non-empty batch of 20 valid entries or fewer, THE VestFlow_Contract SHALL invoke `grantor.require_auth()` exactly once after the size checks pass.
5. WHEN `create_schedules_batch` is called with a non-empty batch of 20 valid entries or fewer, THE VestFlow_Contract SHALL return a `Vec<u64>` of newly assigned schedule IDs in the same positional order as the corresponding entries in the input `Vec<CreateScheduleParams>`.

---

### Requirement 2: Input Struct

**User Story:** As a grantor, I want a structured parameter type for each schedule in the batch, so that the call interface is clear and type-safe.

#### Acceptance Criteria

1. THE VestFlow_Contract SHALL define a Soroban `#[contracttype]` struct named `CreateScheduleParams` with exactly the following fields: `beneficiary: Address`, `token: Address`, `total_amount: i128`, `start_time: u64`, `duration: u64`, `cliff_duration: u64`, `kind: VestingKind`, `revocable: bool`.
2. THE `CreateScheduleParams` struct SHALL be marked `pub` and re-exported at the crate root so that off-chain clients and integration tests can import and construct values of this type without accessing internal modules.

---

### Requirement 3: Pre-approval and Token Transfer

**User Story:** As a grantor, I want the batch entry point to transfer tokens per schedule so that my single pre-approval of each token's total covers the full batch.

#### Acceptance Criteria

1. WHEN `create_schedules_batch` processes each entry, THE VestFlow_Contract SHALL call the token contract's `transfer(grantor, contract_address, entry.total_amount)` for that entry's `token` before writing that schedule's state to storage.
2. WHEN `create_schedules_batch` is called with a batch where all entries share the same `token` address, THE grantor's pre-approval of `Per-Token_Batch_Amount` for that token SHALL be sufficient to cover all transfers in the batch.
3. WHEN `create_schedules_batch` is called with a batch containing entries with different `token` addresses, THE grantor SHALL pre-approve the `Per-Token_Batch_Amount` for each distinct `token` address independently; the contract SHALL make no assumption that a single approval covers multiple token types.
4. IF the grantor's allowance for a given token is less than its `Per-Token_Batch_Amount` at the time the first transfer for that token is attempted, THEN the token contract's `transfer` call SHALL panic and the VestFlow_Contract SHALL propagate that panic, rolling back the entire batch.

---

### Requirement 4: Per-Schedule Validation

**User Story:** As a grantor, I want invalid schedule parameters to be caught immediately, so that I do not lose funds to a partially-processed batch.

#### Acceptance Criteria

1. IF any entry in the batch has `beneficiary == grantor`, THEN THE VestFlow_Contract SHALL panic with `"Beneficiary must differ from grantor"` before performing any token transfer for that entry.
2. IF any entry in the batch has `total_amount ≤ 0`, THEN THE VestFlow_Contract SHALL panic with `"Amount must be positive"` before performing any token transfer for that entry.
3. IF any entry in the batch has `duration == 0`, THEN THE VestFlow_Contract SHALL panic with `"Duration must be positive"` before performing any token transfer for that entry.
4. IF any entry in the batch has `cliff_duration > duration`, THEN THE VestFlow_Contract SHALL panic with `"Cliff cannot exceed duration"` before performing any token transfer for that entry.
5. THE VestFlow_Contract SHALL check each entry's fields in the following order: `beneficiary ≠ grantor`, then `total_amount > 0`, then `duration > 0`, then `cliff_duration ≤ duration`; the first failing check SHALL produce its associated panic message and no subsequent checks for that entry are performed.
6. WHEN any entry fails validation, THE VestFlow_Contract SHALL panic, causing Soroban's transaction engine to roll back all state changes so that no schedules from the batch are stored and no tokens are transferred.

---

### Requirement 5: Schedule ID Assignment and Indexing

**User Story:** As a grantor, I want each schedule in the batch to receive a unique, sequential ID and appear in all existing indexes, so that the batch behaves identically to calling `create_schedule` N times.

#### Acceptance Criteria

1. WHEN `create_schedules_batch` is called with a batch of N valid entries, THE VestFlow_Contract SHALL assign `Schedule_ID` values by reading the current `ScheduleCount`, assigning IDs `count`, `count+1`, … `count+N-1` in the same order as the input entries, and storing the new count as `count+N`; the first entry in the input SHALL receive the lowest ID.
2. WHEN `create_schedules_batch` is called, THE VestFlow_Contract SHALL add each new `Schedule_ID` to the grantor's `GrantorSchedules` index.
3. WHEN `create_schedules_batch` is called, THE VestFlow_Contract SHALL add each new `Schedule_ID` to the respective beneficiary's `BeneficiarySchedules` index.
4. WHEN `create_schedules_batch` is called, THE VestFlow_Contract SHALL emit one event per schedule using the topic `["created", contract_address]` and a data payload containing at minimum the `schedule_id: u64`, `grantor: Address`, and `beneficiary: Address` fields — identical in structure to the event emitted by `create_schedule`.

---

### Requirement 6: Atomic Failure Semantics

**User Story:** As a grantor, I want to know that a failing batch never creates partial state, so that my token balance and the contract's indexes remain consistent after any error.

#### Acceptance Criteria

1. WHEN any entry in the batch fails validation or token transfer, THE VestFlow_Contract SHALL panic, causing Soroban's transaction engine to roll back all writes to `ScheduleCount`, `GrantorSchedules`, `BeneficiarySchedules`, and per-schedule storage entries made during that invocation, and the grantor's token balance SHALL be identical to its value before the call.
2. IF a batch of N entries fails on entry K (where K > 1) after K-1 entries have already been processed, THEN the rollback SHALL also undo all storage writes and token transfers made for entries 1 through K-1, leaving no `Schedule_IDs` from the batch present in any storage key.
3. IF `create_schedules_batch` panics for any reason, THEN no `Schedule_ID` values from that invocation SHALL exist in `ScheduleCount`, `GrantorSchedules`, `BeneficiarySchedules`, or any per-schedule storage entry after the transaction settles.

---

### Requirement 7: Batch Size Limit Documentation and Enforcement

**User Story:** As a developer integrating the contract, I want clear documentation on the safe batch size, so that my transactions do not fail due to exceeding the Soroban instruction budget.

#### Acceptance Criteria

1. THE VestFlow_Contract SHALL include an inline Rust doc comment (`///`) directly on the `create_schedules_batch` function signature stating that the `Safe_Batch_Limit` is 20 entries and that this limit is enforced as a runtime panic.
2. THE inline doc comment SHALL state that IF the `schedules` argument contains more than 20 entries, THEN the contract panics with `"Batch size exceeds safe limit of 20"` before the empty-batch check, before `grantor.require_auth()`, before any per-entry validation, and before any token transfer.
3. IF `schedules.len() > 20`, THEN THE VestFlow_Contract SHALL panic with the exact message `"Batch size exceeds safe limit of 20"` as the very first operation in the function body, before any other guard or computation.

---

### Requirement 8: Test Coverage

**User Story:** As a contract maintainer, I want automated tests for the batch entry point, so that regressions are caught before deployment.

#### Acceptance Criteria

1. THE test suite SHALL include a test `test_batch_of_one` that: (a) records the contract's token balance before the call, (b) calls `create_schedules_batch` with exactly 1 valid `CreateScheduleParams`, (c) asserts the returned `Vec<u64>` has length 1, (d) asserts the returned ID is retrievable via `get_schedule` with matching fields, and (e) asserts the contract's token balance has increased by exactly `total_amount` relative to the pre-call baseline.
2. THE test suite SHALL include a test `test_batch_of_five` that calls `create_schedules_batch` with exactly 5 valid entries, asserts the returned `Vec<u64>` has length 5, asserts all 5 IDs are distinct, asserts the IDs are consecutive (each ID equals the previous ID + 1), and asserts all 5 schedules are retrievable via `get_schedule`.
3. THE test suite SHALL include a test `test_batch_empty_panics` that calls `create_schedules_batch` with a zero-length `Vec<CreateScheduleParams>` and uses `#[should_panic(expected = "Batch must not be empty")]` to assert the exact panic message; it SHALL also assert that `ScheduleCount` is unchanged after the failed call.
4. THE test suite SHALL include a test `test_batch_exceeds_limit_panics` that calls `create_schedules_batch` with 21 entries and uses `#[should_panic(expected = "Batch size exceeds safe limit of 20")]` to assert the exact panic message; it SHALL also assert that no schedule storage entries exist for those IDs after the failed call.
5. THE test suite SHALL include a test `test_batch_invalid_entry_panics` that calls `create_schedules_batch` with a batch containing exactly one entry where `total_amount = 0`, uses `#[should_panic(expected = "Amount must be positive")]` to assert the exact panic message, and asserts that `ScheduleCount` is unchanged and no schedules from the batch exist in storage.
6. THE test suite SHALL include a test `test_batch_grantor_index` that calls `create_schedules_batch` with a batch of 3 valid entries, then calls `get_schedules_by_grantor(grantor)`, and asserts that all 3 returned `Schedule_IDs` are present in the grantor's schedule list.
