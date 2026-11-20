import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { Keys, fromBase64Url, toBase64Url } from './crypto';

/**
 * "Remember on this device": unlocking with a passkey instead of the vault password. The vault's auth and encryption
 * keys are kept in this browser, encrypted under a secret only the passkey can produce (WebAuthn's PRF extension):
 * the stored record is useless without the device's own fingerprint, face or PIN check. The password itself is never
 * kept. Works where the passkey supports PRF (recent Chrome, Edge and Safari).
 */

const DB = 'switcher-remote';
const STORE = 'device';
const RECORD = 'unlock';
const INFO = new TextEncoder().encode('switcher-remote/device-unlock/v1');

export interface Remembered {
  username: string;
  credentialId: string;
  salt: string;
  /** AES-GCM over {authKey, enc}: iv (12) then ciphertext, base64url. */
  sealed: string;
}

export const passkeysSupported = () => typeof PublicKeyCredential !== 'undefined' && !!navigator.credentials;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = run(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export async function remembered(): Promise<Remembered | undefined> {
  try {
    return (await store<Remembered | undefined>('readonly', (s) => s.get(RECORD))) ?? undefined;
  } catch {
    return undefined; // Storage blocked: nothing remembered.
  }
}

export async function forget(): Promise<void> {
  await store('readwrite', (s) => s.delete(RECORD)).catch(() => undefined);
}

const bytes = (u: Uint8Array) => new Uint8Array(u);

/** The AES key a passkey's PRF output unlocks the record with. */
async function wrapKey(prf: ArrayBuffer): Promise<CryptoKey> {
  const k = hkdf(sha256, new Uint8Array(prf), new Uint8Array(0), INFO, 32);
  return crypto.subtle.importKey('raw', bytes(k), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** Asks the passkey for its PRF output on `salt`; undefined where the passkey can't. */
async function prfOf(credentialId: Uint8Array, salt: Uint8Array): Promise<ArrayBuffer | undefined> {
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rpId: location.hostname,
      allowCredentials: [{ id: bytes(credentialId), type: 'public-key' }],
      userVerification: 'required',
      timeout: 60_000,
      extensions: { prf: { eval: { first: bytes(salt) } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  const results = cred?.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } } | undefined;
  return results?.prf?.results?.first;
}

/**
 * Makes a passkey for this vault account on this device and keeps the keys under it. `rawEnc` is the encryption key's
 * bytes, which only exist here, during unlocking. Throws with a plain reason where passkeys can't do this.
 */
export async function remember(username: string, keys: Keys, rawEnc: Uint8Array): Promise<void> {
  if (!passkeysSupported()) {
    throw new Error('this browser has no passkeys');
  }
  const created = (await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { id: location.hostname, name: 'Switcher Remote' },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: username, displayName: `${username} (Switcher Remote)` },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' },
      timeout: 60_000,
      extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  const enabled = (created?.getClientExtensionResults() as { prf?: { enabled?: boolean } } | undefined)?.prf?.enabled;
  if (!created || !enabled) {
    throw new Error('this device’s passkeys can’t keep a secret for the vault (no PRF support)');
  }
  const credentialId = new Uint8Array(created.rawId);
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const prf = await prfOf(credentialId, salt);
  if (!prf) {
    throw new Error('the passkey didn’t give back its secret');
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify({ authKey: keys.authKey, enc: toBase64Url(rawEnc) }));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await wrapKey(prf), plain));
  const sealed = new Uint8Array(12 + ct.length);
  sealed.set(iv);
  sealed.set(ct, 12);
  const record: Remembered = { username, credentialId: toBase64Url(credentialId), salt: toBase64Url(salt), sealed: toBase64Url(sealed) };
  await store('readwrite', (s) => s.put(record, RECORD));
}

/** The vault keys back from this device's passkey (it asks for the fingerprint, face or PIN). */
export async function recall(record: Remembered): Promise<Keys> {
  const prf = await prfOf(fromBase64Url(record.credentialId), fromBase64Url(record.salt));
  if (!prf) {
    throw new Error('the passkey didn’t give back its secret');
  }
  const sealed = fromBase64Url(record.sealed);
  let plain: { authKey: string; enc: string };
  try {
    const opened = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(sealed.subarray(0, 12)) }, await wrapKey(prf), bytes(sealed.subarray(12)));
    plain = JSON.parse(new TextDecoder().decode(opened));
  } catch {
    throw new Error('this device’s saved keys don’t open with that passkey');
  }
  const encKey = await crypto.subtle.importKey('raw', bytes(fromBase64Url(plain.enc)), 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { authKey: plain.authKey, encKey };
}
