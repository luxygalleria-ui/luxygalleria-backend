import express from 'express';
import { createProduct, getProducts, deleteProduct, updateProduct, setGiftingProducts, setNewArrivalProducts } from '../controllers/productController';
import { protect, adminOnly } from '../middlewares/authMiddleware';
import { upload } from '../middlewares/uploadMiddleware';

const router = express.Router();

router.route('/')
  .post(protect, adminOnly, upload.array('imageFiles', 5), createProduct)
  .get(getProducts);

// Must be registered before '/:id' so these paths aren't treated as product ids
router.put('/gifting', protect, adminOnly, setGiftingProducts);
router.put('/new-arrivals', protect, adminOnly, setNewArrivalProducts);

router.route('/:id')
  .put(protect, adminOnly, upload.array('imageFiles', 5), updateProduct)
  .delete(protect, adminOnly, deleteProduct);

export default router;
