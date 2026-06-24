# Design Document: Batch Schedule Creation

## Overview

This document describes the technical design for `create_schedules_batch`, a new entry point on the `VestFlowContract` that creates multiple vesting schedules atomically in a single Soroban transaction. The implementation reuses all existing storage keys, indexing helpers, and the event format of `create_schedule` — no new storage primitives are introduced.

All changes are confined to `contracts/vestflow/src/lib.rs`. No new modules, files, or crates are required.

---

## Architecture

No new modules, files, or crates are required. All changes are confined to `contracts/vestflow/src/lib.rs`. Three additions are made to the existing `impl VestFlowContract` block:

1. A `CreateScheduleParams` struct — parameter bag for one schedule entry.
2. A `create_one` private helper — contains per-schedule logic shared by both entry points.
3. A `create_schedules_batch` public entry point — validates batch guards and iterates.

`create_schedule` is refactored to delegate to `create_one`; its external interface and behaviour are unchanged.

---

## Components and Interfaces

### `CreateScheduleParams` struct (new)

A Soroban `#[contracttype]` parameter bag that groups the per-schedule inputs for use in the batch call:

```rust
#[contracttype]
#[derive(Clone)]
pub struct CreateScheduleParams {
    pub beneficiary:    Address,
    pub token:          Address,
    pub total_amount:   i128,
    pub start_time:     u64,
    pub duration:       u64,
    pub cliff_duration: u64,
    pub kind:           VestingKind,
    pub revocable:      bool,
}
```

### `create_one` private helper (new)

Extracted from the body of `create_schedule`. Performs per-schedule validation, token transfer, storage writes, index maintenance, and event emission for a single entry. Signature:

```rust
fn create_one(env: &Env, grantor: &Address, params: CreateScheduleParams) -> u64
```

Both `create_schedule` and `create_schedules_batch` delegate to this helper. `create_schedule` is a pure refactor — its behaviour is unchanged.

### `create_schedules_batch` entry point (new)

```rust
pub fn create_schedules_batch(
    env: Env,
    grantor: Address,
    schedules: Vec<CreateScheduleParams>,
) -> Vec<u64>
```

Validates batch-level guards, calls `grantor.require_auth()` once, then calls `create_one` per entry and returns collected IDs.

### Call flow

```
create_schedules_batch(env, grantor, schedules)
  │
  ├─ [guard 1] schedules.len() > 20  → panic "Batch size exceeds safe limit of 20"
  ├─ [guard 2] schedules.len() == 0  → panic "Batch must not be empty"
  ├─ grantor.require_auth()
  │
  └─ for each params in schedules:
       create_one(&env, &grantor, params)  →  schedule_id: u64
     collect → Vec<u64>

create_one(env, grantor, params)
  ├─ assert beneficiary ≠ grantor
  ├─ assert total_amount > 0
  ├─ assert duration > 0
  ├─ assert cliff_duration ≤ duration
  ├─ next_id = ScheduleCount + 1
  ├─ token::Client::transfer(grantor → contract, total_amount)
  ├─ storage.set(Schedule(id), VestingSchedule { … })
  ├─ storage.set(ScheduleCount, id)
  ├─ GrantorSchedules(grantor).push(id)
  ├─ BeneficiarySchedules(beneficiary).push(id)
  └─ events.publish("created", …)
     return id
```

### Guard ordering

| Step | Guard | Panic message |
|------|-------|---------------|
| 1 | `schedules.len() > 20` | `"Batch size exceeds safe limit of 20"` |
| 2 | `schedules.len() == 0` | `"Batch must not be empty"` |
| 3 | `grantor.require_auth()` | (auth error from host) |
| 4 per entry | `beneficiary != grantor` | `"Beneficiary must differ from grantor"` |
| 5 per entry | `total_amount > 0` | `"Amount must be positive"` |
| 6 per entry | `duration > 0` | `"Duration must be positive"` |
| 7 per entry | `cliff_duration <= duration` | `"Cliff cannot exceed duration"` |
| 8 per entry | `token::transfer(…)` | (token auth/balance error from host) |

Oversized and empty batches are rejected before auth is consumed. All validation fires before the token transfer for each entry.

