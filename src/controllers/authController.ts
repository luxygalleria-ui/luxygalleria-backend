import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { User } from '../models/User';
import { asyncHandler } from '../utils/asyncHandler';
import { successResponse, errorResponse } from '../utils/responseHandler';
import { ENV } from '../config/env';
import { OAuth2Client } from 'google-auth-library';
import crypto from 'crypto';

// Secure unless NODE_ENV is exactly "development" (local http). Unset, "staging", "Production" or any typo fail safe to
// Secure: the cookie then only travels over HTTPS, which production and HTTPS staging already use.
export const secureCookies = () => process.env.NODE_ENV !== 'development';

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
    secure: secureCookies(),
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
import { addressProblem } from '../utils/addressRules';

export const registerCustomer = asyncHandler(async (req: Request, res: Response) => {
  const { name, email, password, phone, addresses } = req.body;

  if (!name || !email || !password) {
    return errorResponse(res, 400, 'Please provide name, email and password');
  }

  // The sign-up address is optional: a blank entry is dropped (it used to be stored as an empty saved address that
  // checkout then reported as incomplete); a filled one follows the same rules as the address book
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const given = (Array.isArray(addresses) ? addresses : []).filter((a: any) => a && typeof a === 'object'
    && [a.street, a.city, a.state, a.zipCode].some((v) => text(v)));
  for (const a of given) {
    if (!text(a.city) || !text(a.state)) return errorResponse(res, 400, 'The address needs a city and a state (or leave the address empty).');
    const problem = addressProblem(a);
    if (problem) return errorResponse(res, 400, problem);
  }
  const signupAddresses = given.map((a: any) => ({ street: a.street, apartment: a.apartment, landmark: a.landmark, city: a.city, state: a.state, zipCode: a.zipCode, country: a.country }));

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
    addresses: signupAddresses,
    isVerified: true,
    isActive: true,
  });

  const token = generateToken(user._id.toString(), user.role);

  res.cookie('jwt', token, {
    httpOnly: true,
    secure: secureCookies(),
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
    secure: secureCookies(),
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
  const otp = crypto.randomInt(100000, 1000000).toString(); // CSPRNG: Math.random is predictable
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

    // No isVerified check: registration verifies accounts itself and the site has no OTP screen, so older unverified
    // accounts were locked out with a 403 they could never clear. The correct password is the proof here.

    if (!user.isActive) {
      return errorResponse(res, 403, 'Your account has been deactivated');
    }

    // Only allow customers to use this endpoint
    if (user.role !== 'customer') {
      return errorResponse(res, 403, 'This is a staff account. Please sign in through the admin portal.', { code: 'USE_ADMIN_PORTAL' });
    }

    const token = generateToken(user._id.toString(), user.role);

    res.cookie('jwt', token, {
      httpOnly: true,
      secure: secureCookies(),
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
    console.error("Unexpected error in loginCustomer:", error?.message);
    return errorResponse(res, 500, "Internal Server Error");
  }
});

// Google OAuth Sign-In (supports both ID token and access token flows)
/**
 * Verifies a Google credential with Google and returns the identity Google vouches for (never the request body's).
 * Access token (useGoogleLogin, with googleId in the body) -> tokeninfo + audience; otherwise an ID token.
 */
type GoogleIdentity = { email: string; googleId: string; name?: string; picture?: string };
const verifyGoogleCredential = async (body: any): Promise<{ ok: true; id: GoogleIdentity } | { ok: false; status: number; message: string }> => {
  const { credential, googleId: bodyGoogleId, name: bodyName, picture: bodyPicture } = body || {};
  const googleClientId = process.env.GOOGLE_CLIENT_ID || process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
  if (!googleClientId) return { ok: false, status: 500, message: 'Google OAuth is not configured' };
  if (!credential || typeof credential !== 'string') return { ok: false, status: 400, message: 'Google credential is required' };

  let email: string | undefined; let googleId: string | undefined; let name: string | undefined; let picture: string | undefined;
  let emailVerified = false;
  const client = new OAuth2Client(googleClientId);
  try {
    if (bodyGoogleId) {
      // Access token (useGoogleLogin): identity comes only from Google, never from the request body.
      const info = await client.getTokenInfo(credential);
      if (info.aud !== googleClientId) return { ok: false, status: 401, message: 'Invalid Google token' };
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
    return { ok: false, status: 401, message: 'Invalid Google token' };
  }
  if (!emailVerified) return { ok: false, status: 401, message: 'Google account email is not verified' };
  if (!email || !googleId) return { ok: false, status: 400, message: 'Invalid Google authentication data' };
  return { ok: true, id: { email, googleId, name, picture } };
};

export const googleAuth = asyncHandler(async (req: Request, res: Response) => {
  const verified = await verifyGoogleCredential(req.body);
  if (!verified.ok) return errorResponse(res, verified.status, verified.message);
  const { email, googleId, name, picture } = verified.id;

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
        return errorResponse(res, 403, 'This is a staff account. Please sign in through the admin portal.', { code: 'USE_ADMIN_PORTAL' });
      }
      // Never link automatically: anyone can register an email address without proving they own it, so an existing
      // password account is only ever linked by its signed-in owner (POST /auth/google/link). Signing in with Google
      // works only for the Google identity already on the account.
      if (!user.googleId) {
        return errorResponse(res, 409, 'An account with this email already exists. Sign in with your email and password, then link Google from your profile.', { code: 'GOOGLE_LINK_REQUIRED' });
      }
      if (user.googleId !== googleId) {
        return errorResponse(res, 409, 'This account is linked to a different Google account. Sign in with your email and password.', { code: 'GOOGLE_ACCOUNT_MISMATCH' });
      }
      if (!user.isVerified) {
        await User.findByIdAndUpdate(user._id, { $set: { isVerified: true } });
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
      secure: secureCookies(),
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

// POST /auth/google/link (signed-in customer): the owner explicitly links their Google account. The Google email must
// be the account's email, and one Google identity can belong to one account only.
export const linkGoogleAccount = asyncHandler(async (req: Request, res: Response) => {
  const user = await User.findById(req.user?._id);
  if (!user) return errorResponse(res, 404, 'User not found');
  if (user.role !== 'customer') return errorResponse(res, 403, 'Only customer accounts can link Google');
  const verified = await verifyGoogleCredential(req.body);
  if (!verified.ok) return errorResponse(res, verified.status, verified.message);
  const { email, googleId } = verified.id;
  if (email.trim().toLowerCase() !== String(user.email).trim().toLowerCase()) {
    return errorResponse(res, 409, 'This Google account uses a different email address. Link the Google account for ' + user.email + '.', { code: 'GOOGLE_EMAIL_MISMATCH' });
  }
  if (user.googleId === googleId) return successResponse(res, 200, 'Google account already linked', { googleLinked: true });
  if (user.googleId) return errorResponse(res, 409, 'A different Google account is already linked to this account.', { code: 'GOOGLE_ACCOUNT_MISMATCH' });
  if (await User.exists({ googleId, _id: { $ne: user._id } })) {
    return errorResponse(res, 409, 'This Google account is already linked to another account.', { code: 'GOOGLE_ALREADY_LINKED' });
  }
  await User.updateOne({ _id: user._id, googleId: { $exists: false } }, { $set: { googleId } });
  successResponse(res, 200, 'Google account linked', { googleLinked: true });
});

// ---------------------------------------------------------------------------------------------------------------------
// Forgot / reset password (customers). The reply never says whether an account exists; the emailed token is random,
// single-use, valid for 30 minutes and stored only as a sha256 hash; a reset signs every earlier session out.
// ---------------------------------------------------------------------------------------------------------------------
import { schemas } from '../middlewares/validation';

export const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;
export const FORGOT_PASSWORD_REPLY = 'If an account exists for that email address, we have sent a link to reset the password. The link expires in 30 minutes.';
const INVALID_RESET_LINK = 'This reset link is invalid or has expired. Please request a new one.';
const EMAIL_FORMAT = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** The same password rule as registration (8+ characters with upper and lower case, a number and a symbol) */
const passwordRule = schemas.register.shape.body.shape.password;

export const hashResetToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
const frontendBase = () => (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '');

export const forgotPassword = asyncHandler(async (req: Request, res: Response) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
  if (!EMAIL_FORMAT.test(email) || email.length > 254) {
    return errorResponse(res, 400, 'Please enter a valid email address.');
  }

  // Customers only (staff use the admin portal); unknown, staff or deactivated accounts get the same reply
  const user = await User.findOne({ email, role: 'customer', isActive: true }).select('+passwordResetExpires');
  if (user) {
    // Asked again within a minute: keep the link already sent instead of mailing a new one (no inbox flooding)
    const justSent = user.passwordResetExpires && user.passwordResetExpires.getTime() - Date.now() > PASSWORD_RESET_TTL_MS - 60_000;
    if (!justSent) {
      const token = crypto.randomBytes(32).toString('hex'); // 256-bit CSPRNG token, only its hash is stored
      await User.updateOne({ _id: user._id }, {
        $set: { passwordResetTokenHash: hashResetToken(token), passwordResetExpires: new Date(Date.now() + PASSWORD_RESET_TTL_MS) },
      });
      const link = `${frontendBase()}/reset-password?token=${token}`;
      // Not awaited: the reply takes the same time whether or not the account exists. sensitive: the body (the link)
      // is never written to any log
      sendEmail({
        email: user.email,
        subject: 'Reset your Luxy Galleria password',
        sensitive: true,
        message: `We received a request to reset the password of your Luxy Galleria account.\n\nOpen this link within 30 minutes to choose a new password:\n${link}\n\nIf you did not ask for this, you can ignore this email; your password stays the same.`,
        html: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #0A192F;">Reset your password</h2>
          <p>We received a request to reset the password of your Luxy Galleria account.</p>
          <p><a href="${link}" style="display:inline-block;background:#111827;color:#fff;text-decoration:none;padding:12px 24px;border-radius:6px;">Choose a new password</a></p>
          <p style="color:#6b7280;font-size:14px;">This link expires in 30 minutes and can be used once. If you did not ask for this, you can ignore this email; your password stays the same.</p>
        </div>`,
      }).catch((err: any) => console.error('Password reset email could not be sent:', err?.message));
    }
  }
  return successResponse(res, 200, FORGOT_PASSWORD_REPLY, null);
});

export const resetPassword = asyncHandler(async (req: Request, res: Response) => {
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  const { password, confirmPassword } = req.body ?? {};
  if (!/^[a-f0-9]{64}$/.test(token)) return errorResponse(res, 400, INVALID_RESET_LINK);
  if (typeof password !== 'string' || typeof confirmPassword !== 'string' || password !== confirmPassword) {
    return errorResponse(res, 400, 'The two passwords do not match.');
  }
  // Checked before the token is used, so a weak first attempt does not spend the link
  const strength = passwordRule.safeParse(password);
  if (!strength.success) return errorResponse(res, 400, strength.error.issues[0]?.message || 'Please choose a stronger password.');

  // Claim the token atomically: it works once; a second or concurrent use finds nothing
  const user = await User.findOneAndUpdate(
    { passwordResetTokenHash: hashResetToken(token), passwordResetExpires: { $gt: new Date() } },
    { $unset: { passwordResetTokenHash: 1, passwordResetExpires: 1 } },
    { new: true },
  );
  if (!user) return errorResponse(res, 400, INVALID_RESET_LINK);

  user.password = password; // hashed by the model's pre-save hook (bcrypt), like registration
  user.passwordChangedAt = new Date(Date.now() - 1000); // sessions issued before the reset are refused (1 s for clock granularity)
  await user.save();

  // Never logged in automatically: clear any session cookie on this browser too
  res.clearCookie('jwt', { httpOnly: true, secure: secureCookies(), sameSite: 'strict' });
  return successResponse(res, 200, 'Your password has been reset. Please sign in with your new password.', null);
});
