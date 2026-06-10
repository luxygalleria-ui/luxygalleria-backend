"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.uploadLimiter = exports.paymentLimiter = exports.otpLimiter = exports.authLimiter = exports.apiLimiter = void 0;
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
// General API rate limiter
exports.apiLimiter = (0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: process.env.NODE_ENV === 'development' ? 1000 : 100, // Higher limit for development
    message: 'Too many requests from this IP, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
});
// Strict rate limiter for authentication endpoints
exports.authLimiter = (0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: process.env.NODE_ENV === 'development' ? 50 : 5, // Higher limit for development
    message: 'Too many login attempts from this IP, please try again after 15 minutes.',
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true, // Don't count successful requests
});
// OTP rate limiter
exports.otpLimiter = (0, express_rate_limit_1.default)({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: process.env.NODE_ENV === 'development' ? 30 : 3, // Higher limit for development
    message: 'Too many OTP requests. Please try again after 1 hour.',
    standardHeaders: true,
    legacyHeaders: false,
});
// Payment rate limiter
exports.paymentLimiter = (0, express_rate_limit_1.default)({
    windowMs: 60 * 1000, // 1 minute
    max: process.env.NODE_ENV === 'development' ? 100 : 10, // Higher limit for development
    message: 'Too many payment requests. Please slow down.',
    standardHeaders: true,
    legacyHeaders: false,
});
// File upload rate limiter
exports.uploadLimiter = (0, express_rate_limit_1.default)({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: process.env.NODE_ENV === 'development' ? 200 : 20, // Higher limit for development
    message: 'Too many file uploads. Please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
});
//# sourceMappingURL=rateLimiter.js.map