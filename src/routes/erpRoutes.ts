import { Router } from 'express';
import { erpLimiter } from '../middlewares/rateLimiter';
import { erpAuth, erpHeaders, erpSignature } from '../middlewares/erpAuth';
import {
  updateStock, listItems, getItemBySku, upsertItem, patchItem, listOrders, getOrder, orderStatusWebhook, readImage, uploadImage,
  listBrands, getBrand, createBrand, patchBrand, listGiftboxes, getGiftbox, addGiftbox, patchGiftbox, removeGiftbox,
} from '../controllers/erpController';

// Machine-to-machine API for the ERP. HMAC-signed only: admin/customer JWTs are not accepted here.
const router = Router();
router.use(erpLimiter);

router.get('/items', erpAuth, listItems);
router.get('/items/:sku', erpAuth, getItemBySku);
router.put('/stock/:sku', erpAuth, updateStock);
router.post('/items', erpAuth, upsertItem);
router.patch('/items/:sku', erpAuth, patchItem);
router.get('/orders', erpAuth, listOrders);
router.get('/orders/:orderId', erpAuth, getOrder);
router.post('/webhooks/order-status', erpAuth, orderStatusWebhook);
router.get('/brands', erpAuth, listBrands);
router.get('/brands/:id', erpAuth, getBrand);
router.post('/brands', erpAuth, createBrand);
router.patch('/brands/:id', erpAuth, patchBrand);
router.get('/giftboxes', erpAuth, listGiftboxes);
router.get('/giftboxes/:id', erpAuth, getGiftbox);
router.post('/giftboxes', erpAuth, addGiftbox);
router.patch('/giftboxes/:id', erpAuth, patchGiftbox);
router.delete('/giftboxes/:id', erpAuth, removeGiftbox);
// Key and timestamp are checked before the upload is read; the signature then covers the file bytes.
router.post('/images', erpHeaders, readImage, erpSignature((req) => req.file?.buffer), uploadImage);

export default router;
