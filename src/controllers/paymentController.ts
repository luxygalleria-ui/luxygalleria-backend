import { Request, Response } from 'express';
import Razorpay from 'razorpay';
import crypto from 'crypto';
import Order from '../models/Order';
import { Product } from '../models/Product';
import { Settings } from '../models/Settings';
import { sendEmail } from '../utils/sendEmail';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import { calculateShippingForItems } from '../utils/shippingCalculator';
dotenv.config();

const razorpayInstance = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || 'dummy_key_id',
  key_secret: process.env.RAZORPAY_KEY_SECRET || 'dummy_key_secret',
});

// Create Order — Only creates a Razorpay order, does NOT save to DB yet
export const createOrder = async (req: Request, res: Response) => {
  try {
    const { total, items } = req.body;

    if (typeof total !== 'number' || Number.isNaN(total) || total <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid order total. Please refresh and try again.' });
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'No items in order to validate.' });
    }

    // Server-side amount validation
    let totals;
    try {
      totals = await calculateShippingForItems(items);
    } catch (err: any) {
      return res.status(400).json({ success: false, message: err.message || 'Validation failed' });
    }

    // Allow a small margin of error (e.g. 1 INR) for rounding differences
    if (Math.abs(totals.grandTotal - total) > 1) {
      return res.status(400).json({ 
        success: false, 
        message: `Order total validation failed. Server calculated total of ${totals.grandTotal} differs from client total of ${total}. Please refresh and try again.` 
      });
    }

    let razorpayOrder;
    let isMock = false;

    const missingRazorpayConfig = 
      !process.env.RAZORPAY_KEY_ID || 
      process.env.RAZORPAY_KEY_ID === 'dummy_key_id' || 
      process.env.RAZORPAY_KEY_ID === 'YOUR_RAZORPAY_KEY_ID' ||
      process.env.RAZORPAY_KEY_ID.startsWith('rzp_test_Luxy') || // Our placeholder test keys
      !process.env.RAZORPAY_KEY_SECRET || 
      process.env.RAZORPAY_KEY_SECRET === 'dummy_key_secret' ||
      process.env.RAZORPAY_KEY_SECRET === 'YOUR_RAZORPAY_KEY_SECRET' ||
      process.env.RAZORPAY_KEY_SECRET.startsWith('LuxySecret'); // Our placeholder secret

    // Use mock order in development or when Razorpay credentials are missing
    if (missingRazorpayConfig || total < 1) {
      razorpayOrder = {
        id: `mock_order_${Date.now()}`,
        amount: Math.round(total * 100),
        currency: 'INR'
      };
      isMock = true;
    } else {
      const options = {
        amount: Math.round(total * 100),
        currency: "INR",
        receipt: `receipt_order_${Date.now()}`
      };
      razorpayOrder = await razorpayInstance.orders.create(options);
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

  } catch (error: any) {
    console.error('Error creating order:', error);
    res.status(500).json({ success: false, message: error.message || 'Error creating order' });
  }
};

