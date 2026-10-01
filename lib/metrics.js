import { spawnSync } from "node:child_process";

// ─── ps snapshot ────────────────────────────────────────────────────

/** One process row from the shared ps snapshot. */
export function psSnapshot() {
  // macOS takes -axo; Linux needs -eo. Same output fields either way.
  let res = spawnSync("ps", ["-axo", "pid=,ppid=,pgid=,pcpu=,rss=,comm="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5000,
  });
  if (res.status !== 0 || !res.stdout) {
    res = spawnSync("ps", ["-eo", "pid,ppid,pgid,pcpu,rss,comm"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
  }
  const rows = [];
  for (const line of (res.stdout ?? "").split("\n")) {
    const parsed = parsePsLine(line);
    if (parsed) rows.push(parsed);
  }
  return rows;
}

/** Parse "  1234     1  1234   0.5   4992 /bin/zsh" — rss is KB. */
export function parsePsLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/\s+/);
  if (parts.length < 6) return null;
  const [pid, ppid, pgid, cpu, rss, ...rest] = parts;
  const comm = rest.join(" ");
  if (![pid, ppid, pgid].every((n) => /^\d+$/.test(n))) return null;
  return {
    pid: Number(pid),
    ppid: Number(ppid),
    pgid: Number(pgid),
    cpu: Number(cpu) || 0,
    rssBytes: (Number(rss) || 0) * 1024,
    comm,
  };
}

/** Basename of a ps comm value ("/usr/local/bin/node" → "node"). */
export function shortName(comm) {
  const base = (comm ?? "").split("/").pop() ?? "";
  return base.split(" ")[0] ?? base;
}

// ─── Aggregation ────────────────────────────────────────────────────

/**
 * Metrics for one pane: the pane shell plus its foreground process group
 * (deduplicated when the shell itself owns the foreground pgid).
 */
export function metricsForPane(psRows, { shellPid, fgPgid }) {
  const own = psRows.filter((r) => r.pid === shellPid);
  const fg = fgPgid ? psRows.filter((r) => r.pgid === fgPgid && r.pid !== shellPid) : [];
  const all = [...own, ...fg];
  if (all.length === 0) return null;
  const cpu = all.reduce((sum, r) => sum + (r.cpu || 0), 0);
  const rssBytes = all.reduce((sum, r) => sum + (r.rssBytes || 0), 0);
  const top = [...all].sort((a, b) => b.rssBytes - a.rssBytes)[0];
  return {
    cpu,
    rssBytes,
    processCount: all.length,
    topProcess: shortName(top?.comm ?? ""),
  };
}

/**
 * Figure for the "herdr app" row: every herdr binary in the snapshot
 * (server, TUI clients). The ps snapshot is taken before collect spawns
 * any transient CLI children, so no exclusion dance is needed.
 */
export function herdrAppMetrics(psRows) {
  const rows = psRows.filter((r) => /(^|\/)herdr(-server)?(\s|$)/.test(r.comm));
  if (rows.length === 0) return null;
  return {
    cpu: rows.reduce((s, r) => s + (r.cpu || 0), 0),
    rssBytes: rows.reduce((s, r) => s + (r.rssBytes || 0), 0),
    processCount: rows.length,
  };
}

// ─── Formatting ─────────────────────────────────────────────────────

export function formatCpu(percent) {
  if (percent === null || percent === undefined || !Number.isFinite(percent)) return "—";
  return `${percent.toFixed(1)}%`;
}

export function formatMem(bytes) {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "—";
  if (bytes < 1024 * 1024) return `${Math.max(0, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** Compact variant for sidebar tokens ("49.2M", "704K", "1.2G"). */
export function formatMemShort(bytes) {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "—";
  if (bytes < 1024 * 1024) return `${Math.max(0, Math.round(bytes / 1024))}K`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)}M`;
  return `${(bytes / 1024 ** 3).toFixed(1)}G`;
}

const BLOCKS = "▁▂▃▄▅▆▇█";

/**
 * Sparkline of the last `width` samples; shorter series are left-padded
 * with the low block. Values are scaled against the series maximum.
 */
export function sparkline(samples, width) {
  if (!width || width <= 0) return "";
  const tail = (samples ?? []).slice(-width);
  if (tail.length === 0) return "▁".repeat(width);
  const max = Math.max(...tail, 1);
  const bars = tail.map((v) => BLOCKS[Math.min(BLOCKS.length - 1, Math.floor((v / max) * (BLOCKS.length - 1)))]);
  return "▁".repeat(width - tail.length) + bars.join("");
}
