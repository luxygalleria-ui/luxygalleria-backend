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
// Trust proxy - required when hosting behind a reverse proxy (like Render)
app.set('trust proxy', 1);
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
// Exact origins only, no *.vercel.app (old Vercel deployments retired; add a preview origin via CORS_ORIGIN if ever needed).
const allowedOrigins = [
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:3002',
    'https://luxygalleria.com',
    'https://www.luxygalleria.com',
    'https://admin.luxygalleria.com',
    ...(process.env.CORS_ORIGIN || '').split(',').map(o => o.trim().replace(/\/$/, '')).filter(Boolean),
];
const corsConfig = {
    origin: function (origin, callback) {
        // Allow requests with no origin (mobile apps, Postman, etc.)
        if (!origin)
            return callback(null, true);
        if (allowedOrigins.includes(origin)) {
            callback(null, true);
            return;
        }
        // Logged once, by errorHandler (method, path, origin, 403): a second line here doubled every rejection.
        // Still reject before any handler runs (cookie auth), but as a 403, not a 500.
        callback(Object.assign(new Error("Not allowed by CORS"), { statusCode: 403 }));
    },
    credentials: true,
    optionsSuccessStatus: 200,
};
// ICICI posts here from its own pages and servers (the customer's browser carries ICICI's Origin). No CORS on these:
// they never read a cookie and are authenticated by the gateway's secureHash (controllers/iciciController.ts).
const iciciInbound = /^\/api\/v1\/payments\/icici\/(callback|payment-advice|settlement-advice)\/?$/;
const corsMiddleware = (0, cors_1.default)(corsConfig);
app.use((req, res, next) => (iciciInbound.test(req.path) ? next() : corsMiddleware(req, res, next)));
app.options("*", (0, cors_1.default)(corsConfig));
// Health Check Route (for monitoring and Render wake-up)
app.get('/', (req, res) => {
    res.status(200).json({
        success: true,
        message: 'Luxy Galleria Backend is running ✅',
        timestamp: new Date().toISOString(),
        version: '1.0.0'
    });
});
app.get('/api/v1/health', (req, res) => {
    res.status(200).json({
        success: true,
        message: 'Backend is running',
        timestamp: new Date().toISOString()
    });
});
// Body parsers with size limits
// rawBody: the exact bytes the ERP signed (middlewares/erpAuth.ts)
app.use(express_1.default.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
// rawBody also for form posts: ICICI's secureHash is checked against the bytes it sent, before the sanitizers below
app.use(express_1.default.urlencoded({ extended: true, limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use((0, cookie_parser_1.default)());
// Sanitization middleware - prevent NoSQL injection and XSS
app.use(sanitize_1.sanitizeInput);
app.use(sanitize_1.sanitizeStrings);
// Rate limiting - apply to all API routes
app.use('/api/', rateLimiter_1.apiLimiter);
// Logger
// ICICI may return the payment result on the callback URL: never write those parameters (payer details, hash) to the log
morgan_1.default.token('url', (req) => String(req.originalUrl || req.url).replace(/^(\/api\/v1\/payments\/icici\/[^?]*)\?.*$/, '$1?<redacted>'));
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
// Public product images, shown by the storefront and admin on other origins (helmet defaults to same-origin)
app.use('/uploads', (req, res, next) => { res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin'); next(); }, express_1.default.static(path_1.default.join(__dirname, '../uploads')));
// 404 Handler
app.use(notFoundHandler_1.notFoundHandler);
// Global Error Handler
app.use(errorHandler_1.errorHandler);
exports.default = app;
//# sourceMappingURL=app.js.map