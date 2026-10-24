import express from 'express';
import { getDashboardStats, getHistoryOrders, getHistoryCustomers } from '../controllers/dashboardController';
import { protect, authorize } from '../middlewares/authMiddleware';

const router = express.Router();

router.get('/stats', protect, authorize('admin', 'superadmin'), getDashboardStats);
// Read-only production history (local development only; see config/historyDb.ts). No write routes exist for history.
router.get('/history/orders', protect, authorize('admin', 'superadmin'), getHistoryOrders);
router.get('/history/customers', protect, authorize('admin', 'superadmin'), getHistoryCustomers);

export default router;
