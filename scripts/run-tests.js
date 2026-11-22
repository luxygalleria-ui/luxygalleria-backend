#!/usr/bin/env node
/**
 * Runs every backend suite (src/tests/*.test.ts) one after another: `npm test`, or `npm test -- icici security` for a subset.
 * Isolation: each suite gets its own process, local-only database settings and blank provider credentials (dotenv
 * never overrides a variable that is already set, so the real .env cannot supply them), and the network guard below
 * refuses every connection that is not to this machine. Exit code 1 if any suite fails or times out.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dir = path.join(root, 'src', 'tests');
const only = process.argv.slice(2);
const suites = fs.readdirSync(dir).filter((f) => f.endsWith('.test.ts')).sort()
  .filter((f) => !only.length || only.some((o) => f.startsWith(o)));
if (!suites.length) { console.error('No test suites matched'); process.exit(1); }

const LOCAL_DB = 'mongodb://127.0.0.1:27017/luxy_test_runner';
const blank = ['SENDGRID_API_KEY', 'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET', 'NEXT_PUBLIC_RAZORPAY_KEY_ID',
  'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET', 'CLOUDINARY_CLOUD_NAME', 'GOOGLE_CLIENT_ID', 'NEXT_PUBLIC_GOOGLE_CLIENT_ID', 'ERP_API_KEYS',
  'ICICI_PG_INITIATE_SALE_URL', 'ICICI_PG_COMMAND_URL', 'ICICI_PG_MERCHANT_ID', 'ICICI_PG_SECRET_KEY', 'ICICI_PG_AGGREGATOR_ID',
  'ICICI_PG_RETURN_URL', 'ICICI_PG_UAT_TEST_USER_IDS', 'ICICI_PG_UAT_TEST_EMAILS', 'ICICI_PG_ALLOW_REAL_GATEWAY_IN_DEV',
  'HISTORY_READ_URI', 'HISTORY_READ_DB', 'MIGRATION_MONGO_URI', 'ADMIN_EMAIL', 'ADMIN_PASSWORD', 'ALLOW_PRODUCTION_DB_IN_DEV', 'API_URL'];
const env = { ...process.env, ...Object.fromEntries(blank.map((k) => [k, ''])), MONGO_URI: LOCAL_DB, MONGODB_URI: LOCAL_DB,
  HISTORY_READ_ENABLED: 'false', JWT_SECRET: 'test_runner_only_secret_0123456789abcdef', NODE_OPTIONS: `--require ${path.join(__dirname, 'test-network-guard.js')}` };
delete env.NODE_ENV; // each suite sets the mode it tests

const tsNode = require.resolve('ts-node/dist/bin.js', { paths: [root] });
const results = [];
for (const file of suites) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [tsNode, '--transpile-only', path.join('src', 'tests', file)], { cwd: root, env, encoding: 'utf8', timeout: 240_000, maxBuffer: 64 * 1024 * 1024 });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const ok = r.status === 0 && !r.error;
  const why = r.error ? (r.error.code === 'ETIMEDOUT' ? 'timed out' : r.error.message) : r.signal ? `killed by ${r.signal}` : `exit ${r.status}`;
  results.push({ file, ok, secs, why });
  console.log(`${ok ? '✅ PASS' : '❌ FAIL'}  ${file.padEnd(32)} ${secs.padStart(6)}s${ok ? '' : `  (${why})`}`);
  if (!ok) console.log(`----- output of ${file} -----\n${(r.stdout || '') + (r.stderr || '')}`.trimEnd() + '\n----- end -----');
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length} suites: ${results.length - failed.length} passed, ${failed.length} failed, 0 skipped`);
if (failed.length) console.log(`Failed: ${failed.map((f) => f.file).join(', ')}`);
process.exit(failed.length ? 1 : 0);
