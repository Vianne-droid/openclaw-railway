#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const SUPPORTED_OPENCLAW_VERSION = "2026.6.11";
const MARKER = "vianne-gpt56-max";

function fail(message) {
  throw new Error(`[gpt56-max] ${message}`);
}

function findSingle(distDir, pattern, label) {
  const matches = fs.readdirSync(distDir)
    .filter((name) => pattern.test(name))
    .map((name) => path.join(distDir, name));
  if (matches.length !== 1) {
    fail(`expected exactly one ${label} file in ${distDir}, found ${matches.length}`);
  }
  return matches[0];
}

function replaceOnce(content, from, to, label, file) {
  const count = content.split(from).length - 1;
  if (count !== 1) fail(`expected one ${label} anchor in ${file}, found ${count}`);
  return content.replace(from, to);
}

function patchThinkingLevels(file) {
  const before = fs.readFileSync(file, "utf8");
  if (before.includes(`${MARKER}:capabilities`)) return false;

  const from = `function getSupportedThinkingLevels(model) {
\tconst fableContract = model.api === "anthropic-messages" && resolveClaudeFable5ModelIdentity(model) !== void 0;
\tif (!model.reasoning && !fableContract) return ["off"];
\tconst thinkingLevelMap = resolveThinkingLevelMap(model);
\treturn EXTENDED_THINKING_LEVELS.filter((level) => {
\t\tconst mapped = thinkingLevelMap?.[level];
\t\tif (mapped === null) return false;
\t\tif (level === "xhigh" || level === "max") return mapped !== void 0;`;
  const to = `function getSupportedThinkingLevels(model) {
\tconst fableContract = model.api === "anthropic-messages" && resolveClaudeFable5ModelIdentity(model) !== void 0;
\tconst gpt56MaxContract = model.provider === "openai" && model.api === "openai-chatgpt-responses" && /^gpt-5\\.6(?:-|$)/i.test(model.id); /* ${MARKER}:capabilities */
\tif (!model.reasoning && !fableContract && !gpt56MaxContract) return ["off"];
\tconst thinkingLevelMap = resolveThinkingLevelMap(model);
\treturn EXTENDED_THINKING_LEVELS.filter((level) => {
\t\tconst mapped = thinkingLevelMap?.[level];
\t\tif (mapped === null) return false;
\t\tif ((level === "xhigh" || level === "max") && gpt56MaxContract) return true;
\t\tif (level === "xhigh" || level === "max") return mapped !== void 0;`;

  fs.writeFileSync(file, replaceOnce(before, from, to, "thinking capability", file));
  return true;
}

function patchCodexTransport(file) {
  const before = fs.readFileSync(file, "utf8");
  if (before.includes(`${MARKER}:transport`)) return false;

  const from = `\tconst reasoningEffort = clampedReasoning === "off" ? void 0 : clampedReasoning === "max" ? "xhigh" : clampedReasoning;`;
  const to = `\tconst supportsGpt56Max = model.provider === "openai" && model.api === "openai-chatgpt-responses" && /^gpt-5\\.6(?:-|$)/i.test(model.id); /* ${MARKER}:transport */
\tconst reasoningEffort = clampedReasoning === "off" ? void 0 : clampedReasoning === "max" && !supportsGpt56Max ? "xhigh" : clampedReasoning;`;

  fs.writeFileSync(file, replaceOnce(before, from, to, "Codex max transport", file));
  return true;
}

function verify(thinkingFile, transportFile) {
  const thinking = fs.readFileSync(thinkingFile, "utf8");
  const transport = fs.readFileSync(transportFile, "utf8");
  if (!thinking.includes(`${MARKER}:capabilities`)) fail(`capability patch missing from ${thinkingFile}`);
  if (!thinking.includes(`gpt56MaxContract) return true`)) fail(`GPT-5.6 xhigh/max exposure missing from ${thinkingFile}`);
  if (!transport.includes(`${MARKER}:transport`)) fail(`transport patch missing from ${transportFile}`);
  if (!transport.includes(`clampedReasoning === "max" && !supportsGpt56Max ? "xhigh" : clampedReasoning`)) {
    fail(`model-gated max pass-through missing from ${transportFile}`);
  }
}

function main() {
  const moduleDir = process.argv[2];
  if (!moduleDir) fail("usage: patch-gpt56-max.cjs <openclaw-module-dir>");

  const packageFile = path.join(moduleDir, "package.json");
  const distDir = path.join(moduleDir, "dist");
  if (!fs.existsSync(packageFile) || !fs.existsSync(distDir)) fail(`invalid OpenClaw module directory: ${moduleDir}`);

  const version = JSON.parse(fs.readFileSync(packageFile, "utf8")).version;
  if (version !== SUPPORTED_OPENCLAW_VERSION) {
    fail(`version ${version} is not reviewed; expected ${SUPPORTED_OPENCLAW_VERSION}`);
  }

  const thinkingFile = findSingle(distDir, /^sanitize-unicode-.*\.js$/, "thinking capability");
  const transportFile = findSingle(distDir, /^openai-chatgpt-responses-.*\.js$/, "Codex transport");
  const changed = [patchThinkingLevels(thinkingFile), patchCodexTransport(transportFile)].filter(Boolean).length;
  verify(thinkingFile, transportFile);
  console.log(`[gpt56-max] verified OpenClaw ${version}; patched files=${changed}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
