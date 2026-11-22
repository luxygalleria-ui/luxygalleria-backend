import { Request, Response, NextFunction } from 'express';
import { errorResponse } from '../utils/responseHandler';

// The requested URL is not echoed back: its query string can carry tokens or payment parameters
export const notFoundHandler = (req: Request, res: Response, next: NextFunction) => {
  errorResponse(res, 404, 'Route not found');
};
