/**
 * Admin data pages against MongoDB: Messages (contacts), Settings, Video Testimonials.
 * Needs a local MongoDB; uses (and drops) a throwaway database.
 * Run: npx ts-node --transpile-only src/tests/adminData.test.ts
 */
import assert from 'assert';
import { AddressInfo } from 'net';
process.env.NODE_ENV = 'development';
process.env.HISTORY_READ_ENABLED = 'false';
const TEST_DB = 'mongodb://127.0.0.1:27017/luxy_admin_data_test';

import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../app';
import { ENV } from '../config/env';
import { User } from '../models/User';
import { Contact } from '../models/Contact';
import { Settings } from '../models/Settings';
import { VideoTestimonial } from '../models/VideoTestimonial';

let passed = 0;
const test = async (name: string, fn: () => Promise<void>) => { await fn(); passed++; console.log(`  ✅ ${name}`); };

const run = async () => {
  assert.ok(TEST_DB.includes('127.0.0.1') && TEST_DB.endsWith('_test'), 'refusing to run against a non-test database');
  await mongoose.connect(TEST_DB);
  await mongoose.connection.db!.dropDatabase();
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const call = async (method: string, path: string, body?: unknown, token?: string) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => null) as any };
  };

  try {
    const admin = await User.create({ name: 'Admin', email: 'admin@test.local', password: 'Admin#12345', role: 'superadmin', isVerified: true });
    const cust = await User.create({ name: 'Cust', email: 'cust@test.local', password: 'Cust#12345', role: 'customer', isVerified: true });
    const tok = (u: any) => jwt.sign({ id: String(u._id), role: u.role }, ENV.JWT_SECRET, { expiresIn: '10m' });
    const [adminT, custT] = [tok(admin), tok(cust)];

    await test('Messages: real records, per-status totals, filters and search', async () => {
      for (const m of [
        { name: 'Anu', email: 'anu@example.com', phone: '9000000001', subject: 'Order help', message: 'Where is my order?' },
        { name: 'Biju', email: 'biju@example.com', message: 'Do you ship to Delhi?' },
        { name: 'Chitra', email: 'chitra@example.com', subject: 'Gift', message: 'Gift wrapping (a+b)?' },
      ]) assert.strictEqual((await call('POST', '/contacts', m)).status, 201);
      // A legacy record from before `status` existed: isRead only
      await Contact.collection.insertOne({ name: 'Old', email: 'old@example.com', message: 'Legacy', isRead: true, createdAt: new Date(0), updatedAt: new Date(0) });

      const all = await call('GET', '/contacts', undefined, adminT);
      assert.strictEqual(all.status, 200);
      assert.strictEqual(all.json.data.length, 4);
      assert.deepStrictEqual(all.json.counts, { NEW: 3, READ: 1, RESOLVED: 0, ALL: 4 }, 'legacy isRead record counted as READ');
      assert.deepStrictEqual(Object.keys(all.json.data.find((c: any) => c.name === 'Anu')).filter((k) => ['name', 'email', 'phone', 'subject', 'message', 'status', 'createdAt'].includes(k)).sort(), ['createdAt', 'email', 'message', 'name', 'phone', 'status', 'subject']);
      assert.strictEqual((await call('GET', '/contacts?status=NEW', undefined, adminT)).json.data.length, 3);
      assert.strictEqual((await call('GET', '/contacts?status=READ', undefined, adminT)).json.data[0].name, 'Old');
      assert.strictEqual((await call('GET', '/contacts?search=delhi', undefined, adminT)).json.data[0].name, 'Biju');
      assert.strictEqual((await call('GET', '/contacts?search=(a%2Bb)', undefined, adminT)).json.data.length, 1, 'search is literal, not a regex');
      assert.strictEqual((await call('GET', '/contacts?status=bogus', undefined, adminT)).status, 400);
    });

    await test('Messages: read / unread / resolved persist to MongoDB; admin only', async () => {
      const id = String((await Contact.findOne({ name: 'Anu' }))!._id);
      for (const st of ['READ', 'RESOLVED', 'NEW']) {
        assert.strictEqual((await call('PUT', `/contacts/${id}/status`, { status: st }, adminT)).status, 200);
        assert.strictEqual((await Contact.findById(id).lean())!.status, st);
      }
      assert.strictEqual((await call('PUT', `/contacts/${id}/status`, { status: 'DONE' }, adminT)).status, 400);
      assert.strictEqual((await call('PUT', '/contacts/not-an-id/status', { status: 'READ' }, adminT)).status, 400);
      assert.strictEqual((await call('GET', '/contacts')).status, 401);
      assert.strictEqual((await call('GET', '/contacts', undefined, custT)).status, 403);
      assert.strictEqual((await call('PUT', `/contacts/${id}/status`, { status: 'READ' }, custT)).status, 403);
      assert.strictEqual((await call('POST', '/contacts', { name: 'X', email: 'x@example.com', message: 'hi', status: 'RESOLVED' })).json.data.status, 'NEW', 'status is server-owned');
    });

    await test('Settings: saving edited fields keeps every other field and one document', async () => {
      await Settings.create({ primaryColor: '#123456', whatsappNumber: '919847978098', shippingWeightThreshold: 500, freeShippingThreshold: 999, giftingTitle: 'Gifts',
        shipping: { marker: 'checkout section must survive' } });
      const before = await Settings.findOne().lean() as any;
      const r = await call('PUT', '/settings', { bannerText: 'Hello\nWorld', isBannerActive: true }, adminT);
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      const after = await Settings.findOne().lean() as any;
      assert.deepStrictEqual([after.bannerText, after.isBannerActive], ['Hello\nWorld', true]);
      for (const k of ['primaryColor', 'whatsappNumber', 'shippingWeightThreshold', 'freeShippingThreshold', 'giftingTitle', 'footerText', 'secondaryColor', 'shipping']) {
        assert.deepStrictEqual(after[k], before[k], `${k} preserved`);
      }
      await call('PUT', '/settings', { footerText: 'Footer' }, adminT);
      assert.strictEqual(await Settings.countDocuments(), 1, 'no new document per save');
      const pub = await call('GET', '/settings');
      assert.deepStrictEqual([pub.json.data.bannerText, pub.json.data.footerText, String(pub.json.data._id)], ['Hello\nWorld', 'Footer', String(before._id)], 'reflected after refresh');
    });

    await test('Settings: validated on the server; admin only', async () => {
      const bad = await call('PUT', '/settings', { whatsappNumber: 'call me' }, adminT);
      assert.strictEqual(bad.status, 400); assert.strictEqual(bad.json.errors[0].field, 'whatsappNumber');
      assert.strictEqual((await call('PUT', '/settings', { primaryColor: 'red' }, adminT)).status, 400);
      assert.strictEqual((await call('PUT', '/settings', { isBannerActive: 'yes' }, adminT)).status, 400);
      assert.strictEqual((await call('PUT', '/settings', { whatsappNumber: '+91 98479-78098' }, adminT)).json.data.whatsappNumber, '919847978098', 'stored as digits');
      const unknown = await call('PUT', '/settings', { evil: 1, isAdmin: true }, adminT);
      assert.strictEqual(unknown.status, 200); assert.ok(!('evil' in (await Settings.findOne().lean() as any)), 'unknown keys dropped');
      assert.strictEqual((await call('PUT', '/settings', { bannerText: 'x' })).status, 401);
      assert.strictEqual((await call('PUT', '/settings', { bannerText: 'x' }, custT)).status, 403);
      assert.strictEqual((await Settings.findOne().lean())!.bannerText, 'Hello\nWorld', 'refused writes changed nothing');
    });

    await test('Video testimonials: list, create, duplicate refused, toggle, reorder, delete', async () => {
      const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
      const created = await call('POST', '/video-testimonials', { clientName: 'Meera', role: 'Customer', youtubeUrl: url, displayOrder: 1, isActive: true }, adminT);
      assert.strictEqual(created.status, 201, JSON.stringify(created.json));
      assert.deepStrictEqual([created.json.data.youtubeId, created.json.data.thumbnailUrl.includes('dQw4w9WgXcQ')], ['dQw4w9WgXcQ', true]);
      assert.strictEqual((await call('POST', '/video-testimonials', { clientName: 'Meera', role: 'Customer', youtubeUrl: 'https://youtu.be/dQw4w9WgXcQ' }, adminT)).status, 409, 'same video twice refused');
      assert.strictEqual((await call('POST', '/video-testimonials', { clientName: 'X', role: 'Y', youtubeUrl: 'https://example.com/v' }, adminT)).status, 400);
      assert.strictEqual((await call('POST', '/video-testimonials', { role: 'Y', youtubeUrl: url }, adminT)).status, 400, 'name required');
      assert.strictEqual(await VideoTestimonial.countDocuments(), 1, 'no duplicate inserted');

      const second = await call('POST', '/video-testimonials', { clientName: 'Ravi', role: 'Chef', youtubeUrl: 'https://www.youtube.com/shorts/aqz-KE-bpKQ', displayOrder: 2 }, adminT);
      const id = second.json.data._id;
      assert.strictEqual((await call('PUT', `/video-testimonials/${id}`, { isActive: false }, adminT)).status, 200);
      assert.strictEqual((await VideoTestimonial.findById(id).lean())!.isActive, false, 'toggle persisted');
      assert.strictEqual((await call('PUT', `/video-testimonials/${id}`, { isActive: 'no' }, adminT)).status, 400);
      assert.strictEqual((await call('PUT', `/video-testimonials/${id}`, { youtubeUrl: url }, adminT)).status, 409, 'cannot edit into a duplicate');
      assert.strictEqual((await call('PUT', `/video-testimonials/${id}`, { displayOrder: 0 }, adminT)).status, 200);
      const list = await call('GET', '/video-testimonials', undefined, adminT);
      assert.deepStrictEqual(list.json.data.map((t: any) => t.clientName), ['Ravi', 'Meera'], 'sorted by display order');
      assert.deepStrictEqual((await call('GET', '/video-testimonials/active')).json.data.map((t: any) => t.clientName), ['Meera'], 'public list: active only');
      assert.strictEqual((await call('GET', '/video-testimonials')).status, 401);
      assert.strictEqual((await call('DELETE', `/video-testimonials/${id}`, undefined, custT)).status, 403);
      assert.strictEqual((await call('DELETE', '/video-testimonials/bad-id', undefined, adminT)).status, 400);
      assert.strictEqual((await call('DELETE', `/video-testimonials/${id}`, undefined, adminT)).status, 200);
      assert.strictEqual(await VideoTestimonial.countDocuments(), 1);
    });
  } finally {
    await mongoose.connection.db!.dropDatabase();
    await mongoose.disconnect();
    server.close();
  }
  console.log(`=== Summary: ${passed} passed, 0 failed ===`);
};

run().catch(async (e) => { console.error('❌', e?.stack || e); process.exitCode = 1; await mongoose.disconnect().catch(() => undefined); process.exit(1); });
