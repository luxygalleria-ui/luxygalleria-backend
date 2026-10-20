"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.erpAuth = exports.erpSignature = exports.signErpRequest = exports.erpHeaders = exports.loadKeys = void 0;
const crypto_1 = __importDefault(require("crypto"));
const responseHandler_1 = require("../utils/responseHandler");
const TOLERANCE_SECONDS = 300;
/**
 * ERP_API_KEYS="keyId:secret[,keyId2:secret2]". A second entry lets a secret be rotated without downtime.
 * Sandbox and production deployments each get their own keys. Secrets under 32 characters are ignored.
 */
const loadKeys = () => {
    const keys = new Map();
    for (const entry of (process.env.ERP_API_KEYS || '').split(',')) {
        const i = entry.indexOf(':');
        if (i <= 0)
            continue;
        const secret = entry.slice(i + 1).trim();
        if (secret.length >= 32)
            keys.set(entry.slice(0, i).trim(), secret);
    }
    return keys;
};
exports.loadKeys = loadKeys;
// ponytail: in-process replay cache, fine for a single Render instance; move to Mongo/Redis if the API scales out.
const seen = new Map();
const isReplay = (signature, nowSeconds) => {
    for (const [sig, expires] of seen)
        if (expires < nowSeconds)
            seen.delete(sig);
    if (seen.has(signature))
        return true;
    seen.set(signature, nowSeconds + TOLERANCE_SECONDS * 2);
    return false;
};
const unauthorized = (res, message) => (0, responseHandler_1.errorResponse)(res, 401, message, [{ code: 'UNAUTHENTICATED' }]);
/** Key id and timestamp only — cheap enough to run before reading an upload. Also writes the audit line. */
const erpHeaders = (req, res, next) => {
    const started = Date.now();
    // Audit trail: caller, route and outcome. Never bodies, secrets or customer data.
    res.on('finish', () => console.log(JSON.stringify({
        event: 'ERP_API', keyId: req.erpKeyId || null, claimedKeyId: req.get('X-ERP-Key-Id') || null,
        method: req.method, path: req.originalUrl.split('?')[0], status: res.statusCode, ms: Date.now() - started,
    })));
    const keys = (0, exports.loadKeys)();
    if (!keys.size)
        return (0, responseHandler_1.errorResponse)(res, 503, 'ERP integration is not configured', [{ code: 'UNAVAILABLE' }]);
    if (!keys.has(req.get('X-ERP-Key-Id') || ''))
        return unauthorized(res, 'Invalid ERP credentials');
    const ts = Number(req.get('X-ERP-Timestamp'));
    if (!Number.isInteger(ts) || Math.abs(Date.now() / 1000 - ts) > TOLERANCE_SECONDS) {
        return unauthorized(res, `X-ERP-Timestamp missing or more than ${TOLERANCE_SECONDS}s from server time`);
    }
    next();
};
exports.erpHeaders = erpHeaders;
/**
 * X-ERP-Signature = hex HMAC-SHA256(secret, `${timestamp}.${METHOD}.${pathWithQuery}.${hex sha256(body)}`)
 * body = raw JSON bytes, the uploaded file bytes for /images, or empty for GET.
 */
const signErpRequest = (secret, timestamp, method, pathWithQuery, body) => {
    const bodyHash = crypto_1.default.createHash('sha256').update(body || Buffer.alloc(0)).digest('hex');
    return crypto_1.default.createHmac('sha256', secret).update(`${timestamp}.${method}.${pathWithQuery}.${bodyHash}`).digest('hex');
};
exports.signErpRequest = signErpRequest;
const erpSignature = (bodyOf) => (req, res, next) => {
    const keyId = req.get('X-ERP-Key-Id') || '';
    const secret = (0, exports.loadKeys)().get(keyId);
    if (!secret)
        return unauthorized(res, 'Invalid ERP credentials');
    const expected = (0, exports.signErpRequest)(secret, String(req.get('X-ERP-Timestamp')), req.method, req.originalUrl, bodyOf(req));
    const given = String(req.get('X-ERP-Signature') || '').toLowerCase();
    if (given.length !== expected.length || !crypto_1.default.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
        return unauthorized(res, 'Invalid X-ERP-Signature');
    }
    if (isReplay(given, Date.now() / 1000))
        return unauthorized(res, 'Replayed request: sign every attempt with a fresh timestamp');
    req.erpKeyId = keyId;
    next();
};
exports.erpSignature = erpSignature;
/** For JSON and GET routes. */
exports.erpAuth = [exports.erpHeaders, (0, exports.erpSignature)((req) => req.rawBody)];
//# sourceMappingURL=erpAuth.js.map