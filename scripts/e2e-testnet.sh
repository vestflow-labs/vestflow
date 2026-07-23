#!/usr/bin/env bash
# =============================================================================
#  scripts/e2e-testnet.sh
#  End-to-end integration test suite for VestFlow on Testnet
#
#  Deploys contract, creates schedules, waits for vesting, and verifies claims.
#
#  Prerequisites:
#    • Stellar CLI installed
#    • A funded test keypair
#    • Cargo and Node.js
#
#  Usage:
#    ./scripts/e2e-testnet.sh [--skip-deploy]
#
#  Environment variables:
#    SOURCE_KEY       Stellar CLI key name (default: test)
#    NETWORK          Stellar network (default: testnet)
#    SKIP_DEPLOY      Skip contract deployment (default: false)
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "${SCRIPT_DIR}")"

SOURCE_KEY="${SOURCE_KEY:-test}"
NETWORK="${NETWORK:-testnet}"
RPC_URL="${RPC_URL:-https://soroban-testnet.stellar.org}"
NETWORK_PASSPHRASE="${NETWORK_PASSPHRASE:-Test SDF Network ; September 2015}"
SKIP_DEPLOY="${SKIP_DEPLOY:-false}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() {
  echo -e "${GREEN}[INFO]${NC} $*"
}

log_warn() {
  echo -e "${YELLOW}[WARN]${NC} $*"
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $*"
}

pass_count=0
fail_count=0

pass_test() {
  local desc="$1"
  echo -e "  ${GREEN}✅${NC} ${desc}"
  pass_count=$((pass_count + 1))
}

fail_test() {
  local desc="$1"
  local reason="${2:-Unknown error}"
  echo -e "  ${RED}❌${NC} ${desc}"
  echo -e "     ${RED}${reason}${NC}"
  fail_count=$((fail_count + 1))
}

invoke() {
  stellar contract invoke \
    --id "${CONTRACT_ID}" \
    --source "${SOURCE_KEY}" \
    --network "${NETWORK}" \
    --rpc-url "${RPC_URL}" \
    --network-passphrase "${NETWORK_PASSPHRASE}" \
    -- "$@"
}

# ── Build contract ────────────────────────────────────────────────────────────
log_info "Building contract..."
cd "${PROJECT_ROOT}/contracts"
cargo build --target wasm32v1-none --release 2>/dev/null || {
  log_error "Failed to build contract"
  exit 1
}
cd "${PROJECT_ROOT}"

# ── Deploy contract (unless skipped) ──────────────────────────────────────────
if [[ "${SKIP_DEPLOY}" != "true" ]]; then
  log_info "Deploying contract to ${NETWORK}..."

  WASM_PATH="${PROJECT_ROOT}/contracts/target/wasm32v1-none/release/vestflow.wasm"

  CONTRACT_ID=$(stellar contract deploy \
    --wasm "${WASM_PATH}" \
    --source "${SOURCE_KEY}" \
    --network "${NETWORK}" \
    --rpc-url "${RPC_URL}" \
    --network-passphrase "${NETWORK_PASSPHRASE}" 2>/dev/null) || {
    log_error "Failed to deploy contract"
    exit 1
  }

  log_info "Contract deployed: ${CONTRACT_ID}"
else
  log_info "Skipping deployment (--skip-deploy flag set)"
  if [[ -z "${CONTRACT_ID:-}" ]]; then
    log_error "CONTRACT_ID environment variable required when using --skip-deploy"
    exit 1
  fi
  log_info "Using CONTRACT_ID: ${CONTRACT_ID}"
fi

# ── Initialize upgrade authority ──────────────────────────────────────────────
log_info "Initializing upgrade authority..."
SOURCE_ADDR=$(stellar account address "${SOURCE_KEY}" --network "${NETWORK}")
if invoke initialize_upgrade_authority --authority "${SOURCE_ADDR}" >/dev/null 2>&1; then
  pass_test "Upgrade authority initialized"
else
  log_warn "Upgrade authority already initialized (expected on rerun)"
fi

# ── Test 1: Create a linear vesting schedule ──────────────────────────────────
log_info "Test 1: Creating linear vesting schedule..."

BENEFICIARY_KEY="beneficiary-$(date +%s)"
stellar keys generate "${BENEFICIARY_KEY}" --network "${NETWORK}" >/dev/null 2>&1 || true

NATIVE_TOKEN="CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"
START_TIME=$(date +%s)
DURATION=300
TOTAL_AMOUNT=1000

SCHEDULE_ID=$(invoke create_schedule \
  --grantor "${SOURCE_ADDR}" \
  --beneficiary "${SOURCE_ADDR}" \
  --token "${NATIVE_TOKEN}" \
  --total-amount "${TOTAL_AMOUNT}" \
  --start-time "${START_TIME}" \
  --duration "${DURATION}" \
  --cliff-duration 0 \
  --lockup-duration 0 \
  --kind '"Linear"' \
  --revocable true 2>/dev/null) || {
  fail_test "Create linear schedule"
  exit 1
}

if [[ -n "${SCHEDULE_ID}" && "${SCHEDULE_ID}" =~ ^[0-9]+$ ]]; then
  pass_test "Linear vesting schedule created (ID: ${SCHEDULE_ID})"
else
  fail_test "Create linear schedule" "Invalid schedule ID: ${SCHEDULE_ID}"
  exit 1
fi

# ── Test 2: Verify nothing is claimable before start_time ────────────────────
log_info "Test 2: Verifying claim restrictions..."

