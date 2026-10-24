/**
 * Rewrites stored Cloudinary URLs after the Cloudinary cloud was renamed:
 *   http(s)://res.cloudinary.com/<from>/...  ->  same scheme, res.cloudinary.com/<to>/...
 *
 * Target is explicit: MIGRATION_MONGO_URI (never .env's MONGO_URI) and --db must equal the database it names.
 * Report only by default: reads catalogue collections and HEAD-checks the new URLs; never writes.
 * --apply writes, only if every rewritten URL answers 200, each update conditional on the values read.
 * Customer collections are never scanned or written; old-cloud references there are only counted.
 *
 * Run: MIGRATION_MONGO_URI=... npm run migrate:cloudinary-cloud -- --db NAME --from OLD_CLOUD --to NEW_CLOUD [--apply]
 */
import mongoose from 'mongoose';

const CLOUD_NAME = /^[a-z0-9_-]+$/i;
// Catalogue content only. Order/user records are customer data: counted below, never rewritten here.
export const COLLECTIONS = ['banners', 'categories', 'brands', 'products', 'testimonials'];
const CUSTOMER_FIELDS: [string, string][] = [['orders', 'items.image'], ['users', 'avatar']];

export type Tally = { matched: number; alreadyOnTarget: number; unhandled: number };
const bump = (t: Map<string, Tally>, path: string, k: keyof Tally) => {
  const row = t.get(path) || { matched: 0, alreadyOnTarget: 0, unhandled: 0 };
  row[k]++;
  t.set(path, row);
};

/** Returns `value` with old-cloud URL prefixes rewritten, tallying each string per field path. Only plain objects/arrays are walked. */
export const rewrite = (value: unknown, fromCloud: string, toCloud: string, path: string, t: Map<string, Tally>): unknown => {
  if (typeof value === 'string') {
    const m = value.match(/^(https?):\/\/res\.cloudinary\.com\/([^/]+)\//);
    if (m && m[2] === fromCloud) {
      bump(t, path, 'matched');
      return `${m[1]}://res.cloudinary.com/${toCloud}/` + value.slice(m[0].length);
    }
    if (m && m[2] === toCloud) bump(t, path, 'alreadyOnTarget');
    else if (value.includes(`res.cloudinary.com/${fromCloud}/`)) bump(t, path, 'unhandled'); // embedded in text etc.: left alone, reported
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => rewrite(v, fromCloud, toCloud, `${path}[]`, t));
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewrite(v, fromCloud, toCloud, path ? `${path}.${k}` : k, t)]));
  }
  return value; // ObjectId, Date, numbers, null …
};

