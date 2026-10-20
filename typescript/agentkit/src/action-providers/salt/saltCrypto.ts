// PGP helpers for the Salt action provider. Ported from
// salt-agent-sdk/src/crypto.ts's encryptFor/decrypt (same library, same
// call shape) -- kept minimal on purpose: this provider never generates a
// keypair or handles wallet-secret envelopes, only chat-message text.
import * as openpgp from "openpgp";

/**
 * Encrypt plaintext to one or more armored public keys, producing a single
 * ciphertext every one of them can read. This is what salt_send_message
 * sends as a chat message's `message` field.
 *
 * @param plaintext - The text to encrypt.
 * @param armoredPublicKeys - ASCII-armored PGP public keys of every recipient.
 *
 * @returns The ASCII-armored encrypted message.
 */
export async function encryptFor(plaintext: string, armoredPublicKeys: string[]): Promise<string> {
  const keys = await Promise.all(armoredPublicKeys.map(k => openpgp.readKey({ armoredKey: k })));
  const result = await openpgp.encrypt({
    message: await openpgp.createMessage({ text: plaintext }),
    encryptionKeys: keys,
  });
  return result as string;
}

/**
 * Decrypt an armored PGP message with this agent's own private key. Only
 * used by salt_ask_human/salt_get_answer to read a free-text reply (a
 * plain chat message, not a button tap) -- and only when the provider was
 * configured with a private key + passphrase. Without one, this provider
 * is "keyless": it can still send messages (encryption needs only public
 * keys) and can still see BUTTON taps (Salt reports those in plaintext
 * metadata), but cannot read what a free-text reply actually says.
 *
 * @param armoredMessage - The ASCII-armored PGP message to decrypt.
 * @param armoredPrivateKey - The recipient's ASCII-armored PGP private key.
 * @param passphrase - Passphrase for the private key, if it has one.
 *
 * @returns The decrypted plaintext.
 */
export async function decrypt(
  armoredMessage: string,
  armoredPrivateKey: string,
  passphrase: string,
): Promise<string> {
  let privateKey = await openpgp.readPrivateKey({ armoredKey: armoredPrivateKey });
  if (!privateKey.isDecrypted()) {
    privateKey = await openpgp.decryptKey({ privateKey, passphrase });
  }
  const { data } = await openpgp.decrypt({
    message: await openpgp.readMessage({ armoredMessage }),
    decryptionKeys: [privateKey],
  });
  return data as string;
}
