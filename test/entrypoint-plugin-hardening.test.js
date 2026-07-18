import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = join(fileURLToPath(new URL('..', import.meta.url)));
const entrypoint = readFileSync(join(repoRoot, 'entrypoint.sh'), 'utf8');

test('packaging-only core hotfixes keep channel plugins on the published base release', () => {
  assert.match(
    entrypoint,
    /PLUGIN_RELEASE_VERSION="\$EFFECTIVE_CORE_VERSION"[\s\S]*\^\(\[0-9\]\{4\}\\\.\[0-9\]\+\\\.\[0-9\]\+\)-\[0-9\]\+\$/,
  );
  assert.match(entrypoint, /plugins_to_sync\+=\("\$pkg@\$PLUGIN_RELEASE_VERSION"\)/);
  assert.match(entrypoint, /LLAMA_CPP_PACKAGE@\$PLUGIN_RELEASE_VERSION/);
  assert.doesNotMatch(entrypoint, /plugins_to_sync\+=\("\$pkg@\$EFFECTIVE_CORE_VERSION"\)/);
});

test('required plugin discovery covers generation-specific managed projects', () => {
  assert.match(
    entrypoint,
    /npm\/projects\/openclaw-"\$pkg_slug"-\*\/node_modules\/"\$pkg"\/package\.json/,
  );
});

test('trusted plugin ownership is repaired after the exact Codex sync', () => {
  for (const extension of [
    'conversation-logger',
    'gati-sje-direct',
    'headroom',
    'latency-shield',
    'llama-cpp',
    'vilix-memory-hook',
  ]) {
    assert.match(entrypoint, new RegExp(`extensions/${extension.replace('-', '\\-')}`));
  }

  assert.match(
    entrypoint,
    /npm\/projects"\/openclaw-\*\/node_modules\/@openclaw\/\*/,
  );

  const codexSync = entrypoint.indexOf('openclaw plugins install @openclaw/codex@$CORE_VER --force');
  const finalRepair = entrypoint.lastIndexOf('\nrepair_trusted_plugin_code_ownership\n');
  assert.ok(codexSync >= 0, 'exact Codex version sync must remain present');
  assert.ok(finalRepair > codexSync, 'ownership repair must run after the Codex installer');
});
