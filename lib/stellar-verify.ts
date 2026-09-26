import { createHash } from "crypto";
import { Keypair, StrKey } from "@stellar/stellar-sdk";

// SEP-53: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0053.md
const SEP53_PREFIX = "Stellar Signed Message:\n";

/**
 * Validates that a string is a well-formed Stellar ed25519 public address (G...).
 */
export function isValidStellarAddress(address: string): boolean {
  try {
    return StrKey.isValidEd25519PublicKey(address);
  } catch {
    return false;
  }
}

/**
 * Verifies a SEP-53 signed message produced by Freighter's signMessage().
 *
 * SEP-53: messageHash = SHA256("Stellar Signed Message:\n" + message),
 * signed with the wallet's ed25519 secret key. We verify the signature
 * against the claimed public key using stellar-sdk's Keypair.verify.
 *
 * @param publicKey Stellar G-address that supposedly produced the signature
 * @param message the original message that was signed (the nonce)
 * @param signatureBase64 base64-encoded signature returned by Freighter's signMessage()
 */
export function verifyFreighterSignature(
  publicKey: string,
  message: string,
  signatureBase64: string
): boolean {
  try {
    if (!isValidStellarAddress(publicKey)) return false;

    const messageHash = createHash("sha256")
      .update(SEP53_PREFIX + message, "utf8")
      .digest();

    const signature = Buffer.from(signatureBase64, "base64");
    const keypair = Keypair.fromPublicKey(publicKey);

    return keypair.verify(messageHash, signature);
  } catch {
    return false;
  }
}
