#!/usr/bin/env tsx
// Off-chain Merkle tree builder for the commit_schedule_batch / claim_schedule_slot
// flow (#583). Reads the same CSV format as the bulk-create page, hashes each
// row into a leaf using the exact byte layout the contract hashes on-chain,
// builds the tree bottom-up, and writes out a root + per-beneficiary proof
// file the grantor can distribute.
//
// Usage:
//   npx tsx scripts/merkle-batch.ts <csv-file> [--expiry-ledger <u32>] [--out <path>]
//
// Leaf layout (all integers big-endian), matching contracts/vestflow/src/lib.rs
// `schedule_leaf_hash`:
//   sha256(0x00 || beneficiary(32) || total_amount(16, signed) || duration(8)
//          || cliff_duration(8) || start_time(8) || vesting_kind(1) || revocable(1))
//
// Node layout, matching `hash_merkle_node`:
//   sha256(0x01 || min(left, right) || max(left, right))
//
// BigInt is used throughout the amount path — Number() silently loses
// precision above 2^53 stroops, the bug fixed in getWalletXlmBalance in #573.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { StrKey, rpc as StellarRpc } from "@stellar/stellar-sdk";
import { validateCsv, type ValidatedRow } from "../lib/csv-validation";

export type ScheduleKind = "Linear" | "Cliff" | "LinearWithCliff" | "Graded";

// Discriminant byte for a VestingKind as encoded into a batch leaf hash.
// Must match `vesting_kind_byte` in contracts/vestflow/src/lib.rs exactly.
const KIND_BYTE: Record<ScheduleKind, number> = {
  Linear: 0,
  Cliff: 1,
  LinearWithCliff: 2,
  Graded: 3,
};

const LEAF_DOMAIN = Buffer.from([0x00]);
const NODE_DOMAIN = Buffer.from([0x01]);

/** Big-endian two's-complement encoding of a signed 128-bit integer. */
export function i128ToBytesBE(value: bigint): Buffer {
  let v = value < 0n ? (1n << 128n) + value : value;
  const buf = Buffer.alloc(16);
  for (let i = 15; i >= 0; i--) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return buf;
}

/** Big-endian encoding of an unsigned 64-bit integer. */
export function u64ToBytesBE(value: number | bigint): Buffer {
  let v = BigInt(value);
  const buf = Buffer.alloc(8);
  for (let i = 7; i >= 0; i--) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return buf;
}

export interface SlotInput {
  beneficiary: string; // G... StrKey address
  totalAmountStroops: bigint;
  durationSecs: number;
  cliffSecs: number;
  startTime: number;
  kind: ScheduleKind;
  revocable: boolean;
}

/**
 * Hash one beneficiary slot into a leaf. `beneficiary` is StrKey-decoded to
 * its raw 32-byte ed25519 public key — the same bytes the contract recovers
 * by taking the last 32 bytes of the address's XDR encoding, whether the
 * address is an account (ed25519 key) or contract (hash).
 */
export function leafHash(slot: SlotInput): Buffer {
  const addr = StrKey.decodeEd25519PublicKey(slot.beneficiary);
  const parts = [
    LEAF_DOMAIN,
    addr,
    i128ToBytesBE(slot.totalAmountStroops),
    u64ToBytesBE(slot.durationSecs),
    u64ToBytesBE(slot.cliffSecs),
    u64ToBytesBE(slot.startTime),
    Buffer.from([KIND_BYTE[slot.kind]]),
    Buffer.from([slot.revocable ? 1 : 0]),
  ];
  return createHash("sha256").update(Buffer.concat(parts)).digest();
}

/** Sorted-pair, domain-separated hash of two sibling Merkle nodes. */
export function hashMerkleNode(left: Buffer, right: Buffer): Buffer {
  const [lo, hi] = Buffer.compare(left, right) <= 0 ? [left, right] : [right, left];
  return createHash("sha256").update(Buffer.concat([NODE_DOMAIN, lo, hi])).digest();
}

export interface MerkleTree {
  root: Buffer;
  /** proofs[i] is the sibling path (leaf to root) for leaves[i]. */
  proofs: Buffer[][];
}

/**
 * Build a Merkle tree bottom-up over `leaves`, returning the root and, for
 * each leaf (by index), its sibling proof up to the root. An odd node at any
 * level is promoted unchanged (no sibling contributed for it that round) —
 * this must match `build_merkle` in the contract's Rust test helper exactly,
 * since both sides need to agree on which leaf pairs with which sibling.
 */
export function buildMerkleTree(leaves: Buffer[]): MerkleTree {
  const n = leaves.length;
  if (n === 0) throw new Error("cannot build a Merkle tree over zero leaves");

  const proofs: Buffer[][] = leaves.map(() => []);
  const positions = leaves.map((_, i) => i);
  let level = leaves.slice();

  while (level.length > 1) {
    const len = level.length;
    const newLevel: Buffer[] = [];
    for (let k = 0; k < len; k += 2) {
      newLevel.push(k + 1 < len ? hashMerkleNode(level[k], level[k + 1]) : level[k]);
    }
    for (let i = 0; i < n; i++) {
      const p = positions[i];
      const siblingPos = p ^ 1;
      if (siblingPos < len) proofs[i].push(level[siblingPos]);
      positions[i] = p >> 1;
    }
    level = newLevel;
  }

  return { root: level[0], proofs };
}

