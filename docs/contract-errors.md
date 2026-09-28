# Contract Error Codes

Reference for every `VestFlowError` variant returned by the VestFlow contract
(`contracts/vestflow/src/lib.rs`).

On-chain, a contract error surfaces as a failed transaction whose `Error(Contract, #N)`
payload carries the numeric code below. Off-chain, `@stellar/stellar-sdk` and the
generated bindings map that code back to the variant name, so prefer matching on
the name in application code and treat the number as the stable wire format.

Codes are **append-only**. A variant is never renumbered or reused, so a code
observed in an old ledger entry keeps its meaning forever.

## Quick triage

| Symptom | Likely code | Go to |
|---|---|---|
| Transaction fails with `Error(Contract, #1)` | `NotFound` | [1](#1-notfound) |
| Cannot cancel a schedule that was created without revoke rights | `NotRevocable` | [2](#2-notrevocable) |
| Mint/transfer rejected with `Error(Contract, #10)` | `InvalidToken` | [10](#10-invalidtoken) |
| Claim fails with no transfer and no specific error | `NothingToClaim` | [4](#4-nothingtoclaim) |
| Split/stream setup rejected on the weights | `WeightZero` / `WeightTooLarge` | [34](#34-weightzero) / [35](#35-weighttoolarge) |

## Error reference

| Code | Variant | Raised by | Fix |
| --- | --- | --- | --- |
| 1 | [`NotFound`](#1-notfound) | Any `get_schedule` / `claim` / `revoke` / `bump_schedule_ttl` lookup of an unknown ID | Check the ID is correct and that the schedule has not expired out of contract state. Re-read `schedule_count` and paginate `grantor_schedule_ids` rather than guessing IDs. |
| 2 | [`NotRevocable`](#2-notrevocable) | `revoke` on a schedule created as irrevocable | The schedule was created without revoke rights. There is no fix — the vesting commitment is permanent. If the grantor needs an exit, transfer the schedule to a new grantor only if the beneficiary has delegated. |
| 3 | [`AlreadyRevoked`](#3-alreadyrevoked) | Second `revoke` on the same schedule | The schedule is already revoked and its unvested tokens were returned to the grantor. Check `is_revoked` before retrying. |
| 4 | [`NothingToClaim`](#4-nothingtoclaim) | `claim` before any tokens have vested | Wait until the claimable amount is positive. Use the `claimable_amount` view to poll before submitting, and remember `cliff_duration` delays the first unlock. |
| 5 | [`AmountZero`](#5-amountzero) | `create_schedule` with `total_amount <= 0` | Pass a positive `total_amount` in token base units. Note the contract rejects `<= 0`, not just `0`. |
| 6 | [`DurationZero`](#6-durationzero) | `create_schedule` with `duration = 0` | Pass a `duration` of at least 1 second. A zero-length schedule would vest everything immediately, which the contract forbids. |
| 7 | [`CliffExceedsDuration`](#7-cliffexceedsduration) | `create_schedule` with `cliff_duration > duration` | Clamp the cliff to the duration. For a full unlock at the end, set `cliff_duration = duration`. |
| 8 | [`ScheduleRevoked`](#8-schedulerevoked) | `claim` on a schedule that was already revoked | The schedule is dead; create a new one. Check `is_revoked` before claiming. |
| 9 | [`LockupLessThanCliff`](#9-lockuplessthancliff) | `create_schedule` with `lockup_duration < cliff_duration` | The lockup is the tail of the schedule after the cliff, so it must be at least as long as the cliff. Raise `lockup_duration` or lower `cliff_duration`. |
| 10 | [`InvalidToken`](#10-invalidtoken) | `create_schedule` with an address that is not a recognised Stellar Asset Contract | Use the SAC address (`stellarAssetContract` for XLM, the asset's contract id otherwise). A wallet address or a classic account will not work. |
| 11 | [`ProposalNotFound`](#11-proposalnotfound) | Any proposal lookup for an unknown proposal ID | Verify the ID with `proposal_count`; proposals below that counter are valid, above it are not. |
| 12 | [`ProposalNotExpired`](#12-proposalnotexpired) | `expire_proposal` before the expiry ledger | Wait for the ledger in `expire_proposal`'s threshold to pass. Re-read the proposal to get the current `expiry_ledger`. |
| 13 | [`ProposalExpired`](#13-proposalexpired) | `acknowledge_proposal` on an expired proposal | The window to accept has closed. Propose again with `propose_schedule`. |
| 14 | [`ProposalAlreadyActivated`](#14-proposalalreadyactivated) | `fund_and_activate` on a proposal that is already active | Check `get_proposal`'s state first. The funds were already escrowed; do not send a second funding transfer. |
| 15 | [`DurationTooShort`](#15-durationtooshort) | `create_graded_schedule` with a duration below the minimum the milestone set requires | Lengthen `duration` so the earliest milestone can be reached, or drop the leading milestone. |
| 16 | [`DelegationNotFound`](#16-delegationnotfound) | `claim_as_delegate` / `revoke_delegation` with an unknown delegation ID | Use `get_delegation` to list the schedule's delegations. `delegation_count` is a per-schedule counter, so IDs are only unique within a schedule. |
| 17 | [`DelegationRevoked`](#17-delegationrevoked) | Any use of a delegation after `revoke_delegation` | The delegate no longer has authority. Create a new delegation. |
| 18 | [`DelegationExpired`](#18-delegationexpired) | `claim_as_delegate` after `expires_at_ledger` | The authority lapsed at the ledger recorded on the delegation. Create a new one with a later expiry. |
| 19 | [`DelegationExhausted`](#19-delegationexhausted) | `claim_as_delegate` for more than the remaining `max_amount` | The delegate's cap is spent. Split the claim into smaller amounts, or have the beneficiary create a fresh delegation. |
| 20 | [`NotDelegate`](#20-notdelegate) | `claim_as_delegate` where the signer is not the recorded delegate | The `Address` you passed must be the delegate, and the transaction must carry that delegate's signature. An authorisation signed by a different address is rejected. |
| 21 | [`TooManyDelegations`](#21-toomanydelegations) | `create_delegation` when the schedule is at its active-delegation cap | Revoke an unused delegation with `revoke_delegation` before creating another. The cap counts active delegations, not historical ones. |
| 22 | [`MergeTypeMismatch`](#22-mergetypemismatch) | `merge_schedules` mixing vesting kinds | All schedules in a merge must be the same `VestingKind`. Group by kind and merge each group separately. |
| 23 | [`MergeTooFewSchedules`](#23-mergetoofewschedules) | `merge_schedules` with fewer than two IDs | Merging needs at least two schedules. There is nothing to merge. |
| 24 | [`MergeTooManySchedules`](#24-mergetoomanyschedules) | `merge_schedules` exceeding the maximum batch size | Split the merge into batches within the limit. |
| 25 | [`MergeTokenMismatch`](#25-mergetokenmismatch) | `merge_schedules` mixing tokens | Every schedule in a merge must vest the same token. Group by token first. |
| 26 | [`MergeOwnerMismatch`](#26-mergeownermismatch) | `merge_schedules` mixing grantors or beneficiaries | A merge preserves a single grantor and beneficiary. Only schedules with the same pair can merge. |
| 27 | [`NftOwnerNotFound`](#27-nftownernotfound) | `split` with an NFT-gated receiver whose `owner_of` call fails | Confirm `nft_contract` is a contract exposing `owner_of` and that `token_id` is minted. A burned or non-existent token has no owner, so its share cannot be routed. |
| 28 | [`NoSplits`](#28-nosplits) | `split` for an account with no splits configured | Call `set_splits` first. An account must authorise its own configuration; it cannot be set on its behalf. |
| 29 | [`SlotAlreadyClaimed`](#29-slotalreadyclaimed) | `claim_schedule_slot` for a leaf that already claimed | Each slot in a committed batch is single-use. Rebuild the batch to distribute again. |
| 30 | [`BatchExpired`](#30-batchexpired) | `claim_schedule_slot` after the batch's `expiry_ledger` | The claim window closed. The grantor can recover the remainder with `reclaim_batch`. |
| 31 | [`InvalidProof`](#31-invalidproof) | A Merkle proof that does not resolve to the committed root | Check the leaf is part of the batch and that sibling nodes are ordered exactly as committed. Off-by-one ordering is the usual cause. |
| 32 | [`NotExpired`](#32-notexpired) | `reclaim_batch` before `expiry_ledger` | Wait for the batch to expire. Claim outstanding slots in the meantime. |
| 33 | [`ProofTooDeep`](#33-prooftoodeep) | A Merkle proof deeper than 20 levels | Shrink the batch so its tree depth is at most 20, then commit a new batch. |
| 34 | [`WeightZero`](#34-weightzero) | `set_stream` / `add_splits_receiver` with a zero `amt_per_sec` or `weight`; `stream` receiver validation | A zero rate or weight has no meaning and would silently drop value. Remove the receiver instead of setting it to zero. |
| 35 | [`WeightTooLarge`](#35-weighttoolarge) | A splits `weight` above `TOTAL_SPLITS_WEIGHT` (1_000_000) | Weights are parts-per-million of a whole. Use a value `<= 1_000_000`, and `< 1_000_000` when other receivers already exist. |
| 36 | [`ReceiverNotFound`](#36-receivernotfound) | `update_stream_rate` for a receiver absent from the funder's current stream config | Read `get_account_token_streams` and use a receiver that is actually in the list. |
| 37 | [`StreamsNotConfigured`](#37-streamsnotconfigured) | `update_stream_rate` / `receive_streams` for a `(funder, token)` pair with no stream config | Call `set_stream` for that pair first. Streams are configured per token. |
| 38 | [`AlreadyExists`](#38-alreadyexists) | `add_splits_receiver` for a receiver already in the configuration | Splits cannot contain the same address twice. To change a weight, call `set_splits` with the full corrected list. |
| 39 | [`LengthMismatch`](#39-lengthmismatch) | `batch_give` where `receivers` and `amounts` differ in length | Send parallel arrays of equal length. `amounts` is positional, so `amounts[i]` is the gift for `receivers[i]`; to send the same amount to everyone, build the array rather than passing an empty list. |

## Panics

Not every failure path returns a `VestFlowError`; several entry points abort the
transaction with a plain string instead. A panic surfaces as
`Error(Contract, #1)` with the string in the diagnostic log, and none of these
codes are matched as contract errors. The full table lives in the crate-level
docs at the top of `contracts/vestflow/src/lib.rs`; the most common ones are:

| Panic string | Raised by | Fix |
| --- | --- | --- |
| `"Amount must be positive"` | `create_schedule`, `split` | Pass a positive amount. |
| `"Duration must be positive"` | `create_schedule` | Pass a `duration >= 1`. |
| `"Cliff cannot exceed duration"` | `create_schedule` | Clamp the cliff. |
| `"Lockup cannot be less than cliff"` | `create_schedule` | Lengthen the lockup. |
| `"Beneficiary must differ from grantor"` | `create_schedule` | Self-vesting is not allowed. |
| `"Start time cannot be in the past"` | `create_schedule`, `create_graded_schedule` | Use a `start_time` at or after the current ledger timestamp. |
| `"Schedule not found"` | `get_schedule`, `claim`, `revoke`, `bump_schedule_ttl` | Unknown or expired schedule ID. |
| `"Nothing to claim yet"` | `claim` | Poll `claimable_amount` until it is positive. |
| `"Schedule is not revocable"` | `revoke` | The schedule is irrevocable. |
| `"Already revoked"` | `revoke` | Check `is_revoked` first. |
| `"Invalid token"` | `create_schedule` | Use a Stellar Asset Contract address. |
| `"Upgrade authority not initialized"` | Upgrade entry points | Call `initialize_upgrade_authority` once first. |
| `"Unauthorized upgrade authority"` | Upgrade entry points | Sign with the recorded authority address. |
| `"No pending upgrade"` | `execute_upgrade`, `cancel_upgrade` | Announce an upgrade first. |
| `"Upgrade timelock still active"` | `execute_upgrade` | Wait the 48 hours from `announce_upgrade`. |
| `"Stream receiver rate cannot be negative"` | `set_stream` | Pass non-negative rates (`amt_per_sec >= 0`, rate = 0 closes a stream). |
| `"InsufficientBalance"` | `withdraw`, `set_stream` | Ensure withdrawal amount does not exceed available streaming balance. |
| `"Streams not configured"` | `receive_streams`, `pause_streams` | Call `set_stream` first. |
| `"Split receiver weight must be positive"` | `set_splits` | Remove zero-weight receivers. |
| `"Split receiver weight exceeds maximum"` | `set_splits` | Cap weights at `TOTAL_SPLITS_WEIGHT`. |
| `"Total split weight must equal TOTAL_SPLITS_WEIGHT"` | `set_splits` | Ensure the sum of receiver weights equals `TOTAL_SPLITS_WEIGHT` (1,000,000). |
| `"NFT contract not initialized"` | `nft_split` | Call `initialize_nft_contract` first. |
| `"Not the beneficiary"` | `create_delegation`, `revoke_delegation` | Pass the schedule's beneficiary. |
| `"Delegate must differ from beneficiary"` | `create_delegation` | Pick a different delegate. |
| `"Max amount must be positive"` | `create_delegation` | Pass `None` or a positive `max_amount`. |
| `"Expiry must be in the future"` | `create_delegation` | Use an `expires_at_ledger` after the current sequence. |
| `"Performance oracle must be initialized before enabling milestones"` | `enable_performance_milestones` | Call `initialize_performance_oracle` first. |
| `"Segment already squeezed"` | `squeeze_streams` | Squeeze was already performed for this history hash segment; pass a new segment hash. |

## Related

- [`DOCUMENTATION.md`](../DOCUMENTATION.md) — contract API walkthrough
- [`AUDIT.md`](../AUDIT.md) — audit findings and severity
- `contracts/vestflow/src/lib.rs` — `VestFlowError` definition
