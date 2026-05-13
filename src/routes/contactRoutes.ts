import { Router } from 'express';
import { submitContactForm, getContacts, markContactAsRead, deleteContact } from '../controllers/contactController';
import { protect, authorize } from '../middlewares/authMiddleware';

const router = Router();

// Public route for frontend
router.post('/', submitContactForm);

// Admin routes
router.get('/', protect, authorize('admin', 'superadmin'), getContacts);
router.put('/:id/read', protect, authorize('admin', 'superadmin'), markContactAsRead);
router.delete('/:id', protect, authorize('admin', 'superadmin'), deleteContact);

export default router;
