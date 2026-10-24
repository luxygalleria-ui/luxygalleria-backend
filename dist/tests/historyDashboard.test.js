"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Read-only history for the local dashboard, against a REAL authenticated MongoDB started by this test
 * (temporary data folder, port 27991): config refusals, production refusal, read-only enforcement,
 * PII masking, connection failure, accurate totals, history left unchanged, local CRUD unaffected.
 * Needs `mongod` on PATH and the local MongoDB (for the app's throwaway test database).
 * Run: npx ts-node --transpile-only src/tests/historyDashboard.test.ts
 */
const assert_1 = __importDefault(require("assert"));
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const child_process_1 = require("child_process");
process.env.NODE_ENV = 'development';
const APP_DB = 'mongodb://127.0.0.1:27017/luxy_history_app_test';
process.env.MONGO_URI = APP_DB;
const mongoose_1 = __importDefault(require("mongoose"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const mongodb_1 = require("mongodb");
const app_1 = __importDefault(require("../app"));
const env_1 = require("../config/env");
const User_1 = require("../models/User");
const historyDb_1 = require("../config/historyDb");
const PORT = 27991;
const ROOT = `mongodb://root:rootpw@127.0.0.1:${PORT}/admin`;
const uri = (u, p, db = 'luxy') => `mongodb://${u}:${p}@127.0.0.1:${PORT}/${db}?authSource=admin`;
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`); };
const startMongod = async (dir) => {
    const p = (0, child_process_1.spawn)('mongod', ['--dbpath', dir, '--port', String(PORT), '--bind_ip', '127.0.0.1', '--auth', '--quiet'], { stdio: 'ignore' });
    for (let i = 0; i < 60; i++) {
        try {
            const c = await mongodb_1.MongoClient.connect(`mongodb://127.0.0.1:${PORT}`, { serverSelectionTimeoutMS: 500 });
            await c.close();
            return p;
        }
        catch {
            await new Promise((r) => setTimeout(r, 500));
        }
    }
    p.kill();
    throw new Error('mongod did not start');
};
const run = async () => {
    const dir = fs_1.default.mkdtempSync(path_1.default.join(os_1.default.tmpdir(), 'luxy-history-test-'));
    const mongod = await startMongod(dir);
    try {
        // Localhost exception: the first user can be created without auth
        const boot = await mongodb_1.MongoClient.connect(`mongodb://127.0.0.1:${PORT}`);
        await boot.db('admin').command({ createUser: 'root', pwd: 'rootpw', roles: ['root'] });
        await boot.close();
        const root = await mongodb_1.MongoClient.connect(ROOT);
        const admin = root.db('admin');
        await admin.command({ createUser: 'reader', pwd: 'readerpw', roles: [{ role: 'read', db: 'luxy' }] });
        await admin.command({ createUser: 'writer', pwd: 'writerpw', roles: [{ role: 'readWrite', db: 'luxy' }] });
        await admin.command({ createUser: 'otherreader', pwd: 'otherpw', roles: [{ role: 'read', db: 'other' }] });
        // A custom role whose NAME looks harmless but which can insert: role-name checks alone would let it through
        await admin.command({ createRole: 'luxyViewer', privileges: [{ resource: { db: 'luxy', collection: '' }, actions: ['find', 'insert'] }], roles: [] });
        await admin.command({ createUser: 'customwriter', pwd: 'customwriterpw', roles: [{ role: 'read', db: 'luxy' }, { role: 'luxyViewer', db: 'admin' }] });
        // History data with personal details that must never reach the dashboard response
        const h = root.db('luxy');
        const users = await h.collection('users').insertMany([
            { name: 'Asha', email: 'asha.private@example.com', phone: '9876543210', role: 'customer', password: 'HASH1' },
            { name: 'Ravi', email: 'ravi.private@example.com', phone: '9123456780', role: 'customer', password: 'HASH2' },
            { name: 'Ops', email: 'ops@luxy.test', role: 'superadmin', password: 'HASH3' },
        ]);
        const [asha, ravi] = [users.insertedIds[0], users.insertedIds[1]];
        const day = 86400000;
        const order = (user, total, orderStatus, paymentStatus, daysAgo) => ({
            user, total, subtotal: total, orderStatus, paymentStatus, items: [], paymentMethod: 'razorpay',
            shippingAddress: { street: '12 Secret Lane', city: 'Kochi', state: 'Kerala', zipCode: '682011', country: 'India' },
            razorpayPaymentId: 'pay_SECRET', createdAt: new Date(Date.now() - daysAgo * day), updatedAt: new Date(),
        });
        await h.collection('orders').insertMany([
            order(asha, 139, 'processing', 'completed', 1), order(ravi, 338, 'shipped', 'completed', 2), order(asha, 970, 'delivered', 'completed', 40),
            order(ravi, 500, 'cancelled', 'completed', 3), order(asha, 250, 'processing', 'pending', 0),
        ]);
        const hashBefore = (await h.command({ dbHash: 1 })).md5;
        // App: its own throwaway local database, with a local admin and some local data that must NOT appear as history
        assert_1.default.ok(APP_DB.endsWith('_test'));
        await mongoose_1.default.connect(APP_DB);
        await mongoose_1.default.connection.db.dropDatabase();
        const localAdmin = await User_1.User.create({ name: 'Admin', email: 'admin@test.local', password: 'Admin#12345', role: 'superadmin', isVerified: true });
        await mongoose_1.default.connection.db.collection('orders').insertOne({ user: localAdmin._id, total: 9999, orderStatus: 'processing', paymentStatus: 'completed', createdAt: new Date() });
        const server = app_1.default.listen(0);
        const base = `http://127.0.0.1:${server.address().port}/api/v1`;
        const token = jsonwebtoken_1.default.sign({ id: String(localAdmin._id), role: 'superadmin' }, env_1.ENV.JWT_SECRET, { expiresIn: '5m' });
        const stats = async () => { const r = await fetch(`${base}/dashboard/stats`, { headers: { Authorization: `Bearer ${token}` } }); return { status: r.status, text: await r.text() }; };
        const withEnv = async (env, fn) => {
            const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
            Object.assign(process.env, env);
            for (const [k, v] of Object.entries(env))
                if (v === undefined)
                    delete process.env[k];
            (0, historyDb_1.resetHistoryForTests)();
            try {
                await fn();
            }
            finally {
                Object.assign(process.env, saved);
                for (const [k, v] of Object.entries(saved))
                    if (v === undefined)
                        delete process.env[k];
                (0, historyDb_1.resetHistoryForTests)();
            }
        };
        const on = (u, db = 'luxy') => ({ HISTORY_READ_ENABLED: 'true', HISTORY_READ_URI: u, HISTORY_READ_DB: db });
        await test('config: disabled by default, refused in production, rejects missing URI, placeholder host, same-as-MONGO_URI and non-luxy remote DB', () => {
            assert_1.default.strictEqual((0, historyDb_1.historyConfig)({}).enabled, false);
            assert_1.default.match((0, historyDb_1.historyConfig)({ ...on(uri('reader', 'readerpw')), NODE_ENV: 'production' }).reason, /refused/);
            assert_1.default.match((0, historyDb_1.historyConfig)({ HISTORY_READ_ENABLED: 'true', HISTORY_READ_DB: 'luxy', NODE_ENV: 'development' }).reason, /missing/);
            assert_1.default.match((0, historyDb_1.historyConfig)({ ...on(APP_DB), NODE_ENV: 'development', MONGO_URI: APP_DB }).reason, /same as MONGO_URI/);
            assert_1.default.match((0, historyDb_1.historyConfig)({ ...on('mongodb+srv://u:p@x.abc.mongodb.net/', 'luxy_staging'), NODE_ENV: 'development' }).reason, /must be "luxy"/);
            assert_1.default.strictEqual((0, historyDb_1.historyConfig)({ ...on('mongodb+srv://u:p@x.abc.mongodb.net/'), NODE_ENV: 'development' }).enabled, true);
            for (const bad of ['mongodb+srv://u:p@CLUSTER_HOST/luxy', 'mongodb+srv://u:p@<cluster>/luxy', 'mongodb+srv://u:p@cluster0/luxy', 'mongodb+srv://u:p@your cluster.mongodb.net/luxy']) {
                assert_1.default.match((0, historyDb_1.historyConfig)({ ...on(bad), NODE_ENV: 'development' }).reason, /placeholder/, bad);
            }
        });
        await test('disabled: dashboard uses the local database', () => withEnv({ HISTORY_READ_ENABLED: undefined }, async () => {
            const r = await stats();
            const d = JSON.parse(r.text).data;
            assert_1.default.strictEqual(r.status, 200);
            assert_1.default.strictEqual(d.orderDataSource, 'local');
            assert_1.default.strictEqual(d.totalOrders, 1);
            assert_1.default.strictEqual(d.totalRevenue, 9999);
        }));
        await test('opted in but misconfigured (placeholder host): 503 with the reason, never local figures', () => withEnv(on('mongodb+srv://u:p@CLUSTER_HOST/luxy'), async () => {
            const r = await stats();
            const j = JSON.parse(r.text);
            assert_1.default.strictEqual(r.status, 503);
            assert_1.default.match(j.message, /placeholder/);
            assert_1.default.ok(!j.data, 'no figures');
        }));
        await test('production mode: history never initialised even when enabled', () => withEnv({ ...on(uri('reader', 'readerpw')), NODE_ENV: 'production' }, async () => {
            const r = await stats();
            assert_1.default.strictEqual(JSON.parse(r.text).data.orderDataSource, 'local');
        }));
        await test('read-only login: real history totals, statuses and recent orders', () => withEnv(on(uri('reader', 'readerpw')), async () => {
            const r = await stats();
            const d = JSON.parse(r.text).data;
            assert_1.default.strictEqual(r.status, 200, r.text);
            assert_1.default.strictEqual(d.orderDataSource, 'history-readonly');
            assert_1.default.strictEqual(d.totalOrders, 5);
            assert_1.default.strictEqual(d.totalCustomers, 2, 'customers only, superadmin excluded');
            assert_1.default.strictEqual(d.totalRevenue, 139 + 338 + 970, 'paid and not cancelled');
            assert_1.default.strictEqual(d.paidOrders, 3);
            assert_1.default.strictEqual(d.cancelledPaidAmount, 500);
            assert_1.default.deepStrictEqual(d.ordersByStatus, { processing: 2, shipped: 1, delivered: 1, cancelled: 1 });
            assert_1.default.deepStrictEqual(d.paymentsByStatus, { pending: 1, completed: 4, failed: 0, refunded: 0 });
            assert_1.default.strictEqual(d.revenueByDay.reduce((a, x) => a + x.revenue, 0), 139 + 338, '30-day chart excludes the 40-day-old order');
            assert_1.default.strictEqual(d.recentOrders.length, 5);
            assert_1.default.deepStrictEqual(Object.keys(d.recentOrders[0]).sort(), ['_id', 'createdAt', 'orderStatus', 'paymentStatus', 'total', 'user']);
            assert_1.default.ok(d.recentOrders.every((o) => o.user === null || Object.keys(o.user).join() === 'name'));
        }));
        await test('PII masking: no email, phone, address, password or payment ID in the response', () => withEnv(on(uri('reader', 'readerpw')), async () => {
            const { text } = await stats();
            for (const secret of ['@example.com', '9876543210', '9123456780', 'Secret Lane', '682011', 'HASH1', 'pay_SECRET', 'readerpw'])
                assert_1.default.ok(!text.includes(secret), `leaked ${secret}`);
        }));
        await test('a login that can write is refused (503, no fallback figures)', () => withEnv(on(uri('writer', 'writerpw')), async () => {
            const r = await stats();
            const j = JSON.parse(r.text);
            assert_1.default.strictEqual(r.status, 503);
            assert_1.default.match(j.message, /can write/);
            assert_1.default.ok(!j.data, 'no figures returned');
            assert_1.default.ok(!r.text.includes('writerpw'));
        }));
        await test('a custom role that can write is refused, whatever its name', () => withEnv(on(uri('customwriter', 'customwriterpw')), async () => {
            const r = await stats();
            const j = JSON.parse(r.text);
            assert_1.default.strictEqual(r.status, 503);
            assert_1.default.match(j.message, /can write \(privileges: insert\)/);
            assert_1.default.ok(!j.data);
        }));
        await test('a login without read on luxy is refused', () => withEnv(on(uri('otherreader', 'otherpw')), async () => {
            const r = await stats();
            assert_1.default.strictEqual(r.status, 503);
            assert_1.default.match(JSON.parse(r.text).message, /no read role on luxy/);
        }));
        await test('wrong password (the reported failure): 503 naming authentication and the next step, no figures', () => withEnv(on(uri('reader', 'WRONG-password')), async () => {
            const r = await stats();
            const j = JSON.parse(r.text);
            assert_1.default.strictEqual(r.status, 503);
            assert_1.default.match(j.message, /authentication failed: Atlas rejected the username\/password/);
            assert_1.default.ok(!j.data);
            assert_1.default.ok(!r.text.includes('WRONG-password') && !r.text.includes('reader:'), 'credentials never echoed');
        }));
        await test('unknown user: same authentication explanation', () => withEnv(on(uri('nobody', 'x')), async () => {
            const r = await stats();
            assert_1.default.strictEqual(r.status, 503);
            assert_1.default.match(JSON.parse(r.text).message, /authentication failed/);
        }));
        await test('connection failure: 503 with redacted reason, no fallback', () => withEnv(on('mongodb://reader:readerpw@127.0.0.1:1/luxy?authSource=admin&serverSelectionTimeoutMS=1500'), async () => {
            const r = await stats();
            assert_1.default.strictEqual(r.status, 503);
            assert_1.default.ok(!r.text.includes('readerpw'));
            assert_1.default.ok(!JSON.parse(r.text).data);
            assert_1.default.match(JSON.parse(r.text).message, /could not reach the database server.*Network Access/);
        }));
        const list = async (path) => { const r = await fetch(`${base}/dashboard/history/${path}`, { headers: { Authorization: `Bearer ${token}` } }); return { status: r.status, text: await r.text() }; };
        await test('history lists: orders and customers consistent with dashboard, paginated without overlap, read-only shape', () => withEnv(on(uri('reader', 'readerpw')), async () => {
            const d = JSON.parse((await stats()).text).data;
            const o = JSON.parse((await list('orders?limit=100')).text).data;
            const c = JSON.parse((await list('customers?limit=100')).text).data;
            assert_1.default.strictEqual(o.source, 'history-readonly');
            assert_1.default.strictEqual(o.pagination.total, d.totalOrders);
            assert_1.default.strictEqual(o.orders.length, 5);
            assert_1.default.strictEqual(c.pagination.total, d.totalCustomers);
            assert_1.default.strictEqual(c.customers.length, 2, 'superadmin never listed');
            assert_1.default.strictEqual(o.orders.filter((x) => x.paymentStatus === 'completed' && x.orderStatus !== 'cancelled').reduce((a, x) => a + x.total, 0), d.totalRevenue);
            assert_1.default.deepStrictEqual(o.orders.map((x) => x._id), d.recentOrders.map((x) => x._id), 'same newest-first order as the dashboard');
            const p1 = JSON.parse((await list('orders?limit=2&page=1')).text).data, p3 = JSON.parse((await list('orders?limit=2&page=3')).text).data;
            assert_1.default.strictEqual(p1.pagination.pages, 3);
            assert_1.default.strictEqual(p3.orders.length, 1);
            const all = [...p1.orders, ...JSON.parse((await list('orders?limit=2&page=2')).text).data.orders, ...p3.orders].map((x) => x._id);
            assert_1.default.strictEqual(new Set(all).size, 5, 'pages cover every order exactly once');
            assert_1.default.strictEqual(JSON.parse((await list('orders?limit=999')).text).data.pagination.limit, 100, 'page size capped');
            assert_1.default.deepStrictEqual(Object.keys(o.orders[0].shippingAddress).sort(), ['city', 'country', 'state']);
            assert_1.default.deepStrictEqual(Object.keys(c.customers[0]).sort(), ['_id', 'createdAt', 'isActive', 'name', 'orderCount']);
            assert_1.default.strictEqual(c.customers.reduce((a, x) => a + x.orderCount, 0), 5);
        }));
        await test('history lists: no PII in responses', () => withEnv(on(uri('reader', 'readerpw')), async () => {
            const text = (await list('orders?limit=100')).text + (await list('customers?limit=100')).text;
            for (const secret of ['@example.com', '9876543210', '9123456780', 'Secret Lane', '682011', 'HASH1', 'pay_SECRET', 'readerpw', '"email"', '"phone"', '"street"', '"zipCode"'])
                assert_1.default.ok(!text.includes(secret), `leaked ${secret}`);
        }));
        await test('history lists: 404 when disabled, 503 (no records) when the login fails, admin-only', async () => {
            await withEnv({ HISTORY_READ_ENABLED: undefined }, async () => { const r = await list('orders'); assert_1.default.strictEqual(r.status, 404); assert_1.default.match(r.text, /HISTORY_DISABLED/); });
            await withEnv(on(uri('reader', 'WRONG')), async () => { const r = await list('customers'); assert_1.default.strictEqual(r.status, 503); assert_1.default.ok(!JSON.parse(r.text).data); assert_1.default.match(r.text, /authentication failed/); });
            await withEnv(on(uri('writer', 'writerpw')), async () => { const r = await list('orders'); assert_1.default.strictEqual(r.status, 503); assert_1.default.match(r.text, /can write/); });
            const anon = await fetch(`${base}/dashboard/history/orders`);
            assert_1.default.strictEqual(anon.status, 401);
        });
        await test('no write routes exist for history (PUT/DELETE/POST rejected)', async () => {
            for (const [m, p] of [['PUT', 'orders/x'], ['DELETE', 'orders/x'], ['POST', 'orders'], ['DELETE', 'customers/x']]) {
                const r = await fetch(`${base}/dashboard/history/${p}`, { method: m, headers: { Authorization: `Bearer ${token}` } });
                assert_1.default.strictEqual(r.status, 404, `${m} ${p}`);
            }
        });
        await test('local settings untouched by history reads', async () => {
            const before = (await mongoose_1.default.connection.db.command({ dbHash: 1, collections: ['settings', 'orders', 'users'] })).md5;
            await withEnv(on(uri('reader', 'readerpw')), async () => { await stats(); await list('orders'); await list('customers'); });
            assert_1.default.strictEqual((await mongoose_1.default.connection.db.command({ dbHash: 1, collections: ['settings', 'orders', 'users'] })).md5, before);
        });
        await test('history database unchanged after all reads', async () => {
            assert_1.default.strictEqual((await h.command({ dbHash: 1 })).md5, hashBefore);
        });
        await test('local CRUD unaffected while history is enabled (brand create + delete hit the local DB only)', () => withEnv(on(uri('reader', 'readerpw')), async () => {
            const created = await fetch(`${base}/brands`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ name: 'Local Test Brand', logo: 'https://example.com/l.png' }) });
            assert_1.default.strictEqual(created.status, 201, await created.clone().text());
            const id = (await created.json()).data._id;
            assert_1.default.strictEqual(await mongoose_1.default.connection.db.collection('brands').countDocuments(), 1);
            const del = await fetch(`${base}/brands/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
            assert_1.default.strictEqual(del.status, 200);
            assert_1.default.strictEqual(await mongoose_1.default.connection.db.collection('brands').countDocuments(), 0);
            assert_1.default.strictEqual((await h.command({ dbHash: 1 })).md5, hashBefore, 'history untouched');
        }));
        server.close();
        await mongoose_1.default.connection.db.dropDatabase();
        await mongoose_1.default.disconnect();
        await root.close();
    }
    finally {
        mongod.kill();
        await new Promise((r) => setTimeout(r, 1000));
        fs_1.default.rmSync(dir, { recursive: true, force: true });
    }
    console.log(`=== Summary: ${passed} passed, 0 failed ===`);
    process.exit(0);
};
run().catch((e) => { console.error('❌', e.message); process.exit(1); });
//# sourceMappingURL=historyDashboard.test.js.map