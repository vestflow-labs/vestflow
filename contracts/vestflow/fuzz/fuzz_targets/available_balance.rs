//! Fuzz target: available (uncommitted) stream balance calculation.
//!
//! Generates random (funded, committed) tuples and verifies:
//!   1. result is never negative
//!   2. result never exceeds funded (when funded >= 0)

#![no_main]

use libfuzzer_sys::fuzz_target;
use vestflow::fuzz_available_balance;

fuzz_target!(|data: &[u8]| {
    if data.len() < 32 {
        return;
    }

    let funded = i128::from_le_bytes(data[0..16].try_into().unwrap());
    let committed = i128::from_le_bytes(data[16..32].try_into().unwrap());

    let result = fuzz_available_balance(funded, committed);

    // Invariant 1: never negative
    assert!(result >= 0, "available balance is negative: {result}");

    // Invariant 2: never exceeds funded (only meaningful when funded >= 0)
    if funded >= 0 {
        assert!(
            result <= funded,
            "available {result} exceeds funded {funded}"
        );
    }
});
