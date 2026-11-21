import express from 'express';
import { createOrder, verifyPayment, getMyOrders, getAllOrders, updateOrderStatus, correctOrderStatus, deleteOrder, calculateShipping, razorpayWebhook, refundOrder, reconcilePayments } from '../controllers/paymentController';
import { iciciInitiate, iciciCallback, iciciPaymentAdvice, iciciSettlementAdvice, iciciStatus, iciciRefund } from '../controllers/iciciController';
import { protect, authorize } from '../middlewares/authMiddleware';
import { paymentLimiter } from '../middlewares/rateLimiter';

const router = express.Router();

router.post('/calculate-shipping', calculateShipping);
// Server-to-server from Razorpay; authenticated by its HMAC signature (no user token)
router.post('/webhook', razorpayWebhook);
router.post('/create-order', paymentLimiter, protect, createOrder);
router.post('/verify', paymentLimiter, protect, verifyPayment);
router.get('/myorders', protect, getMyOrders);

// ICICI Orange PG. callback / advices come from ICICI (browser form post, server-to-server): no user token and no
// CORS (app.ts); each is authenticated by its secureHash.
router.post('/icici/initiate', paymentLimiter, protect, iciciInitiate);
router.post('/icici/callback', iciciCallback);
router.get('/icici/callback', iciciCallback); // a result returned on the URL instead of a form post
router.post('/icici/payment-advice', iciciPaymentAdvice);
router.post('/icici/settlement-advice', iciciSettlementAdvice);
router.post('/icici/status', paymentLimiter, protect, iciciStatus);
router.post('/icici/refund', protect, authorize('superadmin'), iciciRefund);

// Admin routes
router.get('/admin/orders', protect, authorize('admin', 'superadmin'), getAllOrders);
router.put('/admin/orders/:id/status', protect, authorize('admin', 'superadmin'), updateOrderStatus);
router.delete('/admin/orders/:id', protect, authorize('admin', 'superadmin'), deleteOrder);
// Money movements: super admin only
router.post('/admin/orders/:id/refund', protect, authorize('superadmin'), refundOrder);
router.post('/admin/reconcile', protect, authorize('superadmin'), reconcilePayments);
// Audited correction of a status the forward-only rule refuses
router.post('/admin/orders/:id/status-correction', protect, authorize('superadmin'), correctOrderStatus);

export default router;
