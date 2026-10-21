import { createHash, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const sign = (secret, timestamp, method, pathWithQuery, signedBody = Buffer.alloc(0)) => {
  const stringToSign = `${timestamp}.${method}.${pathWithQuery}.${sha256(signedBody)}`;
  return createHmac('sha256', secret).update(stringToSign).digest('hex');
};

const verifyVector = () => {
  const body = Buffer.from('{"quantity":25,"asOf":"2026-10-17T09:30:00Z"}');
  const signature = sign(
    'test_secret_0123456789abcdef0123456789ab',
    '1792222200',
    'PUT',
    '/api/v1/erp/stock/YOUR_SKU',
    body,
  );
  if (signature !== '063c8145c1ab838827f3f78197594d0c1cee60e1d23f1be8e55b711d81d2c116') {
    throw new Error('Signing vector did not match');
  }
  console.log('Signing vector verified');
};

const request = async ({ method, route, requestBody, signedBody = requestBody, expectedStatus }) => {
  const keyId = process.env.ERP_KEY_ID;
  const secret = process.env.ERP_SECRET;
  const base = new URL(process.env.ERP_API_BASE_URL || 'https://api.luxygalleria.com/api/v1');
  if (!keyId || !secret) throw new Error('Set ERP_KEY_ID and ERP_SECRET in the client environment');
  if (base.protocol !== 'https:' && base.hostname !== 'localhost') throw new Error('ERP_API_BASE_URL must use HTTPS');

  const target = new URL(route.replace(/^\/+/, ''), `${base.toString().replace(/\/$/, '')}/`);
  const pathWithQuery = `${target.pathname}${target.search}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const headers = {
    'X-ERP-Key-Id': keyId,
    'X-ERP-Timestamp': timestamp,
    'X-ERP-Signature': sign(secret, timestamp, method, pathWithQuery, signedBody),
  };
  if (requestBody instanceof Buffer) headers['Content-Type'] = 'application/json';

  const response = await fetch(target, { method, headers, body: requestBody });
  console.log(`HTTP ${response.status}`);
  if (expectedStatus !== undefined && response.status !== expectedStatus) {
    console.error(`Expected HTTP ${expectedStatus}`);
    process.exitCode = 1;
  }
  return response.status;
};

const [mode, filePath] = process.argv.slice(2);

if (mode === '--verify-vector') {
  verifyVector();
} else if (mode === 'get') {
  await request({ method: 'GET', route: 'erp/orders?limit=1', expectedStatus: 200 });
} else if (mode === 'json-validation') {
  const rawBody = Buffer.from('{}');
  await request({ method: 'POST', route: 'erp/items', requestBody: rawBody, expectedStatus: 400 });
} else if (mode === 'upload') {
  if (!filePath) throw new Error('Usage: node docs/erp-signing-client.mjs upload <image-path>');
  const fileBytes = await readFile(filePath);
  const mimeByExtension = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
  const mimeType = mimeByExtension[extname(filePath).toLowerCase()];
  if (!mimeType) throw new Error('Image must use a .jpg, .jpeg, .png or .webp extension');

  const form = new FormData();
  form.append('image', new Blob([new Uint8Array(fileBytes)], { type: mimeType }), basename(filePath));
  await request({ method: 'POST', route: 'erp/images', requestBody: form, signedBody: fileBytes, expectedStatus: 201 });
} else {
  throw new Error('Usage: node docs/erp-signing-client.mjs <get|json-validation|upload|--verify-vector> [image-path]');
}