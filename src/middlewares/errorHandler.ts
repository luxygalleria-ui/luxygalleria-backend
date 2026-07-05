import { Request, Response, NextFunction } from 'express';
import { errorResponse } from '../utils/responseHandler';
import { ENV } from '../config/env';

export const errorHandler = (err: any, req: Request, res: Response, next: NextFunction) => {
  console.error('❌ Error:', err);

  const statusCode = err.statusCode || 500;
  const message = err.message || 'Internal Server Error';

  // Clean up error object for production
  const errors = ENV.NODE_ENV === 'development' ? err.stack : undefined;

  errorResponse(res, statusCode, message, errors);
};
