import { Router } from 'express';
import { protect, adminOnly } from '../middlewares/authMiddleware';
import { readImage } from '../controllers/erpController';
import { consoleStatus, requireConsole, forwardToErp } from '../controllers/erpConsoleController';

// Admin-only mirror of the seven ERP routes (see controllers/erpConsoleController.ts). Only these routes exist.
const router = Router();
router.use(protect, adminOnly);

router.get('/status', consoleStatus);
router.put('/stock/:sku', requireConsole, forwardToErp);
router.post('/items', requireConsole, forwardToErp);
router.patch('/items/:sku', requireConsole, forwardToErp);
router.get('/orders', requireConsole, forwardToErp);
router.get('/orders/:orderId', requireConsole, forwardToErp);
router.post('/webhooks/order-status', requireConsole, forwardToErp);
router.post('/images', requireConsole, readImage, forwardToErp);

export default router;
