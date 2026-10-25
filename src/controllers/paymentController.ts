import { Request, Response } from 'express';
import Razorpay from 'razorpay';
import crypto from 'crypto';
import Order from '../models/Order';
import { Product } from '../models/Product';
import { Settings } from '../models/Settings';
import { User } from '../models/User';
import { sendEmail } from '../utils/sendEmail';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import { ENV } from '../config/env';
import { calculateShippingForItems } from '../utils/shippingCalculator';
import { CheckoutRuleError, Selection } from '../utils/orderPricing';
import { CheckoutSettingsError } from '../utils/checkoutSettings';
import { CheckoutSession, ICheckoutSession } from '../models/CheckoutSession';
import { expireStaleSessions, finalizeSession, releaseStock, reserveStock, settingsFingerprint, snapshotFromQuote } from '../utils/checkoutSessions';
dotenv.config();

export const razorpayInstance = new Razorpay({
  key_id: (process.env.RAZORPAY_KEY_ID || 'dummy_key_id').trim(),
  key_secret: (process.env.RAZORPAY_KEY_SECRET || 'dummy_key_secret').trim(),
});

const razorpayKeysMissing = () =>
  !process.env.RAZORPAY_KEY_ID ||
  process.env.RAZORPAY_KEY_ID === 'dummy_key_id' ||
  process.env.RAZORPAY_KEY_ID === 'YOUR_RAZORPAY_KEY_ID' ||
  process.env.RAZORPAY_KEY_ID.startsWith('rzp_test_Luxy') || // Our placeholder test keys
  !process.env.RAZORPAY_KEY_SECRET ||
  process.env.RAZORPAY_KEY_SECRET === 'dummy_key_secret' ||
  process.env.RAZORPAY_KEY_SECRET === 'YOUR_RAZORPAY_KEY_SECRET' ||
  process.env.RAZORPAY_KEY_SECRET.startsWith('LuxySecret'); // Our placeholder secret

/** Mock payments exist only for local development without Razorpay keys — never anywhere else. */
export const isMockPaymentMode = () => ENV.NODE_ENV === 'development' && razorpayKeysMissing();

