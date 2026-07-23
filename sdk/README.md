# @vestflow/sdk

TypeScript SDK for interacting with the VestFlow vesting contract on Stellar/Soroban.

## Installation

```bash
npm install @vestflow/sdk
# or
pnpm add @vestflow/sdk
```

For wallet signing support (browser), also install:

```bash
npm install @stellar/freighter-api
```

## Quick Start

```ts
import { VestflowClient } from "@vestflow/sdk";

// Create a client (defaults to testnet)
const client = new VestflowClient({ network: "testnet" });

// Read a schedule
const schedule = await client.getSchedule(1);
console.log(schedule);

// Get all schedules for a grantor
const ids = await client.getSchedulesByGrantor("G...");

// Get claimable amounts for multiple schedules in one call
const amounts = await client.getClaimableBulk(ids);
```

## Write Transactions (Browser + Freighter)

```ts
import { VestflowClient } from "@vestflow/sdk";
import { signTransaction } from "@stellar/freighter-api";

const client = new VestflowClient({ network: "testnet" });

// Create a vesting schedule
const hash = await client.createSchedule(
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
const claimHash = await client.claimVested("G...", scheduleId, signTransaction);

// Revoke a schedule (grantor only)
const revokeHash = await client.revokeSchedule("G...", scheduleId, signTransaction);
```

## Write Transactions (Node.js + Keypair)

```ts
import { VestflowClient } from "@vestflow/sdk";
import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";

const client = new VestflowClient({ network: "testnet" });
const keypair = Keypair.fromSecret("S...");

const nodeSigner = async (xdr: string, opts: { networkPassphrase: string }) => {
  const tx = TransactionBuilder.fromXDR(xdr, opts.networkPassphrase);
  tx.sign(keypair);
  return tx.toXDR();
};

const hash = await client.createSchedule({ ... }, nodeSigner);
```

## API Reference

### `new VestflowClient(config?)`

| Option | Type | Default | Description |
|---|---|---|---|
| `network` | `"testnet" \| "mainnet"` | `"testnet"` | Target Stellar network |
| `contractId` | `string` | Deployed testnet ID | Override contract address |
| `rpcUrl` | `string` | Public endpoint | Override Soroban RPC URL |
| `nativeToken` | `string` | Testnet XLM SAC | Override native token SAC |

### Read Methods

| Method | Returns | Description |
|---|---|---|
| `getSchedule(id, publicKey?)` | `Promise<ScheduleData \| null>` | Fetch a schedule by ID |
| `getScheduleCount()` | `Promise<number>` | Total schedules created |
| `getSchedulesByGrantor(address)` | `Promise<number[]>` | Schedule IDs by grantor |
| `getSchedulesByBeneficiary(address)` | `Promise<number[]>` | Schedule IDs by beneficiary |
| `getClaimable(id, publicKey?)` | `Promise<bigint>` | Claimable amount for one schedule |
| `getClaimableBulk(ids, publicKey?)` | `Promise<bigint[]>` | Claimable amounts for multiple schedules |
| `getAllSchedules(publicKey?)` | `Promise<ScheduleData[]>` | All schedules |

### Write Methods

| Method | Returns | Description |
|---|---|---|
| `createSchedule(params, signer)` | `Promise<string>` | Create a new vesting schedule |
| `claimVested(publicKey, id, signer)` | `Promise<string>` | Claim vested tokens |
| `revokeSchedule(publicKey, id, signer)` | `Promise<string>` | Revoke a schedule (grantor only) |

### Utilities

| Function | Description |
|---|---|
| `xlmToStroops(amountXlm)` | Convert XLM string to stroops (integer-safe) |
| `stroopsToXlm(stroops)` | Convert stroops to XLM string |
| `truncate(address)` | Shorten a Stellar address for display |
| `vestingProgress(schedule, now)` | Vesting progress percentage (0-100) |
| `formatDate(timestamp)` | Format Unix timestamp as date string |
| `parseContractError(error)` | Map contract error to user-friendly message |

## License

MIT
