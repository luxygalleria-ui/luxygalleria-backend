/**
 * Checks the Gifting / New Arrivals collection flags.
 * The admin form posts these as FormData strings ("true"/"false"), so the real
 * risk is a bad cast turning "false" into boolean true and leaking every
 * product into both collections.
 * Run: npx ts-node src/tests/collections.test.ts
 */
import assert from 'assert';
import { Product } from '../models/Product';

const base = { name: 'Test', category: 'Test', description: 'x'.repeat(20) };

const off = new Product({ ...base, isGifting: 'false', isNewArrival: 'false' });
assert.strictEqual(off.isGifting, false, '"false" must cast to false');
assert.strictEqual(off.isNewArrival, false, '"false" must cast to false');

const on = new Product({ ...base, isGifting: 'true', isNewArrival: 'true' });
assert.strictEqual(on.isGifting, true, '"true" must cast to true');
assert.strictEqual(on.isNewArrival, true, '"true" must cast to true');

const untouched = new Product({ ...base });
assert.strictEqual(untouched.isGifting, false, 'legacy products default to false');
assert.strictEqual(untouched.isNewArrival, false, 'legacy products default to false');

console.log('✅ collection flag casts OK');
process.exit(0);
