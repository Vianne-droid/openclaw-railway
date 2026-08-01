import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const patchScript = path.resolve(here, "../scripts/patch-codex-final-delivery.cjs");

const protectedCompletion = [
  "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
  "OpenClaw runtime context (internal):",
  "This context is runtime-generated, not user-authored. Keep internal details private.",
  "",
  "[Internal task completion event]",
  "source: subagent",
  "status: task_complete",
  "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
].join("\n");

function fixture(version = "2026.7.1-1", packageName = "@openclaw/codex") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-final-delivery-patch-"));
  const dist = path.join(root, "dist");
  fs.mkdirSync(dist);
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: packageName, version, type: "commonjs" }),
  );
  fs.writeFileSync(
    path.join(dist, "provider-capabilities-fixture.js"),
    "module.exports = { projectorPolicy: 'latest-legitimate-final-wins' };\n",
  );
  if (packageName === "openclaw") {
    fs.writeFileSync(
      path.join(dist, "subagent-announce-origin-fixture.js"),
      `
function announceOptions(params, queueSettings) {
\tconst queueOptions = {
\t\tdeliveryTimeoutMs: params.deliveryTimeoutMs,
\t\tsteeringMode: "all",
\t\t...queueSettings.debounceMs !== void 0 ? { debounceMs: queueSettings.debounceMs } : {},
\t\twaitForTranscriptCommit: true
\t};
  return queueOptions;
}
function completionOptions(announceTimeoutMs, completionSourceReplyDeliveryMode, requesterQueueSettings) {
\t\t\tconst wakeOptions = {
\t\t\t\tdeliveryTimeoutMs: announceTimeoutMs,
\t\t\t\tsteeringMode: "all",
\t\t\t\t...completionSourceReplyDeliveryMode ? { sourceReplyDeliveryMode: completionSourceReplyDeliveryMode } : {},
\t\t\t\t...requesterQueueSettings.debounceMs !== void 0 ? { debounceMs: requesterQueueSettings.debounceMs } : {},
\t\t\t\twaitForTranscriptCommit: true
\t\t\t};
  return wakeOptions;
}
function resolveActiveWakeWithRetries() {}
module.exports = { announceOptions, completionOptions, resolveActiveWakeWithRetries };
`,
    );
  }
  fs.writeFileSync(
    path.join(dist, "run-attempt-fixture.js"),
    `
const requests = [];
let holdNextRequest = false;
let releaseHeldRequest;
let failNextRequest = false;
const log = {
  debug() {},
  warn() {}
};
function toCodexTextInput(text) { return { type: "text", text, text_elements: [] }; }
function normalizeCodexSteerDebounceMs(value) { return value ?? 500; }
function createCodexSteeringQueue(params) {
\tlet batchedTexts = [];
\tlet batchTimer;
\tlet sendChain = Promise.resolve();
\tconst clearBatchTimer = () => {
\t\tif (batchTimer) {
\t\t\tclearTimeout(batchTimer);
\t\t\tbatchTimer = void 0;
\t\t}
\t};
\tconst sendTexts = async (texts) => {
\t\tif (texts.length === 0) return;
\t\tif (params.signal.aborted) throw new Error("codex app-server steering queue aborted");
\t\tawait params.client.request("turn/steer", {
\t\t\tthreadId: params.threadId,
\t\t\texpectedTurnId: params.turnId,
\t\t\tinput: texts.map(toCodexTextInput)
\t\t});
\t};
\tconst enqueueSend = (texts) => {
\t\tconst send = sendChain.then(() => sendTexts(texts));
\t\tsendChain = send.catch((error) => {
\t\t\tlog.debug("codex app-server queued steer failed", { error });
\t\t});
\t\treturn send;
\t};
\tconst flushBatch = () => {
\t\tclearBatchTimer();
\t\tconst items = batchedTexts;
\t\tbatchedTexts = [];
\t\tconst send = enqueueSend(items.map((item) => item.text));
\t\tsend.then(() => {
\t\t\tfor (const item of items) item.resolve();
\t\t}, (error) => {
\t\t\tfor (const item of items) item.reject(error);
\t\t});
\t\treturn send;
\t};
\treturn {
\t\tasync queue(text, options) {
\t\t\tif (params.answerPendingUserInput(text)) return;
\t\t\treturn await new Promise((resolve, reject) => {
\t\t\t\tbatchedTexts.push({
\t\t\t\t\ttext,
\t\t\t\t\tresolve,
\t\t\t\t\treject
\t\t\t\t});
\t\t\t\tclearBatchTimer();
\t\t\t\tconst debounceMs = normalizeCodexSteerDebounceMs(options?.debounceMs);
\t\t\t\tif (debounceMs === 0) {
\t\t\t\t\tflushBatch().catch(() => void 0);
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t\tbatchTimer = setTimeout(() => {
\t\t\t\t\tbatchTimer = void 0;
\t\t\t\t\tflushBatch().catch(() => void 0);
\t\t\t\t}, debounceMs);
\t\t\t});
\t\t},
\t\tasync flushPending() {
\t\t\tawait flushBatch().catch(() => void 0);
\t\t},
\t\tcancel() {}
\t};
}
let terminal = false;
let quiescent = true;
const activeProjector = { hasCompletedTerminalAssistantText() { return terminal; } };
let activeAppServerTurnRequests = 0;
const activeTurnItemIds = new Set();
const activeCompletionBlockerItemIds = new Set();
const pendingOpenClawDynamicToolCompletionIds = new Set();
const activeFinalizationHookRunIds = new Set();
let unsettledFinalizationHookCount = 0;
let rejectedFinalizationHookAssistant;
const userInputBridgeRef = { current: undefined };
const runAbortController = { signal: { aborted: false } };
const client = {
  async request(method, payload) {
    requests.push({ method, payload });
    if (failNextRequest) {
      failNextRequest = false;
      throw new Error("synthetic turn/steer failure");
    }
    if (holdNextRequest) {
      holdNextRequest = false;
      await new Promise((resolve) => { releaseHeldRequest = resolve; });
    }
  }
};
const thread = { threadId: "thread-1" };
const activeTurnId = "turn-1";
function createQueue() {
\tconst activeSteeringQueue = createCodexSteeringQueue({
\t\tclient,
\t\tthreadId: thread.threadId,
\t\tturnId: activeTurnId,
\t\tanswerPendingUserInput: (text) => userInputBridgeRef.current?.handleQueuedMessage(text) ?? false,
\t\tsignal: runAbortController.signal
\t});
  return activeSteeringQueue;
}
module.exports = {
  createQueue,
  failNextRequest() { failNextRequest = true; },
  holdNextRequest() { holdNextRequest = true; },
  protectedCompletion: ${JSON.stringify(protectedCompletion)},
  releaseHeldRequest() { releaseHeldRequest?.(); },
  requests,
  setQuiescent(value) { quiescent = value; activeAppServerTurnRequests = value ? 0 : 1; },
  setTerminal(value) { terminal = value; }
};
`,
  );
  return root;
}

