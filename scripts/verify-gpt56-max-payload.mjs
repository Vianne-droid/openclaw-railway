#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const moduleDir = process.argv[2];
if (!moduleDir) throw new Error("usage: verify-gpt56-max-payload.mjs <openclaw-module-dir>");

const distDir = path.join(moduleDir, "dist");
const transports = fs.readdirSync(distDir).filter((name) => /^openai-chatgpt-responses-.*\.js$/.test(name));
if (transports.length !== 1) throw new Error(`expected one Codex transport, found ${transports.length}`);

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
  console.log("GPT56_MAX_PAYLOAD_OK model=gpt-5.6-sol reasoning.effort=max");
} finally {
  globalThis.fetch = originalFetch;
}
