/**
 * Dashboard stats against a known set of orders: revenue rule, status tallies, daily chart, auth.
 * Needs a local MongoDB; uses (and drops) a throwaway database.
 * Run: npx ts-node --transpile-only src/tests/dashboard.test.ts
 */
import assert from 'assert';
import { AddressInfo } from 'net';
process.env.NODE_ENV = 'development';
const TEST_DB = 'mongodb://127.0.0.1:27017/luxy_dashboard_test';
process.env.MONGO_URI = TEST_DB;
process.env.HISTORY_READ_ENABLED = 'false'; // this test covers the local source; never reach a developer's history login from .env

import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../app';
import { ENV } from '../config/env';
import { User } from '../models/User';
import Order from '../models/Order';
import { Brand } from '../models/Brand';

const run = async () => {
  assert.ok(TEST_DB.includes('127.0.0.1') && TEST_DB.endsWith('_test'), 'refusing to run against a non-test database');
  await mongoose.connect(TEST_DB);
  await mongoose.connection.db!.dropDatabase();
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;

  const admin = await User.create({ name: 'Admin', email: 'admin@test.local', password: 'Admin#12345', role: 'superadmin', isVerified: true });
  const cust = await User.create({ name: 'Cust', email: 'cust@test.local', password: 'Cust#12345', role: 'customer', isVerified: true });
  await Brand.create([{ name: 'B1' }, { name: 'B2' }]);
  const tok = (u: any) => jwt.sign({ id: String(u._id), role: u.role }, ENV.JWT_SECRET, { expiresIn: '5m' });

  const day = 86400000;
  const order = (total: number, orderStatus: string, paymentStatus: string, daysAgo: number) => ({
    user: cust._id, items: [], shippingAddress: { street: 's', city: 'c', state: 's', zipCode: '0', country: 'IN' },
    subtotal: total, total, paymentMethod: 'razorpay', orderStatus, paymentStatus, createdAt: new Date(Date.now() - daysAgo * day),
  });
  await Order.collection.insertMany([
    order(100, 'processing', 'completed', 0), // revenue
    order(200, 'delivered', 'completed', 2), // revenue
    order(300, 'shipped', 'completed', 40), // revenue, but outside the 30-day chart
    order(400, 'cancelled', 'completed', 1), // paid then cancelled: NOT revenue, reported as awaiting refund
    order(500, 'processing', 'pending', 0), // unpaid: NOT revenue
    order(600, 'cancelled', 'refunded', 3), // refunded: NOT revenue
    order(700, 'processing', 'failed', 0), // failed: NOT revenue
  ]);

  const get = async (token?: string) => {
    const r = await fetch(`${base}/dashboard/stats`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    return { status: r.status, json: await r.json() };
  };
  assert.strictEqual((await get()).status, 401, 'no token');
  assert.strictEqual((await get(tok(cust))).status, 403, 'customer');

  const { status, json } = await get(tok(admin));
  assert.strictEqual(status, 200);
  const d = json.data;
  assert.strictEqual(d.totalOrders, 7);
  assert.strictEqual(d.totalRevenue, 600, 'revenue = paid and not cancelled');
  assert.strictEqual(d.paidOrders, 3);
  assert.strictEqual(d.averageOrderValue, 200);
  assert.strictEqual(d.cancelledPaidAmount, 400);
  assert.strictEqual(d.cancelledPaidOrders, 1);
  assert.deepStrictEqual(d.ordersByStatus, { processing: 3, shipped: 1, delivered: 1, cancelled: 2 });
  assert.deepStrictEqual(d.paymentsByStatus, { pending: 1, completed: 4, failed: 1, refunded: 1 });
  assert.strictEqual(d.totalBrands, 2);
  assert.strictEqual(d.totalCustomers, 1);
  assert.strictEqual(d.revenueByDay.length, 30, '30 days, zeros included');
  assert.strictEqual(d.revenueByDay.reduce((s: number, x: any) => s + x.revenue, 0), 300, 'chart = in-range revenue only (100 + 200)');
  assert.strictEqual(d.revenueByDay.reduce((s: number, x: any) => s + x.orders, 0), 2);
  assert.ok(d.revenueByDay.every((x: any, i: number, a: any[]) => i === 0 || a[i - 1].date < x.date), 'oldest first');
  assert.strictEqual(d.total_revenue, d.totalRevenue, 'snake_case alias kept');

  await mongoose.connection.db!.dropDatabase();
  await mongoose.disconnect();
  server.close();
  console.log('✅ dashboard stats: revenue rule, status tallies, 30-day chart, auth (401/403/200)');
};

run().catch(async (e) => { console.error('❌', e.message); process.exitCode = 1; await mongoose.disconnect(); process.exit(1); });
