import express from 'express';
import {
  getSettings, updateSettings, getCheckoutSettings, updateCheckoutSection, listCheckoutProducts, updateCheckoutProducts,
} from '../controllers/settingsController';
import { protect, authorize } from '../middlewares/authMiddleware';

const router = express.Router();

// Public route to get settings (checkout part reduced to what customers may see)
router.get('/', getSettings);

// Admin route to update settings
router.put('/', protect, authorize('admin', 'superadmin'), updateSettings);

// Admin: checkout & fulfilment (shipping, pickup, chocolate, tax). Tax changes additionally need superadmin (checked in the controller).
router.get('/checkout', protect, authorize('admin', 'superadmin'), getCheckoutSettings);
router.get('/checkout/products', protect, authorize('admin', 'superadmin'), listCheckoutProducts);
router.put('/checkout/products', protect, authorize('admin', 'superadmin'), updateCheckoutProducts);
router.put('/checkout/:section', protect, authorize('admin', 'superadmin'), updateCheckoutSection);

export default router;
