#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const REVIEWED_VERSIONS = new Set(["2026.7.1", "2026.7.1-1"]);
const RUN_GUARD_MARKER = "vianne-codex-terminal-task-completion-fence-v2";
const DELIVERY_PROVENANCE_MARKER = "vianne-internal-task-completion-provenance-v1";

const ORIGINAL_ENQUEUE_START = "\tconst enqueueSend = (texts) => {";

const PATCHED_ENQUEUE_START = [
  "\tconst resolveDisposition = (text, options) => {",
  "\t\ttry {",
  "\t\t\treturn params.classifyText?.(text, options);",
  "\t\t} catch {",
  "\t\t\treturn void 0;",
  "\t\t}",
  "\t};",
  "\tconst settleWithoutSteer = (item, disposition) => {",
  "\t\tif (disposition === \"defer\") {",
  "\t\t\titem.reject(/* @__PURE__ */ new Error(\"codex app-server terminal answer already committed; defer internal task completion\"));",
  "\t\t\treturn;",
  "\t\t}",
  "\t\titem.resolve();",
  "\t};",
  "\tconst enqueueSend = (items) => {",
].join("\n");

const ORIGINAL_ENQUEUE_SEND = "\t\tconst send = sendChain.then(() => sendTexts(texts));";

const PATCHED_ENQUEUE_SEND = [
  "\t\tconst send = sendChain.then(async () => {",
  "\t\t\tconst sendItems = [];",
  "\t\t\tfor (const item of items) {",
  "\t\t\t\tconst disposition = resolveDisposition(item.text, item.options);",
  "\t\t\t\tif (disposition === \"absorb\" || disposition === \"defer\") {",
  "\t\t\t\t\tsettleWithoutSteer(item, disposition);",
  "\t\t\t\t\tcontinue;",
  "\t\t\t\t}",
  "\t\t\t\tsendItems.push(item);",
  "\t\t\t}",
  "\t\t\tawait sendTexts(sendItems.map((item) => item.text));",
  "\t\t\treturn sendItems;",
  "\t\t});",
].join("\n");

const ORIGINAL_FLUSH_BATCH = [
  "\tconst flushBatch = () => {",
  "\t\tclearBatchTimer();",
  "\t\tconst items = batchedTexts;",
  "\t\tbatchedTexts = [];",
  "\t\tconst send = enqueueSend(items.map((item) => item.text));",
  "\t\tsend.then(() => {",
  "\t\t\tfor (const item of items) item.resolve();",
  "\t\t}, (error) => {",
  "\t\t\tfor (const item of items) item.reject(error);",
  "\t\t});",
  "\t\treturn send;",
  "\t};",
].join("\n");

const PATCHED_FLUSH_BATCH = [
  "\tconst flushBatch = () => {",
  "\t\tclearBatchTimer();",
  "\t\tconst items = batchedTexts;",
  "\t\tbatchedTexts = [];",
  "\t\tconst send = enqueueSend(items);",
  "\t\tsend.then((sendItems) => {",
  "\t\t\tfor (const item of sendItems) item.resolve();",
  "\t\t}, (error) => {",
  "\t\t\tfor (const item of items) item.reject(error);",
  "\t\t});",
  "\t\treturn send;",
  "\t};",
].join("\n");

const ORIGINAL_QUEUE_START = [
  "\t\tasync queue(text, options) {",
  "\t\t\tif (params.answerPendingUserInput(text)) return;",
  "\t\t\treturn await new Promise((resolve, reject) => {",
  "\t\t\t\tbatchedTexts.push({",
  "\t\t\t\t\ttext,",
  "\t\t\t\t\tresolve,",
  "\t\t\t\t\treject",
  "\t\t\t\t});",
].join("\n");

const PATCHED_QUEUE_START = [
  "\t\tasync queue(text, options) {",
  "\t\t\tif (params.answerPendingUserInput(text)) return;",
  "\t\t\tconst disposition = resolveDisposition(text, options);",
  "\t\t\tif (disposition === \"absorb\") return;",
  "\t\t\tif (disposition === \"defer\") throw new Error(\"codex app-server terminal answer already committed; defer internal task completion\");",
  "\t\t\treturn await new Promise((resolve, reject) => {",
  "\t\t\t\tbatchedTexts.push({",
  "\t\t\t\t\ttext,",
  "\t\t\t\t\toptions,",
  "\t\t\t\t\tresolve,",
  "\t\t\t\t\treject",
  "\t\t\t\t});",
].join("\n");

