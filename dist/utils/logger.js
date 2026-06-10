"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.securityLogger = void 0;
const winston_1 = __importDefault(require("winston"));
const env_1 = require("../config/env");
// Define log format
const logFormat = winston_1.default.format.combine(winston_1.default.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), winston_1.default.format.errors({ stack: true }), winston_1.default.format.splat(), winston_1.default.format.json());
// Create logger instance
const logger = winston_1.default.createLogger({
    level: env_1.ENV.NODE_ENV === 'production' ? 'info' : 'debug',
    format: logFormat,
    defaultMeta: { service: 'luxygalleria-backend' },
    transports: [
        // Write all logs with level 'error' and below to error.log
        new winston_1.default.transports.File({
            filename: 'logs/error.log',
            level: 'error',
            maxsize: 5242880, // 5MB
            maxFiles: 5,
        }),
        // Write all logs to combined.log
        new winston_1.default.transports.File({
            filename: 'logs/combined.log',
            maxsize: 5242880, // 5MB
            maxFiles: 5,
        }),
    ],
});
// If not in production, also log to console
if (env_1.ENV.NODE_ENV !== 'production') {
    logger.add(new winston_1.default.transports.Console({
        format: winston_1.default.format.combine(winston_1.default.format.colorize(), winston_1.default.format.simple()),
    }));
}
// Security event logger
exports.securityLogger = {
    loginAttempt: (email, ip, success) => {
        logger.info('Login attempt', {
            event: 'LOGIN_ATTEMPT',
            email,
            ip,
            success,
            timestamp: new Date().toISOString(),
        });
    },
    loginSuccess: (userId, email, ip) => {
        logger.info('Login successful', {
            event: 'LOGIN_SUCCESS',
            userId,
            email,
            ip,
            timestamp: new Date().toISOString(),
        });
    },
    loginFailure: (email, ip, reason) => {
        logger.warn('Login failed', {
            event: 'LOGIN_FAILURE',
            email,
            ip,
            reason,
            timestamp: new Date().toISOString(),
        });
    },
    accountLockout: (email, ip) => {
        logger.warn('Account locked due to multiple failed attempts', {
            event: 'ACCOUNT_LOCKOUT',
            email,
            ip,
            timestamp: new Date().toISOString(),
        });
    },
    otpGenerated: (email, ip) => {
        logger.info('OTP generated', {
            event: 'OTP_GENERATED',
            email,
            ip,
            timestamp: new Date().toISOString(),
        });
    },
    otpVerified: (email, ip, success) => {
        logger.info('OTP verification attempt', {
            event: 'OTP_VERIFICATION',
            email,
            ip,
            success,
            timestamp: new Date().toISOString(),
        });
    },
    unauthorizedAccess: (path, ip, userId) => {
        logger.warn('Unauthorized access attempt', {
            event: 'UNAUTHORIZED_ACCESS',
            path,
            ip,
            userId,
            timestamp: new Date().toISOString(),
        });
    },
    suspiciousActivity: (description, ip, userId) => {
        logger.warn('Suspicious activity detected', {
            event: 'SUSPICIOUS_ACTIVITY',
            description,
            ip,
            userId,
            timestamp: new Date().toISOString(),
        });
    },
    adminAction: (action, adminId, targetId) => {
        logger.info('Admin action performed', {
            event: 'ADMIN_ACTION',
            action,
            adminId,
            targetId,
            timestamp: new Date().toISOString(),
        });
    },
    paymentAttempt: (userId, amount, success) => {
        logger.info('Payment attempt', {
            event: 'PAYMENT_ATTEMPT',
            userId,
            amount,
            success,
            timestamp: new Date().toISOString(),
        });
    },
};
exports.default = logger;
//# sourceMappingURL=logger.js.map