/** Constant-time compare of the Razorpay HMAC signature. */
export const isValidRazorpaySignature = (orderId: string, paymentId: string, signature: string, secret: string) => {
  const expected = crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

/**
 * The customer's fulfilment choice from a checkout request. `fulfillment` is { method: 'delivery' | 'pickup',
 * shippingMethod?: 'land' | 'air' }. Payment calls default to delivery (what every client sent before pickup existed);
 * a quote without a choice lets the server pick the first available option.
 */
const selectionFrom = (body: any, paying: boolean): Selection | string => {
  const f = body?.fulfillment;
  if (f !== undefined && (typeof f !== 'object' || f === null)) return 'Invalid fulfillment option';
  const method = f?.method;
  if (method !== undefined && method !== 'delivery' && method !== 'pickup') return 'Invalid fulfillment method';
  const shippingMethod = f?.shippingMethod;
  if (shippingMethod !== undefined && shippingMethod !== null && shippingMethod !== 'land' && shippingMethod !== 'air') return 'Invalid shipping method';
  return {
    fulfillment: method ?? (paying ? 'delivery' : undefined),
    shippingMethod: method === 'pickup' ? undefined : shippingMethod ?? undefined,
    state: typeof body?.shippingAddress?.state === 'string' ? body.shippingAddress.state : undefined,
    // Blank country = not given (older saved addresses); never treated as a foreign destination
    country: typeof body?.shippingAddress?.country === 'string' && body.shippingAddress.country.trim() ? body.shippingAddress.country.trim() : undefined,
  };
};

/** Pricing failures: a rule the customer can act on (400), settings we cannot read (503, never guessed charges), bad items (400). */
const pricingError = (res: Response, err: any) => {
  if (err instanceof CheckoutRuleError) {
    return res.status(400).json({ success: false, message: err.message, code: err.code, data: err.options ? { options: err.options } : null });
  }
  if (err instanceof CheckoutSettingsError) {
    console.error('Checkout settings unavailable:', err.message);
    return res.status(503).json({ success: false, message: 'Delivery charges are temporarily unavailable. Please try again shortly.', code: 'SETTINGS_UNAVAILABLE' });
  }
  return res.status(400).json({ success: false, message: err?.message || 'Validation failed' });
};

const hasDeliveryAddress = (a: any) => !!(a?.city?.trim?.() && a?.state?.trim?.() && a?.zipCode?.trim?.());

/** Email summary rows for delivery/pickup, packaging and GST, between Subtotal and Total. */
const chargeRows = (o: any) => {
  const row = (label: string, value: string) => `
                    <tr>
                      <td style="padding-bottom: 10px; color: #6b7280; font-size: 14px;">${label}</td>
                      <td style="padding-bottom: 10px; color: #111827; font-weight: bold; font-size: 14px; text-align: right;">${value}</td>
                    </tr>`;
  const money = (n: number) => (n > 0 ? `₹${n}` : 'Free');
  let rows = o.fulfillmentMethod === 'pickup' ? row('Store pickup:', money(o.pickupFee || 0)) : row('Shipping:', money(o.shippingFee || 0));
  if (o.specialPackagingFee > 0) rows += row('Special packaging:', `₹${o.specialPackagingFee}`);
  if (o.tax?.enabled && o.tax.taxAmount > 0) rows += row(o.tax.pricesIncludeTax ? 'GST (included):' : 'GST:', `₹${o.tax.taxAmount}`);
  if (o.fulfillmentMethod === 'pickup' && o.pickupDetails?.storeName) {
    rows += row('Collect from:', `${o.pickupDetails.storeName}${o.pickupDetails.address ? `, ${o.pickupDetails.address}` : ''}`);
  }
  return rows;
};

/** Order confirmation email. Never throws: a mail failure must not fail the order. */
const sendOrderConfirmationEmail = async (newOrder: any, user: { _id: unknown; name?: string; email?: string; role?: string }) => {
      try {
        if (user && user.email) {
          const autoLoginToken = jwt.sign({ id: user._id, role: user.role || 'customer' }, ENV.JWT_SECRET, { expiresIn: '7d' });

          const itemsHtml = newOrder.items.map((item: any) => {
            const product = item.product;
            return `
              <tr>
                <td style="padding: 15px 10px; border-bottom: 1px solid #eaeaea;">
                  <p style="margin: 0; font-weight: bold; color: #111827; font-size: 15px;">${product?.name || 'Product'}</p>
                  <p style="margin: 5px 0 0; color: #6b7280; font-size: 13px;">Qty: ${item.quantity}</p>
                </td>
                <td style="padding: 15px 0; border-bottom: 1px solid #eaeaea; text-align: right;">
                  <p style="margin: 0; font-weight: bold; color: #111827; font-size: 15px;">₹${item.price}</p>
                </td>
              </tr>
            `;
          }).join('');

          const htmlMessage = `
            <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #eaeaea; border-radius: 10px; overflow: hidden; background-color: #ffffff;">
              <div style="background-color: #111827; padding: 30px; text-align: center;">
                <h1 style="color: #ffffff; margin: 0; font-size: 24px; letter-spacing: 2px; text-transform: uppercase;">Luxy Galleria</h1>
              </div>
              <div style="padding: 40px 30px;">
                <h2 style="color: #111827; font-size: 20px; margin-top: 0; margin-bottom: 20px;">Order Confirmation</h2>
                <p style="color: #4b5563; font-size: 16px; line-height: 1.6; margin-bottom: 20px;">
                  Dear <strong>${user.name}</strong>,<br><br>
                  Thank you for your purchase! Your order has been placed successfully and is now being processed.
                </p>
                <div style="background-color: #f9fafb; border: 1px solid #f3f4f6; border-radius: 8px; padding: 20px; margin-bottom: 30px; text-align: center;">
                  <p style="margin: 0 0 10px 0; color: #374151; font-size: 15px;"><strong>Order ID:</strong> <span style="color: #111827;">${newOrder._id}</span></p>
                  <p style="margin: 0 0 10px 0; color: #374151; font-size: 15px;"><strong>Order Date:</strong> <span style="color: #111827;">${String(new Date(newOrder.createdAt).getDate()).padStart(2, '0')}/${String(new Date(newOrder.createdAt).getMonth() + 1).padStart(2, '0')}/${new Date(newOrder.createdAt).getFullYear()}</span></p>
                </div>

                <h3 style="color: #111827; font-size: 18px; margin-bottom: 15px; border-bottom: 2px solid #f3f4f6; padding-bottom: 10px;">Order Details</h3>
                <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
                  <tbody>
                    ${itemsHtml}
                  </tbody>
                </table>
                
                <div style="background-color: #f9fafb; border-radius: 8px; padding: 20px; margin-bottom: 30px;">
                  <table style="width: 100%; border-collapse: collapse;">
                    <tr>
                      <td style="padding-bottom: 10px; color: #6b7280; font-size: 14px;">Subtotal:</td>
                      <td style="padding-bottom: 10px; color: #111827; font-weight: bold; font-size: 14px; text-align: right;">₹${newOrder.subtotal}</td>
                    </tr>
                    ${newOrder.discount > 0 ? `
                    <tr>
                      <td style="padding-bottom: 10px; color: #6b7280; font-size: 14px;">Discount:</td>
                      <td style="padding-bottom: 10px; color: #10b981; font-weight: bold; font-size: 14px; text-align: right;">-₹${newOrder.discount}</td>
                    </tr>
                    ` : ''}
                    ${chargeRows(newOrder)}
                    <tr>
                      <td style="padding-top: 15px; border-top: 1px solid #eaeaea; color: #111827; font-weight: bold; font-size: 16px;">Total:</td>
                      <td style="padding-top: 15px; border-top: 1px solid #eaeaea; color: #111827; font-weight: bold; font-size: 18px; text-align: right;">₹${newOrder.total}</td>
                    </tr>
                  </table>
                </div>

                <p style="color: #4b5563; font-size: 15px; line-height: 1.6; margin-bottom: 30px;">
                  We will send you another email once your order has been shipped. If you have any questions, feel free to reply to this email.
                </p>
                <div style="text-align: center;">
                  <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/profile?token=${autoLoginToken}" style="background-color: #111827; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: bold; font-size: 14px; display: inline-block;">View Order Details</a>
                </div>
              </div>
              <div style="background-color: #f9fafb; padding: 20px; text-align: center; border-top: 1px solid #eaeaea;">
                <p style="color: #9ca3af; font-size: 13px; margin: 0;">© ${new Date().getFullYear()} Luxy Galleria. All rights reserved.</p>
              </div>
            </div>
          `;
          await sendEmail({
            email: user.email,
            subject: 'Order Confirmation - Luxy Galleria',
            html: htmlMessage
          });
        }
      } catch (emailErr) {
        console.error('Error sending confirmation email:', emailErr);
        // Don't fail the order if email fails
      }

};

/** A Razorpay payment pays this session only if it is for its order, in INR, authorised/captured and for exactly its amount. */
export const paymentMatchesSession = (payment: any, session: Pick<ICheckoutSession, 'razorpayOrderId' | 'amountPaise' | 'currency'>) => {
  const ok = !!payment && payment.order_id === session.razorpayOrderId && ['authorized', 'captured'].includes(payment.status)
    && payment.currency === session.currency && Number(payment.amount) === session.amountPaise;
  if (!ok && payment) {
    // Ids and amounts only (no customer data). A captured payment refused here must be refunded (see /payments/admin/reconcile).
    console.warn(`Payment ${payment.id} (order ${payment.order_id}) not accepted for session ${session.razorpayOrderId}: status ${payment.status}, ${payment.amount} ${payment.currency}, expected ${session.amountPaise} ${session.currency}`);
  }
  return ok;
};

// Create Order — Only creates a Razorpay order, does NOT save to DB yet
export const createOrder = async (req: Request, res: Response) => {
  try {
    const { total, items, shippingAddress } = req.body;
    const selection = selectionFrom(req.body, true);
    if (typeof selection === 'string') return res.status(400).json({ success: false, message: selection });

    // Refuse to start a delivery payment without a deliverable address (pickup orders need none)
    if (selection.fulfillment === 'delivery' && !hasDeliveryAddress(shippingAddress)) {
      return res.status(400).json({ success: false, message: 'Please select or add a shipping address' });
    }

    if (typeof total !== 'number' || Number.isNaN(total) || total <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid order total. Please refresh and try again.' });
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'No items in order to validate.' });
    }

    // Server-side amount validation: shipping, packaging, pickup charge and tax are all recomputed here
    let totals;
    try {
      totals = await calculateShippingForItems(items, selection);
    } catch (err: any) {
      return pricingError(res, err);
    }

    // The client shows the server's own quote, so the totals must agree to the paisa; any difference is stale or tampered
    if (Math.round(totals.grandTotal * 100) !== Math.round(total * 100)) {
      return res.status(400).json({ 
        success: false, 
        message: `Order total validation failed. Server calculated total of ${totals.grandTotal} differs from client total of ${total}. Please refresh and try again.` 
      });
    }

    // Reserve stock now (atomic, all or nothing) so concurrent checkouts can never sell the same units
    await expireStaleSessions();
    const reserved = await reserveStock(totals.lines);
    if (!reserved.ok) {
      return res.status(400).json({ success: false, code: 'OUT_OF_STOCK', message: `Only ${reserved.available} of ${reserved.name} left in stock` });
    }

    let razorpayOrder;
    let isMock = false;
    try {
      if (isMockPaymentMode()) {
        razorpayOrder = { id: `mock_order_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`, amount: Math.round(totals.grandTotal * 100), currency: 'INR' };
        isMock = true;
      } else if (razorpayKeysMissing()) {
        console.error('Razorpay keys are not configured; refusing to create a payment');
        await releaseStock(totals.lines);
        return res.status(503).json({ success: false, message: 'Payments are temporarily unavailable' });
      } else {
        razorpayOrder = await razorpayInstance.orders.create({
          // Charge the server-calculated amount, never the client's number
          amount: Math.round(totals.grandTotal * 100),
          currency: 'INR',
          receipt: `receipt_order_${Date.now()}`,
          notes: { fulfillment: totals.fulfillmentMethod, shippingMethod: totals.shippingMethod || '' },
        });
      }
      // The immutable quote this payment will be verified against
      const fp = await settingsFingerprint();
      await CheckoutSession.create(snapshotFromQuote(totals, items, {
        user: req.user!._id, razorpayOrderId: razorpayOrder.id, isMock, shippingAddress, settingsVersion: fp.version, settingsUpdatedAt: fp.updatedAt,
      }));
    } catch (err) {
      await releaseStock(totals.lines); // nothing can be paid for: give the units back
      throw err;
    }

    // No order yet — the order is created only after the payment is confirmed against the session
    res.status(200).json({
      success: true,
      data: {
        razorpayOrder,
        isMock,
        key_id: process.env.RAZORPAY_KEY_ID || process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || 'rzp_test_YourTestKey' // Return the key used to generate the order to prevent mismatch
      }
    });

  } catch (error: any) {
    console.error('Error creating order:', error);
    res.status(500).json({ success: false, message: 'Error creating order' });
  }
};

