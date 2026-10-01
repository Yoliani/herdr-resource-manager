import { test } from "node:test";
import assert from "node:assert/strict";
import { buildModel } from "../lib/model.js";
import { renderFrame, buildViewRows, visible } from "../lib/render.js";

const ws = [
  { workspace_id: "w1", label: "[1] my-dropplets", number: 1, pane_count: 2, agent_status: "working", focused: true },
  { workspace_id: "w2", label: "[2] browser-switcher", number: 2, pane_count: 1, agent_status: "idle", focused: false },
];
const panes = [
  { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", agent: "pi", agent_status: "working",
    foreground_cwd: "/w/my-dropplets", terminal_title_stripped: "π - my-dropplets", focused: true },
  { pane_id: "w1:p2", workspace_id: "w1", tab_id: "w1:t1", agent_status: "unknown",
    foreground_cwd: "/w/my-dropplets", terminal_title_stripped: "shell", focused: false },
  { pane_id: "w2:p1", workspace_id: "w2", tab_id: "w2:t1", agent: "claude", agent_status: "done",
    foreground_cwd: "/w/browser-switcher", terminal_title_stripped: "Claude Code", focused: false },
];
const processInfo = new Map([
  ["w1:p1", { shell_pid: 100, foreground_process_group_id: 100 }],
  ["w1:p2", { shell_pid: 200, foreground_process_group_id: 200 }],
  ["w2:p1", { shell_pid: 300, foreground_process_group_id: 400 }],
]);
const psRows = [
  { pid: 100, ppid: 1, pgid: 100, cpu: 1.5, rssBytes: 50 * 1024 * 1024, comm: "zsh" },
  { pid: 101, ppid: 100, pgid: 100, cpu: 12.25, rssBytes: 300 * 1024 * 1024, comm: "node" },
  { pid: 200, ppid: 1, pgid: 200, cpu: 0, rssBytes: 10 * 1024 * 1024, comm: "zsh" },
  { pid: 300, ppid: 1, pgid: 300, cpu: 0.1, rssBytes: 8 * 1024 * 1024, comm: "zsh" },
  { pid: 400, ppid: 300, pgid: 400, cpu: 3.0, rssBytes: 150 * 1024 * 1024, comm: "claude" },
];

function fixtureModel() {
  return buildModel({
    workspaces: ws,
    panes,
    processInfoByPane: processInfo,
    psRows,
    repoByWorkspace: new Map([
      ["w1", { repo: "/w/my-dropplets", branch: "main", path: "/w/my-dropplets", source: "git" }],
    ]),
  });
}

function baseState(width, height) {
  return {
    sort: "mem",
    collapsed: new Set(),
    sel: 0,
    scroll: 0,
    width,
    height,
    intervalMs: 2000,
    keyPrefix: "local|",
    history: new Map(),
    totalHistory: [100, 200, 150],
    modal: null,
    status: null,
  };
}

const SIZES = [
  [60, 24],
  [80, 56],
  [120, 40],
];

for (const [width, height] of SIZES) {
  test(`frame fits terminal bounds at ${width}x${height}`, () => {
    const frame = renderFrame(fixtureModel(), baseState(width, height));
    const lines = frame.split("\r\n");
    assert.ok(lines.length <= height, `line count ${lines.length} exceeds height ${height}`);
    for (const [i, line] of lines.entries()) {
      assert.ok(
        visible(line) <= width,
        `line ${i} is ${visible(line)} cells wide, exceeds ${width}: ${JSON.stringify(line)}`
      );
    }
  });

  test(`frame with help modal fits bounds at ${width}x${height}`, () => {
    const state = baseState(width, height);
    state.modal = { kind: "help", lines: ["Keys", "", "x close pane (confirm)"] };
    const frame = renderFrame(fixtureModel(), state);
    for (const [i, line] of frame.split("\r\n").entries()) {
      assert.ok(visible(line) <= width, `modal line ${i} exceeds ${width}`);
    }
  });
}

test("fetch failures render a banner instead of looking empty", () => {
  const model = fixtureModel();
  model.errors = ["pane list failed (connection refused)"];
  const frame = renderFrame(model, baseState(80, 24));
  assert.ok(frame.includes("pane list failed"), "error banner missing");
});

test("sorting by name orders panes alphabetically within each workspace", () => {
  const state = baseState(80, 24);
  state.sort = "name";
  const rows = buildViewRows(fixtureModel(), state);
  // Pane rows come grouped per workspace; each group must be sorted.
  const groups = [];
  let current = [];
  for (const row of rows) {
    if (row.kind === "pane") current.push(row.label);
    else if (current.length > 0) {
      groups.push(current);
      current = [];
    }
  }
  if (current.length > 0) groups.push(current);
  for (const group of groups) {
    assert.deepEqual(group, [...group].sort((a, b) => a.localeCompare(b)));
  }
  assert.ok(groups.length >= 2, "expected pane rows in the fixture");
});

test("collapse hides child rows", () => {
  const state = baseState(80, 24);
  state.collapsed.add("repo:/w/my-dropplets");
  const rows = buildViewRows(fixtureModel(), state);
  assert.ok(!rows.some((r) => r.id === "ws:w1"));
});

test("visible() counts East Asian wide characters as two cells", () => {
  assert.equal(visible("abc"), 3);
  assert.equal(visible("日本語"), 6);
  assert.equal(visible("\x1b[31m日本\x1b[0m"), 4);
});

test("a frame with CJK pane titles stays within terminal bounds", () => {
  const cjkPanels = panes.map((p) => ({
    ...p,
    terminal_title_stripped: `${p.agent ?? "shell"} · 日本語のプロジェクト`,
  }));
  const model = buildModel({
    workspaces: ws,
    panes: cjkPanels,
    processInfoByPane: processInfo,
    psRows,
    repoByWorkspace: new Map([
      ["w1", { repo: "/w/my-dropplets", branch: "main", path: "/w/my-dropplets", source: "git" }],
    ]),
  });
  const frame = renderFrame(model, baseState(60, 24));
  for (const [i, line] of frame.split("\r\n").entries()) {
    assert.ok(visible(line) <= 60, `CJK line ${i} exceeds 60 cells: ${visible(line)}`);
  }
});
