"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.seedAdmin = void 0;
const User_1 = require("../models/User");
const seedAdmin = async () => {
    const existingAdmin = await User_1.User.findOne({ role: { $in: ['admin', 'superadmin'] } });
    if (existingAdmin) {
        return;
    }
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@luxygalleria.com';
    const adminPassword = process.env.ADMIN_PASSWORD || (process.env.NODE_ENV === 'development' ? 'password123' : '');
    if (!adminPassword) {
        console.warn('⚠️  No admin exists and ADMIN_PASSWORD is not set — skipping admin seed');
        return;
    }
    await User_1.User.create({
        name: 'System Admin',
        email: adminEmail,
        password: adminPassword,
        role: 'superadmin',
        isVerified: true,
        isActive: true,
    });
    console.log(`✅ Seed admin created: ${adminEmail}`);
};
exports.seedAdmin = seedAdmin;
//# sourceMappingURL=seedAdmin.js.map