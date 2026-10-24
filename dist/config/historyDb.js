"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resetHistoryForTests = exports.checkHistoryConnection = exports.historyCustomers = exports.historyOrders = exports.historyOrderStats = exports.historyStatus = exports.HistoryUnavailableError = exports.historyConfig = exports.explainHistoryError = void 0;
const mongodb_1 = require("mongodb");
const dashboardStats_1 = require("../utils/dashboardStats");
/**
 * Optional, strictly READ-ONLY connection to historical business data (orders, customers) for the LOCAL dashboard.
 *
 * Off unless HISTORY_READ_ENABLED=true, and refused outside NODE_ENV=development. Separate from MONGO_URI, which
 * keeps serving all local reads and writes. The login must be read-only (checked on connect; any role that can
 * write is refused). The Db handle never leaves this module: callers get the result of fixed read queries only.
 */
const WRITE_ROLE = /^(readWrite|dbOwner|dbAdmin|userAdmin|clusterAdmin|clusterManager|hostManager|restore|root|atlasAdmin|readWriteAnyDatabase|dbAdminAnyDatabase|userAdminAnyDatabase|backup|enableSharding|__system)/;
// Role names miss custom roles (Atlas "custom roles" can be named anything), so the effective privileges are checked too
const WRITE_ACTIONS = new Set(['insert', 'update', 'remove', 'createCollection', 'dropCollection', 'dropDatabase', 'createIndex', 'dropIndex',
    'renameCollectionSameDB', 'collMod', 'convertToCapped', 'compact', 'bypassDocumentValidation', 'applyOps', 'createUser', 'dropUser',
    'grantRole', 'revokeRole', 'createRole', 'dropRole', 'changePassword', 'changeCustomData', 'enableSharding',
    'shardCollection', 'reIndex', 'emptycapped', 'restore', 'anyAction', 'internal']);
const RETRY_AFTER_MS = 30_000;
const isLocal = (uri) => /^mongodb:\/\/(127\.0\.0\.1|localhost)[:/]/.test(uri);
const redact = (message, uri) => String(message).split(uri).join('<HISTORY_READ_URI>')
    .replace(/\/\/[^@/\s]*@/g, '//<credentials>@').replace(/[a-z0-9.-]+\.mongodb\.net/gi, '<cluster-host>');
