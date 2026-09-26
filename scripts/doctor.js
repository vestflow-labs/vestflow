#!/usr/bin/env node
// vestflow doctor (#473) — preflight check for local development prerequisites.
//
// New contributors frequently hit setup failures because Node, Rust,
// stellar-cli, or Freighter is missing or the wrong version. This surfaces
// those gaps immediately with fix instructions instead of a confusing
// failure three steps into `npm run dev` / `npm run bindings:build`.
//
// Usage: npm run doctor

const { execFileSync } = require("node:child_process");

const MIN_NODE_MAJOR = 18;

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

let hasFailure = false;

function ok(label, detail) {
  console.log(`${GREEN}✔${RESET} ${label}${detail ? ` ${detail}` : ""}`);
}

function warn(label, fixInstructions = []) {
  console.log(`${YELLOW}⚠${RESET} ${label}`);
  for (const line of fixInstructions) {
    console.log(`    ${line}`);
  }
}

function fail(label, fixInstructions) {
  hasFailure = true;
  console.log(`${RED}✘${RESET} ${label}`);
  for (const line of fixInstructions) {
    console.log(`    ${line}`);
  }
}

function tryRun(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function checkNode() {
  const [majorStr] = process.versions.node.split(".");
  const major = Number(majorStr);
  if (major >= MIN_NODE_MAJOR) {
    ok("Node.js", `v${process.versions.node} (>= ${MIN_NODE_MAJOR} required)`);
  } else {
    fail(`Node.js v${process.versions.node} is below the minimum (${MIN_NODE_MAJOR}+)`, [
      "Install a current LTS release: https://nodejs.org/",
      "Or with nvm: nvm install --lts && nvm use --lts",
    ]);
  }
}

function checkRust() {
  const rustcVersion = tryRun("rustc", ["--version"]);
  const cargoVersion = tryRun("cargo", ["--version"]);

  if (rustcVersion && cargoVersion) {
    ok("Rust toolchain", `(${rustcVersion})`);
  } else {
    fail("Rust toolchain not found (rustc/cargo)", [
      "Install via rustup: https://rustup.rs/",
      "After installing, restart your shell so `cargo`/`rustc` are on PATH.",
    ]);
    return;
  }

  const targets = tryRun("rustup", ["target", "list", "--installed"]) ?? "";
  if (targets.includes("wasm32v1-none") || targets.includes("wasm32-unknown-unknown")) {
    ok("Rust wasm target installed");
  } else {
    warn("No wasm32 target detected — contract builds will fail", [
      "Install it with: rustup target add wasm32v1-none",
    ]);
  }
}

function checkStellarCli() {
  const version = tryRun("stellar", ["--version"]);
  if (version) {
    ok("Stellar CLI", `(${version.split("\n")[0]})`);
  } else {
    fail("Stellar CLI not found", [
      "Install: https://developers.stellar.org/docs/tools/developer-tools/cli/install-cli",
      "Required for scripts/deploy-testnet.sh, scripts/deploy-mainnet.sh, and contract interaction from the CLI.",
    ]);
  }
}

function checkFreighter() {
  // Freighter is a browser extension — there is no way to detect it from a
  // Node script. Print a reminder instead of faking a check that can't work.
  warn("Freighter wallet extension can't be checked from this script", [
    "Install it in your browser before testing wallet-connected flows: https://www.freighter.app/",
  ]);
}

function checkEnvFile() {
  const fs = require("node:fs");
  const path = require("node:path");
  const envLocal = path.join(process.cwd(), ".env.local");
  if (fs.existsSync(envLocal)) {
    ok(".env.local present");
  } else {
    warn(".env.local not found", [
      "Copy the template: cp .env.local.example .env.local",
      "Then fill in NEXT_PUBLIC_CONTRACT_ID and any other values you need.",
    ]);
  }
}

console.log(`${BOLD}vestflow doctor — checking local prerequisites${RESET}\n`);

checkNode();
checkRust();
checkStellarCli();
checkFreighter();
checkEnvFile();

console.log();
if (hasFailure) {
  console.log(`${RED}${BOLD}Some checks failed — fix the items above before running the app.${RESET}`);
  process.exit(1);
} else {
  console.log(`${GREEN}${BOLD}All checks passed.${RESET}`);
}
