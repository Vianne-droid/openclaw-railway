#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const REVIEWED_VERSIONS = new Set(["2026.7.1", "2026.7.1-1"]);
const MARKER = "vianne-empty-final:last-tool-error";
const LEGACY_ANCHOR =
  "params.attempt.didSendDeterministicApprovalPrompt || params.attempt.lastToolError) return null;";
const PATCHED_ANCHOR =
  `params.attempt.didSendDeterministicApprovalPrompt || ` +
  `params.attempt.lastToolError && params.payloadCount !== 0 /* ${MARKER} */) return null;`;

function fail(message) {
  throw new Error(`[empty-final] ${message}`);
}

function parseArgs(argv) {
  const args = [...argv];
  let check = false;
  let backupDir;
  let moduleDir;
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--check") {
      check = true;
      continue;
    }
    if (arg === "--backup-dir") {
      backupDir = args.shift();
      if (!backupDir) fail("--backup-dir requires a path");
      continue;
    }
    if (arg.startsWith("--")) fail(`unknown option: ${arg}`);
    if (moduleDir) fail("expected exactly one OpenClaw module directory");
    moduleDir = arg;
  }
  if (!moduleDir) {
    fail("usage: patch-empty-final.cjs [--check] [--backup-dir DIR] <openclaw-module-dir>");
  }
  return { backupDir, check, moduleDir: path.resolve(moduleDir) };
}

function count(content, anchor) {
  return content.split(anchor).length - 1;
}

function findTarget(distDir) {
  const matches = fs
    .readdirSync(distDir)
    .filter((name) => /^selection-.*\.js$/.test(name))
    .map((name) => path.join(distDir, name))
    .filter((file) => {
      const content = fs.readFileSync(file, "utf8");
      return content.includes(LEGACY_ANCHOR) || content.includes(MARKER);
    });
  if (matches.length !== 1) {
    fail(`expected exactly one incomplete-turn bundle in ${distDir}, found ${matches.length}`);
  }
  return matches[0];
}

function verify(file) {
  const content = fs.readFileSync(file, "utf8");
  if (count(content, MARKER) !== 1) fail(`patch marker missing or duplicated in ${file}`);
  if (count(content, PATCHED_ANCHOR) !== 1) fail(`patched guard missing or duplicated in ${file}`);
  if (content.includes(LEGACY_ANCHOR)) fail(`legacy silent-drop guard remains in ${file}`);
  if (!content.includes("Agent couldn't generate a response. Please try again.")) {
    fail(`incomplete-turn user notice missing from ${file}`);
  }
}

function backupFile(file, backupDir) {
  if (!backupDir) return undefined;
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const pathKey = crypto.createHash("sha256").update(file).digest("hex").slice(0, 12);
  const target = path.join(backupDir, `${path.basename(file)}.${pathKey}.bak`);
  if (!fs.existsSync(target)) fs.copyFileSync(file, target, fs.constants.COPYFILE_EXCL);
  return target;
}

function atomicWritePreservingMetadata(file, content) {
  const metadata = fs.statSync(file);
  const temp = `${file}.empty-final-${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, content, { mode: metadata.mode });
    fs.chmodSync(temp, metadata.mode);
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      fs.chownSync(temp, metadata.uid, metadata.gid);
    }
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function main() {
  const { backupDir, check, moduleDir } = parseArgs(process.argv.slice(2));
  const packageFile = path.join(moduleDir, "package.json");
  const distDir = path.join(moduleDir, "dist");
  if (!fs.existsSync(packageFile) || !fs.existsSync(distDir)) {
    fail(`invalid OpenClaw module directory: ${moduleDir}`);
  }

  const version = JSON.parse(fs.readFileSync(packageFile, "utf8")).version;
  if (!REVIEWED_VERSIONS.has(version)) {
    fail(`version ${version} is not reviewed; expected ${[...REVIEWED_VERSIONS].join(" or ")}`);
  }

  const target = findTarget(distDir);
  const before = fs.readFileSync(target, "utf8");
  let changed = false;
  let backup;
  if (!before.includes(MARKER)) {
    if (check) fail(`patch is missing from ${target}`);
    if (count(before, LEGACY_ANCHOR) !== 1) {
      fail(`expected one legacy silent-drop guard in ${target}, found ${count(before, LEGACY_ANCHOR)}`);
    }
    backup = backupFile(target, backupDir);
    atomicWritePreservingMetadata(target, before.replace(LEGACY_ANCHOR, PATCHED_ANCHOR));
    changed = true;
  }

  verify(target);
  console.log(
    `[empty-final] verified OpenClaw ${version}; patched files=${changed ? 1 : 0}; ` +
      `target=${target}${backup ? `; backup=${backup}` : ""}`,
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