/** Turns a driver error into a reason that names the failing layer and the next step. Never includes credentials. */
const explainHistoryError = (err) => {
    const msg = String(err?.message || err);
    if (err?.code === 18 || err?.codeName === 'AuthenticationFailed' || /bad auth|authentication failed/i.test(msg)) {
        return 'authentication failed: Atlas rejected the username/password in HISTORY_READ_URI. Check in Atlas → Database Access that the user exists in this project, has not expired, and that the password is current (URL-encode special characters).';
    }
    if (/ENOTFOUND|querySrv|ECONNREFUSED|ETIMEDOUT|Server selection timed out|ServerSelectionError|getaddrinfo/i.test(msg) || err?.name === 'MongoServerSelectionError') {
        return 'could not reach the database server: check internet/DNS and that Atlas → Network Access allows this machine\'s current IP address.';
    }
    if (err?.code === 13 || /not authorized|Unauthorized/i.test(msg)) {
        return 'the login is authenticated but not authorized to read the required data: give it the read role on luxy.';
    }
    return msg; // our own checks (can write / no read role / missing collection) are already specific
};
exports.explainHistoryError = explainHistoryError;
const historyConfig = (env = process.env) => {
    if (env.HISTORY_READ_ENABLED !== 'true')
        return { enabled: false, reason: 'HISTORY_READ_ENABLED is not "true"' };
    if ((env.NODE_ENV || 'development') !== 'development')
        return { enabled: false, reason: 'refused: historical reads are for local development only' };
    const uri = (env.HISTORY_READ_URI || '').trim();
    if (!/^mongodb(\+srv)?:\/\//.test(uri))
        return { enabled: false, reason: 'HISTORY_READ_URI is missing or not a mongodb URI' };
    if (uri === (env.MONGO_URI || env.MONGODB_URI || '').trim())
        return { enabled: false, reason: 'HISTORY_READ_URI must not be the same as MONGO_URI' };
    const host = (uri.match(/^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)/) || [])[1] || '';
    if (!/^[a-z0-9.-]+(:\d+)?(,[a-z0-9.-]+(:\d+)?)*$/.test(host) || (uri.startsWith('mongodb+srv://') && !host.includes('.'))) {
        return { enabled: false, reason: 'HISTORY_READ_URI host is not a valid hostname (a template placeholder?): copy the full connection string from Atlas → Connect' };
    }
    const dbName = (env.HISTORY_READ_DB || '').trim();
    if (dbName !== 'luxy' && !(dbName && isLocal(uri)))
        return { enabled: false, reason: 'HISTORY_READ_DB must be "luxy"' };
    return { enabled: true, uri, dbName };
};
exports.historyConfig = historyConfig;
class HistoryUnavailableError extends Error {
}
exports.HistoryUnavailableError = HistoryUnavailableError;
let cached = null;
let failedAt = 0;
let lastError = '';
const connect = async (uri, dbName) => {
    const client = await mongodb_1.MongoClient.connect(uri, {
        readPreference: 'secondaryPreferred', serverSelectionTimeoutMS: 8000, appName: 'luxy-local-dashboard-history-readonly',
    });
    try {
        const db = client.db(dbName);
        const status = await db.admin().command({ connectionStatus: 1, showPrivileges: true });
        const roles = (status.authInfo?.authenticatedUserRoles || []).map((r) => `${r.role}@${r.db}`);
        const authenticated = (status.authInfo?.authenticatedUsers || []).length > 0;
        if (!authenticated && !isLocal(uri))
            throw new Error('login is not authenticated');
        const writable = roles.filter((r) => WRITE_ROLE.test(r));
        if (writable.length)
            throw new Error(`login can write (${writable.join(', ')}); use a read-only user`);
        const writeActions = [...new Set((status.authInfo?.authenticatedUserPrivileges || [])
                .flatMap((p) => (p.actions || [])).filter((a) => WRITE_ACTIONS.has(a)))];
        if (writeActions.length)
            throw new Error(`login can write (privileges: ${writeActions.join(', ')}); use a read-only user`);
        if (authenticated && !roles.some((r) => r === `read@${dbName}` || r === 'readAnyDatabase@admin'))
            throw new Error(`login has no read role on ${dbName}`);
        const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);
        for (const required of ['orders', 'users'])
            if (!names.includes(required))
                throw new Error(`database ${dbName} has no "${required}" collection`);
        return db;
    }
    catch (err) {
        await client.close().catch(() => undefined);
        throw err;
    }
};
/** The read-only history database, or null when history is disabled. Throws HistoryUnavailableError when enabled but unusable. */
const historyDb = async () => {
    const cfg = (0, exports.historyConfig)();
    if (!cfg.enabled) {
        // Opted in for local development but misconfigured: report it, never quietly show local figures instead
        const optedIn = process.env.HISTORY_READ_ENABLED === 'true' && (process.env.NODE_ENV || 'development') === 'development';
        if (optedIn)
            throw new HistoryUnavailableError(cfg.reason);
        return null;
    }
    if (cached?.uri === cfg.uri)
        return cached.db;
    if (Date.now() - failedAt < RETRY_AFTER_MS)
        throw new HistoryUnavailableError(lastError);
    const db = connect(cfg.uri, cfg.dbName);
    cached = { uri: cfg.uri, db };
    try {
        return await db;
    }
    catch (err) {
        cached = null;
        failedAt = Date.now();
        lastError = redact((0, exports.explainHistoryError)(err), cfg.uri);
        console.error(`⚠️  Historical data (read-only) unavailable: ${lastError}`);
        throw new HistoryUnavailableError(lastError);
    }
};
const historyStatus = () => {
    const cfg = (0, exports.historyConfig)();
    return cfg.enabled ? { enabled: true, database: cfg.dbName } : { enabled: false, reason: cfg.reason };
};
exports.historyStatus = historyStatus;
/** Runs a fixed read over the history database; null when history is disabled. The Db handle never leaves this module. */
const readHistory = async (read) => {
    const db = await historyDb();
    if (!db)
        return null;
    try {
        return await read(db);
    }
    catch (err) {
        const cfg = (0, exports.historyConfig)();
        throw new HistoryUnavailableError(cfg.enabled ? redact((0, exports.explainHistoryError)(err), cfg.uri) : 'history disabled');
    }
};
/** Aggregate figures for the dashboard. */
const historyOrderStats = () => readHistory(dashboardStats_1.orderAndCustomerStats);
exports.historyOrderStats = historyOrderStats;
const paging = (p, total) => ({ page: p.page, limit: p.limit, total, pages: Math.max(1, Math.ceil(total / p.limit)) });
const CUSTOMER_ROLES = ['customer', 'user']; // same filter as the dashboard's customer count
/**
 * Orders, newest first, with minimal personal data: customer NAME only; city/state/country only (no street, PIN,
 * email or phone); no payment IDs or signatures. Product name and first image come from the history catalogue.
 */
