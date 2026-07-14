#!/usr/bin/env node

// Lightweight client for OpenClaw's already-running native hook relay bridge.
//
// The stock command starts the complete OpenClaw CLI for every pre/post tool
// hook. That adds several seconds of cold-start work even though the gateway
// already exposes a private localhost bridge for the actual policy and plugin
// hook execution. This client only performs that authenticated local bridge
// call. It deliberately preserves OpenClaw's fail-closed PreToolUse behavior.

import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
} from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_REGISTRY_BYTES = 64 * 1024;
const MAX_BRIDGE_RESPONSE_BYTES = 5 * 1000 * 1000;
const RETRY_INTERVAL_MS = 25;
const STALE_RECORD_GRACE_MS = 250;
const RELAY_ID_PATTERN = /^[A-Za-z0-9._:-]+$/u;
const EVENTS = new Set([
  "pre_tool_use",
  "post_tool_use",
  "permission_request",
  "before_agent_finalize",
]);
const STALE_REGISTRATION_ERROR = "native hook relay bridge stale registration";

class DeadlineError extends Error {
  constructor(timeoutMs) {
    super(`native hook relay timed out after ${timeoutMs}ms`);
    this.name = "DeadlineError";
  }
}

function parseArgs(argv) {
  const args = [...argv];
  // buildNativeHookRelayCommand emits the normal `hooks relay` subcommand.
  // Accept it so this client is a drop-in replacement for the full CLI.
  if (args[0] === "hooks" && args[1] === "relay") args.splice(0, 2);

  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(`invalid native hook relay argument: ${flag ?? "<missing>"}`);
    }
    values.set(flag.slice(2), value);
  }

  const provider = required(values, "provider");
  const relayId = required(values, "relay-id");
  const generation = values.get("generation")?.trim();
  const event = required(values, "event");
  const preToolUseUnavailable = values.get("pre-tool-use-unavailable")?.trim();
  const timeoutText = values.get("timeout") ?? "5000";
  const timeoutMs = Number(timeoutText);

  if (provider !== "codex") throw new Error(`unsupported native hook provider: ${provider}`);
  validateCompactId(relayId, "relay id");
  if (generation) validateCompactId(generation, "relay generation");
  if (!EVENTS.has(event)) throw new Error(`unsupported native hook event: ${event}`);
  if (preToolUseUnavailable !== undefined && preToolUseUnavailable !== "noop") {
    throw new Error(`unsupported PreToolUse fallback mode: ${preToolUseUnavailable}`);
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`invalid native hook timeout: ${timeoutText}`);
  }

  return {
    provider,
    relayId,
    generation,
    event,
    preToolUseUnavailable,
    timeoutMs,
  };
}

function required(values, name) {
  const value = values.get(name)?.trim();
  if (!value) throw new Error(`Missing required option --${name}`);
  return value;
}

function validateCompactId(value, label) {
  if (value.length > 160 || !RELAY_ID_PATTERN.test(value)) {
    throw new Error(`${label} must be non-empty, compact, and URL-safe`);
  }
}

async function readStdin(deadline) {
  const chunks = [];
  let total = 0;
  const timeout = setTimeout(() => {
    process.stdin.destroy(new DeadlineError(deadline.timeoutMs));
  }, Math.max(1, deadline.expiresAtMs - Date.now()));

  try {
    for await (const chunk of process.stdin) {
      if (Date.now() >= deadline.expiresAtMs) throw new DeadlineError(deadline.timeoutMs);
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.byteLength;
      if (total > MAX_STDIN_BYTES) {
        throw new Error(`native hook input exceeds ${MAX_STDIN_BYTES} bytes`);
      }
      chunks.push(buffer);
    }
  } finally {
    clearTimeout(timeout);
  }

  if (Date.now() >= deadline.expiresAtMs) throw new DeadlineError(deadline.timeoutMs);
  const text = Buffer.concat(chunks, total).toString("utf8");
  return text.trim() ? JSON.parse(text) : null;
}

function bridgeDirectory() {
  const uid = typeof process.getuid === "function" ? process.getuid() : "nouid";
  return path.join(tmpdir(), `openclaw-native-hook-relays-${uid}`);
}

function bridgeRegistryPath(relayId) {
  const key = createHash("sha256").update(relayId).digest("hex").slice(0, 32);
  return path.join(bridgeDirectory(), `${key}.json`);
}

function validatePrivatePath(target, expectedType) {
  const stats = lstatSync(target);
  if (expectedType === "directory") {
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error("unsafe native hook relay bridge directory");
    }
  } else if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error("unsafe native hook relay bridge registry");
  }

  const expectedUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (expectedUid !== undefined && stats.uid !== expectedUid) {
    throw new Error(`unsafe native hook relay bridge ${expectedType} owner`);
  }
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
    throw new Error(`unsafe native hook relay bridge ${expectedType} permissions`);
  }
  return stats;
}

function readBridgeRecord(relayId) {
  const directory = bridgeDirectory();
  validatePrivatePath(directory, "directory");
  const registryPath = bridgeRegistryPath(relayId);
  const stats = validatePrivatePath(registryPath, "registry");
  if (stats.size > MAX_REGISTRY_BYTES) {
    throw new Error("native hook relay bridge registry too large");
  }

  const record = JSON.parse(readFileSync(registryPath, "utf8"));
  if (!isBridgeRecord(record, relayId)) {
    throw new Error("invalid native hook relay bridge registry");
  }
  return record;
}

