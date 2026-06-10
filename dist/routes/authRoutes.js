"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const authController_1 = require("../controllers/authController");
const User_1 = require("../models/User");
const router = (0, express_1.Router)();
router.post('/login', authController_1.loginAdmin);
router.post('/customer-login', authController_1.loginCustomer);
router.post('/register', authController_1.registerCustomer);
router.post('/verify-otp', authController_1.verifyOtp);
router.post('/resend-otp', authController_1.resendOtp);
router.post('/google', authController_1.googleAuth);
router.post('/setup-test-admin', authController_1.createTestAdmin);
// Debug endpoint (development only)
router.get('/debug-users', async (req, res) => {
    if (process.env.NODE_ENV !== 'development') {
        return res
            .status(403)
            .json({ error: 'Debug endpoint only available in development' });
    }
    try {
        const users = await User_1.User.find({ role: 'customer' }).select('+password');
        const userInfo = users.map(user => ({
            id: user._id,
            email: user.email,
            name: user.name,
            verified: user.isVerified,
            active: user.isActive,
            hasPassword: !!user.password,
            passwordLength: user.password?.length,
            hasOTP: !!user.otp,
            otp: user.otp,
            otpExpires: user.otpExpires
        }));
        res.json({
            success: true,
            count: users.length,
            users: userInfo
        });
    }
    catch (error) {
        console.error('Debug users error:', error);
        res.status(500).json({
            error: error instanceof Error ? error.message : 'Unknown error'
        });
    }
});
// Fix user passwords (development only)
router.post('/fix-user-password', async (req, res) => {
    if (process.env.NODE_ENV !== 'development') {
        return res
            .status(403)
            .json({ error: 'Fix endpoint only available in development' });
    }
    try {
        const { email, newPassword } = req.body;
        if (!email || !newPassword) {
            return res
                .status(400)
                .json({ error: 'Email and newPassword required' });
        }
        const user = await User_1.User.findOne({ email });
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        console.log(`\n🔧 FIXING PASSWORD for ${email}:`);
        console.log(`   Old password length: ${user.password?.length}`);
        user.password = newPassword;
        user.isVerified = true;
        await user.save();
        console.log(`   New password length: ${user.password?.length}`);
        console.log(`   Password updated successfully\n`);
        res.json({
            success: true,
            message: `Password updated for ${email}`,
            user: {
                email: user.email,
                verified: user.isVerified,
                active: user.isActive
            }
        });
    }
    catch (error) {
        console.error('Fix password error:', error);
        res.status(500).json({
            error: error instanceof Error ? error.message : 'Unknown error'
        });
    }
});
exports.default = router;
//# sourceMappingURL=authRoutes.js.map