import express from 'express';
import { createBrand, getBrands, deleteBrand, updateBrand } from '../controllers/brandController';
import { protect, adminOnly } from '../middlewares/authMiddleware';
import { upload } from '../middlewares/uploadMiddleware';

const router = express.Router();

router.route('/')
  .post(protect, adminOnly, upload.single('logoFile'), createBrand)
  .get(getBrands);

router.route('/:id')
  .put(protect, adminOnly, upload.single('logoFile'), updateBrand)
  .delete(protect, adminOnly, deleteBrand);

export default router;
