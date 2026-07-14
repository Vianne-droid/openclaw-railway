#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const REVIEWED_VERSION = "2026.7.1";
const MARKER = "vianne-fast-native-hook-relay-v1";
const ORIGINAL = "const executable = params.executable ?? resolveOpenClawCliExecutable();";

function fail(message) {
  throw new Error(`[fast-native-hook-relay] ${message}`);
}

function findRelayFile(distDir) {
  const matches = fs.readdirSync(distDir)
    .filter((name) => /^native-hook-relay-.*\.js$/.test(name))
    .map((name) => path.join(distDir, name))
    .filter((file) => fs.readFileSync(file, "utf8").includes("function buildNativeHookRelayCommand(params)"));
  if (matches.length !== 1) {
    fail(`expected exactly one native hook relay bundle in ${distDir}, found ${matches.length}`);
  }
  return matches[0];
}

function copyClient(source, target, ownerSource) {
  const sourceBytes = fs.readFileSync(source);
  const targetBytes = fs.existsSync(target) ? fs.readFileSync(target) : undefined;
  if (!targetBytes || !sourceBytes.equals(targetBytes)) {
    const temporary = `${target}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, sourceBytes, { mode: 0o555 });
    fs.renameSync(temporary, target);
  }
  fs.chmodSync(target, 0o555);
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    const owner = fs.statSync(ownerSource);
    fs.chownSync(target, owner.uid, owner.gid);
  }
}

function verify(relayFile, clientTarget) {
  const content = fs.readFileSync(relayFile, "utf8");
  const replacement = `const executable = params.executable ?? ${JSON.stringify(clientTarget)}; /* ${MARKER} */`;
  if (!content.includes(replacement)) fail(`patched executable missing from ${relayFile}`);
  if (!fs.existsSync(clientTarget)) fail(`lightweight client missing from ${clientTarget}`);
  if (!fs.readFileSync(clientTarget, "utf8").includes("preserves OpenClaw's fail-closed PreToolUse behavior")) {
    fail(`lightweight client identity check failed for ${clientTarget}`);
  }
}

function main() {
  const args = process.argv.slice(2);
  const verifyOnly = args.includes("--verify");
  const moduleDir = args.find((arg) => arg !== "--verify");
  if (!moduleDir) fail("usage: patch-native-hook-relay.cjs <openclaw-module-dir> [--verify]");

  const packageFile = path.join(moduleDir, "package.json");
  const distDir = path.join(moduleDir, "dist");
  if (!fs.existsSync(packageFile) || !fs.existsSync(distDir)) {
    fail(`invalid OpenClaw module directory: ${moduleDir}`);
  }

  const version = JSON.parse(fs.readFileSync(packageFile, "utf8")).version;
  if (version !== REVIEWED_VERSION) {
    fail(`version ${version} is not reviewed; expected ${REVIEWED_VERSION}`);
  }

  const sourceClient = path.join(__dirname, "fast-native-hook-relay.mjs");
  const clientTarget = path.join(distDir, "fast-native-hook-relay.mjs");
  const relayFile = findRelayFile(distDir);
  const replacement = `const executable = params.executable ?? ${JSON.stringify(clientTarget)}; /* ${MARKER} */`;

  if (!verifyOnly) {
    if (!fs.existsSync(sourceClient)) fail(`source client missing: ${sourceClient}`);
    copyClient(sourceClient, clientTarget, packageFile);

    const before = fs.readFileSync(relayFile, "utf8");
    if (!before.includes(MARKER)) {
      const count = before.split(ORIGINAL).length - 1;
      if (count !== 1) fail(`expected one relay executable anchor in ${relayFile}, found ${count}`);
      fs.writeFileSync(relayFile, before.replace(ORIGINAL, replacement));
    }
  }

  verify(relayFile, clientTarget);
  console.log(`[fast-native-hook-relay] verified OpenClaw ${version}; ${verifyOnly ? "check only" : "patch applied"}: ${relayFile}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
