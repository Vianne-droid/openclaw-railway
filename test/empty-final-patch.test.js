import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const patchScript = path.resolve(here, "../scripts/patch-empty-final.cjs");

function fixture(version = "2026.7.1-1") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "empty-final-patch-"));
  const dist = path.join(root, "dist");
  fs.mkdirSync(dist);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version }));
  fs.writeFileSync(
    path.join(dist, "selection-fixture.js"),
    `
function resolveIncompleteTurnPayloadText(params) {
  if (params.payloadCount !== 0 || params.attempt.didSendDeterministicApprovalPrompt || params.attempt.lastToolError) return null;
  return params.replayUnsafe
    ? "Agent couldn't generate a response. Note: some tool actions may have already been executed."
    : "Agent couldn't generate a response. Please try again.";
}
`,
  );
  return root;
}

test("patches the suppressed-tool-error empty-final guard idempotently", () => {
  const root = fixture();
  const backupDir = path.join(root, "backups");
  const first = spawnSync(process.execPath, [patchScript, "--backup-dir", backupDir, root], {
    encoding: "utf8",
  });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /patched files=1/);

  const second = spawnSync(process.execPath, [patchScript, root], { encoding: "utf8" });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /patched files=0/);

  const check = spawnSync(process.execPath, [patchScript, "--check", root], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);

  const bundle = fs.readFileSync(path.join(root, "dist/selection-fixture.js"), "utf8");
  assert.match(bundle, /lastToolError && params\.payloadCount !== 0/);
  assert.match(bundle, /vianne-empty-final:last-tool-error/);
  assert.equal(fs.readdirSync(backupDir).filter((name) => name.endsWith(".bak")).length, 1);
});

test("check mode fails before the patch is present", () => {
  const root = fixture();
  const result = spawnSync(process.execPath, [patchScript, "--check", root], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /patch is missing/);
});

test("supports the production fork's default 2026.7.1 package", () => {
  const root = fixture("2026.7.1");
  const result = spawnSync(process.execPath, [patchScript, root], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /verified OpenClaw 2026\.7\.1/);
});

test("fails closed for an unreviewed OpenClaw version", () => {
  const root = fixture("2026.7.1-2");
  const result = spawnSync(process.execPath, [patchScript, root], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /version 2026\.7\.1-2 is not reviewed/);
});
