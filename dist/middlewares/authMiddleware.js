"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.adminOnly = exports.authorize = exports.protect = void 0;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const User_1 = require("../models/User");
const asyncHandler_1 = require("../utils/asyncHandler");
const responseHandler_1 = require("../utils/responseHandler");
const env_1 = require("../config/env");
exports.protect = (0, asyncHandler_1.asyncHandler)(async (req, res, next) => {
    let token;
    if (req.cookies.jwt) {
        token = req.cookies.jwt;
    }
    else if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        token = req.headers.authorization.split(' ')[1];
    }
    if (!token) {
        return (0, responseHandler_1.errorResponse)(res, 401, 'Not authorized, no token provided');
    }
    try {
        const decoded = jsonwebtoken_1.default.verify(token, env_1.ENV.JWT_SECRET);
        const user = await User_1.User.findById(decoded.id);
        if (!user) {
            return (0, responseHandler_1.errorResponse)(res, 401, 'Not authorized, user not found');
        }
        if (!user.isActive) {
            return (0, responseHandler_1.errorResponse)(res, 403, 'User account is deactivated');
        }
        req.user = user;
        next();
    }
    catch (error) {
        console.error('Token verification failed:', error.message);
        return (0, responseHandler_1.errorResponse)(res, 401, 'Not authorized, token failed');
    }
});
const authorize = (...roles) => {
    return (req, res, next) => {
        if (!req.user || !roles.includes(req.user.role)) {
            // Log unauthorized access attempt
            const ip = req.ip || req.socket.remoteAddress || 'unknown';
            console.warn(`⚠️  Unauthorized access attempt to ${req.path} by user ${req.user?._id} with role ${req.user?.role}`);
            return (0, responseHandler_1.errorResponse)(res, 403, `User role '${req.user?.role}' is not authorized to access this route`);
        }
        next();
    };
};
exports.authorize = authorize;
exports.adminOnly = (0, exports.authorize)('admin', 'superadmin');
//# sourceMappingURL=authMiddleware.js.map