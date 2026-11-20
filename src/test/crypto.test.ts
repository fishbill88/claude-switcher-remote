import { describe, expect, test } from 'vitest';
import { deriveKeys, seal, unseal } from '../crypto';
import vectors from './vectors.json';

// The vectors were made by the extension (src/vault.ts). A mismatch here means this app can't read a real vault.
describe('vault crypto matches the extension', () => {
  test('keys, and blobs the extension sealed', async () => {
    const keys = await deriveKeys(vectors.username, vectors.password);
    expect(keys.authKey).toBe(vectors.authKey);
    expect(await unseal(keys, vectors.label, vectors.sealed)).toEqual(vectors.plain);
  }, 30_000);

  test('what this app seals opens only under the same label', async () => {
    const keys = await deriveKeys(vectors.username, vectors.password);
    const blob = await seal(keys, 'relay:down:pc-1', { type: 'watch', session: 'abc' });
    expect(await unseal(keys, 'relay:down:pc-1', blob)).toEqual({ type: 'watch', session: 'abc' });
    await expect(unseal(keys, 'relay:down:pc-2', blob)).rejects.toThrow();
    await expect(unseal(keys, vectors.label, vectors.sealed.slice(0, -2) + 'AA')).rejects.toThrow();
  }, 30_000);
});