// Verify Payment — Saves order to DB only after payment is confirmed
// Verify Payment — confirms the payment against the server's quote snapshot and creates the order exactly once
export const verifyPayment = async (req: Request, res: Response) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (!req.user || !req.user._id) {
      return res.status(401).json({ success: false, message: 'User not authenticated' });
    }
    if (typeof razorpay_order_id !== 'string' || typeof razorpay_payment_id !== 'string' || !razorpay_order_id || !razorpay_payment_id) {
      return res.status(400).json({ success: false, message: 'Missing payment details' });
    }

    // Idempotent: a payment can create at most one order (double clicks, retries, replays)
    // Mock payments (local development only) all share the id "mock_payment": key those on the order id alone
    const existing = await Order.findOne(razorpay_payment_id === 'mock_payment'
      ? { razorpayOrderId: razorpay_order_id }
      : { $or: [{ razorpayPaymentId: razorpay_payment_id }, { razorpayOrderId: razorpay_order_id }] })
      .populate('items.product', 'name images variants');
    if (existing) {
      if (existing.user.toString() === req.user._id.toString() && existing.razorpayPaymentId === razorpay_payment_id) {
        return res.status(200).json({ success: true, message: 'Order already placed for this payment', data: existing });
      }
      return res.status(409).json({ success: false, message: 'This payment has already been used' });
    }

    // The quote snapshot created with this Razorpay order is the only source of what may be charged and ordered.
    // Cart items, prices and totals in the request body are ignored.
    const session = await CheckoutSession.findOne({ razorpayOrderId: razorpay_order_id });
    if (!session) {
      console.warn(`Payment ${razorpay_payment_id}: no checkout session for order ${razorpay_order_id}`);
      return res.status(400).json({ success: false, message: 'Checkout session not found. If you were charged, contact us with your payment ID.', code: 'SESSION_NOT_FOUND' });
    }
    if (session.user.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'This checkout belongs to another account' });
    }

    let paymentVerified = false;
    const isMock = razorpay_payment_id === 'mock_payment';
    if (isMock) {
      // Only ever honoured in local development without Razorpay keys, for a session created in mock mode
      paymentVerified = isMockPaymentMode() && session.isMock && razorpay_order_id.startsWith('mock_order_');
    } else {
      if (!razorpay_signature) {
        return res.status(400).json({ success: false, message: 'Missing payment signature' });
      }
      const keySecret = (process.env.RAZORPAY_KEY_SECRET || '').trim();
      if (keySecret && isValidRazorpaySignature(razorpay_order_id, razorpay_payment_id, razorpay_signature, keySecret)) {
        // The signature proves the payment belongs to the order; Razorpay tells us what was actually paid.
        const payment: any = await razorpayInstance.payments.fetch(razorpay_payment_id);
        paymentVerified = paymentMatchesSession(payment, session);
      }
    }
    if (!paymentVerified) {
      return res.status(400).json({ success: false, message: 'Invalid signature. Payment verification failed.' });
    }

    const { order, outcome } = await finalizeSession(session._id, razorpay_payment_id, isMock ? 'mock_signature' : razorpay_signature, 'verify');
    if (outcome === 'processing' || !order) {
      return res.status(202).json({ success: false, message: 'Your payment was received and the order is being confirmed. Please check My Orders shortly.', code: 'PROCESSING' });
    }
    await order.populate('items.product', 'name images variants');
    if (outcome === 'unfulfillable') {
      return res.status(409).json({
        success: false, code: 'PAID_OUT_OF_STOCK', data: order,
        message: 'Your payment was received, but an item went out of stock while the checkout was open. The order has been cancelled and a full refund will be arranged.',
      });
    }
    if (outcome === 'created') await sendOrderConfirmationEmail(order, req.user as any);

    res.status(200).json({ success: true, message: 'Payment verified and order placed successfully', data: order });
  } catch (error: any) {
    console.error('Error verifying payment:', error);
    res.status(500).json({ success: false, message: 'Error verifying payment' });
  }
};


