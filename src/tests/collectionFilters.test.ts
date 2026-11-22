/**
 * Checks that the Gifting / New Arrivals collections combine with the sidebar
 * filters. The bug this guards: the sidebar listed every ACTIVE category/brand
 * globally, so on /gifting every option was for a category no gifting product
 * had — each click returned "No products found".
 *
 * Invariant: every facet the API offers for a collection must, when applied as
 * a filter alongside that collection's flag, return at least one product.
 *
 * By default it starts the app in-process on a throwaway local database (luxy_collection_filters_test, seeded below)
 * and drops it afterwards. To check a running API's real catalogue instead (read-only GETs): API_URL=http://... .
 * Run: npx ts-node --transpile-only src/tests/collectionFilters.test.ts
 */
import assert from 'assert';
import type { Server } from 'http';
import type { AddressInfo } from 'net';

const TEST_DB = 'mongodb://127.0.0.1:27017/luxy_collection_filters_test';
let API = process.env.API_URL || '';
if (!API) Object.assign(process.env, { NODE_ENV: 'development', MONGO_URI: TEST_DB, HISTORY_READ_ENABLED: 'false' });

import mongoose from 'mongoose';
import app from '../app';
import { Product } from '../models/Product';
import { Category } from '../models/Category';
import { Brand } from '../models/Brand';

const local = { server: null as Server | null, done: async () => {} };

/** In-process app on the test database: a plain category/brand, a Gifting-only pair, a New Arrival, an inactive brand. */
const startLocal = async () => {
  await mongoose.connect(TEST_DB, { serverSelectionTimeoutMS: 5000 });
  assert.strictEqual(mongoose.connection.name, 'luxy_collection_filters_test');
  await mongoose.connection.db!.dropDatabase();
  const [choc, hamper] = await Category.create([{ name: 'Chocolates', image: 'x.png' }, { name: 'Gift Hampers', image: 'x.png' }]);
  const [lindt, luxy, retired] = await Brand.create([{ name: 'Lindt' }, { name: 'Luxy Gifts' }, { name: 'Retired', status: 'INACTIVE' }]);
  const variant = { volume: '100g', price: 100, offerPrice: 90, actualPrice: 100, stock: 5, weight: 0.1 };
  const p = (name: string, cat: any, brand: any, extra = {}) => ({ name, category: cat.name, categoryId: cat._id, brandId: brand._id, description: 'test product', variants: [variant], ...extra });
  await Product.create([
    p('Plain bar', choc, lindt),
    p('Gift box', hamper, luxy, { isGifting: true }),
    p('New bar', choc, lindt, { isNewArrival: true }),
    p('Old bar', choc, retired),
  ]);
  const server = app.listen(0);
  API = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  local.server = server;
  local.done = async () => { server.close(); await mongoose.connection.db!.dropDatabase(); await mongoose.disconnect(); };
};
const slug = (name: string) => name.toLowerCase().replace(/\s+/g, '-');

const get = async (qs: string) => {
  const res = await fetch(`${API}/products?${qs}`);
  assert.strictEqual(res.status, 200, `${qs} -> HTTP ${res.status}`);
  const body: any = await res.json();
  assert.ok(body.success, `${qs} -> success=false`);
  return body.data;
};

(async () => {
  if (!API) await startLocal();
  for (const flag of ['', 'gifting=true', 'newArrival=true']) {
    const label = flag || 'all products';
    const facets = await get(`facets=true&${flag}`);

    assert.ok(Array.isArray(facets.categories), `${label}: categories must be an array`);
    assert.ok(Array.isArray(facets.brands), `${label}: brands must be an array`);

    for (const name of facets.categories) {
      const hits = await get(`${flag}&category=${encodeURIComponent(slug(name))}`);
      assert.ok(hits.length > 0, `${label}: category "${name}" is offered but returns nothing`);
    }
    for (const name of facets.brands) {
      const hits = await get(`${flag}&brand=${encodeURIComponent(slug(name))}`);
      assert.ok(hits.length > 0, `${label}: brand "${name}" is offered but returns nothing`);
    }

    // Collection flag must actually narrow, not leak the whole catalogue.
    if (flag) {
      const scoped = await get(flag);
      const all = await get('');
      // An empty collection is valid data (e.g. every New Arrival is also in Gifting), so note it rather than fail
      if (scoped.length === 0) console.log(`  ${label}: collection is currently empty`);
      assert.ok(scoped.length <= all.length, `${label}: collection is not a subset`);
    }

    console.log(`  ${label}: ${facets.categories.length} categories, ${facets.brands.length} brands — all return results`);
  }

  // Main Shop (general=true) never includes Gifting products; New Arrivals do show there (productController.getProducts)
  const general = await get('general=true');
  assert.ok(general.every((p: any) => !p.isGifting), 'general=true leaked a Gifting product');
  console.log(`  general shop: ${general.length} products, none from Gifting`);

  // Gifting is exclusive: New Arrivals must never include a Gifting product
  const newArrivals = await get('newArrival=true');
  assert.ok(newArrivals.every((p: any) => !p.isGifting), 'newArrival=true leaked a Gifting product');
  console.log(`  new arrivals: ${newArrivals.length} products, none from Gifting`);

  if (local.server) {
    // The seeded catalogue pins the expected facets, so an empty facet list cannot pass silently
    const all = await get('facets=true&');
    assert.deepStrictEqual([all.categories, all.brands], [['Chocolates', 'Gift Hampers'], ['Lindt', 'Luxy Gifts']], 'inactive brand is not offered');
    assert.deepStrictEqual((await get('facets=true&gifting=true')).categories, ['Gift Hampers']);
    assert.deepStrictEqual((await get('general=true')).map((p: any) => p.name).sort(), ['New bar', 'Old bar', 'Plain bar']);
    await local.done();
  }
  console.log('✅ collection + filter combinations OK');
  process.exit(0);
})().catch(async (err) => { console.error('❌', err.message); await local.done().catch(() => {}); process.exit(1); });
