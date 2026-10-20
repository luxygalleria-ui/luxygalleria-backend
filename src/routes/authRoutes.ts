import { Router } from 'express';
import {
  loginAdmin,
  registerCustomer,
  loginCustomer,
  verifyOtp,
  resendOtp,
  googleAuth
} from '../controllers/authController';
import { authLimiter, otpLimiter } from '../middlewares/rateLimiter';

const router = Router();

// No setup/debug/password-reset helpers here: they existed as unauthenticated routes guarded only by NODE_ENV.
// Local admins come from utils/seedAdmin.ts at startup.
router.post('/login', authLimiter, loginAdmin);
router.post('/customer-login', authLimiter, loginCustomer);
router.post('/register', authLimiter, registerCustomer);
router.post('/verify-otp', otpLimiter, verifyOtp);
router.post('/resend-otp', otpLimiter, resendOtp);
router.post('/google', authLimiter, googleAuth);

export default router;
