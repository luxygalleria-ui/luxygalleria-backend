# Local development data

## Where each app gets its data

| Environment | Storefront API | Admin API | Database |
|---|---|---|---|
| Production (`www.luxygalleria.com`, `admin.luxygalleria.com`) | `https://api.luxygalleria.com/api/v1` (built into the deployed bundles) | `https://api.luxygalleria.com/api/v1` | Production MongoDB, configured on the API server only |
| Local (`localhost:3000`, `localhost:3001`) | `http://localhost:5000/api/v1`, always: `luxy-frontend/src/lib/apiClient.ts` forces it whenever the page is opened on `localhost` and ignores `NEXT_PUBLIC_API_URL` | `luxy-admin/.env` → `http://localhost:5000/api/v1` | Whatever `MONGO_URI` in `luxy-backend/.env` names; by default a local MongoDB database |

The local database is separate from production on purpose, so local content will differ from the live site. Production is the source of truth for banners, products, categories and brands. Never point local development at the production database without explicit approval: the local admin can create, edit and delete records.

## Demo seed scripts

`npm run seed-banners` and `npm run seed-data` delete the banners (or the products and categories) in the target database and insert demo content: Unsplash stock photos and sample products. That is why a local site seeded this way shows, for example, a cake banner instead of the live Luxy Galleria banners. Both scripts refuse to run unless the target is `localhost` or `127.0.0.1`.

## Fixing the two dead demo banners (local only)

Two of the three seeded banners used Unsplash photos that no longer exist: `photo-1589985643985-…` and `photo-1555939594-…` both return 404. `seedBanners.ts` now uses verified replacements: Coca-Cola cans and mixed chocolate bars.

To fix an existing local database without re-seeding, which would delete all banners: back up the collection, swap only the dead photo ids in `image` and `mobileImage`, and undo from the backup if needed. Titles, status and ids are untouched; re-running changes nothing. This was tested on a copy of the local database: exactly 2 banners changed, and the undo restored them.

```bash
mongodump --uri mongodb://127.0.0.1:27017/luxy-galleria --collection banners --gzip --archive=local-banners-before.archive.gz
mongosh --quiet mongodb://127.0.0.1:27017/luxy-galleria --eval '
const fix = { "photo-1589985643985-33b5f0ee2a1d": "photo-1622483767028-3f66f32aef97", "photo-1555939594-58d7cb561ffa": "photo-1621939514649-280e2ee25f60" };
for (const [dead, ok] of Object.entries(fix)) for (const f of ["image", "mobileImage"]) {
  const r = db.banners.updateMany({ [f]: { $regex: "^https://images\\.unsplash\\.com/" + dead + "\\?" } }, [{ $set: { [f]: { $replaceOne: { input: "$" + f, find: dead, replacement: ok } } } }]);
  print(f.padEnd(11), dead, "->", ok, "| matched", r.matchedCount, "modified", r.modifiedCount);
}'
# Undo:
mongorestore --uri mongodb://127.0.0.1:27017 --gzip --drop --nsFrom 'luxy-galleria.banners' --nsTo 'luxy-galleria.banners' --archive=local-banners-before.archive.gz
```

Alternatively, edit those banners in the local admin. Its banner form only uploads files, and with the normal `.env` an upload goes to the **live** Cloudinary account. To keep uploads local, start the backend with Cloudinary switched off for that session:

```bash
CLOUDINARY_CLOUD_NAME= CLOUDINARY_API_KEY= CLOUDINARY_API_SECRET= npm run dev
```

The empty values override `.env`. Uploads are then saved to `luxy-backend/uploads/` and served at `http://localhost:5000/uploads/<file>`. Restart normally afterwards.

## Getting real catalogue data locally (authorized snapshot)

Needs approval from the data owner. Tested end to end on 23 Oct 2026 against throwaway databases. A fake source containing users, orders, contacts and coupons produced a snapshot with only the four catalogue collections and no sensitive fields. The import replaced only those four collections and kept the local admin user and settings.

