import express, { Application } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';

import { ENV } from './config/env';
import apiRoutes from './routes';
import { errorHandler } from './middlewares/errorHandler';
import { notFoundHandler } from './middlewares/notFoundHandler';
import { sanitizeInput, sanitizeStrings } from './middlewares/sanitize';
import { apiLimiter } from './middlewares/rateLimiter';
import logger from './utils/logger';

const app: Application = express();

// Trust proxy - required when hosting behind a reverse proxy (like Render)
app.set('trust proxy', 1);

// Security Middlewares
// Helmet - sets various HTTP headers for security
app.use(helmet({
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
  origin: function (origin: string | undefined, callback: any) {
    // Allow requests with no origin (mobile apps, Postman, etc.)
    if (!origin) return callback(null, true);

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
const corsMiddleware = cors(corsConfig);
app.use((req, res, next) => (iciciInbound.test(req.path) ? next() : corsMiddleware(req, res, next)));
app.options("*", cors(corsConfig));

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
app.use(express.json({ limit: '1mb', verify: (req: any, _res, buf) => { req.rawBody = buf; } }));
// rawBody also for form posts: ICICI's secureHash is checked against the bytes it sent, before the sanitizers below
app.use(express.urlencoded({ extended: true, limit: '1mb', verify: (req: any, _res, buf) => { req.rawBody = buf; } }));
app.use(cookieParser());

// Sanitization middleware - prevent NoSQL injection and XSS
app.use(sanitizeInput);
app.use(sanitizeStrings);

// Rate limiting - apply to all API routes
app.use('/api/', apiLimiter);

// Logger
// ICICI may return the payment result on the callback URL: never write those parameters (payer details, hash) to the log
morgan.token('url', (req: any) => String(req.originalUrl || req.url).replace(/^(\/api\/v1\/payments\/icici\/[^?]*)\?.*$/, '$1?<redacted>'));
if (ENV.NODE_ENV === 'development') {
  app.use(morgan('dev'));
} else {
  // Production logging
  app.use(morgan('combined', {
    stream: {
      write: (message: string) => logger.info(message.trim()),
    },
  }));
}

// API Routes
app.use('/api/v1', apiRoutes);
import path from 'path';
// Public product images, shown by the storefront and admin on other origins (helmet defaults to same-origin)
app.use('/uploads', (req, res, next) => { res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin'); next(); }, express.static(path.join(__dirname, '../uploads')));

// 404 Handler
app.use(notFoundHandler);

// Global Error Handler
app.use(errorHandler);

export default app;
