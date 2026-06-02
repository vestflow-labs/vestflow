#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONTRACT_TARGET="${CONTRACT_TARGET:-wasm32v1-none}"
WASM_PATH="${REPO_ROOT}/contracts/target/${CONTRACT_TARGET}/release/vestflow.wasm"
OUTPUT_DIR="${REPO_ROOT}/lib/bindings/vestflow"

echo "Building VestFlow contract for ${CONTRACT_TARGET}..."
cargo build \
  --target "${CONTRACT_TARGET}" \
  --release \
  --manifest-path "${REPO_ROOT}/contracts/Cargo.toml"

echo "Generating TypeScript bindings from ${WASM_PATH}..."
stellar contract bindings typescript \
  --wasm "${WASM_PATH}" \
  --output-dir "${OUTPUT_DIR}" \
  --overwrite

find "${OUTPUT_DIR}" -type f \( -name "*.ts" -o -name "*.md" -o -name "*.json" \) \
  -exec perl -pi -e 's/[ \t]+$//' {} +

echo "Generated bindings in ${OUTPUT_DIR}"
