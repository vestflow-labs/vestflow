//! Issue #949 — performance benchmark comparing individual `give` calls against a
//! single `batch_give` call.
//!
//! This is an *informational* benchmark. It is its own test target so CI can run
//! it with `--nocapture` (so the numbers land in the job log) and mark the step
//! `continue-on-error`: a regression reports a finding without blocking the
//! build.
//!
//! Run locally with:
//!   cargo test -p vestflow --test batch_give_benchmark -- --nocapture
//!
//! # Methodology, and one trap worth knowing about
//!
//! The obvious way to write this is to call `give` ten times, read the budget
//! meter, divide by ten, and compare against one `batch_give` call. That is
//! wrong, and it inverts the result.
//!
//! `Budget::cpu_instruction_cost()` in the Soroban test environment re-baselines
//! on every top-level contract invocation. Ten sequential `client.give(...)`
//! calls therefore do *not* report ten times the cost of one: measured on this
//! codebase a single `give` reports ~179k instructions, but the tenth reports
//! only ~219k in total, i.e. the meter is charging a few thousand instructions
//! per additional call rather than a full invocation's worth. Work performed
//! *inside* one `batch_give` invocation accumulates correctly, because it never
//! re-baselines.
//!
//! So the two sides are not comparable if the individual-call side is a loop.
//! This benchmark instead compares like with like, using only single-invocation
//! measurements:
//!
//!   * `single_give`  — cost of one `give` invocation.
//!   * `batch_of_one` — cost of one `batch_give` invocation with 1 receiver.
//!   * `batch_of_n`   — cost of one `batch_give` invocation with N receivers.
//!
//! The marginal cost of one extra receiver inside a batch is then
//! `(batch_of_n - batch_of_one) / (N - 1)`, which is a genuine within-invocation
//! marginal, and that is what gets compared against `single_give`.
//!
//! # What this does and does not tell you
//!
//! Passing this benchmark is necessary but not sufficient for batching to be
//! cheaper in production. The test harness does not charge per-transaction
//! overhead — signature verification, transaction base fee, and the fixed
//! per-invocation cost that a real ledger applies to each of N separate
//! transactions. On a live network that overhead is paid N times for N
//! `give` calls and once for a single `batch_give`, so batching wins by much
//! more in production than the ratio below suggests. The number here is a lower
//! bound on batching's advantage, and the assertion is deliberately a ceiling
//! rather than a target: it is there to catch an `O(n^2)` blowup or a
//! regression that adds per-receiver work, not to certify a specific speedup.

use soroban_sdk::{
    testutils::{Address as _, EnvTestConfig},
    token::StellarAssetClient,
    Address, Env, Vec as SorobanVec,
};
use vestflow::VestFlowContract;

/// Fan-out size for the comparison. The issue specifies 10.
const N: u32 = 10;

/// Ceiling on the marginal per-receiver cost of `batch_give` expressed as a
/// multiple of one standalone `give`. See module docs.
const BATCH_VS_SINGLE_CEILING: f64 = 2.0;

/// CPU instructions charged to the Soroban budget since the last reset. This is
/// the host's own meter, so it covers contract execution, host calls and storage
/// metering — the quantity that drives fees and the per-tx instruction limit.
fn cpu_instructions(env: &Env) -> u64 {
    env.cost_estimate().budget().cpu_instruction_cost()
}

/// Zero the instruction counter, leaving the budget limit untouched so a long
/// benchmark cannot run out of budget partway through.
fn reset_instructions(env: &Env) {
    let mut budget = env.cost_estimate().budget();
    budget.reset_tracker();
}

/// A benchmark measures instructions; it is not asserting on ledger state, so
/// snapshot capture is disabled. Otherwise every run writes three
/// `test_snapshots/*.json` files that then show up as untracked noise.
fn bench_env() -> Env {
    Env::new_with_config(EnvTestConfig {
        capture_snapshot_at_drop: false,
    })
}

struct Fixture {
    grantor: Address,
    token: Address,
}

