# @drips/stellar-sdk

TypeScript SDK for interacting with the Drips/VestFlow streaming and vesting
contracts on Stellar/Soroban.

## Installation

```bash
npm install @drips/stellar-sdk
# or
pnpm add @drips/stellar-sdk
```

For wallet signing support (browser), also install:

```bash
npm install @stellar/freighter-api
```

## Quick Start

```ts
import { VestflowClient } from "@drips/stellar-sdk";

// Create a client (defaults to testnet)
const client = new VestflowClient({ network: "testnet" });

// Read a schedule
const schedule = await client.getSchedule(1);
console.log(schedule);

// Get all schedules for a grantor
const ids: number[] = await client.getSchedulesByGrantor("G...");

// Get claimable amounts for multiple schedules in one call
const amounts: bigint[] = await client.getClaimableBulk(ids);
```

## Write Transactions (Browser + Freighter)

```ts
import { VestflowClient } from "@drips/stellar-sdk";
import { signTransaction } from "@stellar/freighter-api";

const client = new VestflowClient({ network: "testnet" });

// Create a vesting schedule
const hash: string = await client.createSchedule(
  {
    grantor: "G...",
    beneficiary: "G...",
    totalAmountXlm: "1000",
    startTime: Math.floor(Date.now() / 1000),
    durationDays: 365,
    cliffDays: 90,
    kind: "LinearWithCliff",
    revocable: true,
  },
  signTransaction
);

// Claim vested tokens
const claimHash: string = await client.claimVested(
  "G...",
  scheduleId,
  signTransaction
);

// Revoke a schedule (grantor only)
const revokeHash: string = await client.revokeSchedule(
  "G...",
  scheduleId,
  signTransaction
);
```

## Write Transactions (Node.js + Keypair)

```ts
import { VestflowClient } from "@drips/stellar-sdk";
import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";

const client = new VestflowClient({ network: "testnet" });
const keypair = Keypair.fromSecret("S...");

const nodeSigner = async (
  xdr: string,
  opts: { networkPassphrase: string }
): Promise<string> => {
  const tx = TransactionBuilder.fromXDR(xdr, opts.networkPassphrase);
  tx.sign(keypair);
  return tx.toXDR();
};

const hash: string = await client.createSchedule({ ... }, nodeSigner);
```

## Give (One-time Direct Payments)

Send a single or batched one-time payment that bypasses any vesting schedule:

```ts
import { VestflowClient, type TransactionResult } from "@drips/stellar-sdk";
import { signTransaction } from "@stellar/freighter-api";

const client = new VestflowClient({ network: "testnet" });

// Single give
const result: TransactionResult = await client.give(
  "GSENDER...",           // sender (must sign)
  "GRECEIVER...",         // receiver (account or contract)
  "CTOKEN...",            // Stellar Asset Contract address
  1_000_000n,             // amount in stroops (base units)
  signTransaction
);
console.log(result.hash, result.status);

// Batch give — multiple receivers in one transaction
const batchResult: TransactionResult = await client.batchGive(
  "GSENDER...",
  ["GRECEIVER1...", "GRECEIVER2..."],
  [500_000n, 250_000n],   // one amount per receiver, each > 0
  "CTOKEN...",
  signTransaction
);
```

`batchGive` validates that `receivers` and `amounts` have the same length and
that every amount is positive before submitting.

## Streams

Query active outgoing streams, or watch a live balance on an interval:

```ts
import { VestflowClient, type Stream, type BalanceResult } from "@drips/stellar-sdk";

const client = new VestflowClient({ network: "testnet" });

// Get active outgoing streams for an account
const streams: Stream[] = await client.getStreams("G...");
for (const s of streams) {
  console.log(s.receiver, s.token, s.ratePerSec.toString(), s.maxEndTime);
}

// Poll a live streaming balance (immediate first poll, default every 10s)
const stop: () => void = client.subscribeToBalance(
  "GACCOUNT...",
  "CTOKEN...",
  (balance: BalanceResult) => {
    console.log(
      "streaming:",
      balance.streamingBalance.toString(),
      "collectable:",
      balance.collectableAmount.toString()
    );
  },
  10_000 // optional intervalMs (defaults to 10_000)
);

// Later — stop polling
stop();
```

## Collect

Claim (collect) vested/streamed tokens:

```ts
const collectHash: string = await client.collect("G...", scheduleId, signTransaction);
```

## Splits

Read an account's current splits configuration from the indexer:

```ts
import { VestflowClient, type SplitsConfig } from "@drips/stellar-sdk";

const client = new VestflowClient({ network: "testnet" });

const splits: SplitsConfig = await client.getSplits("G...");
for (const r of splits.receivers) {
  console.log(r.address, r.weightBps); // weight in basis points (out of 10 000)
}
// splits.receivers is [] and splits.hash is "" when nothing is configured
```

## Profiles

Fetch an aggregated activity profile (streams, splits, gives, Drips lists)
for any address:

```ts
import { VestflowClient, ProfileError, type ProfileSummary } from "@drips/stellar-sdk";

const client = new VestflowClient({ network: "testnet" });

try {
  const profile: ProfileSummary = await client.getProfile("G...");
  console.log(profile.streams.length, profile.totals.totalGiven.toString());
} catch (err) {
  if (err instanceof ProfileError && err.status === 400) {
    console.error("Invalid address:", err.message);
  } else {
    throw err;
  }
}
```

Addresses with no activity resolve to an empty/zeroed profile rather than
throwing.

## Error Handling