const ORIGINAL_QUEUE_CONSTRUCTOR = [
  "\t\tanswerPendingUserInput: (text) => userInputBridgeRef.current?.handleQueuedMessage(text) ?? false,",
  "\t\tsignal: runAbortController.signal",
].join("\n");

const PATCHED_QUEUE_CONSTRUCTOR = [
  "\t\tanswerPendingUserInput: (text) => userInputBridgeRef.current?.handleQueuedMessage(text) ?? false,",
  "\t\tclassifyText: (text, optionsLocal) => {",
  "\t\t\tif (",
  "\t\t\t\toptionsLocal?.internalTaskCompletion !== true ||",
  "\t\t\t\toptionsLocal?.isInboundUserMessage === true ||",
  "\t\t\t\toptionsLocal?.userTurnTranscriptRecorder ||",
  "\t\t\t\toptionsLocal?.steeringMode !== \"all\"",
  "\t\t\t) return void 0;",
  "\t\t\tconst normalizedText = text.trim();",
  "\t\t\tconst isProtectedTaskCompletion =",
  "\t\t\t\tnormalizedText.startsWith(\"<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\\nOpenClaw runtime context (internal):\\n\") &&",
  "\t\t\t\tnormalizedText.includes(\"\\n[Internal task completion event]\\nsource: subagent\\n\") &&",
  "\t\t\t\tnormalizedText.endsWith(\"<<<END_OPENCLAW_INTERNAL_CONTEXT>>>\");",
  "\t\t\tconst terminalAssistantIsQuiescent =",
  "\t\t\t\tactiveProjector.hasCompletedTerminalAssistantText() &&",
  "\t\t\t\tactiveAppServerTurnRequests === 0 &&",
  "\t\t\t\tactiveTurnItemIds.size === 0 &&",
  "\t\t\t\tactiveCompletionBlockerItemIds.size === 0 &&",
  "\t\t\t\tpendingOpenClawDynamicToolCompletionIds.size === 0 &&",
  "\t\t\t\tactiveFinalizationHookRunIds.size === 0 &&",
  "\t\t\t\tunsettledFinalizationHookCount === 0 &&",
  "\t\t\t\trejectedFinalizationHookAssistant === void 0;",
  "\t\t\tif (!isProtectedTaskCompletion || !terminalAssistantIsQuiescent) return void 0;",
  "\t\t\treturn normalizedText.includes(\"\\nMEDIA:\") ? \"defer\" : \"absorb\";",
  `\t\t}, /* ${RUN_GUARD_MARKER} */`,
  "\t\tsignal: runAbortController.signal",
].join("\n");

const ORIGINAL_ANNOUNCE_QUEUE_OPTIONS = [
  "\tconst queueOptions = {",
  "\t\tdeliveryTimeoutMs: params.deliveryTimeoutMs,",
  "\t\tsteeringMode: \"all\",",
  "\t\t...queueSettings.debounceMs !== void 0 ? { debounceMs: queueSettings.debounceMs } : {},",
  "\t\twaitForTranscriptCommit: true",
  "\t};",
].join("\n");

const PATCHED_ANNOUNCE_QUEUE_OPTIONS = [
  "\tconst queueOptions = {",
  "\t\tdeliveryTimeoutMs: params.deliveryTimeoutMs,",
  "\t\tsteeringMode: \"all\",",
  `\t\tinternalTaskCompletion: true, /* ${DELIVERY_PROVENANCE_MARKER} */`,
  "\t\t...queueSettings.debounceMs !== void 0 ? { debounceMs: queueSettings.debounceMs } : {},",
  "\t\twaitForTranscriptCommit: true",
  "\t};",
].join("\n");

