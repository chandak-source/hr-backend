import { env } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';

export const notFoundHandler = (req, _res, next) => {
  next(ApiError.notFound(`Route ${req.method} ${req.originalUrl} does not exist`));
};

// eslint-disable-next-line no-unused-vars
export const errorHandler = (err, _req, res, _next) => {
  let status = err.status ?? 500;
  let message = err.message ?? 'Something went wrong';
  let details = err.details;

  // Translate common MySQL faults into clean API errors.
  switch (err.code) {
    case 'ER_DUP_ENTRY':
      status = 409;
      message = 'A record with these details already exists';
      break;
    case 'ER_NO_REFERENCED_ROW_2':
    case 'ER_ROW_IS_REFERENCED_2':
      status = 422;
      message = 'Referenced record does not exist';
      break;
    case 'ECONNREFUSED':
    case 'ER_ACCESS_DENIED_ERROR':
      status = 503;
      message = 'Database is unreachable';
      break;
    default:
      break;
  }

  if (status >= 500 && !err.expected) {
    console.error('[error]', err);
    if (env.isProd) message = 'Internal server error';
  }

  res.status(status).json({
    success: false,
    error: { message, ...(details ? { details } : {}) },
  });
};
