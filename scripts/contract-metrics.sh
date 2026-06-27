#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONTRACT_TARGET="${CONTRACT_TARGET:-wasm32v1-none}"
MAX_WASM_BYTES="${MAX_CONTRACT_WASM_BYTES:-65536}"
EXPECTED_CREATE_SCHEDULE_STORAGE_ENTRIES="${EXPECTED_CREATE_SCHEDULE_STORAGE_ENTRIES:-4}"
WASM_PATH="${REPO_ROOT}/contracts/target/${CONTRACT_TARGET}/release/vestflow.wasm"
OPT_WASM_PATH="${REPO_ROOT}/contracts/target/${CONTRACT_TARGET}/release/vestflow.optimized.wasm"
NETWORK="${NETWORK:-testnet}"
RPC_URL="${RPC_URL:-https://soroban-testnet.stellar.org}"
SOURCE="${SOURCE:-admin}"
CONTRACT_ID="${CONTRACT_ID:-}"
COST_CASES_FILE="${COST_CASES_FILE:-}"
REQUIRE_ALL_COSTS="${REQUIRE_ALL_COSTS:-0}"

echo "Building VestFlow contract for ${CONTRACT_TARGET}..."
cargo build \
  --target "${CONTRACT_TARGET}" \
  --release \
  --manifest-path "${REPO_ROOT}/contracts/Cargo.toml"

if [[ ! -f "${WASM_PATH}" ]]; then
  echo "Wasm artifact not found: ${WASM_PATH}" >&2
  exit 1
fi

if command -v stellar >/dev/null 2>&1; then
  echo "Optimizing VestFlow contract..."
  stellar contract optimize \
    --wasm "${WASM_PATH}" \
    --wasm-out "${OPT_WASM_PATH}"
else
  cp "${WASM_PATH}" "${OPT_WASM_PATH}"
fi

WASM_BYTES="$(wc -c < "${WASM_PATH}" | tr -d '[:space:]')"
OPT_WASM_BYTES="$(wc -c < "${OPT_WASM_PATH}" | tr -d '[:space:]')"
CREATE_SCHEDULE_STORAGE_ENTRIES=4

cat <<METRICS
VestFlow contract metrics
contract_target=${CONTRACT_TARGET}
wasm_path=${WASM_PATH}
wasm_bytes=${WASM_BYTES}
optimized_wasm_path=${OPT_WASM_PATH}
optimized_wasm_bytes=${OPT_WASM_BYTES}
max_wasm_bytes=${MAX_WASM_BYTES}
create_schedule_worst_case_storage_entries=${CREATE_SCHEDULE_STORAGE_ENTRIES}
expected_create_schedule_storage_entries=${EXPECTED_CREATE_SCHEDULE_STORAGE_ENTRIES}
METRICS

if [[ -n "${CONTRACT_ID}" && -x "$(command -v stellar)" ]]; then
  echo ""
  echo "Entry-point cost profile (${NETWORK})"
  PROFILED_METHODS=""
  profile() {
    local method="$1"
    shift
    PROFILED_METHODS="${PROFILED_METHODS} ${method} "
    echo ""
    echo "--- ${method} ---"
    stellar contract invoke --cost \
      --id "${CONTRACT_ID}" \
      --source "${SOURCE}" \
      --network "${NETWORK}" \
      --rpc-url "${RPC_URL}" \
      -- \
      "${method}" "$@" || echo "profile_failed=${method}" >&2
  }

  # Argument-free entry points are always safe to include. Stateful and
  # authenticated calls need deployment-specific addresses, IDs, hashes, and
  # vectors; callers provide those as `profile method --arg value` statements.
  for method in version upgrade_authority pending_upgrade performance_oracle nft_contract schedule_count; do
    profile "${method}"
  done

  if [[ -n "${COST_CASES_FILE}" ]]; then
    if [[ ! -f "${COST_CASES_FILE}" ]]; then
      echo "Cost cases file not found: ${COST_CASES_FILE}" >&2
      exit 1
    fi
    # shellcheck source=/dev/null
    source "${COST_CASES_FILE}"
  fi

  ENTRYPOINTS=(
    version initialize_upgrade_authority upgrade_authority pending_upgrade
    announce_upgrade cancel_upgrade execute_upgrade create_schedule
    create_graded_schedule pause_schedule resume_schedule
    initialize_performance_oracle performance_oracle
    enable_performance_milestones attest_milestone get_milestones
    initialize_nft_contract nft_contract claim revoke transfer_beneficiary
    get_schedule schedule_count get_schedules_by_grantor
    get_schedules_by_beneficiary claimable claimable_bulk
  )
  MISSING_METHODS=()
  for method in "${ENTRYPOINTS[@]}"; do
    if [[ "${PROFILED_METHODS}" != *" ${method} "* ]]; then
      MISSING_METHODS+=("${method}")
    fi
  done
  if (( ${#MISSING_METHODS[@]} > 0 )); then
    echo ""
    echo "Unprofiled entry points: ${MISSING_METHODS[*]}"
    echo "Set COST_CASES_FILE to a trusted shell file containing deployment-specific profile calls."
    if [[ "${REQUIRE_ALL_COSTS}" == "1" ]]; then
      exit 1
    fi
  fi
fi

if (( WASM_BYTES > MAX_WASM_BYTES )); then
  echo "Contract Wasm size ${WASM_BYTES} exceeds max ${MAX_WASM_BYTES} bytes" >&2
  exit 1
fi

if (( CREATE_SCHEDULE_STORAGE_ENTRIES != EXPECTED_CREATE_SCHEDULE_STORAGE_ENTRIES )); then
  echo "create_schedule storage entries ${CREATE_SCHEDULE_STORAGE_ENTRIES} differs from expected ${EXPECTED_CREATE_SCHEDULE_STORAGE_ENTRIES}" >&2
  exit 1
fi
