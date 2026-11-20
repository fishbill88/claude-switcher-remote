import { hkdf } from '@noble/hashes/hkdf.js';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { sha256 } from '@noble/hashes/sha2.js';

/**
 * The vault's keys, derived exactly as Claude Account Switcher derives them (src/vault.ts): scrypt over the password,
 * salted with the username, then HKDF-SHA256 into an auth key (sent to the vault to sign in) and an encryption key
 * (never leaves this tab). Blobs are AES-256-GCM in the extension's format: [1][iv 12][tag 16][ciphertext], base64url,
 * with a label authenticated alongside (`relay:state:<pc>` and so on).
 */
export interface Keys {
  authKey: string;
  encKey: CryptoKey;
}

const FORMAT = 1;
const utf8 = new TextEncoder();

export const normalizeUsername = (u: string) => u.trim().toLowerCase();

export async function deriveKeys(username: string, password: string, onProgress?: (fraction: number) => void): Promise<Keys> {
  const salt = `claude-switcher/v1/${normalizeUsername(username)}`;
  const master = await scryptAsync(utf8.encode(password.normalize('NFKC')), utf8.encode(salt), {
    N: 2 ** 16,
    r: 8,
    p: 1,
    dkLen: 32,
    onProgress,
  });
  const sub = (info: string) => hkdf(sha256, master, new Uint8Array(0), utf8.encode(info), 32);
  const authKey = toBase64(sub('auth'));
  const encKey = await crypto.subtle.importKey('raw', bytes(sub('enc')), 'AES-GCM', false, ['encrypt', 'decrypt']);
  master.fill(0);
  return { authKey, encKey };
}

export async function seal(keys: Keys, label: string, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const out = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8.encode(label) }, keys.encKey, utf8.encode(JSON.stringify(value))),
  );
  // WebCrypto appends the tag; the vault format puts it before the ciphertext.
  const ct = out.subarray(0, out.length - 16);
  const tag = out.subarray(out.length - 16);
  const blob = new Uint8Array(1 + 12 + 16 + ct.length);
  blob[0] = FORMAT;
  blob.set(iv, 1);
  blob.set(tag, 13);
  blob.set(ct, 29);
  return toBase64Url(blob);
}

export async function unseal<T = unknown>(keys: Keys, label: string, data: string): Promise<T> {
  const buf = fromBase64Url(data);
  if (buf[0] !== FORMAT || buf.length < 29) {
    throw new Error('Unknown format');
  }
  const sealed = new Uint8Array(buf.length - 13);
  sealed.set(buf.subarray(29));
  sealed.set(buf.subarray(13, 29), buf.length - 29);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(buf.subarray(1, 13)), additionalData: utf8.encode(label) }, keys.encKey, sealed);
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}

/** A plain ArrayBuffer-backed copy, which WebCrypto's types insist on. */
const bytes = (u: Uint8Array) => new Uint8Array(u);

export function toBase64(u: Uint8Array): string {
  let s = '';
  for (const b of u) {
    s += String.fromCharCode(b);
  }
  return btoa(s);
}

export const toBase64Url = (u: Uint8Array) => toBase64(u).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
