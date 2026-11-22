"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.iciciRefund = exports.iciciStatus = exports.checkIciciStatus = exports.iciciSettlementAdvice = exports.iciciPaymentAdvice = exports.iciciCallback = exports.iciciInitiate = exports.paymentPageUrl = void 0;
const Order_1 = __importDefault(require("../models/Order"));
const Cart_1 = require("../models/Cart");
const User_1 = require("../models/User");
const CheckoutSession_1 = require("../models/CheckoutSession");
const checkoutSessions_1 = require("../utils/checkoutSessions");
const iciciPg_1 = require("../utils/iciciPg");
const paymentController_1 = require("./paymentController");
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
const gatewayParams = (req) => {
    const raw = req.rawBody?.toString('utf8') ?? '';
    let body = {};
    if (req.is('application/json')) {
        try {
            const parsed = JSON.parse(raw || '{}', (_k, v, ctx) => (typeof v === 'number' ? ctx?.source ?? String(v) : v));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
                body = parsed;
        }
        catch { /* unparseable: rejected below as no merchantTxnNo */ }
    }
    else {
        body = Object.fromEntries(new URLSearchParams(raw));
    }
    if (body.merchantTxnNo)
        return body;
    const query = Object.fromEntries(new URL(req.originalUrl, 'http://local').searchParams);
    return query.merchantTxnNo ? query : body;
};
/** Returns an unpaid session's stock now instead of waiting for it to expire (a late success re-reserves it). */
const releaseSession = async (sessionId, detail) => {
    const before = await CheckoutSession_1.CheckoutSession.findOneAndUpdate({ _id: sessionId, status: 'pending' }, { $set: { status: 'expired', stockReserved: false }, $push: { events: { at: new Date(), type: 'icici-released', detail: detail.slice(0, 200) } } }, { new: false });
    if (before?.stockReserved)
        await (0, checkoutSessions_1.releaseStock)(before.items);
};
const amountMatches = (amount, paise) => amount === undefined || amount === null || amount === '' || Math.round(Number(amount) * 100) === paise;
/** Applies a verified payment result (return URL, payment advice or status check) to its checkout session. */
const applyResult = async (merchantTxnNo, success, pending, txnID, amount, detail, source) => {
    const session = await CheckoutSession_1.CheckoutSession.findOne({ razorpayOrderId: merchantTxnNo, gateway: 'icici' });
    if (!session) {
        console.warn(`ICICI ${source}: no checkout session for merchantTxnNo ${merchantTxnNo}`);
        return 'unknown';
    }
    if (pending)
        return 'pending';
    if (!success) {
        await releaseSession(session._id, `${source}: ${detail}`);
        return 'failed';
    }
    if (!amountMatches(amount, session.amountPaise)) {
        // Never turned into an order; money taken for the wrong amount is refunded manually
        console.error(`ICICI ${source}: ${merchantTxnNo} paid ${amount}, expected ${session.amountPaise / 100}. Refund manually.`);
        await CheckoutSession_1.CheckoutSession.updateOne({ _id: session._id }, { $push: { events: { at: new Date(), type: 'amount-mismatch', detail: `paid ${amount}` } } });
        return 'mismatch';
    }
    const { order, outcome } = await (0, checkoutSessions_1.finalizeSession)(session._id, txnID || merchantTxnNo, '', source);
    // Paid: the cart is spent. A paid-but-sold-out order clears it only on the browser's own return, never from a
    // later advice/status replay that could wipe items added since.
    if (order && (outcome === 'created' || (outcome === 'unfulfillable' && source === 'icici-callback'))) {
        await Cart_1.Cart.updateOne({ user: order.user }, { $set: { items: [] } });
    }
    if (outcome === 'created' && order) {
        const user = await User_1.User.findById(order.user, { name: 1, email: 1, role: 1 }).lean();
        await order.populate('items.product', 'name images variants');
        if (user)
            await (0, paymentController_1.sendOrderConfirmationEmail)(order, user);
    }
    return outcome;
};
/** Return URL / payment advice body -> outcome. Null when the secureHash or merchant does not check out. */
const handleGatewayPost = async (p, source) => {
    const why = !p.merchantTxnNo ? 'no merchantTxnNo' : !(0, iciciPg_1.verifyV1)(p) ? 'secureHash mismatch'
        : String(p.merchantId) !== (0, iciciPg_1.icici)().merchantId ? `unexpected merchantId ${p.merchantId}` : '';
    if (why) {
        console.error(`ICICI ${source} REJECTED (${why}) merchantTxnNo=${p.merchantTxnNo} responseCode=${p.responseCode} keys=${Object.keys(p).sort().join(',')}`);
        return null;
    }
    // Every verified field is kept on the session (mode-specific ones such as paymentMode, UPI / bank references)
    const { secureHash: _hash, ...fields } = p;
    await CheckoutSession_1.CheckoutSession.updateOne({ razorpayOrderId: String(p.merchantTxnNo), gateway: 'icici' }, { $push: { events: { at: new Date(), type: `${source}-params`, detail: JSON.stringify(fields).slice(0, 4000) } } });
    const code = String(p.responseCode ?? p.respCode ?? '');
    return applyResult(String(p.merchantTxnNo), (0, iciciPg_1.isIciciSuccess)(code), code === 'R1000', String(p.txnID ?? ''), p.amount, `${code} ${p.respDescription ?? ''}`, source);
};
/**
 * UAT testers: comma-separated user _ids (24 hex). Empty -> nobody. Any malformed entry -> null (the whole list is
 * refused, so a typo blocks everyone instead of half-working).
 */
