# Operator runbook (Luxy Galleria internal)

Not for the ERP team. Procedures for authorised operators. Nothing here is automated, and no step prints a secret.

## 1. Order status corrections (superadmin only)

Normal status changes, by admins and by the ERP callback, only move forward: processing → shipped → delivered, and cancel until delivered. Delivered and cancelled are final.

To undo a mistake, for example an order marked delivered while it is still with the courier:

1. Sign in to the admin as a **superadmin**, open the order, and use **Correct status (superadmin)**.
2. Choose the corrected status and give a reason (5–300 characters).

What the server does (`POST /api/v1/payments/admin/orders/:id/status-correction`, superadmin role enforced by the backend):

- It accepts only moves the normal rule refuses. A normal move returns `400 NOT_A_CORRECTION`; use the status dropdown instead.
- It applies only if the order is still in the status you saw. Otherwise it returns `409 CONFLICT`; reload and check first.
- It writes the new status, `statusUpdatedAt`, and an audit entry in `Order.statusCorrections` (time, superadmin user id, from, to, reason) in **one atomic update**.
- It sends no email and makes no refund, restock or payment change. Do those separately if needed.
- ERP status events older than the correction are recorded as `stale`. Later ones follow the normal rules from the corrected status.

**Limitation:** the audit trail is stored on the order. Deleting an order (admin → Orders → delete) deletes its corrections too. Do not delete corrected orders.

## 2. SKU audit and owner-approved corrections

**Audit** (read-only, against a copy, never production directly; see `LOCAL-DEVELOPMENT-DATA.md` for making a sanitized catalogue copy):

```bash
MONGO_URI='mongodb://127.0.0.1:27017/<local copy>' npm run check-skus              # summary
MONGO_URI='mongodb://127.0.0.1:27017/<local copy>' npm run check-skus -- --csv > sku-audit-$(date +%Y%m%d).csv
```

- `MONGO_URI` must be set explicitly; otherwise the database named in `.env` is read.
- Issues reported: `missing` (absent, empty or spaces only), `spaces` (stored with surrounding spaces; the ERP cannot find these), and `duplicate` (same SKU on several variants; compared trimmed, case-sensitive).
- `storedSkuJson` shows the exact stored value in quotes.
- Exit code is 1 while any issue remains.

**Missing SKUs:** the ERP team fills `approvedNewSku`, the owner signs `approvedBy` / `approvedOn`, and an admin enters each code in Admin → Products → Edit → *SKU / Item Code*. The field locks once saved.

**Surrounding spaces / wrong locked SKUs.** The admin cannot change a saved SKU, by design. With the owner's written approval of the CSV row:

1. Back up the products collection:
   `mongodump --uri "$URI" --collection products --gzip --archive=products-before-sku-fix-<date>.archive.gz`
2. Change exactly one variant. The update only applies if the stored value is still the audited one:
   ```js
   db.products.updateOne(
     { _id: ObjectId('<productId>'), variants: { $elemMatch: { _id: ObjectId('<variantId>'), sku: '<exact old value from storedSkuJson>' } } },
     { $set: { 'variants.$.sku': '<approvedNewSku>' } })   // expect matchedCount 1, modifiedCount 1
   ```
   Stock, prices, ids and order history are untouched. Old orders keep the SKU they were sold with.
3. Keep the signed CSV, the backup and the command output together as the change record. Re-run `check-skus`.

Do not change case (`abc` → `ABC`) or create the database unique index until the owner and ERP team approve; the index needs 0 issues first.

## 3. Unused Razorpay orders (monitoring, read-only)

A Razorpay order is created whenever a customer reaches payment. Unused ones are expected:

- **Abandoned:** the customer closed the payment window. The session expires after `CHECKOUT_SESSION_TTL_MINUTES` (default 30).
- **Out of stock:** since Phase 1, the Razorpay order is created first. If the stock is then gone, the session is closed at once with an `out-of-stock` event, and the customer never sees the payment window.

Count them by type from a database **copy** or a read-only user (prints no customer data):