// Verify Payment — Saves order to DB only after payment is confirmed
export const verifyPayment = async (req: Request, res: Response) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      items,
      shippingAddress,
      subtotal,
      discount,
      shippingFee,
      total,
    } = req.body;

    // Validate required fields
    if (!razorpay_order_id || !razorpay_payment_id) {
      return res.status(400).json({ success: false, message: 'Missing payment details' });
    }

    if (!items || items.length === 0) {
      return res.status(400).json({ success: false, message: 'No items in order' });
    }

    if (!req.user || !req.user._id) {
      return res.status(401).json({ success: false, message: 'User not authenticated' });
    }

    // Server-side amount validation before saving order
    let totals;
    try {
      totals = await calculateShippingForItems(items);
    } catch (err: any) {
      return res.status(400).json({ success: false, message: err.message || 'Validation failed' });
    }

    if (Math.abs(totals.grandTotal - total) > 1) {
      return res.status(400).json({ success: false, message: 'Order totals verification failed. Server calculation mismatch.' });
    }

    let paymentVerified = false;

    if (razorpay_payment_id === 'mock_payment') {
      paymentVerified = true;
    } else {
      if (!razorpay_signature) {
        return res.status(400).json({ success: false, message: 'Missing payment signature' });
      }
      const sign = razorpay_order_id + "|" + razorpay_payment_id;
      const expectedSign = crypto
        .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET || 'dummy_key_secret')
        .update(sign.toString())
        .digest("hex");

      try {
        const signatureBuffer = Buffer.from(razorpay_signature, 'hex');
        const expectedBuffer = Buffer.from(expectedSign, 'hex');
        if (signatureBuffer.length === expectedBuffer.length) {
          paymentVerified = crypto.timingSafeEqual(signatureBuffer, expectedBuffer);
        } else {
          paymentVerified = false;
        }
      } catch (err) {
        paymentVerified = false;
      }
    }

    if (paymentVerified) {
      // Payment confirmed — 
      const newOrder = new Order({
        user: req.user._id,
        items,
        shippingAddress,
        subtotal: totals.subtotal,
        discount: discount || 0,
        shippingFee: totals.shipping,
        total: totals.grandTotal,
        paymentMethod: 'razorpay',
        paymentStatus: 'completed',
        orderStatus: 'processing',
        razorpayOrderId: razorpay_order_id,
        razorpayPaymentId: razorpay_payment_id,
        razorpaySignature: razorpay_payment_id === 'mock_payment' ? 'mock_signature' : razorpay_signature,
      });

      await newOrder.save();
      await newOrder.populate('items.product', 'name images variants');

      // Reduce stock for each product
      try {
        for (const item of items) {
          const product = await Product.findById(item.product);
          if (product) {
            product.stock = Math.max(0, (product.stock || 0) - item.quantity);
            await product.save();
          }
        }
      } catch (stockErr) {
        console.error('Error reducing stock:', stockErr);
      }

      // Send Order Confirmation Email
      try {
        if (req.user && req.user.email) {
          const autoLoginToken = jwt.sign({ id: req.user._id, role: (req.user as any).role || 'customer' }, process.env.JWT_SECRET || 'secret', { expiresIn: '7d' });

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
          await sendEmail({
            email: req.user.email,
            subject: 'Order Confirmation - Luxy Galleria',
            html: htmlMessage
          });
        }
      } catch (emailErr) {
        console.error('Error sending confirmation email:', emailErr);
        // Don't fail the order if email fails
      }

      res.status(200).json({
        success: true,
        message: "Payment verified and order placed successfully",
        data: newOrder
      });
    } else {
      res.status(400).json({ success: false, message: "Invalid signature. Payment verification failed." });
    }
  } catch (error: any) {
    console.error('Error verifying payment:', error);
    res.status(500).json({ success: false, message: error.message || 'Error verifying payment' });
  }
};

// Calculate Shipping (Public Endpoint)
export const calculateShipping = async (req: Request, res: Response) => {
  try {
    const { items } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(200).json({
        success: true,
        data: {
          subtotal: 0,
          totalWeight: 0,
          baseShipping: 0,
          extraWeightCharge: 0,
          shipping: 0,
          grandTotal: 0
        }
      });
    }

    const result = await calculateShippingForItems(items);

    return res.status(200).json({
      success: true,
      data: result
    });
  } catch (error: any) {
    console.error('Error calculating shipping:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Error calculating shipping'
    });
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

    const order = await Order.findByIdAndUpdate(
      id,
      { orderStatus },
      { new: true }
    ).populate('user', 'name email phone')
      .populate('items.product', 'name images variants');

    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    // Send Status Update Email
    try {
      const user = order.user as any;
      if (user && user.email) {
        const autoLoginToken = jwt.sign({ id: user._id, role: user.role || 'customer' }, process.env.JWT_SECRET || 'secret', { expiresIn: '7d' });
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

    res.status(200).json({ success: true, data: order });
  } catch (error: any) {
    console.error('Error updating order status:', error);
    res.status(500).json({ success: false, message: error.message || 'Error updating order status' });
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
