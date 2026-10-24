"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getHistoryCustomers = exports.getHistoryOrders = exports.getDashboardStats = void 0;
const mongoose_1 = __importDefault(require("mongoose"));
const Product_1 = require("../models/Product");
const Category_1 = require("../models/Category");
const Brand_1 = require("../models/Brand");
const Banner_1 = require("../models/Banner");
const Coupon_1 = require("../models/Coupon");
const Testimonial_1 = require("../models/Testimonial");
const asyncHandler_1 = require("../utils/asyncHandler");
const responseHandler_1 = require("../utils/responseHandler");
const dashboardStats_1 = require("../utils/dashboardStats");
const historyDb_1 = require("../config/historyDb");
exports.getDashboardStats = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    // Orders, revenue and customers: the read-only history when enabled for local development, otherwise the app database.
    // When history is enabled but unavailable, say so: never substitute local figures that look like history.
    let orderStats;
    let source = 'local';
    try {
        const history = await (0, historyDb_1.historyOrderStats)();
        if (history) {
            orderStats = history;
            source = 'history-readonly';
        }
    }
    catch (err) {
        if (err instanceof historyDb_1.HistoryUnavailableError) {
            return (0, responseHandler_1.errorResponse)(res, 503, `Historical data (read-only) is unavailable: ${err.message}`, [{ code: 'HISTORY_UNAVAILABLE' }]);
        }
        throw err;
    }
    orderStats ??= await (0, dashboardStats_1.orderAndCustomerStats)(mongoose_1.default.connection.db);
    // Catalogue and content always come from the app database (the one the admin edits)
    const [totalProducts, totalCategories, totalBrands, totalBanners, totalCoupons, totalTestimonials] = await Promise.all([
        Product_1.Product.countDocuments(), Category_1.Category.countDocuments(), Brand_1.Brand.countDocuments(), Banner_1.Banner.countDocuments(), Coupon_1.Coupon.countDocuments(), Testimonial_1.Testimonial.countDocuments(),
    ]);
    const s = orderStats;
    (0, responseHandler_1.successResponse)(res, 200, 'Dashboard stats fetched', {
        ...s,
        totalProducts,
        totalCategories,
        totalBrands,
        totalBanners,
        totalCoupons,
        totalTestimonials,
        revenueRule: dashboardStats_1.REVENUE_RULE,
        orderDataSource: source,
        history: (0, historyDb_1.historyStatus)(),
        // Dual compatibility for snake_case callers/integrations
        total_revenue: s.totalRevenue,
        total_orders: s.totalOrders,
        total_products: totalProducts,
        total_categories: totalCategories,
        total_banners: totalBanners,
        total_coupons: totalCoupons,
        total_testimonials: totalTestimonials,
        total_customers: s.totalCustomers,
        recent_orders: s.recentOrders,
    });
});
const pageOf = (req) => {
    const page = Math.max(1, Math.floor(Number(req.query.page) || 1));
    const limit = Math.min(100, Math.max(1, Math.floor(Number(req.query.limit) || 50)));
    return { page, limit };
};
/** Read-only production history lists (local development only). 404 when history is not enabled, 503 when unavailable. */
const historyList = (read) => (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    try {
        const data = await read(pageOf(req));
        if (data === null)
            return (0, responseHandler_1.errorResponse)(res, 404, `Read-only history is not enabled (${(0, historyDb_1.historyStatus)().reason})`, [{ code: 'HISTORY_DISABLED' }]);
        (0, responseHandler_1.successResponse)(res, 200, 'Read-only history fetched', { ...data, source: 'history-readonly' });
    }
    catch (err) {
        if (err instanceof historyDb_1.HistoryUnavailableError)
            return (0, responseHandler_1.errorResponse)(res, 503, `Historical data (read-only) is unavailable: ${err.message}`, [{ code: 'HISTORY_UNAVAILABLE' }]);
        throw err;
    }
});
exports.getHistoryOrders = historyList(historyDb_1.historyOrders);
exports.getHistoryCustomers = historyList(historyDb_1.historyCustomers);
//# sourceMappingURL=dashboardController.js.map