// Calculate Shipping (Public Endpoint): the full checkout quote for a cart and fulfilment choice
export const calculateShipping = async (req: Request, res: Response) => {
  const { items } = req.body;
  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: 'No items to price' });
  }
  const selection = selectionFrom(req.body, false);
  if (typeof selection === 'string') return res.status(400).json({ success: false, message: selection });
  try {
    const result = await calculateShippingForItems(items, selection);
    return res.status(200).json({ success: true, data: result });
  } catch (error: any) {
    return pricingError(res, error);
  }
};

// Get My Orders
export const getMyOrders = async (req: Request, res: Response) => {
  try {
    const orders = await Order.find({ user: req.user?._id })
      .populate('items.product', 'name images')
      .sort({ createdAt: -1 });

    res.status(200).json({ success: true, data: orders });
  } catch (error: any) {
    console.error('Error fetching orders:', error);
    res.status(500).json({ success: false, message: error.message || 'Error fetching orders' });
  }
};

// Admin: Get All Orders
export const getAllOrders = async (req: Request, res: Response) => {
  try {
    const orders = await Order.find()
      .populate('user', 'name email phone')
      .populate('items.product', 'name images variants')
      .sort({ createdAt: -1 });

    res.status(200).json({ success: true, data: orders });
  } catch (error: any) {
    console.error('Error fetching all orders:', error);
    res.status(500).json({ success: false, message: error.message || 'Error fetching all orders' });
  }
};

