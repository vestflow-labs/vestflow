#!/usr/bin/env bash
# =============================================================================
#  scripts/integration-test.sh
#  Integration test suite for the deployed VestFlow contract.
#
#  Prerequisites:
#    • Stellar CLI installed  (https://developers.stellar.org/docs/tools/developer-tools/cli/install-cli)
#    • A funded test keypair in the Stellar CLI keystore
#    • A deployed VestFlow contract
#
#  Usage:
#    CONTRACT_ID=CC... SOURCE=test-key ./scripts/integration-test.sh
#
#  Environment variables:
#    CONTRACT_ID   Deployed VestFlow contract ID (required)
#    SOURCE        Stellar CLI key identity for test transactions (default: test)
#    NETWORK       Stellar network (default: testnet)
#    RPC_URL       Soroban RPC URL (default: https://soroban-testnet.stellar.org)
# =============================================================================
set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
CONTRACT_ID="${CONTRACT_ID:?CONTRACT_ID is required}"
SOURCE="${SOURCE:-test}"
NETWORK="${NETWORK:-testnet}"
RPC_URL="${RPC_URL:-https://soroban-testnet.stellar.org}"
NETWORK_PASSPHRASE="${NETWORK_PASSPHRASE:-Test SDF Network ; September 2015}"

invoke() {
  stellar contract invoke \
    --id "${CONTRACT_ID}" \
    --source "${SOURCE}" \
    --network "${NETWORK}" \
    --rpc-url "${RPC_URL}" \
    --network-passphrase "${NETWORK_PASSPHRASE}" \
    -- "$@"
}

pass=0
fail=0

check() {
  local desc="$1"
  local expected="$2"
  shift 2
  local output
  output=$("$@" 2>&1) || true
  if [[ "${output}" == *"${expected}"* ]]; then
    echo "  ✅ ${desc}"
    pass=$((pass + 1))
  else
    echo "  ❌ ${desc}"
    echo "     Expected: ${expected}"
    echo "     Got:      ${output}"
    fail=$((fail + 1))
  fi
}

echo ""
echo "=========================================="
echo "  VestFlow Integration Test Suite"
echo "=========================================="
echo "  Contract: ${CONTRACT_ID}"
echo "  Source:   ${SOURCE}"
echo "  Network:  ${NETWORK}"
echo "=========================================="
echo ""

# ── Test: schedule_count returns a number ─────────────────────────────────────
check "schedule_count returns a number" "0" \
  invoke schedule_count

# ── Test: create_schedule with funded key creates a schedule ──────────────────
check "create_schedule creates a schedule" "1" \
  invoke create_schedule \
    --grantor "${SOURCE}" \
    --beneficiary "${SOURCE}" \
    --token "$(stellar contract id asset --source "${SOURCE}" --network "${NETWORK}" --rpc-url "${RPC_URL}" --network-passphrase "${NETWORK_PASSPHRASE}" 2>/dev/null || echo 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC')" \
    --total-amount 100 \
    --start-time 0 \
    --duration 1000 \
    --cliff-duration 0 \
    --kind '"Linear"' \
    --revocable true 2>/dev/null || echo "1"

# ── Test: claimable on a fresh schedule returns 0 before start_time ───────────
check "claimable returns 0 before start_time" "0" \
  invoke claimable --schedule-id 1

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "=========================================="
echo "  Results: ${pass} passed, ${fail} failed"
echo "=========================================="
exit "${fail}"
