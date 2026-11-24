"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const authController_1 = require("../controllers/authController");
const authMiddleware_1 = require("../middlewares/authMiddleware");
const rateLimiter_1 = require("../middlewares/rateLimiter");
const router = (0, express_1.Router)();
router.post('/login', rateLimiter_1.authLimiter, authController_1.loginAdmin);
router.post('/customer-login', rateLimiter_1.authLimiter, authController_1.loginCustomer);
router.post('/register', rateLimiter_1.authLimiter, authController_1.registerCustomer);
router.post('/verify-otp', rateLimiter_1.otpLimiter, authController_1.verifyOtp);
router.post('/resend-otp', rateLimiter_1.otpLimiter, authController_1.resendOtp);
router.post('/forgot-password', rateLimiter_1.forgotPasswordLimiter, authController_1.forgotPassword);
router.post('/reset-password', rateLimiter_1.resetPasswordLimiter, authController_1.resetPassword);
router.post('/google', rateLimiter_1.authLimiter, authController_1.googleAuth);
router.post('/google/link', rateLimiter_1.authLimiter, authMiddleware_1.protect, authController_1.linkGoogleAccount);
// Removed: GET /debug-users, POST /fix-user-password and POST /setup-test-admin (unauthenticated; listed customers with
// OTPs, reset any password, reset the superadmin password and returned it). The development admin comes from
// utils/seedAdmin.ts at startup. Never re-add debug, setup or password-reset routes without authentication.
exports.default = router;
//# sourceMappingURL=authRoutes.js.map