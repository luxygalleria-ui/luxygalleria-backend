import express from 'express';
import {
  getPublicFaqs,
  getAdminFaqs,
  createFaq,
  updateFaq,
  deleteFaq,
  toggleFaqStatus
} from '../controllers/faqController';
import { protect, authorize } from '../middlewares/authMiddleware';

const router = express.Router();

// Public route
router.get('/', getPublicFaqs);

// Admin routes
router.use(protect, authorize('admin', 'superadmin'));

router.route('/admin')
  .get(getAdminFaqs)
  .post(createFaq);

router.route('/admin/:id')
  .put(updateFaq)
  .delete(deleteFaq);

router.patch('/admin/:id/toggle', toggleFaqStatus);

export default router;
