import app from './app';
import { connectDB } from './config/db';
import { ENV } from './config/env';
import { seedAdmin } from './utils/seedAdmin';
import { expireStaleSessions } from './utils/checkoutSessions';

const startServer = async () => {
  try {
    // Connect to database
    await connectDB();

    // Ensure a default admin is available in development
    await seedAdmin();

    // Start Express Server
    app.listen(ENV.PORT, () => {
      console.log(`🚀 Server running in ${ENV.NODE_ENV} mode on port ${ENV.PORT}`);
    });

    // Return stock held by abandoned checkouts (also done before each new checkout)
    setInterval(() => {
      expireStaleSessions().catch((err) => console.error('Expiring checkout sessions failed:', err?.message));
    }, 5 * 60_000).unref();
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();
