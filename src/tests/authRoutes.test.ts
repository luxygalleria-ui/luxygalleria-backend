/**
 * Removed debug/setup routes stay unavailable (even in NODE_ENV=development, where they used to answer), and the real
 * auth flows still work: register, customer login, admin login, OTP resend/verify, token on a protected route, seedAdmin.
 * Needs a local MongoDB; uses (and drops) a throwaway database. No email is sent (no SendGrid key). No network.
 * Run: npx ts-node --transpile-only src/tests/authRoutes.test.ts
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { AddressInfo } from 'net';

const TEST_DB = 'mongodb://127.0.0.1:27017/luxy_auth_routes_test';
Object.assign(process.env, { NODE_ENV: 'development', HISTORY_READ_ENABLED: 'false', SENDGRID_API_KEY: '' });

import mongoose from 'mongoose';
import app from '../app';
import { User } from '../models/User';
import { seedAdmin } from '../utils/seedAdmin';
import * as authController from '../controllers/authController';

let passed = 0;
const test = async (name: string, fn: () => Promise<void>) => { await fn(); passed++; console.log(`  ✅ ${name}`); };

const run = async () => {
  assert.ok(TEST_DB.endsWith('_test'));
  await mongoose.connect(TEST_DB);
  await mongoose.connection.db!.dropDatabase();
  await User.init();
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const call = async (method: string, p: string, body?: unknown, token?: string) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json: any = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, json, text };
  };

  try {
    const PW = 'Original-Passw0rd#1';
    const ann = await User.create({ name: 'Ann', email: 'ann@test.local', password: PW, role: 'customer', isVerified: true });
    await User.create({ name: 'Boss', email: 'boss@test.local', password: PW, role: 'superadmin', isVerified: true });
    await User.updateOne({ _id: ann._id }, { $set: { otp: '123456', otpExpires: new Date(Date.now() + 60_000) } }); // an OTP the old route leaked

    console.log('Removed debug routes');
    await test('GET /auth/debug-users is gone (404) in development, in any spelling; lists nothing', async () => {
      for (const p of ['/auth/debug-users', '/auth/debug-users/', '/AUTH/DEBUG-USERS', '/auth/debug-users?all=1']) {
        const r = await call('GET', p);
        assert.strictEqual(r.status, 404, `${p} -> ${r.status}`);
        assert.ok(!r.text.includes('ann@test.local') && !r.text.includes('123456'), `${p} leaked user data`);
      }
    });

    await test('POST /auth/fix-user-password is gone (404) and the password is unchanged', async () => {
      for (const p of ['/auth/fix-user-password', '/auth/fix-user-password/', '/AUTH/FIX-USER-PASSWORD']) {
        const r = await call('POST', p, { email: 'ann@test.local', newPassword: 'Hijacked-Passw0rd#1' });
        assert.strictEqual(r.status, 404, `${p} -> ${r.status}`);
      }
      assert.strictEqual((await call('POST', '/auth/customer-login', { email: 'ann@test.local', password: 'Hijacked-Passw0rd#1' })).status, 401);
      assert.strictEqual((await call('POST', '/auth/customer-login', { email: 'ann@test.local', password: PW })).status, 200);
    });

    await test('POST /auth/setup-test-admin is gone (404) in development; the superadmin password is not reset or returned', async () => {
      for (const p of ['/auth/setup-test-admin', '/auth/setup-test-admin/', '/AUTH/SETUP-TEST-ADMIN']) {
        const r = await call('POST', p, {});
        assert.strictEqual(r.status, 404, `${p} -> ${r.status}`);
        assert.ok(!r.text.includes('password123') && !/"password"/.test(r.text), `${p} returned a password`);
      }
      assert.strictEqual((await call('GET', '/auth/setup-test-admin')).status, 404);
      assert.strictEqual((await call('POST', '/auth/login', { email: 'boss@test.local', password: PW })).status, 200, 'superadmin keeps its password');
      assert.strictEqual((await call('POST', '/auth/login', { email: 'boss@test.local', password: 'password123' })).status, 401);
      assert.ok(!('createTestAdmin' in authController), 'handler removed from authController');
    });

    await test('no route file registers a debug-users, fix-user-password or setup-test-admin handler', async () => {
      const dir = path.join(__dirname, '../routes');
      for (const f of fs.readdirSync(dir)) {
        const src = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
        assert.ok(!/debug-users|fix-user-password|setup-test-admin|createTestAdmin/.test(src), `${f} still registers a removed route`);
      }
    });

    console.log('Real auth flows still work');
    let token = '';
    await test('register -> token -> protected route', async () => {
      const r = await call('POST', '/auth/register', { name: 'Cara', email: 'cara@test.local', password: 'Cara-Passw0rd#1' });
      assert.ok([200, 201].includes(r.status), `register ${r.status} ${r.text.slice(0, 120)}`);
      token = r.json?.data?.token;
      assert.ok(token, 'token returned');
      assert.strictEqual((await call('GET', '/users/profile', undefined, token)).status, 200);
      assert.strictEqual((await call('POST', '/auth/register', { name: 'Cara', email: 'cara@test.local', password: 'x-Passw0rd#1' })).status, 400, 'duplicate refused');
    });

    await test('customer login: right password 200 + working token, wrong 401, staff account refused', async () => {
      const ok = await call('POST', '/auth/customer-login', { email: 'ann@test.local', password: PW });
      assert.strictEqual(ok.status, 200);
      assert.strictEqual((await call('GET', '/users/profile', undefined, ok.json.data.token)).status, 200);
      assert.strictEqual((await call('POST', '/auth/customer-login', { email: 'ann@test.local', password: 'wrong' })).status, 401);
      assert.strictEqual((await call('POST', '/auth/customer-login', { email: 'boss@test.local', password: PW })).status, 403);
    });

    await test('admin login works', async () => {
      const r = await call('POST', '/auth/login', { email: 'boss@test.local', password: PW });
      assert.strictEqual(r.status, 200, r.text.slice(0, 120));
      assert.ok(r.json?.data?.token || r.json?.token, 'admin token returned');
    });

    await test('OTP: resend (no code in the response) -> wrong code 400 -> right code 200 + token', async () => {
      await User.create({ name: 'Dev', email: 'dev@test.local', password: 'Dev-Passw0rd#1', role: 'customer', isVerified: false });
      const resend = await call('POST', '/auth/resend-otp', { email: 'dev@test.local' });
      assert.strictEqual(resend.status, 200, resend.text.slice(0, 120));
      const otp = (await User.findOne({ email: 'dev@test.local' }).lean())!.otp!;
      assert.match(otp, /^\d{6}$/);
      assert.ok(!resend.text.includes(otp), 'OTP never returned');
      assert.strictEqual((await call('POST', '/auth/verify-otp', { email: 'dev@test.local', otp: otp === '000000' ? '111111' : '000000' })).status, 400);
      const ok = await call('POST', '/auth/verify-otp', { email: 'dev@test.local', otp });
      assert.strictEqual(ok.status, 200, ok.text.slice(0, 120));
      assert.strictEqual((await call('GET', '/users/profile', undefined, ok.json.data.token)).status, 200);
      assert.strictEqual((await call('POST', '/auth/resend-otp', { email: 'dev@test.local' })).status, 400, 'already verified');
    });

    console.log('Session cookie');
    await test('jwt cookie is Secure unless NODE_ENV is exactly development (unset, staging, Production, typos fail safe)', async () => {
      const saved = process.env.NODE_ENV;
      try {
        for (const [mode, secure] of [['development', false], ['production', true], [undefined, true], ['staging', true], ['Production', true], ['prod', true]] as const) {
          mode === undefined ? delete process.env.NODE_ENV : (process.env.NODE_ENV = mode);
          for (const [p, email] of [['/auth/customer-login', 'ann@test.local'], ['/auth/login', 'boss@test.local']]) {
            const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
            const cookie = r.headers.get('set-cookie') || '';
            assert.strictEqual(r.status, 200, `${p} NODE_ENV=${mode ?? 'UNSET'}`);
            assert.match(cookie, /^jwt=.*HttpOnly/i, 'jwt cookie set, HttpOnly');
            assert.strictEqual(/;\s*Secure/i.test(cookie), secure, `${p} NODE_ENV=${mode ?? 'UNSET'}: Secure should be ${secure}`);
          }
        }
      } finally { saved === undefined ? delete process.env.NODE_ENV : (process.env.NODE_ENV = saved); }
    });

    console.log('seedAdmin (the development admin, at startup)');
    const admins = () => User.find({ role: { $in: ['admin', 'superadmin'] } }).lean();
    const withEnv = async (env: Record<string, string | undefined>, fn: () => Promise<void>) => {
      const keys = ['NODE_ENV', 'ADMIN_EMAIL', 'ADMIN_PASSWORD'];
      const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
      for (const k of keys) env[k] === undefined ? delete process.env[k] : process.env[k] = env[k];
      try { await fn(); } finally { for (const k of keys) saved[k] === undefined ? delete process.env[k] : process.env[k] = saved[k]; }
    };
    await test('an existing admin is left alone (no password reset)', async () => {
      await withEnv({ NODE_ENV: 'development', ADMIN_EMAIL: 'seed@test.local', ADMIN_PASSWORD: 'Seed-Passw0rd#1' }, () => seedAdmin());
      assert.deepStrictEqual((await admins()).map((a) => a.email), ['boss@test.local']);
      assert.strictEqual((await call('POST', '/auth/login', { email: 'boss@test.local', password: PW })).status, 200);
    });
    await User.deleteMany({ role: { $in: ['admin', 'superadmin'] } });
    await test('no admin + NODE_ENV production / unset without ADMIN_PASSWORD: nothing created', async () => {
      await withEnv({ NODE_ENV: 'production', ADMIN_EMAIL: 'seed@test.local', ADMIN_PASSWORD: undefined }, () => seedAdmin());
      await withEnv({ NODE_ENV: undefined, ADMIN_EMAIL: 'seed@test.local', ADMIN_PASSWORD: undefined }, () => seedAdmin());
      assert.strictEqual((await admins()).length, 0);
    });
    await test('no admin + production with a short ADMIN_PASSWORD (or the dev default): nothing created', async () => {
      await withEnv({ NODE_ENV: 'production', ADMIN_EMAIL: 'seed@test.local', ADMIN_PASSWORD: 'password123' }, () => seedAdmin());
      await withEnv({ NODE_ENV: undefined, ADMIN_EMAIL: 'seed@test.local', ADMIN_PASSWORD: 'short' }, () => seedAdmin());
      assert.strictEqual((await admins()).length, 0);
    });
    await test('no admin + ADMIN_PASSWORD set: superadmin created and can log in', async () => {
      await withEnv({ NODE_ENV: 'production', ADMIN_EMAIL: 'seed@test.local', ADMIN_PASSWORD: 'Seed-Passw0rd#1' }, () => seedAdmin());
      const a = await admins();
      assert.deepStrictEqual(a.map((x) => [x.email, x.role]), [['seed@test.local', 'superadmin']]);
      assert.strictEqual((await call('POST', '/auth/login', { email: 'seed@test.local', password: 'Seed-Passw0rd#1' })).status, 200);
    });
    await User.deleteMany({ role: { $in: ['admin', 'superadmin'] } });
    await test('no admin + exact development without ADMIN_PASSWORD: development default admin can log in', async () => {
      await withEnv({ NODE_ENV: 'development', ADMIN_EMAIL: 'devadmin@test.local', ADMIN_PASSWORD: undefined }, () => seedAdmin());
      assert.strictEqual((await call('POST', '/auth/login', { email: 'devadmin@test.local', password: 'password123' })).status, 200);
      assert.strictEqual((await call('POST', '/auth/customer-login', { email: 'devadmin@test.local', password: 'password123' })).status, 403, 'staff cannot use customer login');
    });

    console.log(`\n${passed} passed`);
  } finally {
    server.close();
    await mongoose.connection.db!.dropDatabase();
    await mongoose.disconnect();
  }
};

run().catch((err) => { console.error('❌', err); process.exit(1); });
