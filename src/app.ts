import express, { Application } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';

import { ENV } from './config/env';
import apiRoutes from './routes';
import { errorHandler } from './middlewares/errorHandler';
import { notFoundHandler } from './middlewares/notFoundHandler';

const app: Application = express();

// Security Middlewares
app.use(helmet());
// const allowedOrigins = ENV.CORS_ORIGIN.split(',');

// const corsOptions = {
//   origin: (origin: string | undefined, callback: any) => {
//     console.log('CORS Check:', origin);
//     if (!origin) return callback(null, true);

//     if (allowedOrigins.includes(origin)) {
//       return callback(null, true);
//     } else {
//       console.log('Warning: Origin not in allowed list, but allowing for dev:', origin);
//       return callback(null, true); // Temporarily allow all to prevent fetch errors
//     }
//   },
//   credentials: true,
// };

// app.use(cors(corsOptions));
// app.options('*', cors(corsOptions));

const corsConfig = {
  origin: [
    "https://heedy-frontend.vercel.app",
    "https://heedy-admin.vercel.app"
  ],
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"]
}
app.use(cors(corsConfig));

// Parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Logger
if (ENV.NODE_ENV === 'development') {
  app.use(morgan('dev'));
}

// API Routes
app.use('/api/v1', apiRoutes);
import path from 'path';
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// 404 Handler
app.use(notFoundHandler);

// Global Error Handler
app.use(errorHandler);

export default app;
