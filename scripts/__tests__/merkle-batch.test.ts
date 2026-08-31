import { describe, it, expect } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import {
  buildBatchFromRows,
  buildMerkleTree,
  hashMerkleNode,
  i128ToBytesBE,
  leafHash,
  u64ToBytesBE,
  type SlotInput,
} from "../merkle-batch";
import { validateCsv } from "../../lib/csv-validation";

function randomAddress(): string {
  return Keypair.random().publicKey();
}

function randomToken(): string {
  return StrKey.encodeContract(randomBytes(32));
}

describe("i128ToBytesBE / u64ToBytesBE", () => {
  it("encodes positive values big-endian in 16/8 bytes", () => {
    expect(i128ToBytesBE(1n).toString("hex")).toBe("00000000000000000000000000000001");
    expect(u64ToBytesBE(1).toString("hex")).toBe("0000000000000001");
  });

  it("round-trips a value above 2^53 without precision loss", () => {
    const huge = 9_007_199_254_740_993n; // 2^53 + 1
    const bytes = i128ToBytesBE(huge);
    const back = bytes.reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);
    expect(back).toBe(huge);
  });
});

describe("leafHash", () => {
  it("matches an independently hand-built sha256 digest", () => {
    const beneficiary = randomAddress();
    const slot: SlotInput = {
      beneficiary,
      totalAmountStroops: 12_345_000n,
      durationSecs: 31_536_000,
      cliffSecs: 7_776_000,
      startTime: 1_700_000_000,
      kind: "LinearWithCliff",
      revocable: true,
    };

    const expected = createHash("sha256")
      .update(
        Buffer.concat([
          Buffer.from([0x00]),
          StrKey.decodeEd25519PublicKey(beneficiary),
          i128ToBytesBE(12_345_000n),
          u64ToBytesBE(31_536_000),
          u64ToBytesBE(7_776_000),
          u64ToBytesBE(1_700_000_000),
          Buffer.from([2]), // LinearWithCliff
          Buffer.from([1]), // revocable
        ])
      )
      .digest();

    expect(leafHash(slot)).toEqual(expected);
  });

  it("changes when any field changes (no accidental collisions)", () => {
    const base: SlotInput = {
      beneficiary: randomAddress(),
      totalAmountStroops: 1000n,
      durationSecs: 1000,
      cliffSecs: 0,
      startTime: 0,
      kind: "Linear",
      revocable: false,
    };
    const variants: SlotInput[] = [
      { ...base, totalAmountStroops: 1001n },
      { ...base, durationSecs: 1001 },
      { ...base, cliffSecs: 1 },
      { ...base, startTime: 1 },
      { ...base, kind: "Cliff" },
      { ...base, revocable: true },
    ];
    const baseHash = leafHash(base).toString("hex");
    for (const v of variants) {
      expect(leafHash(v).toString("hex")).not.toBe(baseHash);
    }
  });
});

describe("hashMerkleNode", () => {
  it("is order-independent (sorted pair)", () => {
    const a = createHash("sha256").update("a").digest();
    const b = createHash("sha256").update("b").digest();
    expect(hashMerkleNode(a, b)).toEqual(hashMerkleNode(b, a));
  });

  it("is domain-separated from a leaf hash", () => {
    const a = createHash("sha256").update("a").digest();
    const b = createHash("sha256").update("b").digest();
    const node = hashMerkleNode(a, b);
    const [lo, hi] = Buffer.compare(a, b) <= 0 ? [a, b] : [b, a];
    const undomained = createHash("sha256").update(Buffer.concat([lo, hi])).digest();
    expect(node).not.toEqual(undomained);
  });
});

describe("buildMerkleTree", () => {
  it("single leaf: root equals the leaf, empty proof", () => {
    const leaf = createHash("sha256").update("only").digest();
    const { root, proofs } = buildMerkleTree([leaf]);
    expect(root).toEqual(leaf);
    expect(proofs).toEqual([[]]);
  });

  function foldProof(leaf: Buffer, proof: Buffer[]): Buffer {
    return proof.reduce((acc, sibling) => hashMerkleNode(acc, sibling), leaf);
  }

  it("every proof folds back to the root, for an odd leaf count", () => {
    const leaves = Array.from({ length: 7 }, (_, i) =>
      createHash("sha256").update(`leaf-${i}`).digest()
    );
    const { root, proofs } = buildMerkleTree(leaves);
    leaves.forEach((leaf, i) => {
      expect(foldProof(leaf, proofs[i])).toEqual(root);
    });
  });

  it("every proof folds back to the root, for a power-of-two leaf count", () => {
    const leaves = Array.from({ length: 16 }, (_, i) =>
      createHash("sha256").update(`leaf-${i}`).digest()
    );
    const { root, proofs } = buildMerkleTree(leaves);
    leaves.forEach((leaf, i) => {
      expect(foldProof(leaf, proofs[i])).toEqual(root);
    });
  });
});

describe("buildBatchFromRows", () => {
  it("builds a batch from a fixture CSV whose proofs verify against the root", () => {
    const token = randomToken();
    const addresses = [randomAddress(), randomAddress(), randomAddress()];
    const futureIso = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const csv =
      "beneficiary,token,amount_xlm,start_time_iso,duration_days,cliff_days,kind,revocable\n" +
      `${addresses[0]},${token},5,${futureIso},365,90,LinearWithCliff,true\n` +
      `${addresses[1]},${token},12.345,${futureIso},365,90,LinearWithCliff,true\n` +
      `${addresses[2]},${token},999.999999,${futureIso},365,90,LinearWithCliff,false\n`;

    const { validRows, invalidRows, headerError } = validateCsv(csv);
    expect(headerError).toBeNull();
    expect(invalidRows).toEqual([]);
    expect(validRows).toHaveLength(3);

    const batch = buildBatchFromRows(validRows, 999_999);
    expect(batch.beneficiaries).toHaveLength(3);
    expect(batch.totalStroops).toBe(
      (50_000_000n + 123_450_000n + 9_999_999_990n).toString()
    );

    function foldProofHex(leafHex: string, proofHex: string[]): string {
      let acc: Buffer = Buffer.from(leafHex, "hex");
      for (const siblingHex of proofHex) {
        acc = hashMerkleNode(acc, Buffer.from(siblingHex, "hex"));
      }
      return acc.toString("hex");
    }

    for (const b of batch.beneficiaries) {
      expect(foldProofHex(b.leaf, b.proof)).toBe(batch.root);
    }
  });

  it("rejects a CSV with more than one distinct token", () => {
    const futureIso = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const csv =
      "beneficiary,token,amount_xlm,start_time_iso,duration_days,cliff_days,kind,revocable\n" +
      `${randomAddress()},${randomToken()},5,${futureIso},365,0,Linear,true\n` +
      `${randomAddress()},${randomToken()},5,${futureIso},365,0,Linear,true\n`;

    const { validRows } = validateCsv(csv);
    expect(() => buildBatchFromRows(validRows, 999_999)).toThrow(/single token/);
  });
});