fn setup(env: &Env) -> Fixture {
    let token_admin = Address::generate(env);
    let token_contract = env.register_stellar_asset_contract_v2(token_admin);
    let token = token_contract.address();
    let grantor = Address::generate(env);
    StellarAssetClient::new(env, &token)
        .mock_all_auths()
        .mint(&grantor, &1_000_000);
    Fixture { grantor, token }
}

fn receiver_set(env: &Env, n: u32) -> (SorobanVec<Address>, SorobanVec<i128>) {
    let mut receivers = SorobanVec::new(env);
    let mut amounts = SorobanVec::new(env);
    for _ in 0..n {
        receivers.push_back(Address::generate(env));
        amounts.push_back(100);
    }
    (receivers, amounts)
}

/// Cost of a single `give` invocation, measured on its own.
fn measure_single_give(env: &Env) -> u64 {
    env.mock_all_auths();
    let contract_id = env.register(VestFlowContract, ());
    let client = vestflow::VestFlowContractClient::new(env, &contract_id);
    let f = setup(env);
    let receiver = Address::generate(env);

    reset_instructions(env);
    client.give(&f.grantor, &receiver, &f.token, &100);
    cpu_instructions(env)
}

/// Cost of a single `batch_give` invocation with `n` receivers, measured on its
/// own.
fn measure_batch_give(env: &Env, n: u32) -> u64 {
    env.mock_all_auths();
    let contract_id = env.register(VestFlowContract, ());
    let client = vestflow::VestFlowContractClient::new(env, &contract_id);
    let f = setup(env);
    let (receivers, amounts) = receiver_set(env, n);

    reset_instructions(env);
    client.batch_give(&f.grantor, &receivers, &amounts, &f.token);
    cpu_instructions(env)
}

#[test]
fn benchmark_batch_give_vs_individual_give() {
    // Each measurement gets its own Env so no storage, footprint or auth state
    // carries over between them.
    let single_give = measure_single_give(&bench_env());
    let batch_of_one = measure_batch_give(&bench_env(), 1);
    let batch_of_n = measure_batch_give(&bench_env(), N);

    // Marginal cost of one extra receiver inside a single batch invocation.
    let marginal_per_receiver = (batch_of_n - batch_of_one) / u64::from(N - 1);
    let ratio = marginal_per_receiver as f64 / single_give as f64;

    // Printed unconditionally so the numbers land in the CI job log. This table
    // is the artifact the issue asks for, not just a pass/fail.
    std::println!(
        "\n\
         ── batch_give vs individual give (fan-out {N}) ──\n\
         {:<44} {:>10}\n\
         {:<44} {:>10}\n\
         {:<44} {:>10}\n\
         {:<44} {:>10}\n\
         {:<44} {:>10}\n\
         {:<44} {:>10}\n\
         ───────────────────────────────────────────────────────\n",
        "1 x give  (instructions)",
        single_give,
        "1 x batch_give, 1 receiver (instructions)",
        batch_of_one,
        "1 x batch_give, 10 receivers (instructions)",
        batch_of_n,
        "marginal cost per extra receiver",
        marginal_per_receiver,
        "batch_give marginal / 1 x give",
        format!("{ratio:.3}x"),
        "asserted ceiling",
        format!("{BATCH_VS_SINGLE_CEILING:.1}x"),
    );
    std::println!(
        "note: the test env re-baselines the budget per top-level call, so N\n\
         separate give transactions are not measured by looping here. On a live\n\
         network each of those transactions also pays signature verification and\n\
         a base fee, so batching's real advantage is larger than this ratio.\n"
    );

    assert_ne!(single_give, 0, "give reported zero instructions");
    assert!(
        batch_of_n > batch_of_one,
        "batch_give with {N} receivers ({batch_of_n}) cost no more than with 1 ({batch_of_one}); \
         it is probably not doing the transfers"
    );

    assert!(
        ratio < BATCH_VS_SINGLE_CEILING,
        "marginal batch_give cost per receiver is {ratio:.3}x a single give \
         ({marginal_per_receiver} vs {single_give} instructions), which exceeds the \
         {BATCH_VS_SINGLE_CEILING:.1}x ceiling"
    );
}
