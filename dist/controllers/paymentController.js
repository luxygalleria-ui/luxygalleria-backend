"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteOrder = exports.updateOrderStatus = exports.getAllOrders = exports.getMyOrders = exports.calculateShipping = exports.verifyPayment = exports.createOrder = exports.isValidRazorpaySignature = exports.isMockPaymentMode = exports.razorpayInstance = void 0;
const razorpay_1 = __importDefault(require("razorpay"));
const crypto_1 = __importDefault(require("crypto"));
const Order_1 = __importDefault(require("../models/Order"));
const Product_1 = require("../models/Product");
const sendEmail_1 = require("../utils/sendEmail");
const dotenv_1 = __importDefault(require("dotenv"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const env_1 = require("../config/env");
const shippingCalculator_1 = require("../utils/shippingCalculator");
dotenv_1.default.config();
exports.razorpayInstance = new razorpay_1.default({
    key_id: (process.env.RAZORPAY_KEY_ID || 'dummy_key_id').trim(),
    key_secret: (process.env.RAZORPAY_KEY_SECRET || 'dummy_key_secret').trim(),
});
const razorpayKeysMissing = () => !process.env.RAZORPAY_KEY_ID ||
    process.env.RAZORPAY_KEY_ID === 'dummy_key_id' ||
    process.env.RAZORPAY_KEY_ID === 'YOUR_RAZORPAY_KEY_ID' ||
    process.env.RAZORPAY_KEY_ID.startsWith('rzp_test_Luxy') || // Our placeholder test keys
    !process.env.RAZORPAY_KEY_SECRET ||
    process.env.RAZORPAY_KEY_SECRET === 'dummy_key_secret' ||
    process.env.RAZORPAY_KEY_SECRET === 'YOUR_RAZORPAY_KEY_SECRET' ||
    process.env.RAZORPAY_KEY_SECRET.startsWith('LuxySecret'); // Our placeholder secret
/** Mock payments exist only for local development without Razorpay keys — never anywhere else. */
const isMockPaymentMode = () => env_1.ENV.NODE_ENV === 'development' && razorpayKeysMissing();
exports.isMockPaymentMode = isMockPaymentMode;
/** Constant-time compare of the Razorpay HMAC signature. */
const isValidRazorpaySignature = (orderId, paymentId, signature, secret) => {
    const expected = crypto_1.default.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(String(signature));
    return a.length === b.length && crypto_1.default.timingSafeEqual(a, b);
};
exports.isValidRazorpaySignature = isValidRazorpaySignature;
// Create Order — Only creates a Razorpay order, does NOT save to DB yet
const createOrder = async (req, res) => {
    try {
        const { total, items, shippingAddress } = req.body;
        // Refuse to start a payment without a deliverable address
        if (!shippingAddress?.city?.trim?.() || !shippingAddress?.state?.trim?.() || !shippingAddress?.zipCode?.trim?.()) {
            return res.status(400).json({ success: false, message: 'Please select or add a shipping address' });
        }
        if (typeof total !== 'number' || Number.isNaN(total) || total <= 0) {
            return res.status(400).json({ success: false, message: 'Invalid order total. Please refresh and try again.' });
        }
        if (!items || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ success: false, message: 'No items in order to validate.' });
        }
        // Server-side amount validation
        let totals;
        try {
            totals = await (0, shippingCalculator_1.calculateShippingForItems)(items);
        }
        catch (err) {
            return res.status(400).json({ success: false, message: err.message || 'Validation failed' });
        }
        // Allow a small margin of error (e.g. 1 INR) for rounding differences
        if (Math.abs(totals.grandTotal - total) > 1) {
            return res.status(400).json({
                success: false,
                message: `Order total validation failed. Server calculated total of ${totals.grandTotal} differs from client total of ${total}. Please refresh and try again.`
            });
        }
        // Refuse before payment rather than oversell after it
        const wanted = new Map();
        for (const line of totals.lines) {
            const w = wanted.get(line.variantId) || { qty: 0, stock: line.stock, name: line.name };
            w.qty += line.quantity;
            wanted.set(line.variantId, w);
        }
        for (const w of wanted.values()) {
            if (w.qty > w.stock) {
                return res.status(400).json({ success: false, message: `Only ${Math.max(0, w.stock)} of ${w.name} left in stock` });
            }
        }
        let razorpayOrder;
        let isMock = false;
        if ((0, exports.isMockPaymentMode)()) {
            razorpayOrder = {
                id: `mock_order_${Date.now()}`,
                amount: Math.round(totals.grandTotal * 100),
                currency: 'INR'
            };
            isMock = true;
        }
        else if (razorpayKeysMissing()) {
            console.error('Razorpay keys are not configured; refusing to create a payment');
            return res.status(503).json({ success: false, message: 'Payments are temporarily unavailable' });
        }
        else {
            const options = {
                // Charge the server-calculated amount, never the client's number
                amount: Math.round(totals.grandTotal * 100),
                currency: "INR",
                receipt: `receipt_order_${Date.now()}`
            };
            razorpayOrder = await exports.razorpayInstance.orders.create(options);
        }
        // No DB save here — order saved only after payment verified
        res.status(200).json({
            success: true,
            data: {
                razorpayOrder,
                isMock,
                key_id: process.env.RAZORPAY_KEY_ID || process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || 'rzp_test_YourTestKey' // Return the key used to generate the order to prevent mismatch
            }
        });
    }
    catch (error) {
        console.error('Error creating order:', error);
        res.status(500).json({ success: false, message: 'Error creating order' });
    }
};
exports.createOrder = createOrder;
// Verify Payment — Saves order to DB only after payment is confirmed
const verifyPayment = async (req, res) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature, items, shippingAddress, } = req.body;
        if (!req.user || !req.user._id) {
            return res.status(401).json({ success: false, message: 'User not authenticated' });
        }
        if (typeof razorpay_order_id !== 'string' || typeof razorpay_payment_id !== 'string' || !razorpay_order_id || !razorpay_payment_id) {
            return res.status(400).json({ success: false, message: 'Missing payment details' });
        }
        if (!Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ success: false, message: 'No items in order' });
        }
        // Idempotent: a payment can create at most one order (double clicks, retries, replays)
        const existing = await Order_1.default.findOne({ $or: [{ razorpayPaymentId: razorpay_payment_id }, { razorpayOrderId: razorpay_order_id }] })
            .populate('items.product', 'name images variants');
        if (existing) {
            if (existing.user.toString() === req.user._id.toString() && existing.razorpayPaymentId === razorpay_payment_id) {
                return res.status(200).json({ success: true, message: 'Order already placed for this payment', data: existing });
            }
            return res.status(409).json({ success: false, message: 'This payment has already been used' });
        }
        // Server-side amount validation before saving order — prices come from the DB only
        let totals;
        try {
            totals = await (0, shippingCalculator_1.calculateShippingForItems)(items);
        }
        catch (err) {
            return res.status(400).json({ success: false, message: err.message || 'Validation failed' });
        }
        let paymentVerified = false;
        const isMock = razorpay_payment_id === 'mock_payment';
        if (isMock) {
            // Only ever honoured in local development without Razorpay keys
            paymentVerified = (0, exports.isMockPaymentMode)() && razorpay_order_id.startsWith('mock_order_');
        }
        else {
            if (!razorpay_signature) {
                return res.status(400).json({ success: false, message: 'Missing payment signature' });
            }
            const keySecret = (process.env.RAZORPAY_KEY_SECRET || '').trim();
            if (keySecret && (0, exports.isValidRazorpaySignature)(razorpay_order_id, razorpay_payment_id, razorpay_signature, keySecret)) {
                // The signature proves the payment belongs to the order; Razorpay tells us what was actually paid.
                const payment = await exports.razorpayInstance.payments.fetch(razorpay_payment_id);
                paymentVerified =
                    payment.order_id === razorpay_order_id &&
                        ['authorized', 'captured'].includes(payment.status) &&
                        payment.currency === 'INR' &&
                        // Paid at least the current cart value (₹1 rounding slack, as above)
                        Number(payment.amount) >= Math.round(totals.grandTotal * 100) - 100;
                if (!paymentVerified) {
                    console.warn(`Payment ${razorpay_payment_id} rejected: status/amount does not match cart`);
                }
            }
        }
        if (paymentVerified) {
            // Payment confirmed — 
            const orderItems = totals.lines.map((line, i) => ({
                product: line.product,
                variantId: line.variantId,
                quantity: line.quantity,
                price: line.price,
                size: typeof items[i].size === 'string' ? items[i].size : undefined,
                image: typeof items[i].image === 'string' ? items[i].image : undefined,
                subtotal: line.price * line.quantity,
            }));
            const newOrder = new Order_1.default({
                user: req.user._id,
                items: orderItems,
                shippingAddress,
                subtotal: totals.subtotal,
                discount: 0, // No server-side discount is applied to the charged total
                shippingFee: totals.shipping,
                total: totals.grandTotal,
                paymentMethod: 'razorpay',
                paymentStatus: 'completed',
                orderStatus: 'processing',
                razorpayOrderId: razorpay_order_id,
                razorpayPaymentId: razorpay_payment_id,
                razorpaySignature: isMock ? 'mock_signature' : razorpay_signature,
            });
            await newOrder.save();
            await newOrder.populate('items.product', 'name images variants');
            // Reduce stock atomically so concurrent orders can't both read the same count
            for (const line of totals.lines) {
                try {
                    const r = await Product_1.Product.updateOne({ _id: line.product, variants: { $elemMatch: { _id: line.variantId, stock: { $gte: line.quantity } } } }, { $inc: { 'variants.$.stock': -line.quantity, stock: -line.quantity } });
                    if (!r.modifiedCount) {
                        console.warn(`Stock short for order ${newOrder._id}: product ${line.product} variant ${line.variantId}`);
                    }
                }
                catch (stockErr) {
                    console.error('Error reducing stock:', stockErr);
                }
            }
            // Send Order Confirmation Email
            try {
                if (req.user && req.user.email) {
                    const autoLoginToken = jsonwebtoken_1.default.sign({ id: req.user._id, role: req.user.role || 'customer' }, env_1.ENV.JWT_SECRET, { expiresIn: '7d' });
                    const itemsHtml = newOrder.items.map((item) => {
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
                  Dear <strong>${req.user.name}</strong>,<br><br>
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
                    <tr>
                      <td style="padding-bottom: 15px; color: #6b7280; font-size: 14px;">Shipping:</td>
                      <td style="padding-bottom: 15px; color: #111827; font-weight: bold; font-size: 14px; text-align: right;">${newOrder.shippingFee > 0 ? `₹${newOrder.shippingFee}` : 'Free'}</td>
                    </tr>
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
                    await (0, sendEmail_1.sendEmail)({
                        email: req.user.email,
                        subject: 'Order Confirmation - Luxy Galleria',
                        html: htmlMessage
                    });
                }
            }
            catch (emailErr) {
                console.error('Error sending confirmation email:', emailErr);
                // Don't fail the order if email fails
            }
            res.status(200).json({
                success: true,
                message: "Payment verified and order placed successfully",
                data: newOrder
            });
        }
        else {
            res.status(400).json({ success: false, message: "Invalid signature. Payment verification failed." });
        }
    }
    catch (error) {
        console.error('Error verifying payment:', error);
        res.status(500).json({ success: false, message: 'Error verifying payment' });
    }
};
exports.verifyPayment = verifyPayment;
// Calculate Shipping (Public Endpoint)
const calculateShipping = async (req, res) => {
    try {
        const { items } = req.body;
        if (!items || !Array.isArray(items) || items.length === 0) {
            // Delegate so the empty-cart shape can never drift from the real one.
            return res.status(200).json({
                success: true,
                data: (0, shippingCalculator_1.calculateShippingPure)([])
            });
        }
        const result = await (0, shippingCalculator_1.calculateShippingForItems)(items);
        return res.status(200).json({
            success: true,
            data: result
        });
    }
    catch (error) {
        console.error('Error calculating shipping:', error);
        return res.status(500).json({
            success: false,
            message: error.message || 'Error calculating shipping'
        });
    }
};
exports.calculateShipping = calculateShipping;
// Get My Orders
const getMyOrders = async (req, res) => {
    try {
        const orders = await Order_1.default.find({ user: req.user?._id })
            .populate('items.product', 'name images')
            .sort({ createdAt: -1 });
        res.status(200).json({ success: true, data: orders });
    }
    catch (error) {
        console.error('Error fetching orders:', error);
        res.status(500).json({ success: false, message: error.message || 'Error fetching orders' });
    }
};
exports.getMyOrders = getMyOrders;
// Admin: Get All Orders
const getAllOrders = async (req, res) => {
    try {
        const orders = await Order_1.default.find()
            .populate('user', 'name email phone')
            .populate('items.product', 'name images variants')
            .sort({ createdAt: -1 });
        res.status(200).json({ success: true, data: orders });
    }
    catch (error) {
        console.error('Error fetching all orders:', error);
        res.status(500).json({ success: false, message: error.message || 'Error fetching all orders' });
    }
};
exports.getAllOrders = getAllOrders;
// Admin: Update Order Status
const updateOrderStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { orderStatus } = req.body;
        if (!['processing', 'shipped', 'delivered', 'cancelled'].includes(orderStatus)) {
            return res.status(400).json({ success: false, message: 'Invalid order status' });
        }
        const order = await Order_1.default.findByIdAndUpdate(id, { orderStatus }, { new: true, runValidators: true }).populate('user', 'name email phone')
            .populate('items.product', 'name images variants');
        if (!order) {
            return res.status(404).json({ success: false, message: 'Order not found' });
        }
        // Send Status Update Email
        try {
            const user = order.user;
            if (user && user.email) {
                const autoLoginToken = jsonwebtoken_1.default.sign({ id: user._id, role: user.role || 'customer' }, env_1.ENV.JWT_SECRET, { expiresIn: '7d' });
                let statusColor = '#3b82f6'; // default blue
                let statusMessage = "There is an update regarding your recent order.";
                let subject = `Order Status Update - Luxy Galleria`;
                if (orderStatus === 'processing') {
                    statusColor = '#f59e0b'; // orange
                    statusMessage = "Your order has been placed successfully and is now being processed.";
                    subject = `Order Placed - Luxy Galleria`;
                }
                else if (orderStatus === 'shipped') {
                    statusColor = '#3b82f6'; // blue
                    statusMessage = "Great news! Your order has been shipped and is on its way to you.";
                    subject = `Order Shipped - Luxy Galleria`;
                }
                else if (orderStatus === 'delivered') {
                    statusColor = '#10b981'; // green
                    statusMessage = "Your order has been delivered successfully. We hope you enjoy your purchase!";
                    subject = `Order Delivered - Luxy Galleria`;
                }
                else if (orderStatus === 'cancelled') {
                    statusColor = '#ef4444'; // red
                    statusMessage = "Your order has been cancelled. If you have been charged, a refund will be initiated shortly.";
                    subject = `Order Cancelled - Luxy Galleria`;
                }
                const itemsHtml = order.items.map((item) => {
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
                    <tr>
                      <td style="padding-bottom: 15px; color: #6b7280; font-size: 14px;">Shipping:</td>
                      <td style="padding-bottom: 15px; color: #111827; font-weight: bold; font-size: 14px; text-align: right;">${order.shippingFee > 0 ? `₹${order.shippingFee}` : 'Free'}</td>
                    </tr>
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
                await (0, sendEmail_1.sendEmail)({
                    email: user.email,
                    subject: subject,
                    html: htmlMessage
                });
            }
            else {
                console.warn(`Skipping email for order ${order._id} because user email is missing.`);
            }
        }
        catch (emailErr) {
            console.error('Error sending status update email:', emailErr);
        }
        res.status(200).json({ success: true, data: order });
    }
    catch (error) {
        console.error('Error updating order status:', error);
        res.status(500).json({ success: false, message: error.message || 'Error updating order status' });
    }
};
exports.updateOrderStatus = updateOrderStatus;
// Delete Order (Admin only)
const deleteOrder = async (req, res) => {
    try {
        const { id } = req.params;
        const order = await Order_1.default.findById(id);
        if (!order) {
            return res.status(404).json({ success: false, message: 'Order not found' });
        }
        await Order_1.default.findByIdAndDelete(id);
        res.status(200).json({ success: true, message: 'Order deleted successfully', data: null });
    }
    catch (error) {
        console.error('Error deleting order:', error);
        res.status(500).json({ success: false, message: error.message || 'Error deleting order' });
    }
};
exports.deleteOrder = deleteOrder;
//# sourceMappingURL=paymentController.js.map