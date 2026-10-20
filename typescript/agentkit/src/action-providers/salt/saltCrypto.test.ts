import * as openpgp from "openpgp";
import { decrypt, encryptFor } from "./saltCrypto";

describe("saltCrypto (real PGP round trip, no mocks)", () => {
  it("encrypts to multiple recipients and each can decrypt with their own key", async () => {
    const alice = await openpgp.generateKey({
      type: "ecc",
      curve: "curve25519",
      userIDs: [{ name: "alice" }],
      format: "armored",
    });
    const bob = await openpgp.generateKey({
      type: "ecc",
      curve: "curve25519",
      userIDs: [{ name: "bob" }],
      format: "armored",
    });

    const ciphertext = await encryptFor("hello from an agent", [alice.publicKey, bob.publicKey]);
    expect(ciphertext).toContain("BEGIN PGP MESSAGE");

    await expect(decrypt(ciphertext, alice.privateKey, "")).resolves.toBe("hello from an agent");
    await expect(decrypt(ciphertext, bob.privateKey, "")).resolves.toBe("hello from an agent");
  });

  it("a third party's key cannot decrypt it", async () => {
    const alice = await openpgp.generateKey({
      type: "ecc",
      curve: "curve25519",
      userIDs: [{ name: "alice" }],
      format: "armored",
    });
    const eve = await openpgp.generateKey({
      type: "ecc",
      curve: "curve25519",
      userIDs: [{ name: "eve" }],
      format: "armored",
    });

    const ciphertext = await encryptFor("secret", [alice.publicKey]);
    await expect(decrypt(ciphertext, eve.privateKey, "")).rejects.toBeTruthy();
  });

  it("round-trips through a passphrase-protected private key", async () => {
    const key = await openpgp.generateKey({
      type: "ecc",
      curve: "curve25519",
      userIDs: [{ name: "passphrase-holder" }],
      passphrase: "correct-horse-battery-staple",
      format: "armored",
    });

    const ciphertext = await encryptFor("payload", [key.publicKey]);
    await expect(decrypt(ciphertext, key.privateKey, "correct-horse-battery-staple")).resolves.toBe(
      "payload",
    );
    await expect(decrypt(ciphertext, key.privateKey, "wrong-passphrase")).rejects.toBeTruthy();
  });
});
