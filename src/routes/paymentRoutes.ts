import express from 'express';
import { createOrder, verifyPayment, getMyOrders, getAllOrders, updateOrderStatus, deleteOrder, calculateShipping, razorpayWebhook, refundOrder, reconcilePayments } from '../controllers/paymentController';
import { protect, authorize } from '../middlewares/authMiddleware';
import { paymentLimiter } from '../middlewares/rateLimiter';

const router = express.Router();

router.post('/calculate-shipping', calculateShipping);
// Server-to-server from Razorpay; authenticated by its HMAC signature (no user token)
router.post('/webhook', razorpayWebhook);
router.post('/create-order', paymentLimiter, protect, createOrder);
router.post('/verify', paymentLimiter, protect, verifyPayment);
router.get('/myorders', protect, getMyOrders);

// Admin routes
router.get('/admin/orders', protect, authorize('admin', 'superadmin'), getAllOrders);
router.put('/admin/orders/:id/status', protect, authorize('admin', 'superadmin'), updateOrderStatus);
router.delete('/admin/orders/:id', protect, authorize('admin', 'superadmin'), deleteOrder);
// Money movements: super admin only
router.post('/admin/orders/:id/refund', protect, authorize('superadmin'), refundOrder);
router.post('/admin/reconcile', protect, authorize('superadmin'), reconcilePayments);

export default router;
