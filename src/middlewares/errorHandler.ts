import { Request, Response, NextFunction } from 'express';
import { errorResponse } from '../utils/responseHandler';

import fs from 'fs';
import path from 'path';

/** Path only: the query string can carry payment results, tokens or personal data. */
export const safePath = (req: Request) => String(req.originalUrl || req.url || '').split('?')[0].slice(0, 300);

/** Credentials embedded in connection strings (mongodb://user:pass@host) never reach a log. */
const redact = (s: string) => s.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1<redacted>@');

/** One Mongoose field error in our own words (its own message can echo the submitted value). */
const fieldProblem = (e: any) => {
  const p = String(e?.path || 'field');
  const { min, max, minlength, maxlength } = e?.properties ?? {};
  switch (e?.kind) {
    case 'required': return `${p} is required`;
    case 'min': return `${p} must be at least ${min}`;
    case 'max': return `${p} must be at most ${max}`;
    case 'minlength': return `${p} must be at least ${minlength} characters`;
    case 'maxlength': return `${p} must be at most ${maxlength} characters`;
    case 'enum': return `${p} has an unsupported value`;
    default: return `${p} is invalid`;
  }
};

/**
 * Invalid input reaching Mongoose (admin forms: category, brand, coupon, banner, product; bad ids) is the caller's
 * mistake: 400 with field-level messages. Never the driver's own text, which echoes values and model names.
 */
export const clientInputError = (err: any): { statusCode: number; message: string } | null => {
  if (err?.name === 'ValidationError' && err.errors && typeof err.errors === 'object') {
    const problems = [...new Set(Object.values(err.errors).map(fieldProblem))];
    return { statusCode: 400, message: `Validation failed: ${problems.join('; ') || 'invalid input'}` };
  }
  if (err?.name === 'CastError') return { statusCode: 400, message: `Invalid ${err.path || 'value'}` };
  return null;
};

export const errorHandler = (err: any, req: Request, res: Response, next: NextFunction) => {
  const input = clientInputError(err);
  if (input) err = Object.assign(new Error(input.message), { statusCode: input.statusCode });
  const statusCode = Number(err?.statusCode || err?.status) || 500;
  const where = `${req.method} ${safePath(req)}`;
  // Client errors (e.g. a CORS-blocked origin, 403) are expected traffic: one line, no stack dump or trace file write
  if (statusCode < 500) {
    // Origin is client-supplied: capped so a crafted header cannot flood the log
    console.warn(`${statusCode} ${where} origin=${String(req.headers.origin ?? '-').slice(0, 200)}: ${String(err?.message ?? '').slice(0, 300)}`);
  } else {
    // Name, code and stack only: the raw error object can hold request data, provider responses or headers
    const trace = redact(`${where} ${err?.name || 'Error'}${err?.code ? ` code=${err.code}` : ''}: ${err?.stack || err?.message || err}`);
    console.error('❌ Error:', trace);
    try {
      fs.appendFileSync(path.join(process.cwd(), 'error-trace.log'), new Date().toISOString() + ': ' + trace + '\n');
    } catch (e) {}
  }

  // Raw NODE_ENV: ENV.NODE_ENV treats an UNSET value as development, which would send stack traces to clients
  const dev = process.env.NODE_ENV === 'development';
  // 4xx messages are written for the client; an unexpected 5xx message may be a database or provider detail
  const message = statusCode < 500 || dev ? err?.message || 'Request failed' : 'Internal Server Error';

  errorResponse(res, statusCode, message, dev ? err?.stack : undefined);
};
