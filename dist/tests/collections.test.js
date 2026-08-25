"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Checks the Gifting / New Arrivals collection flags.
 * The admin form posts these as FormData strings ("true"/"false"), so the real
 * risk is a bad cast turning "false" into boolean true and leaking every
 * product into both collections.
 * Run: npx ts-node src/tests/collections.test.ts
 */
const assert_1 = __importDefault(require("assert"));
const Product_1 = require("../models/Product");
const base = { name: 'Test', category: 'Test', description: 'x'.repeat(20) };
const off = new Product_1.Product({ ...base, isGifting: 'false', isNewArrival: 'false' });
assert_1.default.strictEqual(off.isGifting, false, '"false" must cast to false');
assert_1.default.strictEqual(off.isNewArrival, false, '"false" must cast to false');
const on = new Product_1.Product({ ...base, isGifting: 'true', isNewArrival: 'true' });
assert_1.default.strictEqual(on.isGifting, true, '"true" must cast to true');
assert_1.default.strictEqual(on.isNewArrival, true, '"true" must cast to true');
const untouched = new Product_1.Product({ ...base });
assert_1.default.strictEqual(untouched.isGifting, false, 'legacy products default to false');
assert_1.default.strictEqual(untouched.isNewArrival, false, 'legacy products default to false');
console.log('✅ collection flag casts OK');
process.exit(0);
//# sourceMappingURL=collections.test.js.map