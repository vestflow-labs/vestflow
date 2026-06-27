#!/usr/bin/env bash
# =============================================================================
#  scripts/deploy-mainnet.sh
#  Deploy the VestFlow contract to Stellar Mainnet.
#
#  Prerequisites:
#    • Rust + wasm32v1-none target installed
#    • Stellar CLI installed  (https://developers.stellar.org/docs/tools/developer-tools/cli/install-cli)
#    • A funded deployer key in the Stellar CLI keystore
#
#  Usage:
#    chmod +x scripts/deploy-mainnet.sh
#    DEPLOYER_KEY=deployer ./scripts/deploy-mainnet.sh
#
#  The script will:
#    1. Build the WASM in release mode
#    2. Deploy to mainnet and print the contract ID
#    3. Remind you to update .env.local and CSP config
# =============================================================================
set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
NETWORK="mainnet"
NETWORK_PASSPHRASE="Public Global Stellar Network ; September 2015"
RPC_URL="https://mainnet.sorobanrpc.com"
WASM_PATH="contracts/target/wasm32v1-none/release/vestflow.wasm"
OPT_WASM_PATH="contracts/target/wasm32v1-none/release/vestflow.optimized.wasm"
DEPLOYER_KEY="${DEPLOYER_KEY:-deployer}"   # override via env var
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${VERSION:-$(git -C "${REPO_ROOT}" describe --tags --always --dirty 2>/dev/null || echo untagged)}"
UPDATE_DEPLOYMENTS="${UPDATE_DEPLOYMENTS:-1}"
WASM_HASH=""

# ── Safety gate ──────────────────────────────────────────────────────────────
echo ""
echo "⚠️  You are about to deploy VestFlow to STELLAR MAINNET."
echo "   This is irreversible unless the deployed contract has an initialized upgrade authority."
echo ""
echo "   Mainnet deployment checklist:"
echo "   [ ] Security audit or internal review completed"
echo "   [ ] Immutability decision documented"
echo "   [ ] Deployer key management procedure followed"
echo "   [ ] .env.local updated with mainnet values"
echo "   [ ] next.config.ts CSP verified for mainnet RPC endpoint"
echo ""
read -rp "Type 'deploy' to continue: " CONFIRM
if [[ "${CONFIRM}" != "deploy" ]]; then
  echo "Aborted."
  exit 1
fi

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

if [[ "${UPDATE_DEPLOYMENTS}" != "0" ]]; then
  echo ""
  echo "▶ Recording deployment in DEPLOYMENTS.md..."
  VERSION="${VERSION}" \
    NETWORK="${NETWORK}" \
    CONTRACT_ID="${CONTRACT_ID}" \
    WASM_HASH="${WASM_HASH}" \
    NOTES="${DEPLOYMENT_NOTES:-deployed by scripts/deploy-mainnet.sh}" \
    "${REPO_ROOT}/scripts/update-deployment-registry.sh"
fi

echo ""
echo "Next steps:"
echo "  1. Add to .env.local:  NEXT_PUBLIC_CONTRACT_ID=${CONTRACT_ID}"
echo "  2. Set:                NEXT_PUBLIC_NETWORK=mainnet"
echo "  3. Rebuild frontend:   npm run build"
