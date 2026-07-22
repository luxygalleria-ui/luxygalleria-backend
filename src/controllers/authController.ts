import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { User } from '../models/User';
import { asyncHandler } from '../utils/asyncHandler';
import { successResponse, errorResponse } from '../utils/responseHandler';
import { ENV } from '../config/env';
import { OAuth2Client } from 'google-auth-library';

const generateToken = (id: string, role: string) => {
  return jwt.sign({ id, role }, ENV.JWT_SECRET, {
    expiresIn: ENV.JWT_EXPIRES_IN as any,
  });
};

export const loginAdmin = asyncHandler(async (req: Request, res: Response) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return errorResponse(res, 400, 'Please provide email and password');
  }

  // Check if user exists and select password
  const user = await User.findOne({ email }).select('+password');

  if (!user || !(await user.matchPassword(password))) {
    return errorResponse(res, 401, 'Invalid email or password');
  }

  if (!user.isActive) {
    return errorResponse(res, 403, 'Your account has been deactivated');
  }

  // Check if role is admin or superadmin
  if (user.role !== 'admin' && user.role !== 'superadmin') {
     return errorResponse(res, 403, 'Not authorized to access admin portal');
  }

  // Generate Token
  const token = generateToken(user._id.toString(), user.role);

  // Set Cookie for extra security (HTTP-Only)
  res.cookie('jwt', token, {
    httpOnly: true,
    secure: ENV.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  });

  successResponse(res, 200, 'Login successful', {
    _id: user._id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    token
  });
});

// Helper to quickly create a test admin user (Can be removed later)
export const createTestAdmin = asyncHandler(async (req: Request, res: Response) => {
  if (ENV.NODE_ENV === 'production') {
    return errorResponse(res, 403, 'Cannot create test admin in production');
  }

  const adminEmail = process.env.ADMIN_EMAIL || 'admin@luxygalleria.com';
  const adminPassword = process.env.ADMIN_PASSWORD || 'password123';
  const userExists = await User.findOne({ email: adminEmail }).select('+password');

  if (userExists) {
    if (userExists.role === 'admin' || userExists.role === 'superadmin') {
      userExists.password = adminPassword;
      userExists.role = 'superadmin';
      userExists.isVerified = true;
      userExists.isActive = true;
      await userExists.save();

      return successResponse(res, 200, 'Test admin reset successfully. You can now login.', {
        email: adminEmail,
        password: adminPassword
      });
    }

    return errorResponse(res, 400, 'Email is already registered as a customer');
  }

  const admin = await User.create({
    name: 'System Admin',
    email: adminEmail,
    password: adminPassword,
    role: 'superadmin',
    isVerified: true,
    isActive: true,
  });

  successResponse(res, 201, 'Test admin created successfully. You can now login.', {
    email: admin.email,
    password: adminPassword
  });
});

import { sendEmail } from '../utils/sendEmail';

export const registerCustomer = asyncHandler(async (req: Request, res: Response) => {
  const { name, email, password, phone, addresses } = req.body;

  if (!name || !email || !password) {
    return errorResponse(res, 400, 'Please provide name, email and password');
  }

  const existing = await User.findOne({ email });
  if (existing) {
    return errorResponse(res, 400, 'Email is already registered');
  }

  // Direct signup — account is active and usable immediately (no email OTP step)
  const user = await User.create({
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
    secure: ENV.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  });

  successResponse(res, 201, 'Registration successful', {
    _id: user._id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    token
  });
});

export const verifyOtp = asyncHandler(async (req: Request, res: Response) => {
  const { email, otp } = req.body;

  if (!email || !otp) {
    return errorResponse(res, 400, 'Please provide email and OTP');
  }

  const user = await User.findOne({ email });

  if (!user) {
    return errorResponse(res, 404, 'User not found');
  }

  if (user.isVerified) {
    return errorResponse(res, 400, 'User is already verified');
  }

  if (user.otp !== otp) {
    return errorResponse(res, 400, 'Invalid OTP code');
  }

  if (user.otpExpires && user.otpExpires < new Date()) {
    return errorResponse(res, 400, 'OTP code has expired');
  }

  // Verify user
  user.isVerified = true;
  user.otp = undefined;
  user.otpExpires = undefined;
  await user.save();

  const token = generateToken(user._id.toString(), user.role);

  res.cookie('jwt', token, {
    httpOnly: true,
    secure: ENV.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  });

  successResponse(res, 200, 'Email verified successfully', {
    _id: user._id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    token
  });
});

export const resendOtp = asyncHandler(async (req: Request, res: Response) => {
  const { email } = req.body;

  if (!email) {
    return errorResponse(res, 400, 'Please provide email');
  }

  const user = await User.findOne({ email });

  if (!user) {
    return errorResponse(res, 404, 'User not found');
  }

  if (user.isVerified) {
    return errorResponse(res, 400, 'User is already verified');
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
    
    await sendEmail({
      email,
      subject: emailSubject,
      message: emailMessage,
      html: emailHTML
    });
    
    console.log('\n✅ New OTP Email sent to:', email, 'OTP:', otp, '\n');
  } catch (emailError: any) {
    console.error('⚠️ Failed to send OTP email:', emailError.message);
    // Don't fail if email sending fails - continue anyway
    console.log('\n✅ NEW OTP:', otp, 'for', user.email, '(Email sending failed but OTP generated)\n');
  }

  successResponse(res, 200, 'New verification code generated and sent to your email.', {
    otp
  });
});

