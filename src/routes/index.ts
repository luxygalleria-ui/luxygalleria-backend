import { Router } from 'express';
import { checkHealth } from '../controllers/healthController';
import authRoutes from './authRoutes';
import productRoutes from './productRoutes';
import categoryRoutes from './categoryRoutes';
import brandRoutes from './brandRoutes';
import bannerRoutes from './bannerRoutes';
import couponRoutes from './couponRoutes';
import testimonialRoutes from './testimonialRoutes';
import videoTestimonialRoutes from './videoTestimonialRoutes';
import userRoutes from './userRoutes';
import paymentRoutes from './paymentRoutes';
import cartRoutes from './cartRoutes';
import dashboardRoutes from './dashboardRoutes';
import contactRoutes from './contactRoutes';
import faqRoutes from './faqRoutes';
import settingsRoutes from './settingsRoutes';

const router = Router();

// Health Check
router.get('/health', checkHealth);

// Generic Image Upload (Cloudinary/Local)
import { upload } from '../middlewares/uploadMiddleware';
import { protect } from '../middlewares/authMiddleware';
router.post('/upload', protect, upload.single('imageFile'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No file uploaded' });
  }
  res.status(200).json({ success: true, url: req.file.path });
});

// Mount other routes here
router.use('/auth', authRoutes);
router.use('/products', productRoutes);
router.use('/categories', categoryRoutes);
router.use('/brands', brandRoutes);
router.use('/banners', bannerRoutes);
router.use('/coupons', couponRoutes);
router.use('/testimonials', testimonialRoutes);
router.use('/video-testimonials', videoTestimonialRoutes);
router.use('/users', userRoutes);
router.use('/payments', paymentRoutes);
router.use('/cart', cartRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/contacts', contactRoutes);
router.use('/faqs', faqRoutes);
router.use('/settings', settingsRoutes);

export default router;
