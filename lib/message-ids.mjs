// Fixed 8 KiB per tracked session. No false negatives for older message IDs;
// a false positive only requests an extra authoritative history rebuild.
export class OlderMessageIds {
  constructor() { this.bits = new Uint32Array(2048); }
  hash(id) {
    let a = 2166136261, b = 5381;
    for (const c of String(id)) { a = Math.imul(a ^ c.charCodeAt(0), 16777619); b = Math.imul(b, 33) ^ c.charCodeAt(0); }
    return [a >>> 0, (b | 1) >>> 0];
  }
  add(id) { const [a, b] = this.hash(id); for (let i = 0; i < 4; i++) { const bit = (a + Math.imul(i, b)) & 65535; this.bits[bit >>> 5] |= 1 << (bit & 31); } }
  has(id) { const [a, b] = this.hash(id); for (let i = 0; i < 4; i++) { const bit = (a + Math.imul(i, b)) & 65535; if (!(this.bits[bit >>> 5] & (1 << (bit & 31)))) return false; } return true; }
}
