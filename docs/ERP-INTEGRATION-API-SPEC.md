# Luxy Galleria — ERP Integration API Specification

| | |
|---|---|
| Version | 1.1 (implementation and auth diagnostics) |
| Date | 21 October 2026 |
| Audience | ERP development team; Luxy Galleria backend team |
| Production host | `https://api.luxygalleria.com` (supplied by the project owner) |
| API prefix | `/api/v1/erp` |
| Source | `luxy-backend` — `src/routes/erpRoutes.ts`, `src/controllers/erpController.ts`, `src/middlewares/erpAuth.ts` |
| Tests | `src/tests/erp.test.ts` (`npm run test:erp`) |

## Status at a glance

| Label | Meaning |
|---|---|
| ✅ **Implemented and locally tested** | Code exists in `luxy-backend` and passes the automated tests against a local throwaway MongoDB |
| 🟡 **Implemented but not yet tested** | Code exists; no automated test covers it yet |
| 🟦 **Requires ERP-team confirmation** | A contract or business rule we propose and the ERP team must accept or change |
| 🚀 **Requires production verification** | Deployment or behavior has not been independently verified against production |

> A production request has reached ERP authentication and returned `401 Invalid ERP credentials`. This confirms that at least the requested route and auth middleware are deployed; successful ERP authentication, database access, and the other production routes have not been independently verified here.

| # | Capability | Method | Full URL | Status |
|---|---|---|---|---|
| 1 | Stock Update | `PUT` | `https://api.luxygalleria.com/api/v1/erp/stock/{sku}` | ✅ 🚀 |
| 2 | Item Add / Upsert | `POST` | `https://api.luxygalleria.com/api/v1/erp/items` | ✅ 🚀 |
| 3 | Item Edit | `PATCH` | `https://api.luxygalleria.com/api/v1/erp/items/{sku}` | ✅ 🚀 |
| 4 | Order Checking | `GET` | `https://api.luxygalleria.com/api/v1/erp/orders` | ✅ 🚀 |
| 5 | Order Details | `GET` | `https://api.luxygalleria.com/api/v1/erp/orders/{orderId}` | ✅ 🚀 |
| 6 | Order Status Changing (ERP callback) | `POST` | `https://api.luxygalleria.com/api/v1/erp/webhooks/order-status` | ✅ 🚀 |
| 7 | Image Upload | `POST` | `https://api.luxygalleria.com/api/v1/erp/images` | ✅ 🚀 |
| — | Website → ERP order push | `POST` (to ERP) | ERP-provided | ❌ **Not implemented** — waiting for the ERP sales-order API (Section 10) 🟦 |

---

## 1. Authentication (all seven endpoints)

HMAC request signing is implemented in `src/middlewares/erpAuth.ts` and exercised by the local ERP integration suite. The integration contract remains subject to ERP-team confirmation where noted.

Every request carries three headers:

| Header | Value |
|---|---|
| `X-ERP-Key-Id` | Key identifier issued by Luxy Galleria, e.g. `erp-prod-1` |
| `X-ERP-Timestamp` | Current Unix time in **seconds**. Must be within **±300 s** of server time. |
| `X-ERP-Signature` | Lowercase hex `HMAC-SHA256(secret, stringToSign)` |

```
stringToSign = <X-ERP-Timestamp> + "." + <HTTP METHOD> + "." + <path and query exactly as sent> + "." + <hex SHA-256 of body>
```

