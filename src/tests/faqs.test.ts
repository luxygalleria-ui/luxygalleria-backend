/**
 * FAQ API: public list (active only, ordered), admin CRUD + toggle, validation and auth.
 * Needs a local MongoDB; uses (and drops) a throwaway database.
 * Run: npx ts-node --transpile-only src/tests/faqs.test.ts
 */
import assert from 'assert';
import { AddressInfo } from 'net';
process.env.NODE_ENV = 'development';
const TEST_DB = 'mongodb://127.0.0.1:27017/luxy_faqs_test';
process.env.MONGO_URI = TEST_DB;

import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../app';
import { ENV } from '../config/env';
import { User } from '../models/User';

const run = async () => {
  assert.ok(TEST_DB.includes('127.0.0.1') && TEST_DB.endsWith('_test'), 'refusing to run against a non-test database');
  await mongoose.connect(TEST_DB);
  await mongoose.connection.db!.dropDatabase();
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/faqs`;
  const admin = await User.create({ name: 'Admin', email: 'admin@test.local', password: 'Admin#12345', role: 'admin', isVerified: true });
  const cust = await User.create({ name: 'Cust', email: 'cust@test.local', password: 'Cust#12345', role: 'customer', isVerified: true });
  const tok = (u: any) => jwt.sign({ id: String(u._id), role: u.role }, ENV.JWT_SECRET, { expiresIn: '5m' });
  const call = async (method: string, path: string, body?: unknown, token = tok(admin)) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  let n = 0;
  const check = (cond: unknown, label: string) => { assert.ok(cond, label); n++; };

  // auth
  check((await call('GET', '/admin', undefined, '')).status === 401, 'admin list needs a token');
  check((await call('GET', '/admin', undefined, tok(cust))).status === 403, 'customers cannot manage FAQs');
  check((await call('GET', '/')).status === 200, 'public list is open');

  // create + validation
  const a = await call('POST', '/admin', { question: 'Where do you ship?', answer: 'All India.', order: 2 });
  check(a.status === 201 && a.json.data.question === 'Where do you ship?', 'create');
  const b = await call('POST', '/admin', { question: 'Hidden?', answer: 'Yes', order: 1, isActive: false });
  const c = await call('POST', '/admin', { question: 'First?', answer: 'Yes', order: 0 });
  check(b.status === 201 && c.status === 201, 'create more');
  check((await call('POST', '/admin', { question: '  ', answer: 'x' })).status === 400, 'blank question refused');
  check((await call('POST', '/admin', { question: 'Q' })).status === 400, 'missing answer refused');
  check((await call('POST', '/admin', { question: 'Q', answer: 'A', order: 'abc' })).status === 400, 'non-numeric order refused');

  // lists
  const admins = (await call('GET', '/admin')).json.data.map((f: any) => f.question);
  check(admins.join('|') === 'First?|Hidden?|Where do you ship?', `admin list: all, by order (${admins})`);
  const pub = (await call('GET', '/', undefined, '')).json.data.map((f: any) => f.question);
  check(pub.join('|') === 'First?|Where do you ship?', `public list: active only (${pub})`);

  // update (partial updates keep the other fields), validation, unknown/invalid ids
  const id = a.json.data._id;
  const u = await call('PUT', `/admin/${id}`, { answer: 'All of India, 2-5 days.' });
  check(u.status === 200 && u.json.data.question === 'Where do you ship?' && u.json.data.answer === 'All of India, 2-5 days.', 'partial update keeps the question');
  check((await call('PUT', `/admin/${id}`, { question: '' })).status === 400, 'update cannot blank the question');
  check((await call('PUT', `/admin/${new mongoose.Types.ObjectId()}`, { answer: 'x' })).status === 404, 'unknown id: 404');
  check((await call('PUT', '/admin/not-an-id', { answer: 'x' })).status === 400, 'invalid id: 400, not 500');
  check((await call('DELETE', '/admin/not-an-id')).status === 400, 'invalid id on delete: 400');

  // toggle + delete
  const t = await call('PATCH', `/admin/${b.json.data._id}/toggle`);
  check(t.status === 200 && t.json.data.isActive === true, 'toggle activates');
  check((await call('GET', '/', undefined, '')).json.data.length === 3, 'toggled FAQ now public');
  check((await call('DELETE', `/admin/${c.json.data._id}`)).status === 200, 'delete');
  check((await call('DELETE', `/admin/${c.json.data._id}`)).status === 404, 'delete twice: 404');
  check((await call('GET', '/admin')).json.data.length === 2, 'deleted FAQ gone');

  await mongoose.connection.db!.dropDatabase();
  await mongoose.disconnect();
  server.close();
  console.log(`✅ FAQs: public/active list, admin CRUD + toggle, validation, auth (${n} checks)`);
};

run().catch(async (e) => { console.error('❌', e.message); process.exitCode = 1; await mongoose.disconnect(); process.exit(1); });
