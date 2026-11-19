"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.auditSkus = void 0;
/**
 * Classifies variant SKUs as the ERP sees them (trimmed, exact case): missing (absent, null, '' or spaces only),
 * stored with surrounding spaces, or carried by more than one variant. Pure: reads nothing, writes nothing.
 */
const auditSkus = (products) => {
    const issues = [];
    const bySku = new Map();
    for (const p of products) {
        for (const v of p.variants) {
            const row = { productId: String(p._id), variantId: String(v._id), productName: p.name, size: v.volume || '', storedSku: v.sku ?? null };
            const sku = (v.sku || '').trim();
            if (!sku) {
                issues.push({ issue: 'missing', ...row });
                continue;
            }
            if (v.sku !== sku)
                issues.push({ issue: 'spaces', ...row });
            bySku.set(sku, [...(bySku.get(sku) || []), { issue: 'duplicate', ...row }]);
        }
    }
    const duplicates = [...bySku].filter(([, at]) => at.length > 1);
    duplicates.forEach(([, at]) => issues.push(...at));
    return { products: products.length, variants: products.reduce((n, p) => n + p.variants.length, 0), duplicateSkus: duplicates.map(([s]) => s), issues };
};
exports.auditSkus = auditSkus;
//# sourceMappingURL=skuAudit.js.map