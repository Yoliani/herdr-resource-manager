import { readFileSync } from "node:fs";
import { join } from "node:path";

const PREFIX = "HERDR_RESOURCE_MANAGER_";
const DEFAULTS = { intervalMs: 2000, machine: null, annotate: false, sort: "mem" };

function parseConfigEnv(text) {
  const values = {};
  for (const line of (text ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    values[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return values;
}

/**
 * Config precedence: built-in defaults < HERDR_PLUGIN_CONFIG_DIR/config.env
 * < HERDR_RESOURCE_MANAGER_* environment variables.
 */
export function loadConfig({ env = process.env } = {}) {
  const file = parseConfigEnv(readConfigEnv(env.HERDR_PLUGIN_CONFIG_DIR));
  const pick = (key) => {
    const fromEnv = env[PREFIX + key];
    return fromEnv !== undefined && fromEnv !== "" ? fromEnv : file[key];
  };

  const intervalRaw = Number(pick("INTERVAL_MS"));
  const intervalMs = Number.isFinite(intervalRaw) ? Math.max(500, intervalRaw) : DEFAULTS.intervalMs;
  const machine = pick("MACHINE") ?? DEFAULTS.machine;
  const annotate = (pick("ANNOTATE") ?? "").toLowerCase() === "true";
  const sortRaw = (pick("SORT") ?? DEFAULTS.sort).toLowerCase();
  const sort = ["name", "cpu", "mem"].includes(sortRaw) ? sortRaw : DEFAULTS.sort;

  return { intervalMs, machine: machine || null, annotate, sort };
}

function readConfigEnv(dir) {
  if (!dir) return null;
  try {
    return readFileSync(join(dir, "config.env"), "utf8");
  } catch {
    return null;
  }
}
