import mongoose from 'mongoose';
import { ENV } from './env';

/** The connection target without credentials, e.g. mongodb+srv://***:***@cluster.example.net/luxy */
export const describeMongoUri = (uri: string): string => {
  const m = uri.trim().match(/^(mongodb(?:\+srv)?):\/\/(?:([^:@/]*)(?::[^/]*)?@)?([^/?]+)\/?([^?]*)/);
  if (!m) return '(MONGO_URI is not a mongodb:// or mongodb+srv:// URI)';
  const [, scheme, user, host, db] = m;
  return `${scheme}://${user ? '***:***@' : ''}${host}/${db || '(default database)'}`; // user and password both hidden
};

/** Development must not write to the production database by accident (local admin can edit everything). */
export const productionDbInDevelopment = (uri: string, nodeEnv: string, allow?: string) =>
  nodeEnv === 'development' && allow !== 'true' && (uri.trim().match(/^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]*)/)?.[1] || '') === 'luxy';

export const connectDB = async () => {
  if (productionDbInDevelopment(ENV.MONGODB_URI, ENV.NODE_ENV, process.env.ALLOW_PRODUCTION_DB_IN_DEV)) {
    console.error(`❌ Refusing to start: development is configured for the PRODUCTION database (${describeMongoUri(ENV.MONGODB_URI)}). ` +
      'Use luxy_staging or a local database in MONGO_URI (set ALLOW_PRODUCTION_DB_IN_DEV=true only with a read-only user).');
    process.exit(1);
  }
  try {
    await mongoose.connect(ENV.MONGODB_URI);
    console.log(`✅ MongoDB Connected: ${describeMongoUri(ENV.MONGODB_URI)}`);
  } catch (error: any) {
    console.error(`❌ Error connecting to MongoDB at ${describeMongoUri(ENV.MONGODB_URI)}:`, error);
    if (error?.code === 8000 || /bad auth|authentication failed/i.test(String(error?.message))) {
      console.error('   The database rejected the username/password in MONGO_URI. Check the user and its current password in ' +
        'Atlas → Database Access, and URL-encode any special characters (@ : / ? # [ ] %) in the password.');
    }
    if (error?.name === 'MongoParseError') {
      console.error('   MONGO_URI must start with mongodb:// or mongodb+srv:// — check for quotes, spaces, a repeated "MONGO_URI=" or a leftover <placeholder>.');
    }
    // Opt-in only: a silent switch to a different (often empty) database looks like data loss in the admin
    if (ENV.NODE_ENV === 'development' && process.env.ALLOW_LOCAL_DB_FALLBACK === 'true'
      && !ENV.MONGODB_URI.includes('localhost') && !ENV.MONGODB_URI.includes('127.0.0.1')) {
      const localFallback = 'mongodb://localhost:27017/luxy-galleria';
      try {
        console.warn(`⚠️  ALLOW_LOCAL_DB_FALLBACK=true: using ${localFallback} INSTEAD of the configured database. Data shown will differ.`);
        await mongoose.connect(localFallback);
        console.warn(`⚠️  MongoDB Connected (LOCAL FALLBACK, not MONGO_URI): ${localFallback}`);
        return;
      } catch (fallbackError: any) {
        console.error(`❌ Local MongoDB fallback also failed:`, fallbackError.message);
      }
    }
    process.exit(1);
  }
};
