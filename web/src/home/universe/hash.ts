// Stable hashes of strings: everything random-looking on the map comes from these, so it never changes between loads.
export function hash32(s: string, salt = 0): number {
  let h = (2166136261 ^ salt) >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return h >>> 0;
}

export function hash01(s: string, salt = 0): number {
  return hash32(s, salt) / 4294967296;
}
