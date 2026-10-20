import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { User } from '../models/User';
import { asyncHandler } from '../utils/asyncHandler';
import { successResponse, errorResponse } from '../utils/responseHandler';
import { ENV } from '../config/env';
import { OAuth2Client } from 'google-auth-library';
import crypto from 'crypto';

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

  if (!user.otp || user.otp !== String(otp)) {
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
    
  } catch (emailError: any) {
    console.error('⚠️ Failed to send OTP email:', emailError.message);
    // Don't fail if email sending fails - continue anyway
  }

  successResponse(res, 200, 'New verification code generated and sent to your email.', null);
});

export const loginCustomer = asyncHandler(async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return errorResponse(res, 400, 'Please provide email and password');
    }

    const user = await User.findOne({ email }).select('+password');

    if (!user) {
      return errorResponse(res, 401, 'Invalid email or password');
    }

    const isMatch = await user.matchPassword(password);

    if (!isMatch) {
      return errorResponse(res, 401, 'Invalid email or password');
    }

    if (!user.isVerified) {
      return errorResponse(res, 403, 'Please verify your email to continue. We have sent an OTP to your email during registration.');
    }

    if (!user.isActive) {
      return errorResponse(res, 403, 'Your account has been deactivated');
    }

    // Only allow customers to use this endpoint
    if (user.role !== 'customer') {
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
  const { credential, googleId: bodyGoogleId, name: bodyName, picture: bodyPicture } = req.body;

  let email: string | undefined;
  let name: string | undefined;
  let picture: string | undefined;
  let googleId: string | undefined;
  let emailVerified = false;

  const googleClientId = process.env.GOOGLE_CLIENT_ID || process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
  if (!googleClientId) {
    return errorResponse(res, 500, 'Google OAuth is not configured');
  }
  if (!credential || typeof credential !== 'string') {
    return errorResponse(res, 400, 'Google credential is required');
  }

  const client = new OAuth2Client(googleClientId);
  try {
    if (bodyGoogleId) {
      // Access token (useGoogleLogin): identity comes only from Google, never from the request body.
      const info = await client.getTokenInfo(credential);
      if (info.aud !== googleClientId) {
        return errorResponse(res, 401, 'Invalid Google token');
      }
      email = info.email;
      googleId = info.sub;
      emailVerified = String(info.email_verified) === 'true';
      name = typeof bodyName === 'string' ? bodyName : undefined; // display only
      picture = typeof bodyPicture === 'string' ? bodyPicture : undefined; // display only
    } else {
      // ID token (One Tap / renderButton)
      const ticket = await client.verifyIdToken({ idToken: credential, audience: googleClientId });
      const payload = ticket.getPayload();
      email = payload?.email;
      googleId = payload?.sub;
      emailVerified = payload?.email_verified === true;
      name = payload?.name;
      picture = payload?.picture;
    }
  } catch (error: any) {
    console.error('Google token verification failed:', error.message);
    return errorResponse(res, 401, 'Invalid Google token');
  }

  if (!emailVerified) {
    return errorResponse(res, 401, 'Google account email is not verified');
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
      // Admin accounts sign in through the admin portal only, like loginCustomer
      if (user.role !== 'customer') {
        return errorResponse(res, 403, 'Please use the admin portal to login');
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
        password: crypto.randomBytes(32).toString('hex'), // Unguessable; Google users never use it
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
