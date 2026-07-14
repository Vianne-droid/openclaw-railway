#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const client = path.join(here, "fast-native-hook-relay.mjs");
const uid = typeof process.getuid === "function" ? process.getuid() : "nouid";
const registryDir = path.join(tmpdir(), `openclaw-native-hook-relays-${uid}`);

function registryFile(relayId) {
  const key = createHash("sha256").update(relayId).digest("hex").slice(0, 32);
  return path.join(registryDir, `${key}.json`);
}

function runClient({ relayId, event, timeout = 1000, preMode, input = { ok: true } }) {
  const args = [
    client,
    "hooks",
    "relay",
    "--provider",
    "codex",
    "--relay-id",
    relayId,
    "--generation",
    "test-generation",
    "--event",
    event,
    "--timeout",
    String(timeout),
  ];
  if (preMode) args.push("--pre-tool-use-unavailable", preMode);

  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const child = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr, elapsedMs: performance.now() - startedAt }));
    child.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
  });
}

async function main() {
  mkdirSync(registryDir, { recursive: true, mode: 0o700 });
  chmodSync(registryDir, 0o700);

  const relayId = `fast-relay-test-${randomUUID()}`;
  const token = randomUUID();
  let observed;
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      observed = {
        authorization: req.headers.authorization,
        payload: JSON.parse(body),
      };
      const response = JSON.stringify({
        ok: true,
        result: { stdout: "bridge-ok\n", stderr: "", exitCode: 0 },
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(response);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");

  const liveRegistry = registryFile(relayId);
  writeFileSync(liveRegistry, `${JSON.stringify({
    version: 1,
    relayId,
    pid: process.pid,
    hostname: "127.0.0.1",
    port: address.port,
    token,
    expiresAtMs: Date.now() + 60_000,
  })}\n`, { mode: 0o600 });
  chmodSync(liveRegistry, 0o600);

  try {
    const success = await runClient({ relayId, event: "pre_tool_use" });
    assert.equal(success.code, 0);
    assert.equal(success.stdout, "bridge-ok\n");
    assert.equal(success.stderr, "");
    assert(success.elapsedMs < 750, `success path took ${success.elapsedMs.toFixed(1)}ms`);
    assert.equal(observed.authorization, `Bearer ${token}`);
    assert.equal(observed.payload.relayId, relayId);
    assert.equal(observed.payload.event, "pre_tool_use");
    assert.deepEqual(observed.payload.rawPayload, { ok: true });

    const missingRelay = `missing-${randomUUID()}`;
    const blocked = await runClient({ relayId: missingRelay, event: "pre_tool_use", timeout: 75 });
    assert.equal(blocked.code, 0);
    assert.match(blocked.stderr, /native hook relay timed out/u);
    assert.deepEqual(JSON.parse(blocked.stdout), {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "Native hook relay unavailable",
      },
    });

    const noop = await runClient({ relayId: missingRelay, event: "pre_tool_use", timeout: 75, preMode: "noop" });
    assert.equal(noop.code, 0);
    assert.equal(noop.stdout, "");

    const post = await runClient({ relayId: missingRelay, event: "post_tool_use", timeout: 75 });
    assert.equal(post.code, 0);
    assert.equal(post.stdout, "");

    const permission = await runClient({ relayId: missingRelay, event: "permission_request", timeout: 75 });
    assert.equal(permission.code, 0);
    assert.deepEqual(JSON.parse(permission.stdout), {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: "Native hook relay unavailable" },
      },
    });

    const invalid = await runClient({ relayId, event: "post_tool_use", input: "{" });
    assert.equal(invalid.code, 1);
    assert.match(invalid.stderr, /failed to read native hook input/u);

    console.log(`fast native hook relay tests passed; live bridge path ${success.elapsedMs.toFixed(1)}ms`);
  } finally {
    rmSync(liveRegistry, { force: true });
    await new Promise((resolve) => server.close(resolve));
  }
}

await main();
