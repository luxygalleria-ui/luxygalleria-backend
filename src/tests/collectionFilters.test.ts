/**
 * Checks that the Gifting / New Arrivals collections combine with the sidebar
 * filters. The bug this guards: the sidebar listed every ACTIVE category/brand
 * globally, so on /gifting every option was for a category no gifting product
 * had — each click returned "No products found".
 *
 * Invariant: every facet the API offers for a collection must, when applied as
 * a filter alongside that collection's flag, return at least one product.
 *
 * Needs the API running (npm run dev).
 * Run: npx ts-node src/tests/collectionFilters.test.ts
 */
import assert from 'assert';

const API = process.env.API_URL || 'http://localhost:5000/api/v1';
const slug = (name: string) => name.toLowerCase().replace(/\s+/g, '-');

const get = async (qs: string) => {
  const res = await fetch(`${API}/products?${qs}`);
  assert.strictEqual(res.status, 200, `${qs} -> HTTP ${res.status}`);
  const body: any = await res.json();
  assert.ok(body.success, `${qs} -> success=false`);
  return body.data;
};

(async () => {
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
      assert.ok(scoped.length > 0, `${label}: collection is empty`);
      assert.ok(scoped.length <= all.length, `${label}: collection is not a subset`);
    }

    console.log(`  ${label}: ${facets.categories.length} categories, ${facets.brands.length} brands — all return results`);
  }

  console.log('✅ collection + filter combinations OK');
  process.exit(0);
})().catch(err => { console.error('❌', err.message); process.exit(1); });
