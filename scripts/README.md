# VestFlow Scripts

This directory contains shell scripts for deploying and testing the VestFlow contract.

## Prerequisites

- [Stellar CLI](https://developers.stellar.org/docs/tools/developer-tools/cli/install-cli)
- Rust with `wasm32v1-none` target
- A funded Stellar keypair in the CLI keystore

## Funding a key

```bash
stellar keys generate my-key --network testnet
stellar keys fund my-key --network testnet
```

Check the balance:
```bash
stellar keys balance my-key --network testnet
```

## Scripts

### `deploy-testnet.sh`

Builds and deploys the contract to Stellar Testnet, writes the contract ID to `.env.local`, and runs a smoke test.

```bash
DEPLOYER_KEY=my-key ./scripts/deploy-testnet.sh
```

### `deploy-mainnet.sh`

Same flow for Stellar Mainnet with additional safety prompts.

```bash
DEPLOYER_KEY=my-mainnet-key ./scripts/deploy-mainnet.sh
```

### `integration-test.sh`

Runs a suite of integration tests against a deployed contract.

```bash
CONTRACT_ID=CC... SOURCE=my-key ./scripts/integration-test.sh
```

The test suite covers:
- `schedule_count` returns a number
- `create_schedule` with a funded key creates a schedule
- `claimable` on a fresh schedule returns 0 before `start_time`
