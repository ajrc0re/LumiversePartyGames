/** A source of uniform numbers in [0, 1). Injected so tests can pass a seeded one. */
export interface Rng {
  next(): number;
}

/** Small, fast, seedable PRNG. Used for replays and tests, never for secrets. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return {
    next() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

/** Integer in [0, maxExclusive). */
export function randomInt(rng: Rng, maxExclusive: number): number {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) throw new RangeError("maxExclusive must be a positive integer.");
  return Math.min(maxExclusive - 1, Math.floor(rng.next() * maxExclusive));
}

/** Fisher–Yates shuffle into a new array. */
export function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = randomInt(rng, index + 1);
    const held = result[index] as T;
    result[index] = result[swap] as T;
    result[swap] = held;
  }
  return result;
}

/** A 32-bit seed from the platform's cryptographic source. Backend only. */
export function cryptoSeed(): number {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return buffer[0] ?? 0;
}

/** Uniform numbers built from crypto.getRandomValues. Backend only. */
export function cryptoRng(): Rng {
  return { next: () => cryptoSeed() / 4294967296 };
}
