# Luxy Galleria Backend — Final Audit (2026-11-22, updated after the release fixes)

Scope: `luxy-backend` working tree on `main`. Everything was done locally. Nothing was committed, pushed, deployed or merged.
- No production database, server or paid API was contacted.
- No `.env` file was changed.
- The release review read local `.env` values in memory only, to check that none appears in a file proposed for commit. No value was printed.

## 1. Issues discovered

| # | Severity | Issue | Where |
|---|---|---|---|
| A | **High** | Mock-payment mode used `ENV.NODE_ENV`, which defaults an **unset** `NODE_ENV` to `development`. A server with no `NODE_ENV` and no Razorpay keys would create mock orders, i.e. orders without a real charge. | `controllers/paymentController.ts` |
| B | **High** | Same default in the error handler: with `NODE_ENV` unset, 500s returned the raw message and **stack trace**. | `middlewares/errorHandler.ts` |
| C | Medium | Production 500s echoed internal database or driver messages. Five handlers did this directly, and the settings loader put the driver text into an admin error. | `errorHandler.ts`, `paymentController.ts` ×4, `authController.ts`, `utils/checkoutSettings.ts` |
| D | Medium | 500 logs and `error-trace.log` held raw error objects (which can include request headers) and full URLs with query strings. | `errorHandler.ts` |
| E | Medium | Without SendGrid, every email body (including OTPs) and the full address was logged in every environment. | `utils/sendEmail.ts` |
| F | Medium | The session cookie was `Secure` only when `NODE_ENV` was exactly `production`. Unset, `staging`, `Production` or a typo sent it without `Secure`. | `authController.ts` (5 `res.cookie` calls) |
| G | Medium | Admin form validation failures (category, brand, coupon, banner, product) and malformed ids went to the global handler as **500s**. Before C was fixed, the raw driver text was shown to admins. After it, they saw only "Internal Server Error". | `errorHandler.ts`; the five controllers have no `try/catch` |
| H | Low | The 404 body echoed the full URL, including the query. | `middlewares/notFoundHandler.ts` |
| I | Low | OTPs used `Math.random()`. | `authController.ts` |
| J | Low | `seedAdmin` accepted any `ADMIN_PASSWORD` length for a production superadmin. | `utils/seedAdmin.ts` |
| K | Build | `tsc` compiled `src/tests` into `dist/tests`; 34 tracked test artifacts ship with the build. | `tsconfig.json`, `dist/tests` |
| L | Tests | `npm test` ran one suite, and nothing stopped a suite reaching real services. `collectionFilters` needed a running API. | `package.json`, `collectionFilters.test.ts` |
| M | Tests | `collectionFilters` asserted that the main shop excludes New Arrivals, but the controller deliberately includes them. | `collectionFilters.test.ts` |

Reviewed and sound:
- JWT secret rule;
- ICICI hash verification, the UAT tester gate and the development gateway guard;
- Razorpay HMAC and webhook signature checks;
- Google sign-in verification;
- CORS exact-origin list;
- Helmet/HSTS headers;
- rate limiters;
- upload filter;
- input sanitisers;
- admin role checks;
- the removed debug/setup routes;
- the production-DB guard, which refuses to start on database `luxy` when `NODE_ENV` is unset.

## 2. Issues fixed

- **A, B:** both use the raw `process.env.NODE_ENV === 'development'`.
- **C, D** (error handler):
  - 4xx keeps its message;
  - unexpected 5xx returns `Internal Server Error` except in exact `development`;
  - stack only in exact `development`;
  - logs and the trace file hold method + path (no query), error name/code and stack;
  - `user:pass@` in URLs is redacted;
  - the five handlers return fixed messages;
  - the settings loader logs the driver text server-side only.
