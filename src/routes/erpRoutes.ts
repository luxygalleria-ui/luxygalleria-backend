import { Router } from 'express';
import { erpLimiter } from '../middlewares/rateLimiter';
import { erpAuth, erpHeaders, erpSignature } from '../middlewares/erpAuth';
import {
  updateStock, upsertItem, patchItem, listOrders, getOrder, orderStatusWebhook, readImage, uploadImage,
} from '../controllers/erpController';

// Machine-to-machine API for the ERP. HMAC-signed only: admin/customer JWTs are not accepted here.
const router = Router();
router.use(erpLimiter);

router.put('/stock/:sku', erpAuth, updateStock);
router.post('/items', erpAuth, upsertItem);
router.patch('/items/:sku', erpAuth, patchItem);
router.get('/orders', erpAuth, listOrders);
router.get('/orders/:orderId', erpAuth, getOrder);
router.post('/webhooks/order-status', erpAuth, orderStatusWebhook);
// Key and timestamp are checked before the upload is read; the signature then covers the file bytes.
router.post('/images', erpHeaders, readImage, erpSignature((req) => req.file?.buffer), uploadImage);

export default router;
