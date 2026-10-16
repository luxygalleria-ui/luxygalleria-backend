"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.googleAuth = exports.loginCustomer = exports.resendOtp = exports.verifyOtp = exports.registerCustomer = exports.createTestAdmin = exports.loginAdmin = void 0;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const User_1 = require("../models/User");
const asyncHandler_1 = require("../utils/asyncHandler");
const responseHandler_1 = require("../utils/responseHandler");
const env_1 = require("../config/env");
const google_auth_library_1 = require("google-auth-library");
const crypto_1 = __importDefault(require("crypto"));
const generateToken = (id, role) => {
    return jsonwebtoken_1.default.sign({ id, role }, env_1.ENV.JWT_SECRET, {
        expiresIn: env_1.ENV.JWT_EXPIRES_IN,
    });
};
exports.loginAdmin = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return (0, responseHandler_1.errorResponse)(res, 400, 'Please provide email and password');
    }
    // Check if user exists and select password
    const user = await User_1.User.findOne({ email }).select('+password');
    if (!user || !(await user.matchPassword(password))) {
        return (0, responseHandler_1.errorResponse)(res, 401, 'Invalid email or password');
    }
    if (!user.isActive) {
        return (0, responseHandler_1.errorResponse)(res, 403, 'Your account has been deactivated');
    }
    // Check if role is admin or superadmin
    if (user.role !== 'admin' && user.role !== 'superadmin') {
        return (0, responseHandler_1.errorResponse)(res, 403, 'Not authorized to access admin portal');
    }
    // Generate Token
    const token = generateToken(user._id.toString(), user.role);
    // Set Cookie for extra security (HTTP-Only)
    res.cookie('jwt', token, {
        httpOnly: true,
        secure: env_1.ENV.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });
    (0, responseHandler_1.successResponse)(res, 200, 'Login successful', {
        _id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        token
    });
});
// Helper to quickly create a test admin user (Can be removed later)
exports.createTestAdmin = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (env_1.ENV.NODE_ENV !== 'development') {
        return (0, responseHandler_1.errorResponse)(res, 403, 'Test admin setup is only available in development');
    }
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@luxygalleria.com';
    const adminPassword = process.env.ADMIN_PASSWORD || 'password123';
    const userExists = await User_1.User.findOne({ email: adminEmail }).select('+password');
    if (userExists) {
        if (userExists.role === 'admin' || userExists.role === 'superadmin') {
            userExists.password = adminPassword;
            userExists.role = 'superadmin';
            userExists.isVerified = true;
            userExists.isActive = true;
            await userExists.save();
            return (0, responseHandler_1.successResponse)(res, 200, 'Test admin reset successfully. You can now login.', {
                email: adminEmail,
                password: adminPassword
            });
        }
        return (0, responseHandler_1.errorResponse)(res, 400, 'Email is already registered as a customer');
    }
    const admin = await User_1.User.create({
        name: 'System Admin',
        email: adminEmail,
        password: adminPassword,
        role: 'superadmin',
        isVerified: true,
        isActive: true,
    });
    (0, responseHandler_1.successResponse)(res, 201, 'Test admin created successfully. You can now login.', {
        email: admin.email,
        password: adminPassword
    });
});
const sendEmail_1 = require("../utils/sendEmail");
exports.registerCustomer = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { name, email, password, phone, addresses } = req.body;
    if (!name || !email || !password) {
        return (0, responseHandler_1.errorResponse)(res, 400, 'Please provide name, email and password');
    }
    const existing = await User_1.User.findOne({ email });
    if (existing) {
        return (0, responseHandler_1.errorResponse)(res, 400, 'Email is already registered');
    }
    // Direct signup — account is active and usable immediately (no email OTP step)
    const user = await User_1.User.create({
        name,
        email,
        password,
        phone,
        role: 'customer',
        addresses,
        isVerified: true,
        isActive: true,
    });
    const token = generateToken(user._id.toString(), user.role);
    res.cookie('jwt', token, {
        httpOnly: true,
        secure: env_1.ENV.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });
    (0, responseHandler_1.successResponse)(res, 201, 'Registration successful', {
        _id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        token
    });
});
exports.verifyOtp = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { email, otp } = req.body;
    if (!email || !otp) {
        return (0, responseHandler_1.errorResponse)(res, 400, 'Please provide email and OTP');
    }
    const user = await User_1.User.findOne({ email });
    if (!user) {
        return (0, responseHandler_1.errorResponse)(res, 404, 'User not found');
    }
    if (user.isVerified) {
        return (0, responseHandler_1.errorResponse)(res, 400, 'User is already verified');
    }
    if (!user.otp || user.otp !== String(otp)) {
        return (0, responseHandler_1.errorResponse)(res, 400, 'Invalid OTP code');
    }
    if (user.otpExpires && user.otpExpires < new Date()) {
        return (0, responseHandler_1.errorResponse)(res, 400, 'OTP code has expired');
    }
    // Verify user
    user.isVerified = true;
    user.otp = undefined;
    user.otpExpires = undefined;
    await user.save();
    const token = generateToken(user._id.toString(), user.role);
    res.cookie('jwt', token, {
        httpOnly: true,
        secure: env_1.ENV.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });
    (0, responseHandler_1.successResponse)(res, 200, 'Email verified successfully', {
        _id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        token
    });
});
exports.resendOtp = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { email } = req.body;
    if (!email) {
        return (0, responseHandler_1.errorResponse)(res, 400, 'Please provide email');
    }
    const user = await User_1.User.findOne({ email });
    if (!user) {
        return (0, responseHandler_1.errorResponse)(res, 404, 'User not found');
    }
    if (user.isVerified) {
        return (0, responseHandler_1.errorResponse)(res, 400, 'User is already verified');
    }
    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
    user.otp = otp;
    user.otpExpires = otpExpires;
    await user.save();
    // Send OTP via email
    try {
        const emailSubject = 'Your New Luxy Galleria Verification Code';
        const emailMessage = `Your new verification code is: ${otp}\n\nThis code will expire in 10 minutes.`;
        const emailHTML = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #0A192F; margin-bottom: 20px;">Luxy Galleria - Verification Code</h2>
        <p style="color: #333; font-size: 16px; margin-bottom: 20px;">Hi <strong>${user.name}</strong>,</p>
        <p style="color: #333; font-size: 16px; margin-bottom: 20px;">Your new email verification code is:</p>
        <div style="background-color: #FEF3C7; border: 2px solid #FCD34D; border-radius: 12px; padding: 20px; text-align: center; margin-bottom: 20px;">
          <p style="font-size: 32px; font-weight: bold; color: #0A192F; letter-spacing: 4px; margin: 0;">${otp}</p>
        </div>
        <p style="color: #666; font-size: 14px; margin-bottom: 20px;">This code will expire in <strong>10 minutes</strong>.</p>
        <p style="color: #999; font-size: 12px; margin-top: 30px; border-top: 1px solid #eee; padding-top: 20px;">
          If you didn't request this code, please ignore this email.
        </p>
      </div>
    `;
        await (0, sendEmail_1.sendEmail)({
            email,
            subject: emailSubject,
            message: emailMessage,
            html: emailHTML
        });
    }
    catch (emailError) {
        console.error('⚠️ Failed to send OTP email:', emailError.message);
        // Don't fail if email sending fails - continue anyway
    }
    (0, responseHandler_1.successResponse)(res, 200, 'New verification code generated and sent to your email.', null);
});
exports.loginCustomer = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return (0, responseHandler_1.errorResponse)(res, 400, 'Please provide email and password');
        }
        const user = await User_1.User.findOne({ email }).select('+password');
        if (!user) {
            return (0, responseHandler_1.errorResponse)(res, 401, 'Invalid email or password');
        }
        const isMatch = await user.matchPassword(password);
        if (!isMatch) {
            return (0, responseHandler_1.errorResponse)(res, 401, 'Invalid email or password');
        }
        if (!user.isVerified) {
            return (0, responseHandler_1.errorResponse)(res, 403, 'Please verify your email to continue. We have sent an OTP to your email during registration.');
        }
        if (!user.isActive) {
            return (0, responseHandler_1.errorResponse)(res, 403, 'Your account has been deactivated');
        }
        // Only allow customers to use this endpoint
        if (user.role !== 'customer') {
            return (0, responseHandler_1.errorResponse)(res, 403, 'Please use the admin portal to login');
        }
        const token = generateToken(user._id.toString(), user.role);
        res.cookie('jwt', token, {
            httpOnly: true,
            secure: env_1.ENV.NODE_ENV === 'production',
            sameSite: 'strict',
            maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
        });
        (0, responseHandler_1.successResponse)(res, 200, 'Login successful', {
            _id: user._id,
            name: user.name,
            email: user.email,
            phone: user.phone,
            role: user.role,
            token
        });
    }
    catch (error) {
        console.error("[DEBUG LOGIN] 8. Unexpected error in loginCustomer:", error);
        return (0, responseHandler_1.errorResponse)(res, 500, error.message || 'Internal Server Error');
    }
});
// Google OAuth Sign-In (supports both ID token and access token flows)
exports.googleAuth = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { credential, googleId: bodyGoogleId, name: bodyName, picture: bodyPicture } = req.body;
    let email;
    let name;
    let picture;
    let googleId;
    let emailVerified = false;
    const googleClientId = process.env.GOOGLE_CLIENT_ID || process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
    if (!googleClientId) {
        return (0, responseHandler_1.errorResponse)(res, 500, 'Google OAuth is not configured');
    }
    if (!credential || typeof credential !== 'string') {
        return (0, responseHandler_1.errorResponse)(res, 400, 'Google credential is required');
    }
    const client = new google_auth_library_1.OAuth2Client(googleClientId);
    try {
        if (bodyGoogleId) {
            // Access token (useGoogleLogin): identity comes only from Google, never from the request body.
            const info = await client.getTokenInfo(credential);
            if (info.aud !== googleClientId) {
                return (0, responseHandler_1.errorResponse)(res, 401, 'Invalid Google token');
            }
            email = info.email;
            googleId = info.sub;
            emailVerified = String(info.email_verified) === 'true';
            name = typeof bodyName === 'string' ? bodyName : undefined; // display only
            picture = typeof bodyPicture === 'string' ? bodyPicture : undefined; // display only
        }
        else {
            // ID token (One Tap / renderButton)
            const ticket = await client.verifyIdToken({ idToken: credential, audience: googleClientId });
            const payload = ticket.getPayload();
            email = payload?.email;
            googleId = payload?.sub;
            emailVerified = payload?.email_verified === true;
            name = payload?.name;
            picture = payload?.picture;
        }
    }
    catch (error) {
        console.error('Google token verification failed:', error.message);
        return (0, responseHandler_1.errorResponse)(res, 401, 'Invalid Google token');
    }
    if (!emailVerified) {
        return (0, responseHandler_1.errorResponse)(res, 401, 'Google account email is not verified');
    }
    if (!email || !googleId) {
        return (0, responseHandler_1.errorResponse)(res, 400, 'Invalid Google authentication data');
    }
    try {
        // Check if user already exists
        let user = await User_1.User.findOne({ email });
        if (user) {
            // User exists — check if active
            if (!user.isActive) {
                return (0, responseHandler_1.errorResponse)(res, 403, 'Your account has been deactivated');
            }
            // Admin accounts sign in through the admin portal only, like loginCustomer
            if (user.role !== 'customer') {
                return (0, responseHandler_1.errorResponse)(res, 403, 'Please use the admin portal to login');
            }
            // Update Google ID if not set, and make sure user is marked verified
            if (!user.googleId || !user.isVerified) {
                const updateFields = {};
                if (!user.googleId)
                    updateFields.googleId = googleId;
                if (!user.isVerified)
                    updateFields.isVerified = true;
                await User_1.User.findByIdAndUpdate(user._id, { $set: updateFields });
                if (!user.googleId)
                    user.googleId = googleId;
                user.isVerified = true;
            }
        }
        else {
            // Create new user with Google info (no password needed)
            user = await User_1.User.create({
                name: name || 'Google User',
                email,
                googleId,
                avatar: picture,
                role: 'customer',
                isVerified: true, // Google emails are already verified
                isActive: true,
                password: crypto_1.default.randomBytes(32).toString('hex'), // Unguessable; Google users never use it
            });
        }
        const token = generateToken(user._id.toString(), user.role);
        res.cookie('jwt', token, {
            httpOnly: true,
            secure: env_1.ENV.NODE_ENV === 'production',
            sameSite: 'strict',
            maxAge: 7 * 24 * 60 * 60 * 1000
        });
        (0, responseHandler_1.successResponse)(res, 200, 'Google sign-in successful', {
            _id: user._id,
            name: user.name,
            email: user.email,
            phone: user.phone,
            role: user.role,
            avatar: user.avatar,
            token
        });
    }
    catch (error) {
        console.error('Google auth error:', error);
        return (0, responseHandler_1.errorResponse)(res, 401, 'Google authentication failed');
    }
});
//# sourceMappingURL=authController.js.map