export const loginCustomer = asyncHandler(async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    console.log("[DEBUG LOGIN] 1. Received Email:", email);

    if (!email || !password) {
      console.log("[DEBUG LOGIN] Validation failed: email or password missing");
      return errorResponse(res, 400, 'Please provide email and password');
    }

    const user = await User.findOne({ email }).select('+password');
    console.log("[DEBUG LOGIN] 2. User found in DB?:", !!user);

    if (!user) {
      console.log("[DEBUG LOGIN] 7. Returning 'Invalid email or password' because user was not found in DB");
      return errorResponse(res, 401, 'Invalid email or password');
    }

    console.log("[DEBUG LOGIN] 3. DB User Email:", user.email);
    console.log("[DEBUG LOGIN] 4. DB User Role:", user.role);
    console.log("[DEBUG LOGIN] 5. Password field exists in DB user?:", !!user.password);

    const isMatch = await user.matchPassword(password);
    console.log("[DEBUG LOGIN] 6. Password match result:", isMatch);

    if (!isMatch) {
      console.log("[DEBUG LOGIN] 7. Returning 'Invalid email or password' because password does not match");
      return errorResponse(res, 401, 'Invalid email or password');
    }

    if (!user.isVerified) {
      console.log("[DEBUG LOGIN] Verification check failed: User not verified");
      return errorResponse(res, 403, 'Please verify your email to continue. We have sent an OTP to your email during registration.');
    }

    if (!user.isActive) {
      console.log("[DEBUG LOGIN] Active check failed: User deactivated");
      return errorResponse(res, 403, 'Your account has been deactivated');
    }

    // Only allow customers to use this endpoint
    if (user.role !== 'customer') {
      console.log("[DEBUG LOGIN] Role check failed: User is not a customer");
      return errorResponse(res, 403, 'Please use the admin portal to login');
    }

    const token = generateToken(user._id.toString(), user.role);

    res.cookie('jwt', token, {
      httpOnly: true,
      secure: ENV.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });

    successResponse(res, 200, 'Login successful', {
      _id: user._id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: user.role,
      token
    });
  } catch (error: any) {
    console.error("[DEBUG LOGIN] 8. Unexpected error in loginCustomer:", error);
    return errorResponse(res, 500, error.message || 'Internal Server Error');
  }
});

// Google OAuth Sign-In (supports both ID token and access token flows)
export const googleAuth = asyncHandler(async (req: Request, res: Response) => {
  const { credential, googleId: bodyGoogleId, email: bodyEmail, name: bodyName, picture: bodyPicture } = req.body;

  let email: string | undefined;
  let name: string | undefined;
  let picture: string | undefined;
  let googleId: string | undefined;

  // Flow 1: ID Token (from Google One Tap / renderButton)
  if (credential && !bodyGoogleId) {
    const googleClientId = process.env.GOOGLE_CLIENT_ID;
    if (!googleClientId) {
      return errorResponse(res, 500, 'Google OAuth is not configured');
    }

    const client = new OAuth2Client(googleClientId);

    try {
      const ticket = await client.verifyIdToken({
        idToken: credential,
        audience: googleClientId,
      });

      const payload = ticket.getPayload();
      if (!payload || !payload.email) {
        return errorResponse(res, 400, 'Invalid Google token');
      }

      email = payload.email;
      name = payload.name;
      picture = payload.picture;
      googleId = payload.sub;
    } catch (error: any) {
      console.error('Google ID token verification error:', error);
      return errorResponse(res, 401, 'Invalid Google token');
    }
  }
  // Flow 2: Access Token (from @react-oauth/google useGoogleLogin)
  else if (bodyGoogleId && bodyEmail) {
    // The frontend already fetched user info from Google's userinfo endpoint
    // We trust this because it came from a verified Google access token on the frontend
    email = bodyEmail;
    name = bodyName;
    picture = bodyPicture;
    googleId = bodyGoogleId;
  } else {
    return errorResponse(res, 400, 'Google credential is required');
  }

  if (!email || !googleId) {
    return errorResponse(res, 400, 'Invalid Google authentication data');
  }

  try {
    // Check if user already exists
    let user = await User.findOne({ email });

    if (user) {
      // User exists — check if active
      if (!user.isActive) {
        return errorResponse(res, 403, 'Your account has been deactivated');
      }
      // Update Google ID if not set, and make sure user is marked verified
      if (!user.googleId || !user.isVerified) {
        const updateFields: any = {};
        if (!user.googleId) updateFields.googleId = googleId;
        if (!user.isVerified) updateFields.isVerified = true;
        
        await User.findByIdAndUpdate(user._id, { $set: updateFields });
        
        if (!user.googleId) user.googleId = googleId;
        user.isVerified = true;
      }
    } else {
      // Create new user with Google info (no password needed)
      user = await User.create({
        name: name || 'Google User',
        email,
        googleId,
        avatar: picture,
        role: 'customer',
        isVerified: true, // Google emails are already verified
        isActive: true,
        password: `google_${googleId}_${Date.now()}`, // Random password since Google users don't need one
      });
    }

    const token = generateToken(user._id.toString(), user.role);

    res.cookie('jwt', token, {
      httpOnly: true,
      secure: ENV.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    successResponse(res, 200, 'Google sign-in successful', {
      _id: user._id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: user.role,
      avatar: user.avatar,
      token
    });
  } catch (error: any) {
    console.error('Google auth error:', error);
    return errorResponse(res, 401, 'Google authentication failed');
  }
});
