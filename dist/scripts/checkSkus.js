"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Read-only report of variants the ERP cannot address: missing SKUs and SKUs used more than once.
 * Run before go-live: npm run check-skus   (uses MONGO_URI / MONGODB_URI from .env; writes nothing)
 */
const mongoose_1 = __importDefault(require("mongoose"));
const env_1 = require("../config/env");
const Product_1 = require("../models/Product");
const run = async () => {
    await mongoose_1.default.connect(env_1.ENV.MONGODB_URI);
    const products = await Product_1.Product.find().select('name variants._id variants.sku variants.volume').lean();
    const missing = [];
    const bySku = new Map();
    for (const p of products) {
        for (const v of p.variants) {
            const where = `${p._id} / ${v._id} (${p.name}, ${v.volume})`;
            const sku = (v.sku || '').trim();
            if (!sku)
                missing.push(where);
            else
                bySku.set(sku, [...(bySku.get(sku) || []), where]);
        }
    }
    const dupes = [...bySku].filter(([, at]) => at.length > 1);
    console.log(`Products: ${products.length}, variants without SKU: ${missing.length}, duplicated SKUs: ${dupes.length}`);
    missing.forEach((w) => console.log(`  missing  ${w}`));
    dupes.forEach(([sku, at]) => console.log(`  duplicate ${sku}\n    ${at.join('\n    ')}`));
    await mongoose_1.default.disconnect();
    process.exit(missing.length || dupes.length ? 1 : 0);
};
run().catch(async (err) => {
    console.error(err);
    await mongoose_1.default.disconnect();
    process.exit(1);
});
//# sourceMappingURL=checkSkus.js.map