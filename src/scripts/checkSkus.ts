/**
 * Read-only report of variants the ERP cannot address: missing SKUs and SKUs used more than once.
 * Run before go-live: npm run check-skus   (uses MONGO_URI / MONGODB_URI from .env; writes nothing)
 */
import mongoose from 'mongoose';
import { ENV } from '../config/env';
import { Product } from '../models/Product';

const run = async () => {
  await mongoose.connect(ENV.MONGODB_URI);
  const products = await Product.find().select('name variants._id variants.sku variants.volume').lean();
  const missing: string[] = [];
  const bySku = new Map<string, string[]>();
  for (const p of products) {
    for (const v of p.variants) {
      const where = `${p._id} / ${v._id} (${p.name}, ${v.volume})`;
      const sku = (v.sku || '').trim();
      if (!sku) missing.push(where);
      else bySku.set(sku, [...(bySku.get(sku) || []), where]);
    }
  }
  const dupes = [...bySku].filter(([, at]) => at.length > 1);
  console.log(`Products: ${products.length}, variants without SKU: ${missing.length}, duplicated SKUs: ${dupes.length}`);
  missing.forEach((w) => console.log(`  missing  ${w}`));
  dupes.forEach(([sku, at]) => console.log(`  duplicate ${sku}\n    ${at.join('\n    ')}`));
  await mongoose.disconnect();
  process.exit(missing.length || dupes.length ? 1 : 0);
};

run().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect();
  process.exit(1);
});
