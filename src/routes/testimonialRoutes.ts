import express from 'express';
import { createTestimonial, getTestimonials, deleteTestimonial, updateTestimonial } from '../controllers/testimonialController';
import { protect, adminOnly } from '../middlewares/authMiddleware';

const router = express.Router();

router.route('/')
  .post(protect, adminOnly, createTestimonial)
  .get(getTestimonials);

router.route('/:id')
  .put(protect, adminOnly, updateTestimonial)
  .delete(protect, adminOnly, deleteTestimonial);

export default router;
