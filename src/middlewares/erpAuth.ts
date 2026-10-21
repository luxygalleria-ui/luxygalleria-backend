import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { errorResponse } from '../utils/responseHandler';

declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
      erpKeyId?: string;
    }
  }
}

const TOLERANCE_SECONDS = 300;

/**
 * ERP_API_KEYS="keyId:secret[,keyId2:secret2]". A second entry lets a secret be rotated without downtime.
 * Sandbox and production deployments each get their own keys. Secrets under 32 characters are ignored.
 */
const parseKeys = (configuration: string) => {
  const keys = new Map<string, string>();
  const keyIds = new Set<string>();
  const entries = configuration.split(',');
  let valid = configuration.trim().length > 0;

  for (const rawEntry of entries) {
    const entry = rawEntry.trim();
    const separator = entry.indexOf(':');
    if (!entry || separator <= 0) {
      valid = false;
      continue;
    }

    const keyId = entry.slice(0, separator).trim();
    const secret = entry.slice(separator + 1).trim();
    if (!keyId || secret.length < 32 || keys.has(keyId)) valid = false;
    if (keyId) keyIds.add(keyId);
    if (keyId && secret.length >= 32) keys.set(keyId, secret);
  }

  return { keys, keyIds: Array.from(keyIds), valid: valid && keys.size > 0 };
};

const loadKeys = () => parseKeys(process.env.ERP_API_KEYS || '').keys;

/** Safe configuration summary for operator diagnostics. Secret material never leaves this module. */
export const getErpKeyConfigurationStatus = () => {
  const { keyIds, valid } = parseKeys(process.env.ERP_API_KEYS || '');
  return { valid, keyIds };
};

// ponytail: in-process replay cache, fine for a single Render instance; move to Mongo/Redis if the API scales out.
const seen = new Map<string, number>();
const isReplay = (signature: string, nowSeconds: number) => {
  for (const [sig, expires] of seen) if (expires < nowSeconds) seen.delete(sig);
  if (seen.has(signature)) return true;
  seen.set(signature, nowSeconds + TOLERANCE_SECONDS * 2);
  return false;
};

const unauthorized = (res: Response, message: string) => errorResponse(res, 401, message, [{ code: 'UNAUTHENTICATED' }]);

/** Key id and timestamp only — cheap enough to run before reading an upload. Also writes the audit line. */
export const erpHeaders = (req: Request, res: Response, next: NextFunction) => {
  const started = Date.now();
  // Audit trail: caller, route and outcome. Never bodies, secrets or customer data.
  res.on('finish', () => console.log(JSON.stringify({
    event: 'ERP_API', keyId: req.erpKeyId || null, claimedKeyId: req.get('X-ERP-Key-Id') || null,
    method: req.method, path: req.originalUrl.split('?')[0], status: res.statusCode, ms: Date.now() - started,
  })));

  const keys = loadKeys();
  if (!keys.size) return errorResponse(res, 503, 'ERP integration is not configured', [{ code: 'UNAVAILABLE' }]);
  if (!keys.has(req.get('X-ERP-Key-Id') || '')) return unauthorized(res, 'Invalid ERP credentials');
  const ts = Number(req.get('X-ERP-Timestamp'));
  if (!Number.isInteger(ts) || Math.abs(Date.now() / 1000 - ts) > TOLERANCE_SECONDS) {
    return unauthorized(res, `X-ERP-Timestamp missing or more than ${TOLERANCE_SECONDS}s from server time`);
  }
  next();
};

/**
 * X-ERP-Signature = hex HMAC-SHA256(secret, `${timestamp}.${METHOD}.${pathWithQuery}.${hex sha256(body)}`)
 * body = raw JSON bytes, the uploaded file bytes for /images, or empty for GET.
 */
export const erpSignature = (bodyOf: (req: Request) => Buffer | undefined) =>
  (req: Request, res: Response, next: NextFunction) => {
    const keyId = req.get('X-ERP-Key-Id') || '';
    const secret = loadKeys().get(keyId);
    if (!secret) return unauthorized(res, 'Invalid ERP credentials');
    const bodyHash = crypto.createHash('sha256').update(bodyOf(req) || Buffer.alloc(0)).digest('hex');
    const expected = crypto.createHmac('sha256', secret)
      .update(`${req.get('X-ERP-Timestamp')}.${req.method}.${req.originalUrl}.${bodyHash}`)
      .digest('hex');
    const given = String(req.get('X-ERP-Signature') || '').toLowerCase();
    if (given.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
      return unauthorized(res, 'Invalid X-ERP-Signature');
    }
    if (isReplay(given, Date.now() / 1000)) return unauthorized(res, 'Replayed request: sign every attempt with a fresh timestamp');
    req.erpKeyId = keyId;
    next();
  };

/** For JSON and GET routes. */
export const erpAuth = [erpHeaders, erpSignature((req) => req.rawBody)];
