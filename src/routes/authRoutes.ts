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

router.post('/login', authLimiter, loginAdmin);
router.post('/customer-login', authLimiter, loginCustomer);
router.post('/register', authLimiter, registerCustomer);
router.post('/verify-otp', otpLimiter, verifyOtp);
router.post('/resend-otp', otpLimiter, resendOtp);
router.post('/google', authLimiter, googleAuth);

// Removed: GET /debug-users, POST /fix-user-password and POST /setup-test-admin (unauthenticated; listed customers with
// OTPs, reset any password, reset the superadmin password and returned it). The development admin comes from
// utils/seedAdmin.ts at startup. Never re-add debug, setup or password-reset routes without authentication.

export default router;