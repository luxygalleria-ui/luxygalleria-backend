import { Router } from 'express';
import {
  loginAdmin,
  registerCustomer,
  loginCustomer,
  verifyOtp,
  resendOtp,
  googleAuth,
  linkGoogleAccount,
  forgotPassword,
  resetPassword
} from '../controllers/authController';
import { protect } from '../middlewares/authMiddleware';
import { authLimiter, otpLimiter, forgotPasswordLimiter, resetPasswordLimiter } from '../middlewares/rateLimiter';

const router = Router();

router.post('/login', authLimiter, loginAdmin);
router.post('/customer-login', authLimiter, loginCustomer);
router.post('/register', authLimiter, registerCustomer);
router.post('/verify-otp', otpLimiter, verifyOtp);
router.post('/resend-otp', otpLimiter, resendOtp);
router.post('/forgot-password', forgotPasswordLimiter, forgotPassword);
router.post('/reset-password', resetPasswordLimiter, resetPassword);
router.post('/google', authLimiter, googleAuth);
router.post('/google/link', authLimiter, protect, linkGoogleAccount);

// Removed: GET /debug-users, POST /fix-user-password and POST /setup-test-admin (unauthenticated; listed customers with
// OTPs, reset any password, reset the superadmin password and returned it). The development admin comes from
// utils/seedAdmin.ts at startup. Never re-add debug, setup or password-reset routes without authentication.

export default router;