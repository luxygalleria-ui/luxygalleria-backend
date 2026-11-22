# P2 proposal: rate limiting for ICICI inbound routes

Status: **design only, not implemented.** Needs approval before any code change.

## Problem

ICICI calls three unauthenticated routes:

| Route | Caller | Notes |
|---|---|---|
| `POST/GET /api/v1/payments/icici/callback` | the customer's browser (form post / redirect from ICICI's page) | always answers with a 302 redirect |
| `POST /api/v1/payments/icici/payment-advice` | ICICI's servers | a non-200 reply makes ICICI retry |
| `POST /api/v1/payments/icici/settlement-advice` | ICICI's servers | same |

Today, in production, these routes share the general `apiLimiter`: **100 requests per 15 minutes per IP**. ICICI's advices come from a few ICICI server IPs, so a busy period could reach 100 and get a 429. The advice would then arrive late (only after ICICI retries). The callback is per customer IP, so it's low risk there, but a customer whose IP hits the limit sees a raw 429 page instead of their order status.

**Goal:** stop genuine ICICI traffic from being throttled, while keeping limits that cap floods and hash-guessing.

## Current middleware order (`src/app.ts`)

1. `helmet`
2. CORS. The three inbound routes already **bypass** CORS (`iciciInbound` regex).
3. `express.json` and `express.urlencoded` (1 MB each; they keep `rawBody` for the hash check)
4. `sanitizeInput` (mongo-sanitize) and `sanitizeStrings`. The hash uses `rawBody`, so these don't affect it.
5. `apiLimiter` on `/api/` (production only; ERP routes already skip it)
6. `morgan`. Query strings on ICICI routes are redacted (C3).
7. Routes. The controller parses `rawBody`, then runs `verifyV1` (constant-time HMAC) and the merchantId check. Only after that does it touch the database.

## Proposed order (inbound ICICI routes only)

```
helmet
CORS bypass                                  (unchanged)
iciciBodyParser   json+urlencoded, 32 KB, rawBody   NEW: mounted before the global parsers for these paths;
                                                    the global ones then skip (body already parsed)
sanitizers                                   (unchanged; hash uses rawBody)
apiLimiter        SKIPS these three paths    CHANGED (same mechanism as the ERP skip)
iciciFloodLimiter per IP, counts every request      NEW (tier 1)
iciciRejectLimiter per IP, counts only REJECTED     NEW (tier 2)
morgan                                       (unchanged)
controller        shape check -> verifyV1 -> merchantId -> DB   (shape check NEW, verification unchanged)
```

## Signature verification (unchanged, with one cheap addition)

- `verifyV1` stays as it is: HMAC-SHA256 over the raw parameters, a constant-time compare, and the merchantId check. **Nothing is weakened.**
- **New shape check before HMAC:** `merchantTxnNo` must match `^[A-Za-z0-9]{1,20}$` and `secureHash` must match `^[0-9a-f]{64}$` (any case). Anything else is rejected straight away: no HMAC, no DB work.
- When a request is rejected, the controller sets `res.locals.iciciRejected = true`. Tier 2 counts only those requests. The log line records the IP and the reason, never the parameters.

## Rate-limit strategy

| Tier | Key | Advice routes | Callback route | Counts |
|---|---|---|---|---|
| 1: flood | client IP | 300 per minute | 30 per minute | every request |
| 2: bad signatures | client IP | 20 per 15 minutes | 10 per 15 minutes | only rejected requests (`requestWasSuccessful: (req, res) => !res.locals.iciciRejected`) |
| 3: replay (optional) | `merchantTxnNo` | 30 per 10 minutes | 30 per 10 minutes | every request |

- Tier 1 is far above any realistic ICICI volume for this shop, but still caps a flood. These numbers are starting points; tune them from `logs/combined.log` (the diagnostic script counts ICICI requests by status).
- Genuine ICICI traffic always carries a valid hash, so **it never trips tier 2**. An attacker guessing hashes is blocked after a handful of tries.
- Replays of a valid signed payload are already harmless: `finalizeSession` is idempotent and orders are unique per `merchantTxnNo`. Tier 3 only limits the DB load they cause.

**When a limit is hit:**
- **Advice routes:** answer 429 with `Retry-After`. ICICI retries non-200 replies (assumed; confirm with ICICI), and the admin reconcile path (STATUS command) recovers anything still missing.
- **Callback route:** never a raw 429. Redirect to `/order-failure?reason=unconfirmed`, which never invites a second payment. The order is still created by the payment advice or reconcile.

## Other abuse protection

- **Body size:** 32 KB for these routes instead of 1 MB. An ICICI payload is a few hundred bytes.
- **Content types:** accept only `application/x-www-form-urlencoded` and `application/json` on POST. Anything else gets 415 (callback: the `unconfirmed` redirect).
- **Optional source-IP allow-list for advices only:** `ICICI_PG_ADVICE_IPS`, used only if ICICI supplies its server IPs. If unset, the routes stay open and protected by the hash plus the limiters. It must never apply to the callback, which comes from customers' browsers.
- **Correct client IP:** the limiters key on `req.ip`, and `trust proxy` is `1`. That is only right if there is exactly one proxy (nginx) in front of the app. With Cloudflare in front of nginx it would be 2, otherwise every request looks like the proxy's IP. **Verify this on the VPS before enabling the limiters.**
- **Store:** express-rate-limit's in-memory store counts per process. That is fine for one PM2 fork process. In PM2 cluster mode the effective limit multiplies by the number of instances: either accept that or add a shared store. No new dependency unless the app runs in cluster mode.

## Tests to add with the implementation

- 101 valid advices from one IP in 15 minutes: all return 200 (no longer throttled by `apiLimiter`).
- 11 bad-hash callbacks from one IP: the 11th redirects to `unconfirmed`. A valid callback from another IP still succeeds.
- 21 bad-hash advices: 429. A valid advice from that IP afterwards: also 429. This is the deliberate cost of tier 2 (an ICICI IP is never in this state).
- A 40 KB body: refused before verification, and no DB query.
- Malformed `secureHash` or `merchantTxnNo`: rejected without calling HMAC (spy on `verifyV1`).
- The flood tier redirects the callback and returns 429 on advices, with `Retry-After`.
- Run in production mode with a distinct `X-Forwarded-For` per case (as in the P1 gate test).

## Open questions for ICICI or ops

1. Does ICICI retry advices after a non-200 reply? How often, and for how long?
2. Can ICICI give us the source IPs for its advices (UAT and live)?
3. VPS: how many proxies sit in front of the app (sets `trust proxy`), and does PM2 run in fork or cluster mode?
