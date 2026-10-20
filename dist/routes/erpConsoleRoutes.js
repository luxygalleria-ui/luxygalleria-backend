"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const authMiddleware_1 = require("../middlewares/authMiddleware");
const erpController_1 = require("../controllers/erpController");
const erpConsoleController_1 = require("../controllers/erpConsoleController");
// Admin-only mirror of the seven ERP routes (see controllers/erpConsoleController.ts). Only these routes exist.
const router = (0, express_1.Router)();
router.use(authMiddleware_1.protect, authMiddleware_1.adminOnly);
router.get('/status', erpConsoleController_1.consoleStatus);
router.put('/stock/:sku', erpConsoleController_1.requireConsole, erpConsoleController_1.forwardToErp);
router.post('/items', erpConsoleController_1.requireConsole, erpConsoleController_1.forwardToErp);
router.patch('/items/:sku', erpConsoleController_1.requireConsole, erpConsoleController_1.forwardToErp);
router.get('/orders', erpConsoleController_1.requireConsole, erpConsoleController_1.forwardToErp);
router.get('/orders/:orderId', erpConsoleController_1.requireConsole, erpConsoleController_1.forwardToErp);
router.post('/webhooks/order-status', erpConsoleController_1.requireConsole, erpConsoleController_1.forwardToErp);
router.post('/images', erpConsoleController_1.requireConsole, erpController_1.readImage, erpConsoleController_1.forwardToErp);
exports.default = router;
//# sourceMappingURL=erpConsoleRoutes.js.map