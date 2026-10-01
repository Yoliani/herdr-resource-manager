#!/usr/bin/env node
// herdr.resource-manager board — live TUI over the resource model.
import { stdout, stdin, exit } from "node:process";
import { loadConfig } from "../lib/config.js";
import { call, result } from "../lib/herdr.js";
import { tokenize } from "../lib/keys.js";
import { formatMemShort } from "../lib/metrics.js";
import { collect } from "../lib/model.js";
import { DiskScanner } from "../lib/du.js";
import {
  renderFrame,
  confirmModal,
  cleanupModal,
  helpModal,
} from "../lib/render.js";

const config = loadConfig();

const state = {
  sort: config.sort,
  collapsed: new Set(),
  sel: 0,
  scroll: 0,
  width: stdout.columns ?? 80,
  height: stdout.rows ?? 24,
  intervalMs: config.intervalMs,
  keyPrefix: `${config.machine ?? "local"}|`,
  history: new Map(), // scopeKey → rss samples
  totalHistory: [],
  modal: null,
  status: null,
  lastModel: null,
  lastRows: [],
  machine: config.machine,
  annotate: config.annotate,
  tickTimer: null,
  running: true,
  pendingConfirm: null,
};

const disk = new DiskScanner(process.env.HERDR_PLUGIN_STATE_DIR ?? null);
const lastTokenSent = new Map(); // scopeKey → { value, at }
let duLastChecked = 0;

/** Machine-scoped key so caches never collide across servers. */
function scopeKey(paneId) {
  return `${state.machine ?? "local"}|${paneId}`;
}

// ─── Drawing & status ───────────────────────────────────────────────

function draw() {
  const model = state.lastModel ?? emptyModel();
  stdout.write(renderFrame(model, state, disk));
}

function emptyModel() {
  return {
    machine: null,
    repos: [],
    panes: [],
    orphans: [],
    finished: [],
    totals: { cpu: 0, memBytes: 0, paneCount: 0, agentCount: 0, orphanCount: 0, finishedCount: 0 },
    server: null,
    errors: null,
  };
}

function setStatus(text) {
  state.status = { text, at: Date.now() };
  draw();
}

function scheduleImmediateTick() {
  clearTimeout(state.tickTimer);
  tick();
}

// ─── Refresh loop ───────────────────────────────────────────────────

async function tick() {
  if (!state.running) return;
  try {
    const model = await collect({ machine: state.machine });
    updateHistory(model);
    state.lastModel = model;
    if (state.annotate) annotate(model);
    if (!state.machine && Date.now() - duLastChecked > 10_000) {
      duLastChecked = Date.now();
      disk.ensure(uniqueWorkspacePaths(model));
    }
  } catch (err) {
    setStatus(`collect failed: ${err.message}`);
  }
  try {
    draw();
    state.tickTimer = setTimeout(tick, state.intervalMs);
    state.tickTimer.unref?.();
  } catch (err) {
    // A render failure must not freeze the refresh loop forever.
    state.tickTimer = setTimeout(tick, state.intervalMs);
    state.tickTimer.unref?.();
    setStatus(`render failed: ${err.message}`);
  }
}

function updateHistory(model) {
  const live = new Set();
  for (const pane of model.panes) {
    live.add(scopeKey(pane.pane_id));
    if (!pane.metrics) continue;
    const key = scopeKey(pane.pane_id);
    const samples = state.history.get(key) ?? [];
    samples.push(pane.metrics.rssBytes);
    if (samples.length > 40) samples.shift();
    state.history.set(key, samples);
  }
  for (const id of state.history.keys()) {
    if (!live.has(id)) state.history.delete(id);
  }
  state.totalHistory.push(model.totals.memBytes);
  if (state.totalHistory.length > 40) state.totalHistory.shift();
}

function uniqueWorkspacePaths(model) {
  const paths = new Set();
  for (const repo of model?.repos ?? []) {
    for (const ws of repo.workspaces) {
      if (ws.path) paths.add(ws.path);
    }
  }
  return [...paths];
}

