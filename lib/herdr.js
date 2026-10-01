import { spawnSync } from "node:child_process";

/**
 * Thin wrapper over the herdr CLI — the plugin's whole API surface.
 * call() returns { ok, status, stdout, stderr, json } without throwing;
 * result() unwraps the result envelope (null on failure).
 */
export function call(args, { machine = null } = {}) {
  const argv = machine ? [...args, "--machine", machine] : [...args];
  const res = spawnSync(process.env.HERDR_BIN_PATH ?? "herdr", argv, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
    env: process.env,
  });
  const status = res.status ?? 1;
  const stdout = res.stdout ?? "";
  const stderr = res.stderr ?? "";
  let json = null;
  const trimmed = stdout.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      json = JSON.parse(trimmed);
    } catch {
      json = null;
    }
  }
  return { ok: status === 0, status, stdout, stderr, json };
}

/** Unwrap the result envelope; null when the call failed. */
export function result(args, opts = {}) {
  const res = call(args, opts);
  return res.ok ? res.json?.result ?? null : null;
}

/** Extract the JSON error code from a failed call, for diagnostics. */
export function errorCode(res) {
  return (
    res.json?.error?.code ??
    (() => {
      try {
        return JSON.parse(res.stderr)?.error?.code ?? null;
      } catch {
        return null;
      }
    })()
  );
}
