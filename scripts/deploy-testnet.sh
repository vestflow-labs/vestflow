#!/usr/bin/env bash
# =============================================================================
#  scripts/deploy-testnet.sh
#  Deploy the VestFlow contract to Stellar Testnet.
#
#  Prerequisites:
#    • Rust + wasm32v1-none target installed
#    • Stellar CLI installed  (https://developers.stellar.org/docs/tools/developer-tools/cli/install-cli)
#    • A funded deployer key in the Stellar CLI keystore
#
#  Usage:
#    chmod +x scripts/deploy-testnet.sh
#    DEPLOYER_KEY=deployer ./scripts/deploy-testnet.sh
#
#  The script will:
#    1. Build the WASM in release mode
#    2. Deploy to testnet and write the contract ID into .env.local
#    3. Run a smoke-test (schedule_count) against the new deployment
# =============================================================================
set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
NETWORK="testnet"
NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
RPC_URL="https://soroban-testnet.stellar.org"
WASM_PATH="target/wasm32v1-none/release/vestflow.wasm"
DEPLOYER_KEY="${DEPLOYER_KEY:-deployer}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${REPO_ROOT}/.env.local"

# ── Build ─────────────────────────────────────────────────────────────────────
echo ""
echo "▶ Building WASM..."
(
  cd "${REPO_ROOT}/contracts/vestflow"
  cargo build --target wasm32v1-none --release 2>&1
)

# ── Deploy ────────────────────────────────────────────────────────────────────
echo ""
echo "▶ Deploying to ${NETWORK}..."
CONTRACT_ID=$(stellar contract deploy \
  --wasm "${REPO_ROOT}/${WASM_PATH}" \
  --source "${DEPLOYER_KEY}" \
  --network "${NETWORK}" \
  --rpc-url "${RPC_URL}" \
  --network-passphrase "${NETWORK_PASSPHRASE}")

echo ""
echo "✅  Contract deployed successfully!"
echo "   Contract ID: ${CONTRACT_ID}"
echo ""

# ── Write .env.local ──────────────────────────────────────────────────────────
echo "▶ Writing contract ID to ${ENV_FILE}..."
if [[ -f "${ENV_FILE}" ]]; then
  if grep -q '^NEXT_PUBLIC_CONTRACT_ID=' "${ENV_FILE}"; then
    sed -i '' "s/^NEXT_PUBLIC_CONTRACT_ID=.*/NEXT_PUBLIC_CONTRACT_ID=${CONTRACT_ID}/" "${ENV_FILE}"
  else
    echo "NEXT_PUBLIC_CONTRACT_ID=${CONTRACT_ID}" >> "${ENV_FILE}"
  fi
else
  cat > "${ENV_FILE}" <<-EOF
		NEXT_PUBLIC_CONTRACT_ID=${CONTRACT_ID}
		NEXT_PUBLIC_NATIVE_TOKEN=CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC
		NEXT_PUBLIC_NETWORK=testnet
		EOF
fi

echo "   Updated NEXT_PUBLIC_CONTRACT_ID in ${ENV_FILE}"

# ── Smoke test ────────────────────────────────────────────────────────────────
echo ""
echo "▶ Running smoke test (schedule_count)..."
RESULT=$(stellar contract invoke \
  --id "${CONTRACT_ID}" \
  --source "${DEPLOYER_KEY}" \
  --network "${NETWORK}" \
  --rpc-url "${RPC_URL}" \
  --network-passphrase "${NETWORK_PASSPHRASE}" \
  -- \
  schedule_count 2>&1)

echo "   schedule_count returned: ${RESULT}"
echo ""
echo "✅  Smoke test passed!"
echo ""
echo "Next steps:"
echo "  1. Frontend will now use the contract at: ${CONTRACT_ID}"
echo "  2. Run integration tests: ./scripts/integration-test.sh"