// Admin: Update Order Status
export const updateOrderStatus = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { orderStatus } = req.body;

    if (!['processing', 'shipped', 'delivered', 'cancelled'].includes(orderStatus)) {
      return res.status(400).json({ success: false, message: 'Invalid order status' });
    }

    const order = await Order.findByIdAndUpdate(
      id,
      { orderStatus },
      { new: true, runValidators: true }
    ).populate('user', 'name email phone')
      .populate('items.product', 'name images variants');

    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    await sendOrderStatusEmail(order, orderStatus);

    res.status(200).json({ success: true, data: order });
  } catch (error: any) {
    console.error('Error updating order status:', error);
    res.status(500).json({ success: false, message: error.message || 'Error updating order status' });
  }
};

/** Emails the customer about a status change. Never throws: a mail failure must not fail the status change. */
export const sendOrderStatusEmail = async (order: any, orderStatus: string) => {
    try {
      const user = order.user as any;
      if (user && user.email) {
        const autoLoginToken = jwt.sign({ id: user._id, role: user.role || 'customer' }, ENV.JWT_SECRET, { expiresIn: '7d' });
        let statusColor = '#3b82f6'; // default blue
        let statusMessage = "There is an update regarding your recent order.";
        let subject = `Order Status Update - Luxy Galleria`;

        if (orderStatus === 'processing') {
          statusColor = '#f59e0b'; // orange
          statusMessage = "Your order has been placed successfully and is now being processed.";
          subject = `Order Placed - Luxy Galleria`;
        } else if (orderStatus === 'shipped') {
          statusColor = '#3b82f6'; // blue
          statusMessage = "Great news! Your order has been shipped and is on its way to you.";
          subject = `Order Shipped - Luxy Galleria`;
        } else if (orderStatus === 'delivered') {
          statusColor = '#10b981'; // green
          statusMessage = "Your order has been delivered successfully. We hope you enjoy your purchase!";
          subject = `Order Delivered - Luxy Galleria`;
        } else if (orderStatus === 'cancelled') {
          statusColor = '#ef4444'; // red
          statusMessage = "Your order has been cancelled. If you have been charged, a refund will be initiated shortly.";
          subject = `Order Cancelled - Luxy Galleria`;
        }

        const itemsHtml = order.items.map((item: any) => {
          const product = item.product;
          return `
            <tr>
              <td style="padding: 15px 10px; border-bottom: 1px solid #eaeaea;">
                <p style="margin: 0; font-weight: bold; color: #111827; font-size: 15px;">${product?.name || 'Product'}</p>
                <p style="margin: 5px 0 0; color: #6b7280; font-size: 13px;">Qty: ${item.quantity}</p>
              </td>
              <td style="padding: 15px 0; border-bottom: 1px solid #eaeaea; text-align: right;">
                <p style="margin: 0; font-weight: bold; color: #111827; font-size: 15px;">₹${item.price}</p>
              </td>
            </tr>
          `;
        }).join('');

        const htmlMessage = `
            <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #eaeaea; border-radius: 10px; overflow: hidden; background-color: #ffffff;">
              <div style="background-color: #111827; padding: 30px; text-align: center;">
                <h1 style="color: #ffffff; margin: 0; font-size: 24px; letter-spacing: 2px; text-transform: uppercase;">Luxy Galleria</h1>
              </div>
              <div style="padding: 40px 30px;">
                <h2 style="color: #111827; font-size: 20px; margin-top: 0; margin-bottom: 20px;">Order Status Update</h2>
                <p style="color: #4b5563; font-size: 16px; line-height: 1.6; margin-bottom: 20px;">
                  Dear <strong>${user.name}</strong>,<br><br>
                  ${statusMessage}
                </p>
                <div style="background-color: #f9fafb; border: 1px solid #f3f4f6; border-radius: 8px; padding: 20px; margin-bottom: 30px; text-align: center;">
                  <p style="margin: 0 0 10px 0; color: #374151; font-size: 15px;"><strong>Order ID:</strong> <span style="color: #111827;">${order._id}</span></p>
                  <p style="margin: 0 0 10px 0; color: #374151; font-size: 15px;"><strong>Order Date:</strong> <span style="color: #111827;">${String(new Date(order.createdAt).getDate()).padStart(2, '0')}/${String(new Date(order.createdAt).getMonth() + 1).padStart(2, '0')}/${new Date(order.createdAt).getFullYear()}</span></p>
                  <p style="margin: 0; color: #374151; font-size: 15px;">Current Status:</p>
                  <div style="display: inline-block; background-color: ${statusColor}15; color: ${statusColor}; padding: 8px 16px; border-radius: 20px; font-weight: bold; font-size: 16px; text-transform: uppercase; margin-top: 10px; border: 1px solid ${statusColor}40;">
                    ${orderStatus}
                  </div>
                </div>

                <h3 style="color: #111827; font-size: 18px; margin-bottom: 15px; border-bottom: 2px solid #f3f4f6; padding-bottom: 10px;">Order Details</h3>
                <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
                  <tbody>
                    ${itemsHtml}
                  </tbody>
                </table>
                
                <div style="background-color: #f9fafb; border-radius: 8px; padding: 20px; margin-bottom: 30px;">
                  <table style="width: 100%; border-collapse: collapse;">
                    <tr>
                      <td style="padding-bottom: 10px; color: #6b7280; font-size: 14px;">Subtotal:</td>
                      <td style="padding-bottom: 10px; color: #111827; font-weight: bold; font-size: 14px; text-align: right;">₹${order.subtotal}</td>
                    </tr>
                    ${order.discount > 0 ? `
                    <tr>
                      <td style="padding-bottom: 10px; color: #6b7280; font-size: 14px;">Discount:</td>
                      <td style="padding-bottom: 10px; color: #10b981; font-weight: bold; font-size: 14px; text-align: right;">-₹${order.discount}</td>
                    </tr>
                    ` : ''}
                    ${chargeRows(order)}
                    <tr>
                      <td style="padding-top: 15px; border-top: 1px solid #eaeaea; color: #111827; font-weight: bold; font-size: 16px;">Total:</td>
                      <td style="padding-top: 15px; border-top: 1px solid #eaeaea; color: #111827; font-weight: bold; font-size: 18px; text-align: right;">₹${order.total}</td>
                    </tr>
                  </table>
                </div>

                <p style="color: #4b5563; font-size: 15px; line-height: 1.6; margin-bottom: 30px;">
                  Thank you for shopping with Luxy Galleria. If you have any questions, feel free to reply to this email.
                </p>
                <div style="text-align: center;">
                  <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/profile?token=${autoLoginToken}" style="background-color: #111827; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: bold; font-size: 14px; display: inline-block;">View Order History</a>
                </div>
              </div>
              <div style="background-color: #f9fafb; padding: 20px; text-align: center; border-top: 1px solid #eaeaea;">
                <p style="color: #9ca3af; font-size: 13px; margin: 0;">© ${new Date().getFullYear()} Luxy Galleria. All rights reserved.</p>
              </div>
            </div>
        `;
        await sendEmail({
          email: user.email,
          subject: subject,
          html: htmlMessage
        });
      } else {
        console.warn(`Skipping email for order ${order._id} because user email is missing.`);
      }
    } catch (emailErr) {
      console.error('Error sending status update email:', emailErr);
    }
};


