"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const morgan_1 = __importDefault(require("morgan"));
const cookie_parser_1 = __importDefault(require("cookie-parser"));
const env_1 = require("./config/env");
const routes_1 = __importDefault(require("./routes"));
const errorHandler_1 = require("./middlewares/errorHandler");
const notFoundHandler_1 = require("./middlewares/notFoundHandler");
const sanitize_1 = require("./middlewares/sanitize");
const rateLimiter_1 = require("./middlewares/rateLimiter");
const logger_1 = __importDefault(require("./utils/logger"));
const app = (0, express_1.default)();
// Security Middlewares
// Helmet - sets various HTTP headers for security
app.use((0, helmet_1.default)({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            scriptSrc: ["'self'"],
            imgSrc: ["'self'", 'data:', 'https:'],
        },
    },
    hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true,
    },
}));
// CORS configuration
const allowedOrigins = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(",").map(o => o.trim())
    : [
        'http://localhost:3000',
        'http://localhost:3001',
        'http://localhost:3002',
        'http://localhost:3000/',
        'http://localhost:3001/',
        'http://localhost:3002/',
        'https://luxygalleria-frontend.vercel.app',
        'https://luxygalleria-admin.vercel.app',
        'https://*.vercel.app', // Allow all Vercel preview deployments
    ];
const corsConfig = {
    origin: function (origin, callback) {
        // Allow requests with no origin (mobile apps, Postman, etc.)
        if (!origin)
            return callback(null, true);
        // Check exact match
        if (allowedOrigins.includes(origin)) {
            callback(null, true);
            return;
        }
        // Check wildcard match for Vercel preview deployments
        const isVercelPreview = origin.includes('.vercel.app');
        if (isVercelPreview) {
            callback(null, true);
            return;
        }
        logger_1.default.warn(`CORS blocked request from origin: ${origin}`);
        callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
    optionsSuccessStatus: 200,
};
app.use((0, cors_1.default)(corsConfig));
app.options("*", (0, cors_1.default)(corsConfig));
// Body parsers with size limits
app.use(express_1.default.json({ limit: '50mb' }));
app.use(express_1.default.urlencoded({ extended: true, limit: '50mb' }));
app.use((0, cookie_parser_1.default)());
// Sanitization middleware - prevent NoSQL injection and XSS
app.use(sanitize_1.sanitizeInput);
app.use(sanitize_1.sanitizeStrings);
// Rate limiting - apply to all API routes
app.use('/api/', rateLimiter_1.apiLimiter);
// Logger
if (env_1.ENV.NODE_ENV === 'development') {
    app.use((0, morgan_1.default)('dev'));
}
else {
    // Production logging
    app.use((0, morgan_1.default)('combined', {
        stream: {
            write: (message) => logger_1.default.info(message.trim()),
        },
    }));
}
// API Routes
app.use('/api/v1', routes_1.default);
const path_1 = __importDefault(require("path"));
app.use('/uploads', express_1.default.static(path_1.default.join(__dirname, '../uploads')));
// 404 Handler
app.use(notFoundHandler_1.notFoundHandler);
// Global Error Handler
app.use(errorHandler_1.errorHandler);
exports.default = app;
//# sourceMappingURL=app.js.map