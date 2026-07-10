import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const patchScript = path.resolve(here, "../scripts/patch-gpt56-max.cjs");

function fixture(version = "2026.6.11") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gpt56-max-patch-"));
  const dist = path.join(root, "dist");
  fs.mkdirSync(dist);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version }));
  fs.writeFileSync(path.join(dist, "sanitize-unicode-fixture.js"), `
function getSupportedThinkingLevels(model) {
\tconst fableContract = model.api === "anthropic-messages" && resolveClaudeFable5ModelIdentity(model) !== void 0;
\tif (!model.reasoning && !fableContract) return ["off"];
\tconst thinkingLevelMap = resolveThinkingLevelMap(model);
\treturn EXTENDED_THINKING_LEVELS.filter((level) => {
\t\tconst mapped = thinkingLevelMap?.[level];
\t\tif (mapped === null) return false;
\t\tif (level === "xhigh" || level === "max") return mapped !== void 0;
\t\treturn true;
\t});
}
`);
  fs.writeFileSync(path.join(dist, "openai-chatgpt-responses-fixture.js"), `
const streamSimpleOpenAICodexResponses = (model, context, options) => {
\tconst clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : void 0;
\tconst reasoningEffort = clampedReasoning === "off" ? void 0 : clampedReasoning === "max" ? "xhigh" : clampedReasoning;
};
`);
  return root;
}

test("patches GPT-5.6 max capability and transport idempotently", () => {
  const root = fixture();
  const first = spawnSync(process.execPath, [patchScript, root], { encoding: "utf8" });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /patched files=2/);

  const second = spawnSync(process.execPath, [patchScript, root], { encoding: "utf8" });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /patched files=0/);

  const thinking = fs.readFileSync(path.join(root, "dist/sanitize-unicode-fixture.js"), "utf8");
  const transport = fs.readFileSync(path.join(root, "dist/openai-chatgpt-responses-fixture.js"), "utf8");
  assert.match(thinking, /gpt56MaxContract/);
  assert.match(transport, /supportsGpt56Max/);
  assert.match(transport, /clampedReasoning === "max" && !supportsGpt56Max/);
});

test("fails closed for an unreviewed OpenClaw version", () => {
  const root = fixture("2026.6.12");
  const result = spawnSync(process.execPath, [patchScript, root], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /version 2026\.6\.12 is not reviewed/);
});