- **E:** outside exact `development`, the log shows only subject + masked address (`c***@domain`). SendGrid logs mask the recipient too.
- **F:** `secureCookies()` returns `NODE_ENV !== 'development'`. Production and HTTPS staging always get `Secure`. Unset or invalid values fail safe to `Secure`. Local `development` over http keeps working.
- **G:** the error handler classifies Mongoose input errors before anything else:
  - `ValidationError` → **400** `Validation failed: <field> is required; <field> is invalid; …`. Our own per-rule wording covers required, min/max, min/max length, enum and invalid type, and never echoes the submitted value, model name or "Cast to …" text.
  - `CastError` (e.g. a malformed id) → **400** `Invalid <path>`.
  - Duplicate keys and all other errors are unchanged.

  This is one change in the shared handler, so it covers all five controllers and every other route that reaches it (e.g. registration).
- **H:** 404 → `Route not found`.
- **I:** `crypto.randomInt`.
- **J:** outside exact `development`, the seed is skipped when `ADMIN_PASSWORD` has fewer than 12 characters.
- **K:**
  - `tsconfig.build.json` excludes `src/tests/**`; `npm run build` uses it;
  - `tsconfig.json` still includes tests, so `npm run typecheck` checks them;
  - the build writes no `dist/tests`.
  - Removal of the tracked files is **prepared, not done** (§10).
- **L:** `npm test` → `scripts/run-tests.js`:
  - each suite runs in its own process with a timeout and a summary, and the run exits 1 on any failure;
  - local-only `MONGO_URI`;
  - provider credentials blanked (dotenv never overrides a set variable);
  - `scripts/test-network-guard.js` preloaded, which refuses any socket to a host that is not this machine.

  `collectionFilters` now seeds and drops its own test database.
- **M:** the test was aligned with the controller. Business logic is unchanged.

## 3. Files changed

Source:
- `src/middlewares/errorHandler.ts`
- `src/middlewares/notFoundHandler.ts`
- `src/controllers/authController.ts`
- `src/controllers/paymentController.ts`
- `src/utils/checkoutSettings.ts`
- `src/utils/sendEmail.ts`
- `src/utils/seedAdmin.ts`

From earlier rounds:
- `src/app.ts`
- `src/config/env.ts`
- `src/controllers/iciciController.ts`
- `src/routes/authRoutes.ts`
- `src/utils/iciciPg.ts`

Build, config and tooling:
- `package.json`
- `tsconfig.build.json` (new)
- `.env.example` (placeholders only)
- `scripts/run-tests.js`, `scripts/test-network-guard.js`, `scripts/icici-diagnose.js`, `scripts/icici-local-mock.js` (all new)

Tests:
- new: `adminValidation`, `errorHandling`, `addresses`, `authRoutes`, `iciciMock`, `jwtSecret`, `pickupSettings`;
- updated: `collectionFilters`, `icici`, `security`.

Generated: `dist/` non-test files, rebuilt with the production config.

## 4. Tests executed

`npm test`: **24 suites** (the original 22, plus `errorHandling` and `adminValidation`), on local MongoDB `*_test` databases. `historyDashboard` starts its own temporary `mongod`.

New regression coverage:
- **`adminValidation`** (7 tests, run with `NODE_ENV=production`):
  - category, brand, coupon, banner and product validation failures → 400 with field messages;
  - malformed ids → 400;
  - no driver text or echoed values;
  - valid saves still 201;
  - duplicate-key errors stay 500.
- **`authRoutes`:** cookie `Secure` checked on customer and admin login for `development` (off) and `production`, unset, `staging`, `Production` and `prod` (on).
- **`errorHandling`** (12 tests):
  - sanitised 500s and logs;
  - 404;
  - malformed JSON → 400;
  - email masking;
  - mock payments;
  - build config.

## 5. Results

**24 suites: 24 passed, 0 failed, 0 skipped.** Exit 0.
- Zero outbound connections were attempted.
- The release review independently confirmed that each suite reaches its own final success line.

## 6. Build result

