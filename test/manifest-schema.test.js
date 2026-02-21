import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import askpi from "../index.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.resolve(__dirname, "..", "clawdbot.plugin.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

test("manifest schema keys align with validator", () => {
  const properties = manifest?.configSchema?.properties ?? {};
  const required = manifest?.configSchema?.required ?? [];

  const manifestKeys = Object.keys(properties).sort();
  const validatorKeys = Array.from(askpi.configSchema.allowedKeys).sort();

  assert.deepEqual(
    manifestKeys,
    validatorKeys,
    "manifest configSchema properties must match validator allowed keys",
  );

  const manifestRequired = Array.from(required).sort();
  const validatorRequired = Array.from(askpi.configSchema.requiredKeys).sort();

  assert.deepEqual(
    manifestRequired,
    validatorRequired,
    "manifest configSchema required keys must match validator required keys",
  );
});