```js
// mongosh "<read-only URI>" unused-orders.js
const since = new Date(Date.now() - 7 * 86400000);
db.checkoutsessions.aggregate([
  { $match: { isMock: false, createdAt: { $gte: since }, order: { $exists: false } } },
  { $project: { status: 1, outOfStock: { $in: ['out-of-stock', { $ifNull: ['$events.type', []] }] } } },
  { $group: { _id: { status: '$status', outOfStock: '$outOfStock' }, sessions: { $sum: 1 } } },
]).forEach((r) => print(JSON.stringify(r)));
print('processing > 10 min:', db.checkoutsessions.countDocuments({ isMock: false, status: 'processing', updatedAt: { $lt: new Date(Date.now() - 600000) } }));
```

| Result | Meaning |
|---|---|
| `expired`, `outOfStock: false` | Abandoned checkout. Expected. |
| `expired`, `outOfStock: true` | Stock ran out at payment. Expected; a high count means stock figures are wrong. |
| `pending` | A checkout still open (under the TTL). Expected. |
| `processing` older than 10 min | **Investigate:** a payment confirmation stopped half-way. |

Whether **money was taken** for an order with no Luxy order cannot be seen in the database. A superadmin uses Admin reconcile (`POST /api/v1/payments/admin/reconcile`). It asks Razorpay about open sessions from the last 7 days, creates the order for a valid payment, and lists `mismatchedPayments` for manual refund. It never cancels Razorpay orders. Unpaid Razorpay orders simply lapse; there is nothing to cancel.

## 4. Credentials: verify and rotate (operator only)

**Names only** (backend): `ERP_API_KEYS`, `MONGO_URI`, `JWT_SECRET`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, `SENDGRID_API_KEY`. The admin Vercel `ERP_KEY_ID`, `ERP_SECRET` and `ERP_API_BASE_URL` are unused since the workbench was removed.

**Is a value active?** Compare fingerprints, never values. On each machine holding a candidate:

```bash
read -rs V && printf %s "$V" | shasum -a 256 | cut -c1-12; unset V
```

Do this for the commented line in a developer `luxy-backend/.env`, that file's `ERP_API_KEYS` secret, the production `ERP_API_KEYS` secret(s) on the server, the admin Vercel `ERP_SECRET`, and the copy issued to the ERP team. Matching fingerprints mean the same secret. On a server, `npm run diagnose:erp-keys` prints only `{ valid, keyIds }`.

**Rotation checklist** (only if a production secret is found outside the production server):

- [ ] Generate a new secret on the server without printing it: `openssl rand -hex 32` into the secret store or `.env`.
- [ ] Set `ERP_API_KEYS=erp-prod-2:<new>,erp-prod-1:<old>`, restart the backend under pm2, and check with `diagnose:erp-keys`.
- [ ] Send `erp-prod-2` and its secret to the ERP team's named contact through a one-time link; the key id goes separately.
- [ ] Confirm a signed read (`GET /erp/orders?limit=1`) works with the new key.
- [ ] Remove `erp-prod-1`, restart, and confirm the old key gets `401`.
- [ ] Delete the stray line and any production secret from developer `.env` files; delete the unused admin Vercel `ERP_*` variables.
- [ ] Record date, operator and key ids (never secrets).

The Razorpay webhook secret is checked the same way: Razorpay Dashboard → Webhooks (URL `…/api/v1/payments/webhook`, events `payment.captured`, `order.paid`, `payment.authorized`) against the server `.env` fingerprint.

## 5. Staging prerequisites (not provisioned; needs separate approval)

- A staging backend and database restored from a **sanitized** catalogue copy (no users, orders, carts or contacts).
- A **staging-only** ERP key (`erp-staging-1`), never used in production. Postman uses `postman/Luxy-Galleria-ERP-Local-Staging.postman_environment.json`, with secrets entered as Current values only.
- Email disabled: `SENDGRID_API_KEY` empty.
- Razorpay **test** keys and a **test** webhook secret.
- An explicitly permitted **test** Cloudinary target, not `luxygalleria-staging`, unless the owner approves.
- Staging URLs in the backend `CORS_ORIGIN` and in the staging admin/storefront `NEXT_PUBLIC_API_URL`.
