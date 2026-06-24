# Implement lockup period, SAC support, and structured events

This PR implements three key enhancements to the VestFlow vesting contract.

## Changes

### Issue #72: Token Lockup Period
Implements a lockup period that is separate from the vesting cliff. This distinguishes between:
- **Cliff**: Tokens not yet earned
- **Lockup**: Tokens earned but non-transferable

**Key Features**:
- Added `lockup_duration` field to vesting schedules
- Tokens vest according to schedule but cannot be claimed until lockup expires
- Lockup duration must be >= cliff duration
- Backward compatible with existing vesting logic

**Example Use Case**:
Employee receives tokens with a 1-year cliff and 2-year lockup. After year 1, tokens start vesting but cannot be transferred. After year 2, all vested tokens become claimable.

### Issue #74: SAC Token Support
Documents and verifies support for Stellar Asset Contract (SAC) wrapped assets.

**Supported Tokens**:
- Native XLM (wrapped as SAC)
- Classic Stellar assets (wrapped as SAC)  
- Custom Soroban tokens

The contract uses the standard token interface and works with any SAC-compliant token contract.

### Issue #70: Structured Events
Enhanced all event emissions with structured data for indexers and monitoring systems.

**Improvements**:
- All events now include complete state transition data
- Timestamps added to all events for temporal ordering
- Schedule IDs in event topics for efficient indexing
- Comprehensive event documentation in contract

**Events Updated**:
- `created`: Full schedule parameters
- `claimed`: Beneficiary, token, amounts, timestamp
- `revoked`: Grantor, token, amounts, timestamp
- `paused`, `resumed`, `bnf_chng`: Enhanced with timestamps
- All admin events: Timestamps added

## Testing

- ✅ All existing tests updated and passing
- ✅ New tests for lockup functionality
- ✅ Event structure verified
- ✅ SAC support documented

## Breaking Changes

**Contract Interface**:
- `create_schedule()`: Added `lockup_duration` parameter
- `create_graded_schedule()`: Added `lockup_duration` parameter
- `VestingSchedule` struct: Added `lockup_duration` and `milestones` fields

**Migration Path**:
- Use `lockup_duration = 0` for schedules without lockup
- Use `lockup_duration = cliff_duration` to maintain existing behavior
- Frontend clients need to update contract call signatures

## Documentation

- Added comprehensive event documentation
- Added SAC support documentation
- Created `IMPLEMENTATION_NOTES.md` with detailed explanation

## Verification

- No security vulnerabilities introduced
- Maintains overflow-safe arithmetic
- Preserves authorization checks
- Re-entrancy guards unchanged
- Event structure backwards compatible (additive only)

## Files Changed

- `contracts/vestflow/src/lib.rs`: Core implementation (203 additions)
- `IMPLEMENTATION_NOTES.md`: Detailed documentation (new file)

## Related Issues

Closes #72
Closes #74  
Closes #70
