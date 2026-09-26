# Local Development Quickstart with Soroban CLI

Get a local VestFlow sandbox running and interact with a vesting schedule in under 10 steps.

## Prerequisites

- [Rust](https://www.rust-lang.org/tools/install) (stable toolchain)
- [Soroban CLI](https://developers.stellar.org/docs/tools/developer-tools/cli/stellar-cli) v21+
- [Node.js](https://nodejs.org/) v18+
- [npm](https://www.npmjs.com/) v9+

Install the Soroban CLI if you haven't already:

```bash
cargo install --locked stellar-cli --features opt
```

---

## Steps

### 1. Clone the repository

```bash
git clone https://github.com/vestflow-labs/vestflow.git
cd vestflow
npm install
```

### 2. Start a local Stellar network

```bash
stellar network start local
```

This spins up a local Stellar node accessible at `http://localhost:8000`.

### 3. Configure the local network in the CLI

```bash
stellar network add local \
  --rpc-url http://localhost:8000/soroban/rpc \
  --network-passphrase "Standalone Network ; February 2017"
```

### 4. Create test accounts (grantor and beneficiary)

```bash
stellar keys generate grantor --network local
stellar keys generate beneficiary --network local
```

Fund both accounts from the local friendbot:

```bash
stellar keys fund grantor --network local
stellar keys fund beneficiary --network local
```

### 5. Build and deploy the VestFlow contract

```bash
stellar contract build
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/vestflow.wasm \
  --source grantor \
  --network local
```

Copy the printed **contract address** — you'll use it in the steps below as `<CONTRACT_ID>`.

### 6. Create a vesting schedule

```bash
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source grantor \
  --network local \
  -- \
  create_schedule \
  --grantor $(stellar keys address grantor) \
  --beneficiary $(stellar keys address beneficiary) \
  --amount 1000000000 \
  --start_time 0 \
  --cliff_time 0 \
  --end_time 86400
```

This creates a linear schedule vesting 1000 XLM over 24 hours starting immediately.

### 7. Check the claimable amount

```bash
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source beneficiary \
  --network local \
  -- \
  claimable_amount \
  --schedule_id 0 \
  --current_time $(date +%s)
```

### 8. Claim vested tokens

```bash
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source beneficiary \
  --network local \
  -- \
  claim \
  --schedule_id 0
```

### 9. (Optional) Revoke the schedule

Only the grantor can revoke a revocable schedule:

```bash
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source grantor \
  --network local \
  -- \
  revoke_schedule \
  --schedule_id 0
```

---

## Next Steps

- Explore the [examples/](../examples/) directory for runnable JS/TS scripts.
- Read the [architecture overview](./architecture.md) to understand the contract data model.
- Check the [CONTRIBUTING.md](../CONTRIBUTING.md) guide before opening a PR.
