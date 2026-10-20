import dotenv from 'dotenv';
dotenv.config();

// Fail closed: only an explicit NODE_ENV=development enables development behaviour. Unset or unknown values
// (e.g. "dev", "staging") run as production: secure cookies, no stack traces, JWT_SECRET required.
const RAW_NODE_ENV = (process.env.NODE_ENV || '').trim();
if (RAW_NODE_ENV !== 'development' && RAW_NODE_ENV !== 'production') {
  console.warn(`⚠️  NODE_ENV is ${RAW_NODE_ENV ? `"${RAW_NODE_ENV}"` : 'not set'}; running with production settings`);
}

export const ENV = {
  NODE_ENV: RAW_NODE_ENV === 'development' ? 'development' : 'production',
  PORT: process.env.PORT || 5000,
  MONGODB_URI: process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/heedy-db',
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
