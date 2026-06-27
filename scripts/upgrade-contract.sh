#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NETWORK="${NETWORK:-testnet}"
SOURCE="${SOURCE:-${STELLAR_ACCOUNT:-admin}}"
CONTRACT_ID="${CONTRACT_ID:?Set CONTRACT_ID to the contract being upgraded}"
RPC_URL="${RPC_URL:-}"
WASM_PATH="${WASM_PATH:-${REPO_ROOT}/contracts/target/wasm32v1-none/release/vestflow.wasm}"
OPT_WASM_PATH="${OPT_WASM_PATH:-${REPO_ROOT}/contracts/target/wasm32v1-none/release/vestflow.optimized.wasm}"
WASM_HASH="${WASM_HASH:-}"
ACTION="${ACTION:-announce}"

case "${NETWORK}" in
  mainnet)
    RPC_URL="${RPC_URL:-https://mainnet.sorobanrpc.com}"
    NETWORK_PASSPHRASE="Public Global Stellar Network ; September 2015"
    ;;
  testnet)
    RPC_URL="${RPC_URL:-https://soroban-testnet.stellar.org}"
    NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
    ;;
  *)
    echo "NETWORK must be testnet or mainnet" >&2
    exit 1
    ;;
esac

build_and_upload() {
  cargo build --target wasm32v1-none --release --manifest-path "${REPO_ROOT}/contracts/Cargo.toml"
  stellar contract optimize --wasm "${WASM_PATH}" --wasm-out "${OPT_WASM_PATH}"
  stellar contract upload \
    --wasm "${OPT_WASM_PATH}" \
    --source "${SOURCE}" \
    --network "${NETWORK}" \
    --rpc-url "${RPC_URL}" \
    --network-passphrase "${NETWORK_PASSPHRASE}"
}

if [[ "${ACTION}" == "upload" || -z "${WASM_HASH}" ]]; then
  echo "▶ Building, optimizing, and uploading WASM..."
  WASM_HASH="$(build_and_upload | tail -n 1)"
  echo "WASM_HASH=${WASM_HASH}"
fi

case "${ACTION}" in
  upload)
    ;;
  announce)
    stellar contract invoke \
      --id "${CONTRACT_ID}" \
      --source "${SOURCE}" \
      --network "${NETWORK}" \
      --rpc-url "${RPC_URL}" \
      --network-passphrase "${NETWORK_PASSPHRASE}" \
      -- \
      announce_upgrade \
      --authority "${SOURCE}" \
      --wasm-hash "${WASM_HASH}"
    ;;
  execute)
    stellar contract invoke \
      --id "${CONTRACT_ID}" \
      --source "${SOURCE}" \
      --network "${NETWORK}" \
      --rpc-url "${RPC_URL}" \
      --network-passphrase "${NETWORK_PASSPHRASE}" \
      -- \
      execute_upgrade \
      --authority "${SOURCE}"
    ;;
  *)
    echo "ACTION must be upload, announce, or execute" >&2
    exit 1
    ;;
esac

