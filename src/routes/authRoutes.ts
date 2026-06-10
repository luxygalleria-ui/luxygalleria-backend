import { Router } from 'express';
import {
  loginAdmin,
  createTestAdmin,
  registerCustomer,
  loginCustomer,
  verifyOtp,
  resendOtp,
  googleAuth
} from '../controllers/authController';
import { User } from '../models/User';

const router = Router();

router.post('/login', loginAdmin);
router.post('/customer-login', loginCustomer);
router.post('/register', registerCustomer);
router.post('/verify-otp', verifyOtp);
router.post('/resend-otp', resendOtp);
router.post('/google', googleAuth);
router.post('/setup-test-admin', createTestAdmin);

// Debug endpoint (development only)
router.get('/debug-users', async (req, res) => {
  if (process.env.NODE_ENV !== 'development') {
    return res
      .status(403)
      .json({ error: 'Debug endpoint only available in development' });
  }

  try {
    const users = await User.find({ role: 'customer' }).select('+password');

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
  } catch (error: any) {
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

    const user = await User.findOne({ email });

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
  } catch (error: any) {
    console.error('Fix password error:', error);

    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;