#!/usr/bin/env node

// Stable JavaScript entrypoint for the Phase 2 migration.
// The replay implementation is shared with the application's TypeScript
// services; this wrapper is the operator-facing migration command.

const path = require('path');
const { spawnSync } = require('child_process');

const backendDir = path.resolve(__dirname, '..', '..');
const replayScript = path.join(backendDir, 'src', 'scripts', 'phase2', 'bulk_ledger_replay.ts');

const result = spawnSync(process.execPath, [
  '-r',
  'ts-node/register/transpile-only',
  replayScript,
  ...process.argv.slice(2),
], {
  cwd: backendDir,
  env: process.env,
  stdio: 'inherit',
});

if (result.error) {
  console.error(`Unable to start Phase 2 replay: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status === null ? 1 : result.status);
