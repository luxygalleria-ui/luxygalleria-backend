"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const healthController_1 = require("../controllers/healthController");
const authRoutes_1 = __importDefault(require("./authRoutes"));
const productRoutes_1 = __importDefault(require("./productRoutes"));
const categoryRoutes_1 = __importDefault(require("./categoryRoutes"));
const bannerRoutes_1 = __importDefault(require("./bannerRoutes"));
const couponRoutes_1 = __importDefault(require("./couponRoutes"));
const testimonialRoutes_1 = __importDefault(require("./testimonialRoutes"));
const videoTestimonialRoutes_1 = __importDefault(require("./videoTestimonialRoutes"));
const userRoutes_1 = __importDefault(require("./userRoutes"));
const paymentRoutes_1 = __importDefault(require("./paymentRoutes"));
const cartRoutes_1 = __importDefault(require("./cartRoutes"));
const dashboardRoutes_1 = __importDefault(require("./dashboardRoutes"));
const contactRoutes_1 = __importDefault(require("./contactRoutes"));
const faqRoutes_1 = __importDefault(require("./faqRoutes"));
const settingsRoutes_1 = __importDefault(require("./settingsRoutes"));
const router = (0, express_1.Router)();
// Health Check
router.get('/health', healthController_1.checkHealth);
// Mount other routes here
router.use('/auth', authRoutes_1.default);
router.use('/products', productRoutes_1.default);
router.use('/categories', categoryRoutes_1.default);
router.use('/banners', bannerRoutes_1.default);
router.use('/coupons', couponRoutes_1.default);
router.use('/testimonials', testimonialRoutes_1.default);
router.use('/video-testimonials', videoTestimonialRoutes_1.default);
router.use('/users', userRoutes_1.default);
router.use('/payments', paymentRoutes_1.default);
router.use('/cart', cartRoutes_1.default);
router.use('/dashboard', dashboardRoutes_1.default);
router.use('/contacts', contactRoutes_1.default);
router.use('/faqs', faqRoutes_1.default);
router.use('/settings', settingsRoutes_1.default);
exports.default = router;
//# sourceMappingURL=index.js.map