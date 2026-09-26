/**
 * Webhook protocol core: signing, replay rejection, secret storage,
 * backoff schedule, stable delivery IDs and SSRF guards.
 */

import crypto from "crypto";
import { describe, expect, it, vi } from "vitest";
import {
  assertDeliverableUrl,
  backoffDelaySeconds,
  computeSignature,
  decryptSecret,
  deliveryIdFor,
  encryptSecret,
  generateChallenge,
  generateSecret,
  getEncryptionKey,
  hashSecret,
  isPrivateAddress,
  MAX_ATTEMPTS,
  matchesEventType,
  normalizeEventTypes,
  parseSignatureHeader,
  resetEncryptionKeyWarning,
  RETRY_SCHEDULE_SECONDS,
  SIGNATURE_TOLERANCE_SECONDS,
  signPayload,
  timingSafeEqualHex,
  verifySecretHash,
  verifySignature,
} from "../src/webhooks";

const SECRET = "e".repeat(64);
const BODY = JSON.stringify({ event_id: "1234-1-0", event_type: "claimed" });
const NOW = 1_760_000_000;

describe("request signing", () => {
  it("emits a Stripe-style t=…,v1=… header", () => {
    const header = signPayload(SECRET, BODY, NOW);
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(parseSignatureHeader(header)).toEqual({
      timestamp: NOW,
      signature: computeSignature(SECRET, BODY, NOW),
    });
  });

  it("binds the signature to the timestamp, not just the body", () => {
    expect(computeSignature(SECRET, BODY, NOW)).not.toBe(
      computeSignature(SECRET, BODY, NOW + 1)
    );
  });

  it("verifies a freshly signed payload", () => {
    const header = signPayload(SECRET, BODY, NOW);
    expect(verifySignature(SECRET, BODY, header, { nowSeconds: NOW })).toBe(true);
  });

  it("rejects a tampered payload, a wrong secret and a malformed header", () => {
    const header = signPayload(SECRET, BODY, NOW);
    expect(
      verifySignature(SECRET, `${BODY} `, header, { nowSeconds: NOW })
    ).toBe(false);
    expect(verifySignature("other-secret", BODY, header, { nowSeconds: NOW })).toBe(
      false
    );
    expect(verifySignature(SECRET, BODY, "v1=deadbeef", { nowSeconds: NOW })).toBe(
      false
    );
    expect(verifySignature(SECRET, BODY, "t=abc,v1=zz", { nowSeconds: NOW })).toBe(
      false
    );
  });

  it("rejects a truncated signature without throwing on length mismatch", () => {
    const header = `t=${NOW},v1=${computeSignature(SECRET, BODY, NOW).slice(0, 32)}`;
    expect(verifySignature(SECRET, BODY, header, { nowSeconds: NOW })).toBe(false);
  });

  it("compares digests with crypto.timingSafeEqual", () => {
    const spy = vi.spyOn(crypto, "timingSafeEqual");
    const header = signPayload(SECRET, BODY, NOW);

    expect(verifySignature(SECRET, BODY, header, { nowSeconds: NOW })).toBe(true);
    expect(spy).toHaveBeenCalled();

    spy.mockRestore();
  });
});

describe("replay protection", () => {
  it("accepts signatures inside the 5 minute window", () => {
    const header = signPayload(SECRET, BODY, NOW);
    expect(
      verifySignature(SECRET, BODY, header, {
        nowSeconds: NOW + SIGNATURE_TOLERANCE_SECONDS,
      })
    ).toBe(true);
  });

  it("rejects signatures older than 5 minutes", () => {
    const header = signPayload(SECRET, BODY, NOW);
    expect(
      verifySignature(SECRET, BODY, header, {
        nowSeconds: NOW + SIGNATURE_TOLERANCE_SECONDS + 1,
      })
    ).toBe(false);
    expect(
      verifySignature(SECRET, BODY, header, { nowSeconds: NOW + 3600 })
    ).toBe(false);
  });

  it("rejects timestamps too far in the future", () => {
    const header = signPayload(SECRET, BODY, NOW + 600);
    expect(verifySignature(SECRET, BODY, header, { nowSeconds: NOW })).toBe(false);
  });

  it("cannot be replayed by swapping in a fresh timestamp", () => {
    const captured = parseSignatureHeader(signPayload(SECRET, BODY, NOW))!;
    const replayed = `t=${NOW + 3600},v1=${captured.signature}`;
    expect(
      verifySignature(SECRET, BODY, replayed, { nowSeconds: NOW + 3600 })
    ).toBe(false);
  });
});

