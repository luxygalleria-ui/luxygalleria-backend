import dotenv from 'dotenv';
dotenv.config();

export const ENV = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: process.env.PORT || 5000,
  MONGODB_URI: process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/luxy-galleria',
  JWT_SECRET: process.env.JWT_SECRET || '',
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '7d',
  CORS_ORIGIN: process.env.CORS_ORIGIN || 'http://localhost:3000',
};

// Never sign tokens with a guessable default outside local development.
if (!ENV.JWT_SECRET) {
  if (ENV.NODE_ENV !== 'development') {
    throw new Error('JWT_SECRET must be set outside development');
  }
  ENV.JWT_SECRET = 'dev_only_insecure_jwt_secret_do_not_use';
} else if (ENV.JWT_SECRET.length < 32) {
  console.warn('⚠️  JWT_SECRET is shorter than 32 characters — rotate it to a long random value');
}
