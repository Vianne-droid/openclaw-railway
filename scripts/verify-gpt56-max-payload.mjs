#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const moduleDir = process.argv[2];
if (!moduleDir) throw new Error("usage: verify-gpt56-max-payload.mjs <openclaw-module-dir>");

const distDir = path.join(moduleDir, "dist");
const version = JSON.parse(fs.readFileSync(path.join(moduleDir, "package.json"), "utf8")).version;

if (version === "2026.7.1") {
  const policies = fs.readdirSync(distDir)
    .filter((name) => /^thinking-policy-.*\.js$/.test(name))
    .filter((name) => fs.readFileSync(path.join(distDir, name), "utf8").includes("function buildOpenAIThinkingProfile(params)"));
  if (policies.length === 0) throw new Error("native OpenAI thinking policy not found");

  for (const policy of policies) {
    const policyUrl = `${pathToFileURL(path.join(distDir, policy)).href}?verify=${Date.now()}`;
    const { t: resolveOpenAICodexThinkingProfile } = await import(policyUrl);
    if (typeof resolveOpenAICodexThinkingProfile !== "function") {
      throw new Error(`native Codex thinking resolver missing from ${policy}`);
    }
    const sol = resolveOpenAICodexThinkingProfile("gpt-5.6-sol", "codex");
    const terra = resolveOpenAICodexThinkingProfile("gpt-5.6-terra", "codex");
    const luna = resolveOpenAICodexThinkingProfile("gpt-5.6-luna", "codex");
    const ids = (profile) => profile.levels.map((level) => level.id);
    if (!ids(sol).includes("max") || !ids(sol).includes("ultra")) throw new Error(`${policy} rejects Sol max/ultra`);
    if (!ids(terra).includes("max") || !ids(terra).includes("ultra")) throw new Error(`${policy} rejects Terra max/ultra`);
    if (!ids(luna).includes("max")) throw new Error(`${policy} rejects Luna max`);
  }

  const runtimes = fs.readdirSync(distDir)
    .filter((name) => /^simple-completion-runtime-.*\.js$/.test(name))
    .filter((name) => fs.readFileSync(path.join(distDir, name), "utf8")
      .includes('supportsOpenAIReasoningEffort(model, "max") ? "max" : "xhigh"'));
  if (runtimes.length === 0) throw new Error("native GPT-5.6 max transport not found");
  console.log("GPT56_NATIVE_SUPPORT_OK sol=max+ultra terra=max+ultra luna=max transport=model-gated-max");
  process.exit(0);
}

if (version !== "2026.6.11") {
  throw new Error(`version ${version} is not reviewed; expected 2026.6.11 or 2026.7.1`);
}

const transports = fs.readdirSync(distDir).filter((name) => /^openai-chatgpt-responses-.*\.js$/.test(name));
if (transports.length !== 1) throw new Error(`expected one Codex transport, found ${transports.length}`);
const thinkingProfiles = fs.readdirSync(distDir)
  .filter((name) => /^thinking-.*\.js$/.test(name))
  .filter((name) => fs.readFileSync(path.join(distDir, name), "utf8").includes("function isThinkingLevelSupported(params)"));
if (thinkingProfiles.length !== 1) throw new Error(`expected one gateway thinking profile, found ${thinkingProfiles.length}`);

let capturedBody;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (_url, init) => {
  capturedBody = JSON.parse(String(init?.body ?? "{}"));
  return new Response(JSON.stringify({ error: { message: "verification stop" } }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
};

try {
  const thinkingUrl = `${pathToFileURL(path.join(distDir, thinkingProfiles[0])).href}?verify=${Date.now()}`;
  const { n: isThinkingLevelSupported } = await import(thinkingUrl);
  if (!isThinkingLevelSupported({ provider: "openai", model: "gpt-5.6-sol", level: "max" })) {
    throw new Error("gateway thinking profile rejects GPT-5.6 max");
  }

  const transportUrl = `${pathToFileURL(path.join(distDir, transports[0])).href}?verify=${Date.now()}`;
  const { streamSimpleOpenAICodexResponses } = await import(transportUrl);
  const fakeClaims = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "verification-account" },
  })).toString("base64url");
  streamSimpleOpenAICodexResponses(
    {
      id: "gpt-5.6-sol",
      name: "GPT-5.6 Sol",
      provider: "openai",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 372000,
      maxTokens: 128000,
    },
    { systemPrompt: "Verification only.", messages: [] },
    {
      apiKey: `e30.${fakeClaims}.signature`,
      reasoning: "max",
      timeoutMs: 1000,
      transport: "sse",
    },
  );

  const deadline = Date.now() + 3000;
  while (!capturedBody && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!capturedBody) throw new Error("transport did not issue a request");
  if (capturedBody.model !== "gpt-5.6-sol") throw new Error(`unexpected model: ${capturedBody.model}`);
  if (capturedBody.reasoning?.effort !== "max") {
    throw new Error(`expected outbound reasoning.effort=max, got ${capturedBody.reasoning?.effort ?? "unset"}`);
  }
  console.log("GPT56_MAX_PAYLOAD_OK gateway=max model=gpt-5.6-sol reasoning.effort=max");
} finally {
  globalThis.fetch = originalFetch;
}