const historyOrders = (p) => readHistory(async (db) => {
    const orders = db.collection('orders');
    const [total, rows] = await Promise.all([
        orders.countDocuments(),
        orders.find({}, { projection: { user: 1, items: 1, 'shippingAddress.city': 1, 'shippingAddress.state': 1, 'shippingAddress.country': 1, subtotal: 1, discount: 1, shippingFee: 1, total: 1, paymentMethod: 1, paymentStatus: 1, orderStatus: 1, createdAt: 1 } })
            .sort({ createdAt: -1, _id: -1 }).skip((p.page - 1) * p.limit).limit(p.limit).toArray(),
    ]);
    const userIds = rows.map((o) => o.user).filter(Boolean);
    const productIds = rows.flatMap((o) => (o.items || []).map((it) => it.product)).filter(Boolean);
    const [users, products] = await Promise.all([
        db.collection('users').find({ _id: { $in: userIds } }, { projection: { name: 1 } }).toArray(),
        db.collection('products').find({ _id: { $in: productIds } }, { projection: { name: 1, images: { $slice: 1 } } }).toArray(),
    ]);
    const nameOf = new Map(users.map((u) => [String(u._id), u.name]));
    const productOf = new Map(products.map((x) => [String(x._id), { _id: String(x._id), name: x.name, images: (x.images || []) }]));
    return {
        orders: rows.map((o) => ({
            _id: String(o._id),
            user: o.user ? { _id: String(o.user), name: nameOf.get(String(o.user)) ?? null } : null,
            items: (o.items || []).map((it) => ({ product: productOf.get(String(it.product)) ?? null, quantity: it.quantity, price: it.price, size: it.size, image: it.image })),
            shippingAddress: { city: o.shippingAddress?.city ?? null, state: o.shippingAddress?.state ?? null, country: o.shippingAddress?.country ?? null },
            subtotal: o.subtotal, discount: o.discount, shippingFee: o.shippingFee, total: o.total,
            paymentMethod: o.paymentMethod, paymentStatus: o.paymentStatus, orderStatus: o.orderStatus, createdAt: o.createdAt,
        })),
        pagination: paging(p, total),
    };
});
exports.historyOrders = historyOrders;
/** Customers, newest first: NAME, status, joined date and order count only (no email, phone, addresses or secrets). */
const historyCustomers = (p) => readHistory(async (db) => {
    const users = db.collection('users');
    const filter = { role: { $in: CUSTOMER_ROLES } };
    const [total, rows] = await Promise.all([
        users.countDocuments(filter),
        users.find(filter, { projection: { name: 1, isActive: 1, createdAt: 1 } }).sort({ createdAt: -1, _id: -1 }).skip((p.page - 1) * p.limit).limit(p.limit).toArray(),
    ]);
    const counts = await db.collection('orders').aggregate([{ $match: { user: { $in: rows.map((u) => u._id) } } }, { $group: { _id: '$user', n: { $sum: 1 } } }]).toArray();
    const countOf = new Map(counts.map((c) => [String(c._id), c.n]));
    return {
        customers: rows.map((u) => ({ _id: String(u._id), name: u.name ?? null, isActive: u.isActive !== false, createdAt: u.createdAt ?? null, orderCount: countOf.get(String(u._id)) ?? 0 })),
        pagination: paging(p, total),
    };
});
exports.historyCustomers = historyCustomers;
/** Connection check for diagnostics: connects with the same read-only checks, returns no data and no handle. */
const checkHistoryConnection = async () => {
    try {
        const db = await historyDb();
        return db ? { ok: true, reason: 'connected; login is read-only; orders and users collections present' } : { ok: false, reason: (0, exports.historyConfig)().reason };
    }
    catch (err) {
        return { ok: false, reason: err?.message || String(err) };
    }
};
exports.checkHistoryConnection = checkHistoryConnection;
/** Test hook: forget the cached connection and failure state. */
const resetHistoryForTests = () => { cached = null; failedAt = 0; lastError = ''; };
exports.resetHistoryForTests = resetHistoryForTests;
//# sourceMappingURL=historyDb.js.map