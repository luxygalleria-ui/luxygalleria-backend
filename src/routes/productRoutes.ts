import express from 'express';
import { createProduct, getProducts, deleteProduct, updateProduct, setGiftingProducts, setNewArrivalProducts } from '../controllers/productController';
import { protect, authorize } from '../middlewares/authMiddleware';
import { upload } from '../middlewares/uploadMiddleware';

const router = express.Router();

router.route('/')
  .post(protect, upload.array('imageFiles', 5), createProduct)
  .get(getProducts);

// Must be registered before '/:id' so these paths aren't treated as product ids
router.put('/gifting', protect, authorize('admin', 'superadmin'), setGiftingProducts);
router.put('/new-arrivals', protect, authorize('admin', 'superadmin'), setNewArrivalProducts);

router.route('/:id')
  .put(protect, upload.array('imageFiles', 5), updateProduct)
  .delete(protect, deleteProduct);

export default router;
