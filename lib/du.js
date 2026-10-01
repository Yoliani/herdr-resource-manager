import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const ENTRY_TTL_MS = 10 * 60_000;

/**
 * Serial background `du` scanner. Results are cached in the plugin state
 * dir (usage.json) so the board opens with sizes immediately. One scan
 * runs at a time; ensure() enqueues, drain() works through the queue.
 */
export class DiskScanner {
  constructor(stateDir) {
    this.cachePath = stateDir ? join(stateDir, "usage.json") : null;
    this.cache = new Map(); // path → { bytes, at }
    this.queue = [];
    this.running = false;
    if (this.cachePath) {
      try {
        const parsed = JSON.parse(readFileSync(this.cachePath, "utf8"));
        for (const [path, entry] of Object.entries(parsed ?? {})) {
          if (entry && typeof entry.bytes === "number") this.cache.set(path, entry);
        }
      } catch {
        // no cache yet
      }
    }
  }

  /** Cached size entry for a path, or null. */
  get(path) {
    return this.cache.get(path) ?? null;
  }

  /** Paths currently queued for scanning. */
  pending() {
    return this.queue;
  }

  /** Queue paths whose cache entry is missing or stale. */
  ensure(paths, { force = false } = {}) {
    const now = Date.now();
    for (const path of paths ?? []) {
      if (!path) continue;
      const entry = this.cache.get(path);
      const fresh = entry && now - entry.at < ENTRY_TTL_MS;
      if (!force && fresh) continue;
      if (!this.queue.includes(path)) this.queue.push(path);
    }
    this.#drain();
  }

  #drain() {
    if (this.running) return;
    this.running = true;
    const next = () => {
      const path = this.queue.shift();
      if (!path) {
        this.running = false;
        this.#persist();
        return;
      }
      const bytes = duBytes(path);
      this.cache.set(path, { bytes, at: Date.now() });
      setImmediate(next);
    };
    setImmediate(next);
  }

  #persist() {
    if (!this.cachePath) return;
    try {
      mkdirSync(dirname(this.cachePath), { recursive: true });
      const out = Object.fromEntries([...this.cache.entries()].sort(([a], [b]) => a.localeCompare(b)));
      writeFileSync(this.cachePath, JSON.stringify(out, null, 2) + "\n");
    } catch {
      // state dir may be unwritable; scanning still works in-memory
    }
  }
}

/** du -sk returns KB; map to bytes, null on failure. */
function duBytes(path) {
  const res = spawnSync("du", ["-sk", path], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 30_000,
  });
  if (res.status !== 0 || !res.stdout) return null;
  const kb = Number.parseInt(res.stdout.trim().split(/\s+/)[0], 10);
  return Number.isFinite(kb) ? kb * 1024 : null;
}
