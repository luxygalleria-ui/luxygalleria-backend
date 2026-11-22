"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ENV = void 0;
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
exports.ENV = {
    NODE_ENV: process.env.NODE_ENV || 'development',
    PORT: process.env.PORT || 5000,
    MONGODB_URI: process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/luxy-galleria',
    JWT_SECRET: process.env.JWT_SECRET || '',
    JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '7d',
    CORS_ORIGIN: process.env.CORS_ORIGIN || 'http://localhost:3000',
};
// Never sign tokens with a guessable default outside local development. Only the raw NODE_ENV exactly "development"
// may fall back: ENV.NODE_ENV defaults an UNSET value to "development", which must not count here. Every jwt.sign and
// jwt.verify reads ENV.JWT_SECRET, so both always use this one validated value. Never log the secret or its length.
if (!exports.ENV.JWT_SECRET.trim()) {
    if (process.env.NODE_ENV !== 'development') {
        const nodeEnv = process.env.NODE_ENV === undefined ? 'unset' : JSON.stringify(process.env.NODE_ENV);
        throw new Error(`JWT_SECRET is missing or empty and NODE_ENV is ${nodeEnv}: refusing to start. Set JWT_SECRET (only NODE_ENV=development may use the built-in development secret).`);
    }
    exports.ENV.JWT_SECRET = 'dev_only_insecure_jwt_secret_do_not_use';
}
else if (exports.ENV.JWT_SECRET.length < 32) {
    console.warn('⚠️  JWT_SECRET does not meet the recommended strength: rotate it to a long random value (e.g. `openssl rand -hex 32`)');
}
//# sourceMappingURL=env.js.map