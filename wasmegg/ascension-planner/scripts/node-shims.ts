/**
 * Minimal browser globals for running app code under Node.
 *
 * Side-effect-only, and imported FIRST by fastsearch.ts: ESM evaluates imports in
 * declaration order, so this runs before any store module whose top-level state()
 * reads localStorage (lib's eids store does exactly that, and throws at import
 * time without it).
 *
 * These are deliberately in-memory and throwaway. The harness never wants to
 * persist a player list or a plan library - it just needs the reads to not throw.
 */
class MemoryStorage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
}

const g = globalThis as any;
if (!g.localStorage) g.localStorage = new MemoryStorage();
if (!g.sessionStorage) g.sessionStorage = new MemoryStorage();
if (!g.window) g.window = g;
if (!g.document) {
  g.document = {
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
    documentElement: { style: {} },
    addEventListener() {},
    removeEventListener() {},
    body: { appendChild() {}, removeChild() {} },
  };
}
if (!g.navigator) g.navigator = { userAgent: 'node', language: 'en-US' };
// The plan-library code path (lib/storage/db) is never called by the search, but
// its module-level feature checks look for indexedDB; leaving it undefined is
// fine as long as it exists as a property.
if (!('indexedDB' in g)) g.indexedDB = undefined;

export {};
