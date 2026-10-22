import { Request, Response } from 'express';
import Order from '../models/Order';
import { Product } from '../models/Product';
import { User } from '../models/User';
import { Category } from '../models/Category';
import { Banner } from '../models/Banner';
import { Coupon } from '../models/Coupon';
import { Testimonial } from '../models/Testimonial';
import { asyncHandler } from '../utils/asyncHandler';
import { successResponse } from '../utils/responseHandler';

export const getDashboardStats = asyncHandler(async (req: Request, res: Response) => {
  const [
    totalOrders,
    recentOrders,
    totalProducts,
    totalCustomers,
    totalCategories,
    totalBanners,
    totalCoupons,
    totalTestimonials,
    revenueResult,
  ] = await Promise.all([
    Order.countDocuments(),
    Order.find().populate('user', 'name email').sort({ createdAt: -1 }).limit(5),
    Product.countDocuments(),
    User.countDocuments({ role: { $in: ['customer', 'user'] } }),
    Category.countDocuments(),
    Banner.countDocuments(),
    Coupon.countDocuments(),
    Testimonial.countDocuments(),
    Order.aggregate([
      { $match: { paymentStatus: { $in: ['completed', 'COMPLETED', 'paid', 'PAID'] } } },
      { $group: { _id: null, total: { $sum: '$total' } } }
    ]),
  ]);

  const totalRevenue = revenueResult.length > 0 && revenueResult[0]?.total != null ? revenueResult[0].total : 0;
  const safeRecentOrders = recentOrders || [];

  successResponse(res, 200, 'Dashboard stats fetched', {
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
