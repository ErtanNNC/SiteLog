/** Deterministic, valid-looking UUIDs for demo data (FNV-1a based; not for production ids). */
export function demoId(key: string): string {
  const hex = (seed: number) => {
    let h = seed >>> 0;
    for (let i = 0; i < key.length; i++) {
      h ^= key.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  };
  const a = hex(0x811c9dc5);
  const b = hex(0x01000193);
  const c = hex(0x9e3779b9);
  const d = hex(0x7f4a7c15);
  const raw = `${a}${b}${c}${d}`; // 32 hex chars
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-4${raw.slice(13, 16)}-8${raw.slice(17, 20)}-${raw.slice(20, 32)}`;
}

/** Deterministic pseudo-random in [0,1) from a key (for waveform peaks etc.). */
export function demoRand(key: string, i = 0): number {
  let h = 2166136261 ^ i;
  const s = `${key}:${i}`;
  for (let k = 0; k < s.length; k++) {
    h ^= s.charCodeAt(k);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h % 10000) / 10000;
}