// Delete Order (Admin only)
export const deleteOrder = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const order = await Order.findById(id);
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    await Order.findByIdAndDelete(id);
    res.status(200).json({ success: true, message: 'Order deleted successfully', data: null });
  } catch (error: any) {
    console.error('Error deleting order:', error);
    res.status(500).json({ success: false, message: error.message || 'Error deleting order' });
  }
};

/** Constant-time check of a Razorpay webhook signature (HMAC-SHA256 of the raw request body). */
export const isValidWebhookSignature = (rawBody: Buffer, signature: string, secret: string) => {
  const expected = Buffer.from(crypto.createHmac('sha256', secret).update(rawBody).digest('hex'));
  const given = Buffer.from(String(signature));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
};

// Razorpay webhook (payment.captured / order.paid / payment.authorized): completes the order when the customer's browser
// never reached /verify (closed tab, lost network). Off unless RAZORPAY_WEBHOOK_SECRET is configured.
export const razorpayWebhook = async (req: Request, res: Response) => {
  try {
    const secret = (process.env.RAZORPAY_WEBHOOK_SECRET || '').trim();
    if (!secret) return res.status(503).json({ success: false, message: 'Webhook not configured' });
    const raw: Buffer | undefined = (req as any).rawBody;
    if (!raw || !isValidWebhookSignature(raw, req.get('x-razorpay-signature') || '', secret)) {
      return res.status(400).json({ success: false, message: 'Invalid webhook signature' });
    }
    const event = String(req.body?.event || '');
    const payment = req.body?.payload?.payment?.entity;
    if (!['payment.captured', 'order.paid', 'payment.authorized'].includes(event) || !payment?.order_id) {
      return res.status(200).json({ success: true, message: 'Event ignored' });
    }
    const session = await CheckoutSession.findOne({ razorpayOrderId: payment.order_id });
    if (!session) {
      console.warn(`Webhook ${event}: no checkout session for order ${payment.order_id} (payment ${payment.id})`);
      return res.status(200).json({ success: true, message: 'No matching checkout session' });
    }
    // Same rules as /verify; a payment that does not match is logged for reconciliation, never turned into an order
    if (!paymentMatchesSession(payment, session)) return res.status(200).json({ success: true, message: 'Payment not accepted for this session' });

    const { order, outcome } = await finalizeSession(session._id, String(payment.id), 'webhook', 'webhook');
    if (outcome === 'created' && order) {
      const user = await User.findById(order.user, { name: 1, email: 1, role: 1 }).lean();
      await order.populate('items.product', 'name images variants');
      if (user) await sendOrderConfirmationEmail(order, user as any);
    }
    // 200 for every handled delivery: Razorpay retries non-2xx, and retries are harmless (finalize is idempotent)
    return res.status(200).json({ success: true, outcome });
  } catch (error: any) {
    console.error('Error handling Razorpay webhook:', error?.message);
    return res.status(500).json({ success: false, message: 'Webhook processing failed' }); // Razorpay will retry
  }
};

