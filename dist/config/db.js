"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.connectDB = exports.productionDbInDevelopment = exports.describeMongoUri = void 0;
const mongoose_1 = __importDefault(require("mongoose"));
const env_1 = require("./env");
/** The connection target without credentials, e.g. mongodb+srv://***:***@cluster.example.net/luxy */
const describeMongoUri = (uri) => {
    const m = uri.trim().match(/^(mongodb(?:\+srv)?):\/\/(?:([^:@/]*)(?::[^/]*)?@)?([^/?]+)\/?([^?]*)/);
    if (!m)
        return '(MONGO_URI is not a mongodb:// or mongodb+srv:// URI)';
    const [, scheme, user, host, db] = m;
    return `${scheme}://${user ? '***:***@' : ''}${host}/${db || '(default database)'}`; // user and password both hidden
};
exports.describeMongoUri = describeMongoUri;
/** Development must not write to the production database by accident (local admin can edit everything). */
const productionDbInDevelopment = (uri, nodeEnv, allow) => nodeEnv === 'development' && allow !== 'true' && (uri.trim().match(/^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]*)/)?.[1] || '') === 'luxy';
exports.productionDbInDevelopment = productionDbInDevelopment;
const connectDB = async () => {
    if ((0, exports.productionDbInDevelopment)(env_1.ENV.MONGODB_URI, env_1.ENV.NODE_ENV, process.env.ALLOW_PRODUCTION_DB_IN_DEV)) {
        console.error(`❌ Refusing to start: development is configured for the PRODUCTION database (${(0, exports.describeMongoUri)(env_1.ENV.MONGODB_URI)}). ` +
            'Use luxy_staging or a local database in MONGO_URI (set ALLOW_PRODUCTION_DB_IN_DEV=true only with a read-only user).');
        process.exit(1);
    }
    try {
        await mongoose_1.default.connect(env_1.ENV.MONGODB_URI);
        console.log(`✅ MongoDB Connected: ${(0, exports.describeMongoUri)(env_1.ENV.MONGODB_URI)}`);
    }
    catch (error) {
        console.error(`❌ Error connecting to MongoDB at ${(0, exports.describeMongoUri)(env_1.ENV.MONGODB_URI)}:`, error);
        if (error?.code === 8000 || /bad auth|authentication failed/i.test(String(error?.message))) {
            console.error('   The database rejected the username/password in MONGO_URI. Check the user and its current password in ' +
                'Atlas → Database Access, and URL-encode any special characters (@ : / ? # [ ] %) in the password.');
        }
        if (error?.name === 'MongoParseError') {
            console.error('   MONGO_URI must start with mongodb:// or mongodb+srv:// — check for quotes, spaces, a repeated "MONGO_URI=" or a leftover <placeholder>.');
        }
        // Opt-in only: a silent switch to a different (often empty) database looks like data loss in the admin
        if (env_1.ENV.NODE_ENV === 'development' && process.env.ALLOW_LOCAL_DB_FALLBACK === 'true'
            && !env_1.ENV.MONGODB_URI.includes('localhost') && !env_1.ENV.MONGODB_URI.includes('127.0.0.1')) {
            const localFallback = 'mongodb://localhost:27017/luxy-galleria';
            try {
                console.warn(`⚠️  ALLOW_LOCAL_DB_FALLBACK=true: using ${localFallback} INSTEAD of the configured database. Data shown will differ.`);
                await mongoose_1.default.connect(localFallback);
                console.warn(`⚠️  MongoDB Connected (LOCAL FALLBACK, not MONGO_URI): ${localFallback}`);
                return;
            }
            catch (fallbackError) {
                console.error(`❌ Local MongoDB fallback also failed:`, fallbackError.message);
            }
        }
        process.exit(1);
    }
};
exports.connectDB = connectDB;
//# sourceMappingURL=db.js.map