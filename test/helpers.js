// Registers an account through Vaultwarden's API (our crypto; the official CLI later proves it valid).
import * as v from '../vault.js';

export async function register(server, email, password, kdf) {
  const mk = await v.makeMasterKey(password, email, kdf);
  const userKey = v.toKey(crypto.getRandomValues(new Uint8Array(64)));
  const rsa = await crypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-1' }, true, ['encrypt', 'decrypt']);
  const post = (path, body) => fetch(`${server}/identity/accounts/register${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  // Without a mail server Vaultwarden returns the verification token directly.
  const emailVerificationToken = await (await post('/send-verification-email', { email, name: 'test', receiveMarketingEmails: false })).text();
  const r = await post('/finish', {
    email, emailVerificationToken, masterPasswordHash: await v.masterPasswordHash(mk, password),
    userSymmetricKey: await v.encrypt(v.keyBytes(userKey), await v.stretch(mk)), ...kdf,
    userAsymmetricKeys: {
      publicKey: v.b64(new Uint8Array(await crypto.subtle.exportKey('spki', rsa.publicKey))),
      encryptedPrivateKey: await v.encrypt(new Uint8Array(await crypto.subtle.exportKey('pkcs8', rsa.privateKey)), userKey),
    },
  });
  if (!r.ok) throw new Error(`register: ${r.status} ${await r.text()}`);
}
