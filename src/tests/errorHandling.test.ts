/**
 * Error responses and error logs never leak: no query string in logs or 404 bodies, no raw error objects or
 * connection-string credentials in error-trace.log, a generic message for unexpected 5xx outside development (also
 * when NODE_ENV is UNSET), 4xx messages kept, stack only in development. Also: mock payments, the email console
 * fallback and the production build config. No database, no network; error-trace.log is written to a temp folder.
 * Run: npx ts-node --transpile-only src/tests/errorHandling.test.ts
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import express from 'express';
import type { AddressInfo } from 'net';

const repo = path.join(__dirname, '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'luxy-errors-'));
process.chdir(tmp); // errorHandler appends to <cwd>/error-trace.log
Object.assign(process.env, { JWT_SECRET: process.env.JWT_SECRET || 'error_handling_test_secret_0123456789', HISTORY_READ_ENABLED: 'false' });

import { errorHandler } from '../middlewares/errorHandler';
import { notFoundHandler } from '../middlewares/notFoundHandler';
import { sendEmail } from '../utils/sendEmail';
import realApp from '../app';
import { isMockPaymentMode } from '../controllers/paymentController';

const SECRET_QUERY = 'otp=482913&token=eyJhbGciOiJIUzI1NiJ9.secret&secureHash=deadbeef';
const DB_LEAK = 'connect failed mongodb+srv://shop_user:S3cretPass99@cluster0.abc.mongodb.net/luxy';

const app = express();
app.get('/boom', () => { throw Object.assign(new Error(DB_LEAK), { code: 'EDBDOWN', config: { headers: { Authorization: 'Bearer leaked-token' } } }); });
app.get('/forbidden', () => { throw Object.assign(new Error('Not allowed by CORS'), { statusCode: 403 }); });
app.post('/json', express.json(), (_req, res) => { res.json({ ok: true }); });
app.use(notFoundHandler);
app.use(errorHandler);

let passed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => { await fn(); passed++; console.log(`  ✅ ${name}`); };

/** Runs fn with NODE_ENV set (undefined = unset) and console.warn/error captured; restores both. */
const capture = async <T>(nodeEnv: string | undefined, fn: () => Promise<T>) => {
  const saved = { env: process.env.NODE_ENV, warn: console.warn, error: console.error, log: console.log };
  const lines: string[] = [];
  const keep = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  nodeEnv === undefined ? delete process.env.NODE_ENV : (process.env.NODE_ENV = nodeEnv);
  console.warn = keep; console.error = keep; console.log = keep;
  try { return { result: await fn(), log: lines.join('\n') }; } finally {
    saved.env === undefined ? delete process.env.NODE_ENV : (process.env.NODE_ENV = saved.env);
    Object.assign(console, { warn: saved.warn, error: saved.error, log: saved.log });
  }
};

