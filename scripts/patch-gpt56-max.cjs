#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const LEGACY_PATCH_VERSION = "2026.6.11";
const NATIVE_SUPPORT_VERSION = "2026.7.1";
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

function findSingleContaining(distDir, pattern, anchor, label) {
  const matches = fs.readdirSync(distDir)
    .filter((name) => pattern.test(name))
    .map((name) => path.join(distDir, name))
    .filter((file) => fs.readFileSync(file, "utf8").includes(anchor));
  if (matches.length !== 1) {
    fail(`expected exactly one ${label} file in ${distDir}, found ${matches.length}`);
  }
  return matches[0];
}

function findAllContaining(distDir, pattern, anchor, label) {
  const matches = fs.readdirSync(distDir)
    .filter((name) => pattern.test(name))
    .map((name) => path.join(distDir, name))
    .filter((file) => fs.readFileSync(file, "utf8").includes(anchor));
  if (matches.length === 0) fail(`expected at least one ${label} file in ${distDir}, found 0`);
  return matches;
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

function patchGatewayThinkingProfile(file) {
  const before = fs.readFileSync(file, "utf8");
  if (before.includes(`${MARKER}:gateway-profile-v2`)) return false;

  const pluginFrom = `\tif (pluginProfile) {
\t\tconst normalized = normalizeThinkingProfile(pluginProfile);
\t\tif (normalized.levels.length > 0 && (context.reasoning !== false || pluginProfile.preserveWhenCatalogReasoningFalse === true)) return normalized;
\t}`;
  const pluginTo = `\tif (pluginProfile) {
\t\tconst normalized = normalizeThinkingProfile(pluginProfile);
\t\tif (normalized.levels.length > 0 && (context.reasoning !== false || pluginProfile.preserveWhenCatalogReasoningFalse === true)) {
\t\t\tconst supportsGpt56Max = context.normalizedProvider === "openai" && /^gpt-5\\.6(?:-|$)/i.test(context.modelId); /* ${MARKER}:gateway-profile-v2 */
\t\t\tif (supportsGpt56Max) {
\t\t\t\tappendProfileLevel(normalized, "xhigh");
\t\t\t\tappendProfileLevel(normalized, "max");
\t\t\t}
\t\t\treturn normalized;
\t\t}
\t}`;
  let after = replaceOnce(before, pluginFrom, pluginTo, "gateway plugin thinking profile", file);

  if (!after.includes(`/* ${MARKER}:gateway-profile */`)) {
    const fallbackFrom = `\tconst profile = binaryDecision === true ? buildBinaryThinkingProfile(defaultLevel) : buildBaseThinkingProfile(defaultLevel);
\tif (binaryDecision !== true && catalogSupportsXHigh(context.compat)) appendProfileLevel(profile, "xhigh");`;
    const fallbackTo = `\tconst profile = binaryDecision === true ? buildBinaryThinkingProfile(defaultLevel) : buildBaseThinkingProfile(defaultLevel);
\tconst supportsGpt56Max = context.normalizedProvider === "openai" && /^gpt-5\\.6(?:-|$)/i.test(context.modelId); /* ${MARKER}:gateway-profile */
\tif (binaryDecision !== true && supportsGpt56Max) {
\t\tappendProfileLevel(profile, "xhigh");
\t\tappendProfileLevel(profile, "max");
\t}
\tif (binaryDecision !== true && catalogSupportsXHigh(context.compat)) appendProfileLevel(profile, "xhigh");`;
    after = replaceOnce(after, fallbackFrom, fallbackTo, "gateway fallback thinking profile", file);
  }

  fs.writeFileSync(file, after);
  return true;
}

function verify(thinkingFile, transportFile, gatewayThinkingFile) {
  const thinking = fs.readFileSync(thinkingFile, "utf8");
  const transport = fs.readFileSync(transportFile, "utf8");
  const gatewayThinking = fs.readFileSync(gatewayThinkingFile, "utf8");
  if (!thinking.includes(`${MARKER}:capabilities`)) fail(`capability patch missing from ${thinkingFile}`);
  if (!thinking.includes(`gpt56MaxContract) return true`)) fail(`GPT-5.6 xhigh/max exposure missing from ${thinkingFile}`);
  if (!transport.includes(`${MARKER}:transport`)) fail(`transport patch missing from ${transportFile}`);
  if (!transport.includes(`clampedReasoning === "max" && !supportsGpt56Max ? "xhigh" : clampedReasoning`)) {
    fail(`model-gated max pass-through missing from ${transportFile}`);
  }
  if (!gatewayThinking.includes(`${MARKER}:gateway-profile-v2`)) {
    fail(`gateway thinking profile patch missing from ${gatewayThinkingFile}`);
  }
  if (!gatewayThinking.includes(`appendProfileLevel(profile, "max")`)) {
    fail(`GPT-5.6 max gateway entitlement missing from ${gatewayThinkingFile}`);
  }
}

function verifyNativeSupport(distDir) {
  const policyFiles = findAllContaining(
    distDir,
    /^thinking-policy-.*\.js$/,
    "function buildOpenAIThinkingProfile(params)",
    "native OpenAI thinking policy",
  );
  const runtimeFiles = findAllContaining(
    distDir,
    /^simple-completion-runtime-.*\.js$/,
    'supportsOpenAIReasoningEffort(model, "max") ? "max" : "xhigh"',
    "native simple-completion max transport",
  );

  for (const file of policyFiles) {
    const content = fs.readFileSync(file, "utf8");
    for (const anchor of [
      'const isSol = modelId === "gpt-5.6-sol"',
      'const isTerra = modelId === "gpt-5.6-terra"',
      'const isLuna = modelId === "gpt-5.6-luna"',
      'authoritativeCodexEfforts.includes("max") : isSol || isTerra || isLuna',
      'supportsMax ? [{ id: "max" }] : []',
    ]) {
      if (!content.includes(anchor)) fail(`native GPT-5.6 max anchor missing from ${file}: ${anchor}`);
    }
  }
  for (const file of runtimeFiles) {
    const content = fs.readFileSync(file, "utf8");
    if (!content.includes('case "max": return isOpenAIProvider(model.provider)')) {
      fail(`native model-gated max pass-through missing from ${file}`);
    }
  }
}

function main() {
  const moduleDir = process.argv[2];
  if (!moduleDir) fail("usage: patch-gpt56-max.cjs <openclaw-module-dir>");

  const packageFile = path.join(moduleDir, "package.json");
  const distDir = path.join(moduleDir, "dist");
  if (!fs.existsSync(packageFile) || !fs.existsSync(distDir)) fail(`invalid OpenClaw module directory: ${moduleDir}`);

  const version = JSON.parse(fs.readFileSync(packageFile, "utf8")).version;
  if (version === NATIVE_SUPPORT_VERSION) {
    verifyNativeSupport(distDir);
    console.log(`[gpt56-max] verified native support in OpenClaw ${version}; patched files=0`);
    return;
  }
  if (version !== LEGACY_PATCH_VERSION) {
    fail(`version ${version} is not reviewed; expected ${LEGACY_PATCH_VERSION} or ${NATIVE_SUPPORT_VERSION}`);
  }

  const thinkingFile = findSingle(distDir, /^sanitize-unicode-.*\.js$/, "thinking capability");
  const transportFile = findSingle(distDir, /^openai-chatgpt-responses-.*\.js$/, "Codex transport");
  const gatewayThinkingFile = findSingleContaining(
    distDir,
    /^thinking-.*\.js$/,
    "const profile = binaryDecision === true ? buildBinaryThinkingProfile",
    "gateway thinking profile",
  );
  const changed = [
    patchThinkingLevels(thinkingFile),
    patchCodexTransport(transportFile),
    patchGatewayThinkingProfile(gatewayThinkingFile),
  ].filter(Boolean).length;
  verify(thinkingFile, transportFile, gatewayThinkingFile);
  console.log(`[gpt56-max] verified OpenClaw ${version}; patched files=${changed}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