const urlsIn = (value: unknown, toCloud: string, out: Set<string>) => {
  if (typeof value === 'string') { if (/^https?:\/\/res\.cloudinary\.com\//.test(value) && value.includes(`/${toCloud}/`)) out.add(value); return; }
  if (Array.isArray(value)) return value.forEach((v) => urlsIn(v, toCloud, out));
  if (value && Object.getPrototypeOf(value) === Object.prototype) Object.values(value).forEach((v) => urlsIn(v, toCloud, out));
};

const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };

const run = async () => {
  const fromCloud = arg('--from');
  const toCloud = arg('--to');
  const dbName = arg('--db');
  const apply = process.argv.includes('--apply');
  const uri = process.env.MIGRATION_MONGO_URI;
  if (!uri || !dbName || !fromCloud || !toCloud || !CLOUD_NAME.test(fromCloud) || !CLOUD_NAME.test(toCloud) || fromCloud === toCloud) {
    throw new Error('Usage: MIGRATION_MONGO_URI=... --db NAME --from OLD_CLOUD --to NEW_CLOUD [--apply]');
  }

  await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
  const db = mongoose.connection.db!;
  if (db.databaseName !== dbName) throw new Error(`Connected database is "${db.databaseName}", not --db "${dbName}"; nothing done`);
  // Database name only: reports get saved and shared, so never the host, user or URI
  console.log(`${apply ? 'APPLY' : 'REPORT ONLY (no writes)'} on database "${db.databaseName}": ${fromCloud} -> ${toCloud}`);

  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  const plan: { collection: string; _id: unknown; set: Record<string, unknown>; was: Record<string, unknown> }[] = [];
  const urls = new Set<string>();
  const summary: Record<string, unknown> = {};

  for (const name of COLLECTIONS.filter((c) => existing.has(c))) {
    const tally = new Map<string, Tally>();
    let docs = 0;
    let toChange = 0;
    for await (const doc of db.collection(name).find()) {
      docs++;
      const set: Record<string, unknown> = {};
      const was: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(doc)) {
        if (field === '_id') continue;
        const next = rewrite(value, fromCloud, toCloud, field, tally);
        if (JSON.stringify(next) !== JSON.stringify(value)) { set[field] = next; was[field] = value; urlsIn(next, toCloud, urls); }
      }
      if (Object.keys(set).length) { toChange++; plan.push({ collection: name, _id: doc._id, set, was }); }
    }
    summary[name] = { documents: docs, documentsToChange: toChange, fields: Object.fromEntries(tally) };
    console.log(`  ${name}: ${docs} documents, ${toChange} to change`);
    for (const [path, t] of tally) console.log(`    ${path}: matched ${t.matched}, already on ${toCloud} ${t.alreadyOnTarget}, unhandled ${t.unhandled}`);
  }

  // Customer records: count only (no documents read into this process), never rewritten
  const prefix = new RegExp(`^https?://res\\.cloudinary\\.com/${fromCloud}/`);
  for (const [name, field] of CUSTOMER_FIELDS.filter(([c]) => existing.has(c))) {
    const n = await db.collection(name).countDocuments({ [field]: prefix });
    summary[`${name}.${field} (not migrated)`] = n;
    console.log(`  ${name}.${field}: ${n} documents reference ${fromCloud} (customer records: not changed by this script)`);
  }

  const invalid: string[] = [];
  for (const url of urls) {
    const status = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(15000) }).then((r) => r.status, () => 0);
    if (status !== 200) { invalid.push(url); console.log(`  INVALID on ${toCloud} (${status || 'network error'}): ${url}`); }
  }
  console.log(`${plan.length} documents to change; ${urls.size} distinct rewritten URLs, ${urls.size - invalid.length} answer 200, ${invalid.length} invalid`);
  Object.assign(summary, { documentsToChange: plan.length, distinctUrls: urls.size, invalidUrls: invalid.length });

  if (!apply) {
    console.log('Report only: nothing was written. Re-run with --apply after approval.');
    return console.log(JSON.stringify(summary));
  }
  if (invalid.length) throw new Error('Refusing to apply: some rewritten URLs are not available on the new cloud; nothing written');

  let updated = 0;
  let skipped = 0;
  let failed = 0;
  for (const p of plan) {
    try {
      // Conditional on the values read, so a field changed since the scan (e.g. a checkout stock update) is never overwritten
      const r = await db.collection(p.collection).updateOne({ _id: p._id as any, ...p.was }, { $set: p.set });
      if (r.modifiedCount) updated++; else skipped++;
    } catch (err: any) {
      failed++;
      console.log(`  FAILED ${p.collection}/${p._id}: ${err.message}`);
    }
  }
  console.log(`Updated ${updated}; skipped ${skipped} (changed during the run: re-run to pick them up); failed ${failed}`);
  console.log(JSON.stringify({ ...summary, updated, skipped, failed }));
};

if (require.main === module) {
  // Driver errors can echo the connection string or cluster host: redact both before printing
  const redact = (m: string) => (process.env.MIGRATION_MONGO_URI ? m.split(process.env.MIGRATION_MONGO_URI).join('<MIGRATION_MONGO_URI>') : m)
    .replace(/[a-z0-9.-]+\.mongodb\.net/gi, '<cluster-host>');
  run().then(() => mongoose.disconnect(), async (err) => { console.error(redact(String(err?.message ?? err))); process.exitCode = 1; await mongoose.disconnect(); });
}
