import express from 'express';
import { getAddresses, addAddress, deleteAddress, editAddress, getAllCustomers, toggleCustomerStatus, updateProfile, getProfile, deleteCustomer } from '../controllers/userController';
import { protect, authorize } from '../middlewares/authMiddleware';

const router = express.Router();

router.route('/profile')
  .get(protect, getProfile)
  .put(protect, updateProfile);

router.route('/addresses')
  .get(protect, getAddresses)
  .post(protect, addAddress);

router.route('/addresses/:addressId')
  .put(protect, editAddress)
  .delete(protect, deleteAddress);

// Admin routes
router.get('/admin/customers', protect, authorize('admin', 'superadmin'), getAllCustomers);
router.put('/admin/customers/:id/toggle-status', protect, authorize('admin', 'superadmin'), toggleCustomerStatus);
router.delete('/admin/customers/:id', protect, authorize('admin', 'superadmin'), deleteCustomer);

export default router;