- `npm run typecheck` and `npm run build`: clean.
- The production build has 86 `.js` files, all byte-identical to `dist/`.
- There is no `tests` output, and `dist/tests` was untouched by the build.
- `dist/server.js` and the 9 `dist/scripts/*.js` are present.
- `git diff --check`: clean.

## 7. Security improvements

- A missing or invalid `NODE_ENV` now fails safe everywhere that matters: no mock payments, no stack traces, `Secure` cookies, gated ICICI UAT, the JWT secret is required, and the production-DB guard refuses to start.
- No internal database or provider text reaches clients.
- Logs and trace files hold no query strings, raw error objects, credentials, OTPs, email bodies or full addresses.
- OTPs come from a CSPRNG.
- A weak password can't seed a superadmin.
- Tests can't reach external services.

## 8. Remaining risks

1. `dist/tests`: 34 tracked files are stale or obsolete. Removal is prepared but needs your approval (§10).
2. Hostinger must set `NODE_ENV=production` and build with `npm run build`. With an unset value the server is safe but refuses to start on database `luxy`.
3. HTTPS staging is assumed. A staging site on plain http would no longer receive the session cookie; the Bearer token in the login response still works.
4. Duplicate-key errors (e.g. a unique email at the database level) still return a generic 500. Registration checks for an existing email first.
5. Registration has no server-side password-strength rule.
6. `/auth/resend-otp` reveals whether an account exists (rate-limited to 3 per hour).
7. `GET /products` writes to the database on every call (an existing clean-up).
8. Running a suite directly with `npx ts-node` skips the network guard and loads `.env`. Use `npm test`.
9. Development email logging still prints OTPs (local only).
10. The ERP key on `.env` line 72 is pending its fingerprint check and rotation.
11. The ICICI inbound rate limit (P2) is design only.

## 9. Deployment readiness

Ready for review and commit. Before deploying to Hostinger:
- approve §10;
- set `NODE_ENV=production`;
- build with `npm run build` and start with `npm start`;
- set `JWT_SECRET`;
- set `ICICI_PG_UAT_TEST_USER_IDS` and remove `ICICI_PG_UAT_TEST_EMAILS`;
- get the ICICI UAT confirmations;
- do an atomic release with a backup.

Client-visible changes:
- validation failures and malformed ids are now 400s with field messages instead of 500s;
- unexpected 500s carry a generic message;
- the 404 text is fixed;
- malformed JSON returns 400.

The admin and storefront display `data.message` either way, and neither parses message text.

## 10. Prepared removal of tracked `dist/tests` (not executed)

Nothing references `dist/tests`: no `package.json` script, no runtime import, no other script.

Tracked (34): `adminData`, `cart`, `cartTotals`, `checkout`, `cloudinaryMigration`, `collectionFilters`, `collections`, `dashboard`, `dbUri`, `erp`, `historyDashboard`, `icici`, `paymentLifecycle`, `products`, `security`, `shipping`, `skuAudit`. Each is `dist/tests/<name>.test.js` plus its `.js.map`.
- Stale against the current sources: `collectionFilters` and `security`. `icici` is stale at HEAD and current on disk (modified locally).
- The other 14 are current but obsolete: the build no longer produces them.

Untracked locally (10, never committed): `addresses`, `authRoutes` (stale), `iciciMock`, `jwtSecret`, `pickupSettings`, each with its `.map`.

Proposed command, to run only with your approval:

```
git rm -r -q dist/tests            # stages deletion of the 34 tracked files and removes them locally
rm -f dist/tests/*.test.js dist/tests/*.test.js.map   # the 10 untracked leftovers
```

Effect:
- the next `git pull` on any server deletes `dist/tests/` there;
- `dist/server.js`, `dist/app.js`, `dist/scripts/*` and every runtime file are untouched;
- `npm start` and `npm run build` are unaffected;
- tests keep running from `src/tests` via `npm test`.

To keep the local files and only untrack them, use `git rm -r --cached dist/tests` instead.
