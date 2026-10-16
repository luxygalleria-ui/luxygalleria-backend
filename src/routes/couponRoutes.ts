import express from 'express';
import { createCoupon, getCoupons, deleteCoupon, updateCoupon, validateCoupon } from '../controllers/couponController';
import { protect, adminOnly } from '../middlewares/authMiddleware';

const router = express.Router();

router.route('/')
  .post(protect, adminOnly, createCoupon)
  .get(protect, adminOnly, getCoupons);

router.post('/validate', validateCoupon);

router.route('/:id')
  .put(protect, adminOnly, updateCoupon)
  .delete(protect, adminOnly, deleteCoupon);

export default router;
