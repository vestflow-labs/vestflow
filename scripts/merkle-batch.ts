import { createHash } from "crypto";
import { readFileSync, writeFileSync } from "fs";
import { StrKey } from "@stellar/stellar-sdk";
import { parse } from "csv-parse/sync";

function sha256(buf: Buffer): Buffer {
    return createHash('sha256').update(buf).digest();
}

function parseAmountToStroops(amountStr: string): bigint {
    const parts = amountStr.trim().split('.');
    let whole = parts[0];
    let frac = parts[1] || '';
    if (frac.length > 7) {
        frac = frac.slice(0, 7);
    }
    while (frac.length < 7) {
        frac += '0';
    }
    return BigInt(whole + frac);
}

function buildLeaf(row: any): Buffer {
    const pubKeyBytes = StrKey.decodeEd25519PublicKey(row.beneficiary.trim());
    const amount = parseAmountToStroops(row.amount);
    const startTime = BigInt(row.start_time.trim());
    
    let kindByte = 0;
    const k = row.kind.trim().toLowerCase();
    if (k === 'linear') kindByte = 0;
    else if (k === 'cliff') kindByte = 1;
    else if (k === 'linearwithcliff') kindByte = 2;
    else if (k === 'graded') kindByte = 3;
    else throw new Error("Unknown kind " + k);

    const cliffDays = BigInt(row.cliff_days.trim());
    const durationDays = BigInt(row.duration_days.trim());
    
    const cliffSeconds = cliffDays * 86400n;
    const durationSeconds = durationDays * 86400n;

    const revocableByte = row.revocable.trim().toLowerCase() === 'true' ? 1 : 0;

    const buf = Buffer.alloc(1 + 32 + 16 + 8 + 8 + 8 + 1 + 1);
    let offset = 0;
    buf.writeUInt8(0x00, offset); offset += 1;
    Buffer.from(pubKeyBytes).copy(buf, offset); offset += 32;

    const hex = amount.toString(16).padStart(32, '0');
    Buffer.from(hex, 'hex').copy(buf, offset); offset += 16;

    buf.writeBigUInt64BE(durationSeconds, offset); offset += 8;
    buf.writeBigUInt64BE(cliffSeconds, offset); offset += 8;
    buf.writeBigUInt64BE(startTime, offset); offset += 8;
    
    buf.writeUInt8(kindByte, offset); offset += 1;
    buf.writeUInt8(revocableByte, offset); offset += 1;

    return sha256(buf);
}

function getProof(allLevels: Buffer[][], index: number): Buffer[] {
    const proof: Buffer[] = [];
    let currentIndex = index;
    
    for (let level = 0; level < allLevels.length - 1; level++) {
        const currentLevel = allLevels[level];
        const isRightChild = currentIndex % 2 === 1;
        const siblingIndex = isRightChild ? currentIndex - 1 : currentIndex + 1;
        
        if (siblingIndex < currentLevel.length) {
            proof.push(currentLevel[siblingIndex]);
        }
        
        currentIndex = Math.floor(currentIndex / 2);
    }
    
    return proof;
}

function main() {
    const inputFile = process.argv[2];
    if (!inputFile) {
        console.error("Usage: ts-node merkle-batch.ts <input.csv>");
        process.exit(1);
    }

    const fileContent = readFileSync(inputFile, 'utf-8');
    const records = parse(fileContent, {
        columns: true,
        skip_empty_lines: true
    });

    const leaves: Buffer[] = [];
    let totalAmountStroops = 0n;

    for (const row of records) {
        leaves.push(buildLeaf(row));
        totalAmountStroops += parseAmountToStroops(row.amount);
    }

    const allLevels = [leaves];
    let currentLevel = leaves;

    while (currentLevel.length > 1) {
        const nextLevel: Buffer[] = [];
        for (let i = 0; i < currentLevel.length; i += 2) {
            if (i + 1 === currentLevel.length) {
                nextLevel.push(currentLevel[i]);
            } else {
                let left = currentLevel[i];
                let right = currentLevel[i+1];
                if (Buffer.compare(left, right) > 0) {
                    const temp = left;
                    left = right;
                    right = temp;
                }
                const pairBuf = Buffer.alloc(1 + 32 + 32);
                pairBuf.writeUInt8(0x01, 0);
                left.copy(pairBuf, 1);
                right.copy(pairBuf, 33);
                nextLevel.push(sha256(pairBuf));
            }
        }
        allLevels.push(nextLevel);
        currentLevel = nextLevel;
    }

    const root = currentLevel[0].toString('hex');
    
    const proofs = records.map((row: any, i: number) => {
        return {
            beneficiary: row.beneficiary,
            proof: getProof(allLevels, i).map(b => b.toString('hex'))
        };
    });

    const output = {
        root,
        totalStroops: totalAmountStroops.toString(),
        expiryLedger: 50000000,
        proofs
    };

    writeFileSync('batch-root.json', JSON.stringify(output, null, 2));
    console.log("Created batch-root.json with root:", root);
}

main();
