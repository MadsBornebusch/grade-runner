import { describe, expect, it } from "vitest";
import { decrypt, encrypt } from "./crypto.ts";

describe("encrypt/decrypt", () => {
  it("round-trips an object through the same secret", () => {
    const secret = "test-secret-1";
    const value = { refreshToken: "abc123", accessTokenExpiresAt: 1234567890, athleteName: "Mads" };
    const encoded = encrypt(secret, value);
    expect(decrypt(secret, encoded)).toEqual(value);
  });

  it("returns null when decrypted with the wrong secret", () => {
    const encoded = encrypt("secret-a", { x: 1 });
    expect(decrypt("secret-b", encoded)).toBeNull();
  });

  it("returns null for a tampered ciphertext", () => {
    const secret = "test-secret-2";
    const encoded = encrypt(secret, { x: 1 });
    const tampered = encoded.slice(0, -4) + (encoded.slice(-4) === "AAAA" ? "BBBB" : "AAAA");
    expect(decrypt(secret, tampered)).toBeNull();
  });

  it("returns null for garbage input", () => {
    expect(decrypt("any-secret", "not-a-valid-cookie-value")).toBeNull();
  });

  it("produces a different ciphertext each time (random IV) for the same input", () => {
    const secret = "test-secret-3";
    const a = encrypt(secret, { x: 1 });
    const b = encrypt(secret, { x: 1 });
    expect(a).not.toBe(b);
  });
});