const ORIGINAL_COMPLETION_WAKE_OPTIONS = [
  "\t\t\tconst wakeOptions = {",
  "\t\t\t\tdeliveryTimeoutMs: announceTimeoutMs,",
  "\t\t\t\tsteeringMode: \"all\",",
  "\t\t\t\t...completionSourceReplyDeliveryMode ? { sourceReplyDeliveryMode: completionSourceReplyDeliveryMode } : {},",
  "\t\t\t\t...requesterQueueSettings.debounceMs !== void 0 ? { debounceMs: requesterQueueSettings.debounceMs } : {},",
  "\t\t\t\twaitForTranscriptCommit: true",
  "\t\t\t};",
].join("\n");

const PATCHED_COMPLETION_WAKE_OPTIONS = [
  "\t\t\tconst wakeOptions = {",
  "\t\t\t\tdeliveryTimeoutMs: announceTimeoutMs,",
  "\t\t\t\tsteeringMode: \"all\",",
  "\t\t\t\tinternalTaskCompletion: true,",
  "\t\t\t\t...completionSourceReplyDeliveryMode ? { sourceReplyDeliveryMode: completionSourceReplyDeliveryMode } : {},",
  "\t\t\t\t...requesterQueueSettings.debounceMs !== void 0 ? { debounceMs: requesterQueueSettings.debounceMs } : {},",
  "\t\t\t\twaitForTranscriptCommit: true",
  "\t\t\t};",
].join("\n");

function fail(message) {
  throw new Error(`[codex-final-delivery] ${message}`);
}

function findSingleContaining(distDir, pattern, anchors, label) {
  const matches = fs
    .readdirSync(distDir)
    .filter((name) => pattern.test(name))
    .map((name) => path.join(distDir, name))
    .filter((file) => {
      const content = fs.readFileSync(file, "utf8");
      return anchors.every((anchor) => content.includes(anchor));
    });
  if (matches.length !== 1) {
    fail(`expected exactly one ${label} bundle in ${distDir}, found ${matches.length}`);
  }
  return matches[0];
}

function replaceOnce(content, from, to, label, file) {
  const count = content.split(from).length - 1;
  if (count !== 1) {
    fail(`expected one ${label} anchor in ${file}, found ${count}`);
  }
  return content.replace(from, to);
}

function patchRunAttempt(file) {
  const before = fs.readFileSync(file, "utf8");
  if (before.includes(RUN_GUARD_MARKER)) {
    return false;
  }
  let after = replaceOnce(
    before,
    ORIGINAL_ENQUEUE_START,
    PATCHED_ENQUEUE_START,
    "serialized steering admission",
    file,
  );
  after = replaceOnce(
    after,
    ORIGINAL_ENQUEUE_SEND,
    PATCHED_ENQUEUE_SEND,
    "serialized steering dispatch",
    file,
  );
  after = replaceOnce(
    after,
    ORIGINAL_FLUSH_BATCH,
    PATCHED_FLUSH_BATCH,
    "steering flush",
    file,
  );
  after = replaceOnce(
    after,
    ORIGINAL_QUEUE_START,
    PATCHED_QUEUE_START,
    "steering admission",
    file,
  );
  after = replaceOnce(
    after,
    ORIGINAL_QUEUE_CONSTRUCTOR,
    PATCHED_QUEUE_CONSTRUCTOR,
    "steering classifier",
    file,
  );
  const candidateFile = path.join(
    path.dirname(file),
    `.${path.basename(file)}.vianne-final-delivery-${process.pid}.tmp.js`,
  );
  fs.writeFileSync(candidateFile, after);
  const syntax = spawnSync(process.execPath, ["--check", candidateFile], { encoding: "utf8" });
  if (syntax.status !== 0) {
    fs.rmSync(candidateFile, { force: true });
    fail(`patch candidate failed node --check: ${syntax.stderr.trim()}`);
  }
  fs.renameSync(candidateFile, file);
  return true;
}

