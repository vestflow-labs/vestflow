# VestFlow Documentation

## Table of Contents

1. [Overview](#overview)
2. [Smart Contract API](#smart-contract-api)
3. [Frontend Integration](#frontend-integration)
4. [Development Guide](#development-guide)
5. [Deployment](#deployment)
6. [Team / DAO Vesting — Multisig Beneficiaries](#team--dao-vesting--multisig-beneficiaries)
7. [Security Considerations](#security-considerations)
8. [Troubleshooting](#troubleshooting)

## Overview

VestFlow is a trustless token vesting platform built on Stellar/Soroban that enables:

- **Linear Vesting**: Tokens unlock continuously over time
- **Cliff Vesting**: Tokens unlock all at once after a specified period
- **Revocable Schedules**: Grantors can cancel and reclaim unvested tokens
- **Irrevocable Schedules**: Permanent vesting commitments

### Key Features

| Feature | Description | Use Case |
|---------|-------------|----------|
| **Trustless** | No intermediaries or custodians | Employee compensation, investor vesting |
| **Flexible** | Linear or cliff vesting options | Different vesting strategies |
| **Revocable** | Optional grantor control | Employment termination scenarios |
| **Multi-token** | Support for any Stellar asset | Various token types |
| **Event-driven** | On-chain events for indexing | Analytics and monitoring |

## Smart Contract API

### Core Functions

#### `create_schedule`

Creates a new vesting schedule.

```rust
pub fn create_schedule(
    env: Env,
    grantor: Address,       // Must sign the transaction
    beneficiary: Address,   // Recipient of vested tokens
    token: Address,         // Stellar Asset Contract address
    total_amount: i128,     // Total tokens to vest (in base units)
    start_time: u64,        // Unix timestamp when vesting begins
    duration: u64,          // Vesting duration in seconds
    cliff_duration: u64,    // Cliff period in seconds (0 for no cliff)
    kind: VestingKind,      // Linear | Cliff
    revocable: bool,        // Whether grantor can revoke
) -> u64                    // Returns schedule ID
```

**Prerequisites:**
- Grantor must call `token.approve(contract_address, total_amount)` first
- Grantor must have sufficient token balance

**Events Emitted:**
- `ScheduleCreated { schedule_id, grantor, beneficiary, total_amount }`

#### `claim`

Claims available vested tokens.

```rust
pub fn claim(env: Env, schedule_id: u64)
```

**Authorization:** Must be called by the beneficiary
**Returns:** Transfers `vested_amount - already_claimed` to beneficiary
**Errors:** Panics with "Nothing to claim yet" if no tokens are available

**Events Emitted:**
- `TokensClaimed { schedule_id, beneficiary, amount }`

#### `revoke`

Revokes a revocable schedule (grantor only).

```rust
pub fn revoke(env: Env, schedule_id: u64)
```

**Authorization:** Must be called by the grantor
**Behavior:** 
- Calculates vested amount at revocation time
- Releases already-vested tokens to beneficiary
- Returns unvested remainder to grantor

**Events Emitted:**
- `ScheduleRevoked { schedule_id, grantor, unvested_amount }`

### Read-Only Functions

#### `claimable`

Returns the amount of tokens currently claimable.

```rust
pub fn claimable(env: Env, schedule_id: u64) -> i128
```

#### `get_schedule`

Returns complete schedule information.

```rust
pub fn get_schedule(env: Env, schedule_id: u64) -> VestingSchedule
```

#### `schedule_count`

Returns total number of schedules created.

```rust
pub fn schedule_count(env: Env) -> u64
```

### Data Structures

#### `VestingSchedule`

```rust
pub struct VestingSchedule {
    pub grantor: Address,
    pub beneficiary: Address,
    pub token: Address,
    pub total_amount: i128,
    pub claimed_amount: i128,
    pub start_time: u64,
    pub duration: u64,
    pub cliff_duration: u64,
    pub kind: VestingKind,
    pub revocable: bool,
    pub revoked: bool,
}
```

#### `VestingKind`

```rust
pub enum VestingKind {
    Linear,  // Continuous unlock over duration
    Cliff,   // All tokens unlock after cliff period
}
```

## Frontend Integration

### Wallet Connection

```typescript
import { WalletProvider } from './lib/WalletContext';

function App({ children }: { children: React.ReactNode }) {
  return (
    <WalletProvider>
      {children}
    </WalletProvider>
  );
}
```

### Contract Interaction

```typescript
import { createSchedule, claimTokens, getClaimable } from './lib/stellar';

// Create a vesting schedule
const scheduleId = await createSchedule({
  beneficiary: 'GXXXXXXX...',
  totalAmount: '1000000000', // 100 XLM in stroops
  startTime: Math.floor(Date.now() / 1000),
  duration: 365 * 24 * 60 * 60, // 1 year
  cliffDuration: 90 * 24 * 60 * 60, // 90 days
  kind: 'Linear',
  revocable: true,
});

// Check claimable amount
const claimable = await getClaimable(scheduleId);

// Claim vested tokens
await claimTokens(scheduleId);
```

### Component Examples

#### Schedule Card Component

```typescript
interface ScheduleCardProps {
  schedule: VestingSchedule;
  onClaim: () => void;
  onRevoke: () => void;
}

export function ScheduleCard({ schedule, onClaim, onRevoke }: ScheduleCardProps) {
  const [claimable, setClaimable] = useState<string>('0');
  
  useEffect(() => {
    getClaimable(schedule.id).then(setClaimable);
  }, [schedule.id]);
  
  return (
    <div className="border rounded-lg p-4">
      <h3>Schedule #{schedule.id}</h3>
      <p>Beneficiary: {schedule.beneficiary}</p>
      <p>Claimable: {claimable} stroops</p>
      
      {claimable !== '0' && (
        <button onClick={onClaim}>Claim Tokens</button>
      )}
      
      {schedule.revocable && !schedule.revoked && (
        <button onClick={onRevoke}>Revoke Schedule</button>
      )}
    </div>
  );
}
```

## Development Guide

### Prerequisites

- Node.js ≥ 18
- Rust with `wasm32v1-none` target
- Stellar CLI
- Freighter wallet (Testnet mode)

### Setup

```bash
# Clone repository
git clone https://github.com/libby-coder/vestflow.git
cd vestflow

# Install dependencies
npm install

# Set up environment
cp .env.local.example .env.local

# Start development server
npm run dev
```

### Testing

#### Smart Contract Tests

```bash
cd contracts/vestflow
cargo test
```

#### Frontend Tests

```bash
npm test
```

### Building

#### Contract Build

```bash
cd contracts/vestflow
cargo build --target wasm32v1-none --release
```

#### Frontend Build

```bash
npm run build
```

## Deployment

### Contract Deployment

1. **Generate Deployer Key**
```bash
stellar keys generate deployer --network testnet
stellar keys fund deployer --network testnet
```

2. **Deploy Contract**
```bash
stellar contract deploy \
  --wasm target/wasm32v1-none/release/vestflow.wasm \
  --source deployer \
  --network testnet
```

3. **Update Environment**
```bash
# Add contract ID to .env.local
NEXT_PUBLIC_CONTRACT_ID=<your-contract-id>
```

### Frontend Deployment

#### Vercel Deployment

```bash
# Install Vercel CLI
npm i -g vercel

# Deploy
vercel --prod
```

#### Environment Variables

Required environment variables:

```bash
NEXT_PUBLIC_CONTRACT_ID=<contract-address>
NEXT_PUBLIC_NETWORK=testnet
NEXT_PUBLIC_RPC_URL=https://soroban-testnet.stellar.org
```

## Team / DAO Vesting — Multisig Beneficiaries

VestFlow supports any valid Stellar account address as the beneficiary, including multisig
accounts and DAO treasury accounts.

### How it works

Stellar's native multisig model means that `beneficiary.require_auth()` inside the contract
is satisfied as long as the `claim` transaction carries the required threshold of signatures
for that account. No contract changes are needed.

### Setting up a multisig beneficiary

1. **Configure the Stellar account** — set the signing threshold and add co-signers using
   Stellar Laboratory or the Stellar CLI:

   ```bash
   stellar account set-options \
     --source <treasury-account> \
     --network testnet \
     --med-threshold 2 \
     --signer <signer-b-pubkey>:1 \
     --signer <signer-c-pubkey>:1
   ```

2. **Create the schedule** — pass the multisig account address as `beneficiary` in
   `create_schedule`. The grantor flow is identical to a single-key beneficiary.

3. **Claim vested tokens** — all required signers must co-sign the `claim` transaction.
   Because Freighter currently supports single-key signing, use the Stellar CLI or a
   multisig-capable wallet (Lobstr, StellarTerm) to collect signatures:

   ```bash
   # Build the unsigned transaction
   stellar contract invoke \
     --id <CONTRACT_ID> \
     --network testnet \
     --source <one-signer> \
     --build-only \
     -- claim --schedule_id <ID> > claim.xdr

   # Each additional signer adds their signature
   stellar tx sign claim.xdr --source <another-signer> --network testnet

   # Submit the fully-signed transaction
   stellar tx submit claim.xdr --network testnet
   ```

### DAO contract as beneficiary

A Soroban contract address (e.g. a DAO governance contract) can also be the beneficiary if
the contract implements the Soroban auth interface (`require_auth` / `__check_auth`). Verify
the DAO contract supports this before creating the schedule.

### Tested flows

| Scenario | Behaviour |
|---|---|
| Multisig account, threshold met | `claim` succeeds; tokens transferred to multisig account |
| Multisig account, threshold not met | Transaction rejected by Stellar protocol before reaching contract |
| DAO contract with `__check_auth` | `claim` succeeds if the DAO contract approves the invocation |
| DAO contract without auth support | Transaction fails with auth error |

### Security notes

- The grantor cannot distinguish a multisig address from a regular address — the on-chain
  enforcement is identical.
- For irrevocable schedules with a multisig beneficiary, ensure the multisig account is
  properly configured before creating the schedule. If signers are lost and the threshold
  cannot be met, the tokens will be permanently locked.
- Consider using a time-locked or social-recovery multisig for long-duration schedules.

---

## Security Considerations

### Smart Contract Security

1. **No Admin Keys**: Contract has no privileged owner or upgrade mechanism
2. **Authorization Checks**: All functions verify caller authorization
3. **Atomic Operations**: Token transfers happen atomically with state changes
4. **Integer Arithmetic**: Uses safe integer math to prevent overflow/underflow
5. **Immutable Settings**: Revocable flag cannot be changed after creation

### Frontend Security

1. **Wallet Integration**: Uses official Freighter API
2. **Transaction Signing**: All transactions require user approval
3. **Input Validation**: Validates all user inputs before contract calls
4. **Error Handling**: Graceful error handling for failed transactions

### Best Practices

1. **Test Thoroughly**: Always test on testnet before mainnet
2. **Verify Contracts**: Verify contract source code matches deployed bytecode
3. **Monitor Events**: Set up event monitoring for schedule activities
4. **Backup Keys**: Securely store all private keys and recovery phrases

## Troubleshooting

### Common Issues

#### "Insufficient Balance" Error

**Cause**: Grantor doesn't have enough tokens
**Solution**: Ensure grantor has sufficient token balance before creating schedule

#### "Nothing to claim yet" Error

**Cause**: No tokens have vested yet
**Solution**: Wait for vesting period to begin or check schedule parameters

#### "Schedule is not revocable" Error

**Cause**: Attempting to revoke an irrevocable schedule
**Solution**: Only revocable schedules can be revoked

#### Wallet Connection Issues

**Cause**: Freighter not installed or wrong network
**Solution**: 
1. Install Freighter extension
2. Switch to correct network (Testnet/Mainnet)
3. Refresh page and reconnect

### Debug Tools

#### Contract Simulation

```bash
# Simulate contract call without submitting
stellar contract invoke \
  --id <contract-id> \
  --network testnet \
  --source <keypair> \
  -- claimable --schedule_id 1
```

#### Event Monitoring

```typescript
// Monitor contract events
const events = await server.getEvents({
  startLedger: 'now',
  filters: [
    {
      type: 'contract',
      contractIds: [CONTRACT_ID],
    },
  ],
});
```

### Support

For additional support:

1. Check [GitHub Issues](https://github.com/libby-coder/vestflow/issues)
2. Review [Soroban Documentation](https://developers.stellar.org/docs/smart-contracts)
3. Join [Stellar Discord](https://discord.gg/stellardev)

---

*Last updated: May 30, 2026*