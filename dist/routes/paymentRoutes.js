"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const paymentController_1 = require("../controllers/paymentController");
const iciciController_1 = require("../controllers/iciciController");
const authMiddleware_1 = require("../middlewares/authMiddleware");
const rateLimiter_1 = require("../middlewares/rateLimiter");
const router = express_1.default.Router();
router.post('/calculate-shipping', paymentController_1.calculateShipping);
// Server-to-server from Razorpay; authenticated by its HMAC signature (no user token)
router.post('/webhook', paymentController_1.razorpayWebhook);
router.post('/create-order', rateLimiter_1.paymentLimiter, authMiddleware_1.protect, paymentController_1.createOrder);
router.post('/verify', rateLimiter_1.paymentLimiter, authMiddleware_1.protect, paymentController_1.verifyPayment);
router.get('/myorders', authMiddleware_1.protect, paymentController_1.getMyOrders);
// ICICI Orange PG. callback / advices come from ICICI (browser form post, server-to-server): no user token and no
// CORS (app.ts); each is authenticated by its secureHash.
router.post('/icici/initiate', rateLimiter_1.paymentLimiter, authMiddleware_1.protect, iciciController_1.iciciInitiate);
router.post('/icici/callback', iciciController_1.iciciCallback);
router.post('/icici/payment-advice', iciciController_1.iciciPaymentAdvice);
router.post('/icici/settlement-advice', iciciController_1.iciciSettlementAdvice);
router.post('/icici/status', rateLimiter_1.paymentLimiter, authMiddleware_1.protect, iciciController_1.iciciStatus);
router.post('/icici/refund', authMiddleware_1.protect, (0, authMiddleware_1.authorize)('superadmin'), iciciController_1.iciciRefund);
// Admin routes
router.get('/admin/orders', authMiddleware_1.protect, (0, authMiddleware_1.authorize)('admin', 'superadmin'), paymentController_1.getAllOrders);
router.put('/admin/orders/:id/status', authMiddleware_1.protect, (0, authMiddleware_1.authorize)('admin', 'superadmin'), paymentController_1.updateOrderStatus);
router.delete('/admin/orders/:id', authMiddleware_1.protect, (0, authMiddleware_1.authorize)('admin', 'superadmin'), paymentController_1.deleteOrder);
// Money movements: super admin only
router.post('/admin/orders/:id/refund', authMiddleware_1.protect, (0, authMiddleware_1.authorize)('superadmin'), paymentController_1.refundOrder);
router.post('/admin/reconcile', authMiddleware_1.protect, (0, authMiddleware_1.authorize)('superadmin'), paymentController_1.reconcilePayments);
// Audited correction of a status the forward-only rule refuses
router.post('/admin/orders/:id/status-correction', authMiddleware_1.protect, (0, authMiddleware_1.authorize)('superadmin'), paymentController_1.correctOrderStatus);
exports.default = router;
//# sourceMappingURL=paymentRoutes.js.map