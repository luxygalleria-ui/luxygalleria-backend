"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isIciciSuccess = exports.postForm = exports.postJson = exports.signed = exports.saleTxnDate = exports.istTimestamp = exports.newTxnNo = exports.verifyV1 = exports.hashV2 = exports.hashV1 = exports.iciciConfigured = exports.icici = void 0;
const crypto_1 = __importDefault(require("crypto"));
/**
 * ICICI Orange PG (Gateway_Interface_Specifiation_V0.4_Orange_PG.pdf). Server-side only: the secret key never leaves
 * the backend. Field names follow ICICI's own samples exactly: merchantId, aggregatorID, customerEmailID, secureHash.
 */
const icici = () => ({
    merchantId: (process.env.ICICI_PG_MERCHANT_ID || '').trim(),
    secret: (process.env.ICICI_PG_SECRET_KEY || '').trim(),
    aggregatorID: (process.env.ICICI_PG_AGGREGATOR_ID || '').trim() || undefined,
    currencyCode: (process.env.ICICI_PG_CURRENCY_CODE || '356').trim(),
    initiateSaleUrl: (process.env.ICICI_PG_INITIATE_SALE_URL || '').trim(),
    commandUrl: (process.env.ICICI_PG_COMMAND_URL || '').trim(),
    returnURL: (process.env.ICICI_PG_RETURN_URL || '').trim(),
});
exports.icici = icici;
const iciciConfigured = () => {
    const c = (0, exports.icici)();
    return !!(c.merchantId && c.secret && c.initiateSaleUrl && c.commandUrl && c.returnURL);
};
exports.iciciConfigured = iciciConfigured;
// ICICI's reference code hashes msg.getBytes("ASCII"): every non-ASCII character becomes "?"
const hmac = (msg, key) => crypto_1.default.createHmac('sha256', key).update(msg.replace(/[^\x00-\x7F]/gu, '?'), 'ascii').digest('hex');
/**
 * Hash V1 (initiateSale, command, return URL, advices): values of every non-empty parameter, in ascending order of
 * parameter name, concatenated; HMAC-SHA256 with the merchant key; lowercase hex. secureHash itself is excluded.
 */
const hashV1 = (params, key = (0, exports.icici)().secret) => hmac(Object.keys(params).filter((k) => k !== 'secureHash' && params[k] !== null && params[k] !== undefined && params[k] !== '')
    .sort().map((k) => String(params[k])).join(''), key);
exports.hashV1 = hashV1;
/** Hash V2 (only the APIs the spec marks "v2", sent in the `securehash` header): HMAC of the minified JSON string. */
const hashV2 = (json, key = (0, exports.icici)().secret) => hmac(typeof json === 'string' ? json : JSON.stringify(json), key);
exports.hashV2 = hashV2;
/** Constant-time check of a V1 secureHash received from ICICI. */
const verifyV1 = (params, key = (0, exports.icici)().secret) => {
    const given = Buffer.from(String(params?.secureHash ?? '').toLowerCase());
    const expected = Buffer.from((0, exports.hashV1)(params, key));
    return !!key && given.length === expected.length && crypto_1.default.timingSafeEqual(given, expected);
};
exports.verifyV1 = verifyV1;
/** Unique alphanumeric merchant reference, 18 chars (ICICI max 20). */
const newTxnNo = () => `LG${Date.now().toString(36)}${crypto_1.default.randomBytes(4).toString('hex')}`.toUpperCase();
exports.newTxnNo = newTxnNo;
/** YYYYMMDDHHMMSS in IST (the server may run in UTC). */
const istTimestamp = (d = new Date()) => new Date(d.getTime() + 330 * 60_000).toISOString().replace(/\D/g, '').slice(0, 14);
exports.istTimestamp = istTimestamp;
/**
 * initiateSale txnDate. Step-wise doc: "greater than payment initiation time, max 235959 with current date". So: now + 5 min,
 * capped at 23:59:59 IST today (a payment started just before midnight still gets a same-day txnDate).
 */
const saleTxnDate = (now = new Date()) => {
    const later = (0, exports.istTimestamp)(new Date(now.getTime() + 5 * 60_000));
    const today = (0, exports.istTimestamp)(now).slice(0, 8);
    return later.startsWith(today) ? later : `${today}235959`;
};
exports.saleTxnDate = saleTxnDate;
/** Drops empty fields, then adds the V1 secureHash. */
const signed = (params) => {
    const p = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== ''));
    return { ...p, secureHash: (0, exports.hashV1)(p) };
};
exports.signed = signed;
const readJson = async (r) => {
    const text = await r.text();
    try {
        return JSON.parse(text);
    }
    catch {
        throw new Error(`ICICI HTTP ${r.status}: ${text.slice(0, 200)}`);
    }
};
/** initiateSale takes JSON. */
const postJson = async (url, body) => readJson(await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) }));
exports.postJson = postJson;
/** The command API (STATUS / REFUND) takes form-urlencoded. */
const postForm = async (url, params) => readJson(await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params), signal: AbortSignal.timeout(20_000) }));
exports.postForm = postForm;
const isIciciSuccess = (code) => code === '000' || code === '0000';
exports.isIciciSuccess = isIciciSuccess;
//# sourceMappingURL=iciciPg.js.map