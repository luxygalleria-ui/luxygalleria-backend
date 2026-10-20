"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const authController_1 = require("../controllers/authController");
const rateLimiter_1 = require("../middlewares/rateLimiter");
const router = (0, express_1.Router)();
// No setup/debug/password-reset helpers here: they existed as unauthenticated routes guarded only by NODE_ENV.
// Local admins come from utils/seedAdmin.ts at startup.
router.post('/login', rateLimiter_1.authLimiter, authController_1.loginAdmin);
router.post('/customer-login', rateLimiter_1.authLimiter, authController_1.loginCustomer);
router.post('/register', rateLimiter_1.authLimiter, authController_1.registerCustomer);
router.post('/verify-otp', rateLimiter_1.otpLimiter, authController_1.verifyOtp);
router.post('/resend-otp', rateLimiter_1.otpLimiter, authController_1.resendOtp);
router.post('/google', rateLimiter_1.authLimiter, authController_1.googleAuth);
exports.default = router;
//# sourceMappingURL=authRoutes.js.map