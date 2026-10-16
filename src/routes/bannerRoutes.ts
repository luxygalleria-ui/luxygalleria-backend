import express from 'express';
import { createBanner, getBanners, deleteBanner, updateBanner } from '../controllers/bannerController';
import { protect, adminOnly } from '../middlewares/authMiddleware';
import { upload } from '../middlewares/uploadMiddleware';

const router = express.Router();

router.route('/')
  .post(protect, adminOnly, upload.fields([{ name: 'image', maxCount: 1 }, { name: 'mobileImage', maxCount: 1 }]), createBanner)
  .get(getBanners);

router.route('/:id')
  .put(protect, adminOnly, upload.fields([{ name: 'image', maxCount: 1 }, { name: 'mobileImage', maxCount: 1 }]), updateBanner)
  .delete(protect, adminOnly, deleteBanner);

export default router;
