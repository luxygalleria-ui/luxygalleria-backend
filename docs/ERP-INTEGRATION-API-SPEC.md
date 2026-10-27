# Luxy Galleria — ERP Integration API Specification

| | |
|---|---|
| Version | 2.1 |
| Date | 27 October 2026 (2.0: 23 October 2026) |
| Audience | ERP development team |
| API base URL | `https://api.luxygalleria.com/api/v1` |
| ERP API prefix | `/api/v1/erp` |
| Postman package | `postman/Luxy-Galleria-ERP-API.postman_collection.json`, `postman/Luxy-Galleria-ERP-Production.postman_environment.json` (Section 11) |
| Quick start | `docs/ERP-DEVELOPER-HANDOVER.md` |
| Source of truth | `luxy-backend`: `src/routes/erpRoutes.ts`, `src/controllers/erpController.ts`, `src/middlewares/erpAuth.ts` |

Every request field, rule and response in this document comes from the backend source code. Every response example was captured from that code running on a local test server with a throwaway database (23 October 2026), unless it is marked otherwise. Behaviour added in version 2.1 (Sections 4, 5, 6A, 6B and the order-line fields) is documented from source and the automated tests of 27 October 2026; responses shown for it are marked *shape from source and tests*. Items that cannot be confirmed from source or tests are marked **NEEDS CONFIRMATION**.

---

## Contents

1. Overview and current status
2. Authentication
3. Common conventions
4. Stock Update — `PUT /erp/stock/{sku}`
5. Item Add / Upsert — `POST /erp/items`
6. Item Edit — `PATCH /erp/items/{sku}`
6A. Item List — `GET /erp/items`
6B. Item Lookup — `GET /erp/items/{sku}`
7. Order Checking — `GET /erp/orders`
8. Order Details — `GET /erp/orders/{orderId}`
9. Order Status Callback — `POST /erp/webhooks/order-status`
10. Image Upload — `POST /erp/images`
11. Postman package
12. Website–ERP data mapping
13. Not implemented: website → ERP order push and customer sync
14. Information required from the ERP team
15. Test evidence
16. Known limitations and open items

---

## 1. Overview and current status

### 1.1 Integration directions

| Direction | Data | Endpoints | Status |
|---|---|---|---|
| ERP → Website | Products/variants, prices, stock, images, order fulfilment status | Sections 4, 5, 6, 9, 10 | Implemented |
| ERP reads Website | Orders and order details (including customer contact and shipping address) | Sections 7, 8 | Implemented |
| Website → ERP | Automatic new-order (sales order) push | — | **NOT IMPLEMENTED** (Section 13) |
| Customers | Customer master synchronization | — | **NOT IMPLEMENTED** (Section 13) |

The website is the system of record for orders. The ERP is intended to be the system of record for items, prices and stock (**NEEDS CONFIRMATION**, Section 14).

### 1.2 Endpoint status

Status labels: **VERIFIED** — a real request succeeded in that environment. **FAILED** — a real request returned an error. **NOT TESTED** — no real request evidence. **NOT IMPLEMENTED** — no code exists.

| # | Function | Method | Full URL | Local test server | Production |
|---|---|---|---|---|---|
| 1 | Stock Update | `PUT` | `https://api.luxygalleria.com/api/v1/erp/stock/{sku}` | VERIFIED | NOT TESTED |
| 2 | Item Add / Upsert | `POST` | `https://api.luxygalleria.com/api/v1/erp/items` | VERIFIED | FAILED (`401 Invalid ERP credentials`, earlier team test; see 2.6) |
| 3 | Item Edit | `PATCH` | `https://api.luxygalleria.com/api/v1/erp/items/{sku}` | VERIFIED | NOT TESTED |
| 4 | Order Checking | `GET` | `https://api.luxygalleria.com/api/v1/erp/orders` | VERIFIED | `200` reported by an earlier team test; not independently re-run |
| 5 | Order Details | `GET` | `https://api.luxygalleria.com/api/v1/erp/orders/{orderId}` | VERIFIED | `200` reported by an earlier team test; not independently re-run |
| 6 | Order Status Callback | `POST` | `https://api.luxygalleria.com/api/v1/erp/webhooks/order-status` | VERIFIED | NOT TESTED |
| 7 | Image Upload | `POST` | `https://api.luxygalleria.com/api/v1/erp/images` | Signing and validation VERIFIED; storing an image NOT TESTED (storage disabled on the test server) | NOT TESTED |
| 8 | Item List | `GET` | `https://api.luxygalleria.com/api/v1/erp/items` | VERIFIED | NOT TESTED |
| 9 | Item Lookup | `GET` | `https://api.luxygalleria.com/api/v1/erp/items/{sku}` | VERIFIED | NOT TESTED |

Routes 1–7 are deployed in production and enforce authentication: an unsigned request to each returns `401` (checked 22 and 23 October 2026). Routes 8–9 were not included in that check. The version 2.1 behaviour changes (27 October 2026) are verified locally only and are **not yet deployed**. Section 15 lists all evidence.

### 1.3 Environments

| Environment | Base URL | Notes |
|---|---|---|
| Production | `https://api.luxygalleria.com/api/v1` | Live store data. Write requests affect the storefront and customers. |
| Staging / sandbox | **NEEDS CONFIRMATION** | No separate staging service exists yet. Until one does, production writes must use an approved test SKU and test order (Section 11.5). |

Health check (no authentication): `GET https://api.luxygalleria.com/api/v1/health` → `200 {"success":true,"message":"Backend is running","timestamp":"…"}`.

---

## 2. Authentication

All nine endpoints use HMAC-SHA256 request signing with a key ID and a shared secret. No other credential is accepted: admin and customer logins or JWTs do not work on `/api/v1/erp/*`, and ERP keys work nowhere else.

### 2.1 Credentials

| Item | Description |
|---|---|
| Key ID | Public identifier, for example `erp-prod-1`. Matched exactly, case-sensitive. |
| Secret | 32+ characters (Luxy Galleria issues a 64-character hex value). Never sent over the wire, only used to compute signatures. |

Luxy Galleria issues the key ID and secret to the ERP team's named technical contact through a one-time secret link or password manager. The secret is never sent by email, chat or ticket, and the key ID is sent separately. Store the secret in your platform's secret manager. Rotate it immediately if exposure is suspected: the server accepts two keys at once, so rotation needs no downtime.

### 2.2 Required headers

| Header | Value |
|---|---|
| `X-ERP-Key-Id` | Your key ID |
| `X-ERP-Timestamp` | Current Unix time in **whole seconds** (for example `1792222200`). Must be within **±300 seconds** of server time. Milliseconds are rejected. |
| `X-ERP-Signature` | 64-character hex HMAC-SHA256 (Section 2.3). Compared case-insensitively; send lowercase. |
| `Content-Type` | `application/json` on JSON requests (a `charset=utf-8` parameter is fine). `multipart/form-data` with boundary on Image Upload. |

### 2.3 Signature algorithm

```
bodyHash     = lowercase hex( SHA-256( body bytes ) )
stringToSign = X-ERP-Timestamp + "." + METHOD + "." + pathWithQuery + "." + bodyHash
signature    = lowercase hex( HMAC-SHA256( key = secret as UTF-8 bytes, message = stringToSign as UTF-8 bytes ) )
```

| Part | Exact rule |
|---|---|
| `X-ERP-Timestamp` | The same string sent in the header |
| `METHOD` | Uppercase HTTP method: `GET`, `PUT`, `POST`, `PATCH` |
| `pathWithQuery` | The request path and query string exactly as sent, without scheme or host. It includes `/api/v1` and any percent-encoding, and keeps the query parameters in the order sent. Example: `/api/v1/erp/orders?page=1&limit=10`. |
| body bytes, JSON requests | The exact bytes of the request body as sent. The server hashes the raw bytes before parsing, so whitespace and key order matter, and pretty-printed JSON is fine if you sign the same text. Encode as UTF-8. |
| body bytes, `GET` | Empty. `bodyHash` = `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| body bytes, Image Upload | The raw bytes of the uploaded **file**, not the multipart envelope |

If a JSON request is sent without `Content-Type: application/json`, the server does not read its body. It then hashes an empty body, and the request fails with `401 Invalid X-ERP-Signature`.

**Test vector** (fake secret; check your implementation against it):

| Input | Value |
|---|---|
| secret | `test_secret_0123456789abcdef0123456789ab` |
| timestamp | `1792222200` |
| method / pathWithQuery | `PUT` / `/api/v1/erp/stock/YOUR_SKU` |
| body | `{"quantity":25,"asOf":"2026-10-17T09:30:00Z"}` |
| stringToSign | `1792222200.PUT./api/v1/erp/stock/YOUR_SKU.<sha256 hex of body>` |
| **signature** | `063c8145c1ab838827f3f78197594d0c1cee60e1d23f1be8e55b711d81d2c116` |

Reference implementations: the collection pre-request script (Section 11), `docs/erp-signing-client.mjs` (Node.js; `node docs/erp-signing-client.mjs --verify-vector` checks the vector offline), and this shell helper:

```bash
BASE=https://api.luxygalleria.com
KEY_ID=YOUR_ERP_KEY_ID
SECRET=YOUR_ERP_SECRET   # load from a secret store; never commit or paste into tickets

