#!/usr/bin/env node
// Machine-readable snapshot of the resource model. Exits nonzero when the
// Herdr inventory cannot be fetched — an empty success would lie.
import { loadConfig } from "../lib/config.js";
import { collect } from "../lib/model.js";

const config = loadConfig();
const model = await collect({ machine: config.machine });

if (model.errors?.length) {
  process.stderr.write(
    `herdr-resource-manager: inventory unavailable: ${model.errors.join("; ")}\n`
  );
  process.exit(1);
}

process.stdout.write(JSON.stringify(model, null, 2) + "\n");
