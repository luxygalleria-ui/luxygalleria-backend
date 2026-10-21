import mongoose from 'mongoose';
import { ENV } from './env';

/** The connection target without the password, e.g. mongodb+srv://user:***@cluster.example.net/luxy */
export const describeMongoUri = (uri: string): string => {
  const m = uri.trim().match(/^(mongodb(?:\+srv)?):\/\/(?:([^:@/]*)(?::[^/]*)?@)?([^/?]+)\/?([^?]*)/);
  if (!m) return '(MONGO_URI is not a mongodb:// or mongodb+srv:// URI)';
  const [, scheme, user, host, db] = m;
  return `${scheme}://${user ? `${decodeURIComponent(user)}:***@` : ''}${host}/${db || '(default database)'}`;
};

export const connectDB = async () => {
  try {
    const conn = await mongoose.connect(ENV.MONGODB_URI);
    console.log(`✅ MongoDB Connected: ${conn.connection.host}`);
  } catch (error: any) {
    console.error(`❌ Error connecting to MongoDB at ${describeMongoUri(ENV.MONGODB_URI)}:`, error);
    if (error?.code === 8000 || /bad auth|authentication failed/i.test(String(error?.message))) {
      console.error('   The database rejected the username/password in MONGO_URI. Check the user and its current password in ' +
        'Atlas → Database Access, and URL-encode any special characters (@ : / ? # [ ] %) in the password.');
    }
    process.exit(1);
  }
};
