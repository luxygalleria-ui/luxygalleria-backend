"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Read-only report of variants the ERP cannot address: missing SKUs, SKUs stored with surrounding spaces, and SKUs
 * used more than once. Writes nothing. Exit code 1 while any issue remains.
 *   MONGO_URI=<database to audit> npm run check-skus            human-readable
 *   MONGO_URI=<database to audit> npm run check-skus -- --csv   CSV audit report (redirect to a file), with blank
 *                                                               columns for the owner-approved new value
 * Always set MONGO_URI explicitly: otherwise the database named in .env is read.
 */
const mongoose_1 = __importDefault(require("mongoose"));
const env_1 = require("../config/env");
const Product_1 = require("../models/Product");
const skuAudit_1 = require("../utils/skuAudit");
const csvCell = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const run = async () => {
    await mongoose_1.default.connect(env_1.ENV.MONGODB_URI);
    const products = await Product_1.Product.find().select('name variants._id variants.sku variants.volume').lean();
    const r = (0, skuAudit_1.auditSkus)(products);
    const count = (k) => r.issues.filter((i) => i.issue === k).length;
    if (process.argv.includes('--csv')) {
        console.log(['issue', 'productId', 'variantId', 'productName', 'size', 'storedSkuJson', 'approvedNewSku', 'approvedBy', 'approvedOn'].join(','));
        r.issues.forEach((i) => console.log([i.issue, i.productId, i.variantId, i.productName, i.size, JSON.stringify(i.storedSku), '', '', ''].map(csvCell).join(',')));
    }
    else {
        console.log(`Products: ${r.products}, variants without SKU: ${count('missing')}, duplicated SKUs: ${r.duplicateSkus.length}, SKUs with surrounding spaces: ${count('spaces')}`);
        r.issues.forEach((i) => console.log(`  ${i.issue.padEnd(9)} ${i.productId} / ${i.variantId} (${i.productName}, ${i.size})${i.issue === 'missing' ? '' : ` ${JSON.stringify(i.storedSku)}`}`));
    }
    await mongoose_1.default.disconnect();
    process.exit(r.issues.length ? 1 : 0);
};
run().catch(async (err) => {
    console.error(err);
    await mongoose_1.default.disconnect();
    process.exit(1);
});
//# sourceMappingURL=checkSkus.js.map