// Encrypts small JSON payloads (Strava tokens, the settings blob) into a
// single opaque string suitable for a cookie value. AES-256-GCM via Node's
// built-in crypto module -- no dependency, and GCM's auth tag means a
// tampered or truncated cookie fails to decrypt instead of silently
// producing garbage data the caller might trust.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function keyFromSecret(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

export function encrypt(secret: string, value: unknown): string {
  const key = keyFromSecret(secret);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64url");
}

/** Returns null on any failure (wrong secret, tampered/truncated value,
 * unparseable JSON) rather than throwing -- callers should treat that
 * identically to "no cookie at all". */
export function decrypt<T>(secret: string, encoded: string): T | null {
  try {
    const key = keyFromSecret(secret);
    const raw = Buffer.from(encoded, "base64url");
    const iv = raw.subarray(0, IV_LENGTH);
    const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8")) as T;
  } catch {
    return null;
  }
}
