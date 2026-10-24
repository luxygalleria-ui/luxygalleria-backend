"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * rewrite() changes only URLs that start with the old cloud prefix, and tallies everything else it sees. No database needed.
 * Run: npx ts-node --transpile-only src/tests/cloudinaryMigration.test.ts
 */
const assert_1 = __importDefault(require("assert"));
const mongoose_1 = require("mongoose");
const migrateCloudinaryCloud_1 = require("../scripts/migrateCloudinaryCloud");
const old = 'https://res.cloudinary.com/old/';
const neu = 'https://res.cloudinary.com/new/';
const id = new mongoose_1.Types.ObjectId();
const date = new Date('2026-10-01T00:00:00Z');
const tally = new Map();
const out = (0, migrateCloudinaryCloud_1.rewrite)({
    image: `${old}image/upload/v1/a.webp`,
    mobileImage: '',
    images: [`${old}image/upload/b.webp`, 'https://images.unsplash.com/x.jpg', `${neu}image/upload/done.webp`],
    variants: [{ _id: id, image: `http://res.cloudinary.com/old/image/upload/c.webp`, stock: 3, stockAsOf: date }],
    note: `see ${old}image/upload/d.webp`, // embedded in text: left alone, reported as unhandled
    other: 'https://res.cloudinary.com/older/image/upload/e.webp', // a different cloud whose name starts the same
}, 'old', 'new', '', tally);
assert_1.default.strictEqual(out.image, `${neu}image/upload/v1/a.webp`);
assert_1.default.strictEqual(out.mobileImage, '');
assert_1.default.deepStrictEqual(out.images, [`${neu}image/upload/b.webp`, 'https://images.unsplash.com/x.jpg', `${neu}image/upload/done.webp`]);
assert_1.default.strictEqual(out.variants[0].image, 'http://res.cloudinary.com/new/image/upload/c.webp'); // scheme kept
assert_1.default.strictEqual(out.variants[0]._id, id);
assert_1.default.strictEqual(out.variants[0].stockAsOf, date);
assert_1.default.strictEqual(out.variants[0].stock, 3);
assert_1.default.strictEqual(out.note, `see ${old}image/upload/d.webp`);
assert_1.default.strictEqual(out.other, 'https://res.cloudinary.com/older/image/upload/e.webp');
assert_1.default.deepStrictEqual(Object.fromEntries(tally), {
    image: { matched: 1, alreadyOnTarget: 0, unhandled: 0 },
    'images[]': { matched: 1, alreadyOnTarget: 1, unhandled: 0 },
    'variants[].image': { matched: 1, alreadyOnTarget: 0, unhandled: 0 },
    note: { matched: 0, alreadyOnTarget: 0, unhandled: 1 },
});
// Only the cloud-name segment changes: version, folders, filename, transformations, video type and query string are kept
const keep = new Map();
const variants = [
    'image/upload/v1788956328/luxygalleria_products/image-1788956327462.webp',
    'image/upload/w_400,h_300,c_fill,q_auto,f_auto/v1788956328/luxygalleria_products/a.webp',
    'image/upload/t_thumb/folder/sub/b.png?_a=BAMAK+cQ0',
    'video/upload/v1/clips/c.mp4',
];
for (const rest of variants) {
    assert_1.default.strictEqual((0, migrateCloudinaryCloud_1.rewrite)(`${old}${rest}`, 'old', 'new', 'u', keep), `${neu}${rest}`);
}
assert_1.default.strictEqual(keep.get('u').matched, variants.length);
// Running again over the output changes nothing (idempotent)
const again = new Map();
assert_1.default.deepStrictEqual((0, migrateCloudinaryCloud_1.rewrite)(out, 'old', 'new', '', again), out);
assert_1.default.ok([...again.values()].every((t) => t.matched === 0));
assert_1.default.ok(!migrateCloudinaryCloud_1.COLLECTIONS.includes('orders') && !migrateCloudinaryCloud_1.COLLECTIONS.includes('users'), 'customer collections must not be rewritten');
console.log('✅ cloudinary migration rewrite: only old-cloud URL prefixes change; idempotent; customer collections excluded');
//# sourceMappingURL=cloudinaryMigration.test.js.map