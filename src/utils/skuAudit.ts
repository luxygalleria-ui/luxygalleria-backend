/** One row per variant needing attention. `storedSku` is the exact stored value (JSON-quoted in reports, so spaces show). */
export interface SkuIssue {
  issue: 'missing' | 'spaces' | 'duplicate';
  productId: string;
  variantId: string;
  productName: string;
  size: string;
  storedSku: string | null;
}

/**
 * Classifies variant SKUs as the ERP sees them (trimmed, exact case): missing (absent, null, '' or spaces only),
 * stored with surrounding spaces, or carried by more than one variant. Pure: reads nothing, writes nothing.
 */
export const auditSkus = (products: { _id: unknown; name: string; variants: { _id: unknown; sku?: string | null; volume?: string }[] }[]) => {
  const issues: SkuIssue[] = [];
  const bySku = new Map<string, SkuIssue[]>();
  for (const p of products) {
    for (const v of p.variants) {
      const row = { productId: String(p._id), variantId: String(v._id), productName: p.name, size: v.volume || '', storedSku: v.sku ?? null };
      const sku = (v.sku || '').trim();
      if (!sku) { issues.push({ issue: 'missing', ...row }); continue; }
      if (v.sku !== sku) issues.push({ issue: 'spaces', ...row });
      bySku.set(sku, [...(bySku.get(sku) || []), { issue: 'duplicate', ...row }]);
    }
  }
  const duplicates = [...bySku].filter(([, at]) => at.length > 1);
  duplicates.forEach(([, at]) => issues.push(...at));
  return { products: products.length, variants: products.reduce((n, p) => n + p.variants.length, 0), duplicateSkus: duplicates.map(([s]) => s), issues };
};
