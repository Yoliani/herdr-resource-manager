#!/usr/bin/env node
// Action handler for herdr.resource-manager.open — opens the board pane.
import { spawnSync } from "node:child_process";
import { loadConfig } from "../lib/config.js";

const config = loadConfig();
const herdr = process.env.HERDR_BIN_PATH ?? "herdr";
const args = [
  "plugin",
  "pane",
  "open",
  "--plugin",
  "herdr.resource-manager",
  "--entrypoint",
  "manager",
];
// Forward the configured machine scope so the board opens against it.
if (config.machine) {
  args.push("--env", `HERDR_RESOURCE_MANAGER_MACHINE=${config.machine}`);
}

const res = spawnSync(herdr, args, {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 15_000,
});
process.stdout.write(res.stdout ?? "");
process.stderr.write(res.stderr ?? "");
process.exit(res.status ?? 1);
