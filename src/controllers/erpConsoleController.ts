import { Request, Response, NextFunction } from 'express';
import { loadKeys, signErpRequest } from '../middlewares/erpAuth';
import { successResponse, errorResponse } from '../utils/responseHandler';

/**
 * Admin-only test console for the ERP API (/api/v1/erp-console/*).
 * Each console route mirrors one /api/v1/erp route: the request is signed here, on the server, with the key
 * named by ERP_CONSOLE_KEY_ID, and sent to this same server over loopback. Secrets and signatures never reach
 * the browser, and the target is always this server's own /api/v1/erp router (no arbitrary URLs).
 * Disabled unless ERP_CONSOLE_KEY_ID is set — leave it unset on production.
 */

const consoleKey = () => {
  const keyId = (process.env.ERP_CONSOLE_KEY_ID || '').trim();
  const secret = keyId ? loadKeys().get(keyId) : undefined;
  return keyId && secret ? { keyId, secret } : null;
};

export const WRITE_CONFIRM_HEADER = 'X-ERP-Console-Confirm';

// GET /erp-console/status — lets the page say whether the console is usable here, without revealing secrets
export const consoleStatus = (req: Request, res: Response) => {
  const key = consoleKey();
  successResponse(res, 200, key ? 'ERP test console enabled' : 'ERP test console is not enabled on this server', {
    enabled: Boolean(key),
    keyId: key?.keyId ?? null,
  });
};

export const requireConsole = (req: Request, res: Response, next: NextFunction) => {
  if (!consoleKey()) {
    return errorResponse(res, 503, 'ERP test console is not enabled on this server (set ERP_CONSOLE_KEY_ID to a key in ERP_API_KEYS)', [{ code: 'UNAVAILABLE' }]);
  }
  // Writes need an explicit confirmation header, so nothing changes data by accident (prefetch, stray scripts)
  if (req.method !== 'GET' && req.get(WRITE_CONFIRM_HEADER) !== 'write') {
    return errorResponse(res, 400, `Write requests need the ${WRITE_CONFIRM_HEADER}: write header`, [{ code: 'CONFIRMATION_REQUIRED' }]);
  }
  // A "." or ".." path segment would be resolved away by the URL parser and change the target route
  if (Object.values(req.params).some((v) => /^\.{1,2}$/.test(v.trim()))) {
    return errorResponse(res, 400, 'Invalid path parameter', [{ code: 'VALIDATION_ERROR' }]);
  }
  next();
};

// The ERP rejects a signature it has seen before, and identical requests within one second sign identically
// (timestamps are whole seconds). Wait for the next second rather than fail a legitimate repeat.
const issued = new Map<string, number>(); // signature -> ms issued
const freshSignature = async (secret: string, method: string, path: string, body?: Buffer) => {
  for (;;) {
    const now = Date.now();
    const timestamp = String(Math.floor(now / 1000));
    const signature = signErpRequest(secret, timestamp, method, path, body);
    for (const [sig, at] of issued) if (now - at > 2000) issued.delete(sig);
    if (!issued.has(signature)) {
      issued.set(signature, now);
      return { timestamp, signature };
    }
    await new Promise((r) => setTimeout(r, 1000 - (now % 1000) + 5));
  }
};

// Mirrors the matched console route onto /api/v1/erp and returns the ERP's real status and body.
export const forwardToErp = async (req: Request, res: Response) => {
  const key = consoleKey()!;
  const path = req.baseUrl.replace(/\/erp-console$/, '/erp') + req.url;
  const method = req.method;

  let body: Buffer | undefined;
  let payload: RequestInit['body'];
  const headers: Record<string, string> = {};
  if (req.file) {
    // /images: the signature covers the file bytes; FormData supplies the multipart boundary
    body = req.file.buffer;
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array(req.file.buffer)], { type: req.file.mimetype }), req.file.originalname);
    payload = form;
  } else if (method !== 'GET') {
    body = Buffer.from(JSON.stringify(req.body ?? {}));
    payload = new Uint8Array(body);
    headers['Content-Type'] = 'application/json';
  }

  const { timestamp, signature } = await freshSignature(key.secret, method, path, body);
  headers['X-ERP-Key-Id'] = key.keyId;
  headers['X-ERP-Timestamp'] = timestamp;
  headers['X-ERP-Signature'] = signature;

  const started = Date.now();
  let status: number;
  let responseBody: unknown;
  try {
    const upstream = await fetch(`http://127.0.0.1:${req.socket.localPort}${path}`, {
      method, headers, body: payload, signal: AbortSignal.timeout(30_000),
    });
    status = upstream.status;
    const text = await upstream.text();
    try { responseBody = JSON.parse(text); } catch { responseBody = text; }
  } catch (err: any) {
    console.error('ERP console request failed:', err?.message);
    return errorResponse(res, 502, 'Could not reach the ERP API on this server', [{ code: 'UPSTREAM_ERROR' }]);
  }

  // Audit: who ran what, never bodies or secrets
  console.log(JSON.stringify({ event: 'ERP_CONSOLE', adminId: String(req.user?._id), keyId: key.keyId, method, path: path.split('?')[0], status }));

  // Always 200 here: the ERP's own status (including its 401s) is data for the page, not this admin's session state.
  successResponse(res, 200, 'ERP API response', {
    request: { method, path },
    status,
    durationMs: Date.now() - started,
    body: responseBody,
  });
};
