import winston from 'winston';
import { ENV } from '../config/env';

// Define log format
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json()
);

// Create logger instance
const logger = winston.createLogger({
  level: ENV.NODE_ENV === 'production' ? 'info' : 'debug',
  format: logFormat,
  defaultMeta: { service: 'heedy-backend' },
  transports: [
    // Write all logs with level 'error' and below to error.log
    new winston.transports.File({ 
      filename: 'logs/error.log', 
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
    // Write all logs to combined.log
    new winston.transports.File({ 
      filename: 'logs/combined.log',
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
  ],
});

// If not in production, also log to console
if (ENV.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    ),
  }));
}

// Security event logger
export const securityLogger = {
  loginAttempt: (email: string, ip: string, success: boolean) => {
    logger.info('Login attempt', {
      event: 'LOGIN_ATTEMPT',
      email,
      ip,
      success,
      timestamp: new Date().toISOString(),
    });
  },

  loginSuccess: (userId: string, email: string, ip: string) => {
    logger.info('Login successful', {
      event: 'LOGIN_SUCCESS',
      userId,
      email,
      ip,
      timestamp: new Date().toISOString(),
    });
  },

  loginFailure: (email: string, ip: string, reason: string) => {
    logger.warn('Login failed', {
      event: 'LOGIN_FAILURE',
      email,
      ip,
      reason,
      timestamp: new Date().toISOString(),
    });
  },

  accountLockout: (email: string, ip: string) => {
    logger.warn('Account locked due to multiple failed attempts', {
      event: 'ACCOUNT_LOCKOUT',
      email,
      ip,
      timestamp: new Date().toISOString(),
    });
  },

  otpGenerated: (email: string, ip: string) => {
    logger.info('OTP generated', {
      event: 'OTP_GENERATED',
      email,
      ip,
      timestamp: new Date().toISOString(),
    });
  },

  otpVerified: (email: string, ip: string, success: boolean) => {
    logger.info('OTP verification attempt', {
      event: 'OTP_VERIFICATION',
      email,
      ip,
      success,
      timestamp: new Date().toISOString(),
    });
  },

  unauthorizedAccess: (path: string, ip: string, userId?: string) => {
    logger.warn('Unauthorized access attempt', {
      event: 'UNAUTHORIZED_ACCESS',
      path,
      ip,
      userId,
      timestamp: new Date().toISOString(),
    });
  },

  suspiciousActivity: (description: string, ip: string, userId?: string) => {
    logger.warn('Suspicious activity detected', {
      event: 'SUSPICIOUS_ACTIVITY',
      description,
      ip,
      userId,
      timestamp: new Date().toISOString(),
    });
  },

  adminAction: (action: string, adminId: string, targetId?: string) => {
    logger.info('Admin action performed', {
      event: 'ADMIN_ACTION',
      action,
      adminId,
      targetId,
      timestamp: new Date().toISOString(),
    });
  },

  paymentAttempt: (userId: string, amount: number, success: boolean) => {
    logger.info('Payment attempt', {
      event: 'PAYMENT_ATTEMPT',
      userId,
      amount,
      success,
      timestamp: new Date().toISOString(),
    });
  },
};

export default logger;