const run = async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (p: string, init?: RequestInit) => { const r = await fetch(base + p, init); return { status: r.status, body: await r.json() as any }; };
  const trace = () => (fs.existsSync('error-trace.log') ? fs.readFileSync('error-trace.log', 'utf8') : '');
  try {
    for (const mode of ['production', undefined] as const) {
      const label = mode ?? 'UNSET';
      await test(`500 with NODE_ENV ${label}: generic message, no stack, nothing from the error in the body`, async () => {
        const { result: r } = await capture(mode, () => call(`/boom?${SECRET_QUERY}`));
        assert.strictEqual(r.status, 500);
        assert.deepStrictEqual(r.body, { success: false, message: 'Internal Server Error', errors: null });
      });
    }
    await test('500 log and error-trace.log: path without query, no credentials, no raw error object', async () => {
      fs.rmSync('error-trace.log', { force: true });
      const { log } = await capture('production', () => call(`/boom?${SECRET_QUERY}`));
      for (const text of [log, trace()]) {
        assert.match(text, /GET \/boom Error code=EDBDOWN/);
        assert.match(text, /mongodb\+srv:\/\/<redacted>@cluster0/);
        for (const leak of ['482913', 'eyJhbGci', 'deadbeef', 'S3cretPass99', 'shop_user', 'leaked-token', 'Authorization', '?']) {
          assert.ok(!text.includes(leak), `log contains ${leak}`);
        }
      }
    });
    await test('4xx keeps its client-facing message; its log line has no query string', async () => {
      const { result: r, log } = await capture('production', () => call(`/forbidden?${SECRET_QUERY}`));
      assert.deepStrictEqual([r.status, r.body.message], [403, 'Not allowed by CORS']);
      assert.ok(log.includes('403 GET /forbidden ') && !log.includes('482913') && !log.includes('?'), log);
    });
    await test('malformed JSON body: 400 with the parser message, not a 500', async () => {
      const { result: r } = await capture('production', () => call('/json', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"a":' }));
      assert.strictEqual(r.status, 400);
      assert.notStrictEqual(r.body.message, 'Internal Server Error');
    });
    await test('development only: the real message and stack are returned', async () => {
      const { result: r } = await capture('development', () => call('/boom'));
      assert.strictEqual(r.status, 500);
      assert.ok(r.body.message.startsWith('connect failed'));
      assert.match(String(r.body.errors), /at /, 'stack trace');
    });
    await test('404: fixed message, the URL and its query are not echoed', async () => {
      const r = await call(`/api/v1/nope?${SECRET_QUERY}`);
      assert.deepStrictEqual([r.status, r.body], [404, { success: false, message: 'Route not found', errors: null }]);
    });
    await test('404 from the real app has the same safe body', async () => {
      const real = realApp.listen(0, '127.0.0.1');
      await new Promise((r) => real.once('listening', r));
      try {
        const r = await fetch(`http://127.0.0.1:${(real.address() as AddressInfo).port}/api/v1/does-not-exist?${SECRET_QUERY}`);
        const body = await r.json() as any;
        assert.deepStrictEqual([r.status, body.message], [404, 'Route not found']);
        assert.ok(!JSON.stringify(body).includes('482913'));
      } finally { real.close(); }
    });

    await test('email without SendGrid outside development: no body, no OTP, masked address', async () => {
      for (const mode of ['production', undefined]) {
        const { log } = await capture(mode, () => sendEmail({ email: 'customer@example.com', subject: 'Your code', message: 'Your code is 482913', html: '<b>482913</b>' }));
        assert.ok(!log.includes('482913') && !log.includes('customer@example.com'), log);
        assert.match(log, /c\*\*\*@example\.com/);
      }
    });
    await test('email without SendGrid in development: still printed for local testing', async () => {
      const { log } = await capture('development', () => sendEmail({ email: 'dev@example.com', subject: 'Your code', message: 'Your code is 482913' }));
      assert.ok(log.includes('482913'));
    });

    await test('mock payments only in exact development, never with NODE_ENV unset or production', async () => {
      const keys = ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET'] as const;
      const saved = keys.map((k) => process.env[k]);
      keys.forEach((k) => delete process.env[k]);
      try {
        for (const [mode, expected] of [['development', true], [undefined, false], ['production', false], ['staging', false]] as const) {
          const { result } = await capture(mode, async () => isMockPaymentMode());
          assert.strictEqual(result, expected, `NODE_ENV ${mode ?? 'UNSET'}`);
        }
      } finally { keys.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i]))); }
    });

    await test('production build config leaves src/tests out and keeps server, app and scripts', async () => {
      const tsc = require.resolve('typescript/bin/tsc', { paths: [repo] });
      const files = execFileSync(process.execPath, [tsc, '-p', path.join(repo, 'tsconfig.build.json'), '--listFilesOnly'], { encoding: 'utf8' })
        .split('\n').map((f) => path.relative(repo, f)).filter((f) => f.startsWith('src'));
      assert.ok(!files.some((f) => f.startsWith(path.join('src', 'tests'))), 'a test file is in the production build');
      for (const f of ['src/server.ts', 'src/app.ts', 'src/scripts/diagnoseErpKeys.ts']) assert.ok(files.includes(f), `${f} missing from the build`);
      const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
      assert.strictEqual(pkg.scripts.build, 'tsc -p tsconfig.build.json');
      assert.strictEqual(pkg.scripts.start, 'node dist/server.js');
    });

    console.log(`\n${passed} passed`);
  } finally {
    server.close();
    process.chdir(repo);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
};

run().then(() => process.exit(0), (err) => { console.error('❌', err); process.exit(1); });
