import express from 'express';
import { createBrand, getBrands, deleteBrand, updateBrand } from '../controllers/brandController';
import { protect } from '../middlewares/authMiddleware';
import { upload } from '../middlewares/uploadMiddleware';

const router = express.Router();

router.route('/')
  .post(protect, upload.single('logoFile'), createBrand)
  .get(getBrands);

router.route('/:id')
  .put(protect, upload.single('logoFile'), updateBrand)
  .delete(protect, deleteBrand);

export default router;