function annotate(model) {
  const ttl = Math.max(8000, state.intervalMs * 3);
  const now = Date.now();
  for (const pane of model.panes) {
    if (!pane.metrics) continue;
    const key = scopeKey(pane.pane_id);
    const value = formatMemShort(pane.metrics.rssBytes);
    const sent = lastTokenSent.get(key);
    // Renew before the TTL lapses even when the rounded value is unchanged,
    // or the sidebar token silently disappears.
    const unchanged = sent && sent.value === value && now - sent.at < ttl * 0.8;
    if (unchanged) continue;
    const res = call(
      [
        "pane",
        "report-metadata",
        pane.pane_id,
        "--source",
        "herdr.resource-manager",
        "--token",
        `MEM=${value}`,
        "--ttl-ms",
        String(ttl),
      ],
      { machine: state.machine }
    );
    if (res.ok) lastTokenSent.set(key, { value, at: now });
  }
}

function clearAnnotations(model) {
  const panes = model?.panes ?? [...lastTokenSent.keys()].map((k) => ({ pane_id: k.split("|")[1] }));
  for (const pane of panes) {
    call(
      [
        "pane",
        "report-metadata",
        pane.pane_id,
        "--source",
        "herdr.resource-manager",
        "--clear-token",
        "MEM",
      ],
      { machine: state.machine }
    );
  }
  const prefix = `${state.machine ?? "local"}|`;
  for (const key of lastTokenSent.keys()) {
    if (key.startsWith(prefix)) lastTokenSent.delete(key);
  }
}

// ─── Selection helpers ──────────────────────────────────────────────

function selectedRow() {
  return state.lastRows[state.sel] ?? null;
}

function move(delta) {
  state.sel = Math.min(Math.max(0, state.sel + delta), Math.max(0, state.lastRows.length - 1));
  draw();
}

function jumpTo(edge) {
  state.sel = edge === "top" ? 0 : Math.max(0, state.lastRows.length - 1);
  draw();
}

function toggleCollapse() {
  const row = selectedRow();
  if (!row || row.kind === "pane") {
    setStatus("select a repo or workspace row");
    return;
  }
  if (state.collapsed.has(row.id)) state.collapsed.delete(row.id);
  else state.collapsed.add(row.id);
  draw();
}

function cycleSort() {
  const order = ["name", "cpu", "mem"];
  const next = order[(order.indexOf(state.sort) + 1) % order.length];
  state.sort = next;
  setStatus(`sort: ${next}`);
  draw();
}

function focusSelected() {
  const row = selectedRow();
  if (!row) return;
  if (row.kind === "pane") {
    const res = call(["pane", "focus", row.pane.pane_id], { machine: state.machine });
    if (!res.ok) setStatus(`focus failed: ${res.json?.error?.code ?? res.stderr.trim()}`);
    return;
  }
  toggleCollapse();
}

// ─── Destructive actions (all confirm-gated, re-fetching targets) ───

function requireConfirm(title, detail, action) {
  state.modal = confirmModal(title, detail);
  state.pendingConfirm = action;
  draw();
}

function closePane(pane, { quiet = false } = {}) {
  // Re-fetch the target before destroying it: the selection may be stale
  // after a refresh, re-sort, or another client's cleanup.
  const fresh = call(["pane", "get", pane.pane_id], { machine: state.machine });
  if (!fresh.ok) {
    if (!quiet) setStatus(`${pane.pane_id} is already gone`);
    return false;
  }
  const res = call(["pane", "close", pane.pane_id], { machine: state.machine });
  if (!quiet) {
    setStatus(res.ok ? `closed ${pane.pane_id}` : `close failed: ${res.json?.error?.code ?? res.stderr.trim()}`);
  }
  return res.ok;
}

function closeSelectedPane() {
  const row = selectedRow();
  if (!row || row.kind !== "pane") {
    setStatus("select a pane row first");
    return;
  }
  const p = row.pane;
  const detail = p.isAgent ? `${p.title} (${p.agent}, ${p.agentStatus ?? "?"})` : p.title;
  requireConfirm(`Close pane ${p.pane_id}?`, detail, () => closePane(p));
}

function closeFinished() {
  const finished = state.lastModel?.finished ?? [];
  if (finished.length === 0) {
    setStatus("no finished agents");
    return;
  }
  requireConfirm(
    `Close ${finished.length} finished agent${finished.length === 1 ? "" : "s"}?`,
    finished.map((p) => p.pane_id).join(", "),
    () => {
      let closed = 0;
      for (const pane of finished) {
        if (closePane(pane, { quiet: true })) closed++;
      }
      setStatus(`closed ${closed} finished agent${closed === 1 ? "" : "s"}`);
    }
  );
}

