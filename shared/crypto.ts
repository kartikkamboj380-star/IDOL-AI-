/**
 * The two crypto primitives the knowledge layer needs, usable from Node and from
 * a browser.
 *
 * The indexer only needs a stable hash of a passage key, and ids only need to be
 * unique within one session. Neither is a security boundary, so a plain 128-bit
 * hash is enough — but it must be *stable*: passage ids appear inside citations,
 * and a different algorithm would silently invalidate every stored index.
 *
 * `node:crypto` is unavailable in the browser build and `crypto.subtle` is async,
 * so this file carries both paths: the exact node:crypto hash when it is there,
 * and a synchronous implementation on the raw SHA-1/SHA-256 compression function
 * when it is not. The digests match the platform ones byte for byte, which
 * `tests/portable.test.ts` checks.
 */

/* ------------------------------------------------------------------ */
/* SHA-1 / SHA-256 (synchronous, portable)                            */
/* ------------------------------------------------------------------ */

const rotl = (value: number, bits: number): number => (value << bits) | (value >>> (32 - bits));

function padding(lengthBytes: number): Uint8Array {
  // 0x80, then zeros, then the 64-bit big-endian bit length.
  const zeroPad = (56 - ((lengthBytes + 1) % 64) + 64) % 64;
  const total = lengthBytes + 1 + zeroPad + 8;
  const out = new Uint8Array(total);
  out[lengthBytes] = 0x80;
  const bits = lengthBytes * 8;
  // Message lengths here are far below 2^32 bits, so the high word is zero.
  writeUint32(out, total - 4, bits >>> 0);
  writeUint32(out, total - 8, Math.floor(bits / 0x100000000) >>> 0);
  return out;
}

function writeUint32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

function readUint32(source: Uint8Array, offset: number): number {
  return (
    ((source[offset]! << 24) | (source[offset + 1]! << 16) | (source[offset + 2]! << 8) | source[offset + 3]!) >>> 0
  );
}

function toBytes(input: string): Uint8Array {
  return new TextEncoder().encode(input);
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

function sha1Bytes(message: Uint8Array): Uint8Array {
  const data = new Uint8Array(message.length + padding(message.length).length);
  data.set(message, 0);
  data.set(padding(message.length), message.length);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Int32Array(80);

  for (let offset = 0; offset < data.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = readUint32(data, offset + i * 4);
    for (let i = 16; i < 80; i += 1) w[i] = rotl(w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!, 1);

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;

    for (let i = 0; i < 80; i += 1) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (rotl(a, 5) + f + e + k + w[i]!) | 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = temp;
    }

    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
  }

  const out = new Uint8Array(20);
  writeUint32(out, 0, h0 >>> 0);
  writeUint32(out, 4, h1 >>> 0);
  writeUint32(out, 8, h2 >>> 0);
  writeUint32(out, 12, h3 >>> 0);
  writeUint32(out, 16, h4 >>> 0);
  return out;
}

const K256 = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function sha256Bytes(message: Uint8Array): Uint8Array {
  const data = new Uint8Array(message.length + padding(message.length).length);
  data.set(message, 0);
  data.set(padding(message.length), message.length);

  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Int32Array(64);

  for (let offset = 0; offset < data.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = readUint32(data, offset + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotl(w[i - 15]!, 25) ^ rotl(w[i - 15]!, 14) ^ (w[i - 15]! >>> 3);
      const s1 = rotl(w[i - 2]!, 15) ^ rotl(w[i - 2]!, 13) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
    }

    let [a, b, c, d, e, f, g, hh] = h as [number, number, number, number, number, number, number, number];

    for (let i = 0; i < 64; i += 1) {
      const S1 = rotl(e, 26) ^ rotl(e, 21) ^ rotl(e, 7);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + S1 + ch + K256[i]! + w[i]!) | 0;
      const S0 = rotl(a, 30) ^ rotl(a, 19) ^ rotl(a, 10);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }

    h[0] = (h[0]! + a) | 0;
    h[1] = (h[1]! + b) | 0;
    h[2] = (h[2]! + c) | 0;
    h[3] = (h[3]! + d) | 0;
    h[4] = (h[4]! + e) | 0;
    h[5] = (h[5]! + f) | 0;
    h[6] = (h[6]! + g) | 0;
    h[7] = (h[7]! + hh) | 0;
  }

  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i += 1) writeUint32(out, i * 4, h[i]! >>> 0);
  return out;
}

/* ------------------------------------------------------------------ */
/* Platform digests                                                   */
/* ------------------------------------------------------------------ */

type NodeCrypto = {
  createHash: (algorithm: string) => {
    update: (data: string | Uint8Array) => { digest: (encoding: 'hex') => string };
  };
};

let nodeCrypto: NodeCrypto | null | undefined;

function getNodeCrypto(): NodeCrypto | null {
  if (nodeCrypto !== undefined) return nodeCrypto;
  try {
    // Node only. In a browser this throws and the portable path is used.
    const proc = (globalThis as { process?: { getBuiltinModule?: (name: string) => NodeCrypto } }).process;
    nodeCrypto = proc?.getBuiltinModule?.('node:crypto') ?? null;
  } catch {
    nodeCrypto = null;
  }
  return nodeCrypto;
}

/** Accepts a string or raw bytes (Node's fs may hand back a Buffer). */
export type HashInput = string | Uint8Array;

/** SHA-1 hex digest. Identical output on Node and in the browser. */
export function sha1Hex(input: HashInput): string {
  const node = getNodeCrypto();
  if (node) return node.createHash('sha1').update(input).digest('hex');
  return toHex(sha1Bytes(typeof input === 'string' ? toBytes(input) : input));
}

/** SHA-256 hex digest. Identical output on Node and in the browser. */
export function sha256Hex(input: HashInput): string {
  const node = getNodeCrypto();
  if (node) return node.createHash('sha256').update(input).digest('hex');
  return toHex(sha256Bytes(typeof input === 'string' ? toBytes(input) : input));
}

/** A short unique id, e.g. `ans_1f4c8ab39d2e0a44c1b7`. */
export function randomId(prefix: string, length = 20): string {
  const bytes = new Uint8Array(16);
  const webCrypto = (globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => void } }).crypto;
  if (webCrypto?.getRandomValues) {
    webCrypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  return `${prefix}_${toHex(bytes).slice(0, length)}`;
}
