# Luxy Galleria ERP API — Developer Handover

For the ERP development team. This guide gets you connected and testing. The full contract, with every field and error, is `ERP-INTEGRATION-API-SPEC.md`; section numbers below refer to it.

## 1. What you receive

| Item | File |
|---|---|
| API specification | `docs/ERP-INTEGRATION-API-SPEC.md` |
| Postman collection, classic JSON (21 requests, automatic signing, tests) | `postman/Luxy-Galleria-ERP-API.postman_collection.json` |
| Postman environments, classic JSON (credentials blank) | `postman/Luxy-Galleria-ERP-Local-Staging.postman_environment.json` (use for all testing); `postman/Luxy-Galleria-ERP-Production.postman_environment.json` |
| The same collection and Local / Staging environment for **Postman Local Mode** (YAML) | `postman/local-mode/` |
| Node.js signing example | `docs/erp-signing-client.mjs` |
| Key ID and secret | Sent separately by Luxy Galleria through a one-time secret link. Staging and production keys are different. |

## 2. Base URL

| Environment | `baseUrl` |
|---|---|
| Local backend | `http://localhost:5000/api/v1` (the backend's default port) |
| Staging | Provided by Luxy Galleria when staging exists (not yet available) |
| Production | `https://api.luxygalleria.com/api/v1` |

Paths below are relative to `baseUrl`, which already ends in `/api/v1`. For example, `{{baseUrl}}/erp/items` is the item list. Do not add `/api/v1` again.

## 3. Endpoints

| # | Function | Method and path | Direction | Spec |
|---|---|---|---|---|
| 1 | Item List | `GET /erp/items?page=&limit=&search=` | ERP reads website | 6A |
| 2 | Item Lookup | `GET /erp/items/{sku}` | ERP reads website | 6B |
| 3 | Item Add / Upsert | `POST /erp/items` | ERP → website | 5 |
| 4 | Item Edit | `PATCH /erp/items/{sku}` | ERP → website | 6 |
| 5 | Stock Update | `PUT /erp/stock/{sku}` | ERP → website | 4 |
| 6 | Order Checking | `GET /erp/orders?page=&limit=&status=&paymentStatus=&updatedSince=` | ERP reads website | 7 |
| 7 | Order Details | `GET /erp/orders/{orderId}` | ERP reads website | 8 |
| 8 | Order Status Callback | `POST /erp/webhooks/order-status` | ERP → website | 9 |
| 9 | Image Upload | `POST /erp/images` (multipart, one file in field `image`) | ERP → website | 10 |

**Orders:** the ERP **pulls** orders (6, 7). The website does **not** push orders to the ERP; automatic outbound order push is not implemented.

## 4. Authentication (every request)

| Header | Value |
|---|---|
| `X-ERP-Key-Id` | Your key ID |
| `X-ERP-Timestamp` | Current Unix time in whole **seconds**, within ±300 s of server time |
| `X-ERP-Signature` | Lowercase hex `HMAC-SHA256(secret, timestamp + "." + METHOD + "." + pathWithQuery + "." + sha256hex(body))` |

- `pathWithQuery` is the path exactly as sent, starting with `/api/v1`, plus any query string in the order sent. Example: `/api/v1/erp/orders?page=1&limit=10`.
- `body` is the exact bytes sent. For a `GET` it is empty, and its `sha256hex` is `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`. For Image Upload it is the **file bytes** only, not the multipart envelope.
- JSON requests need `Content-Type: application/json`. Without it the server hashes an empty body and returns `401 Invalid X-ERP-Signature`.
- **Sign every attempt with a fresh timestamp.** An identical signed request sent again within 10 minutes is refused as a replay.
- To check your implementation, use the test vector in spec §2.3: secret `test_secret_0123456789abcdef0123456789ab`, timestamp `1792222200`, `PUT /api/v1/erp/stock/YOUR_SKU`, body `{"quantity":25,"asOf":"2026-10-17T09:30:00Z"}`. The expected signature is `063c8145c1ab838827f3f78197594d0c1cee60e1d23f1be8e55b711d81d2c116`. `node docs/erp-signing-client.mjs --verify-vector` checks it offline.

| Response | Cause |
|---|---|
| `401 Invalid ERP credentials` | Key ID missing or unknown, or the request was not signed |
| `401 X-ERP-Timestamp missing or more than 300s from server time` | Clock wrong, or the timestamp is in milliseconds |
| `401 Invalid X-ERP-Signature` | Wrong secret, or the path, query, body or `Content-Type` differs from what was signed |
| `401 Replayed request: …` | The same signed request was sent again; re-sign it |
| `429 RATE_LIMITED` | More than 600 requests per minute; honour `Retry-After` |
| `503 ERP integration is not configured` | The server has no keys (fails closed) |

## 5. Responses and errors

Success: `{ "success": true, "message": "…", "data": … }`. Error: `{ "success": false, "message": "…", "errors": [{ "code": "…", "field": "…", "message": "…" }] }`.

Example validation error (captured):

```json
{"success":false,"message":"Validation failed","errors":[{"field":"quantity","code":"VALIDATION_ERROR","message":"Number must be greater than or equal to 0"}]}
```

Codes: `VALIDATION_ERROR` (400), `UNAUTHENTICATED` (401), `NOT_FOUND` (404), `DUPLICATE_SKU`, `CONFLICT`, `STALE_UPDATE`, `INVALID_TRANSITION`, `UNMAPPED_PRODUCT` (409), `PAYLOAD_TOO_LARGE` (413), `RATE_LIMITED` (429), `UPSTREAM_ERROR` (502), `UNAVAILABLE` (503).

Stock and item bodies are **strict**: an unknown field gives `400`. The status callback ignores unknown fields.

## 6. Rules that matter most

**SKUs**
- Matching is exact and case-sensitive after trimming. One SKU = one website variant.
- Item List shows website variants that have no SKU yet (`sku: null`). Agree their item codes with Luxy Galleria before syncing.
- `409 UNMAPPED_PRODUCT` on Item Add means the website already has that product without SKUs. Ask Luxy Galleria to set your SKU on it; do not create it again.

**Stock** (`PUT /erp/stock/{sku}`, body `{ "quantity": 25, "asOf": "2026-10-23T04:27:41Z" }`)
- `quantity` is an **absolute** figure, not a change.
- Stored stock = `quantity` − units in website orders placed after `asOf` − units held by open website checkouts. Abandoned checkouts can never push stock above your figure. **Provisional:** whether `quantity` is physical or sellable stock is not yet confirmed.
- Same `asOf` again → `200`, `applied: false`. Older `asOf` → `409 STALE_UPDATE`.
- `409 CONFLICT` with a message ending in *retry it* (stock kept changing during the update) → nothing was written; retry unchanged with a fresh signature.

Successful response (captured; the current version also returns `reservedQuantity`):

```json
{"success":true,"message":"Stock updated","data":{"sku":"SKU-001","productId":"6adae279d6f61832746849b1","variantId":"6adae279d6f61832746849b2","asOf":"2026-10-23T04:27:41.000Z","previousQuantity":10,"quantity":25,"erpQuantity":25,"pendingOrderQuantity":0,"applied":true,"updatedAt":"2026-10-23T04:28:41.865Z"}}
```

**Items**
- Item Add matches on SKU and never duplicates. Stock is applied only when a variant is created.
- Item Edit changes only the fields you send. It cannot change stock or the SKU.

**Order polling**
- Keep the newest `updatedAt` you received and pass it as `updatedSince` next time.
- De-duplicate by `orderId`; the boundary order is returned again.
- Order lines carry the SKU and product name as sold.

**Status callback** (`{ "eventId", "orderId", "status", "occurredAt", "erpOrderId"?, "trackingNumber"? }`)
- Send one unique `eventId` per event, and retry with the same `eventId`.
- Transitions move forward only: `processing` → `shipped` → `delivered`, and `cancelled` until delivered. `delivered` and `cancelled` are final.
- Outcomes: `applied` (customer emailed once), `unchanged`, `stale` (older than the last change), `duplicate`. A backwards move → `409 INVALID_TRANSITION`.
- Cancelling does not refund or restock.

**Images**
- JPG, PNG or WEBP, up to 15 MB. The extension, content type and file bytes must agree. Exactly one file in field `image`.
- Returns `201` with `data.url`. Use that URL in `imageUrls` or `variants[].image`.

**Retries**
- Retry `429`, `502`, `503` and timeouts with backoff, re-signing each attempt.
- Fix the request before retrying `400`, `401`, `404` or `409`, except a `409 CONFLICT` saying *retry it*.

## 7. Postman setup

**A. Classic Postman (signed in to a workspace):**
1. **Import** → `postman/Luxy-Galleria-ERP-API.postman_collection.json` and `postman/Luxy-Galleria-ERP-Local-Staging.postman_environment.json`.
2. Select the environment **Luxy Galleria ERP - Local / Staging** (top right).

**B. Postman Local Mode** (if Postman says JSON collections and environments are unsupported in Local Mode). The `postman/local-mode/` folder is a local Postman workspace in the YAML format that Local Mode uses. It was generated with the Postman CLI (`postman collection migrate`, `postman environment new`) and linted with 0 errors.
1. In Postman's Local Mode, open the `postman/local-mode` folder as the workspace. It holds `.postman/resources.yaml`, `postman/collections/Luxy Galleria ERP API/` and `postman/environments/`.
2. If your Postman version shows no "open folder" option, copy those two `postman/` subfolders into the folder your Local Mode workspace already uses.

The YAML files were verified with the Postman CLI. Opening them in the desktop app has **not** been verified by Luxy Galleria. If it fails, use option A, or ask Luxy Galleria for the same files exported from a signed-in workspace.

**Then, in either mode,** set these as **Current values** only (never as initial values, never exported):

| Variable | Enter |
|---|---|
| `baseUrl` | Section 2 (local default is preset) |
| `erpKeyId`, `erpSecret` | Your **non-production** key for local or staging |
| `itemSku` | An approved test SKU (`ERP-TEST-SKU-001` is created by request 1 on a local or staging database) |
| `orderId` | A test order id copied from *4. Order Checking* |
| `orderStatus`, `trackingNumber` | Status to send in request 7 (it must be a forward move for that order) and a test tracking number |
| `imageSha256` | SHA-256 of the image you select in request 6: `shasum -a 256 file.png` (macOS/Linux) or `certutil -hashfile file.png SHA256` (Windows) |
| `stockQuantity`, `categoryName`, `eventId` | Preset; `categoryName` must be an existing website category; leave `eventId` blank (a new id is generated per send) |

The collection's pre-request script signs every request. You never type the `X-ERP-*` headers.

### Troubleshooting `401 Invalid X-ERP-Signature`

This error means the key ID **was** accepted and the clock is fine, so only the signature differs. Open **View → Postman Console** and send again. The collection prints two lines:

- `Signed as: {keyId, timestamp, method, pathWithQuery, bodySha256, secretLength, secretFingerprint}`: what the script signed. `secretFingerprint` is the first 12 hex characters of SHA-256 of the secret, never the secret itself.
- `Sent: <method> <url> | X-ERP-Key-Id=…`: what Postman actually sent.

Check, in order:

1. **`Signed as` is missing.** The collection pre-request script did not run: the request is not inside this collection, or it has its own pasted script. Use the collection's requests as supplied, and delete any request-level signing script.
2. **The secret is wrong** (the usual cause). Compare `secretFingerprint` with the server's fingerprint for the same key ID. On the backend host, without printing any secret:
   ```bash
   node -e "require('dotenv').config(); const c=require('crypto'); for (const e of (process.env.ERP_API_KEYS||'').split(',')) { const i=e.indexOf(':'); if (i>0) console.log(e.slice(0,i).trim(), c.createHash('sha256').update(e.slice(i+1).trim()).digest('hex').slice(0,12)); }"
   ```
   If they differ, re-enter `erpSecret` as the **Current value**: exactly the secret paired with that key ID in `ERP_API_KEYS`, with no quotes, prefix or comment text. `secretLength` must match too (Luxy Galleria issues 64-character secrets).
3. **The request was changed after signing.** `pathWithQuery` must equal the path and query in `Sent`. Don't edit the URL, add `/api/v1` twice, or put Postman dynamic variables such as `{{$guid}}` in a body.
4. **The wrong environment is selected** (top right). The key ID and secret must belong to the backend that `baseUrl` points at.

## 8. Test sequence

Run against a **local or approved staging** database. Write requests (1–3, 6, 7, W1–W4) change data; never run them against production without an approved test SKU and test order.

| Step | Request | Expected |
|---|---|---|
| 1 | `0. Health check` | `200` |
| 2 | `1. Item Add`, then `2. Item Edit` (on an existing approved SKU, skip 1) | `201`/`200`; then `200` |
| 3 | `8. Item List`, `9. Item Lookup` | `200`; the lookup returns `itemSku` |
| 4 | `N1` unknown SKU | `404 NOT_FOUND` |
| 5 | `3. Stock Update`, then `W1` (same `asOf`), `W2` (older `asOf`) | `200 applied: true`; `200 applied: false`; `409 STALE_UPDATE` |
| 6 | `4. Order Checking`, `5. Order Details` | `200` |
| 7 | `7. Order Status Callback`, then `W3` (same `eventId`), `W4` (backwards) | `200 applied`; `200 duplicate: true`; `409 INVALID_TRANSITION` |
| 8 | `6. Image Upload` with a real approved test image and `imageSha256` set | `201` with `data.url` (stores the image in the configured test storage) |
| 9 | `N0` unsigned, `N4` wrong signature, `N5` expired timestamp, `N6` unknown key, `N2`/`N3` validation | `401` ×4, `400` ×2 |

`409 CONFLICT` on stock (stock changing during the update) cannot be triggered safely from Postman. It is covered by Luxy Galleria's automated tests.

## 9. Not supported yet / awaiting decisions

- **Not implemented:** website → ERP order push; customer master sync; deleting or deactivating products; setting GST/HSN, variant name or description via the API; refunds and payment status; restocking on cancellation.
- **Needs your answers** (spec §14):
  1. Is `quantity` physical or sellable stock, and are website orders already deducted?
  2. SKU format, and the codes for existing website variants.
  3. Polling frequency, or whether you need a push (then: endpoint, auth, payload, retries, duplicate handling).
  4. Status mapping, refund and restock ownership.
  5. Callback timeout and retry policy.
  6. Ownership of GST/HSN and of variant names and descriptions.
  7. Customer data and privacy requirements.

## 10. Verification status

- **Local test server** (throwaway database and key, image storage stubbed): every request in the collection passes, run with the Postman CLI from both the classic JSON files and the Local Mode YAML files (21 requests, 84 assertions). Luxy Galleria's automated tests cover all nine endpoints.
- **Not yet verified:** staging (not available yet); signed production requests; a real image stored in cloud storage; opening the Local Mode files in the Postman desktop app.

Contact: **NEEDS CONFIRMATION** — Luxy Galleria technical contact to be added before sending.
