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
WASM_PATH="contracts/target/wasm32v1-none/release/vestflow.wasm"
OPT_WASM_PATH="contracts/target/wasm32v1-none/release/vestflow.optimized.wasm"
DEPLOYER_KEY="${DEPLOYER_KEY:-deployer}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${VERSION:-$(git -C "${REPO_ROOT}" describe --tags --always --dirty 2>/dev/null || echo untagged)}"
UPDATE_DEPLOYMENTS="${UPDATE_DEPLOYMENTS:-1}"
ENV_FILE="${REPO_ROOT}/.env.local"
WASM_HASH=""

# ── Build ─────────────────────────────────────────────────────────────────────
echo ""
echo "▶ Building WASM..."
(
  cd "${REPO_ROOT}/contracts/vestflow"
  cargo build --target wasm32v1-none --release 2>&1
)

echo ""
echo "▶ Optimizing WASM..."
stellar contract optimize \
  --wasm "${REPO_ROOT}/${WASM_PATH}" \
  --wasm-out "${REPO_ROOT}/${OPT_WASM_PATH}"

if command -v sha256sum >/dev/null 2>&1; then
  WASM_HASH="$(sha256sum "${REPO_ROOT}/${OPT_WASM_PATH}" | awk '{print $1}')"
fi

# ── Deploy ────────────────────────────────────────────────────────────────────
echo ""
echo "▶ Deploying to ${NETWORK}..."
CONTRACT_ID=$(stellar contract deploy \
  --wasm "${REPO_ROOT}/${OPT_WASM_PATH}" \
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

if [[ "${UPDATE_DEPLOYMENTS}" != "0" ]]; then
  echo ""
  echo "▶ Recording deployment in DEPLOYMENTS.md..."
  VERSION="${VERSION}" \
    NETWORK="${NETWORK}" \
    CONTRACT_ID="${CONTRACT_ID}" \
    WASM_HASH="${WASM_HASH}" \
    NOTES="${DEPLOYMENT_NOTES:-deployed by scripts/deploy-testnet.sh}" \
    "${REPO_ROOT}/scripts/update-deployment-registry.sh"
fi

echo ""
echo "Next steps:"
echo "  1. Frontend will now use the contract at: ${CONTRACT_ID}"
echo "  2. Run integration tests: ./scripts/integration-test.sh"
