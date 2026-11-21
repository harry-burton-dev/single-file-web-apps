// Seeded pseudo random numbers with named, independent streams.
//
// createRandom(seed).stream(name) returns a generator that depends only on
// (seed, name): drawing from one stream never moves another. Repeated calls
// with the same name return the same generator object (so the sequence
// continues). Algorithm: sfc32, seeded through an xmur3 string hash.

const UINT32_RANGE = 4294967296;
const WARMUP_ROUNDS = 12;

function createStringHasher(text) {
  let h = 1779033703 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function nextWord() {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

function createSfc32(a, b, c, d) {
  return function nextUint32() {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return t >>> 0;
  };
}

function createStream(seedText) {
  const nextWord = createStringHasher(seedText);
  const uint32 = createSfc32(nextWord(), nextWord(), nextWord(), nextWord());
  for (let i = 0; i < WARMUP_ROUNDS; i++) uint32();

  const float = () => uint32() / UINT32_RANGE;

  function int(min, max) {
    if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
      throw new RangeError(`int(min, max) needs integers with min <= max, got ${min}, ${max}`);
    }
    return min + Math.floor(float() * (max - min + 1));
  }

  function bytes(n) {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i += 4) {
      let word = uint32();
      for (let k = 0; k < 4 && i + k < n; k++) {
        out[i + k] = word & 0xff;
        word >>>= 8;
      }
    }
    return out;
  }

  function pick(items) {
    if (!items.length) throw new RangeError("pick() needs a non-empty array");
    return items[int(0, items.length - 1)];
  }

  // Always consumes one draw, so a stream's position does not depend on p.
  const chance = (p) => float() < p;

  return { float, int, bytes, pick, chance };
}

export function createRandom(seed) {
  const streams = new Map();
  function stream(name) {
    let existing = streams.get(name);
    if (!existing) {
      existing = createStream(`${seed}::${name}`);
      streams.set(name, existing);
    }
    return existing;
  }
  return { stream };
}