const REFUNDABLE_FROM = [undefined, 'required', 'failed'];

/** Updates an order from a Razorpay refund entity. processed -> payment marked refunded. */
const applyRefundStatus = (order: any, refund: any, by: string) => {
  const status = refund.status === 'processed' ? 'processed' : refund.status === 'failed' ? 'failed' : 'pending';
  order.refund.status = status;
  order.refund.razorpayRefundId = refund.id;
  order.refund.lastError = undefined;
  order.refund.events.push({ at: new Date(), by, action: 'gateway-status', outcome: status, detail: `refund ${refund.id}` });
  if (status === 'processed') order.paymentStatus = 'refunded';
};

// Admin: full refund of an order's verified payment. Idempotent and safe to retry: an attempt whose outcome is unknown
// (timeout) is retried by first looking for a refund Razorpay already holds for this order, never by refunding twice.
export const refundOrder = async (req: Request, res: Response) => {
  try {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (reason.length < 3 || reason.length > 300) return res.status(400).json({ success: false, message: 'A refund reason (3-300 characters) is required' });
    const by = String(req.user?._id);
    const order: any = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (!order.razorpayPaymentId || order.razorpayPaymentId === 'mock_payment' || order.paymentStatus === 'pending' || order.paymentStatus === 'failed') {
      return res.status(400).json({ success: false, message: 'This order has no captured gateway payment to refund' });
    }
    if (order.paymentStatus === 'refunded' || ['pending', 'processed'].includes(order.refund?.status)) {
      return res.status(200).json({ success: true, message: 'Refund already issued', data: order.refund });
    }

    // Claim the refund atomically: two admins (or a double click) cannot both start one
    const claimed: any = await Order.findOneAndUpdate(
      { _id: order._id, $or: [{ 'refund.status': { $in: REFUNDABLE_FROM } }, { 'refund.status': 'requested', 'refund.razorpayRefundId': { $exists: false } }] },
      { $set: { 'refund.status': 'requested', 'refund.reason': reason, 'refund.amountPaise': Math.round(order.total * 100) },
        $push: { 'refund.events': { at: new Date(), by, action: 'requested', detail: reason } } },
      { new: true },
    );
    if (!claimed) return res.status(409).json({ success: false, message: 'A refund for this order is already in progress', data: order.refund });

    try {
      const payment: any = await razorpayInstance.payments.fetch(claimed.razorpayPaymentId);
      if (payment.status !== 'captured') {
        // Authorised-only payments are released by Razorpay if never captured; there is nothing to refund yet
        claimed.refund.status = 'failed';
        claimed.refund.lastError = `Payment status is "${payment.status}"; only captured payments can be refunded`;
        claimed.refund.events.push({ at: new Date(), by, action: 'refused', detail: claimed.refund.lastError });
        await claimed.save();
        return res.status(409).json({ success: false, message: claimed.refund.lastError, data: claimed.refund });
      }
      const existingList: any = await razorpayInstance.payments.fetchMultipleRefund(claimed.razorpayPaymentId, {});
      let refund = (existingList?.items || []).find((r: any) => r?.notes?.orderId === String(claimed._id));
      if (refund) {
        claimed.refund.events.push({ at: new Date(), by, action: 'adopted-existing', detail: `refund ${refund.id}` });
      } else {
        refund = await razorpayInstance.payments.refund(claimed.razorpayPaymentId, {
          amount: Math.min(Number(payment.amount), claimed.refund.amountPaise),
          receipt: `refund_${claimed._id}`,
          notes: { orderId: String(claimed._id), reason: reason.slice(0, 250) },
        } as any);
      }
      applyRefundStatus(claimed, refund, by);
      await claimed.save();
      return res.status(200).json({ success: true, message: 'Refund submitted', data: claimed.refund });
    } catch (err: any) {
      // Outcome unknown (e.g. timeout): stay "requested" without a refund id, so a retry first checks Razorpay
      const detail = String(err?.error?.description || err?.message || err).slice(0, 300);
      await Order.updateOne({ _id: claimed._id }, { $set: { 'refund.lastError': detail }, $push: { 'refund.events': { at: new Date(), by, action: 'error', detail } } });
      return res.status(502).json({ success: false, message: 'The refund could not be confirmed with the payment gateway. Retrying is safe.', code: 'REFUND_UNCONFIRMED' });
    }
  } catch (error: any) {
    console.error('Error refunding order:', error?.message);
    res.status(500).json({ success: false, message: 'Error refunding order' });
  }
};

