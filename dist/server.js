"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const app_1 = __importDefault(require("./app"));
const db_1 = require("./config/db");
const env_1 = require("./config/env");
const seedAdmin_1 = require("./utils/seedAdmin");
const checkoutSessions_1 = require("./utils/checkoutSessions");
const startServer = async () => {
    try {
        // Connect to database
        await (0, db_1.connectDB)();
        // Ensure a default admin is available in development
        await (0, seedAdmin_1.seedAdmin)();
        // Start Express Server
        app_1.default.listen(env_1.ENV.PORT, () => {
            console.log(`🚀 Server running in ${env_1.ENV.NODE_ENV} mode on port ${env_1.ENV.PORT}`);
        });
        // Return stock held by abandoned checkouts (also done before each new checkout)
        setInterval(() => {
            (0, checkoutSessions_1.expireStaleSessions)().catch((err) => console.error('Expiring checkout sessions failed:', err?.message));
        }, 5 * 60_000).unref();
    }
    catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
};
startServer();
//# sourceMappingURL=server.js.map