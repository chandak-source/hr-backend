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

  // Translate common MongoDB / mongoose faults into clean API errors.
  if (err.code === 11000) {
    // Duplicate key — name the field so the client can point at it.
    status = 409;
    const field = Object.keys(err.keyPattern ?? {}).join(', ');
    message = field
      ? `A record with this ${field} already exists`
      : 'A record with these details already exists';
  } else if (err.name === 'ValidationError') {
    status = 422;
    message = 'Validation failed';
    details = Object.values(err.errors ?? {}).map((e) => ({
      field: e.path,
      message: e.message,
    }));
  } else if (err.name === 'CastError') {
    status = 400;
    message = `Invalid ${err.path}: ${err.value}`;
  } else if (
    err.name === 'MongooseServerSelectionError' ||
    err.name === 'MongoNetworkError' ||
    err.code === 'ECONNREFUSED'
  ) {
    status = 503;
    message = 'Database is unreachable';
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