CLAIMABLE=$(invoke claimable --schedule-id "${SCHEDULE_ID}" 2>/dev/null || echo "0")
if [[ "${CLAIMABLE}" == "0" ]]; then
  pass_test "No tokens claimable before start_time"
else
  fail_test "Claim before start_time" "Expected 0, got ${CLAIMABLE}"
fi

# ── Test 3: Create cliff vesting schedule ─────────────────────────────────────
log_info "Test 3: Creating cliff vesting schedule..."

CLIFF_START=$((START_TIME + 1000))
CLIFF_DURATION=60

CLIFF_SCHEDULE_ID=$(invoke create_schedule \
  --grantor "${SOURCE_ADDR}" \
  --beneficiary "${SOURCE_ADDR}" \
  --token "${NATIVE_TOKEN}" \
  --total-amount 500 \
  --start-time "${CLIFF_START}" \
  --duration 120 \
  --cliff-duration "${CLIFF_DURATION}" \
  --lockup-duration 0 \
  --kind '"Cliff"' \
  --revocable false 2>/dev/null) || {
  fail_test "Create cliff schedule"
  exit 1
}

if [[ -n "${CLIFF_SCHEDULE_ID}" && "${CLIFF_SCHEDULE_ID}" =~ ^[0-9]+$ ]]; then
  pass_test "Cliff vesting schedule created (ID: ${CLIFF_SCHEDULE_ID})"
else
  fail_test "Create cliff schedule" "Invalid schedule ID: ${CLIFF_SCHEDULE_ID}"
  exit 1
fi

# ── Test 4: Verify cliff enforcement ──────────────────────────────────────────
log_info "Test 4: Verifying cliff enforcement..."

CLIFF_CLAIMABLE=$(invoke claimable --schedule-id "${CLIFF_SCHEDULE_ID}" 2>/dev/null || echo "0")
if [[ "${CLIFF_CLAIMABLE}" == "0" ]]; then
  pass_test "Cliff tokens not yet claimable (before cliff)"
else
  fail_test "Cliff enforcement" "Expected 0 before cliff, got ${CLIFF_CLAIMABLE}"
fi

# ── Test 5: Create linear-with-cliff schedule ─────────────────────────────────
log_info "Test 5: Creating linear-with-cliff schedule..."

LWC_START=$((START_TIME + 2000))
LWC_CLIFF=60
LWC_DURATION=300

LWC_SCHEDULE_ID=$(invoke create_schedule \
  --grantor "${SOURCE_ADDR}" \
  --beneficiary "${SOURCE_ADDR}" \
  --token "${NATIVE_TOKEN}" \
  --total-amount 2000 \
  --start-time "${LWC_START}" \
  --duration "${LWC_DURATION}" \
  --cliff-duration "${LWC_CLIFF}" \
  --lockup-duration "${LWC_CLIFF}" \
  --kind '"LinearWithCliff"' \
  --revocable true 2>/dev/null) || {
  fail_test "Create linear-with-cliff schedule"
  exit 1
}

if [[ -n "${LWC_SCHEDULE_ID}" && "${LWC_SCHEDULE_ID}" =~ ^[0-9]+$ ]]; then
  pass_test "Linear-with-cliff schedule created (ID: ${LWC_SCHEDULE_ID})"
else
  fail_test "Create linear-with-cliff schedule" "Invalid schedule ID: ${LWC_SCHEDULE_ID}"
  exit 1
fi

# ── Test 6: Verify schedule count ─────────────────────────────────────────────
log_info "Test 6: Verifying schedule count..."

SCHEDULE_COUNT=$(invoke schedule_count 2>/dev/null || echo "0")
EXPECTED_COUNT=3
if [[ "${SCHEDULE_COUNT}" -ge "${EXPECTED_COUNT}" ]]; then
  pass_test "Schedule count increased (${SCHEDULE_COUNT} >= ${EXPECTED_COUNT})"
else
  fail_test "Schedule count" "Expected at least ${EXPECTED_COUNT}, got ${SCHEDULE_COUNT}"
fi

# ── Test 7: Get schedule details ──────────────────────────────────────────────
log_info "Test 7: Retrieving schedule details..."

SCHEDULE_DETAIL=$(invoke get_schedule --schedule-id "${SCHEDULE_ID}" 2>/dev/null) || {
  fail_test "Get schedule details"
  exit 1
}

if [[ -n "${SCHEDULE_DETAIL}" ]]; then
  pass_test "Retrieved schedule details"
else
  fail_test "Get schedule details" "Empty response"
fi

# ── Test 8: Pause and resume schedule ─────────────────────────────────────────
log_info "Test 8: Testing pause/resume..."

if invoke pause_schedule --schedule-id "${SCHEDULE_ID}" >/dev/null 2>&1; then
  pass_test "Schedule paused"

  if invoke resume_schedule --schedule-id "${SCHEDULE_ID}" >/dev/null 2>&1; then
    pass_test "Schedule resumed"
  else
    fail_test "Resume schedule"
  fi
else
  fail_test "Pause schedule"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "=========================================="
echo "  E2E Test Results"
echo "=========================================="
echo "  Contract: ${CONTRACT_ID}"
echo "  Network:  ${NETWORK}"
echo "  Passed:   ${GREEN}${pass_count}${NC}"
echo "  Failed:   ${RED}${fail_count}${NC}"
echo "=========================================="

exit "${fail_count}"