const uatTesterIds = () => {
    const ids = (process.env.ICICI_PG_UAT_TEST_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
    return ids.every((id) => /^[a-f\d]{24}$/i.test(id)) ? new Set(ids.map((id) => id.toLowerCase())) : null;
};
/**
 * ICICI's payment page for this sale (redirectURI + tranCtx), or '' when redirectURI is not a parseable https URL or
 * tranCtx is missing: the customer is never sent to a malformed or plain-http page. URL keeps any query redirectURI has.
 */
const paymentPageUrl = (resp) => {
    try {
        const u = new URL(String(resp?.redirectURI ?? ''));
        if (u.protocol !== 'https:' || !resp?.tranCtx)
            return '';
        u.searchParams.set('tranCtx', String(resp.tranCtx));
        return u.toString();
    }
    catch {
        return '';
    }
};
exports.paymentPageUrl = paymentPageUrl;
// POST /payments/icici/initiate (customer): quote, reserve stock, initiateSale, return the gateway URL to redirect to
const iciciInitiate = async (req, res) => {
    try {
        if (!(0, iciciPg_1.iciciConfigured)())
            return res.status(503).json({ success: false, message: 'ICICI payments are not available' });
        // Test (UAT / mixed / unknown) gateway config on any server except NODE_ENV exactly "development": test-card
        // "payments" must never become real customer orders, so only the accounts whose _id is listed in
        // ICICI_PG_UAT_TEST_USER_IDS may pay. Fail-safe: NODE_ENV unset, "staging", "Production" etc. are all gated.
        // By _id, never email: registration does not prove email ownership and emails are stored case-sensitively, so
        // anyone could register a tester's address (or a case variant of it). req.user comes from the signed token's id.
        if (!(0, iciciPg_1.iciciLive)() && process.env.NODE_ENV !== 'development') {
            const testers = uatTesterIds();
            if (!testers?.has(String(req.user._id))) {
                if (!testers)
                    console.error('ICICI UAT gate: ICICI_PG_UAT_TEST_USER_IDS has a malformed entry (each must be a 24-hex user _id): every customer is blocked');
                if (process.env.ICICI_PG_UAT_TEST_EMAILS)
                    console.warn('ICICI UAT gate: ICICI_PG_UAT_TEST_EMAILS is no longer used; list tester user _ids in ICICI_PG_UAT_TEST_USER_IDS');
                return res.status(403).json({ success: false, message: 'Online payment is being set up and is not available yet. Please try again later.' });
            }
        }
        // Back from ICICI's page without paying and trying again: release this customer's earlier unpaid holds first, so
        // the last unit is not blocked by their own reservation. If an earlier one is paid after all, it re-reserves.
        const earlier = await CheckoutSession_1.CheckoutSession.find({ user: req.user._id, gateway: 'icici', status: 'pending' }, { _id: 1 }).lean();
        for (const e of earlier)
            await releaseSession(e._id, 'superseded by a new ICICI checkout');
        const priced = await (0, paymentController_1.priceCheckout)(req, res);
        if (!priced)
            return;
        const c = (0, iciciPg_1.icici)();
        const merchantTxnNo = (0, iciciPg_1.newTxnNo)();
        const session = await (0, paymentController_1.openSession)(req, res, priced, merchantTxnNo, 'icici');
        if (!session)
            return;
        const user = req.user;
        const mobile = String(user.phone ?? '').replace(/\D/g, '').slice(-10);
        const request = (0, iciciPg_1.signed)({
            merchantId: c.merchantId,
            aggregatorID: c.aggregatorID,
            merchantTxnNo,
            amount: (session.amountPaise / 100).toFixed(2),
            currencyCode: c.currencyCode,
            payType: '0',
            customerEmailID: user.email,
            customerMobileNo: mobile.length === 10 ? mobile : undefined,
            transactionType: 'SALE',
            txnDate: (0, iciciPg_1.saleTxnDate)(),
            returnURL: c.returnURL,
        });
        let resp;
        try {
            resp = await (0, iciciPg_1.postJson)(c.initiateSaleUrl, request);
        }
        catch (err) {
            const failure = (0, iciciPg_1.gatewayFailure)(err, c.initiateSaleUrl);
            await releaseSession(session._id, `initiateSale error: ${failure}`);
            // No reply at all (seen when ICICI's firewall drops callers whose IP it has not allow-listed): say what to check
            const hint = err?.name === 'TimeoutError' ? ' (no response in 20 s: check that this server\'s public IP is allow-listed with ICICI for this environment)'
                : /ECONNREFUSED/.test(failure) ? ' (connection refused: is the configured gateway, or the local mock, running at this address?)' : '';
            console.error(`ICICI initiateSale ${merchantTxnNo} failed: ${failure}${hint}`);
            return res.status(502).json({ success: false, message: 'Could not reach the ICICI payment gateway. You have not been charged. Please try again in a few minutes.' });
        }
        const redirectUrl = (0, exports.paymentPageUrl)(resp);
        const ok = resp?.responseCode === 'R1000' && !!redirectUrl && (0, iciciPg_1.verifyV1)(resp);
        if (!ok || resp.showOTPCapturePage === 'Y') {
            // showOTPCapturePage "Y" means a merchant-hosted OTP page (Direct / payType 1 only); never expected for payType 0
            const why = `responseCode ${resp?.responseCode} ${resp?.respDescription ?? ''}${ok ? ' (OTP capture page requested)' : !(0, iciciPg_1.verifyV1)(resp ?? {}) ? ' (secureHash mismatch)' : !redirectUrl ? ' (no https redirectURI / tranCtx)' : ''}`;
            await releaseSession(session._id, `initiateSale refused: ${why}`);
            console.error(`ICICI initiateSale ${merchantTxnNo} refused: ${why}`);
            return res.status(502).json({ success: false, message: 'The ICICI payment gateway could not start this payment. You have not been charged. Please try again.' });
        }
        await CheckoutSession_1.CheckoutSession.updateOne({ _id: session._id }, { $push: { events: { at: new Date(), type: 'icici-initiated', detail: String(resp.tranCtx) } } });
        return res.status(200).json({ success: true, data: { redirectUrl, merchantTxnNo } });
    }
    catch (error) {
        console.error('Error initiating ICICI payment:', error?.message);
        return res.status(500).json({ success: false, message: 'Error starting payment' });
    }
};
exports.iciciInitiate = iciciInitiate;
// POST /payments/icici/callback: the customer's browser, form-posted by ICICI to returnURL. Always redirects.
const iciciCallback = async (req, res) => {
    const to = (path) => res.redirect(302, `${frontend()}${path}`);
    try {
        const outcome = await handleGatewayPost(gatewayParams(req), 'icici-callback');
        if (outcome === 'created' || outcome === 'existing')
            return to('/order-success');
        if (outcome === 'unfulfillable')
            return to('/order-failure?reason=paid_out_of_stock');
        if (outcome === 'processing')
            return to('/order-failure?reason=processing');
        if (outcome === 'failed')
            return to('/order-failure'); // a verified decline or cancel: safe to try again
        if (outcome === 'pending')
            return to('/order-failure?reason=pending'); // UPI R1000: awaiting the customer's approval
        // Wrong amount, unknown session or an unverifiable post: money may have moved
        return to('/order-failure?reason=unconfirmed');
    }
    catch (error) {
        console.error('Error handling ICICI callback:', error?.message);
        return to('/order-failure?reason=unconfirmed'); // the payment may have succeeded: never invite a second payment
    }
};
exports.iciciCallback = iciciCallback;
// POST /payments/icici/payment-advice: server-to-server, same parameters as the return URL. 200 = delivered.
const iciciPaymentAdvice = async (req, res) => {
    try {
        const outcome = await handleGatewayPost(gatewayParams(req), 'icici-advice');
        // A bad hash is answered 400 so a genuine advice that fails verification is retried and shows in the logs
        if (outcome === null)
            return res.status(400).json({ success: false, message: 'Invalid secureHash' });
        return res.status(200).json({ success: true, outcome });
    }
    catch (error) {
        console.error('Error handling ICICI payment advice:', error?.message);
        return res.status(500).json({ success: false }); // ICICI retries non-200; finalizeSession is idempotent
    }
};
exports.iciciPaymentAdvice = iciciPaymentAdvice;
// POST /payments/icici/settlement-advice: server-to-server JSON; recorded on the order.
const iciciSettlementAdvice = async (req, res) => {
    try {
        const p = gatewayParams(req);
        if (!(0, iciciPg_1.verifyV1)(p) || String(p.merchantId) !== (0, iciciPg_1.icici)().merchantId || !p.merchantTxnNo) {
            return res.status(400).json({ success: false, message: 'Invalid secureHash' });
        }
        const { secureHash, ...settlement } = p;
        const r = await Order_1.default.updateOne({ razorpayOrderId: String(p.merchantTxnNo), paymentMethod: 'icici' }, { $set: { iciciSettlement: { ...settlement, receivedAt: new Date() } } });
        if (!r.matchedCount)
            console.warn(`ICICI settlement advice: no order for merchantTxnNo ${p.merchantTxnNo}`);
        return res.status(200).json({ success: true });
    }
    catch (error) {
        console.error('Error handling ICICI settlement advice:', error?.message);
        return res.status(500).json({ success: false });
    }
};
exports.iciciSettlementAdvice = iciciSettlementAdvice;
/**
 * STATUS command for one merchantTxnNo; a verified result is applied to its session (SUC -> order, REJ/ERR -> stock
 * released, REQ -> left pending). Used by /status and by admin reconcile. Throws if ICICI is unreachable or unverifiable.
 */
const checkIciciStatus = async (merchantTxnNo) => {
    const c = (0, iciciPg_1.icici)();
    const resp = await (0, iciciPg_1.postForm)(c.commandUrl, (0, iciciPg_1.signed)({
        merchantId: c.merchantId, aggregatorID: c.aggregatorID, merchantTxnNo, originalTxnNo: merchantTxnNo, transactionType: 'STATUS',
    }));
    if (!(0, iciciPg_1.verifyV1)(resp)) {
        console.error(`ICICI STATUS ${merchantTxnNo}: secureHash mismatch keys=${Object.keys(resp ?? {}).sort().join(',')}`);
        throw new Error('Could not verify the gateway response');
    }
    // responseCode is the status REQUEST's result; the payment itself is txnStatus + txnResponseCode
    if (!(0, iciciPg_1.isIciciSuccess)(resp.responseCode))
        return { txnStatus: null, txnRespDescription: resp.respDescription ?? null, outcome: 'not-found' };
    const txnStatus = String(resp.txnStatus ?? '');
    const outcome = await applyResult(merchantTxnNo, txnStatus === 'SUC' && (0, iciciPg_1.isIciciSuccess)(resp.txnResponseCode), txnStatus === 'REQ', String(resp.txnID ?? ''), resp.amount, `${txnStatus} ${resp.txnRespDescription ?? ''}`, 'icici-status');
    return { txnStatus, txnRespDescription: resp.txnRespDescription ?? null, outcome };
};
exports.checkIciciStatus = checkIciciStatus;
// POST /payments/icici/status { merchantTxnNo }: the session's owner or an admin. A confirmed success creates the order
// (recovers a lost return URL / advice).
const iciciStatus = async (req, res) => {
    try {
        if (!(0, iciciPg_1.iciciConfigured)())
            return res.status(503).json({ success: false, message: 'ICICI payments are not available' });
        const merchantTxnNo = String(req.body?.merchantTxnNo ?? '');
        if (!/^[A-Za-z0-9]{1,20}$/.test(merchantTxnNo))
            return res.status(400).json({ success: false, message: 'Invalid merchantTxnNo' });
        const session = await CheckoutSession_1.CheckoutSession.findOne({ razorpayOrderId: merchantTxnNo, gateway: 'icici' }, { user: 1 }).lean();
        const isAdmin = ['admin', 'superadmin'].includes(String(req.user?.role));
        if (!session || (!isAdmin && String(session.user) !== String(req.user?._id))) {
            return res.status(404).json({ success: false, message: 'Payment not found' });
        }
        return res.status(200).json({ success: true, data: await (0, exports.checkIciciStatus)(merchantTxnNo) });
    }
    catch (error) {
        console.error('Error checking ICICI status:', (0, iciciPg_1.gatewayFailure)(error, (0, iciciPg_1.icici)().commandUrl));
        return res.status(502).json({ success: false, message: 'Could not reach the payment gateway' });
    }
};
exports.iciciStatus = iciciStatus;
const REFUNDABLE_FROM = [undefined, 'required', 'failed', 'requested'];
// POST /payments/icici/refund { orderId, reason } (super admin): full refund. Safe to retry: a retry reuses the same
// refund merchantTxnNo, so ICICI sees one refund request however often it is sent.
const iciciRefund = async (req, res) => {
    try {
        if (!(0, iciciPg_1.iciciConfigured)())
            return res.status(503).json({ success: false, message: 'ICICI payments are not available' });
        const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
        if (reason.length < 3 || reason.length > 300)
            return res.status(400).json({ success: false, message: 'A refund reason (3-300 characters) is required' });
        if (!/^[a-f\d]{24}$/i.test(String(req.body?.orderId)))
            return res.status(400).json({ success: false, message: 'Invalid orderId' });
        const by = String(req.user?._id);
        const order = await Order_1.default.findById(req.body.orderId);
        if (!order)
            return res.status(404).json({ success: false, message: 'Order not found' });
        if (order.paymentMethod !== 'icici' || !order.iciciTxnId || order.paymentStatus !== 'completed') {
            return order.paymentStatus === 'refunded'
                ? res.status(200).json({ success: true, message: 'Refund already issued', data: order.refund })
                : res.status(400).json({ success: false, message: 'This order has no completed ICICI payment to refund' });
        }
        if (['pending', 'processed'].includes(order.refund?.status)) {
            return res.status(200).json({ success: true, message: 'Refund already issued', data: order.refund });
        }
        // Claim atomically, fixing the refund reference on first claim: two admins (or a double click) send one request
        const refundTxnNo = order.iciciRefundTxnNo || (0, iciciPg_1.newTxnNo)();
        const amountPaise = Math.round(order.total * 100);
        const claimed = await Order_1.default.findOneAndUpdate({ _id: order._id, 'refund.status': { $in: REFUNDABLE_FROM }, iciciRefundTxnNo: order.iciciRefundTxnNo ?? { $exists: false } }, { $set: { iciciRefundTxnNo: refundTxnNo, 'refund.status': 'requested', 'refund.reason': reason, 'refund.amountPaise': amountPaise },
            $push: { 'refund.events': { at: new Date(), by, action: 'requested', detail: `ICICI ${refundTxnNo}: ${reason}` } } }, { new: true });
        if (!claimed)
            return res.status(409).json({ success: false, message: 'A refund for this order is already in progress' });
        const c = (0, iciciPg_1.icici)();
        let resp;
        try {
            resp = await (0, iciciPg_1.postForm)(c.commandUrl, (0, iciciPg_1.signed)({
                merchantId: c.merchantId, aggregatorID: c.aggregatorID, merchantTxnNo: refundTxnNo, originalTxnNo: claimed.razorpayOrderId,
                amount: (amountPaise / 100).toFixed(2), transactionType: 'REFUND',
            }));
            if (!(0, iciciPg_1.verifyV1)(resp))
                throw new Error('secureHash mismatch on refund response');
        }
        catch (err) {
            // Outcome unknown: stays "requested", and a retry sends the same refund merchantTxnNo
            const detail = String(err?.message || err).slice(0, 300);
            await Order_1.default.updateOne({ _id: claimed._id }, { $set: { 'refund.lastError': detail }, $push: { 'refund.events': { at: new Date(), by, action: 'error', detail } } });
            return res.status(502).json({ success: false, message: 'The refund could not be confirmed with the payment gateway. Retrying is safe.', code: 'REFUND_UNCONFIRMED' });
        }
        const code = String(resp.responseCode ?? '');
        const status = (0, iciciPg_1.isIciciSuccess)(code) ? 'processed' : code === 'R1000' ? 'pending' : 'failed';
        claimed.refund.status = status;
        claimed.refund.lastError = status === 'failed' ? String(resp.respDescription ?? code).slice(0, 300) : undefined;
        claimed.refund.events.push({ at: new Date(), by, action: 'gateway-status', outcome: status, detail: `ICICI ${code} ${resp.respDescription ?? ''} txn ${resp.txnID ?? ''}` });
        if (status === 'processed')
            claimed.paymentStatus = 'refunded';
        if (status === 'failed')
            claimed.iciciRefundTxnNo = undefined; // refused, not in flight: a new attempt needs a new reference
        await claimed.save();
        return res.status(status === 'failed' ? 409 : 200).json({ success: status !== 'failed', message: `Refund ${status}`, data: claimed.refund });
    }
    catch (error) {
        console.error('Error refunding ICICI order:', error?.message);
        return res.status(500).json({ success: false, message: 'Error refunding order' });
    }
};
exports.iciciRefund = iciciRefund;
//# sourceMappingURL=iciciController.js.map