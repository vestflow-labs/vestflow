#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REGISTRY_FILE="${REPO_ROOT}/DEPLOYMENTS.md"

VERSION="${VERSION:-}"
NETWORK="${NETWORK:-}"
CONTRACT_ID="${CONTRACT_ID:-}"
WASM_HASH="${WASM_HASH:-}"
DEPLOYED_AT="${DEPLOYED_AT:-$(date -u +"%Y-%m-%dT%H:%M:%SZ")}"
NOTES="${NOTES:-}"

usage() {
  cat <<USAGE
Usage:
  VERSION=v0.1.0 NETWORK=testnet CONTRACT_ID=CC... [WASM_HASH=...] [NOTES=...] scripts/update-deployment-registry.sh
USAGE
}

if [[ -z "${VERSION}" || -z "${NETWORK}" || -z "${CONTRACT_ID}" ]]; then
  usage >&2
  exit 1
fi

case "${NETWORK}" in
  testnet|mainnet) ;;
  *)
    echo "NETWORK must be either testnet or mainnet" >&2
    exit 1
    ;;
esac

if [[ ! -f "${REGISTRY_FILE}" ]]; then
  cat > "${REGISTRY_FILE}" <<'EOF'
# VestFlow Deployments

This registry maps tagged contract releases to deployed contract IDs.

| Version | Network | Contract ID | Wasm Hash | Deployed At (UTC) | Notes |
|---|---|---|---|---|---|
EOF
fi

ROW="| ${VERSION} | ${NETWORK} | \`${CONTRACT_ID}\` | ${WASM_HASH:-TBD} | ${DEPLOYED_AT} | ${NOTES:-} |"

if grep -Fq "| ${VERSION} | ${NETWORK} |" "${REGISTRY_FILE}"; then
  echo "A deployment entry for ${VERSION} on ${NETWORK} already exists in ${REGISTRY_FILE}" >&2
  exit 1
fi

printf '%s\n' "${ROW}" >> "${REGISTRY_FILE}"
echo "Recorded ${NETWORK} deployment for ${VERSION} in ${REGISTRY_FILE}"
