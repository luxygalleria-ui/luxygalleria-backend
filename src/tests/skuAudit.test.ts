/**
 * The SKU audit behind `npm run check-skus`. Pure: no database.
 * Run: npx ts-node --transpile-only src/tests/skuAudit.test.ts
 */
import assert from 'assert';
import { auditSkus } from '../utils/skuAudit';

const v = (id: string, sku?: string | null) => ({ _id: id, volume: '50ml', ...(sku === undefined ? {} : { sku }) });
const r = auditSkus([
  { _id: 'p1', name: 'Missing', variants: [v('v1'), v('v2', null), v('v3', ''), v('v4', '   ')] },
  { _id: 'p2', name: 'Spaces', variants: [v('v5', ' SP-1 ')] },
  { _id: 'p3', name: 'Dup A', variants: [v('v6', 'DUP-1')] },
  { _id: 'p4', name: 'Dup B', variants: [v('v7', 'DUP-1 ')] }, // duplicate once trimmed, and has spaces
  { _id: 'p5', name: 'Case', variants: [v('v8', 'case-1'), v('v9', 'CASE-1')] }, // exact case: not duplicates
  { _id: 'p6', name: 'OK', variants: [v('v10', 'OK-1')] },
]);
const of = (k: string) => r.issues.filter((i) => i.issue === k).map((i) => i.variantId).sort();
assert.deepStrictEqual([r.products, r.variants], [6, 10]);
assert.deepStrictEqual(of('missing'), ['v1', 'v2', 'v3', 'v4'], 'absent, null, empty and spaces-only are missing');
assert.deepStrictEqual(of('spaces'), ['v5', 'v7'], 'surrounding spaces reported with the exact stored value');
assert.strictEqual(r.issues.find((i) => i.variantId === 'v5')!.storedSku, ' SP-1 ');
assert.deepStrictEqual(r.duplicateSkus, ['DUP-1'], 'duplicates compared trimmed, case-sensitive');
assert.deepStrictEqual(of('duplicate'), ['v6', 'v7']);
assert.ok(!r.issues.some((i) => ['v8', 'v9', 'v10'].includes(i.variantId)), 'distinct and clean SKUs are not reported');
assert.deepStrictEqual(auditSkus([{ _id: 'p', name: 'Clean', variants: [v('a', 'A-1')] }]).issues, [], 'a clean catalogue has no issues');
console.log('✅ SKU audit: missing (4 forms), surrounding spaces, trimmed duplicates, exact case');
