/**
 * Forgot / reset password: generic reply (no account enumeration), single-use hashed token with expiry, password rules,
 * sessions signed out after a reset, rate limits, and no token or password in any log. Mail goes to an in-memory mock
 * (sendEmail is replaced); nothing is sent. Uses (and drops) a throwaway local database.
 * Run: npx ts-node --transpile-only src/tests/passwordReset.test.ts
 */
import assert from 'assert';
import crypto from 'crypto';
import { AddressInfo } from 'net';

const TEST_DB = 'mongodb://127.0.0.1:27017/luxy_password_reset_test';
// Not "development": the rate limiters are active, as in production
Object.assign(process.env, { NODE_ENV: 'production', HISTORY_READ_ENABLED: 'false', SENDGRID_API_KEY: '', FRONTEND_URL: 'https://shop.test/' });

import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../app';
import { ENV } from '../config/env';
import { User } from '../models/User';
import * as mail from '../utils/sendEmail';
import { FORGOT_PASSWORD_REPLY, PASSWORD_RESET_TTL_MS, hashResetToken } from '../controllers/authController';

// ---- mock mailbox: sendEmail is replaced in memory (the controller calls it through the module object)
const outbox: { email: string; subject: string; message?: string; html?: string; sensitive?: boolean }[] = [];
const realSendEmail = mail.sendEmail;
(mail as any).sendEmail = async (o: any) => { outbox.push(o); return { success: true, provider: 'mock' }; };

// ---- every log line, to prove no token or password is ever written
const logged: string[] = [];
for (const level of ['log', 'info', 'warn', 'error'] as const) {
  const orig = console[level].bind(console);
  (console as any)[level] = (...a: unknown[]) => { logged.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); if (level === 'error') orig(...a); };
}

let passed = 0;
const test = async (name: string, fn: () => Promise<void>) => { await fn(); passed++; process.stdout.write(`  ✅ ${name}\n`); };

