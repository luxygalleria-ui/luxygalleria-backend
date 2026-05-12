import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { User, IUser } from '../models/User';
import { asyncHandler } from '../utils/asyncHandler';
import { errorResponse } from '../utils/responseHandler';
import { ENV } from '../config/env';

// Extend Express Request type globally
declare global {
  namespace Express {
    interface Request {
      user?: IUser;
    }
  }
}

export const protect = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  let token;

  if (req.cookies.jwt) {
    token = req.cookies.jwt;
  } else if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return errorResponse(res, 401, 'Not authorized, no token provided');
  }

  try {
    const decoded = jwt.verify(token, ENV.JWT_SECRET) as { id: string, role: string };
    
    const user = await User.findById(decoded.id);
    if (!user) {
      return errorResponse(res, 401, 'Not authorized, user not found');
    }

    if (!user.isActive) {
      return errorResponse(res, 403, 'User account is deactivated');
    }

    req.user = user;
    next();
  } catch (error) {
    return errorResponse(res, 401, 'Not authorized, token failed');
  }
});

export const authorize = (...roles: string[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      // Log unauthorized access attempt
      const ip = req.ip || req.socket.remoteAddress || 'unknown';
      console.warn(`⚠️  Unauthorized access attempt to ${req.path} by user ${req.user?._id} with role ${req.user?.role}`);
      return errorResponse(res, 403, `User role '${req.user?.role}' is not authorized to access this route`);
    }
    next();
  };
};
