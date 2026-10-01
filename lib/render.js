import { formatCpu, formatMem, sparkline } from "./metrics.js";

export const RESET = "\x1b[0m";
export const BOLD = "\x1b[1m";
export const DIM = "\x1b[2m";
export const RED = "\x1b[31m";
export const GREEN = "\x1b[32m";
export const YELLOW = "\x1b[33m";
export const MAGENTA = "\x1b[35m";
export const CYAN = "\x1b[36m";

const SPARK_W = 12;

/** Visible terminal-cell width of a string, ANSI-stripped, CJK-aware. */
export function visible(text) {
  const plain = text.replace(/\x1b\[[0-9;]*m/g, "");
  // Count East Asian Wide/Fullwidth code points as two terminal cells.
  let cells = 0;
  for (const ch of plain) {
    const code = ch.codePointAt(0);
    cells += (code >= 0x1100 && (code <= 0x115f || code === 0x2329 || code === 0x232a)) ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1f64f) ||
      (code >= 0x1f900 && code <= 0x1f9ff)
      ? 2
      : 1;
  }
  return cells;
}

/** Pad to n cells, or clip with an ellipsis — ANSI-aware. */
export function fit(text, n) {
  if (visible(text) <= n) return text + " ".repeat(n - visible(text));
  let out = "";
  let cells = 0;
  for (let i = 0; i < text.length; ) {
    if (text[i] === "\x1b") {
      const m = text.slice(i).match(/^\x1b\[[0-9;]*m/);
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    const ch = text[i];
    const w = visible(ch);
    if (cells + w > n - 1) break;
    out += ch;
    cells += w;
    i += 1;
  }
  return out + "…";
}

function right(text, n) {
  const pad = Math.max(0, n - visible(text));
  return " ".repeat(pad) + text;
}

// ─── View rows ──────────────────────────────────────────────────────

/**
 * Flatten the model into selectable rows: repo → workspace → panes.
 * Collapsed groups hide their children; panes sort per workspace.
 */
export function buildViewRows(model, state) {
  const rows = [];
  const paneSort = paneComparator(state.sort);
  for (const repo of model.repos ?? []) {
    const repoId = `repo:${repo.repo}`;
    let repoCpu = 0;
    let repoMem = 0;
    let agentCount = 0;
    let paneCount = 0;
    const wsRows = [];
    for (const ws of repo.workspaces) {
      const panes = [...ws.panes].sort(paneSort);
      let wsCpu = 0;
      let wsMem = 0;
      for (const p of panes) {
        wsCpu += p.metrics?.cpu ?? 0;
        wsMem += p.metrics?.rssBytes ?? 0;
      }
      repoCpu += wsCpu;
      repoMem += wsMem;
      const wsAgentCount = panes.filter((p) => p.isAgent).length;
      agentCount += wsAgentCount;
      paneCount += panes.length;
      const wsId = `ws:${ws.workspace_id}`;
      wsRows.push({
        kind: "workspace",
        id: wsId,
        depth: 1,
        label: ws.label.replace(/^\[\d+\]\s*/, ""),
        cpu: wsCpu,
        mem: wsMem,
        collapsed: state.collapsed.has(wsId),
        ws,
        agentCount: wsAgentCount,
        paneCount: panes.length,
      });
      if (!state.collapsed.has(wsId)) {
        for (const p of panes) {
          wsRows.push({
            kind: "pane",
            id: `pane:${p.pane_id}`,
            depth: 2,
            label: paneLabel(p),
            cpu: p.metrics?.cpu ?? null,
            mem: p.metrics?.rssBytes ?? null,
            pane: p,
          });
        }
      }
    }
    rows.push({
      kind: "repo",
      id: repoId,
      depth: 0,
      label: repo.repoLabel,
      cpu: repoCpu,
      mem: repoMem,
      collapsed: state.collapsed.has(repoId),
      repo,
      agentCount,
      paneCount,
    });
    if (!state.collapsed.has(repoId)) rows.push(...wsRows);
  }
  return rows;
}

function plural(text, n) {
  return n === 1 ? text : `${text}s`;
}

function paneLabel(p) {
  if (p.isAgent) return `[${p.agent}] ${p.agentStatus ?? "?"} ${p.title}`;
  return (p.isOrphan ? "orphan " : "") + p.title;
}

function paneComparator(sort) {
  if (sort === "name") return (a, b) => paneLabel(a).localeCompare(paneLabel(b));
  if (sort === "cpu") {
    return (a, b) => (b.metrics?.cpu ?? -1) - (a.metrics?.cpu ?? -1);
  }
  return (a, b) => (b.metrics?.rssBytes ?? -1) - (a.metrics?.rssBytes ?? -1);
}

// ─── Rendering ──────────────────────────────────────────────────────

/** Rows reserved outside the scrollable body. */
function bodyHeight(height) {
  return Math.max(1, height - 5);
}

export function renderFrame(model, state, disk = null) {
  const width = state.width;
  const height = state.height;
  const rows = buildViewRows(model, state);
  if (state.sel >= rows.length) state.sel = Math.max(0, rows.length - 1);
  const errorCount = model.errors?.length ?? 0;
  // Keep the selection visible; remember rows so key handlers can resolve
  // the selected row back to a pane/workspace/repo.
  const bodyH = bodyHeight(height) - errorCount;
  if (state.sel < state.scroll) state.scroll = state.sel;
  if (state.sel >= state.scroll + bodyH) state.scroll = state.sel - bodyH + 1;
  if (state.scroll < 0) state.scroll = 0;
  state.lastRows = rows;

  const lines = [];

  // Header
  const scope = model.machine ? `machine:${model.machine}` : "local";
  const scan = disk && disk.pending().length > 0 ? ` ${CYAN}◌ scanning${RESET}` : "";
  lines.push(
    `${BOLD}Resource manager${RESET} ${DIM}· ${scope} · every ${state.intervalMs / 1000}s${scan}${RESET}`
  );

  // Disconnected / partial banner — missing data must not read as empty.
  if (model.errors?.length) {
    for (const err of model.errors) {
      lines.push(`${RED}⚠ ${fit(err, width - 2)}${RESET}`);
    }
  }

  const t = model.totals;
  const server = model.server ? `herdr app ${formatMem(model.server.rssBytes)}` : "";
  const flags = [
    plural(`${t.paneCount} pane`, t.paneCount),
    plural(`${t.agentCount} agent`, t.agentCount),
    t.orphanCount > 0 ? `${YELLOW}${plural(`${t.orphanCount} orphan`, t.orphanCount)}${RESET}` : "",
    t.finishedCount > 0 ? `${CYAN}${t.finishedCount} done${RESET}` : "",
    server,
  ].filter(Boolean);
  const flagsText = flags.join(" · ");
  const spark = sparkline(state.totalHistory ?? [], SPARK_W);
  const left = `${BOLD}CPU${RESET} ${formatCpu(t.cpu)}  ${BOLD}MEM${RESET} ${formatMem(t.memBytes)}  `;
  const avail = Math.max(0, width - visible(left) - 1 - SPARK_W);
  let flagsPart;
  if (visible(flagsText) <= avail) {
    flagsPart = `${" ".repeat(avail - visible(flagsText))}${flagsText}`;
  } else {
    flagsPart = fit(flagsText, avail);
  }
  lines.push(`${left}${flagsPart} ${DIM}${spark}${RESET}`);

  // Column header with the active sort marked.
  const nameHeader = state.sort === "name" ? "NAME ↓" : "NAME";
  const cpuHeader = state.sort === "cpu" ? "CPU ↓" : "CPU";
  const memHeader = state.sort === "mem" ? "MEM ↓" : "MEM";
  lines.push(
    `  ${BOLD}${fit(nameHeader, 10)}${RESET}${" ".repeat(Math.max(0, width - 32))}${right(`${BOLD}${cpuHeader}${RESET}`, 6)}  ${right(`${BOLD}${memHeader}${RESET}`, 9)}  `
  );

  // Body rows
  const windowed = rows.slice(state.scroll, state.scroll + bodyH);
  for (const row of windowed) {
    lines.push(renderRow(row, row.index ?? rows.indexOf(row), state, disk, width));
  }
  while (lines.length < 3 + errorCount + bodyH) lines.push("");

  // Status line (transient) or blank, then footer.
  const statusFresh = state.status && Date.now() - state.status.at < 6000;
  lines.push(statusFresh ? `${CYAN}${fit(state.status.text, width)}${RESET}` : "");
  lines.push(footerLine(width));

  const frame = lines.slice(0, height);
  if (state.modal) return stampModal(frame, state.modal, width, height);
  return "\x1b[H\x1b[2J" + frame.join("\r\n");
}

const GLYPHS = {
  working: `${GREEN}●${RESET}`,
  blocked: `${MAGENTA}◆${RESET}`,
  done: `${DIM}✓${RESET}`,
  idle: `${CYAN}○${RESET}`,
};

function renderRow(row, index, state, disk, width) {
  const selected = index === state.sel;
  const cursor = selected ? "❯" : " ";
  const indent = "  ".repeat(row.depth);

  if (row.kind === "pane") {
    const p = row.pane;
    let glyph = " ";
    if (p.isOrphan) glyph = `${YELLOW}□${RESET}`;
    else if (p.isAgent) glyph = GLYPHS[p.agentStatus] ?? GLYPHS.idle;
    const counts = p.isAgent ? `${p.agent ?? "agent"} ` : "";
    const label = `${cursor} ${indent}${glyph} ${counts}${row.label}`;
    if (!p.metrics) {
      return `${fit(label, width - 22)}${right("—", 6)}${right("—", 9)}${right("", 13)}`;
    }
    const samples = state.history?.get(`${state.keyPrefix ?? "local|"}${p.pane_id}`) ?? [];
    const sparkPart = `${DIM}${sparkline(samples, SPARK_W)}${RESET}`;
    const focus = p.focused ? " ▸" : "  ";
    const fixed = 6 + 2 + 9 + 2 + SPARK_W + 1 + 2;
    return `${fit(label, width - fixed)}${right(formatCpu(p.metrics.cpu), 6)}  ${right(formatMem(p.metrics.rssBytes), 9)}  ${sparkPart}${focus}`;
  }

  // repo / workspace rows aggregate
  const glyph = row.collapsed ? "▸" : "▾";
  let extra = "";
  if (row.kind === "workspace" && row.ws.path) {
    const size = disk?.get(row.ws.path)?.bytes ?? null;
    if (size) extra += ` ${DIM}(${formatMem(size)})${RESET}`;
    if (row.ws.branch) extra += ` ${DIM}${row.ws.branch}${RESET}`;
  }
  const label = `${cursor} ${indent}${glyph} ${row.label}${extra}`;
  const counts = `${DIM}${right(`${row.agentCount}/${row.paneCount}`, 5)}${RESET}`;
  const fixed = 5 + 2 + 6 + 2 + 9 + 2;
  return `${fit(label, width - fixed)}${right(formatCpu(row.cpu), 6)}  ${right(formatMem(row.mem), 9)}  ${counts}`;
}

function footerLine(width) {
  const hints =
    "↑↓/jk move · ⏎/f focus · x close pane · c cleanup · s sort · m machine · a annotate · d rescan · ? help · q quit";
  return `${DIM}${fit(hints, width)}${RESET}`;
}

// ─── Modals ─────────────────────────────────────────────────────────

export function renderModal(modal, width) {
  const inner = Math.min(72, Math.max(16, width - 8));
  const border = "─".repeat(inner);
  const lines = [`┌${border}┐`];
  for (const line of modal.lines) {
    lines.push(`│ ${fit(line, inner - 2)} │`);
  }
  lines.push(`└${border}┘`);
  return lines.map((l) => `${BOLD}${l}${RESET}`).join("\r\n");
}

export function confirmModal(title, detail) {
  return {
    kind: "confirm",
    lines: [title, detail, "", "y confirm · n/esc cancel"].filter((l) => l !== undefined),
  };
}

export function cleanupModal(model) {
  const t = model.totals;
  return {
    kind: "cleanup",
    lines: [
      "Clean up",
      "",
      `o  close ${t.orphanCount} idle shell pane${t.orphanCount === 1 ? "" : "s"} (no agent at the prompt; jobs in them end too)`,
      `f  close ${t.finishedCount} finished agent pane${t.finishedCount === 1 ? "" : "s"} (agent status done)`,
      "",
      "esc back",
    ],
  };
}

export function helpModal() {
  return {
    kind: "help",
    lines: [
      "Keys",
      "",
      "↑↓ / j k   move selection        g G   top / bottom",
      "⏎ / f      focus pane in Herdr   h l / ←→   collapse / expand",
      "x          close pane (confirm)  K     close finished agents",
      "c          cleanup actions       w     close workspace",
      "D          remove worktree       s     sort (name/cpu/mem)",
      "m          switch machine        a     sidebar memory tokens",
      "d          rescan disk           r     refresh now",
      "q          quit",
      "",
      "esc back",
    ],
  };
}

/** Stamp the modal box centered over the frame. */
function stampModal(lines, modal, width, height) {
  const box = renderModal(modal, width).split("\r\n");
  const top = Math.max(0, Math.floor((height - box.length) / 2));
  const merged = [...lines];
  while (merged.length < top + box.length) merged.push("");
  for (let r = 0; r < box.length; r++) merged[top + r] = box[r];
  return "\x1b[H\x1b[2J" + merged.slice(0, height).join("\r\n");
}
