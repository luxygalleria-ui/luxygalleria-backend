"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.connectDB = exports.describeMongoUri = void 0;
const mongoose_1 = __importDefault(require("mongoose"));
const env_1 = require("./env");
/** The connection target without the password, e.g. mongodb+srv://user:***@cluster.example.net/luxy */
const describeMongoUri = (uri) => {
    const m = uri.trim().match(/^(mongodb(?:\+srv)?):\/\/(?:([^:@/]*)(?::[^/]*)?@)?([^/?]+)\/?([^?]*)/);
    if (!m)
        return '(MONGO_URI is not a mongodb:// or mongodb+srv:// URI)';
    const [, scheme, user, host, db] = m;
    return `${scheme}://${user ? `${decodeURIComponent(user)}:***@` : ''}${host}/${db || '(default database)'}`;
};
exports.describeMongoUri = describeMongoUri;
const connectDB = async () => {
    try {
        const conn = await mongoose_1.default.connect(env_1.ENV.MONGODB_URI);
        console.log(`✅ MongoDB Connected: ${conn.connection.host}`);
    }
    catch (error) {
        console.error(`❌ Error connecting to MongoDB at ${(0, exports.describeMongoUri)(env_1.ENV.MONGODB_URI)}:`, error);
        if (error?.code === 8000 || /bad auth|authentication failed/i.test(String(error?.message))) {
            console.error('   The database rejected the username/password in MONGO_URI. Check the user and its current password in ' +
                'Atlas → Database Access, and URL-encode any special characters (@ : / ? # [ ] %) in the password.');
        }
        process.exit(1);
    }
};
exports.connectDB = connectDB;
//# sourceMappingURL=db.js.map