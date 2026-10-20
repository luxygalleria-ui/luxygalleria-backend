"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.forwardToErp = exports.requireConsole = exports.consoleStatus = exports.WRITE_CONFIRM_HEADER = void 0;
const erpAuth_1 = require("../middlewares/erpAuth");
const responseHandler_1 = require("../utils/responseHandler");
/**
 * Admin-only test console for the ERP API (/api/v1/erp-console/*).
 * Each console route mirrors one /api/v1/erp route: the request is signed here, on the server, with the key
 * named by ERP_CONSOLE_KEY_ID, and sent to this same server over loopback. Secrets and signatures never reach
 * the browser, and the target is always this server's own /api/v1/erp router (no arbitrary URLs).
 * Disabled unless ERP_CONSOLE_KEY_ID is set — leave it unset on production.
 */
const consoleKey = () => {
    const keyId = (process.env.ERP_CONSOLE_KEY_ID || '').trim();
    const secret = keyId ? (0, erpAuth_1.loadKeys)().get(keyId) : undefined;
    return keyId && secret ? { keyId, secret } : null;
};
exports.WRITE_CONFIRM_HEADER = 'X-ERP-Console-Confirm';
// GET /erp-console/status — lets the page say whether the console is usable here, without revealing secrets
const consoleStatus = (req, res) => {
    const key = consoleKey();
    (0, responseHandler_1.successResponse)(res, 200, key ? 'ERP test console enabled' : 'ERP test console is not enabled on this server', {
        enabled: Boolean(key),
        keyId: key?.keyId ?? null,
    });
};
exports.consoleStatus = consoleStatus;
const requireConsole = (req, res, next) => {
    if (!consoleKey()) {
        return (0, responseHandler_1.errorResponse)(res, 503, 'ERP test console is not enabled on this server (set ERP_CONSOLE_KEY_ID to a key in ERP_API_KEYS)', [{ code: 'UNAVAILABLE' }]);
    }
    // Writes need an explicit confirmation header, so nothing changes data by accident (prefetch, stray scripts)
    if (req.method !== 'GET' && req.get(exports.WRITE_CONFIRM_HEADER) !== 'write') {
        return (0, responseHandler_1.errorResponse)(res, 400, `Write requests need the ${exports.WRITE_CONFIRM_HEADER}: write header`, [{ code: 'CONFIRMATION_REQUIRED' }]);
    }
    // A "." or ".." path segment would be resolved away by the URL parser and change the target route
    if (Object.values(req.params).some((v) => /^\.{1,2}$/.test(v.trim()))) {
        return (0, responseHandler_1.errorResponse)(res, 400, 'Invalid path parameter', [{ code: 'VALIDATION_ERROR' }]);
    }
    next();
};
exports.requireConsole = requireConsole;
// The ERP rejects a signature it has seen before, and identical requests within one second sign identically
// (timestamps are whole seconds). Wait for the next second rather than fail a legitimate repeat.
const issued = new Map(); // signature -> ms issued
const freshSignature = async (secret, method, path, body) => {
    for (;;) {
        const now = Date.now();
        const timestamp = String(Math.floor(now / 1000));
        const signature = (0, erpAuth_1.signErpRequest)(secret, timestamp, method, path, body);
        for (const [sig, at] of issued)
            if (now - at > 2000)
                issued.delete(sig);
        if (!issued.has(signature)) {
            issued.set(signature, now);
            return { timestamp, signature };
        }
        await new Promise((r) => setTimeout(r, 1000 - (now % 1000) + 5));
    }
};
// Mirrors the matched console route onto /api/v1/erp and returns the ERP's real status and body.
const forwardToErp = async (req, res) => {
    const key = consoleKey();
    const path = req.baseUrl.replace(/\/erp-console$/, '/erp') + req.url;
    const method = req.method;
    let body;
    let payload;
    const headers = {};
    if (req.file) {
        // /images: the signature covers the file bytes; FormData supplies the multipart boundary
        body = req.file.buffer;
        const form = new FormData();
        form.append('image', new Blob([new Uint8Array(req.file.buffer)], { type: req.file.mimetype }), req.file.originalname);
        payload = form;
    }
    else if (method !== 'GET') {
        body = Buffer.from(JSON.stringify(req.body ?? {}));
        payload = new Uint8Array(body);
        headers['Content-Type'] = 'application/json';
    }
    const { timestamp, signature } = await freshSignature(key.secret, method, path, body);
    headers['X-ERP-Key-Id'] = key.keyId;
    headers['X-ERP-Timestamp'] = timestamp;
    headers['X-ERP-Signature'] = signature;
    const started = Date.now();
    let status;
    let responseBody;
    try {
        const upstream = await fetch(`http://127.0.0.1:${req.socket.localPort}${path}`, {
            method, headers, body: payload, signal: AbortSignal.timeout(30_000),
        });
        status = upstream.status;
        const text = await upstream.text();
        try {
            responseBody = JSON.parse(text);
        }
        catch {
            responseBody = text;
        }
    }
    catch (err) {
        console.error('ERP console request failed:', err?.message);
        return (0, responseHandler_1.errorResponse)(res, 502, 'Could not reach the ERP API on this server', [{ code: 'UPSTREAM_ERROR' }]);
    }
    // Audit: who ran what, never bodies or secrets
    console.log(JSON.stringify({ event: 'ERP_CONSOLE', adminId: String(req.user?._id), keyId: key.keyId, method, path: path.split('?')[0], status }));
    // Always 200 here: the ERP's own status (including its 401s) is data for the page, not this admin's session state.
    (0, responseHandler_1.successResponse)(res, 200, 'ERP API response', {
        request: { method, path },
        status,
        durationMs: Date.now() - started,
        body: responseBody,
    });
};
exports.forwardToErp = forwardToErp;
//# sourceMappingURL=erpConsoleController.js.map