# usage: sign METHOD PATH_WITH_QUERY BODY_FILE_OR_EMPTY  -> sets TS and SIG
sign() {
  TS=$(date +%s)
  if [ -n "$3" ]; then BODY_HASH=$(openssl dgst -sha256 -hex < "$3" | sed 's/^.* //')
  else BODY_HASH=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; fi
  SIG=$(printf '%s' "$TS.$1.$2.$BODY_HASH" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')
}
```

### 2.4 Replay protection

- The server remembers every accepted signature for **10 minutes** and rejects a repeat with `401 Replayed request…`.
- Sign every attempt, including retries, with a fresh timestamp. A retry then has a new signature and is accepted. The idempotency rules in Sections 4–10 make repeated writes safe.
- The replay memory is held in the server process. It does not survive a server restart. The timestamp window still limits any replay to 5 minutes.

### 2.5 Check order and authentication errors

The server checks, in order:

1. ERP keys are configured.
2. The key ID is known.
3. The timestamp is within the window.
4. *Image Upload only:* the multipart upload is read and its size and format limits are applied.
5. The signature matches.
6. The signature is not a replay.

| HTTP | `message` | `errors[0].code` | Cause |
|---|---|---|---|
| 401 | `Invalid ERP credentials` | `UNAUTHENTICATED` | `X-ERP-Key-Id` missing or not a configured key ID |
| 401 | `X-ERP-Timestamp missing or more than 300s from server time` | `UNAUTHENTICATED` | Header missing, not an integer, in milliseconds, or clock skew > 300 s |
| 401 | `Invalid X-ERP-Signature` | `UNAUTHENTICATED` | Wrong secret, or method/path/query/body differs from what was signed, or wrong `Content-Type` |
| 401 | `Replayed request: sign every attempt with a fresh timestamp` | `UNAUTHENTICATED` | Identical signed request sent again |
| 503 | `ERP integration is not configured` | `UNAVAILABLE` | Server has no ERP keys (fails closed) |
| 429 | `Too many ERP requests, retry after the Retry-After interval` | `RATE_LIMITED` | More than 600 requests per minute from one IP address (Section 3.5) |

### 2.6 Troubleshooting `401 Invalid ERP credentials`

This response means the server did not receive a key ID it knows. A wrong body, path, method or secret never produces it; those give `Invalid X-ERP-Signature`. Check in this order:

1. **The request was not signed.** An unsigned request gets exactly this response. In Postman this happens when no environment is selected, `erpKeyId` or `erpSecret` is empty, or the pre-request script raised an error. Postman then still sends the request, without the `X-ERP-*` headers. The collection detects this: its test *request was signed by the collection pre-request script* fails, and the Postman Console shows the script error.
2. **A different key ID was sent** from the one that worked for other requests. The key check is identical for every endpoint and method. Compare the `X-ERP-Key-Id` actually sent (Postman Console → request headers).
3. **The server's key configuration changed**, for example after a key rotation. Ask Luxy Galleria to confirm that your key ID is configured.

---

## 3. Common conventions

### 3.1 Response envelope

Success:

```json
{ "success": true, "message": "…", "data": { } }
```

Error:

```json
{ "success": false, "message": "Validation failed", "errors": [{ "field": "quantity", "code": "VALIDATION_ERROR", "message": "Number must be greater than or equal to 0" }] }
```

`errors` is an array of `{ code, field?, message? }`. Some errors carry extra keys, such as `currentAsOf` on `STALE_UPDATE`. Order Checking adds a top-level `pagination` object next to `data`.

### 3.2 Error codes

| Code | HTTP | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Request does not meet the schema or a business rule |
| `UNAUTHENTICATED` | 401 | Authentication failed (Section 2.5) |
| `NOT_FOUND` | 404 | SKU or order does not exist |
| `DUPLICATE_SKU` | 409 | The SKU exists on more than one website variant; Luxy Galleria must fix the data |
| `CONFLICT` | 409 | Request conflicts with current data (SKUs of two products, `erpOrderId` mismatch, concurrent change). On Stock Update and the status callback it means *retry the same request*. |
| `UNMAPPED_PRODUCT` | 409 | Item Add would duplicate a website product whose variants have no SKU yet; Luxy Galleria must set the SKU on that product first (Section 5) |
| `STALE_UPDATE` | 409 | A newer stock figure was already applied |
| `INVALID_TRANSITION` | 409 | Order status change not allowed |
| `PAYLOAD_TOO_LARGE` | 413 | Image over 15 MB |
| `RATE_LIMITED` | 429 | Rate limit exceeded |
| `UPSTREAM_ERROR` | 502 | Image storage provider failed |
| `UNAVAILABLE` | 503 | ERP keys or image storage not configured on the server |

### 3.3 Errors raised before authentication

These come from the shared request parser or router, so they do not use ERP codes. Derived from source; not captured.

| Situation | Response |
|---|---|
| JSON body is not valid JSON | `400`, `success: false`, `message` = the parser's error text, no `errors` array |
| JSON body over 1 MB | `413`, `message: "request entity too large"`, no `errors` array |
| Unknown path under `/api/v1/erp/` | `404`, `message: "Route not found - <path>"`, `errors: null` |

### 3.4 Request rules

- JSON bodies: UTF-8, `Content-Type: application/json`, at most 1 MB.
- Stock and item requests use **strict** validation: an unknown field returns `400` (`Unrecognized key(s) in object: '…'`). The Order Status Callback ignores unknown fields.
- Text values are sanitised before storage: `<script>…</script>` blocks, `javascript:` and `on<word>=` patterns are removed.
- Keys that start with `$` or contain `.` are rewritten (NoSQL-injection protection).
- **SKU matching is exact** (case-sensitive) after trimming surrounding spaces. Percent-encode SKUs in URL paths when they contain characters other than letters, digits, `-`, `_`, `.` and `~`.
- Money values are INR as numbers, for example `499` or `499.5`.
- Dates are ISO 8601 with a timezone, such as `2026-10-17T09:30:00Z` or `2026-10-17T15:00:00+05:30`. Responses use UTC with milliseconds.

### 3.5 Rate limit

600 requests per minute per client IP address across all ERP endpoints. Responses carry the standard `RateLimit-*` headers; a `429` adds `Retry-After`. There is no bulk endpoint, so send one request per SKU (**NEEDS CONFIRMATION** whether volumes require a bulk endpoint).

### 3.6 Retries and idempotency

- **Retry** `429`, `502`, `503` and network timeouts with exponential backoff (for example 30 s, 2 min, 10 min, 1 h). Re-sign each attempt.
- **Do not retry** `400`, `401`, `404` or `409` until the request or data is fixed, **except** `409 CONFLICT` whose message ends in *retry it* (Stock Update: stock kept changing; Order Status Callback: order changed concurrently). Nothing was written; retry it unchanged with a fresh signature (same `eventId` for the callback).
- Every write is safe to repeat; see the *Idempotency* note on each endpoint. An `Idempotency-Key` header is not used.

---

## 4. Stock Update — `PUT /erp/stock/{sku}`

| | |
|---|---|
| Direction | ERP → Website |
| Full URL | `https://api.luxygalleria.com/api/v1/erp/stock/{sku}` |
| Purpose | Set the **absolute** sellable quantity of one product variant (not an adjustment) |
| Headers | Section 2.2, `Content-Type: application/json` |
| Postman | *3. Stock Update* |

**Path parameter**

| Name | Type | Rules |
|---|---|---|
| `sku` | string | Variant SKU, URL-encoded; must match exactly one website variant |

**Body** (strict)

| Field | Type | Required | Rules |
|---|---|---|---|
| `quantity` | integer | Yes | 0 – 1,000,000. Absolute sellable units. |
| `asOf` | string | Yes | ISO 8601 with timezone. The ERP time the figure was taken. At most 5 minutes in the future. |

**Behaviour**

- **Units the website has already committed are subtracted** (you cannot see either of these):
  - `pendingOrderQuantity`: units of this variant in website orders created after `asOf` and not cancelled;
  - `reservedQuantity`: units of this variant held right now by open website checkouts (customer is paying). An unpaid checkout holds its units for 30 minutes by default (server setting `CHECKOUT_SESSION_TTL_MINUTES`, minimum 5); they are released by the next expiry sweep, which runs every 5 minutes and before each new checkout.
  - stored stock = `max(0, quantity − pendingOrderQuantity − reservedQuantity)`
  - Because held units are subtracted, a checkout that is later abandoned returns its units on top of the stored figure, giving back your `quantity` less `pendingOrderQuantity`. Stock never rises above your figure because of an abandoned checkout.
  - **NEEDS CONFIRMATION** (Section 14, item 4): whether `quantity` is physical on-hand stock or sellable stock, and whether it already excludes website orders you have received. The formula above is provisional until you confirm.
- **The write is conditional.** It is applied only if the variant's stock has not changed between the server reading it and writing your figure (a checkout reserving or releasing units at that moment). The server retries this automatically up to 3 times; if stock keeps changing it returns `409 CONFLICT` and nothing is written. Retry the same body with a fresh signature.
- **Out-of-order updates are refused.**
  - The update applies only if `asOf` is newer than the last applied `asOf` for the variant.
  - The same `asOf` again returns `200` with `applied: false` and changes nothing.
  - An older `asOf` returns `409 STALE_UPDATE`.
- Only this variant's stock is written, atomically. The product's total stock is recomputed as the sum of its variants. Prices, images and other variants are untouched.
- Website checkout continues to decrement stock as it sells.
- This endpoint never creates a product or variant.

**Request**

```json
{ "quantity": 25, "asOf": "2026-10-23T04:27:41Z" }
```

**Success `200` — applied**

```json
{
  "success": true,
  "message": "Stock updated",
  "data": {
    "sku": "SKU-001",
    "productId": "6adae279d6f61832746849b1",
    "variantId": "6adae279d6f61832746849b2",
    "asOf": "2026-10-23T04:27:41.000Z",
    "previousQuantity": 10,
    "quantity": 25,
    "erpQuantity": 25,
    "pendingOrderQuantity": 0,
    "applied": true,
    "updatedAt": "2026-10-23T04:28:41.865Z"
  }
}
```

`quantity` is the stored stock; `erpQuantity` is the figure you sent. Since version 2.1 the applied response also contains `"reservedQuantity": <integer>` next to `pendingOrderQuantity` (*shape from source and tests*; not in the 23 October capture above). `previousQuantity` is the variant's stock immediately before your figure was written.

**Success `200` — same `asOf` delivered again**

```json
{
  "success": true,
  "message": "Stock already at this update",
  "data": {
    "sku": "SKU-001",
    "productId": "6adae279d6f61832746849b1",
    "variantId": "6adae279d6f61832746849b2",
    "asOf": "2026-10-23T04:27:41.000Z",
    "previousQuantity": 25,
    "quantity": 25,
    "applied": false,
    "updatedAt": "2026-10-23T04:28:41.870Z"
  }
}
```

**Errors**

| HTTP | When | Response |
|---|---|---|
| 400 | Fractional quantity | `{"success":false,"message":"Validation failed","errors":[{"field":"quantity","code":"VALIDATION_ERROR","message":"Expected integer, received float"}]}` |
| 400 | Negative quantity | `{"success":false,"message":"Validation failed","errors":[{"field":"quantity","code":"VALIDATION_ERROR","message":"Number must be greater than or equal to 0"}]}` |
| 400 | Missing `asOf` | `{"success":false,"message":"Validation failed","errors":[{"field":"asOf","code":"VALIDATION_ERROR","message":"Required"}]}` |
| 400 | `asOf` not ISO 8601 with timezone | `{"success":false,"message":"Validation failed","errors":[{"field":"asOf","code":"VALIDATION_ERROR","message":"must be an ISO 8601 timestamp, e.g. 2026-10-17T10:00:00Z"}]}` |
| 400 | `asOf` > 5 min in the future | `{"success":false,"message":"asOf is in the future","errors":[{"code":"VALIDATION_ERROR","field":"asOf"}]}` |
| 400 | Unknown field | `{"success":false,"message":"Validation failed","errors":[{"code":"VALIDATION_ERROR","message":"Unrecognized key(s) in object: 'warehouse'"}]}` |
| 404 | Unknown SKU | `{"success":false,"message":"SKU not found: NOPE","errors":[{"code":"NOT_FOUND","field":"sku"}]}` |
| 409 | Older `asOf` | `{"success":false,"message":"A newer stock update has already been applied","errors":[{"code":"STALE_UPDATE","field":"asOf","currentAsOf":"2026-10-23T04:27:41.000Z"}]}` |
| 409 | SKU on two variants | `{"success":false,"message":"SKU DUP-SKU is used by 2 website variants; fix the duplicate before syncing","errors":[{"code":"DUPLICATE_SKU","field":"sku"}]}` |
| 409 | Stock kept changing during the update (version 2.1; *shape from source*) | `{"success":false,"message":"Stock changed repeatedly while applying this update; retry it","errors":[{"code":"CONFLICT"}]}` |

**Idempotency:** repeating a request with the same `asOf` changes nothing. A request that got `409 CONFLICT` changed nothing and can be retried as is.

```bash
P=/api/v1/erp/stock/SKU-001
printf '%s' '{"quantity":25,"asOf":"2026-10-23T04:27:41Z"}' > body.json
sign PUT "$P" body.json
curl -sS -X PUT "$BASE$P" -H "Content-Type: application/json" \
  -H "X-ERP-Key-Id: $KEY_ID" -H "X-ERP-Timestamp: $TS" -H "X-ERP-Signature: $SIG" --data-binary @body.json
```

---

## 5. Item Add / Upsert — `POST /erp/items`

| | |
|---|---|
| Direction | ERP → Website |
| Full URL | `https://api.luxygalleria.com/api/v1/erp/items` |
| Purpose | Create a product with its variants, or update the product that already carries these SKUs |
| Headers | Section 2.2, `Content-Type: application/json` |
| Postman | *1. Item Add / Upsert* |

**Body** (strict)

| Field | Type | Required | Rules |
|---|---|---|---|
| `name` | string | On create | 1–200 characters |
| `description` | string | On create | 1–5000 characters |
| `category` | string | On create | Name (case-insensitive) or 24-hex id of an **existing** website category |
| `brand` | string | No | Name (case-insensitive) of an existing brand |
| `brandId` | string | No | 24-hex id of an existing brand; takes precedence over `brand` |
| `imageUrls` | string[] | No | Up to 10 `https://` URLs. **Replaces** the product's image list when sent; untouched when omitted. |
| `variants` | object[] | **Yes** | 1–50 entries; each `sku` at most once |
| `variants[].sku` | string | **Yes** | 1–64 characters; the matching key |
| `variants[].size` or `variants[].volume` | string | No | 1–50 characters, e.g. `"30ml"`. Both name the same value; `size` wins if both are sent. New variants default to `"Standard"`. |
| `variants[].flavor` | string | No | 1–50 characters; new variants default to `"Default"` |
| `variants[].offerPrice` | number | For new variants | Selling price, 0–10,000,000 |
| `variants[].actualPrice` | number | For new variants | MRP, 0–10,000,000; must be ≥ `offerPrice` |
| `variants[].stock` | integer | No | 0–1,000,000. **Applied only when the variant is created** (default 0). Existing variants change stock only through Stock Update. |
| `variants[].weight` | number | No | Kilograms, 0–1000. If omitted on create, it is parsed from the size (e.g. `"500g"` → 0.5, `"30ml"` → 0.03), otherwise 0. |
| `variants[].image` | string | No | `https://` URL |

**Matching rules**

| Situation | Result |
|---|---|
| No SKU in the request exists on the website | New product created → `201`, `action: "created"` |
| All existing SKUs belong to one product | That product is updated → `200`, `action: "updated"`. Only supplied fields change, variants not in the request are kept, and new SKUs are added as new variants. |
| SKUs belong to two different products | `409 CONFLICT` |
| A SKU exists on two website variants | `409 DUPLICATE_SKU` |
| No SKU exists yet, but a website product with the same `name` (case-insensitive) has variants without a SKU | `409 UNMAPPED_PRODUCT` with that `productId`; nothing is created (version 2.1). The website product was most likely created in the website admin before SKUs were assigned. Ask Luxy Galleria to set your SKU on its variant; your next request then updates it in place. |
| Unknown category or brand | `400`. Categories and brands are never auto-created (**NEEDS CONFIRMATION** whether they should be). |

**Request — create**

```json
{
  "name": "Rose Serum",
  "description": "Hydrating face serum",
  "category": "Skincare",
  "brand": "Lumina",
  "imageUrls": ["https://images.example.com/SKU-001/main.jpg"],
  "variants": [
    { "sku": "SKU-001", "size": "30ml", "offerPrice": 499, "actualPrice": 599, "stock": 10, "weight": 0.05 }
  ]
}
```

**Success `201` — created**

```json
{
  "success": true,
  "message": "Item created",
  "data": {
    "productId": "6adae279d6f61832746849b1",
    "action": "created",
    "variants": [
      { "sku": "SKU-001", "variantId": "6adae279d6f61832746849b2", "size": "30ml", "flavor": "Default", "offerPrice": 499, "actualPrice": 599, "stock": 10, "weight": 0.05, "image": null, "action": "created" }
    ]
  }
}
```

**Request — update an existing SKU and add a variant**

```json
{ "name": "Rose Serum", "variants": [ { "sku": "SKU-001", "offerPrice": 479 }, { "sku": "SKU-002", "size": "50ml", "offerPrice": 699, "actualPrice": 799 } ] }
```

**Success `200` — updated**

```json
{
  "success": true,
  "message": "Item updated",
  "data": {
    "productId": "6adae279d6f61832746849b1",
    "action": "updated",
    "variants": [
      { "sku": "SKU-001", "variantId": "6adae279d6f61832746849b2", "size": "30ml", "flavor": "Default", "offerPrice": 479, "actualPrice": 599, "stock": 10, "weight": 0.05, "image": null, "action": "updated" },
      { "sku": "SKU-002", "variantId": "6adae279d6f61832746849b8", "size": "50ml", "flavor": "Default", "offerPrice": 699, "actualPrice": 799, "stock": 0, "weight": 0.05, "image": null, "action": "created" }
    ]
  }
}
```

`data.variants` lists only the SKUs in the request. `SKU-002` was sent without `weight`, so its weight was parsed from `"50ml"` (0.05 kg).

**Errors**

| HTTP | When | Response |
|---|---|---|
| 400 | Empty body | `{"success":false,"message":"Validation failed","errors":[{"field":"variants","code":"VALIDATION_ERROR","message":"Required"}]}` |
| 400 | Create without `name`/`description`/`category` | `{"success":false,"message":"Validation failed","errors":[{"field":"name","code":"VALIDATION_ERROR","message":"required when creating an item"}, …]}` (one entry per missing field) |
| 400 | Unknown field | `{"success":false,"message":"Validation failed","errors":[{"code":"VALIDATION_ERROR","message":"Unrecognized key(s) in object: 'color'"}]}` |
| 400 | Non-https URL | `{"success":false,"message":"Validation failed","errors":[{"field":"imageUrls.0","code":"VALIDATION_ERROR","message":"must be an https URL"}]}` |
| 400 | New variant without prices | `{"success":false,"message":"offerPrice and actualPrice are required for a new variant","errors":[{"code":"VALIDATION_ERROR","field":"variants.0"}]}` |
| 400 | `offerPrice` > `actualPrice` | `{"success":false,"message":"offerPrice cannot be higher than actualPrice (MRP)","errors":[{"code":"VALIDATION_ERROR","field":"variants.0.offerPrice"}]}` |
| 400 | Unknown category | `{"success":false,"message":"Unknown category: Nope","errors":[{"code":"VALIDATION_ERROR","field":"category"}]}` |
| 400 | Unknown brand | `{"success":false,"message":"Unknown brand","errors":[{"code":"VALIDATION_ERROR","field":"brand"}]}` |
| 400 | Same SKU twice in one request | `{"success":false,"message":"Each SKU may appear only once per request","errors":[{"code":"VALIDATION_ERROR","field":"variants"}]}` |
| 409 | SKUs of two products | `{"success":false,"message":"These SKUs belong to different website products; send them separately","errors":[{"code":"CONFLICT","field":"variants"}]}` |
| 409 | SKU on two variants | `{"success":false,"message":"SKU DUP-SKU is used by 2 website variants; fix the duplicate before syncing","errors":[{"code":"DUPLICATE_SKU","field":"sku"}]}` |
| 409 | Same-named product without SKUs exists (version 2.1; *shape from source and tests*) | `{"success":false,"message":"Website product \"Rose Serum\" already exists with variants that have no SKU. Ask the website team to set the SKUs on it instead of creating a new item","errors":[{"code":"UNMAPPED_PRODUCT","field":"name","productId":"<24-hex id>"}]}` |

**Idempotency:** repeating the request updates the same product and never creates a duplicate. The name check only catches an exact (case-insensitive) name match; a renamed product is not detected, so map SKUs before syncing items (Section 14, item 4).

⚠️ **Production:** the website has no inactive or draft product flag, so a created product is immediately visible on the storefront.

```bash
P=/api/v1/erp/items
sign POST "$P" item.json
curl -sS -X POST "$BASE$P" -H "Content-Type: application/json" \
  -H "X-ERP-Key-Id: $KEY_ID" -H "X-ERP-Timestamp: $TS" -H "X-ERP-Signature: $SIG" --data-binary @item.json
```

---

## 6. Item Edit — `PATCH /erp/items/{sku}`

| | |
|---|---|
| Direction | ERP → Website |
| Full URL | `https://api.luxygalleria.com/api/v1/erp/items/{sku}` |
| Purpose | Change only the supplied fields of the variant `sku` and of its product |
| Headers | Section 2.2, `Content-Type: application/json` |
| Postman | *2. Item Edit* |

**Path parameter:** `sku` — as in Section 4.

**Body** (strict; at least one field; types and rules as in Section 5)

| Level | Fields |
|---|---|
| Product | `name`, `description`, `category`, `brand`, `brandId`, `imageUrls` (replaces the list) |
| Variant | `size` / `volume`, `flavor`, `offerPrice`, `actualPrice`, `weight`, `image` |

Not allowed: `stock` (use Stock Update), `sku` (changing a SKU is not supported; **NEEDS CONFIRMATION** whether SKUs can change in the ERP), `variants`.

**Guarantees:** omitted fields, other variants and stock are untouched. The variant id never changes. No product is created.

**Request**

```json
{ "offerPrice": 449, "name": "Rose Serum - New Pack" }
```

**Success `200`**

```json
{
  "success": true,
  "message": "Item updated",
  "data": {
    "productId": "6adae279d6f61832746849b1",
    "name": "Rose Serum - New Pack",
    "category": "Skincare",
    "images": ["https://images.example.com/SKU-001/main.jpg"],
    "updatedFields": ["offerPrice", "name"],
    "variant": { "sku": "SKU-001", "variantId": "6adae279d6f61832746849b2", "size": "30ml", "flavor": "Default", "offerPrice": 449, "actualPrice": 599, "stock": 10, "weight": 0.05, "image": null }
  }
}
```

`updatedFields` lists the fields you sent, in the order you sent them.

**Errors**

| HTTP | When | Response |
|---|---|---|
| 400 | Empty body | `{"success":false,"message":"Validation failed","errors":[{"code":"VALIDATION_ERROR","message":"send at least one field to change"}]}` |
| 400 | `stock` or another disallowed field | `{"success":false,"message":"Validation failed","errors":[{"code":"VALIDATION_ERROR","message":"Unrecognized key(s) in object: 'stock'"}, …]}` |
| 400 | Price above MRP | `{"success":false,"message":"offerPrice cannot be higher than actualPrice (MRP)","errors":[{"code":"VALIDATION_ERROR","field":"offerPrice"}]}` |
| 400 | Unknown category/brand | As in Section 5 |
| 404 | Unknown SKU | `{"success":false,"message":"SKU not found: NOPE","errors":[{"code":"NOT_FOUND","field":"sku"}]}` |
| 409 | SKU on two variants | `DUPLICATE_SKU`, as in Section 4 |

**Idempotency:** the same body always gives the same result.

```bash
P=/api/v1/erp/items/SKU-001
printf '%s' '{"offerPrice":449}' > patch.json
sign PATCH "$P" patch.json
curl -sS -X PATCH "$BASE$P" -H "Content-Type: application/json" \
  -H "X-ERP-Key-Id: $KEY_ID" -H "X-ERP-Timestamp: $TS" -H "X-ERP-Signature: $SIG" --data-binary @patch.json
```

---

## 6A. Item List — `GET /erp/items`

| | |
|---|---|
| Direction | ERP reads Website |
| Full URL | `https://api.luxygalleria.com/api/v1/erp/items` |
| Purpose | List website products with all their variants, including variants that have no SKU yet (for SKU mapping and reconciliation) |
| Headers | Section 2.2 (no body; sign an empty body) |
| Postman | *8. Item List* |

**Query parameters** (strict; unknown parameters → `400`)

| Name | Type | Default | Rules |
|---|---|---|---|
| `page` | integer | 1 | ≥ 1 |
| `limit` | integer | 50 | 1–100 |
| `search` | string | — | At most 100 characters. Case-insensitive *contains* match on product name or variant SKU. |

Sorted by product `updatedAt`, newest first, then product id. `pagination` is inside `data` here (unlike Order Checking, where it is top-level).

**Success `200`** (*shape from source and tests*)

```json
{
  "success": true,
  "message": "Items fetched",
  "data": {
    "items": [
      {
        "productId": "<24-hex id>",
        "name": "Rose Serum",
        "description": "Hydrating face serum",
        "category": "Skincare",
        "images": ["https://…"],
        "status": "In Stock",
        "updatedAt": "2026-10-27T05:00:00.000Z",
        "variants": [
          { "variantId": "<24-hex id>", "sku": "SKU-001", "name": null, "size": "30ml", "flavor": "Default", "offerPrice": 499, "actualPrice": 599, "stock": 10, "weight": 0.05, "image": null }
        ]
      }
    ],
    "pagination": { "page": 1, "limit": 50, "total": 1, "pages": 1 }
  }
}
```

- `variants[].sku` is `null` for a variant that has no SKU yet. Such a variant cannot be used with the SKU endpoints until Luxy Galleria sets its SKU; use `variantId` to identify it when agreeing the SKU mapping.
- `status` is a free-text display label set in the website admin; it is not derived from stock.

**Errors:** `400 VALIDATION_ERROR` for a bad `page`/`limit`, a `search` over 100 characters or an unknown parameter (same shape as Section 7).

Read-only.

---

## 6B. Item Lookup — `GET /erp/items/{sku}`

| | |
|---|---|
| Direction | ERP reads Website |
| Full URL | `https://api.luxygalleria.com/api/v1/erp/items/{sku}` |
| Purpose | Read the one variant carrying this SKU, with its product |
| Headers | Section 2.2 (no body) |
| Postman | *9. Item Lookup* |

**Path parameter:** `sku` — as in Section 4.

**Success `200`** (*shape from source and tests*)

```json
{
  "success": true,
  "message": "Item fetched",
  "data": {
    "productId": "<24-hex id>",
    "name": "Rose Serum",
    "description": "Hydrating face serum",
    "category": "Skincare",
    "images": ["https://…"],
    "variant": { "sku": "SKU-001", "variantId": "<24-hex id>", "size": "30ml", "flavor": "Default", "offerPrice": 499, "actualPrice": 599, "stock": 10, "weight": 0.05, "image": null }
  }
}
```

**Errors:** `404 NOT_FOUND` (unknown SKU) and `409 DUPLICATE_SKU` (SKU on two variants), exactly as in Section 4.

Read-only.

---

## 7. Order Checking — `GET /erp/orders`

| | |
|---|---|
| Direction | ERP reads Website |
| Full URL | `https://api.luxygalleria.com/api/v1/erp/orders` |
| Purpose | List orders page by page, oldest change first, for incremental sync |
| Headers | Section 2.2 (no body; sign an empty body) |
| Postman | *4. Order Checking (list)* |

**Query parameters** (unknown parameters → `400`)

| Name | Type | Default | Rules |
|---|---|---|---|
| `page` | integer | 1 | ≥ 1 |
| `limit` | integer | 50 | 1–100 |
| `status` | string | — | `processing` \| `shipped` \| `delivered` \| `cancelled` |
| `paymentStatus` | string | — | `pending` \| `completed` \| `failed` \| `refunded` |
| `updatedSince` | string | — | ISO 8601 with timezone; returns orders with `updatedAt >= updatedSince` |

**Sync rules**

- Sorted by `updatedAt`, then `orderId`, ascending (stable paging).
- Keep the newest `updatedAt` received and pass it as `updatedSince` next time. The boundary order is returned again, so de-duplicate by `orderId`.
- The website saves an order only after the customer's payment is verified. Orders therefore normally have `paymentStatus: "completed"`.

**Success `200`** (`?page=1&limit=2`)

```json
{
  "success": true,
  "message": "Orders fetched",
  "data": [
    {
      "orderId": "6adae2739dd483d873e04a65",
      "createdAt": "2026-10-23T04:28:35.725Z",
      "updatedAt": "2026-10-23T04:28:35.725Z",
      "orderStatus": "processing",
      "paymentStatus": "completed",
      "currency": "INR",
      "subtotal": 998,
      "discount": 0,
      "shippingFee": 40,
      "total": 1038,
      "customer": { "customerId": "6adae2739dd483d873e04a62", "name": "Customer Name", "email": "customer@example.com" },
      "items": [
        { "productId": "6adae2739dd483d873e04a63", "variantId": "6adae2739dd483d873e04a64", "sku": null, "name": null, "size": "30ml", "quantity": 2, "unitPrice": 499, "lineTotal": 998 }
      ],
      "erp": { "erpOrderId": null, "trackingNumber": null }
    }
  ],
  "pagination": { "page": 1, "limit": 2, "total": 2, "pages": 1 }
}
```

(One of the two returned orders shown. This 23 October capture predates some fields: current responses also contain `fulfillment`, `charges` and, per item, `taxRate` and `taxAmount`; see Section 12.4.)

**Field notes**

- `items[].sku` and `items[].name` (version 2.1): for orders placed after the 2.1 release, these are the variant SKU and product name **at the time of purchase**, stored on the order, so later catalogue edits do not change them. For older orders they are looked up from the product when you call, and are `null` when the product or variant has been deleted or has no SKU (as in this captured example).
- `items[].variantId` is always the variant that was sold. Since version 2.1 checkout refuses a variant id that no longer exists instead of substituting another variant.
- `currency` is always `INR`.
- `discount` is currently always `0`.
- `erp.*` is filled by the Order Status Callback.

**Errors**

| HTTP | When | Response |
|---|---|---|
| 400 | `limit=500` | `{"success":false,"message":"Validation failed","errors":[{"field":"limit","code":"VALIDATION_ERROR","message":"Number must be less than or equal to 100"}]}` |
| 400 | `status=lost` | `{"success":false,"message":"Validation failed","errors":[{"field":"status","code":"VALIDATION_ERROR","message":"Invalid enum value. Expected 'processing' \| 'shipped' \| 'delivered' \| 'cancelled', received 'lost'"}]}` |
| 400 | `updatedSince=yesterday` | `{"success":false,"message":"Validation failed","errors":[{"field":"updatedSince","code":"VALIDATION_ERROR","message":"must be an ISO 8601 timestamp, e.g. 2026-10-17T10:00:00Z"}]}` |
| 400 | Unknown parameter | `{"success":false,"message":"Validation failed","errors":[{"code":"VALIDATION_ERROR","message":"Unrecognized key(s) in object: 'foo'"}]}` |

Read-only.

```bash
P='/api/v1/erp/orders?updatedSince=2026-10-17T00:00:00Z&limit=50'
sign GET "$P" ""
curl -sS "$BASE$P" -H "X-ERP-Key-Id: $KEY_ID" -H "X-ERP-Timestamp: $TS" -H "X-ERP-Signature: $SIG"
```

---

## 8. Order Details — `GET /erp/orders/{orderId}`

| | |
|---|---|
| Direction | ERP reads Website |
| Full URL | `https://api.luxygalleria.com/api/v1/erp/orders/{orderId}` |
| Purpose | One order by its website order id, with shipping and payment details |
| Headers | Section 2.2 (no body) |
| Postman | *5. Order Details* |

**Path parameter:** `orderId` — 24 hexadecimal characters (from Order Checking).

**Success `200`** — all fields of Section 7, plus `customer.phone`, `shippingAddress`, `payment` and `statusUpdatedAt`:

```json
{
  "success": true,
  "message": "Order fetched",
  "data": {
    "orderId": "6adae2739dd483d873e04a65",
    "createdAt": "2026-10-23T04:28:35.725Z",
    "updatedAt": "2026-10-23T04:28:35.725Z",
    "orderStatus": "processing",
    "paymentStatus": "completed",
    "currency": "INR",
    "subtotal": 998,
    "discount": 0,
    "shippingFee": 40,
    "total": 1038,
    "customer": { "customerId": "6adae2739dd483d873e04a62", "name": "Customer Name", "email": "customer@example.com", "phone": "9999999999" },
    "items": [
      { "productId": "6adae2739dd483d873e04a63", "variantId": "6adae2739dd483d873e04a64", "sku": null, "name": null, "size": "30ml", "quantity": 2, "unitPrice": 499, "lineTotal": 998 }
    ],
    "erp": { "erpOrderId": null, "trackingNumber": null },
    "shippingAddress": { "street": "Street", "city": "City", "state": "State", "zipCode": "000000", "country": "India" },
    "payment": { "method": "razorpay", "status": "completed", "gatewayOrderId": "order_TEST…", "gatewayPaymentId": "pay_TEST" },
    "statusUpdatedAt": null
  }
}
```

`statusUpdatedAt` is when the status last changed: the `occurredAt` of the last Order Status Callback that was applied or unchanged, or the time a Luxy Galleria admin changed or a superadmin corrected the status; `null` before any. A superadmin correction can set a status the forward-only rule refuses (for example back from `delivered` to `shipped` after a mistake); later callbacks then follow the normal rules from the corrected status. Admin status changes follow the same transition rules as the callback (Section 9), so a callback whose `occurredAt` is older than an admin change is recorded as `stale`.

**Not returned, because the website does not store it:**
- HSN codes on order lines (GST amounts are returned in `charges.tax` and `items[].taxRate` / `items[].taxAmount` when GST was enabled for the order; Section 12.4)
- billing address
- recipient name and phone (separate from the customer account)
- apartment and landmark
- customer GSTIN
- a human-readable order number

**NEEDS CONFIRMATION:** which of these your sales order requires. The payment signature and any passwords or tokens are never returned.

**Errors**

| HTTP | When | Response |
|---|---|---|
| 400 | Malformed id | `{"success":false,"message":"orderId must be a 24-character hex id","errors":[{"code":"VALIDATION_ERROR","field":"orderId"}]}` |
| 404 | Unknown id | `{"success":false,"message":"Order not found","errors":[{"code":"NOT_FOUND","field":"orderId"}]}` |

Read-only.

```bash
P=/api/v1/erp/orders/6adae2739dd483d873e04a65
sign GET "$P" ""
curl -sS "$BASE$P" -H "X-ERP-Key-Id: $KEY_ID" -H "X-ERP-Timestamp: $TS" -H "X-ERP-Signature: $SIG"
```

---

## 9. Order Status Callback — `POST /erp/webhooks/order-status`

| | |
|---|---|
| Direction | ERP → Website |
| Full URL | `https://api.luxygalleria.com/api/v1/erp/webhooks/order-status` |
| Purpose | The ERP reports that an order's fulfilment status changed |
| Headers | Section 2.2, `Content-Type: application/json` |
| Postman | *7. Order Status Callback* |

**Body** (unknown fields are ignored)

| Field | Type | Required | Rules |
|---|---|---|---|
| `eventId` | string | Yes | 1–100 characters, unique per event. Redelivery of the same id is acknowledged without effect. |
| `orderId` | string | Yes | Website order id (24 hex) |
| `status` | string | Yes | `processing` \| `shipped` \| `delivered` \| `cancelled` |
| `occurredAt` | string | Yes | ISO 8601 with timezone; when the change happened in the ERP |
| `erpOrderId` | string | No | 1–100 characters. Stored the first time; a different value later → `409`. |
| `trackingNumber` | string | No | 1–100 characters. Stored with an applied or unchanged status. |

**Allowed transitions** (**NEEDS CONFIRMATION**: your status list and how it maps to these four)

| From | To |
|---|---|
| `processing` | `shipped`, `delivered`, `cancelled` |
| `shipped` | `delivered`, `cancelled` |
| `delivered`, `cancelled` | None (final) |

**Processing order and outcomes**

| Step | Situation | Response |
|---|---|---|
| 1 | Body invalid | `400` |
| 2 | `eventId` already processed | `200`, `duplicate: true`, the original `outcome`; no side effects |
| 3 | Order not found | `404` |
| 4 | `erpOrderId` differs from the one already stored | `409 CONFLICT` |
| 5 | `occurredAt` not newer than the last applied event | `200`, `outcome: "stale"`; status, tracking and `statusUpdatedAt` unchanged (a new `erpOrderId` is still stored) |
| 6 | Same status as now | `200`, `outcome: "unchanged"`; tracking number and `statusUpdatedAt` updated; no email |
| 7 | Allowed transition | `200`, `outcome: "applied"`; status, tracking and `statusUpdatedAt` updated; **the customer is emailed once** |
| 7 | Transition not allowed | `409 INVALID_TRANSITION`; nothing recorded, so a corrected event can be sent with the same `eventId` |
| — | Order changed concurrently | `409 CONFLICT`, `Order changed while processing this event; retry it` |

`stale`, `unchanged` and `applied` events are recorded by `eventId`.

**What this endpoint does not do:**
- **Refunds:** cancelling does not refund the payment; refunds remain a manual Razorpay action.
- **Stock:** cancelling does not restore stock; send the corrected figure through Stock Update.
- **NEEDS CONFIRMATION:** who owns refunds and restocking. The cancellation email uses the website's existing text, which tells the customer a refund will be initiated if they were charged.

**Request**

```json
{
  "eventId": "EVT-1",
  "orderId": "6adae2739dd483d873e04a65",
  "erpOrderId": "SO-1001",
  "status": "shipped",
  "trackingNumber": "TRACK-001",
  "occurredAt": "2026-10-23T04:18:41Z"
}
```

**Success `200` — applied**

```json
{
  "success": true,
  "message": "Status updated",
  "data": { "eventId": "EVT-1", "orderId": "6adae2739dd483d873e04a65", "previousStatus": "processing", "orderStatus": "shipped", "applied": true, "outcome": "applied", "duplicate": false }
}
```

**Success `200` — duplicate `eventId`**

```json
{ "success": true, "message": "Event already processed", "data": { "eventId": "EVT-1", "duplicate": true, "outcome": "applied" } }
```

**Success `200` — unchanged or stale**

```json
{
  "success": true,
  "message": "Event recorded; status not changed",
  "data": { "eventId": "EVT-3", "orderId": "6adae2739dd483d873e04a65", "previousStatus": "shipped", "orderStatus": "shipped", "applied": false, "outcome": "stale", "duplicate": false }
}
```

**Errors**

| HTTP | When | Response |
|---|---|---|
| 400 | Missing fields | `{"success":false,"message":"Validation failed","errors":[{"field":"eventId","code":"VALIDATION_ERROR","message":"Required"},{"field":"status",…},{"field":"occurredAt",…}]}` |
| 400 | Bad status | `{"success":false,"message":"Validation failed","errors":[{"field":"status","code":"VALIDATION_ERROR","message":"Invalid enum value. Expected 'processing' \| 'shipped' \| 'delivered' \| 'cancelled', received 'lost'"}]}` |
| 404 | Unknown order | `{"success":false,"message":"Order not found","errors":[{"code":"NOT_FOUND","field":"orderId"}]}` |
| 409 | Backward | `{"success":false,"message":"Order cannot move from shipped to processing","errors":[{"code":"INVALID_TRANSITION","field":"status"}]}` |
| 409 | From a final state | `{"success":false,"message":"Order cannot move from cancelled to shipped","errors":[{"code":"INVALID_TRANSITION","field":"status"}]}` |
| 409 | `erpOrderId` mismatch | `{"success":false,"message":"erpOrderId does not match the ERP order already linked to this order","errors":[{"code":"CONFLICT","field":"erpOrderId"}]}` |

**Delivery and retry:**
- Treat any non-`2xx` response or a timeout as failed.
- Retry with backoff using the **same `eventId`**, re-signing each attempt.
- Timeout value: **NEEDS CONFIRMATION**. A typical response takes well under one second.

⚠️ **Production:** an applied change is visible to the customer and sends them an email.

```bash
P=/api/v1/erp/webhooks/order-status
sign POST "$P" event.json
curl -sS -X POST "$BASE$P" -H "Content-Type: application/json" \
  -H "X-ERP-Key-Id: $KEY_ID" -H "X-ERP-Timestamp: $TS" -H "X-ERP-Signature: $SIG" --data-binary @event.json
```

---

## 10. Image Upload — `POST /erp/images`

| | |
|---|---|
| Direction | ERP → Website |
| Full URL | `https://api.luxygalleria.com/api/v1/erp/images` |
| Purpose | Upload one product image and receive a hosted `https://` URL to use in `imageUrls` or `variants[].image` (Sections 5–6) |
| Headers | Section 2.2; `Content-Type: multipart/form-data; boundary=…` (set by your HTTP client) |
| Postman | *6. Image Upload* |

If your images already have public `https://` URLs, you can send those directly in the item endpoints and skip this one.

**Multipart body**

| Item | Rule |
|---|---|
| Field name | `image`: exactly one file, and no other fields |
| Formats | JPG/JPEG, PNG, WEBP. The file extension, the part's content type (`image/jpeg`, `image/png`, `image/webp`) **and** the actual file bytes must all agree. |
| Maximum size | 15 MB |
| Signed body | SHA-256 of the **file bytes** only (Section 2.3) |
| Storage | The website's Cloudinary account, folder `luxygalleria_products` |

**Success `201`** (shape from source and the automated test with storage stubbed; a real stored-image response has not been captured)

```json
{ "success": true, "message": "Image uploaded", "data": { "url": "https://res.cloudinary.com/…", "bytes": 48213, "contentType": "image/png" } }
```

`url` is the Cloudinary `secure_url` (**NEEDS CONFIRMATION**: exact URL format, until a real upload is verified).

**Errors**

Multipart errors (`400` and `413`) are returned **before** the signature is checked. A request with an invalid signature is never stored.

| HTTP | When | Response |
|---|---|---|
| 400 | No file | `{"success":false,"message":"Send the image as multipart/form-data in the field \"image\"","errors":[{"code":"VALIDATION_ERROR","field":"image"}]}` |
| 400 | Wrong field name, extra field or file | `{"success":false,"message":"Send exactly one file in the multipart field \"image\" (Unexpected file field)","errors":[{"code":"VALIDATION_ERROR","field":"image"}]}` (text in brackets varies) |
| 400 | Not an image, or bytes do not match extension/content type | `{"success":false,"message":"Only JPG, PNG or WEBP images are allowed, with matching file extension and content type","errors":[{"code":"VALIDATION_ERROR","field":"image"}]}` |
| 401 | Signature not over these file bytes | `{"success":false,"message":"Invalid X-ERP-Signature","errors":[{"code":"UNAUTHENTICATED"}]}` |
| 413 | Over 15 MB | `{"success":false,"message":"Image is larger than 15 MB","errors":[{"code":"PAYLOAD_TOO_LARGE","field":"image"}]}` |
| 502 | Storage provider failed (from source) | `{"success":false,"message":"Image storage failed; retry later","errors":[{"code":"UPSTREAM_ERROR"}]}` |
| 503 | Storage not configured | `{"success":false,"message":"Image storage is not configured","errors":[{"code":"UNAVAILABLE"}]}` |

**Idempotency:** each successful call stores a new image. Retrying after a timeout may leave an unused copy, which is harmless.

```bash
P=/api/v1/erp/images
sign POST "$P" ./rose.png          # hashes the file bytes
curl -sS -X POST "$BASE$P" -H "X-ERP-Key-Id: $KEY_ID" -H "X-ERP-Timestamp: $TS" -H "X-ERP-Signature: $SIG" \
  -F "image=@./rose.png;type=image/png"
```

---

## 11. Postman package

### 11.1 Files

| File | Contents |
|---|---|
| `postman/Luxy-Galleria-ERP-API.postman_collection.json` | Postman Collection v2.1 with the nine requests in a runnable order, a *Negative checks* folder, automatic signing, and test assertions |
| `postman/Luxy-Galleria-ERP-Production.postman_environment.json` | Environment template for production. Credentials and IDs are blank. |
| `postman/Luxy-Galleria-ERP-Local-Staging.postman_environment.json` | Same variables for a local or staging backend (`baseUrl` defaults to `http://localhost:5000/api/v1`). Credentials and IDs are blank. Use it for all test writes. |

| Postman request | Function | Section |
|---|---|---|
| 1. Item Add / Upsert | Item Add / Upsert | 5 |
| 2. Item Edit | Item Edit | 6 |
| 3. Stock Update | Stock Update | 4 |
| 4. Order Checking (list) | Order Checking | 7 |
| 5. Order Details | Order Details | 8 |
| 6. Image Upload | Image Upload | 10 |
| 7. Order Status Callback | Order Status Callback | 9 |
| 8. Item List | Item List | 6A |
| 9. Item Lookup | Item Lookup | 6B |
| Negative checks (folder) | Expected refusals: unknown SKU (`404`), bad query (`400`), invalid stock body (`400`), wrong signature, expired timestamp and unknown key (`401`) | 2.5, 4, 6B, 7 |

The run order puts Item Add first, because Item Edit and Stock Update need its SKU to exist. The *Negative checks* are safe to run anywhere: they are read-only or refused before any data is read or written.

### 11.2 Setup and secrets

1. Postman → **Import** → select both files.
2. Select the environment **Luxy Galleria ERP - Production** (environment selector, top right).
3. Enter `erpKeyId` and `erpSecret` in the **Current value** column only. Postman keeps Current values local by default; Initial values are shared with anyone who can see the environment in a workspace. `erpSecret` is a *secret*-type variable and is masked on screen. Postman Vault is an alternative if your organisation uses it. Never export the environment with the secret filled in, and never paste it into a request, a script or a shared collection.
4. Make sure the computer clock is correct (within 5 minutes).

**Non-production key (local or staging).** Never use a production key outside production.
1. Generate a secret on the backend host without printing it, e.g. `openssl rand -hex 32` written straight into the secret store or `.env` of that local/staging backend.
2. Add it there as `ERP_API_KEYS=<keyId>:<secret>` with a non-production key ID (for example `erp-staging-1`) and restart that backend. `npm run diagnose:erp-keys` prints only `{ valid, keyIds }`.
3. In Postman select **Luxy Galleria ERP - Local / Staging**, set `baseUrl` to that backend, and enter the key ID and secret as **Current values** only.
4. Do not reuse the staging key in production, and never add a production key to a local or staging `.env`.

### 11.3 Variables

| Variable | Default | Used by |
|---|---|---|
| `baseUrl` | `https://api.luxygalleria.com/api/v1` | All requests (no trailing slash) |
| `erpKeyId`, `erpSecret` | blank | Signing |
| `itemSku` | `ERP-TEST-SKU-001` | Item Add, Item Edit, Stock Update |
| `categoryName` | `Chocolates` | Item Add; must be an existing website category |
| `stockQuantity` | `10` | Stock Update |
| `orderId` | blank | Order Details, Order Status Callback. Copy it from Order Checking; the collection never fills it automatically. |
| `orderStatus` | `shipped` | Order Status Callback |
| `trackingNumber` | `TEST-TRACK-001` | Order Status Callback |
| `eventId` | blank | Order Status Callback. Blank = a new id per send. Set a fixed value to test redelivery. |
| `imageSha256` | blank | Image Upload (Section 11.4) |

The collection-level pre-request script signs every request as in Section 2.3. It sets `{{nowIso}}`, and `{{eventId}}` when that is blank, **before** hashing, so the signed bytes equal the sent bytes. Do not put Postman dynamic variables such as `{{$guid}}` or `{{$timestamp}}` in a request body: Postman resolves them again at send time, and the signature no longer matches.

### 11.4 Image Upload in Postman

1. Open *6. Image Upload* → **Body** → `form-data`, key `image` (type **File**) → **Select Files** → choose a JPG, PNG or WEBP file of 15 MB or less. Add no other fields.
2. Compute the file's SHA-256 and paste the 64-character hex value into `imageSha256`:
   - macOS / Linux: `shasum -a 256 /path/to/image.png`
   - Windows: `certutil -hashfile C:\path\to\image.png SHA256`
3. Send.

Postman scripts cannot read the selected file, so the file hash is supplied this way. If `imageSha256` does not match the selected file, the response is `401 Invalid X-ERP-Signature`. Update it whenever you select a different file.

This procedure was verified on the local test server: the correct hash passed the signature check, and a wrong hash returned `401`. Storing an image has **not** been verified, because storage was disabled on the test server.

### 11.5 Tests and safe use

Each request runs these tests:

- the request was signed;
- the response uses the standard envelope;
- the HTTP status is the documented success status (for *Negative checks*: the documented refusal status);
- `data` matches the documented JSON schema (for *Negative checks*: the documented `errors[0].code`; *9. Item Lookup* also checks the returned SKU).

A failing status test writes the server's `message` to the Postman Console.

| Request | Effect in production |
|---|---|
| 4, 5, 8, 9, Negative checks | Read-only, or refused before any change |
| 1 | Creates a product **visible on the storefront** (no draft flag) |
| 2, 3 | Change that SKU's price and stock |
| 6 | Stores an image in the website's Cloudinary account |
| 7 | Changes a real order's status and **emails the customer** |

Run requests 1–3, 6 and 7 in production only with a test SKU and test order that Luxy Galleria has approved for the purpose.

Command line (optional):

```bash
npx newman run Luxy-Galleria-ERP-API.postman_collection.json -e Luxy-Galleria-ERP-Production.postman_environment.json \
  --env-var erpKeyId=… --env-var erpSecret=… --folder "4. Order Checking (list)"
```

Newman cannot open a file picker. For Image Upload, set the form-data `src` to a file path in a local copy of the collection.

---

## 12. Website–ERP data mapping

### 12.1 Items (ERP → Website)

| ERP field | Website field | Notes |
|---|---|---|
| `variants[].sku` | `Product.variants[].sku` | Matching key; exact, case-sensitive. Must be unique across the site; duplicates return `409`. Since version 2.1 the website admin refuses a SKU already used by another variant, and can set a SKU only on a variant that has none: an existing SKU cannot be changed or cleared from the website. |
| `name`, `description` | `Product.name`, `Product.description` | |
| `category` | `Product.category` (name) + `Product.categoryId` | Must already exist |
| `brand` / `brandId` | `Product.brandId` | Must already exist |
| `imageUrls[]` | `Product.images[]` | Replaces the list |
| `variants[].size` / `volume` | `variants[].size` and `variants[].volume` | Both set to the same value |
| `variants[].flavor` | `variants[].flavor` | |
| `variants[].offerPrice` | `variants[].offerPrice` and `variants[].price` | Selling price, INR |
| `variants[].actualPrice` | `variants[].actualPrice` and `variants[].oldPrice` | MRP, INR |
| `variants[].weight` | `variants[].weight` | kg (used for shipping) |
| `variants[].image` | `variants[].image` | |
| — | `variants[]._id` | Returned as `variantId`; stable |
| — | `Product._id` | Returned as `productId`; stable |

### 12.2 Stock (ERP → Website)

| ERP field | Website field |
|---|---|
| `quantity` | `variants[].stock` = `max(0, quantity − pendingOrderQuantity − reservedQuantity)` (provisional, Section 4) |
| `asOf` | `variants[].stockAsOf` |
| — | `Product.stock` = sum of variant stock |

### 12.3 Images (ERP → Website)

`POST /erp/images` → Cloudinary folder `luxygalleria_products` → returned `data.url` → send it in `imageUrls` or `variants[].image`.

### 12.4 Orders (ERP reads Website)

| API field | Website source |
|---|---|
| `orderId` | `Order._id`. Use it as the external reference on the ERP sales order. |
| `orderStatus`, `paymentStatus` | `Order.orderStatus`, `Order.paymentStatus` |
| `subtotal`, `discount`, `shippingFee`, `total` | Same-named `Order` fields (INR) |
| `currency` | Constant `INR` |
| `items[].productId`, `variantId`, `quantity`, `unitPrice`, `lineTotal`, `size` | `Order.items[]`: `product`, `variantId`, `quantity`, `price`, `subtotal`, `size` |
| `items[].sku`, `items[].name` | `Order.items[].sku` / `.name` stored at purchase (orders from version 2.1 on); otherwise current product data, looked up when called |
| `shippingAddress.*` | `Order.shippingAddress` (street, city, state, zipCode, country). `null` for store-pickup orders. |
| `fulfillment.method` | `Order.fulfillmentMethod`: `delivery` or `pickup`. Orders placed before this field existed report `delivery`. |
| `fulfillment.shippingMethod`, `fulfillment.zone` | `Order.shippingMethod` (`land`/`air`), `Order.shippingZone` (`kerala`/`outsideKerala`); `null` for pickup and for older orders |
| `fulfillment.pickup` | `Order.pickupDetails` store name and address (pickup orders only, else `null`) |
| `charges.pickupFee`, `charges.specialPackagingFee` | Same-named `Order` fields (INR); `0` when not charged. Already included in `total`. |
| `charges.tax` | `Order.tax` (`pricesIncludeTax`, `taxableValue`, `taxAmount`) when GST display was enabled for the order, else `null` |
| `items[].taxRate`, `items[].taxAmount` | `Order.items[]` GST rate (%) and amount; `null` when not recorded |
| `payment.method`, `status`, `gatewayOrderId`, `gatewayPaymentId` | `paymentMethod`, `paymentStatus`, `razorpayOrderId`, `razorpayPaymentId` |
| `erp.erpOrderId`, `erp.trackingNumber`, `statusUpdatedAt` | Written by the Order Status Callback |

### 12.5 Customers (inside orders only)

| API field | Website source | Returned by |
|---|---|---|
| `customer.customerId` | `User._id` | Orders list and details |
| `customer.name`, `customer.email` | `User.name`, `User.email` | Orders list and details |
| `customer.phone` | `User.phone` | Order details only |

---

## 13. Not implemented: website → ERP order push and customer sync

The current source contains no code that sends orders or customers to the ERP. The ERP must pull orders with Sections 7–8.

**Website → ERP order push (NOT IMPLEMENTED).** The planned design, not yet built:

- When the website saves a paid order, a background job sends it to the ERP's sales-order API, using the website `orderId` as the external reference.
- Retries use backoff and must not create duplicates.
- The returned ERP order id is stored on the order.
- Sync status and errors are visible to Luxy Galleria admins.

Building it requires the information in Section 14, items 1–3 and 6. Orders placed before the push goes live remain available through Order Checking.

**Customer synchronization (NOT IMPLEMENTED).** No endpoint creates, updates or lists customers. Customer name, email and phone reach the ERP only inside orders (Section 12.5).

---

## 14. Information required from the ERP team

| # | Topic | What we need |
|---|---|---|
| 1 | Sales Order Create API | Endpoint URL (sandbox and production), request payload schema, required fields (tax/GST/HSN, billing address, order number, etc.), and a sample success response with your order id |
| 2 | Authentication | How the website must authenticate to your API (method, credentials, rotation), and confirmation that the HMAC scheme in Section 2 is acceptable for your calls to us. If you need IP allow-listing, your outbound IP addresses. |
| 3 | Idempotency and duplicates | How your API treats a repeated order with the same external reference (`orderId`), and whether you need an `Idempotency-Key` header |
| 4 | Product, SKU and stock ownership | SKU format (allowed characters, length, case rules) — the website currently accepts any 1–64 character value, matched exactly — uniqueness, and whether SKUs can change. The item code for each existing website variant that has no SKU (list them with Item List, Section 6A). Whether the ERP is the master for items, prices and stock, so that admin-panel editing can be locked. Whether your stock `quantity` is physical on-hand or sellable stock, and whether it already excludes website orders you have received (Section 4), and warehouse/unit rules. Whether categories and brands should be auto-created. |
| 5 | Order and payment statuses | Your status list and its mapping to `processing` / `shipped` / `delivered` / `cancelled`; your transition rules; ownership of cancellation, refunds and restocking; whether payment status changes must flow either way |
| 6 | Retry, timeout, errors, reconciliation | Your timeouts, error codes and rate limits; expected retry behaviour on both sides; how and how often orders and stock are reconciled; expected volumes (is a bulk stock endpoint needed?) |
| 7 | Customer data and privacy | Which customer fields you need and why; whether a customer master sync is required; retention, access control and data-protection obligations for the personal data you receive (name, email, phone, address) |

---

## 15. Test evidence

Each category is reported separately. No signed request has been sent to production by Luxy Galleria's review, and no production data has been read or changed by it.

### 15.1 Automated local tests

`npm run test:erp` (`src/tests/erp.test.ts`) against a throwaway local MongoDB with email and image storage disabled: **33 passed, 0 failed** (22 and 23 October 2026). Covers authentication, item upsert/edit, stock rules, order listing/details, the status callback, and image validation with storage stubbed.

### 15.2 Local Postman / Newman

The exported collection was run with Newman against a local server on a throwaway database (22 October 2026; final exported files re-run on 23 October 2026 with the same result):

- Requests 1–5 and 7 returned their documented success status, and all their tests passed.
- The database state was checked: one product created, then updated in place on re-runs (no duplicates); the price edit applied; stock set with `stockAsOf`; the order moved processing → shipped → delivered, with events recorded.
- Image Upload passed the signature check and stopped at the disabled storage (`503`). A wrong `imageSha256` returned `401 Invalid X-ERP-Signature`.
- With blank credentials, the *request was signed* test failed as designed.

### 15.3 Local response capture

On 23 October 2026, 62 signed requests covering the success and error cases of all seven endpoints were sent to a local server on a throwaway database. The response examples in Sections 4–10 are from this run. Additional wire-format checks:

| Check | Result |
|---|---|
| JSON sent with `Content-Type: text/plain` | `401 Invalid X-ERP-Signature` |
| `Content-Type: application/json; charset=utf-8` | `200` |
| Uppercase hex signature | `200` |
| Timestamp in milliseconds | `401 X-ERP-Timestamp…` |
| Pretty-printed JSON, signed as sent | `200` |

### 15.4 Previously observed production responses (earlier Postman tests by the project team)

| Request | Result | Notes |
|---|---|---|
| Order Checking | `200` | Reported; request details not available for review |
| Order Details | `200` | Reported; request details not available for review |
| Item Add | `401 Invalid ERP credentials` | Most likely an unsigned request or a different key ID (Section 2.6). Not yet re-tested. |

### 15.5 Production checks without credentials (22–23 October 2026)

| Request | Result | Meaning |
|---|---|---|
| `GET /api/v1/health` | `200` | Service reachable |
| Unsigned request to each of the seven routes | `401 Invalid ERP credentials` | Routes deployed; authentication enforced; ERP keys are configured (otherwise `503`) |

### 15.6 Blocked or untested

| Item | Status | Blocker |
|---|---|---|
| Signed production read (Order Checking, Order Details) | NOT TESTED in this review | Needs the production key ID and secret on the tester's side |
| Production writes (Item Add, Item Edit, Stock Update, Order Status Callback) | NOT TESTED | Needs an approved test plan with a test SKU and test order, or a staging service |
| Real image storage (any environment) | NOT TESTED | Needs Cloudinary configured on the target server and an approved test |
| Website → ERP order push, customer sync | NOT IMPLEMENTED | Section 13 |

### 15.7 Version 2.1 local verification (27 October 2026)

Automated tests against throwaway local MongoDB databases (no production data, email or image storage):

| Suite | Result | Covers |
|---|---|---|
| `src/tests/erp.test.ts` | 40 passed, 0 failed | All nine ERP routes including authentication, plus the 2.1 additions: reservations subtracted from stock, `UNMAPPED_PRODUCT` (also for spaces-only SKUs), order-line SKU/name snapshot, a stock update retried concurrently applied once, concurrent updates with different `asOf` (newest wins), `409 CONFLICT` after the retries when stock keeps changing (nothing overwritten) |
| `src/tests/products.test.ts` | 12 passed, 0 failed | Website admin keeps variant ids, stock and `stockAsOf` on edits; SKU set-once and uniqueness rules, including legacy SKUs stored with surrounding or only spaces |
| `src/tests/paymentLifecycle.test.ts` | 16 passed, 0 failed | Unknown variant refused at checkout; SKU/name stored on the order line; a stock update arriving while a checkout is creating its payment does not lose that checkout's reservation; admin status changes follow the callback's transition rules, set `statusUpdatedAt`, and make an older callback `stale` |

Postman collection (version 2.1 files), run with the Postman CLI 1.76 against a local server on a throwaway database with a throwaway key: 15 requests, 61 assertions passed. Requests 1–5 and 7–9 returned their documented success status (Order Details was run on a store-pickup order, whose `shippingAddress` is `null`), and all six *Negative checks* returned their documented refusal. *6. Image Upload* failed as expected in a command-line run, because no file can be selected (Section 11.4); image upload remains covered only by the automated test with storage stubbed.

Nothing in version 2.1 has been tested in staging (none exists) or production.

---

## 16. Known limitations and open items

| # | Item | Status |
|---|---|---|
| 1 | Production Item Add returned `401 Invalid ERP credentials` | Re-test with the Postman collection and check its *request was signed* test (Section 2.6) |
| 2 | No staging environment | **NEEDS CONFIRMATION** — Luxy Galleria to decide on a staging service or approve production test records |
| 3 | No draft/inactive product flag; created items are public at once | Limitation |
| 4 | Admin panel can still edit price, and adjust stock | Since version 2.1, admin product edits never overwrite stock or `stockAsOf`; a stock adjustment applies only if stock is unchanged since the admin opened the product. Stock editing can be removed once the ERP is confirmed as master (Section 14, item 4) |
| 5 | Some existing website variants have no SKU, and SKUs are not yet unique at database level | Existing duplicates are refused with `409 DUPLICATE_SKU`; the website admin refuses new duplicates. A database unique index will be added after the SKU backfill, which needs the mapping in Section 14, item 4 |
| 6 | Orders are created when payment is verified by the customer's browser or by the Razorpay payment webhook | The webhook is implemented but active only when configured on the server (**NEEDS CONFIRMATION** for production) |
| 7 | HSN codes, billing address, recipient name/phone, order number are not stored | Add once your requirements are known (Section 8) |
| 8 | No bulk stock endpoint; 600 requests/minute | **NEEDS CONFIRMATION** of volumes |
| 9 | Business rules marked **NEEDS CONFIRMATION** above | Awaiting the ERP team (Section 14) |
| 10 | Stock formula subtracts website orders and open checkouts from your figure | Provisional until stock semantics are confirmed (Section 4) |
| 11 | Version 2.1 changes are verified locally only | Deploy to a staging or approved production window, then re-run Section 11.5 |
