//! Fuzz target: stream balance accrual calculation.
//!
//! Generates random (rate_per_sec, elapsed, balance) tuples and verifies:
//!   1. result is never negative
//!   2. result never exceeds the initial balance

#![no_main]

use libfuzzer_sys::fuzz_target;
use vestflow::fuzz_accrued_capped;

// The fuzzer feeds us a raw byte slice; we interpret the first 48 bytes as
// three little-endian i128 values.  Inputs shorter than 48 bytes are skipped.
fuzz_target!(|data: &[u8]| {
    if data.len() < 48 {
        return;
    }

    let rate = i128::from_le_bytes(data[0..16].try_into().unwrap());
    let elapsed = i128::from_le_bytes(data[16..32].try_into().unwrap());
    let balance = i128::from_le_bytes(data[32..48].try_into().unwrap());

    let result = fuzz_accrued_capped(rate, elapsed, balance);

    // Invariant 1: never negative
    assert!(result >= 0, "accrued amount is negative: {result}");

    // Invariant 2: never exceeds the initial balance (when balance is positive)
    if balance > 0 {
        assert!(
            result <= balance,
            "accrued {result} exceeds balance {balance}"
        );
    }
});