export interface BatchOutput {
  root: string;
  token: string;
  totalStroops: string;
  expiryLedger: number;
  beneficiaries: {
    rowIndex: number;
    beneficiary: string;
    totalAmountStroops: string;
    durationSecs: number;
    cliffSecs: number;
    startTime: number;
    kind: ScheduleKind;
    revocable: boolean;
    leaf: string;
    proof: string[];
  }[];
}

/** Converts CSV-validated rows (as produced by lib/csv-validation.ts) into a committable batch. */
export function buildBatchFromRows(rows: ValidatedRow[], expiryLedger: number): BatchOutput {
  if (rows.length === 0) throw new Error("no valid rows to build a batch from");

  const token = rows[0].token;
  const mismatched = rows.filter((r) => r.token !== token);
  if (mismatched.length > 0) {
    throw new Error(
      `commit_schedule_batch deposits a single token per batch; row(s) ${mismatched
        .map((r) => r.rowIndex)
        .join(", ")} use a different token than row 1 (${token}).`
    );
  }

  const slots: SlotInput[] = rows.map((r) => ({
    beneficiary: r.beneficiary,
    totalAmountStroops: r.amountStroops,
    durationSecs: r.durationDays * 86400,
    cliffSecs: r.cliffDays * 86400,
    startTime: r.startTime,
    kind: r.kind,
    revocable: r.revocable,
  }));

  const leaves = slots.map(leafHash);
  const { root, proofs } = buildMerkleTree(leaves);
  const totalStroops = rows.reduce((sum, r) => sum + r.amountStroops, 0n);

  return {
    root: root.toString("hex"),
    token,
    totalStroops: totalStroops.toString(),
    expiryLedger,
    beneficiaries: rows.map((r, i) => ({
      rowIndex: r.rowIndex,
      beneficiary: r.beneficiary,
      totalAmountStroops: slots[i].totalAmountStroops.toString(),
      durationSecs: slots[i].durationSecs,
      cliffSecs: slots[i].cliffSecs,
      startTime: slots[i].startTime,
      kind: slots[i].kind,
      revocable: slots[i].revocable,
      leaf: leaves[i].toString("hex"),
      proof: proofs[i].map((p) => p.toString("hex")),
    })),
  };
}

// ---------- CLI ----------

export async function suggestExpiryLedger(expiryDays: number): Promise<number> {
  const rpcUrl =
    process.env.NEXT_PUBLIC_NETWORK === "mainnet"
      ? "https://mainnet.sorobanrpc.com"
      : "https://soroban-testnet.stellar.org";
  const server = new StellarRpc.Server(rpcUrl);
  const latest = await server.getLatestLedger();
  // ~5s per ledger.
  const ledgersPerDay = Math.floor((24 * 60 * 60) / 5);
  return latest.sequence + expiryDays * ledgersPerDay;
}

async function main() {
  const args = process.argv.slice(2);
  const csvPath = args.find((a) => !a.startsWith("--"));
  if (!csvPath) {
    console.error("Usage: tsx scripts/merkle-batch.ts <csv-file> [--expiry-ledger <u32>] [--expiry-days <n>] [--out <path>]");
    process.exit(1);
  }

  const expiryLedgerArgIdx = args.indexOf("--expiry-ledger");
  const expiryDaysArgIdx = args.indexOf("--expiry-days");
  const outArgIdx = args.indexOf("--out");
  const outPath = outArgIdx >= 0 ? args[outArgIdx + 1] : "batch-root.json";

  let expiryLedger: number;
  if (expiryLedgerArgIdx >= 0) {
    expiryLedger = Number(args[expiryLedgerArgIdx + 1]);
  } else {
    const expiryDays = expiryDaysArgIdx >= 0 ? Number(args[expiryDaysArgIdx + 1]) : 30;
    expiryLedger = await suggestExpiryLedger(expiryDays);
  }

  const text = readFileSync(csvPath, "utf-8");
  const { validRows, invalidRows, headerError } = validateCsv(text);

  if (headerError) {
    console.error(`CSV error: ${headerError}`);
    process.exit(1);
  }
  if (invalidRows.length > 0) {
    console.error(`${invalidRows.length} row(s) failed validation:`);
    for (const row of invalidRows) {
      console.error(`  row ${row.rowIndex}: ${row.errors.join("; ")}`);
    }
    process.exit(1);
  }

  const batch = buildBatchFromRows(validRows, expiryLedger);
  writeFileSync(outPath, JSON.stringify(batch, null, 2));

  console.log(`Wrote ${outPath}`);
  console.log(`  root:           ${batch.root}`);
  console.log(`  token:          ${batch.token}`);
  console.log(`  total stroops:  ${batch.totalStroops}`);
  console.log(`  expiry ledger:  ${batch.expiryLedger}`);
  console.log(`  beneficiaries:  ${batch.beneficiaries.length}`);
}

// Only run the CLI when invoked directly, not when imported by tests.
const isMain = (() => {
  try {
    return !!process.argv[1] && basename(fileURLToPath(import.meta.url)) === basename(process.argv[1]);
  } catch {
    return false;
  }
})();
if (isMain) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