const run = async () => {
  assert.ok(TEST_DB.endsWith('_test'));
  await mongoose.connect(TEST_DB);
  await mongoose.connection.db!.dropDatabase();
  await User.init();
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  let ip = 0; // each test its own client IP (trust proxy 1), so the rate limiter is tested on purpose only
  const call = async (method: string, p: string, body?: unknown, opts: { token?: string; ip?: string } = {}) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': opts.ip ?? `10.7.0.${++ip}`,
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json: any = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, json, text, cookie: r.headers.get('set-cookie') };
  };
  const tokenFromMail = (m: { message?: string }) => (m.message?.match(/reset-password\?token=([a-f0-9]{64})/) || [])[1];
  const login = (email: string, password: string) => call('POST', '/auth/customer-login', { email, password });
  const STRONG = 'New-Passw0rd#2026';
  const OLD = 'Original-Passw0rd#1';
  const secrets: string[] = [STRONG, OLD];

  try {
    const ann = await User.create({ name: 'Ann', email: 'ann@test.local', password: OLD, role: 'customer', isVerified: true });
    await User.create({ name: 'Boss', email: 'boss@test.local', password: OLD, role: 'superadmin', isVerified: true });
    await User.create({ name: 'Gone', email: 'gone@test.local', password: OLD, role: 'customer', isVerified: true, isActive: false });

    await test('email format: invalid formats get a clear 400; a valid one the generic 200', async () => {
      for (const bad of ['', 'not-an-email', 'a@b', '@test.local', 'x y@test.local', 42]) {
        const r = await call('POST', '/auth/forgot-password', { email: bad });
        assert.deepStrictEqual([r.status, r.json?.message], [400, 'Please enter a valid email address.'], JSON.stringify(bad));
      }
      assert.strictEqual(outbox.length, 0);
    });

    await test('no account enumeration: unknown, staff and deactivated accounts get the exact same reply as a real customer, and no email', async () => {
      const replies: [number, string][] = [];
      for (const email of ['nobody@test.local', 'boss@test.local', 'gone@test.local']) {
        const r = await call('POST', '/auth/forgot-password', { email });
        replies.push([r.status, r.text]);
      }
      assert.strictEqual(outbox.length, 0, 'nothing sent for unknown / staff / deactivated');
      const real = await call('POST', '/auth/forgot-password', { email: 'ann@test.local' });
      replies.push([real.status, real.text]);
      assert.ok(replies.every(([s, t]) => s === 200 && t === replies[0][1]), 'identical status and body for all four');
      assert.strictEqual(real.json.message, FORGOT_PASSWORD_REPLY);
      assert.strictEqual(outbox.length, 1, 'one email for the real customer');
    });

    let token = '';
    await test('existing account: the mock email carries a single reset link to the storefront, marked sensitive', async () => {
      const m = outbox[0];
      assert.strictEqual(m.email, 'ann@test.local');
      assert.strictEqual(m.sensitive, true, 'body never logged');
      token = tokenFromMail(m)!;
      assert.match(token, /^[a-f0-9]{64}$/, '256-bit hex token');
      assert.ok(m.message!.includes(`https://shop.test/reset-password?token=${token}`) && m.html!.includes(token));
      secrets.push(token);
    });

    await test('only a hash of the token is stored (never the token), with a 30-minute expiry; API replies never contain it', async () => {
      const doc: any = await mongoose.connection.db!.collection('users').findOne({ _id: ann._id });
      assert.strictEqual(doc.passwordResetTokenHash, hashResetToken(token));
      assert.ok(!JSON.stringify(doc).includes(token), 'raw token nowhere in the user document');
      const ttl = new Date(doc.passwordResetExpires).getTime() - Date.now();
      assert.ok(ttl > PASSWORD_RESET_TTL_MS - 60_000 && ttl <= PASSWORD_RESET_TTL_MS, `expiry ~30 min (${ttl} ms)`);
      const viaModel: any = await User.findById(ann._id).lean();
      assert.ok(!('passwordResetTokenHash' in viaModel) && !('passwordResetExpires' in viaModel), 'hash/expiry not selected by default');
    });

    await test('asking again within a minute keeps the link already sent (no inbox flooding)', async () => {
      const r = await call('POST', '/auth/forgot-password', { email: 'ann@test.local' });
      assert.deepStrictEqual([r.status, r.json.message, outbox.length], [200, FORGOT_PASSWORD_REPLY, 1]);
    });

    await test('invalid tokens are refused: malformed, unknown, and the token of nobody', async () => {
      for (const bad of ['', 'abc', 'Z'.repeat(64), crypto.randomBytes(32).toString('hex'), token.toUpperCase()]) {
        const r = await call('POST', '/auth/reset-password', { token: bad, password: STRONG, confirmPassword: STRONG });
        assert.deepStrictEqual([r.status, r.json?.message], [400, 'This reset link is invalid or has expired. Please request a new one.'], bad.slice(0, 8));
      }
    });

    await test('mismatched or weak passwords are refused and do NOT use up the link', async () => {
      const mismatch = await call('POST', '/auth/reset-password', { token, password: STRONG, confirmPassword: STRONG + 'x' });
      assert.deepStrictEqual([mismatch.status, mismatch.json.message], [400, 'The two passwords do not match.']);
      for (const [weak, msg] of [['alllowercase1!', /uppercase/], ['ALLUPPERCASE1!', /lowercase/], ['NoNumbers!!', /number/], ['NoSymbols123', /special/], ['Ab1!', /8 characters/], ['', /8 characters/]] as const) {
        const r = await call('POST', '/auth/reset-password', { token, password: weak, confirmPassword: weak });
        assert.strictEqual(r.status, 400, weak);
        assert.match(r.json?.message || '', msg, weak);
      }
      const doc: any = await mongoose.connection.db!.collection('users').findOne({ _id: ann._id });
      assert.strictEqual(doc.passwordResetTokenHash, hashResetToken(token), 'link still valid after refused attempts');
    });

    let oldSession = '';
    await test('a session from before the reset exists and works (to be signed out below)', async () => {
      const r = await login('ann@test.local', OLD);
      assert.strictEqual(r.status, 200);
      oldSession = r.json.data.token;
      assert.strictEqual((await call('GET', '/users/profile', undefined, { token: oldSession })).status, 200);
      await new Promise((res) => setTimeout(res, 1100)); // the reset happens in a later second than this token's iat
    });

    await test('successful reset: 200 with a clear message; no token, password or hash in the reply; never logged in; cookie cleared', async () => {
      const r = await call('POST', '/auth/reset-password', { token, password: STRONG, confirmPassword: STRONG });
      assert.deepStrictEqual([r.status, r.json.message], [200, 'Your password has been reset. Please sign in with your new password.']);
      assert.strictEqual(r.json.data, null, 'no session or user data returned');
      for (const s of [token, STRONG, '$2']) assert.ok(!r.text.includes(s), `reply free of ${s.slice(0, 4)}…`);
      assert.match(r.cookie || '', /jwt=;/, 'any session cookie cleared');
      const doc: any = await mongoose.connection.db!.collection('users').findOne({ _id: ann._id });
      assert.ok(!doc.passwordResetTokenHash && !doc.passwordResetExpires, 'token removed');
      assert.ok(doc.password.startsWith('$2') && doc.password !== STRONG, 'stored as a bcrypt hash');
      assert.ok(doc.passwordChangedAt, 'passwordChangedAt set');
    });

    await test('the same link cannot be used again', async () => {
      const r = await call('POST', '/auth/reset-password', { token, password: 'Another-Passw0rd#3', confirmPassword: 'Another-Passw0rd#3' });
      assert.strictEqual(r.status, 400);
      assert.strictEqual((await login('ann@test.local', 'Another-Passw0rd#3')).status, 401);
    });

    await test('new password signs in; old password no longer does', async () => {
      assert.strictEqual((await login('ann@test.local', STRONG)).status, 200);
      assert.strictEqual((await login('ann@test.local', OLD)).status, 401);
    });

    await test('sessions issued before the reset are signed out; a new sign-in works', async () => {
      const old = await call('GET', '/users/profile', undefined, { token: oldSession });
      assert.deepStrictEqual([old.status, old.json?.errors?.code, old.json?.message], [401, 'PASSWORD_CHANGED', 'Your password was changed. Please sign in again.']);
      const fresh = (await login('ann@test.local', STRONG)).json.data.token;
      assert.strictEqual((await call('GET', '/users/profile', undefined, { token: fresh })).status, 200);
      // a token without iat (forged shapes, old formats) is refused once a password change exists
      const noIat = jwt.sign({ id: String(ann._id), role: 'customer' }, ENV.JWT_SECRET, { noTimestamp: true });
      assert.strictEqual((await call('GET', '/users/profile', undefined, { token: noIat })).status, 401);
    });

    await test('an expired link is refused (and a fresh request then works)', async () => {
      outbox.length = 0;
      await User.updateOne({ _id: ann._id }, { $unset: { passwordResetExpires: 1 } }); // no "just sent" guard
      await call('POST', '/auth/forgot-password', { email: 'ann@test.local' });
      const t2 = tokenFromMail(outbox[0])!; secrets.push(t2);
      await mongoose.connection.db!.collection('users').updateOne({ _id: ann._id }, { $set: { passwordResetExpires: new Date(Date.now() - 1000) } });
      const r = await call('POST', '/auth/reset-password', { token: t2, password: 'Expired-Passw0rd#4', confirmPassword: 'Expired-Passw0rd#4' });
      assert.strictEqual(r.status, 400, 'expired');
      assert.strictEqual((await login('ann@test.local', STRONG)).status, 200, 'password unchanged');
    });

    await test('two simultaneous uses of one link: exactly one succeeds', async () => {
      outbox.length = 0;
      await User.updateOne({ _id: ann._id }, { $unset: { passwordResetExpires: 1, passwordResetTokenHash: 1 } });
      await call('POST', '/auth/forgot-password', { email: 'ann@test.local' });
      const t3 = tokenFromMail(outbox[0])!; secrets.push(t3);
      const pw = ['Race-Passw0rd#5A', 'Race-Passw0rd#5B'];
      const rs = await Promise.all(pw.map((p) => call('POST', '/auth/reset-password', { token: t3, password: p, confirmPassword: p })));
      assert.deepStrictEqual(rs.map((r) => r.status).sort(), [200, 400]);
      const winner = pw[rs.findIndex((r) => r.status === 200)];
      assert.strictEqual((await login('ann@test.local', winner)).status, 200);
      secrets.push(...pw);
    });

    await test('rate limits: the 6th reset request and the 11th reset attempt from one IP within 15 minutes get 429', async () => {
      const before = outbox.length;
      const f = [];
      for (let i = 0; i < 6; i++) f.push((await call('POST', '/auth/forgot-password', { email: 'nobody@test.local' }, { ip: '10.9.9.1' })).status);
      assert.deepStrictEqual(f, [200, 200, 200, 200, 200, 429]);
      const r = [];
      for (let i = 0; i < 11; i++) r.push((await call('POST', '/auth/reset-password', { token: 'x', password: 'a', confirmPassword: 'a' }, { ip: '10.9.9.2' })).status);
      assert.deepStrictEqual(r.slice(-2), [400, 429]);
      assert.strictEqual(outbox.length, before);
    });

    await test('the real sendEmail never prints a sensitive body, even in development without SendGrid', async () => {
      const n = logged.length;
      const prev = process.env.NODE_ENV; process.env.NODE_ENV = 'development';
      try { await realSendEmail({ email: 'x@test.local', subject: 'Reset your Luxy Galleria password', message: 'https://shop.test/reset-password?token=SECRETTOKEN', sensitive: true }); }
      finally { process.env.NODE_ENV = prev; }
      const lines = logged.slice(n).join('\n');
      assert.ok(!lines.includes('SECRETTOKEN') && !lines.includes('x@test.local'), 'no body, no full address');
      assert.match(lines, /Email not sent \(SendGrid not configured\): "Reset your Luxy Galleria password" to x\*\*\*@test\.local/);
    });

    await test('no reset token or password appears in any log line written during these tests', async () => {
      const all = logged.join('\n');
      for (const s of secrets) assert.ok(!all.includes(s), `log free of ${s.slice(0, 6)}…`);
    });

    process.stdout.write(`\n${passed} passed\n`);
  } finally {
    server.close();
    await mongoose.connection.db!.dropDatabase();
    await mongoose.disconnect();
  }
};

run().catch((e) => { console.error('❌', e); process.exit(1); });
