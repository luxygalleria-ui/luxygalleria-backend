/**
 * rewrite() changes only URLs that start with the old cloud prefix, and tallies everything else it sees. No database needed.
 * Run: npx ts-node --transpile-only src/tests/cloudinaryMigration.test.ts
 */
import assert from 'assert';
import { Types } from 'mongoose';
import { rewrite, Tally, COLLECTIONS } from '../scripts/migrateCloudinaryCloud';

const old = 'https://res.cloudinary.com/old/';
const neu = 'https://res.cloudinary.com/new/';
const id = new Types.ObjectId();
const date = new Date('2026-10-01T00:00:00Z');
const tally = new Map<string, Tally>();

const out: any = rewrite({
  image: `${old}image/upload/v1/a.webp`,
  mobileImage: '',
  images: [`${old}image/upload/b.webp`, 'https://images.unsplash.com/x.jpg', `${neu}image/upload/done.webp`],
  variants: [{ _id: id, image: `http://res.cloudinary.com/old/image/upload/c.webp`, stock: 3, stockAsOf: date }],
  note: `see ${old}image/upload/d.webp`, // embedded in text: left alone, reported as unhandled
  other: 'https://res.cloudinary.com/older/image/upload/e.webp', // a different cloud whose name starts the same
}, 'old', 'new', '', tally);

assert.strictEqual(out.image, `${neu}image/upload/v1/a.webp`);
assert.strictEqual(out.mobileImage, '');
assert.deepStrictEqual(out.images, [`${neu}image/upload/b.webp`, 'https://images.unsplash.com/x.jpg', `${neu}image/upload/done.webp`]);
assert.strictEqual(out.variants[0].image, 'http://res.cloudinary.com/new/image/upload/c.webp'); // scheme kept
assert.strictEqual(out.variants[0]._id, id);
assert.strictEqual(out.variants[0].stockAsOf, date);
assert.strictEqual(out.variants[0].stock, 3);
assert.strictEqual(out.note, `see ${old}image/upload/d.webp`);
assert.strictEqual(out.other, 'https://res.cloudinary.com/older/image/upload/e.webp');
assert.deepStrictEqual(Object.fromEntries(tally), {
  image: { matched: 1, alreadyOnTarget: 0, unhandled: 0 },
  'images[]': { matched: 1, alreadyOnTarget: 1, unhandled: 0 },
  'variants[].image': { matched: 1, alreadyOnTarget: 0, unhandled: 0 },
  note: { matched: 0, alreadyOnTarget: 0, unhandled: 1 },
});

// Only the cloud-name segment changes: version, folders, filename, transformations, video type and query string are kept
const keep = new Map<string, Tally>();
const variants = [
  'image/upload/v1788956328/luxygalleria_products/image-1788956327462.webp',
  'image/upload/w_400,h_300,c_fill,q_auto,f_auto/v1788956328/luxygalleria_products/a.webp',
  'image/upload/t_thumb/folder/sub/b.png?_a=BAMAK+cQ0',
  'video/upload/v1/clips/c.mp4',
];
for (const rest of variants) {
  assert.strictEqual(rewrite(`${old}${rest}`, 'old', 'new', 'u', keep), `${neu}${rest}`);
}
assert.strictEqual(keep.get('u')!.matched, variants.length);

// Running again over the output changes nothing (idempotent)
const again = new Map<string, Tally>();
assert.deepStrictEqual(rewrite(out, 'old', 'new', '', again), out);
assert.ok([...again.values()].every((t) => t.matched === 0));

assert.ok(!COLLECTIONS.includes('orders') && !COLLECTIONS.includes('users'), 'customer collections must not be rewritten');
console.log('✅ cloudinary migration rewrite: only old-cloud URL prefixes change; idempotent; customer collections excluded');