function runCleanup(kind) {
  const targets = kind === "orphans" ? state.lastModel?.orphans ?? [] : state.lastModel?.finished ?? [];
  let closed = 0;
  for (const pane of targets) {
    if (closePane(pane, { quiet: true })) closed++;
  }
  setStatus(`closed ${closed} pane${closed === 1 ? "" : "s"}`);
}

function closeWorkspaceConfirm() {
  const row = selectedRow();
  if (!row || row.kind !== "workspace") {
    setStatus("select a workspace row first");
    return;
  }
  requireConfirm(`Close workspace ${row.ws.workspace_id}?`, row.ws.label, () => closeWorkspace(row.ws));
}

function closeWorkspace(ws) {
  // Re-fetch: the workspace may have been closed by another client since
  // the row was drawn.
  const fresh = result(["workspace", "list"], { machine: state.machine });
  const stillThere = (fresh?.workspaces ?? []).some((w) => w.workspace_id === ws.workspace_id);
  if (!stillThere) {
    setStatus(`${ws.workspace_id} is already gone`);
    return false;
  }
  const res = call(["workspace", "close", ws.workspace_id], { machine: state.machine });
  if (!res.ok) {
    const code = res.json?.error?.code;
    if (code === "workspace_group_close_required") {
      setStatus("workspace is a worktree group; use workspace close --group or D to remove the checkout");
      return false;
    }
    setStatus(`close failed: ${code ?? res.stderr.trim()}`);
    return false;
  }
  setStatus(`closed ${ws.workspace_id}`);
  return true;
}

function removeSelectedWorktree() {
  const row = selectedRow();
  if (!row || row.kind !== "workspace") {
    setStatus("select a workspace row first");
    return;
  }
  // Only Herdr-created linked worktrees are removable; a git-fallback path
  // may be an ordinary checkout and must not be offered deletion.
  if (row.ws.provenance !== "herdr" || !row.ws.path) {
    setStatus("not a Herdr linked worktree");
    return;
  }
  requireConfirm(
    `Delete worktree checkout?`,
    `${row.ws.path}${row.ws.branch ? ` (${row.ws.branch})` : ""} — files on disk are removed`,
    () => removeWorktree(row.ws)
  );
}

function removeWorktree(ws) {
  // No --force: a dirty checkout must be resolved by the user, not silently
  // deleted. Herdr refuses removal of ordinary repo checkouts.
  // Re-fetch provenance: only a still-registered Herdr worktree may go.
  const fresh = result(["worktree", "list", "--workspace", ws.workspace_id], { machine: state.machine });
  const record = (fresh?.worktrees ?? []).find((t) => t.workspace_id === ws.workspace_id) ?? (fresh?.worktrees ?? [])[0];
  if (!record) {
    setStatus(`${ws.workspace_id} is no longer a registered worktree`);
    return;
  }
  const res = call(["worktree", "remove", "--workspace", ws.workspace_id], {
    machine: state.machine,
  });
  setStatus(
    res.ok
      ? `removed worktree ${ws.path ?? ws.workspace_id}`
      : `worktree remove failed: ${res.json?.error?.code ?? res.stderr.trim()} (resolve dirty files first)`
  );
}

// ─── Machine scope ──────────────────────────────────────────────────

function machineChoices() {
  // machine list --json prints a bare array (unlike result-wrapped commands).
  const res = call(["machine", "list", "--json"], { machine: null });
  let list = [];
  if (Array.isArray(res.json)) list = res.json;
  else if (Array.isArray(res.json?.result)) list = res.json.result;
  else if (Array.isArray(res.json?.result?.machines)) list = res.json.result.machines;
  const choices = [null]; // local first
  for (const m of list) {
    if (m?.enabled === false) continue;
    const value = m.label ?? m.id;
    if (value) choices.push(value);
  }
  return choices;
}

function cycleMachine() {
  const choices = machineChoices();
  if (choices.length <= 1) {
    setStatus("no saved machines; add one with herdr machine add");
    return;
  }
  if (state.annotate && state.lastModel) clearAnnotations(state.lastModel);
  const idx = choices.indexOf(state.machine);
  const next = choices[(idx + 1) % choices.length] ?? choices[0];
  state.machine = next;
  state.keyPrefix = `${next ?? "local"}|`;
  // The new scope has its own inventory; drop stale view state.
  state.lastModel = null;
  state.lastRows = [];
  state.sel = 0;
  state.scroll = 0;
  scheduleImmediateTick();
  setStatus(`scope: ${next ?? "local"} (metrics local-only)`);
}