function isBridgeRecord(value, relayId) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && value.version === 1
    && value.relayId === relayId
    && Number.isInteger(value.pid)
    && value.hostname === "127.0.0.1"
    && Number.isInteger(value.port)
    && value.port > 0
    && value.port <= 65535
    && typeof value.token === "string"
    && value.token.length > 0
    && value.token.length <= 1024
    && typeof value.expiresAtMs === "number"
    && Number.isFinite(value.expiresAtMs);
}

function postBridge(record, payload, timeoutMs) {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    const req = request({
      hostname: "127.0.0.1",
      method: "POST",
      path: "/invoke",
      port: record.port,
      timeout: timeoutMs,
      headers: {
        authorization: `Bearer ${record.token}`,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      },
    }, (res) => {
      let responseText = "";
      let responseBytes = 0;
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        responseBytes += Buffer.byteLength(chunk);
        if (responseBytes > MAX_BRIDGE_RESPONSE_BYTES) {
          settle(reject, new Error("native hook relay bridge response too large"));
          res.destroy();
          return;
        }
        responseText += chunk;
      });
      res.on("error", (error) => settle(reject, error));
      res.on("end", () => {
        if (settled) return;
        try {
          const parsed = JSON.parse(responseText);
          if (!parsed?.ok) throw new Error(parsed?.error || "native hook relay bridge failed");
          if (!isProcessResponse(parsed.result)) {
            throw new Error("invalid native hook relay bridge response");
          }
          settle(resolve, parsed.result);
        } catch (error) {
          settle(reject, error instanceof Error ? error : new Error(String(error)));
        }
      });
    });

    req.on("timeout", () => req.destroy(new Error("native hook relay bridge timed out")));
    req.on("error", (error) => settle(reject, error));
    req.end(body);
  });
}

function isProcessResponse(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && typeof value.stdout === "string"
    && typeof value.stderr === "string"
    && Number.isInteger(value.exitCode);
}

function isRetryable(error, elapsedMs) {
  const code = error?.code;
  return code === "ENOENT"
    || code === "ECONNREFUSED"
    || code === "EAGAIN"
    || (error instanceof SyntaxError && elapsedMs < STALE_RECORD_GRACE_MS)
    || (error instanceof Error && error.message === STALE_REGISTRATION_ERROR && elapsedMs < STALE_RECORD_GRACE_MS);
}

async function invokeBridge(options, rawPayload, deadline) {
  const startedAt = Date.now();
  let lastError = new Error("native hook relay bridge not found");
  while (Date.now() < deadline.expiresAtMs) {
    try {
      const record = readBridgeRecord(options.relayId);
      if (Date.now() > record.expiresAtMs) {
        throw new Error("native hook relay bridge expired");
      }
      return await postBridge(record, {
        provider: options.provider,
        relayId: options.relayId,
        generation: options.generation,
        event: options.event,
        rawPayload,
      }, Math.max(1, deadline.expiresAtMs - Date.now()));
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (!isRetryable(lastError, Date.now() - startedAt)) break;
      const remaining = deadline.expiresAtMs - Date.now();
      if (remaining <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(RETRY_INTERVAL_MS, remaining)));
    }
  }

  if (Date.now() >= deadline.expiresAtMs) throw new DeadlineError(deadline.timeoutMs);
  throw lastError;
}

function unavailableResponse(options, message = "Native hook relay unavailable") {
  if (options.event === "pre_tool_use") {
    if (options.preToolUseUnavailable === "noop") return { stdout: "", stderr: "", exitCode: 0 };
    return {
      stdout: `${JSON.stringify({ hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: message,
      } })}\n`,
      stderr: "",
      exitCode: 0,
    };
  }
  if (options.event === "permission_request") {
    return {
      stdout: `${JSON.stringify({ hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message },
      } })}\n`,
      stderr: "",
      exitCode: 0,
    };
  }
  return { stdout: "", stderr: "", exitCode: 0 };
}

function writeResponse(response) {
  if (response.stdout) process.stdout.write(response.stdout);
  if (response.stderr) process.stderr.write(response.stderr);
  process.exitCode = response.exitCode;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }

  const deadline = {
    timeoutMs: options.timeoutMs,
    expiresAtMs: Date.now() + options.timeoutMs,
  };

  let rawPayload;
  try {
    rawPayload = await readStdin(deadline);
  } catch (error) {
    if (error instanceof DeadlineError) {
      process.stderr.write(`native hook relay timed out: ${error.message}\n`);
      writeResponse(unavailableResponse(options));
      return;
    }
    process.stderr.write(`failed to read native hook input: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }

  try {
    writeResponse(await invokeBridge(options, rawPayload, deadline));
  } catch (error) {
    const prefix = error instanceof DeadlineError
      ? "native hook relay timed out"
      : "native hook relay unavailable";
    process.stderr.write(`${prefix}: ${error instanceof Error ? error.message : String(error)}\n`);
    writeResponse(unavailableResponse(options));
  }
}

await main();
