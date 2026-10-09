"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const productController_1 = require("../controllers/productController");
const authMiddleware_1 = require("../middlewares/authMiddleware");
const uploadMiddleware_1 = require("../middlewares/uploadMiddleware");
const router = express_1.default.Router();
router.route('/')
    .post(authMiddleware_1.protect, uploadMiddleware_1.upload.array('imageFiles', 5), productController_1.createProduct)
    .get(productController_1.getProducts);
// Must be registered before '/:id' so these paths aren't treated as product ids
router.put('/gifting', authMiddleware_1.protect, (0, authMiddleware_1.authorize)('admin', 'superadmin'), productController_1.setGiftingProducts);
router.put('/new-arrivals', authMiddleware_1.protect, (0, authMiddleware_1.authorize)('admin', 'superadmin'), productController_1.setNewArrivalProducts);
router.route('/:id')
    .put(authMiddleware_1.protect, uploadMiddleware_1.upload.array('imageFiles', 5), productController_1.updateProduct)
    .delete(authMiddleware_1.protect, productController_1.deleteProduct);
exports.default = router;
//# sourceMappingURL=productRoutes.js.map