// ─── Disk rescan ────────────────────────────────────────────────────

function rescanDisk() {
  if (state.machine) {
    setStatus("disk scan is local-only");
    return;
  }
  const row = selectedRow();
  let paths;
  if (row?.kind === "workspace" && row.ws.path) {
    paths = [row.ws.path];
  } else {
    paths = uniqueWorkspacePaths(state.lastModel ?? {});
  }
  disk.ensure(paths, { force: true });
  setStatus(`rescanning ${paths.length} path${paths.length === 1 ? "" : "s"}`);
}

// ─── Input ──────────────────────────────────────────────────────────

function handleKey(data) {
  let chunk = data.toString();
  // The tail of a split escape sequence (e.g. "\x1b[") from the previous
  // chunk must be joined with the rest before tokenizing.
  if (escBuffer !== null) {
    clearTimeout(escTimer);
    chunk = escBuffer + chunk;
    escBuffer = null;
  }
  const { tokens, pending } = tokenize(chunk);
  if (pending !== null) {
    escBuffer = pending;
    escTimer = setTimeout(() => {
      escBuffer = null;
      handleSingleKey("\x1b"); // flush: it was a real Escape after all
    }, 50);
  }
  for (const key of tokens) handleSingleKey(key);
}

let escBuffer = null;
let escTimer = null;

function handleSingleKey(key) {
  if (state.modal) {
    if (state.modal.kind === "confirm") {
      if (key === "y") {
        const action = state.pendingConfirm;
        state.modal = null;
        state.pendingConfirm = null;
        action?.();
        scheduleImmediateTick();
      } else if (key === "n" || key === "\x1b" || key === "\r") {
        state.modal = null;
        state.pendingConfirm = null;
        draw();
      }
      return;
    }
    if (state.modal.kind === "cleanup") {
      if (key === "o") {
        state.modal = null;
        runCleanup("orphans");
      } else if (key === "f") {
        state.modal = null;
        runCleanup("finished");
      } else if (key === "\x1b" || key === "q" || key === "\r") {
        state.modal = null;
        draw();
      }
      return;
    }
    // help
    state.modal = null;
    draw();
    return;
  }

  switch (key) {
    case "\x1b[A":
      return move(-1);
    case "\x1b[B":
      return move(1);
    case "\x1b[C":
      return toggleCollapse();
    case "\x1b[D":
      return toggleCollapse();
    case "\r":
      return focusSelected();
    case "\x03": // ctrl+c
    case "\x1b": // esc
      return quit();
    case "j":
      return move(1);
    case "k":
      return move(-1);
    case "x":
      return closeSelectedPane();
    case "f":
      return focusSelected();
    case "K":
      return closeFinished();
    case "h":
      return toggleCollapse();
    case "l":
      return toggleCollapse();
    case "g":
      return jumpTo("top");
    case "G":
      return jumpTo("bottom");
    case "s":
      return cycleSort();
    case "c":
      state.modal = cleanupModal(state.lastModel);
      return draw();
    case "?":
      state.modal = helpModal();
      return draw();
    case "w":
      return closeWorkspaceConfirm();
    case "D":
      return removeSelectedWorktree();
    case "m":
      return cycleMachine();
    case "a": {
      state.annotate = !state.annotate;
      if (!state.annotate) clearAnnotations(state.lastModel);
      setStatus(`sidebar memory tokens: ${state.annotate ? "on" : "off"}`);
      return;
    }
    case "d":
      return rescanDisk();
    case "r":
      return scheduleImmediateTick();
    case "q":
      return quit();
    default:
      return;
  }
}

// ─── Lifecycle ──────────────────────────────────────────────────────

function quit() {
  state.running = false;
  clearTimeout(state.tickTimer);
  if (state.annotate) clearAnnotations(state.lastModel);
  stdout.write("\x1b[?1049l\x1b[?25h");
  stdin.setRawMode(false);
  stdin.pause();
  exit(0);
}

stdout.write("\x1b[?1049h\x1b[?25l");
stdin.setRawMode(true);
stdin.resume();
stdin.setEncoding("utf8");
stdin.on("data", handleKey);
stdout.on("resize", () => {
  state.width = stdout.columns ?? state.width;
  state.height = stdout.rows ?? state.height;
  draw();
});
tick();