function patchCompletionProvenance(file) {
  const before = fs.readFileSync(file, "utf8");
  if (before.includes(DELIVERY_PROVENANCE_MARKER)) {
    return false;
  }
  let after = replaceOnce(
    before,
    ORIGINAL_ANNOUNCE_QUEUE_OPTIONS,
    PATCHED_ANNOUNCE_QUEUE_OPTIONS,
    "subagent announce queue provenance",
    file,
  );
  after = replaceOnce(
    after,
    ORIGINAL_COMPLETION_WAKE_OPTIONS,
    PATCHED_COMPLETION_WAKE_OPTIONS,
    "subagent completion wake provenance",
    file,
  );
  const candidateFile = path.join(
    path.dirname(file),
    `.${path.basename(file)}.vianne-completion-provenance-${process.pid}.tmp.js`,
  );
  fs.writeFileSync(candidateFile, after);
  const syntax = spawnSync(process.execPath, ["--check", candidateFile], { encoding: "utf8" });
  if (syntax.status !== 0) {
    fs.rmSync(candidateFile, { force: true });
    fail(`provenance patch candidate failed node --check: ${syntax.stderr.trim()}`);
  }
  fs.renameSync(candidateFile, file);
  return true;
}

function verify(runAttemptFile, completionProvenanceFile) {
  const runAttempt = fs.readFileSync(runAttemptFile, "utf8");
  for (const anchor of [
    RUN_GUARD_MARKER,
    "resolveDisposition(item.text, item.options)",
    "await sendTexts(sendItems.map((item) => item.text))",
    "send.then((sendItems) =>",
    "optionsLocal?.internalTaskCompletion !== true",
    "optionsLocal?.isInboundUserMessage === true",
    "activeProjector.hasCompletedTerminalAssistantText()",
    "terminalAssistantIsQuiescent",
    'return normalizedText.includes("\\nMEDIA:") ? "defer" : "absorb"',
  ]) {
    if (!runAttempt.includes(anchor)) {
      fail(`run-attempt verification failed in ${runAttemptFile}: ${anchor}`);
    }
  }
  if (completionProvenanceFile) {
    const completionProvenance = fs.readFileSync(completionProvenanceFile, "utf8");
    for (const anchor of [
      DELIVERY_PROVENANCE_MARKER,
      "internalTaskCompletion: true",
      "const queueOptions = {",
      "const wakeOptions = {",
    ]) {
      if (!completionProvenance.includes(anchor)) {
        fail(`completion provenance verification failed in ${completionProvenanceFile}: ${anchor}`);
      }
    }
  }
}

function main() {
  const args = process.argv.slice(2);
  const verifyOnly = args.includes("--verify");
  const moduleDir = args.find((arg) => arg !== "--verify");
  if (!moduleDir) {
    fail("usage: patch-codex-final-delivery.cjs <openclaw-or-codex-module-dir> [--verify]");
  }

  const packageFile = path.join(moduleDir, "package.json");
  const distDir = path.join(moduleDir, "dist");
  if (!fs.existsSync(packageFile) || !fs.existsSync(distDir)) {
    fail(`invalid module directory: ${moduleDir}`);
  }

  const packageJson = JSON.parse(fs.readFileSync(packageFile, "utf8"));
  const version = packageJson.version;
  if (!REVIEWED_VERSIONS.has(version)) {
    fail(`version ${version} is not reviewed; expected one of ${[...REVIEWED_VERSIONS].join(", ")}`);
  }

  const runAttemptFile = findSingleContaining(
    distDir,
    /^run-attempt-.*\.js$/,
    ["function createCodexSteeringQueue", "hasCompletedTerminalAssistantText()"],
    "Codex run-attempt",
  );
  const completionProvenanceFile =
    packageJson.name === "openclaw"
      ? findSingleContaining(
          distDir,
          /^subagent-announce-origin-.*\.js$/,
          ["resolveActiveWakeWithRetries", "const wakeOptions = {"],
          "subagent announce origin",
        )
      : undefined;

  let changed = 0;
  if (!verifyOnly) {
    changed += patchRunAttempt(runAttemptFile) ? 1 : 0;
    if (completionProvenanceFile) {
      changed += patchCompletionProvenance(completionProvenanceFile) ? 1 : 0;
    }
  }
  verify(runAttemptFile, completionProvenanceFile);
  for (const bundleFile of [runAttemptFile, completionProvenanceFile].filter(Boolean)) {
    const syntax = spawnSync(process.execPath, ["--check", bundleFile], { encoding: "utf8" });
    if (syntax.status !== 0) {
      fail(`patched bundle failed node --check (${bundleFile}): ${syntax.stderr.trim()}`);
    }
  }
  console.log(`[codex-final-delivery] verified ${version}; patched files=${changed}; ${moduleDir}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