- **path and query exactly as sent:** for example `/api/v1/erp/orders?limit=50&status=shipped`, including any percent-encoding, and without the host.
- **body:**
  - JSON endpoints: the exact raw bytes sent.
  - `GET` requests: empty, so the hash is `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
  - `POST /images`: the raw bytes of the uploaded file.

**Rules**

- The `X-ERP-Key-Id` header must exactly match a configured key ID, including letter case. The key ID is not a secret.
- **Sign every attempt with a fresh timestamp.** An identical signature seen again within 10 minutes is rejected as a replay.
- Admin or customer logins and JWTs are **not accepted** on these routes. ERP keys grant access to nothing outside `/api/v1/erp/*`.
- If no ERP keys are configured on the server, every ERP route returns `503` (fail closed).
- **Rate limit:** 600 requests per minute per IP on ERP routes, separate from the website's limit. Exceeding it returns `429` with a `Retry-After` header.
- **HTTPS only.**

**Test vector** (fake secret; use it to check your signing code)

| Input | Value |
|---|---|
| secret | `test_secret_0123456789abcdef0123456789ab` |
| timestamp | `1792222200` |
| method / path | `PUT` `/api/v1/erp/stock/YOUR_SKU` |
| body | `{"quantity":25,"asOf":"2026-10-17T09:30:00Z"}` |
| **signature** | `063c8145c1ab838827f3f78197594d0c1cee60e1d23f1be8e55b711d81d2c116` |

**Shell helper used by the curl examples** (placeholders only):

```bash
BASE=https://api.luxygalleria.com
KEY_ID=YOUR_ERP_KEY_ID
SECRET=YOUR_ERP_SECRET          # never commit or paste into tickets

# usage: sign METHOD PATH_WITH_QUERY BODY_FILE_OR_EMPTY  -> sets TS and SIG
sign() {
  TS=$(date +%s)
  if [ -n "$3" ]; then BODY_HASH=$(openssl dgst -sha256 -hex < "$3" | sed 's/^.* //')
  else BODY_HASH=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855; fi
  SIG=$(printf '%s' "$TS.$1.$2.$BODY_HASH" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')
}
```

**Node.js signing client:** [`docs/erp-signing-client.mjs`](erp-signing-client.mjs) reads `ERP_KEY_ID`, `ERP_SECRET`, and optionally `ERP_API_BASE_URL` from its environment. The default API base is `https://api.luxygalleria.com/api/v1`. It constructs the URL first, signs that URL's exact path and query, and sends the same uppercase method. JSON bodies are signed and sent as the same `Buffer`; image uploads sign the image bytes while sending a multipart request. The script prints only the HTTP status, not API response data or credentials.

Offline signing check (no credentials or network request required):

```bash
node docs/erp-signing-client.mjs --verify-vector
```

After setting the client environment variables in a secure local shell or secret manager, these production checks are non-destructive:

```bash
ERP_API_BASE_URL=https://api.luxygalleria.com/api/v1 node docs/erp-signing-client.mjs get
ERP_API_BASE_URL=https://api.luxygalleria.com/api/v1 node docs/erp-signing-client.mjs json-validation
```

Expected: `get` returns HTTP 200 and only reads one order page; `json-validation` sends `{}` to item validation, expects HTTP 400, and creates or changes no data. The `upload` mode writes an image to Cloudinary; use staging only.

**Authentication errors**

| HTTP | `message` | `errors[0].code` |
|---|---|---|
| 401 | `Invalid ERP credentials` | `UNAUTHENTICATED` |
| 401 | `X-ERP-Timestamp missing or more than 300s from server time` | `UNAUTHENTICATED` |
| 401 | `Invalid X-ERP-Signature` | `UNAUTHENTICATED` |
| 401 | `Replayed request: sign every attempt with a fresh timestamp` | `UNAUTHENTICATED` |
| 503 | `ERP integration is not configured` | `UNAVAILABLE` |
| 429 | `Too many ERP requests, retry after the Retry-After interval` | `RATE_LIMITED` |

### Diagnosing `Invalid ERP credentials`

The middleware returns this message when the supplied key ID is absent from the parsed `ERP_API_KEYS` key map. The configuration is read at request time as comma-separated `keyId:secret` pairs; key IDs and secrets are trimmed, and secrets shorter than 32 characters are ignored. If no valid pairs remain, the response is `503 ERP integration is not configured` instead. A stale timestamp, signature mismatch, or replay has a different 401 message.

Therefore, a production `401 Invalid ERP credentials` indicates a key-ID/configuration mismatch in the normal request flow, not a body, path, method, timestamp, or HMAC mismatch. Verify in the production secret manager that `ERP_API_KEYS` contains the exact ID sent in `X-ERP-Key-Id`, with a secret of at least 32 characters. Do not print or paste the variable value. This repository cannot verify the live secret-manager value.

## 2. Common conventions

**Success**

```json
{ "success": true, "message": "…", "data": { } }
```

**Error**

```json
{ "success": false, "message": "Validation failed", "errors": [{ "field": "quantity", "code": "VALIDATION_ERROR", "message": "Number must be greater than or equal to 0" }] }
```

**Error codes:** `VALIDATION_ERROR` (400), `UNAUTHENTICATED` (401), `NOT_FOUND` (404), `DUPLICATE_SKU` / `CONFLICT` / `STALE_UPDATE` / `INVALID_TRANSITION` (409), `PAYLOAD_TOO_LARGE` (413), `RATE_LIMITED` (429), `UPSTREAM_ERROR` (502), `UNAVAILABLE` (503).

**Retries.** Every write below is safe to repeat (see each endpoint's *Idempotency* note).

- **Retry** `429`, `5xx` and network timeouts with exponential backoff (for example 30 s, 2 min, 10 min, 1 h), re-signing each attempt.
- **Do not retry** `400`, `401`, `404` or `409` without fixing the request.
- An `Idempotency-Key` header is not required. 🟦 Tell us if your platform needs one.

**Request rules**

- JSON bodies use `Content-Type: application/json` and may be up to 1 MB.
- Unknown fields are **rejected** on stock and item requests (strict validation). On the webhook they are ignored.
- Text values are sanitised: `<script>…</script>`, `javascript:` and `on…=` patterns are removed.
- **SKU matching is exact** (case-sensitive) after trimming spaces. A SKU found on more than one website variant returns `409 DUPLICATE_SKU` until the data is fixed (Section 9).

---

## 3. Stock Update — `PUT /api/v1/erp/stock/{sku}`

✅ Implemented and locally tested · 🚀 not yet deployed · 🟦 reconciliation rule to be confirmed

**Purpose:** set the **absolute sellable quantity** of one product variant. This is not an adjustment.

**Full URL:** `https://api.luxygalleria.com/api/v1/erp/stock/{sku}`

| Path parameter | Type | Rules |
|---|---|---|
| `sku` | string | URL-encoded; must match exactly one website variant |

| Body field | Type | Required | Rules |
|---|---|---|---|
| `quantity` | integer | Yes | 0 – 1,000,000. Absolute sellable units. |
| `asOf` | string | Yes | ISO 8601 with timezone, e.g. `2026-10-17T09:30:00Z`. The ERP time the figure was taken. No more than 5 minutes in the future. |

**Behaviour**

- **Stale updates are refused.** The update is applied only if `asOf` is newer than the last applied `asOf` for that variant. An older one returns `409 STALE_UPDATE`. The same `asOf` again returns `200` with `applied: false`.
- **Website orders since your snapshot stay reserved.** Website orders placed after `asOf` (and not cancelled) are not yet in your figure. The website subtracts them:
  - stored stock = `max(0, quantity − pendingOrderQuantity)`
  - both numbers are returned in the response
  - 🟦 This is a provisional rule. Confirm it, or tell us your figure already accounts for website orders.
- **Only this variant's stock is written,** in one atomic update. The product's total stock is recomputed. Prices, images and other variants are untouched.
- Checkout continues to reduce stock with its own atomic, conditional decrement.
- No product is ever created by this endpoint. An unknown SKU returns `404`.

**Request**

```json
{ "quantity": 25, "asOf": "2026-10-17T09:30:00Z" }
```

**Success `200`**

```json
{
  "success": true,
  "message": "Stock updated",
  "data": {
    "sku": "YOUR_SKU",
    "productId": "YOUR_PRODUCT_ID",
    "variantId": "YOUR_VARIANT_ID",
    "asOf": "2026-10-17T09:30:00.000Z",
    "previousQuantity": 12,
    "quantity": 25,
    "erpQuantity": 25,
    "pendingOrderQuantity": 0,
    "applied": true,
    "updatedAt": "2026-10-17T09:30:02.114Z"
  }
}
```

**Same update delivered again `200`:** `"message": "Stock already at this update"`, `"applied": false`, with the current quantity.

**Errors**

| HTTP | Example |
|---|---|
| 400 | `{ "success": false, "message": "Validation failed", "errors": [{ "field": "quantity", "code": "VALIDATION_ERROR", "message": "Expected integer, received float" }] }` |
| 400 | `{ "success": false, "message": "asOf is in the future", "errors": [{ "code": "VALIDATION_ERROR", "field": "asOf" }] }` |
| 404 | `{ "success": false, "message": "SKU not found: YOUR_SKU", "errors": [{ "code": "NOT_FOUND", "field": "sku" }] }` |
| 409 | `{ "success": false, "message": "A newer stock update has already been applied", "errors": [{ "code": "STALE_UPDATE", "field": "asOf", "currentAsOf": "2026-10-17T09:35:00.000Z" }] }` |
| 409 | `{ "success": false, "message": "SKU YOUR_SKU is used by 2 website variants; fix the duplicate before syncing", "errors": [{ "code": "DUPLICATE_SKU", "field": "sku" }] }` |

**Idempotency:** repeating a request with the same `asOf` changes nothing.

**Bulk:** not implemented. Send one request per SKU (600/min). 🟦 A bulk endpoint can be added if your volumes need it.

```bash
P=/api/v1/erp/stock/YOUR_SKU
printf '%s' '{"quantity":25,"asOf":"2026-10-17T09:30:00Z"}' > body.json
sign PUT "$P" body.json
curl -sS -X PUT "$BASE$P" -H "Content-Type: application/json" \
  -H "X-ERP-Key-Id: $KEY_ID" -H "X-ERP-Timestamp: $TS" -H "X-ERP-Signature: $SIG" \
  --data-binary @body.json
```

**Source:** `erpController.ts` → `updateStock`. **Tests:** "Stock update" section of `erp.test.ts`.

---

## 4. Item Add / Upsert — `POST /api/v1/erp/items`

✅ Implemented and locally tested · 🚀 not yet deployed

**Purpose:** create a product with its variants, or update the product that already carries these SKUs.

**Full URL:** `https://api.luxygalleria.com/api/v1/erp/items`

| Body field | Type | Required | Rules / mapping |
|---|---|---|---|
| `name` | string | On create | 1–200 characters |
| `description` | string | On create | 1–5000 characters |
| `category` | string | On create | Name (case-insensitive) or id of an **existing** website category |
| `brand` | string | No | Name of an existing brand |
| `brandId` | string | No | 24-hex id of an existing brand (takes precedence over `brand`) |
| `imageUrls` | string[] | No | Up to 10 `https://` URLs. **Replaces** the product's image list when sent; untouched when omitted. |
| `variants` | array | **Yes** | 1–50 entries; each SKU at most once |
| `variants[].sku` | string | **Yes** | 1–64 characters; the matching key |
| `variants[].size` / `volume` | string | No | e.g. `"30ml"`. Default `"Standard"` for new variants. |
| `variants[].flavor` | string | No | Default `"Default"` |
| `variants[].offerPrice` | number | For new variants | Selling price, ≥ 0 |
| `variants[].actualPrice` | number | For new variants | MRP; must be ≥ `offerPrice` |
| `variants[].stock` | integer | No | **Used only when the variant is created.** Existing variants change stock only via Section 3. |
| `variants[].weight` | number | No | kg; if omitted on create, parsed from `size` (e.g. `"500g"` → 0.5) |
| `variants[].image` | string | No | `https://` URL |

**Matching rules**

| Situation | Result |
|---|---|
| No SKU in the request exists on the website | A new product is created → `201` |
| The SKUs belong to one existing product | That product is updated → `200` |
| On update | Only supplied fields change. Existing variants not in the request are kept. New SKUs are added as new variants. |
| SKUs belong to two different website products | `409 CONFLICT` |
| A SKU exists on two website variants | `409 DUPLICATE_SKU` |
| Unknown category or brand | `400` (categories and brands are not auto-created 🟦) |

**Request**

```json
{
  "name": "Rose Serum",
  "description": "Hydrating face serum",
  "category": "Skincare",
  "brand": "Lumina",
  "imageUrls": ["https://images.example-erp.com/YOUR_SKU/main.jpg"],
  "variants": [
    { "sku": "YOUR_SKU", "size": "30ml", "offerPrice": 499, "actualPrice": 599, "stock": 10, "weight": 0.05 }
  ]
}
```

**Success `201` (created) / `200` (updated)**

```json
{
  "success": true,
  "message": "Item created",
  "data": {
    "productId": "YOUR_PRODUCT_ID",
    "action": "created",
    "variants": [
      {
        "sku": "YOUR_SKU", "variantId": "YOUR_VARIANT_ID", "size": "30ml", "flavor": "Default",
        "offerPrice": 499, "actualPrice": 599, "stock": 10, "weight": 0.05, "image": null, "action": "created"
      }
    ]
  }
}
```

**Errors**

| HTTP | Example |
|---|---|
| 400 | Missing on create: `{ "message": "Validation failed", "errors": [{ "field": "name", "code": "VALIDATION_ERROR", "message": "required when creating an item" }] }` |
| 400 | Unknown field: `{ "errors": [{ "code": "VALIDATION_ERROR", "message": "Unrecognized key(s) in object: 'color'" }] }` |
| 400 | `offerPrice cannot be higher than actualPrice (MRP)`; `Unknown category: Nope`; `Each SKU may appear only once per request` |
| 409 | `These SKUs belong to different website products; send them separately` (`CONFLICT`) |
| 409 | `DUPLICATE_SKU` (see Section 3) |

**Idempotency:** repeating the request updates the same product; it never creates a duplicate.

```bash
P=/api/v1/erp/items
sign POST "$P" item.json
curl -sS -X POST "$BASE$P" -H "Content-Type: application/json" \
  -H "X-ERP-Key-Id: $KEY_ID" -H "X-ERP-Timestamp: $TS" -H "X-ERP-Signature: $SIG" --data-binary @item.json
```

**Source:** `erpController.ts` → `upsertItem`. **Tests:** "Item add / upsert" section.

---

## 5. Item Edit — `PATCH /api/v1/erp/items/{sku}`

✅ Implemented and locally tested · 🚀 not yet deployed

**Purpose:** change only the supplied fields of the variant `sku` and its product.

**Full URL:** `https://api.luxygalleria.com/api/v1/erp/items/{sku}`

**Allowed fields** (at least one; anything else → `400`):

| Level | Fields |
|---|---|
| Product | `name`, `description`, `category`, `brand`, `brandId`, `imageUrls` (replaces the list) |
| Variant | `size` / `volume`, `flavor`, `offerPrice`, `actualPrice`, `weight`, `image` |

Types and rules are the same as Section 4.

**Not allowed**

- `stock` — use Section 3.
- `sku` — changing a SKU is not supported 🟦.

**Guarantees**

- Omitted fields, other variants, images and stock are untouched.
- The variant id never changes.
- No product is created; an unknown SKU returns `404`.

**Request**

```json
{ "offerPrice": 449, "name": "Rose Serum — New Pack" }
```

**Success `200`**

```json
{
  "success": true,
  "message": "Item updated",
  "data": {
    "productId": "YOUR_PRODUCT_ID",
    "name": "Rose Serum — New Pack",
    "category": "Skincare",
    "images": ["https://images.example-erp.com/YOUR_SKU/main.jpg"],
    "updatedFields": ["offerPrice", "name"],
    "variant": {
      "sku": "YOUR_SKU", "variantId": "YOUR_VARIANT_ID", "size": "30ml", "flavor": "Default",
      "offerPrice": 449, "actualPrice": 599, "stock": 25, "weight": 0.05, "image": null
    }
  }
}
```

**Errors:**
- `400` — empty body, unknown or disallowed field (including `stock`), price above MRP, unknown category/brand.
- `404` — SKU not found.
- `409` — `DUPLICATE_SKU`.

**Idempotency:** naturally repeatable; the same body gives the same result.

```bash
P=/api/v1/erp/items/YOUR_SKU
printf '%s' '{"offerPrice":449}' > patch.json
sign PATCH "$P" patch.json
curl -sS -X PATCH "$BASE$P" -H "Content-Type: application/json" \
  -H "X-ERP-Key-Id: $KEY_ID" -H "X-ERP-Timestamp: $TS" -H "X-ERP-Signature: $SIG" --data-binary @patch.json
```

**Source:** `erpController.ts` → `patchItem`. **Tests:** "Item edit" section.

---

## 6. Order Checking — `GET /api/v1/erp/orders`

✅ Implemented and locally tested · 🚀 not yet deployed

**Purpose:** list orders page by page, oldest change first, for incremental sync.

**Full URL:** `https://api.luxygalleria.com/api/v1/erp/orders`

| Query parameter | Type | Default | Rules |
|---|---|---|---|
| `page` | integer | 1 | ≥ 1 |
| `limit` | integer | 50 | 1–100 |
| `status` | string | — | `processing` \| `shipped` \| `delivered` \| `cancelled` |
| `paymentStatus` | string | — | `pending` \| `completed` \| `failed` \| `refunded` |
| `updatedSince` | ISO 8601 | — | Orders with `updatedAt >= updatedSince` |

Unknown query parameters → `400`.

**Order and incremental sync**

- Results are sorted by `updatedAt`, then `orderId` (stable).
- To sync incrementally, keep the newest `updatedAt` you received and pass it as `updatedSince` next time. You will see that last order again, so de-duplicate by `orderId`.
- Only orders that have been paid and saved by the website exist; checkout saves an order after payment verification.

**Success `200`**

```json
{
  "success": true,
  "message": "Orders fetched",
  "data": [
    {
      "orderId": "YOUR_ORDER_ID",
      "createdAt": "2026-10-17T08:00:00.000Z",
      "updatedAt": "2026-10-17T08:00:05.000Z",
      "orderStatus": "processing",
      "paymentStatus": "completed",
      "currency": "INR",
      "subtotal": 998,
      "discount": 0,
      "shippingFee": 40,
      "total": 1038,
      "customer": { "customerId": "YOUR_CUSTOMER_ID", "name": "Customer Name", "email": "customer@example.com" },
      "items": [
        { "productId": "YOUR_PRODUCT_ID", "variantId": "YOUR_VARIANT_ID", "sku": "YOUR_SKU", "name": "Rose Serum", "size": "30ml", "quantity": 2, "unitPrice": 499, "lineTotal": 998 }
      ],
      "erp": { "erpOrderId": null, "trackingNumber": null }
    }
  ],
  "pagination": { "page": 1, "limit": 50, "total": 1, "pages": 1 }
}
```

**Field notes**

- `items[].sku` is the variant's **current** SKU, looked up when you call. It is `null` if the variant has no SKU or was deleted.
- `currency` is always `INR`; the store charges only INR and does not store it per order.
- `discount` is currently always `0`.

**Errors:** `400` (for example `limit=500`, `status=lost`, a bad date, or an unknown parameter), `401`.

```bash
P='/api/v1/erp/orders?updatedSince=2026-10-17T00:00:00Z&limit=50'
sign GET "$P" ""
curl -sS "$BASE$P" -H "X-ERP-Key-Id: $KEY_ID" -H "X-ERP-Timestamp: $TS" -H "X-ERP-Signature: $SIG"
```

**Source:** `erpController.ts` → `listOrders`. **Tests:** "Orders" section.

---

## 7. Order Details — `GET /api/v1/erp/orders/{orderId}`

✅ Implemented and locally tested · 🚀 not yet deployed

**Purpose:** return one order by its website order id (24 hex characters).

**Full URL:** `https://api.luxygalleria.com/api/v1/erp/orders/{orderId}`

**Success `200`** — every field in Section 6, plus:

```json
{
  "success": true,
  "message": "Order fetched",
  "data": {
    "orderId": "YOUR_ORDER_ID",
    "orderStatus": "processing",
    "paymentStatus": "completed",
    "currency": "INR",
    "subtotal": 998, "discount": 0, "shippingFee": 40, "total": 1038,
    "customer": { "customerId": "YOUR_CUSTOMER_ID", "name": "Customer Name", "email": "customer@example.com", "phone": "CUSTOMER_PHONE" },
    "shippingAddress": { "street": "Street", "city": "City", "state": "State", "zipCode": "000000", "country": "India" },
    "items": [
      { "productId": "YOUR_PRODUCT_ID", "variantId": "YOUR_VARIANT_ID", "sku": "YOUR_SKU", "name": "Rose Serum", "size": "30ml", "quantity": 2, "unitPrice": 499, "lineTotal": 998 }
    ],
    "payment": { "method": "razorpay", "status": "completed", "gatewayOrderId": "GATEWAY_ORDER_REF", "gatewayPaymentId": "GATEWAY_PAYMENT_REF" },
    "erp": { "erpOrderId": null, "trackingNumber": null },
    "statusUpdatedAt": null,
    "createdAt": "2026-10-17T08:00:00.000Z",
    "updatedAt": "2026-10-17T08:00:05.000Z"
  }
}
```

**Not returned, because the website does not hold this data** (fields are not invented):

- tax / GST / HSN amounts
- billing address
- recipient name and phone
- apartment and landmark
- customer GSTIN
- order number

🟦 Tell us which of these your sales-order requires.

The payment signature, passwords and tokens are never returned.

**Errors:**
- `400` `orderId must be a 24-character hex id`.
- `404` `Order not found`.

```bash
P=/api/v1/erp/orders/YOUR_ORDER_ID
sign GET "$P" ""
curl -sS "$BASE$P" -H "X-ERP-Key-Id: $KEY_ID" -H "X-ERP-Timestamp: $TS" -H "X-ERP-Signature: $SIG"
```

**Source:** `erpController.ts` → `getOrder`. **Tests:** "Orders" section.

---

## 8. Order Status Changing — `POST /api/v1/erp/webhooks/order-status`

✅ Implemented and locally tested · 🚀 not yet deployed · 🟦 status list and transitions to be confirmed

**Purpose:** the ERP tells the website that an order's fulfilment status changed.

**Full URL:** `https://api.luxygalleria.com/api/v1/erp/webhooks/order-status`

| Body field | Type | Required | Rules |
|---|---|---|---|
| `eventId` | string | Yes | 1–100 characters, unique per event; redelivery of the same id is ignored |
| `orderId` | string | Yes | Website order id (24 hex) |
| `status` | string | Yes | `processing` \| `shipped` \| `delivered` \| `cancelled` |
| `occurredAt` | string | Yes | ISO 8601 with timezone; when it happened in the ERP |
| `erpOrderId` | string | No | Stored the first time. A different value later → `409`. |
| `trackingNumber` | string | No | Stored with the status |

Other fields are ignored.

**Allowed transitions**

| From | To |
|---|---|
| `processing` | `shipped`, `delivered`, `cancelled` |
| `shipped` | `delivered`, `cancelled` |
| `delivered`, `cancelled` | Final — no change allowed |

**Outcomes**

| Situation | Response |
|---|---|
| Valid forward move | `200`, `outcome: "applied"`; the customer is emailed **once** |
| Same status as now | `200`, `outcome: "unchanged"` (tracking number / ERP id still saved; no email) |
| `occurredAt` not newer than the last applied event | `200`, `outcome: "stale"`; nothing changes, so an older event can never revert a newer state |
| Same `eventId` again | `200`, `duplicate: true`; no side effects |
| Backward or from a final state | `409 INVALID_TRANSITION`; not recorded, so you can send a corrected event |
| Unknown order | `404` |
| Order changed concurrently | `409 CONFLICT`; retry the event |

**What this endpoint does not do**

- **Refunds:** none. Cancelling does not refund the payment; refunds remain a manual Razorpay action 🟦.
- **Stock:** not restored. The ERP owns stock and should send the corrected quantity through Section 3 🟦.
- The cancellation email uses the website's existing text, which tells the customer a refund will be initiated if they were charged.

**Request**

```json
{
  "eventId": "EVENT-001",
  "orderId": "YOUR_ORDER_ID",
  "erpOrderId": "ERP_ORDER_ID",
  "status": "shipped",
  "trackingNumber": "TRACK-001",
  "occurredAt": "2026-10-17T10:00:00Z"
}
```

**Success `200`**

```json
{
  "success": true,
  "message": "Status updated",
  "data": {
    "eventId": "EVENT-001",
    "orderId": "YOUR_ORDER_ID",
    "previousStatus": "processing",
    "orderStatus": "shipped",
    "applied": true,
    "outcome": "applied",
    "duplicate": false
  }
}
```

**Duplicate `200`:** `{ "success": true, "message": "Event already processed", "data": { "eventId": "EVENT-001", "duplicate": true, "outcome": "applied" } }`

**Errors**

| HTTP | Example |
|---|---|
| 400 | `{ "message": "Validation failed", "errors": [{ "field": "status", "code": "VALIDATION_ERROR", "message": "Invalid enum value. Expected 'processing' \| 'shipped' \| 'delivered' \| 'cancelled', received 'lost'" }] }` |
| 404 | `{ "message": "Order not found", "errors": [{ "code": "NOT_FOUND", "field": "orderId" }] }` |
| 409 | `{ "message": "Order cannot move from shipped to processing", "errors": [{ "code": "INVALID_TRANSITION", "field": "status" }] }` |

**Delivery and retry**

- Treat any non-`2xx` response or timeout as failed.
- Retry with backoff and the **same `eventId`**, re-signing each attempt.

```bash
P=/api/v1/erp/webhooks/order-status
sign POST "$P" event.json
curl -sS -X POST "$BASE$P" -H "Content-Type: application/json" \
  -H "X-ERP-Key-Id: $KEY_ID" -H "X-ERP-Timestamp: $TS" -H "X-ERP-Signature: $SIG" --data-binary @event.json
```

**Source:** `erpController.ts` → `orderStatusWebhook`; event log `src/models/ErpEvent.ts`; email `paymentController.ts` → `sendOrderStatusEmail`. **Tests:** "Order-status webhook" section.

---

## 9. Image Upload — `POST /api/v1/erp/images`

✅ Implemented and locally tested (storage stubbed in tests) · 🚀 real Cloudinary upload to be verified after deployment

**Purpose:** upload one product image and get back a hosted URL. Then use that URL in `imageUrls` or `variants[].image` (Sections 4–5).

**Simpler alternative:** if your images already have public `https://` URLs, send those directly in the item APIs and skip this endpoint.

**Full URL:** `https://api.luxygalleria.com/api/v1/erp/images`

| Item | Value |
|---|---|
| Content-Type | `multipart/form-data` |
| File field | `image` — exactly one file, no other form fields |
| Formats | JPG/JPEG, PNG, WEBP. Extension, declared content type **and** actual file bytes must agree. |
| Max size | 15 MB |
| Signature body | SHA-256 of the **file bytes** (not the multipart envelope) |
| Storage | Cloudinary, folder `luxygalleria_products`. Never server disk. |

**Success `201`**

```json
{
  "success": true,
  "message": "Image uploaded",
  "data": { "url": "https://res.cloudinary.com/<cloud>/image/upload/v1/luxygalleria_products/<id>.png", "bytes": 48213, "contentType": "image/png" }
}
```

**Errors**

| HTTP | When |
|---|---|
| 400 | No file; wrong field name; extra fields; wrong type; bytes do not match the extension or content type |
| 401 | Bad signature (checked before anything is stored) |
| 413 | Larger than 15 MB |
| 502 | Cloudinary failed — retry |
| 503 | Image storage not configured on the server |

**Idempotency:** each successful call stores a new image. Retrying after a timeout may leave an unused copy, which is harmless.

```bash
P=/api/v1/erp/images
sign POST "$P" ./rose.png
curl -sS -X POST "$BASE$P" -H "X-ERP-Key-Id: $KEY_ID" -H "X-ERP-Timestamp: $TS" -H "X-ERP-Signature: $SIG" \
  -F "image=@./rose.png;type=image/png"
```

**Source:** `erpController.ts` → `readImage`, `uploadImage`, `imageStore`. **Tests:** "Image upload" section.

---

## 10. Website → ERP order push

❌ **Not implemented — waiting for the ERP sales-order API** 🟦

**Today:** the ERP can pull orders with Sections 6–7.

**Planned automatic push** (not to be reported complete until a real sandbox test succeeds):

- **Trigger:** right after the website saves a paid order (`paymentController.ts` → `verifyPayment`, at `newOrder.save()`), handled by a background worker so checkout never waits on the ERP.
- **Delivery:** our website `orderId` is sent as your external reference, so a retried push can't create a duplicate order. Retries use backoff.
- **Tracking:** the ERP order id is stored on the order. Sync status, attempts and last error are tracked and visible to admins.

**Not built yet, deliberately.** There is no ERP URL, payload, credentials or sync-status fields. They depend on your API. Orders created before the push goes live can be found later through Section 6.

**Needed from you:**
- sales-order create endpoint and payload schema
- sample response with your order id
- how duplicates of our reference are handled
- authentication method
- sandbox URL and credentials
- rate limits and error codes

---

## 11. Deployment, configuration and verification (Luxy Galleria)

**Environment variable (Hostinger production environment)** — names only; never share values in documents or chat.

| Name | Value format |
|---|---|
| `ERP_API_KEYS` | `keyId:secret` pairs, comma-separated, e.g. `erp-prod-1:<64 hex chars>`. Generate with `openssl rand -hex 32`. Use a different key for sandbox/staging. During a rotation, list old and new keys, then remove the old one. |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | Already used by admin uploads; required for Section 9 |

**Exact key parser behavior**

- The application splits `ERP_API_KEYS` on literal commas. Each entry uses its first colon as the key-ID/secret separator; colons after that are part of the secret. Commas cannot be part of a key ID or secret.
- Leading/trailing whitespace around each entry, key ID, and secret is trimmed. IDs are matched case-sensitively. Secrets shorter than 32 characters are ignored.
- Use a generated hex secret (`openssl rand -hex 32`) to avoid dotenv/shell special-character and quoting surprises. Quoting a dotenv value does not make commas safe: the parser still splits on commas after dotenv loads it.
- After building the current source with `npm run build`, run `npm run diagnose:erp-keys` from `/opt/luxygalleria-migration/backend` to print only parsed key IDs and a validity boolean. Example shape: `{"valid":true,"keyIds":["erp-prod-1"]}`. Invalid configuration exits nonzero. It never prints secret values or hashes. Do not add logging around `process.env.ERP_API_KEYS`.

**Secure credential exchange**

1. Luxy Galleria generates the secret.
2. It is shared with the ERP team's named technical contact through a one-time secret link or password manager — never email, chat or tickets.
3. The key id is sent separately.
4. Rotate immediately if exposure is suspected, and at least yearly.

**Safe deploy steps**

1. Run `npm run test:erp` against the dedicated local test database and `npm run build`. Do not run data seeding or SKU scripts as part of an auth deployment.
2. Review and commit the backend source, documentation, sample client, and build output required by the deployment process (`node dist/server.js` is the configured start command).
3. Deploy through the normal reviewed production release process. Do not change production environment values as part of this code change.
4. On Hostinger, privately verify the configured `ERP_API_KEYS` entry has the same key ID as the ERP client's `X-ERP-Key-Id` and a secret of at least 32 characters. The `diagnose:erp-keys` command reports accepted IDs without revealing secrets. Never print, paste, or log the variable value. If the IDs differ, coordinate a credential update/rotation with the ERP owner as a separate approved operation; keep both IDs during an agreed rotation window, then remove the retired key.
5. Use the non-destructive signed GET and JSON-validation checks above. Do not use the upload mode against production because a successful upload writes to Cloudinary.

**Production smoke test** — none of these changes data:

| Check | Expected |
|---|---|
| `GET /api/v1/health` | `200` |
| Unsigned request to each of the seven routes | `401` — proves the route is deployed and closed. `503` means `ERP_API_KEYS` is not set. `404` means the old build is still running. |
| Signed `GET /api/v1/erp/orders?limit=1` | `200` |
| Signed `GET /api/v1/erp/orders/{an id from the list}` | `200` |
| Signed `PUT /stock/SMOKE-DOES-NOT-EXIST` | `404` (lookup only) |
| Signed `POST /items` with `{}` | `400` (validation) |
| Signed `PATCH /items/SMOKE-DOES-NOT-EXIST` | `404` (lookup only) |
| Signed webhook for order id `000000000000000000000000` | `404` (no event is recorded) |
| Signed `/images` with a text file | `400` (nothing is stored) |

**Write tests in production.** Run them only on a dedicated test SKU or test order, or preferably on a staging service with its own database. The website has no "inactive product" flag yet, so a test product created in production would be visible on the storefront.

**Before stock sync goes live**

1. Run `npm run check-skus` against production. It is read-only and lists variants without SKUs and SKUs used more than once.
2. Backfill or fix those SKUs in the admin panel.
3. After the data is clean, a unique index on `variants.sku` can be added (see the `ponytail:` note in `src/models/Product.ts`).

**Known limits and follow-ups**

| Item | Status |
|---|---|
| Admin panel can still edit price and stock, which conflicts with the ERP being the source of truth | Lock those fields once the ERP sync is live |
| Replay cache is in memory | Correct for one Render instance; must be shared if the API runs on several instances |
| ERP audit log | One JSON line per ERP request (`"event":"ERP_API"`: key id, method, path, status, duration) on stdout → Render logs. No bodies or customer data. |
| Website orders exist only if the customer's browser completes `/payments/verify` after paying | A Razorpay webhook is still needed before the order push is fully reliable |
| Tax/GST/HSN, billing address, recipient name/phone, order number | Not held by the website; add only once the ERP's requirements are known |

## 12. Information still needed from the ERP team 🟦

1. Confirmation of the HMAC scheme in Section 1, or your required alternative; your outbound IP addresses.
2. SKU rules: uniqueness, case, format, whether codes can change.
3. Stock semantics: does your figure already exclude website orders (Section 3 reconciliation rule)? Units and warehouses?
4. Whether categories and brands should be auto-created from your item data.
5. Your status list and its mapping to `processing` / `shipped` / `delivered` / `cancelled`; cancellation, refund and restock ownership.
6. Sales-order API for the website → ERP push (Section 10), with a sandbox.
7. Required order fields the website does not hold today (Section 7).
8. Expected volumes (bulk stock endpoint?) and whether you need an `Idempotency-Key` header.

## 13. Source files and tests

| File | Role |
|---|---|
| `src/routes/erpRoutes.ts` | Route table, mounted at `/api/v1/erp` in `src/routes/index.ts` |
| `src/middlewares/erpAuth.ts` | HMAC verification, timestamp window, replay cache, audit log |
| `src/middlewares/rateLimiter.ts` | `erpLimiter`; the website limiter skips `/api/v1/erp/*` |
| `src/controllers/erpController.ts` | All seven handlers and validation |
| `src/models/ErpEvent.ts` | Webhook event log (unique `eventId`) |
| `src/models/Product.ts` | `variants[].stockAsOf`; index on `variants.sku` |
| `src/models/Order.ts` | `erpOrderId`, `trackingNumber`, `statusUpdatedAt`; index on `updatedAt` |
| `src/controllers/paymentController.ts` | `sendOrderStatusEmail` (shared by admin and webhook) |
| `src/app.ts` | Captures raw JSON bytes for signature checks |
| `src/scripts/checkSkus.ts` | Read-only SKU report (`npm run check-skus`) |
| `src/tests/erp.test.ts` | 29 tests (`npm run test:erp`, local MongoDB) |
| `.env.example` | Variable names, including `ERP_API_KEYS` |
