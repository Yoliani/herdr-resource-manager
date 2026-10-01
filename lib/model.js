import { spawnSync } from "node:child_process";
import { call, result, errorCode } from "./herdr.js";
import { metricsForPane, herdrAppMetrics, psSnapshot } from "./metrics.js";

/**
 * Pure model builder. Inputs are already-fetched pieces so tests can run
 * without Herdr. Returns the resource model the TUI and snapshot render.
 *
 * Tree shape mirrors Orca's resource manager: repo → workspace → panes.
 */
export function buildModel({
  workspaces = [],
  panes = [],
  processInfoByPane = new Map(),
  psRows = [],
  repoByWorkspace = new Map(),
} = {}) {
  const rows = panes.map((p) => {
    const info = processInfoByPane.get(p.pane_id) ?? null;
    const shellPid = info?.shell_pid ?? null;
    const fgPgid = info?.foreground_process_group_id ?? null;
    const metrics = shellPid ? metricsForPane(psRows, { shellPid, fgPgid }) : null;
    const hasAgent = Boolean(p.agent);
    // Orphan: no recognized agent and the pane's only process is an idle
    // shell sitting at its prompt (Herdr analog of Orca's orphan terminals).
    // Any foreground command — or a command exec'd in place of the shell,
    // like a plugin pane — makes it not-an-orphan. A missing foreground
    // pgid means we cannot see the pane's real process tree, so we err
    // toward not flagging (and later killing) it.
    const isOrphan =
      !hasAgent &&
      fgPgid !== null &&
      metrics !== null &&
      metrics.processCount === 1 &&
      SHELLS.has(metrics.topProcess);
    const cwd = p.foreground_cwd || p.cwd || "";
    return {
      pane_id: p.pane_id,
      workspace_id: p.workspace_id,
      title: rowTitle(p, hasAgent, metrics, cwd),
      agent: p.agent ?? null,
      agentStatus: p.agent_status ?? null,
      cwd,
      focused: Boolean(p.focused),
      shellPid,
      fgPgid,
      metrics,
      isOrphan,
      isFinished: p.agent_status === "done",
      isAgent: hasAgent,
    };
  });

  const withMetrics = rows.filter((r) => r.metrics);
  const totals = {
    cpu: withMetrics.reduce((s, r) => s + r.metrics.cpu, 0),
    memBytes: withMetrics.reduce((s, r) => s + r.metrics.rssBytes, 0),
    paneCount: rows.length,
    agentCount: rows.filter((r) => r.isAgent).length,
    orphanCount: rows.filter((r) => r.isOrphan).length,
    finishedCount: rows.filter((r) => r.isFinished).length,
  };

  // Group workspaces by repo. Workspace without repo info falls back to a
  // group keyed by the workspace itself (label basis), like a plain project.
  const groups = new Map();
  for (const ws of workspaces) {
    const repo = repoByWorkspace.get(ws.workspace_id) ?? null;
    const repoKey = repo?.repo ?? `ws:${ws.workspace_id}`;
    const repoLabel = repo?.repo ?? (ws.label.replace(/^\[\d+\]\s*/, "") || ws.workspace_id);
    if (!groups.has(repoKey)) {
      groups.set(repoKey, {
        repo: repoKey,
        repoLabel,
        isSynthetic: !repo,
        workspaces: [],
      });
    }
    groups.get(repoKey).workspaces.push({
      workspace_id: ws.workspace_id,
      label: ws.label,
      focused: Boolean(ws.focused),
      paneCount: ws.pane_count ?? null,
      repo: repo?.repo ?? null,
      branch: repo?.branch ?? null,
      path: repo?.path ?? null,
      provenance: repo?.source ?? null,
      panes: rows
        .filter((r) => r.workspace_id === ws.workspace_id)
        .sort((a, b) => paneRank(a) - paneRank(b)),
    });
  }
  const repos = [...groups.values()].sort((a, b) => a.repoLabel.localeCompare(b.repoLabel));

  return {
    machine: null, // filled by collect()
    repos,
    panes: rows,
    orphans: rows.filter((r) => r.isOrphan),
    finished: rows.filter((r) => r.isFinished),
    totals,
    server: null, // filled by collect() via herdrAppMetrics()
  };
}

const SHELLS = new Set(["zsh", "-zsh", "bash", "-bash", "fish", "sh", "-sh", "pwsh"]);

