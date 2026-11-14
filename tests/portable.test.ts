/**
 * The portable crypto in shared/crypto.ts exists so the knowledge layer can run
 * inside a browser as well as in Node. If its digests differed by even one bit
 * from the platform hashes, every stored index would silently invalidate and
 * every citation marker would point at the wrong passage.
 *
 * So these tests compare the pure-JS implementation against node:crypto's, and
 * against the published digests of the empty string and "abc".
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { randomId, sha1Hex, sha256Hex } from '../shared/crypto.js';

const SAMPLES = [
  '',
  'abc',
  'a',
  'The quick brown fox jumps over the lazy dog',
  'src_abc123:README.md:0',
  'sha256$\u00e9\u00fc\u00df\u4e2d\u6587',
  'x'.repeat(55), // padding boundary: exactly one byte short of a block
  'x'.repeat(56), // forces an extra padded block
  'x'.repeat(64),
  'y'.repeat(1000), // multi-block
];

describe('portable hashing', () => {
  it('matches node:crypto for sha1 on every sample', () => {
    for (const sample of SAMPLES) {
      const expected = createHash('sha1').update(sample).digest('hex');
      assert.equal(sha1Hex(sample), expected, `sha1 mismatch for ${JSON.stringify(sample.slice(0, 30))}`);
    }
  });

  it('matches node:crypto for sha256 on every sample', () => {
    for (const sample of SAMPLES) {
      const expected = createHash('sha256').update(sample).digest('hex');
      assert.equal(sha256Hex(sample), expected, `sha256 mismatch for ${JSON.stringify(sample.slice(0, 30))}`);
    }
  });

  it('reproduces the published digests', () => {
    assert.equal(sha1Hex('abc'), 'a9993e364706816aba3e25717850c26c9cd0d89d');
    assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('hashes raw bytes the same way as the equivalent hex string', () => {
    const bytes = new Uint8Array([0x61, 0x62, 0x63]);
    assert.equal(sha1Hex(bytes), sha1Hex('abc'));
    assert.equal(sha256Hex(bytes), sha256Hex('abc'));
  });

  it('produces ids that are unique and prefixed', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 500; i += 1) ids.add(randomId('ans'));
    assert.equal(ids.size, 500, 'ids collided');
    for (const id of ids) {
      assert.match(id, /^ans_[0-9a-f]{20}$/);
    }
  });
});
