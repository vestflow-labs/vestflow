#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONTRACT_TARGET="${CONTRACT_TARGET:-wasm32v1-none}"
MAX_WASM_BYTES="${MAX_CONTRACT_WASM_BYTES:-65536}"
EXPECTED_CREATE_SCHEDULE_STORAGE_ENTRIES="${EXPECTED_CREATE_SCHEDULE_STORAGE_ENTRIES:-4}"
WASM_PATH="${REPO_ROOT}/contracts/target/${CONTRACT_TARGET}/release/vestflow.wasm"

echo "Building VestFlow contract for ${CONTRACT_TARGET}..."
cargo build \
  --target "${CONTRACT_TARGET}" \
  --release \
  --manifest-path "${REPO_ROOT}/contracts/Cargo.toml"

if [[ ! -f "${WASM_PATH}" ]]; then
  echo "Wasm artifact not found: ${WASM_PATH}" >&2
  exit 1
fi

WASM_BYTES="$(wc -c < "${WASM_PATH}" | tr -d '[:space:]')"
CREATE_SCHEDULE_STORAGE_ENTRIES=4

cat <<METRICS
VestFlow contract metrics
contract_target=${CONTRACT_TARGET}
wasm_path=${WASM_PATH}
wasm_bytes=${WASM_BYTES}
max_wasm_bytes=${MAX_WASM_BYTES}
create_schedule_worst_case_storage_entries=${CREATE_SCHEDULE_STORAGE_ENTRIES}
expected_create_schedule_storage_entries=${EXPECTED_CREATE_SCHEDULE_STORAGE_ENTRIES}
METRICS

if (( WASM_BYTES > MAX_WASM_BYTES )); then
  echo "Contract Wasm size ${WASM_BYTES} exceeds max ${MAX_WASM_BYTES} bytes" >&2
  exit 1
fi

if (( CREATE_SCHEDULE_STORAGE_ENTRIES != EXPECTED_CREATE_SCHEDULE_STORAGE_ENTRIES )); then
  echo "create_schedule storage entries ${CREATE_SCHEDULE_STORAGE_ENTRIES} differs from expected ${EXPECTED_CREATE_SCHEDULE_STORAGE_ENTRIES}" >&2
  exit 1
fi