---

## Data Models

No new `DataKey` variants or storage schemas are introduced. All storage keys used by `create_one` already exist:

| Key | Type | Description |
|-----|------|-------------|
| `DataKey::Schedule(u64)` | `VestingSchedule` | Per-schedule state |
| `DataKey::ScheduleCount` | `u64` | Global monotonic ID counter |
| `DataKey::GrantorSchedules(Address)` | `Vec<u64>` | IDs created by a grantor |
| `DataKey::BeneficiarySchedules(Address)` | `Vec<u64>` | IDs where address is beneficiary |

The only new type is `CreateScheduleParams` — a transient parameter struct that is never persisted to storage.

---

## Correctness Properties

### Property 1: Atomicity

Soroban's execution model is all-or-nothing at the transaction level. A `panic!` unwinds the WASM frame and the host discards all storage mutations and token transfers made during that invocation. No explicit rollback logic is needed — the design relies entirely on this host guarantee. There is no partial-success mode.

**Validates: Requirements 6.1, 6.2, 6.3**

### Property 2: ID Monotonicity

`create_one` reads `ScheduleCount`, computes `id = count + 1`, writes `ScheduleCount = id`. Iterating over N entries produces IDs `count+1, count+2, … count+N` in input order, identical to calling `create_schedule` N times sequentially.

**Validates: Requirements 5.1**

### Property 3: Index Consistency

Each `create_one` call appends to both `GrantorSchedules` and `BeneficiarySchedules`, matching the behaviour of the existing single-schedule path. A panicked batch rolls these writes back along with everything else.

**Validates: Requirements 5.2, 5.3**

### Property 4: Multi-token Correctness

Each entry carries its own `token` address. The per-entry `token::transfer` uses that entry's token. No assumption of token homogeneity is made. Grantors must pre-approve each distinct token for its summed per-token batch amount.

**Validates: Requirements 3.2, 3.3, 3.4**

### Property 5: Safe Batch Limit Rationale

Each `create_one` call costs roughly 300–500k instructions (empirical Soroban benchmarks). With a 100M instruction budget, 20 entries ≈ 6–10M instructions — well within budget with headroom for host overhead. The limit is a hard runtime check, not advisory documentation.

**Validates: Requirements 7.1, 7.2, 7.3**

---

## Error Handling

All errors are signalled via `panic!` / `assert!`, which Soroban translates into a failed transaction with full state rollback.

New error messages added by this feature:

| Error string | Triggered by |
|---|---|
| `"Batch size exceeds safe limit of 20"` | `create_schedules_batch` with > 20 entries |
| `"Batch must not be empty"` | `create_schedules_batch` with 0 entries |

All existing per-schedule error messages (`"Amount must be positive"`, `"Duration must be positive"`, `"Cliff cannot exceed duration"`, `"Beneficiary must differ from grantor"`) are reused unchanged from `create_one`, and the top-level module doc error table is updated to include the two new messages.

Token authorization failures propagate directly from the token contract's `transfer` call — the VestFlow contract does not wrap or re-map those errors.

---

## Testing Strategy

Tests are written in the existing `#[cfg(test)] mod test` block in `lib.rs`, using the `soroban-sdk` test utilities already present in the crate.

**Happy-path tests:**
- `test_batch_of_one` — verifies single-entry batch, token balance delta, and `get_schedule` retrieval.
- `test_batch_of_five` — verifies 5-entry batch, distinct IDs, ID consecutiveness, and retrieval.
- `test_batch_grantor_index` — verifies all batch IDs appear in `get_schedules_by_grantor`.

**Guard / panic tests (each uses `#[should_panic(expected = "…")]`):**
- `test_batch_empty_panics` — empty vec → `"Batch must not be empty"`.
- `test_batch_exceeds_limit_panics` — 21-entry vec → `"Batch size exceeds safe limit of 20"`.
- `test_batch_invalid_entry_panics` — `total_amount = 0` → `"Amount must be positive"`.

**Regression:** `cargo test` is run after the `create_one` refactor (Task 2) to confirm no existing tests are broken before adding the new entry point.
