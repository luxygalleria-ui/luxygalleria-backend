import crypto from 'crypto';

/**
 * ICICI Orange PG (Gateway_Interface_Specifiation_V0.4_Orange_PG.pdf). Server-side only: the secret key never leaves
 * the backend. Field names follow ICICI's own samples exactly: merchantId, aggregatorID, customerEmailID, secureHash.
 */
export const icici = () => ({
  merchantId: (process.env.ICICI_PG_MERCHANT_ID || '').trim(),
  secret: (process.env.ICICI_PG_SECRET_KEY || '').trim(),
  aggregatorID: (process.env.ICICI_PG_AGGREGATOR_ID || '').trim() || undefined,
  currencyCode: (process.env.ICICI_PG_CURRENCY_CODE || '356').trim(),
  initiateSaleUrl: (process.env.ICICI_PG_INITIATE_SALE_URL || '').trim(),
  commandUrl: (process.env.ICICI_PG_COMMAND_URL || '').trim(),
  returnURL: (process.env.ICICI_PG_RETURN_URL || '').trim(),
});

export const iciciConfigured = () => {
  const c = icici();
  return !!(c.merchantId && c.secret && c.initiateSaleUrl && c.commandUrl && c.returnURL);
};

// ICICI's reference code hashes msg.getBytes("ASCII"): every non-ASCII character becomes "?"
const hmac = (msg: string, key: string) =>
  crypto.createHmac('sha256', key).update(msg.replace(/[^\x00-\x7F]/gu, '?'), 'ascii').digest('hex');

/**
 * Hash V1 (initiateSale, command, return URL, advices): values of every non-empty parameter, in ascending order of
 * parameter name, concatenated; HMAC-SHA256 with the merchant key; lowercase hex. secureHash itself is excluded.
 */
export const hashV1 = (params: Record<string, unknown>, key = icici().secret) =>
  hmac(Object.keys(params).filter((k) => k !== 'secureHash' && params[k] !== null && params[k] !== undefined && params[k] !== '')
    .sort().map((k) => String(params[k])).join(''), key);

/** Hash V2 (only the APIs the spec marks "v2", sent in the `securehash` header): HMAC of the minified JSON string. */
export const hashV2 = (json: object | string, key = icici().secret) => hmac(typeof json === 'string' ? json : JSON.stringify(json), key);

/** Constant-time check of a V1 secureHash received from ICICI. */
export const verifyV1 = (params: Record<string, unknown>, key = icici().secret) => {
  const given = Buffer.from(String(params?.secureHash ?? '').toLowerCase());
  const expected = Buffer.from(hashV1(params, key));
  return !!key && given.length === expected.length && crypto.timingSafeEqual(given, expected);
};

/** Unique alphanumeric merchant reference, 18 chars (ICICI max 20). */
export const newTxnNo = () => `LG${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`.toUpperCase();

/** YYYYMMDDHHMMSS in IST (the server may run in UTC). */
export const istTimestamp = (d = new Date()) => new Date(d.getTime() + 330 * 60_000).toISOString().replace(/\D/g, '').slice(0, 14);

/** Drops empty fields, then adds the V1 secureHash. */
export const signed = (params: Record<string, string | undefined>) => {
  const p = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== '')) as Record<string, string>;
  return { ...p, secureHash: hashV1(p) };
};

const readJson = async (r: Response) => {
  const text = await r.text();
  try { return JSON.parse(text); } catch { throw new Error(`ICICI HTTP ${r.status}: ${text.slice(0, 200)}`); }
};

/** initiateSale takes JSON. */
export const postJson = async (url: string, body: object) =>
  readJson(await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) }));

/** The command API (STATUS / REFUND) takes form-urlencoded. */
export const postForm = async (url: string, params: Record<string, string>) =>
  readJson(await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params), signal: AbortSignal.timeout(20_000) }));

export const isIciciSuccess = (code: unknown) => code === '000' || code === '0000';