// Admin: reconciliation. Releases stock from expired sessions, turns payments Razorpay holds for open sessions into
// orders (or flags them), and refreshes the status of submitted refunds. Safe to run repeatedly.
export const reconcilePayments = async (req: Request, res: Response) => {
  try {
    const summary = { expiredSessions: 0, recoveredOrders: [] as string[], unfulfillable: [] as string[], mismatchedPayments: [] as string[], refundsUpdated: 0, errors: [] as string[] };
    summary.expiredSessions = await expireStaleSessions();

    const since = new Date(Date.now() - 7 * 86_400_000);
    const open = await CheckoutSession.find({ isMock: false, status: { $in: ['pending', 'expired', 'processing'] }, createdAt: { $gte: since } }).limit(200);
    for (const s of open) {
      try {
        const list: any = await razorpayInstance.orders.fetchPayments(s.razorpayOrderId);
        const paid = (list?.items || []).filter((p: any) => ['authorized', 'captured'].includes(p.status));
        const match = paid.find((p: any) => paymentMatchesSession(p, s));
        if (match) {
          const { order, outcome } = await finalizeSession(s._id, String(match.id), 'reconciled', 'reconcile');
          if (order && outcome === 'created') summary.recoveredOrders.push(String(order._id));
          if (order && outcome === 'unfulfillable') summary.unfulfillable.push(String(order._id));
        } else if (paid.length) {
          summary.mismatchedPayments.push(...paid.map((p: any) => String(p.id))); // money taken but not for this quote: refund manually
        }
      } catch (err: any) {
        summary.errors.push(`${s.razorpayOrderId}: ${String(err?.message || err).slice(0, 120)}`);
      }
    }

    const refunding: any[] = await Order.find({ 'refund.status': 'pending', 'refund.razorpayRefundId': { $exists: true } }).limit(200);
    for (const o of refunding) {
      try {
        const refund: any = await razorpayInstance.payments.fetchRefund(o.razorpayPaymentId, o.refund.razorpayRefundId);
        if (refund?.status && refund.status !== 'pending') { applyRefundStatus(o, refund, 'reconcile'); await o.save(); summary.refundsUpdated++; }
      } catch (err: any) {
        summary.errors.push(`refund ${o.refund.razorpayRefundId}: ${String(err?.message || err).slice(0, 120)}`);
      }
    }
    res.status(200).json({ success: true, data: summary });
  } catch (error: any) {
    console.error('Error reconciling payments:', error?.message);
    res.status(500).json({ success: false, message: 'Error reconciling payments' });
  }
};
