import { User } from '../models/User';

/** Production needs a real password: the seeded account is a superadmin. */
export const MIN_SEED_PASSWORD_LENGTH = 12;

export const seedAdmin = async () => {
  const existingAdmin = await User.findOne({ role: { $in: ['admin', 'superadmin'] } });

  if (existingAdmin) {
    return;
  }

  const dev = process.env.NODE_ENV === 'development';
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@luxygalleria.com';
  // The built-in password only ever applies to a local development database
  const adminPassword = process.env.ADMIN_PASSWORD || (dev ? 'password123' : '');
  if (!adminPassword) {
    console.warn('⚠️  No admin exists and ADMIN_PASSWORD is not set — skipping admin seed');
    return;
  }
  if (!dev && adminPassword.length < MIN_SEED_PASSWORD_LENGTH) {
    console.warn(`⚠️  No admin exists but ADMIN_PASSWORD is shorter than ${MIN_SEED_PASSWORD_LENGTH} characters — skipping admin seed`);
    return;
  }

  await User.create({
    name: 'System Admin',
    email: adminEmail,
    password: adminPassword,
    role: 'superadmin',
    isVerified: true,
    isActive: true,
  });

  console.log(`✅ Seed admin created: ${adminEmail}`);
};
