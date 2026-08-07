"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const brandController_1 = require("../controllers/brandController");
const authMiddleware_1 = require("../middlewares/authMiddleware");
const uploadMiddleware_1 = require("../middlewares/uploadMiddleware");
const router = express_1.default.Router();
router.route('/')
    .post(authMiddleware_1.protect, uploadMiddleware_1.upload.single('logoFile'), brandController_1.createBrand)
    .get(brandController_1.getBrands);
router.route('/:id')
    .put(authMiddleware_1.protect, uploadMiddleware_1.upload.single('logoFile'), brandController_1.updateBrand)
    .delete(authMiddleware_1.protect, brandController_1.deleteBrand);
exports.default = router;
//# sourceMappingURL=brandRoutes.js.map