import { test } from "node:test";
import assert from "node:assert/strict";
import { buildModel } from "../lib/model.js";
import { formatCpu, formatMem, formatMemShort, sparkline, parsePsLine } from "../lib/metrics.js";
import { loadConfig } from "../lib/config.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  { pane_id: "w2:p2", workspace_id: "w2", tab_id: "w2:t2", agent_status: "unknown",
    foreground_cwd: "/w/plugin", terminal_title_stripped: "Tool", focused: false },
];
const processInfo = new Map([
  ["w1:p1", { shell_pid: 100, foreground_process_group_id: 100 }],
  ["w1:p2", { shell_pid: 200, foreground_process_group_id: 200 }], // shell owns foreground → orphan
  ["w2:p1", { shell_pid: 300, foreground_process_group_id: 400 }],
  ["w2:p2", { shell_pid: 600, foreground_process_group_id: 600 }], // command exec'd as pane process
]);
const psRows = [
  { pid: 100, ppid: 1, pgid: 100, cpu: 1.5, rssBytes: 50 * 1024 * 1024, comm: "zsh" },
  { pid: 101, ppid: 100, pgid: 100, cpu: 12.25, rssBytes: 300 * 1024 * 1024, comm: "/usr/local/bin/node" },
  { pid: 200, ppid: 1, pgid: 200, cpu: 0, rssBytes: 10 * 1024 * 1024, comm: "zsh" },
  { pid: 300, ppid: 1, pgid: 300, cpu: 0.1, rssBytes: 8 * 1024 * 1024, comm: "zsh" },
  { pid: 400, ppid: 300, pgid: 400, cpu: 3.0, rssBytes: 150 * 1024 * 1024, comm: "claude" },
  { pid: 500, ppid: 1, pgid: 500, cpu: 2.0, rssBytes: 42 * 1024 * 1024, comm: "/opt/herdr/bin/herdr-server" },
  { pid: 600, ppid: 1, pgid: 600, cpu: 0.2, rssBytes: 49 * 1024 * 1024, comm: "node" },
];
const repoByWorkspace = new Map([
  ["w1", { repo: "/w/my-dropplets", branch: "main", path: "/w/my-dropplets", source: "git" }],
  ["w2", { repo: "/w/my-dropplets", branch: "feat", path: "/w/bs", source: "herdr" }],
]);

test("buildModel aggregates pane metrics from shell pid plus foreground process group", () => {
  const model = buildModel({ workspaces: ws, panes, processInfoByPane: processInfo, psRows, repoByWorkspace });
  const pi = model.panes.find((p) => p.pane_id === "w1:p1");
  assert.equal(pi.metrics.cpu, 13.75);
  assert.equal(pi.metrics.rssBytes, 350 * 1024 * 1024);
  assert.equal(pi.metrics.processCount, 2);
  assert.equal(pi.metrics.topProcess, "node");
  assert.equal(pi.title, "π - my-dropplets");
});

test("does not double-count the shell when pgid equals shell pid", () => {
  const model = buildModel({ workspaces: ws, panes, processInfoByPane: processInfo, psRows, repoByWorkspace });
  const shell = model.panes.find((p) => p.pane_id === "w1:p2");
  assert.equal(shell.metrics.processCount, 1);
});

test("buildModel groups workspaces of the same repo together", () => {
  const model = buildModel({ workspaces: ws, panes, processInfoByPane: processInfo, psRows, repoByWorkspace });
  assert.equal(model.repos.length, 1);
  assert.equal(model.repos[0].workspaces.length, 2);
  assert.equal(model.repos[0].workspaces[0].branch, "main");
});

test("buildModel flags orphan and finished panes", () => {
  const model = buildModel({ workspaces: ws, panes, processInfoByPane: processInfo, psRows, repoByWorkspace });
  assert.deepEqual(model.orphans.map((p) => p.pane_id), ["w1:p2"]);
  assert.deepEqual(model.finished.map((p) => p.pane_id), ["w2:p1"]);
  assert.equal(model.totals.orphanCount, 1);
  assert.equal(model.totals.finishedCount, 1);
  assert.equal(model.totals.agentCount, 2);
});

test("a command exec'd as the pane process is not an orphan", () => {
  const model = buildModel({ workspaces: ws, panes, processInfoByPane: processInfo, psRows, repoByWorkspace });
  const tool = model.panes.find((p) => p.pane_id === "w2:p2");
  assert.equal(tool.isOrphan, false);
  assert.equal(tool.title, "node · plugin");
});

test("buildModel sums totals across panes with metrics", () => {
  const model = buildModel({ workspaces: ws, panes, processInfoByPane: processInfo, psRows, repoByWorkspace });
  assert.equal(model.totals.paneCount, 4);
  assert.ok(model.totals.memBytes > 0);
});

test("formatters", () => {
  assert.equal(formatCpu(12.25), "12.3%");
  assert.equal(formatCpu(null), "—");
  assert.equal(formatMem(720 * 1024), "720 KB");
  assert.equal(formatMem(49.2 * 1024 * 1024), "49.2 MB");
  assert.equal(formatMem(1.5 * 1024 ** 3), "1.5 GB");
  assert.equal(formatMemShort(704 * 1024), "704K");
  assert.equal(formatMemShort(49.2 * 1024 * 1024), "49.2M");
});

test("sparkline maps samples to blocks and pads short series", () => {
  assert.equal(sparkline([], 4), "▁▁▁▁");
  assert.equal(sparkline([50, 5], 4), "▁▁█▁");
  const wide = sparkline([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 6);
  assert.equal(wide.length, 6);
  assert.equal(wide.endsWith("█"), true);
});

test("parsePsLine reads a real ps line shape", () => {
  const row = parsePsLine("  1234     1  1234   0.5   4992 /usr/local/bin/node");
  assert.equal(row.pid, 1234);
  assert.equal(row.ppid, 1);
  assert.equal(row.pgid, 1234);
  assert.equal(row.cpu, 0.5);
  assert.equal(row.rssBytes, 4992 * 1024);
  assert.equal(row.comm, "/usr/local/bin/node");
  assert.equal(parsePsLine(""), null);
});

test("config: defaults, config.env file, env overrides", () => {
  const defaults = loadConfig({ env: {} });
  assert.equal(defaults.intervalMs, 2000);
  assert.equal(defaults.sort, "mem");
  assert.equal(defaults.annotate, false);
  assert.equal(defaults.machine, null);

  const dir = mkdtempSync(join(tmpdir(), "rm-config-"));
  writeFileSync(join(dir, "config.env"), "INTERVAL_MS=1000\nSORT=cpu\nMACHINE=box\n");
  const fromFile = loadConfig({ env: { HERDR_PLUGIN_CONFIG_DIR: dir } });
  assert.equal(fromFile.intervalMs, 1000);
  assert.equal(fromFile.sort, "cpu");
  assert.equal(fromFile.machine, "box");

  const fromEnv = loadConfig({
    env: {
      HERDR_PLUGIN_CONFIG_DIR: dir,
      HERDR_RESOURCE_MANAGER_INTERVAL_MS: "750",
      HERDR_RESOURCE_MANAGER_SORT: "name",
      HERDR_RESOURCE_MANAGER_ANNOTATE: "true",
    },
  });
  assert.equal(fromEnv.intervalMs, 750);
  assert.equal(fromEnv.sort, "name");
  assert.equal(fromEnv.annotate, true);

  // Sub-minimum intervals clamp to 500.
  const clamped = loadConfig({ env: { HERDR_RESOURCE_MANAGER_INTERVAL_MS: "50" } });
  assert.equal(clamped.intervalMs, 500);
});
