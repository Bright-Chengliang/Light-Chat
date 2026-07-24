import { JsonStore } from './account-store.mjs';

const WINDOW_MS = 15 * 60 * 1000;
const BLOCK_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;

export class LoginLimiter {
  constructor(path) {
    this.store = new JsonStore(path, { version: 1, entries: {} });
    this.value = null;
    this.queue = Promise.resolve();
  }

  async initialize() {
    const loaded = await this.store.load();
    this.value = loaded?.version === 1 && loaded.entries && typeof loaded.entries === 'object'
      ? loaded
      : { version: 1, entries: {} };
    await this.cleanup(true);
  }

  state(key, now = Date.now()) {
    const entry = this.value.entries[key];
    if (!entry) return { blocked: false, retryAfter: 0 };
    if (entry.blockedUntil > now) {
      return { blocked: true, retryAfter: Math.max(1, Math.ceil((entry.blockedUntil - now) / 1000)) };
    }
    if (now - entry.windowStartedAt >= WINDOW_MS) {
      delete this.value.entries[key];
      return { blocked: false, retryAfter: 0 };
    }
    return { blocked: false, retryAfter: 0 };
  }

  async failure(key, now = Date.now()) {
    const existing = this.value.entries[key];
    const entry = !existing || now - existing.windowStartedAt >= WINDOW_MS
      ? { failures: 0, windowStartedAt: now, blockedUntil: 0 }
      : existing;
    entry.failures += 1;
    if (entry.failures >= MAX_FAILURES) entry.blockedUntil = now + BLOCK_MS;
    this.value.entries[key] = entry;
    await this.persist();
    return this.state(key, now);
  }

  async success(key) {
    if (!this.value.entries[key]) return;
    delete this.value.entries[key];
    await this.persist();
  }

  async cleanup(persist = false) {
    const staleBefore = Date.now() - WINDOW_MS - BLOCK_MS;
    let changed = false;
    for (const [key, entry] of Object.entries(this.value.entries)) {
      if (!entry || Math.max(entry.windowStartedAt || 0, entry.blockedUntil || 0) < staleBefore) {
        delete this.value.entries[key];
        changed = true;
      }
    }
    if (persist && changed) await this.persist();
  }

  persist() {
    const snapshot = structuredClone(this.value);
    this.queue = this.queue.catch(() => undefined).then(() => this.store.save(snapshot));
    return this.queue;
  }
}
