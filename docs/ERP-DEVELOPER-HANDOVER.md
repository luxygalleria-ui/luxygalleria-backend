# Luxy Galleria ERP API — Developer Handover

For the ERP development team. The full contract is in `ERP-INTEGRATION-API-SPEC.md`; section numbers below refer to it.

## What you receive

| Item | File |
|---|---|
| API specification | `docs/ERP-INTEGRATION-API-SPEC.md` |
| Postman collection (9 requests plus a *Negative checks* folder, automatic signing, tests) | `postman/Luxy-Galleria-ERP-API.postman_collection.json` |
| Postman environment templates (credentials blank) | `postman/Luxy-Galleria-ERP-Production.postman_environment.json`; `postman/Luxy-Galleria-ERP-Local-Staging.postman_environment.json` for staging tests |
| Node.js signing example | `docs/erp-signing-client.mjs` |
| Key ID and secret | Sent separately by Luxy Galleria through a one-time secret link |

## API at a glance

Base URL: `https://api.luxygalleria.com/api/v1`

| # | Function | Method and path | Direction |
|---|---|---|---|
| 1 | Stock Update | `PUT /erp/stock/{sku}` | ERP → Website |
| 2 | Item Add / Upsert | `POST /erp/items` | ERP → Website |
| 3 | Item Edit | `PATCH /erp/items/{sku}` | ERP → Website |
| 4 | Order Checking | `GET /erp/orders` | ERP reads Website |
| 5 | Order Details | `GET /erp/orders/{orderId}` | ERP reads Website |
| 6 | Order Status Callback | `POST /erp/webhooks/order-status` | ERP → Website |
| 7 | Image Upload | `POST /erp/images` (multipart, field `image`) | ERP → Website |
| 8 | Item List | `GET /erp/items` | ERP reads Website |
| 9 | Item Lookup | `GET /erp/items/{sku}` | ERP reads Website |

Not available yet:
- Website → ERP order push (the website does not send orders to you; pull them with #4 and #5).
- Customer master sync.

See Section 13.

## Authentication in one paragraph

Send three headers with every request:

- `X-ERP-Key-Id`
- `X-ERP-Timestamp`: Unix seconds, within ±300 s of server time
- `X-ERP-Signature`: lowercase hex of `HMAC-SHA256(secret, timestamp + "." + METHOD + "." + pathWithQuery + "." + sha256hex(body))`

`pathWithQuery` is the path as sent, for example `/api/v1/erp/orders?limit=10`. The body is:

- the exact JSON bytes you send, with `Content-Type: application/json`;
- empty for GET;
- the file bytes for Image Upload.

Sign every attempt, including retries, with a fresh timestamp. Check your implementation against the test vector in Section 2.3.

## First steps

1. Store the key ID and secret in your secret manager. Never put the secret in code, tickets, chat or an exported Postman environment.
2. Import both Postman files, select the **Luxy Galleria ERP - Production** environment, and enter `erpKeyId` and `erpSecret` as **Current values** (Section 11.2).
3. Run **4. Order Checking (list)**, then copy an `orderId` into the environment and run **5. Order Details**. Both are read-only. All tests should pass.
4. If you get `401 Invalid ERP credentials`, the request was unsigned or used an unknown key ID. Check the *request was signed* test and the Postman Console (Section 2.6).
5. Agree a write test plan with Luxy Galleria before running requests 1–3, 6 or 7 in production:
   - A created item appears on the storefront immediately.
   - A status change emails the customer.
   - Use only the test SKU and test order Luxy Galleria provides.

## Rules that matter most

- **Stock** is an absolute quantity with an `asOf` time. Older figures are refused (`409 STALE_UPDATE`). Website orders placed after `asOf` and units held by open website checkouts are subtracted; this formula is provisional until you confirm whether you send physical or sellable stock. Retry a `409 CONFLICT` as is (Section 4).
- **Item Add** matches on SKU. Repeating it updates the same product and never duplicates it. Stock is applied only when a variant is created. `409 UNMAPPED_PRODUCT` means the website already has that product without SKUs: ask us to set your SKU on it rather than creating it again (Section 5).
- **SKU mapping**: use Item List (Section 6A) to see website variants without a SKU, and agree their item codes with us before syncing.
- **Item Edit** changes only the fields you send; it cannot change stock or SKU (Section 6).
- **Orders**: sync incrementally with `updatedSince` and de-duplicate by `orderId`. Order lines carry the SKU and name as sold (Section 7).
- **Status callback**: send a unique `eventId` per event and retry with the same `eventId`. Transitions only move forward; `delivered` and `cancelled` are final (Section 9).
- **Images**: JPG, PNG or WEBP, up to 15 MB, one file in field `image`. In Postman, paste the file's SHA-256 into `imageSha256` (Section 11.4).
- **Retries**: retry `429`/`5xx`/timeouts with backoff; fix the request before retrying `400`/`401`/`404`/`409`, except a `409 CONFLICT` saying *retry it*, which is retried unchanged (Section 3.6).

## Current status

- Version 2.1 changes (27 October 2026: stock reservations, `UNMAPPED_PRODUCT`, order-line snapshots, Item List/Lookup documentation) pass automated tests locally and are **not yet deployed**.

- All nine endpoints pass automated tests on a local test server.
- Production routes are deployed and enforce authentication.
- Production reads of orders were reported working in an earlier test.
- Production writes and a real image upload have **not** been verified yet.

See Section 15 for the evidence.

## What we need from you

Section 14 lists it in full:

1. The sales-order create API with its payload, authentication, duplicate handling and a sandbox.
2. SKU and stock ownership rules.
3. Your order status list and transition, refund and restock rules.
4. Your retry, timeout and reconciliation expectations.
5. The customer data you need and your privacy requirements.

Contact: **NEEDS CONFIRMATION** — Luxy Galleria technical contact to be added before sending.
