"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const dashboardController_1 = require("../controllers/dashboardController");
const authMiddleware_1 = require("../middlewares/authMiddleware");
const router = express_1.default.Router();
router.get('/stats', authMiddleware_1.protect, (0, authMiddleware_1.authorize)('admin', 'superadmin'), dashboardController_1.getDashboardStats);
// Read-only production history (local development only; see config/historyDb.ts). No write routes exist for history.
router.get('/history/orders', authMiddleware_1.protect, (0, authMiddleware_1.authorize)('admin', 'superadmin'), dashboardController_1.getHistoryOrders);
router.get('/history/customers', authMiddleware_1.protect, (0, authMiddleware_1.authorize)('admin', 'superadmin'), dashboardController_1.getHistoryCustomers);
exports.default = router;
//# sourceMappingURL=dashboardRoutes.js.map