"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const settingsController_1 = require("../controllers/settingsController");
const authMiddleware_1 = require("../middlewares/authMiddleware");
const router = express_1.default.Router();
// Public route to get settings (checkout part reduced to what customers may see)
router.get('/', settingsController_1.getSettings);
// Admin route to update settings
router.put('/', authMiddleware_1.protect, (0, authMiddleware_1.authorize)('admin', 'superadmin'), settingsController_1.updateSettings);
// Admin: checkout & fulfilment (shipping, pickup, chocolate, tax). Tax changes additionally need superadmin (checked in the controller).
router.get('/checkout', authMiddleware_1.protect, (0, authMiddleware_1.authorize)('admin', 'superadmin'), settingsController_1.getCheckoutSettings);
router.get('/checkout/products', authMiddleware_1.protect, (0, authMiddleware_1.authorize)('admin', 'superadmin'), settingsController_1.listCheckoutProducts);
router.put('/checkout/products', authMiddleware_1.protect, (0, authMiddleware_1.authorize)('admin', 'superadmin'), settingsController_1.updateCheckoutProducts);
router.put('/checkout/:section', authMiddleware_1.protect, (0, authMiddleware_1.authorize)('admin', 'superadmin'), settingsController_1.updateCheckoutSection);
exports.default = router;
//# sourceMappingURL=settingsRoutes.js.map