Wrap write calls in `try/catch` and use `parseContractError` for
user-friendly messages:

```ts
import { VestflowClient, parseContractError } from "@drips/stellar-sdk";
import { signTransaction } from "@stellar/freighter-api";

const client = new VestflowClient({ network: "testnet" });

try {
  await client.give("G...", "G...", "C...", 100n, signTransaction);
} catch (err) {
  console.error(parseContractError(err));
}
```

Validation failures (invalid addresses, non-positive amounts, mismatched
batch lengths) throw plain `Error`s before any transaction is built.

## Waiting for a transaction

```ts
import { waitForTransaction, TimeoutError } from "@drips/stellar-sdk";

try {
  const result = await waitForTransaction(hash, {
    getTransaction: (h) => server.getTransaction(h),
    timeoutMs: 30_000,
  });
  console.log(result.status); // "SUCCESS"
} catch (err) {
  if (err instanceof TimeoutError) {
    console.error("transaction never confirmed");
  }
}
```

## API Reference

### `new VestflowClient(config?)`

| Option | Type | Default | Description |
|---|---|---|---|
| `network` | `"testnet" \| "mainnet"` | `"testnet"` | Target Stellar network |
| `contractId` | `string` | Deployed testnet ID | Override contract address |
| `rpcUrl` | `string` | Public endpoint | Override Soroban RPC URL |
| `nativeToken` | `string` | Testnet XLM SAC | Override native token SAC |
| `indexerUrl` | `string` | Public indexer | Override the indexer base URL used by `getStreams`, `getSplits` and `getProfile` |

### Read Methods

| Method | Returns | Description |
|---|---|---|
| `getSchedule(id, publicKey?)` | `Promise<ScheduleData \| null>` | Fetch a schedule by ID |
| `getScheduleCount()` | `Promise<number>` | Total schedules created |
| `getSchedulesByGrantor(address)` | `Promise<number[]>` | Schedule IDs by grantor |
| `getSchedulesByBeneficiary(address)` | `Promise<number[]>` | Schedule IDs by beneficiary |
| `getClaimable(id, publicKey?)` | `Promise<bigint>` | Claimable amount for one schedule |
| `getClaimableBulk(ids, publicKey?)` | `Promise<bigint[]>` | Claimable amounts for multiple schedules |
| `getScheduleBatch(ids, publicKey?)` | `Promise<(ScheduleData \| null)[]>` | Fetch multiple schedules in one call |
| `getRemainingUnvested(id, publicKey?)` | `Promise<bigint>` | Unvested remainder (what a revoke would recover) |
| `getAllSchedules(publicKey?)` | `Promise<ScheduleData[]>` | All schedules |
| `getStreams(account, indexerUrl?)` | `Promise<Stream[]>` | Active outgoing streams for an account |
| `getBalance(account, token, publicKey?)` | `Promise<BalanceResult>` | Live streaming balance and collectable amount, via simulation |
| `getSplits(account)` | `Promise<SplitsConfig>` | Current splits configuration for an account, from the indexer |
| `getProfile(address)` | `Promise<ProfileSummary>` | Aggregated streams/splits/gives/Drips lists profile for an address |

### Write Methods

| Method | Returns | Description |
|---|---|---|
| `createSchedule(params, signer)` | `Promise<string>` | Create a new vesting schedule |
| `claimVested(publicKey, id, signer)` | `Promise<string>` | Claim vested tokens |
| `revokeSchedule(publicKey, id, signer)` | `Promise<string>` | Revoke a schedule (grantor only) |
| `give(sender, receiver, token, amount, signer)` | `Promise<TransactionResult>` | Send a one-time direct payment, bypassing any schedule |
| `batchGive(sender, receivers, amounts, token, signer)` | `Promise<TransactionResult>` | Send one-time direct payments to multiple receivers in one transaction |

### Subscriptions

| Method | Returns | Description |
|---|---|---|
| `subscribeToBalance(account, token, callback, intervalMs?)` | `() => void` | Poll `getBalance` on an interval (default 10s); fires immediately; returns a teardown function that stops polling |
| `subscribeToSchedule(id, callback, options?)` | `{ unsubscribe(): void }` | Poll a schedule and its claimable amount on an interval |

### Transaction polling

| Export | Description |
|---|---|
| `waitForTransaction(hash, opts)` | Poll the RPC with exponential backoff (1s, 2s, 4s, 8s…) until the transaction settles; throws `TimeoutError` after `timeoutMs` (default 30s) |
| `TimeoutError` | Error thrown when the wait times out |

### Utilities

| Function | Description |
|---|---|
| `xlmToStroops(amountXlm)` | Convert XLM string to stroops (integer-safe) |
| `stroopsToXlm(stroops)` | Convert stroops to XLM string |
| `truncate(address)` | Shorten a Stellar address for display |
| `vestingProgress(schedule, now)` | Vesting progress percentage (0-100) |
| `formatDate(timestamp)` | Format Unix timestamp as date string |
| `parseContractError(error)` | Map contract error to user-friendly message |
| `formatRate(amtPerSec, token, decimals)` | Format a per-second flow rate, e.g. "0.008640 XLM / day" |

### Errors

| Export | Description |
|---|---|
| `ProfileError` | Thrown by `getProfile` for invalid addresses (`status: 400`) or unexpected indexer failures; carries an HTTP-style `status` |

## Building

`npm run build` produces both ESM (`dist/esm/`) and CJS (`dist/cjs/`) bundles
with matching type declarations, ready to publish to npm.

## License

MIT