**Allow-list.**
- Always: `banners`, `categories`, `brands`, `products`. They go together, because products reference categories and brands by id.
- Optional, with approval: `settings`, `faqs`, `testimonials`, `videotestimonials`. These are public site content; testimonials contain client names.
- **Never:** `users` (emails, phones, addresses, password hashes, OTPs), `orders` (addresses, payment ids and signatures), `carts`, `contacts`, `coupons` (live discount codes), `erpevents`, and any collection not listed here.

### 1. Export (trusted machine, read-only production database user)

```bash
read -rs PROD_URI && export PROD_URI      # not echoed, not in shell history
PROD_DB='<PROD_DB_NAME>'; STAMP=$(date +%Y%m%d-%H%M); umask 077
printf 'uri: %s\n' "$PROD_URI" > .mongo-tools.yaml   # keeps the URI off the process list
for c in banners categories brands products; do
  mongodump --config=.mongo-tools.yaml --db "$PROD_DB" --collection "$c" --gzip --out "catalogue-$STAMP"
done
rm -f .mongo-tools.yaml; unset PROD_URI
```

### 2. Verify the snapshot before importing (local, read-only)

```bash
# Only the allow-listed collections (prelude.json.gz is mongodump metadata)
ls "catalogue-$STAMP/$PROD_DB" | sed -E 's/\.(bson|metadata\.json)\.gz$//' | sort -u | grep -vxE 'banners|categories|brands|products|prelude\.json\.gz' \
  && echo "STOP: unexpected collections above" || echo "collections OK"
# No personal or secret fields in the data (expect 0)
for f in "catalogue-$STAMP/$PROD_DB"/*.bson.gz; do gunzip -c "$f" | bsondump --quiet; done \
  | grep -ciE '"(password|email|phone|otp|token|googleId|razorpay[A-Za-z]*|addresses|shippingAddress|secret|apiKey)"\s*:'
```

### 3. Import into a separate local database and inspect it (creates a new local database only)

```bash
mongorestore --uri mongodb://127.0.0.1:27017 --gzip --nsFrom "$PROD_DB.*" --nsTo "luxy-catalogue-$STAMP.*" "catalogue-$STAMP"
mongosh --quiet "mongodb://127.0.0.1:27017/luxy-catalogue-$STAMP" --eval 'printjson(Object.fromEntries(db.getCollectionNames().sort().map(c=>[c,db[c].countDocuments()])))'
```

### 4. Replace the catalogue in the working local database (modifies local data; approval required)

```bash
# Back up the current local database first
mongodump --uri mongodb://127.0.0.1:27017/luxy-galleria --gzip --archive="luxy-galleria-before-$STAMP.archive.gz"
# --drop replaces ONLY the four collections in the snapshot; users, settings, orders etc. are untouched
mongorestore --uri mongodb://127.0.0.1:27017 --gzip --drop --nsFrom "$PROD_DB.*" --nsTo "luxy-galleria.*" "catalogue-$STAMP"
```

Undo:

```bash
mongorestore --uri mongodb://127.0.0.1:27017 --gzip --drop --archive="luxy-galleria-before-$STAMP.archive.gz"
```

### 5. Fix the copied image URLs locally (modifies local data; approval required)

Until production is migrated, the snapshot's image URLs still name the old cloud `dlysz5wmo` and will 404 locally. Run the migration report first, then apply, against the **local** database:

```bash
MIGRATION_MONGO_URI=mongodb://127.0.0.1:27017/luxy-galleria npm run -s migrate:cloudinary-cloud -- --db luxy-galleria --from dlysz5wmo --to luxygalleria-staging
MIGRATION_MONGO_URI=mongodb://127.0.0.1:27017/luxy-galleria npm run -s migrate:cloudinary-cloud -- --db luxy-galleria --from dlysz5wmo --to luxygalleria-staging --apply
```

Delete `catalogue-$STAMP` when you are done.

**Uploads from local development write to the real Cloudinary account** (`luxygalleria-staging`), because the local `.env` has its credentials. Upload only test images, with approval, and delete them afterwards.
