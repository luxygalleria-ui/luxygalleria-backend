"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const rateLimiter_1 = require("../middlewares/rateLimiter");
const erpAuth_1 = require("../middlewares/erpAuth");
const erpController_1 = require("../controllers/erpController");
// Machine-to-machine API for the ERP. HMAC-signed only: admin/customer JWTs are not accepted here.
const router = (0, express_1.Router)();
router.use(rateLimiter_1.erpLimiter);
router.get('/items', erpAuth_1.erpAuth, erpController_1.listItems);
router.get('/items/:sku', erpAuth_1.erpAuth, erpController_1.getItemBySku);
router.put('/stock/:sku', erpAuth_1.erpAuth, erpController_1.updateStock);
router.post('/items', erpAuth_1.erpAuth, erpController_1.upsertItem);
router.patch('/items/:sku', erpAuth_1.erpAuth, erpController_1.patchItem);
router.get('/orders', erpAuth_1.erpAuth, erpController_1.listOrders);
router.get('/orders/:orderId', erpAuth_1.erpAuth, erpController_1.getOrder);
router.post('/webhooks/order-status', erpAuth_1.erpAuth, erpController_1.orderStatusWebhook);
// Key and timestamp are checked before the upload is read; the signature then covers the file bytes.
router.post('/images', erpAuth_1.erpHeaders, erpController_1.readImage, (0, erpAuth_1.erpSignature)((req) => req.file?.buffer), erpController_1.uploadImage);
exports.default = router;
//# sourceMappingURL=erpRoutes.js.map