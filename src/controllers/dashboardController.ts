import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { Product } from '../models/Product';
import { Category } from '../models/Category';
import { Brand } from '../models/Brand';
import { Banner } from '../models/Banner';
import { Coupon } from '../models/Coupon';
import { Testimonial } from '../models/Testimonial';
import { asyncHandler } from '../utils/asyncHandler';
import { successResponse, errorResponse } from '../utils/responseHandler';
import { orderAndCustomerStats, REVENUE_RULE } from '../utils/dashboardStats';
import { historyOrderStats, historyOrders, historyCustomers, historyStatus, HistoryUnavailableError, Page } from '../config/historyDb';

export const getDashboardStats = asyncHandler(async (req: Request, res: Response) => {
  // Orders, revenue and customers: the read-only history when enabled for local development, otherwise the app database.
  // When history is enabled but unavailable, say so: never substitute local figures that look like history.
  let orderStats;
  let source: 'local' | 'history-readonly' = 'local';
  try {
    const history = await historyOrderStats();
    if (history) { orderStats = history; source = 'history-readonly'; }
  } catch (err) {
    if (err instanceof HistoryUnavailableError) {
      return errorResponse(res, 503, `Historical data (read-only) is unavailable: ${err.message}`, [{ code: 'HISTORY_UNAVAILABLE' }]);
    }
    throw err;
  }
  orderStats ??= await orderAndCustomerStats(mongoose.connection.db!);

  // Catalogue and content always come from the app database (the one the admin edits)
  const [totalProducts, totalCategories, totalBrands, totalBanners, totalCoupons, totalTestimonials] = await Promise.all([
    Product.countDocuments(), Category.countDocuments(), Brand.countDocuments(), Banner.countDocuments(), Coupon.countDocuments(), Testimonial.countDocuments(),
  ]);

  const s = orderStats;
  successResponse(res, 200, 'Dashboard stats fetched', {
    ...s,
    totalProducts,
    totalCategories,
    totalBrands,
    totalBanners,
    totalCoupons,
    totalTestimonials,
    revenueRule: REVENUE_RULE,
    orderDataSource: source,
    history: historyStatus(),
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

const pageOf = (req: Request): Page => {
  const page = Math.max(1, Math.floor(Number(req.query.page) || 1));
  const limit = Math.min(100, Math.max(1, Math.floor(Number(req.query.limit) || 50)));
  return { page, limit };
};

/** Read-only production history lists (local development only). 404 when history is not enabled, 503 when unavailable. */
const historyList = (read: (p: Page) => Promise<unknown>) => asyncHandler(async (req: Request, res: Response) => {
  try {
    const data = await read(pageOf(req));
    if (data === null) return errorResponse(res, 404, `Read-only history is not enabled (${(historyStatus() as any).reason})`, [{ code: 'HISTORY_DISABLED' }]);
    successResponse(res, 200, 'Read-only history fetched', { ...(data as object), source: 'history-readonly' });
  } catch (err) {
    if (err instanceof HistoryUnavailableError) return errorResponse(res, 503, `Historical data (read-only) is unavailable: ${err.message}`, [{ code: 'HISTORY_UNAVAILABLE' }]);
    throw err;
  }
});

export const getHistoryOrders = historyList(historyOrders);
export const getHistoryCustomers = historyList(historyCustomers);
