/**
 * Read-only report of variants the ERP cannot address: missing SKUs, SKUs stored with surrounding spaces, and SKUs
 * used more than once. Writes nothing. Exit code 1 while any issue remains.
 *   MONGO_URI=<database to audit> npm run check-skus            human-readable
 *   MONGO_URI=<database to audit> npm run check-skus -- --csv   CSV audit report (redirect to a file), with blank
 *                                                               columns for the owner-approved new value
 * Always set MONGO_URI explicitly: otherwise the database named in .env is read.
 */
import mongoose from 'mongoose';
import { ENV } from '../config/env';
import { Product } from '../models/Product';
import { auditSkus } from '../utils/skuAudit';

const csvCell = (v: unknown) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

const run = async () => {
  await mongoose.connect(ENV.MONGODB_URI);
  const products = await Product.find().select('name variants._id variants.sku variants.volume').lean();
  const r = auditSkus(products as any);
  const count = (k: string) => r.issues.filter((i) => i.issue === k).length;
  if (process.argv.includes('--csv')) {
    console.log(['issue', 'productId', 'variantId', 'productName', 'size', 'storedSkuJson', 'approvedNewSku', 'approvedBy', 'approvedOn'].join(','));
    r.issues.forEach((i) => console.log([i.issue, i.productId, i.variantId, i.productName, i.size, JSON.stringify(i.storedSku), '', '', ''].map(csvCell).join(',')));
  } else {
    console.log(`Products: ${r.products}, variants without SKU: ${count('missing')}, duplicated SKUs: ${r.duplicateSkus.length}, SKUs with surrounding spaces: ${count('spaces')}`);
    r.issues.forEach((i) => console.log(`  ${i.issue.padEnd(9)} ${i.productId} / ${i.variantId} (${i.productName}, ${i.size})${i.issue === 'missing' ? '' : ` ${JSON.stringify(i.storedSku)}`}`));
  }
  await mongoose.disconnect();
  process.exit(r.issues.length ? 1 : 0);
};

run().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect();
  process.exit(1);
});
