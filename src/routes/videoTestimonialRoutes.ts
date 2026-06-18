import express from 'express';
import {
  createVideoTestimonial,
  getVideoTestimonials,
  getActiveVideoTestimonials,
  updateVideoTestimonial,
  deleteVideoTestimonial,
} from '../controllers/videoTestimonialController';
import { protect, authorize } from '../middlewares/authMiddleware';

const router = express.Router();

// Public route for landing page
router.get('/active', getActiveVideoTestimonials);

// Admin routes (require login and admin/superadmin role)
router.use(protect, authorize('admin', 'superadmin'));

router.route('/')
  .get(getVideoTestimonials)
  .post(createVideoTestimonial);

router.route('/:id')
  .put(updateVideoTestimonial)
  .delete(deleteVideoTestimonial);

export default router;
