import { Request, Response } from 'express';
import Order from '../models/Order';
import { Cart } from '../models/Cart';
import { User } from '../models/User';
import { CheckoutSession } from '../models/CheckoutSession';
import { finalizeSession, releaseStock } from '../utils/checkoutSessions';
import { gatewayFailure, icici, iciciConfigured, iciciLive, isIciciSuccess, saleTxnDate, newTxnNo, postForm, postJson, signed, verifyV1 } from '../utils/iciciPg';
import { openSession, priceCheckout, sendOrderConfirmationEmail } from './paymentController';

/**
 * ICICI Orange PG, standard redirection (payType 0). Uses the same quote snapshot, stock reservation and
 * finalizeSession as Razorpay: an order is created exactly once, only after ICICI confirms the payment with a valid
 * secureHash, for this merchant and the session's exact amount.
 */

const frontend = () => (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');

/**
 * The parameters exactly as ICICI sent them, whatever fields the payment mode returns. req.body has been rewritten by
 * the sanitizers (app.ts), which would break the hash, so the raw body is parsed again here. Form-urlencoded by
 * default; JSON if opted for at onboarding (numbers keep their sent text, e.g. 2.00, as the hash covers it). A result
 * carried on the URL instead (query string / GET redirect) is used only when the body has none: never merged.
 */
const gatewayParams = (req: Request): Record<string, any> => {
  const raw = (req as any).rawBody?.toString('utf8') ?? '';
  let body: Record<string, any> = {};
  if (req.is('application/json')) {
    try {
      const parsed = (JSON.parse as any)(raw || '{}', (_k: string, v: unknown, ctx?: { source?: string }) => (typeof v === 'number' ? ctx?.source ?? String(v) : v));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed;
    } catch { /* unparseable: rejected below as no merchantTxnNo */ }
  } else {
    body = Object.fromEntries(new URLSearchParams(raw));
  }
  if (body.merchantTxnNo) return body;
  const query = Object.fromEntries(new URL(req.originalUrl, 'http://local').searchParams);
  return query.merchantTxnNo ? query : body;
};

/** Returns an unpaid session's stock now instead of waiting for it to expire (a late success re-reserves it). */
const releaseSession = async (sessionId: unknown, detail: string) => {
  const before = await CheckoutSession.findOneAndUpdate(
    { _id: sessionId, status: 'pending' },
    { $set: { status: 'expired', stockReserved: false }, $push: { events: { at: new Date(), type: 'icici-released', detail: detail.slice(0, 200) } } },
    { new: false },
  );
  if (before?.stockReserved) await releaseStock(before.items);
};

const amountMatches = (amount: unknown, paise: number) =>
  amount === undefined || amount === null || amount === '' || Math.round(Number(amount) * 100) === paise;

type Outcome = 'created' | 'existing' | 'unfulfillable' | 'processing' | 'pending' | 'failed' | 'mismatch' | 'unknown';

/** Applies a verified payment result (return URL, payment advice or status check) to its checkout session. */
const applyResult = async (
  merchantTxnNo: string, success: boolean, pending: boolean, txnID: string, amount: unknown, detail: string,
  source: 'icici-callback' | 'icici-advice' | 'icici-status',
): Promise<Outcome> => {
  const session = await CheckoutSession.findOne({ razorpayOrderId: merchantTxnNo, gateway: 'icici' });
  if (!session) {
    console.warn(`ICICI ${source}: no checkout session for merchantTxnNo ${merchantTxnNo}`);
    return 'unknown';
  }
  if (pending) return 'pending';
  if (!success) {
    await releaseSession(session._id, `${source}: ${detail}`);
    return 'failed';
  }
  if (!amountMatches(amount, session.amountPaise)) {
    // Never turned into an order; money taken for the wrong amount is refunded manually
    console.error(`ICICI ${source}: ${merchantTxnNo} paid ${amount}, expected ${session.amountPaise / 100}. Refund manually.`);
    await CheckoutSession.updateOne({ _id: session._id }, { $push: { events: { at: new Date(), type: 'amount-mismatch', detail: `paid ${amount}` } } });
    return 'mismatch';
  }
  const { order, outcome } = await finalizeSession(session._id, txnID || merchantTxnNo, '', source);
  // Paid: the cart is spent. A paid-but-sold-out order clears it only on the browser's own return, never from a
  // later advice/status replay that could wipe items added since.
  if (order && (outcome === 'created' || (outcome === 'unfulfillable' && source === 'icici-callback'))) {
    await Cart.updateOne({ user: order.user }, { $set: { items: [] } });
  }
  if (outcome === 'created' && order) {
    const user = await User.findById(order.user, { name: 1, email: 1, role: 1 }).lean();
    await order.populate('items.product', 'name images variants');
    if (user) await sendOrderConfirmationEmail(order, user as any);
  }
  return outcome;
};

/** Return URL / payment advice body -> outcome. Null when the secureHash or merchant does not check out. */
const handleGatewayPost = async (p: Record<string, any>, source: 'icici-callback' | 'icici-advice'): Promise<Outcome | null> => {
  const why = !p.merchantTxnNo ? 'no merchantTxnNo' : !verifyV1(p) ? 'secureHash mismatch'
    : String(p.merchantId) !== icici().merchantId ? `unexpected merchantId ${p.merchantId}` : '';
  if (why) {
    console.error(`ICICI ${source} REJECTED (${why}) merchantTxnNo=${p.merchantTxnNo} responseCode=${p.responseCode} keys=${Object.keys(p).sort().join(',')}`);
    return null;
  }
  // Every verified field is kept on the session (mode-specific ones such as paymentMode, UPI / bank references)
  const { secureHash: _hash, ...fields } = p;
  await CheckoutSession.updateOne({ razorpayOrderId: String(p.merchantTxnNo), gateway: 'icici' },
    { $push: { events: { at: new Date(), type: `${source}-params`, detail: JSON.stringify(fields).slice(0, 4000) } } });
  const code = String(p.responseCode ?? p.respCode ?? '');
  return applyResult(String(p.merchantTxnNo), isIciciSuccess(code), code === 'R1000', String(p.txnID ?? ''), p.amount,
    `${code} ${p.respDescription ?? ''}`, source);
};

/**
 * UAT testers: comma-separated user _ids (24 hex). Empty -> nobody. Any malformed entry -> null (the whole list is
 * refused, so a typo blocks everyone instead of half-working).
 */
const uatTesterIds = (): Set<string> | null => {
  const ids = (process.env.ICICI_PG_UAT_TEST_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return ids.every((id) => /^[a-f\d]{24}$/i.test(id)) ? new Set(ids.map((id) => id.toLowerCase())) : null;
};

/**
 * ICICI's payment page for this sale (redirectURI + tranCtx), or '' when redirectURI is not a parseable https URL or
 * tranCtx is missing: the customer is never sent to a malformed or plain-http page. URL keeps any query redirectURI has.
 */
export const paymentPageUrl = (resp: any) => {
  try {
    const u = new URL(String(resp?.redirectURI ?? ''));
    if (u.protocol !== 'https:' || !resp?.tranCtx) return '';
    u.searchParams.set('tranCtx', String(resp.tranCtx));
    return u.toString();
  } catch {
    return '';
  }
};

// POST /payments/icici/initiate (customer): quote, reserve stock, initiateSale, return the gateway URL to redirect to
export const iciciInitiate = async (req: Request, res: Response) => {
  try {
    if (!iciciConfigured()) return res.status(503).json({ success: false, message: 'ICICI payments are not available' });
    // Test (UAT / mixed / unknown) gateway config on any server except NODE_ENV exactly "development": test-card
    // "payments" must never become real customer orders, so only the accounts whose _id is listed in
    // ICICI_PG_UAT_TEST_USER_IDS may pay. Fail-safe: NODE_ENV unset, "staging", "Production" etc. are all gated.
    // By _id, never email: registration does not prove email ownership and emails are stored case-sensitively, so
    // anyone could register a tester's address (or a case variant of it). req.user comes from the signed token's id.
    if (!iciciLive() && process.env.NODE_ENV !== 'development') {
      const testers = uatTesterIds();
      if (!testers?.has(String(req.user!._id))) {
        if (!testers) console.error('ICICI UAT gate: ICICI_PG_UAT_TEST_USER_IDS has a malformed entry (each must be a 24-hex user _id): every customer is blocked');
        if (process.env.ICICI_PG_UAT_TEST_EMAILS) console.warn('ICICI UAT gate: ICICI_PG_UAT_TEST_EMAILS is no longer used; list tester user _ids in ICICI_PG_UAT_TEST_USER_IDS');
        return res.status(403).json({ success: false, message: 'Online payment is being set up and is not available yet. Please try again later.' });
      }
    }
    // Back from ICICI's page without paying and trying again: release this customer's earlier unpaid holds first, so
    // the last unit is not blocked by their own reservation. If an earlier one is paid after all, it re-reserves.
    const earlier = await CheckoutSession.find({ user: req.user!._id, gateway: 'icici', status: 'pending' }, { _id: 1 }).lean();
    for (const e of earlier) await releaseSession(e._id, 'superseded by a new ICICI checkout');
    const priced = await priceCheckout(req, res);
    if (!priced) return;

    const c = icici();
    const merchantTxnNo = newTxnNo();
    const session = await openSession(req, res, priced, merchantTxnNo, 'icici');
    if (!session) return;

    const user = req.user!;
    const mobile = String((user as any).phone ?? '').replace(/\D/g, '').slice(-10);
    const request = signed({
      merchantId: c.merchantId,
      aggregatorID: c.aggregatorID,
      merchantTxnNo,
      amount: (session.amountPaise / 100).toFixed(2),
      currencyCode: c.currencyCode,
      payType: '0',
      customerEmailID: user.email,
      customerMobileNo: mobile.length === 10 ? mobile : undefined,
      transactionType: 'SALE',
      txnDate: saleTxnDate(),
      returnURL: c.returnURL,
    });

    let resp: any;
    try {
      resp = await postJson(c.initiateSaleUrl, request);
    } catch (err: any) {
      const failure = gatewayFailure(err, c.initiateSaleUrl);
      await releaseSession(session._id, `initiateSale error: ${failure}`);
      // No reply at all (seen when ICICI's firewall drops callers whose IP it has not allow-listed): say what to check
      const hint = err?.name === 'TimeoutError' ? ' (no response in 20 s: check that this server\'s public IP is allow-listed with ICICI for this environment)'
        : /ECONNREFUSED/.test(failure) ? ' (connection refused: is the configured gateway, or the local mock, running at this address?)' : '';
      console.error(`ICICI initiateSale ${merchantTxnNo} failed: ${failure}${hint}`);
      return res.status(502).json({ success: false, message: 'Could not reach the ICICI payment gateway. You have not been charged. Please try again in a few minutes.' });
    }
    const redirectUrl = paymentPageUrl(resp);
    const ok = resp?.responseCode === 'R1000' && !!redirectUrl && verifyV1(resp);
    if (!ok || resp.showOTPCapturePage === 'Y') {
      // showOTPCapturePage "Y" means a merchant-hosted OTP page (Direct / payType 1 only); never expected for payType 0
      const why = `responseCode ${resp?.responseCode} ${resp?.respDescription ?? ''}${ok ? ' (OTP capture page requested)' : !verifyV1(resp ?? {}) ? ' (secureHash mismatch)' : !redirectUrl ? ' (no https redirectURI / tranCtx)' : ''}`;
      await releaseSession(session._id, `initiateSale refused: ${why}`);
      console.error(`ICICI initiateSale ${merchantTxnNo} refused: ${why}`);
      return res.status(502).json({ success: false, message: 'The ICICI payment gateway could not start this payment. You have not been charged. Please try again.' });
    }

    await CheckoutSession.updateOne({ _id: session._id }, { $push: { events: { at: new Date(), type: 'icici-initiated', detail: String(resp.tranCtx) } } });
    return res.status(200).json({ success: true, data: { redirectUrl, merchantTxnNo } });
  } catch (error: any) {
    console.error('Error initiating ICICI payment:', error?.message);
    return res.status(500).json({ success: false, message: 'Error starting payment' });
  }
};

// POST /payments/icici/callback: the customer's browser, form-posted by ICICI to returnURL. Always redirects.
export const iciciCallback = async (req: Request, res: Response) => {
  const to = (path: string) => res.redirect(302, `${frontend()}${path}`);
  try {
    const outcome = await handleGatewayPost(gatewayParams(req), 'icici-callback');
    if (outcome === 'created' || outcome === 'existing') return to('/order-success');
    if (outcome === 'unfulfillable') return to('/order-failure?reason=paid_out_of_stock');
    if (outcome === 'processing') return to('/order-failure?reason=processing');
    if (outcome === 'failed') return to('/order-failure'); // a verified decline or cancel: safe to try again
    if (outcome === 'pending') return to('/order-failure?reason=pending'); // UPI R1000: awaiting the customer's approval
    // Wrong amount, unknown session or an unverifiable post: money may have moved
    return to('/order-failure?reason=unconfirmed');
  } catch (error: any) {
    console.error('Error handling ICICI callback:', error?.message);
    return to('/order-failure?reason=unconfirmed'); // the payment may have succeeded: never invite a second payment
  }
};

// POST /payments/icici/payment-advice: server-to-server, same parameters as the return URL. 200 = delivered.
export const iciciPaymentAdvice = async (req: Request, res: Response) => {
  try {
    const outcome = await handleGatewayPost(gatewayParams(req), 'icici-advice');
    // A bad hash is answered 400 so a genuine advice that fails verification is retried and shows in the logs
    if (outcome === null) return res.status(400).json({ success: false, message: 'Invalid secureHash' });
    return res.status(200).json({ success: true, outcome });
  } catch (error: any) {
    console.error('Error handling ICICI payment advice:', error?.message);
    return res.status(500).json({ success: false }); // ICICI retries non-200; finalizeSession is idempotent
  }
};

// POST /payments/icici/settlement-advice: server-to-server JSON; recorded on the order.
export const iciciSettlementAdvice = async (req: Request, res: Response) => {
  try {
    const p = gatewayParams(req);
    if (!verifyV1(p) || String(p.merchantId) !== icici().merchantId || !p.merchantTxnNo) {
      return res.status(400).json({ success: false, message: 'Invalid secureHash' });
    }
    const { secureHash, ...settlement } = p;
    const r = await Order.updateOne({ razorpayOrderId: String(p.merchantTxnNo), paymentMethod: 'icici' },
      { $set: { iciciSettlement: { ...settlement, receivedAt: new Date() } } });
    if (!r.matchedCount) console.warn(`ICICI settlement advice: no order for merchantTxnNo ${p.merchantTxnNo}`);
    return res.status(200).json({ success: true });
  } catch (error: any) {
    console.error('Error handling ICICI settlement advice:', error?.message);
    return res.status(500).json({ success: false });
  }
};

/**
 * STATUS command for one merchantTxnNo; a verified result is applied to its session (SUC -> order, REJ/ERR -> stock
 * released, REQ -> left pending). Used by /status and by admin reconcile. Throws if ICICI is unreachable or unverifiable.
 */
export const checkIciciStatus = async (merchantTxnNo: string) => {
  const c = icici();
  const resp: any = await postForm(c.commandUrl, signed({
    merchantId: c.merchantId, aggregatorID: c.aggregatorID, merchantTxnNo, originalTxnNo: merchantTxnNo, transactionType: 'STATUS',
  }));
  if (!verifyV1(resp)) {
    console.error(`ICICI STATUS ${merchantTxnNo}: secureHash mismatch keys=${Object.keys(resp ?? {}).sort().join(',')}`);
    throw new Error('Could not verify the gateway response');
  }
  // responseCode is the status REQUEST's result; the payment itself is txnStatus + txnResponseCode
  if (!isIciciSuccess(resp.responseCode)) return { txnStatus: null, txnRespDescription: resp.respDescription ?? null, outcome: 'not-found' };
  const txnStatus = String(resp.txnStatus ?? '');
  const outcome = await applyResult(merchantTxnNo, txnStatus === 'SUC' && isIciciSuccess(resp.txnResponseCode), txnStatus === 'REQ',
    String(resp.txnID ?? ''), resp.amount, `${txnStatus} ${resp.txnRespDescription ?? ''}`, 'icici-status');
  return { txnStatus, txnRespDescription: resp.txnRespDescription ?? null, outcome };
};

// POST /payments/icici/status { merchantTxnNo }: the session's owner or an admin. A confirmed success creates the order
// (recovers a lost return URL / advice).
export const iciciStatus = async (req: Request, res: Response) => {
  try {
    if (!iciciConfigured()) return res.status(503).json({ success: false, message: 'ICICI payments are not available' });
    const merchantTxnNo = String(req.body?.merchantTxnNo ?? '');
    if (!/^[A-Za-z0-9]{1,20}$/.test(merchantTxnNo)) return res.status(400).json({ success: false, message: 'Invalid merchantTxnNo' });
    const session = await CheckoutSession.findOne({ razorpayOrderId: merchantTxnNo, gateway: 'icici' }, { user: 1 }).lean();
    const isAdmin = ['admin', 'superadmin'].includes(String(req.user?.role));
    if (!session || (!isAdmin && String(session.user) !== String(req.user?._id))) {
      return res.status(404).json({ success: false, message: 'Payment not found' });
    }

    return res.status(200).json({ success: true, data: await checkIciciStatus(merchantTxnNo) });
  } catch (error: any) {
    console.error('Error checking ICICI status:', gatewayFailure(error, icici().commandUrl));
    return res.status(502).json({ success: false, message: 'Could not reach the payment gateway' });
  }
};

const REFUNDABLE_FROM = [undefined, 'required', 'failed', 'requested'];

// POST /payments/icici/refund { orderId, reason } (super admin): full refund. Safe to retry: a retry reuses the same
// refund merchantTxnNo, so ICICI sees one refund request however often it is sent.
export const iciciRefund = async (req: Request, res: Response) => {
  try {
    if (!iciciConfigured()) return res.status(503).json({ success: false, message: 'ICICI payments are not available' });
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (reason.length < 3 || reason.length > 300) return res.status(400).json({ success: false, message: 'A refund reason (3-300 characters) is required' });
    if (!/^[a-f\d]{24}$/i.test(String(req.body?.orderId))) return res.status(400).json({ success: false, message: 'Invalid orderId' });
    const by = String(req.user?._id);
    const order: any = await Order.findById(req.body.orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.paymentMethod !== 'icici' || !order.iciciTxnId || order.paymentStatus !== 'completed') {
      return order.paymentStatus === 'refunded'
        ? res.status(200).json({ success: true, message: 'Refund already issued', data: order.refund })
        : res.status(400).json({ success: false, message: 'This order has no completed ICICI payment to refund' });
    }
    if (['pending', 'processed'].includes(order.refund?.status)) {
      return res.status(200).json({ success: true, message: 'Refund already issued', data: order.refund });
    }

    // Claim atomically, fixing the refund reference on first claim: two admins (or a double click) send one request
    const refundTxnNo = order.iciciRefundTxnNo || newTxnNo();
    const amountPaise = Math.round(order.total * 100);
    const claimed: any = await Order.findOneAndUpdate(
      { _id: order._id, 'refund.status': { $in: REFUNDABLE_FROM }, iciciRefundTxnNo: order.iciciRefundTxnNo ?? { $exists: false } },
      { $set: { iciciRefundTxnNo: refundTxnNo, 'refund.status': 'requested', 'refund.reason': reason, 'refund.amountPaise': amountPaise },
        $push: { 'refund.events': { at: new Date(), by, action: 'requested', detail: `ICICI ${refundTxnNo}: ${reason}` } } },
      { new: true },
    );
    if (!claimed) return res.status(409).json({ success: false, message: 'A refund for this order is already in progress' });

    const c = icici();
    let resp: any;
    try {
      resp = await postForm(c.commandUrl, signed({
        merchantId: c.merchantId, aggregatorID: c.aggregatorID, merchantTxnNo: refundTxnNo, originalTxnNo: claimed.razorpayOrderId,
        amount: (amountPaise / 100).toFixed(2), transactionType: 'REFUND',
      }));
      if (!verifyV1(resp)) throw new Error('secureHash mismatch on refund response');
    } catch (err: any) {
      // Outcome unknown: stays "requested", and a retry sends the same refund merchantTxnNo
      const detail = String(err?.message || err).slice(0, 300);
      await Order.updateOne({ _id: claimed._id }, { $set: { 'refund.lastError': detail }, $push: { 'refund.events': { at: new Date(), by, action: 'error', detail } } });
      return res.status(502).json({ success: false, message: 'The refund could not be confirmed with the payment gateway. Retrying is safe.', code: 'REFUND_UNCONFIRMED' });
    }

    const code = String(resp.responseCode ?? '');
    const status = isIciciSuccess(code) ? 'processed' : code === 'R1000' ? 'pending' : 'failed';
    claimed.refund.status = status;
    claimed.refund.lastError = status === 'failed' ? String(resp.respDescription ?? code).slice(0, 300) : undefined;
    claimed.refund.events.push({ at: new Date(), by, action: 'gateway-status', outcome: status, detail: `ICICI ${code} ${resp.respDescription ?? ''} txn ${resp.txnID ?? ''}` });
    if (status === 'processed') claimed.paymentStatus = 'refunded';
    if (status === 'failed') claimed.iciciRefundTxnNo = undefined; // refused, not in flight: a new attempt needs a new reference
    await claimed.save();
    return res.status(status === 'failed' ? 409 : 200).json({ success: status !== 'failed', message: `Refund ${status}`, data: claimed.refund });
  } catch (error: any) {
    console.error('Error refunding ICICI order:', error?.message);
    return res.status(500).json({ success: false, message: 'Error refunding order' });
  }
};
