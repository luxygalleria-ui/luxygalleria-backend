import express from 'express';
import { createCategory, getCategories, deleteCategory, updateCategory } from '../controllers/categoryController';
import { protect, adminOnly } from '../middlewares/authMiddleware';
import { upload } from '../middlewares/uploadMiddleware';

const router = express.Router();

router.route('/')
  .post(protect, adminOnly, upload.single('imageFile'), createCategory)
  .get(getCategories);

router.route('/:id')
  .put(protect, adminOnly, upload.single('imageFile'), updateCategory)
  .delete(protect, adminOnly, deleteCategory);

export default router;