describe("backoff schedule", () => {
  it("doubles the delay after each failed attempt", () => {
    expect(RETRY_SCHEDULE_SECONDS).toEqual([1, 2, 4, 8, 16, 32, 64, 128, 256]);
    expect(RETRY_SCHEDULE_SECONDS).toHaveLength(MAX_ATTEMPTS - 1);
  });

  it("computes 2^(attempt-1) seconds", () => {
    expect(backoffDelaySeconds(1)).toBe(1);
    expect(backoffDelaySeconds(5)).toBe(16);
    expect(backoffDelaySeconds(9)).toBe(256);
    expect(backoffDelaySeconds(11)).toBe(1024);
  });

  it("rejects non-positive attempt counts", () => {
    expect(() => backoffDelaySeconds(0)).toThrow();
    expect(() => backoffDelaySeconds(-1)).toThrow();
  });
});

describe("secret storage", () => {
  it("never stores the plaintext in the hash and verifies it back", () => {
    const secret = generateSecret();
    const stored = hashSecret(secret);

    expect(stored).toMatch(/^scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
    expect(stored).not.toContain(secret);
    expect(verifySecretHash(secret, stored)).toBe(true);
    expect(verifySecretHash(`${secret}x`, stored)).toBe(false);
    expect(verifySecretHash(secret, "not-a-hash")).toBe(false);
  });

  it("salts each hash independently", () => {
    const secret = generateSecret();
    expect(hashSecret(secret)).not.toBe(hashSecret(secret));
  });

  it("round-trips the signing secret through AES-256-GCM", () => {
    const key = crypto.randomBytes(32);
    const secret = generateSecret();
    const encrypted = encryptSecret(secret, key);

    expect(encrypted.startsWith("v1.")).toBe(true);
    expect(encrypted).not.toContain(secret);
    expect(decryptSecret(encrypted, key)).toBe(secret);
  });

  it("refuses tampered ciphertext and the wrong key", () => {
    const key = crypto.randomBytes(32);
    const encrypted = encryptSecret("super-secret-value", key);
    const [version, iv, tag, ciphertext] = encrypted.split(".");
    const flipped = Buffer.from(ciphertext, "base64");
    flipped[0] ^= 0xff;

    expect(() =>
      decryptSecret([version, iv, tag, flipped.toString("base64")].join("."), key)
    ).toThrow();
    expect(() => decryptSecret(encrypted, crypto.randomBytes(32))).toThrow();
    expect(() => decryptSecret("garbage", key)).toThrow(
      /Malformed encrypted webhook secret/
    );
  });

  it("derives the AES key from the environment and fails loudly when unset", () => {
    const hex = "f".repeat(64);
    expect(getEncryptionKey({ WEBHOOK_ENCRYPTION_KEY: hex })).toEqual(
      Buffer.from(hex, "hex")
    );
    expect(getEncryptionKey({ WEBHOOK_ENCRYPTION_KEY: "a passphrase" })).toHaveLength(
      32
    );
    expect(() => getEncryptionKey({})).toThrow(/WEBHOOK_ENCRYPTION_KEY/);
  });

  it("warns once when the key has to be derived, and never for proper hex", () => {
    resetEncryptionKeyWarning();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    getEncryptionKey({ WEBHOOK_ENCRYPTION_KEY: "f".repeat(64) });
    expect(warn).not.toHaveBeenCalled();

    getEncryptionKey({ WEBHOOK_ENCRYPTION_KEY: "my-secret-key" });
    getEncryptionKey({ WEBHOOK_ENCRYPTION_KEY: "my-secret-key" });

    // Once per process — the delivery worker resolves the key per request.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/64 hex characters/);

    warn.mockRestore();
    resetEncryptionKeyWarning();
  });

  it("generates distinct high-entropy secrets and challenges", () => {
    expect(generateSecret()).toHaveLength(64);
    expect(generateSecret()).not.toBe(generateSecret());
    expect(generateChallenge()).not.toBe(generateChallenge());
  });
});

describe("delivery identity", () => {
  it("derives a stable v5-style UUID per (registration, event)", () => {
    const id = deliveryIdFor("reg-1", "1234-1-0");
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(deliveryIdFor("reg-1", "1234-1-0")).toBe(id);
    expect(deliveryIdFor("reg-2", "1234-1-0")).not.toBe(id);
    expect(deliveryIdFor("reg-1", "1234-1-1")).not.toBe(id);
  });
});

describe("subscription matching", () => {
  it("honours explicit types and the wildcard", () => {
    expect(matchesEventType(["claimed"], "claimed")).toBe(true);
    expect(matchesEventType(["claimed"], "revoked")).toBe(false);
    expect(matchesEventType(["*"], "revoked")).toBe(true);
  });

  it("normalises and validates the requested event types", () => {
    expect(normalizeEventTypes([" claimed ", "claimed", "revoked"])).toEqual([
      "claimed",
      "revoked",
    ]);
    expect(normalizeEventTypes(["*"])).toEqual(["*"]);
    expect(() => normalizeEventTypes([])).toThrow(/non-empty/);
    expect(() => normalizeEventTypes(["nope"])).toThrow(/Unknown event type/);
    expect(() => normalizeEventTypes([42])).toThrow(/must be strings/);
  });
});

describe("SSRF guards", () => {
  const publicLookup = async () => ["93.184.216.34"];

  it("classifies private and loopback addresses", () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "192.168.1.1",
      "172.16.0.1",
      "169.254.169.254",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of ["8.8.8.8", "93.184.216.34", "2606:2800:220:1::"]) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });

  it("accepts a public https endpoint", async () => {
    const url = await assertDeliverableUrl("https://hooks.example.com/vestflow", {
      allowInsecure: false,
      lookup: publicLookup,
    });
    expect(url.host).toBe("hooks.example.com");
  });

  it("rejects plain http, credentials and non-http schemes", async () => {
    await expect(
      assertDeliverableUrl("http://hooks.example.com/x", {
        allowInsecure: false,
        lookup: publicLookup,
      })
    ).rejects.toThrow(/https/);
    await expect(
      assertDeliverableUrl("https://user:pass@hooks.example.com/x", {
        allowInsecure: false,
        lookup: publicLookup,
      })
    ).rejects.toThrow(/credentials/);
    await expect(
      assertDeliverableUrl("file:///etc/passwd", { allowInsecure: false })
    ).rejects.toThrow(/https/);
    await expect(
      assertDeliverableUrl("not a url", { allowInsecure: false })
    ).rejects.toThrow(/valid absolute URL/);
  });

  it("rejects hostnames that resolve into the internal network", async () => {
    await expect(
      assertDeliverableUrl("https://localhost/admin", { allowInsecure: false })
    ).rejects.toThrow(/private or loopback/);
    await expect(
      assertDeliverableUrl("https://internal-service/admin", {
        allowInsecure: false,
        lookup: async () => ["10.0.0.5"],
      })
    ).rejects.toThrow(/private or loopback/);
    await expect(
      assertDeliverableUrl("https://rebind.example.com/x", {
        allowInsecure: false,
        // DNS rebinding: one public and one internal answer is still a reject.
        lookup: async () => ["93.184.216.34", "169.254.169.254"],
      })
    ).rejects.toThrow(/private or loopback/);
    await expect(
      assertDeliverableUrl("https://nxdomain.example.com/x", {
        allowInsecure: false,
        lookup: async () => {
          throw new Error("ENOTFOUND");
        },
      })
    ).rejects.toThrow(/could not be resolved/);
  });
});

describe("timingSafeEqualHex", () => {
  it("matches equal digests and rejects everything else", () => {
    const digest = computeSignature(SECRET, BODY, NOW);
    expect(timingSafeEqualHex(digest, digest)).toBe(true);
    expect(timingSafeEqualHex(digest, digest.slice(0, 60))).toBe(false);
    expect(timingSafeEqualHex("", "")).toBe(false);
    expect(timingSafeEqualHex("zz", "zz")).toBe(false);
  });
});
