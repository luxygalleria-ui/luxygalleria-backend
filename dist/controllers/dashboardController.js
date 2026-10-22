"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDashboardStats = void 0;
const Order_1 = __importDefault(require("../models/Order"));
const Product_1 = require("../models/Product");
const User_1 = require("../models/User");
const Category_1 = require("../models/Category");
const Banner_1 = require("../models/Banner");
const Coupon_1 = require("../models/Coupon");
const Testimonial_1 = require("../models/Testimonial");
const asyncHandler_1 = require("../utils/asyncHandler");
const responseHandler_1 = require("../utils/responseHandler");
exports.getDashboardStats = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const [totalOrders, recentOrders, totalProducts, totalCustomers, totalCategories, totalBanners, totalCoupons, totalTestimonials, revenueResult,] = await Promise.all([
        Order_1.default.countDocuments(),
        Order_1.default.find().populate('user', 'name email').sort({ createdAt: -1 }).limit(5),
        Product_1.Product.countDocuments(),
        User_1.User.countDocuments({ role: { $in: ['customer', 'user'] } }),
        Category_1.Category.countDocuments(),
        Banner_1.Banner.countDocuments(),
        Coupon_1.Coupon.countDocuments(),
        Testimonial_1.Testimonial.countDocuments(),
        Order_1.default.aggregate([
            { $match: { paymentStatus: { $in: ['completed', 'COMPLETED', 'paid', 'PAID'] } } },
            { $group: { _id: null, total: { $sum: '$total' } } }
        ]),
    ]);
    const totalRevenue = revenueResult.length > 0 && revenueResult[0]?.total != null ? revenueResult[0].total : 0;
    const safeRecentOrders = recentOrders || [];
    (0, responseHandler_1.successResponse)(res, 200, 'Dashboard stats fetched', {
        totalRevenue,
        totalOrders,
        totalProducts,
        totalCategories,
        totalBanners,
        totalCoupons,
        totalTestimonials,
        totalCustomers,
        recentOrders: safeRecentOrders,
        // Dual compatibility for snake_case callers/integrations
        total_revenue: totalRevenue,
        total_orders: totalOrders,
        total_products: totalProducts,
        total_categories: totalCategories,
        total_banners: totalBanners,
        total_coupons: totalCoupons,
        total_testimonials: totalTestimonials,
        total_customers: totalCustomers,
        recent_orders: safeRecentOrders,
    });
});
//# sourceMappingURL=dashboardController.js.map