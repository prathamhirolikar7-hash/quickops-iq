// Deterministic randomness. Every stream is derived from (seed, key...) with
// SHA-256, so each entity's values are stable no matter how much else changes.
import { createHash } from "node:crypto"

/** sfc32 PRNG seeded from a SHA-256 of the key parts */
export function rng(...parts) {
  const h = createHash("sha256").update(parts.join("|")).digest()
  let a = h.readUInt32LE(0), b = h.readUInt32LE(4), c = h.readUInt32LE(8), d = h.readUInt32LE(12)
  const next = () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0
    let t = (a + b) | 0
    a = b ^ (b >>> 9)
    b = (c + (c << 3)) | 0
    c = (c << 21) | (c >>> 11)
    d = (d + 1) | 0
    t = (t + d) | 0
    c = (c + t) | 0
    return (t >>> 0) / 4294967296
  }
  return {
    next,
    between: (min, max) => min + next() * (max - min),
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    chance: (p) => next() < p,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    /** entries: [value, weight][] */
    weighted: (entries) => {
      const total = entries.reduce((s, [, w]) => s + w, 0)
      let x = next() * total
      for (const [v, w] of entries) {
        x -= w
        if (x < 0) return v
      }
      return entries[entries.length - 1][0]
    },
    /** Sample an index from a prefix-sum array (ascending, last = total) */
    fromCumulative: (cum) => {
      const x = next() * cum[cum.length - 1]
      let lo = 0, hi = cum.length - 1
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (cum[mid] > x) hi = mid
        else lo = mid + 1
      }
      return lo
    },
    normal: (mean, sd) => {
      const u = Math.max(next(), 1e-12)
      const v = next()
      return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
    },
  }
}

/** Deterministic RFC 4122 version-5-style UUID from the seed + key */
export function uuidFor(seed, ...parts) {
  const h = createHash("sha1").update(`${seed}|${parts.join("|")}`).digest()
  h[6] = (h[6] & 0x0f) | 0x50
  h[8] = (h[8] & 0x3f) | 0x80
  const hex = h.subarray(0, 16).toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}