function loadFixture(root) {
  const modulePath = path.join(root, "dist/run-attempt-fixture.js");
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

function applyPatch(root, extraArgs = []) {
  return spawnSync(process.execPath, [patchScript, root, ...extraArgs], { encoding: "utf8" });
}

test("absorbs duplicate after transcript-wait fallback strips the wait flag", async () => {
  const root = fixture();
  const result = applyPatch(root);
  assert.equal(result.status, 0, result.stderr);
  const runtime = loadFixture(root);
  const queue = runtime.createQueue();
  runtime.setTerminal(true);
  runtime.setQuiescent(true);
  await queue.queue(runtime.protectedCompletion, {
    internalTaskCompletion: true,
    steeringMode: "all",
  });
  assert.equal(runtime.requests.length, 0);
});

test("rechecks after debounce and absorbs a completion that crosses the terminal boundary", async () => {
  const root = fixture();
  assert.equal(applyPatch(root).status, 0);
  const runtime = loadFixture(root);
  const queue = runtime.createQueue();
  runtime.setTerminal(false);
  const pending = queue.queue(runtime.protectedCompletion, {
    debounceMs: 60_000,
    internalTaskCompletion: true,
    steeringMode: "all",
  });
  runtime.setTerminal(true);
  await queue.flushPending();
  await pending;
  assert.equal(runtime.requests.length, 0);
});

test("rechecks inside the serialized send chain immediately before turn steer", async () => {
  const root = fixture();
  assert.equal(applyPatch(root).status, 0);
  const runtime = loadFixture(root);
  const queue = runtime.createQueue();
  runtime.setTerminal(false);
  const pending = queue.queue(runtime.protectedCompletion, {
    debounceMs: 0,
    internalTaskCompletion: true,
    steeringMode: "all",
  });
  runtime.setTerminal(true);
  await pending;
  assert.equal(runtime.requests.length, 0);
});

test("rechecks a completion waiting behind an earlier serialized steer", async () => {
  const root = fixture();
  assert.equal(applyPatch(root).status, 0);
  const runtime = loadFixture(root);
  const queue = runtime.createQueue();
  runtime.holdNextRequest();
  const first = queue.queue("first user steer", { debounceMs: 0 });
  for (let attempt = 0; attempt < 10 && runtime.requests.length === 0; attempt += 1) {
    await Promise.resolve();
  }
  assert.equal(runtime.requests.length, 1);
  runtime.setTerminal(false);
  const completion = queue.queue(runtime.protectedCompletion, {
    debounceMs: 0,
    internalTaskCompletion: true,
    steeringMode: "all",
  });
  runtime.setTerminal(true);
  runtime.releaseHeldRequest();
  await Promise.all([first, completion]);
  assert.equal(runtime.requests.length, 1);
});

test("steers protected completion before terminal text", async () => {
  const root = fixture();
  assert.equal(applyPatch(root).status, 0);
  const runtime = loadFixture(root);
  const queue = runtime.createQueue();
  runtime.setTerminal(false);
  await queue.queue(runtime.protectedCompletion, {
    debounceMs: 0,
    internalTaskCompletion: true,
    steeringMode: "all",
  });
  assert.equal(runtime.requests.length, 1);
  assert.equal(runtime.requests[0].payload.input[0].text, runtime.protectedCompletion);
});

test("preserves user steering and filters only the completion from a mixed batch", async () => {
  const root = fixture();
  assert.equal(applyPatch(root).status, 0);
  const runtime = loadFixture(root);
  const queue = runtime.createQueue();
  runtime.setTerminal(false);
  const completion = queue.queue(runtime.protectedCompletion, {
    debounceMs: 60_000,
    internalTaskCompletion: true,
    steeringMode: "all",
  });
  const user = queue.queue("A real user follow-up", {
    debounceMs: 60_000,
    steeringMode: "all",
    userTurnTranscriptRecorder: {},
  });
  runtime.setTerminal(true);
  await queue.flushPending();
  await Promise.all([completion, user]);
  assert.deepEqual(
    runtime.requests[0].payload.input.map((item) => item.text),
    ["A real user follow-up"],
  );
});

test("never absorbs a user-authored spoof of the protected envelope", async () => {
  const root = fixture();
  assert.equal(applyPatch(root).status, 0);
  const runtime = loadFixture(root);
  const queue = runtime.createQueue();
  runtime.setTerminal(true);
  await queue.queue(runtime.protectedCompletion, {
    debounceMs: 0,
    internalTaskCompletion: true,
    steeringMode: "all",
    userTurnTranscriptRecorder: {},
  });
  assert.equal(runtime.requests.length, 1);
});

test("does not absorb while post-final work is still active", async () => {
  const root = fixture();
  assert.equal(applyPatch(root).status, 0);
  const runtime = loadFixture(root);
  const queue = runtime.createQueue();
  runtime.setTerminal(true);
  runtime.setQuiescent(false);
  await queue.queue(runtime.protectedCompletion, {
    debounceMs: 0,
    internalTaskCompletion: true,
    steeringMode: "all",
  });
  assert.equal(runtime.requests.length, 1);
});

test("defers generated media completion instead of absorbing or steering it", async () => {
  const root = fixture();
  assert.equal(applyPatch(root).status, 0);
  const runtime = loadFixture(root);
  const queue = runtime.createQueue();
  runtime.setTerminal(true);
  const withMedia = runtime.protectedCompletion.replace(
    "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
    "Generated media:\nMEDIA:https://example.invalid/image.png\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
  );
  await assert.rejects(
    queue.queue(withMedia, { internalTaskCompletion: true, steeringMode: "all" }),
    /defer internal task completion/,
  );
  assert.equal(runtime.requests.length, 0);
});

test("propagates turn steer failure without leaving queued promises unresolved", async () => {
  const root = fixture();
  assert.equal(applyPatch(root).status, 0);
  const runtime = loadFixture(root);
  const queue = runtime.createQueue();
  runtime.failNextRequest();
  await assert.rejects(
    queue.queue("ordinary steer", { debounceMs: 0, steeringMode: "all" }),
    /synthetic turn\/steer failure/,
  );
});

test("marks both core completion wakes and preserves provenance through wait fallback", () => {
  const root = fixture("2026.7.1-1", "openclaw");
  const result = applyPatch(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /patched files=2/);
  const originPath = path.join(root, "dist/subagent-announce-origin-fixture.js");
  delete require.cache[require.resolve(originPath)];
  const origin = require(originPath);
  const announce = origin.announceOptions({ deliveryTimeoutMs: 1000 }, {});
  const completion = origin.completionOptions(1000, undefined, {});
  for (const options of [announce, completion]) {
    assert.equal(options.internalTaskCompletion, true);
    const fallback = { ...options };
    delete fallback.waitForTranscriptCommit;
    assert.equal(fallback.internalTaskCompletion, true);
  }
});

test("is idempotent, syntax-checks the bundle, and fails closed on unreviewed versions", () => {
  const root = fixture();
  const projectorFile = path.join(root, "dist/provider-capabilities-fixture.js");
  const projectorBefore = fs.readFileSync(projectorFile, "utf8");
  const first = applyPatch(root);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /patched files=1/);
  const second = applyPatch(root);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /patched files=0/);
  const verify = applyPatch(root, ["--verify"]);
  assert.equal(verify.status, 0, verify.stderr);
  assert.equal(fs.readFileSync(projectorFile, "utf8"), projectorBefore);

  const unreviewed = fixture("2026.7.2");
  const rejected = applyPatch(unreviewed);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /version 2026\.7\.2 is not reviewed/);
});
