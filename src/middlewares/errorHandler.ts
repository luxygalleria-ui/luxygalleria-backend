import { Request, Response, NextFunction } from 'express';
import { errorResponse } from '../utils/responseHandler';
import { ENV } from '../config/env';

import fs from 'fs';
import path from 'path';

export const errorHandler = (err: any, req: Request, res: Response, next: NextFunction) => {
  console.error('❌ Error:', err);
  try {
    fs.appendFileSync(path.join(process.cwd(), 'error-trace.log'), new Date().toISOString() + ': ' + (err.stack || err.message) + '\n');
  } catch (e) {}

  const statusCode = err.statusCode || 500;
  const message = err.message || 'Internal Server Error';

  // Clean up error object for production
  const errors = ENV.NODE_ENV === 'development' ? err.stack : undefined;

  errorResponse(res, statusCode, message, errors);
};
