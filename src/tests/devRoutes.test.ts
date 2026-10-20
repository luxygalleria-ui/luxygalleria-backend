/**
 * Regression test: the removed development helpers stay gone, and NODE_ENV fails closed.
 * No database needed. Run: npm run test:dev-routes
 */
import assert from 'assert';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { AddressInfo } from 'net';

process.env.NODE_ENV = 'development'; // the most permissive mode: the routes must not exist even here
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);

import app from '../app';

let passed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
  await fn();
  passed++;
  console.log(`  ✅ ${name}`);
};

/** ENV.NODE_ENV as seen by a fresh process with the given NODE_ENV, run outside the repo so no .env is loaded. */
const resolvedEnv = (nodeEnv: string | undefined, jwtSecret = 'y'.repeat(40)) => {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, JWT_SECRET: jwtSecret, TS_NODE_PROJECT: path.resolve(__dirname, '../../tsconfig.json') };
  if (nodeEnv !== undefined) env.NODE_ENV = nodeEnv;
  const envModule = path.resolve(__dirname, '../config/env');
  const r = spawnSync(process.execPath, ['-r', require.resolve('ts-node/register/transpile-only'), '-e', `console.log(require(${JSON.stringify(envModule)}).ENV.NODE_ENV)`], {
    cwd: os.tmpdir(), env, encoding: 'utf8',
  });
  return { status: r.status, out: r.stdout.trim().split('\n').pop(), err: r.stderr };
};

const run = async () => {
  const server = app.listen(0);
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  console.log('\nRemoved development routes');
  await test('setup-test-admin, fix-user-password and debug-users are 404 even with NODE_ENV=development', async () => {
    const body = JSON.stringify({ email: 'admin@luxygalleria.com', newPassword: 'Attacker#123' });
    const headers = { 'Content-Type': 'application/json' };
    assert.strictEqual((await fetch(`${origin}/api/v1/auth/setup-test-admin`, { method: 'POST', headers, body: '{}' })).status, 404);
    assert.strictEqual((await fetch(`${origin}/api/v1/auth/fix-user-password`, { method: 'POST', headers, body })).status, 404);
    assert.strictEqual((await fetch(`${origin}/api/v1/auth/debug-users`)).status, 404);
  });
  server.close();

  console.log('\nNODE_ENV fails closed');
  await test('unset NODE_ENV runs as production', () => assert.strictEqual(resolvedEnv(undefined).out, 'production'));
  await test('unknown NODE_ENV values run as production', () => {
    for (const v of ['dev', 'staging', 'Development', '']) assert.strictEqual(resolvedEnv(v).out, 'production', v);
  });
  await test('only an exact NODE_ENV=development enables development', () => assert.strictEqual(resolvedEnv('development').out, 'development'));
  await test('without NODE_ENV, a missing JWT_SECRET stops startup instead of using the dev secret', () => {
    const r = resolvedEnv(undefined, '');
    assert.notStrictEqual(r.status, 0);
    assert.match(r.err, /JWT_SECRET must be set outside development/);
  });

  console.log(`\n=== Summary: ${passed} passed, 0 failed ===`);
};

run().catch((err) => {
  console.error('\n❌ FAILED:', err);
  process.exit(1);
});
