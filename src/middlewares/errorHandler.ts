import { Request, Response, NextFunction } from 'express';
import { errorResponse } from '../utils/responseHandler';
import { ENV } from '../config/env';

export const errorHandler = (err: any, req: Request, res: Response, next: NextFunction) => {
  console.error('❌ Error:', err);

  // Write error to file for debugging
  try {
    const fs = require('fs');
    fs.writeFileSync('/Users/muhammedshareefcv/Desktop/PAID-ECOM-8999/luxy-galleria/backend_error.log', `URL: ${req.method} ${req.url}\nBODY: ${JSON.stringify(req.body)}\nERROR: ${err.message}\nSTACK: ${err.stack}\n`);
  } catch (e) {
    console.error('Failed to write error log file:', e);
  }

  const statusCode = err.statusCode || 500;
  const message = err.message || 'Internal Server Error';

  // Clean up error object for production
  const errors = ENV.NODE_ENV === 'development' ? err.stack : undefined;

  errorResponse(res, statusCode, message, errors);
};