function paneRank(pane) {
  // Agents first (working > blocked > done/idle > unknown), then orphans last.
  const statusRank = { working: 0, blocked: 1, idle: 2, done: 2, unknown: 3 };
  if (pane.isAgent) return statusRank[pane.agentStatus] ?? 3;
  if (pane.isOrphan) return 5;
  return 4;
}

/** Agents keep their terminal title; plain processes get a short label. */
function rowTitle(pane, hasAgent, metrics, cwd) {
  if (hasAgent) {
    return pane.terminal_title_stripped || pane.terminal_title || pane.pane_id;
  }
  const proc = metrics?.topProcess ?? "";
  const kind = SHELLS.has(proc) ? "shell" : proc || "process";
  const dir = cwd.split("/").filter(Boolean).pop() ?? cwd;
  return `${kind} · ${dir}`;
}

// ─── Live collection ────────────────────────────────────────────────

const repoCache = new Map(); // cwd → { repo, branch, path } | null
const worktreeCache = new Map(); // "machine|workspace_id" → { at, value }
const WORKTREE_TTL_MS = 60_000;

/**
 * Fetch everything from a live Herdr and build the model. Only `disk`
 * (du results) lives outside this module.
 */
export async function collect({ machine = null, withProcessInfo = true } = {}) {
  const wsRes = call(["workspace", "list"], { machine });
  const paneRes = call(["pane", "list"], { machine });
  const errors = [];
  if (!wsRes.ok) errors.push(`workspace list failed (${errorCode(wsRes) ?? wsRes.status ?? "no response"})`);
  if (!paneRes.ok) errors.push(`pane list failed (${errorCode(paneRes) ?? paneRes.status ?? "no response"})`);
  const workspaces = wsRes.ok ? wsRes.json?.result?.workspaces ?? [] : [];
  const paneList = paneRes.ok ? paneRes.json?.result?.panes ?? [] : [];
  // Metrics only work locally: pane PIDs come from the (possibly remote)
  // server, but ps runs here. For remote machines show topology and agent
  // state without fabricating numbers.
  const psRows = machine ? [] : psSnapshot();

  const processInfoByPane = new Map();
  if (withProcessInfo) {
    for (const pane of paneList) {
      const info = result(["pane", "process-info", "--pane", pane.pane_id], { machine });
      if (info?.process_info) processInfoByPane.set(pane.pane_id, info.process_info);
    }
  }

  const repoByWorkspace = new Map();
  for (const ws of workspaces) {
    // git toplevel only makes sense for local paths; remote grouping relies
    // on Herdr's own worktree provenance.
    const repo = worktreeRepo(ws, machine) ?? (machine ? null : gitRepo(cwdOfWorkspaces(paneList, ws.workspace_id)));
    if (repo) repoByWorkspace.set(ws.workspace_id, repo);
  }

  const model = buildModel({ workspaces, panes: paneList, processInfoByPane, psRows, repoByWorkspace });
  model.machine = machine;
  model.errors = errors;
  model.server = herdrAppMetrics(psRows);
  return model;
}

function cwdOfWorkspaces(panes, workspaceId) {
  const pane = panes.find((p) => p.workspace_id === workspaceId);
  return pane?.foreground_cwd || pane?.cwd || null;
}

/** Herdr worktree provenance: workspace → { repo, branch, path, source }. */
function worktreeRepo(ws, machine = null) {
  const cacheKey = `${machine ?? "local"}|${ws.workspace_id}`;
  const cached = worktreeCache.get(cacheKey);
  if (cached && Date.now() - cached.at < WORKTREE_TTL_MS) return cached.value;
  let value = null;
  const res = result(["worktree", "list", "--workspace", ws.workspace_id], { machine });
  let list = res?.worktrees;
  if (!Array.isArray(list)) list = [];
  const mine = list.find((t) => t.workspace_id === ws.workspace_id) ?? list[0];
  if (mine) {
    value = {
      repo: mine.repo ?? mine.repository ?? null,
      branch: mine.branch ?? null,
      path: mine.path ?? null,
      // Only Herdr-provenance records may drive destructive worktree removal.
      source: "herdr",
    };
  }
  worktreeCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

/** Fallback: derive repo identity from the pane cwd via git. */
function gitRepo(cwd) {
  if (!cwd) return null;
  if (repoCache.has(cwd)) return repoCache.get(cwd);
  let value = null;
  const res = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel", "--abbrev-ref", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 3000,
  });
  if (res.status === 0 && res.stdout) {
    const [top, branch = ""] = res.stdout.trim().split("\n");
    value = { repo: top, branch: branch.trim() || null, path: top, source: "git" };
  }
  repoCache.set(cwd, value);
  return value;
}
