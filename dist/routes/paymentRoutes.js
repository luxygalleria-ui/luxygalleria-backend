"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const paymentController_1 = require("../controllers/paymentController");
const authMiddleware_1 = require("../middlewares/authMiddleware");
const router = express_1.default.Router();
router.post('/calculate-shipping', paymentController_1.calculateShipping);
router.post('/create-order', authMiddleware_1.protect, paymentController_1.createOrder);
router.post('/verify', authMiddleware_1.protect, paymentController_1.verifyPayment);
router.get('/myorders', authMiddleware_1.protect, paymentController_1.getMyOrders);
// Admin routes
router.get('/admin/orders', authMiddleware_1.protect, (0, authMiddleware_1.authorize)('admin', 'superadmin'), paymentController_1.getAllOrders);
router.put('/admin/orders/:id/status', authMiddleware_1.protect, (0, authMiddleware_1.authorize)('admin', 'superadmin'), paymentController_1.updateOrderStatus);
router.delete('/admin/orders/:id', authMiddleware_1.protect, (0, authMiddleware_1.authorize)('admin', 'superadmin'), paymentController_1.deleteOrder);
exports.default = router;
//# sourceMappingURL=paymentRoutes.js.map