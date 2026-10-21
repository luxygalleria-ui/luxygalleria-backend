/**
 * describeMongoUri never reveals the password. No database needed.
 * Run: npx ts-node --transpile-only src/tests/dbUri.test.ts
 */
import assert from 'assert';
import { describeMongoUri } from '../config/db';

const cases: [string, string, string][] = [
  ['mongodb+srv://shop_user:S3cretPass99@cluster0.abc.mongodb.net/luxy?retryWrites=true', 'S3cretPass99', 'mongodb+srv://shop_user:***@cluster0.abc.mongodb.net/luxy'],
  ['mongodb+srv://shop_user:p@ss:w0rd@cluster0.abc.mongodb.net/luxy', 'p@ss:w0rd', 'mongodb+srv://shop_user:***@cluster0.abc.mongodb.net/luxy'],
  ['mongodb+srv://shop_user:p%40ss%2Fx@cluster0.abc.mongodb.net/', 'p%40ss%2Fx', 'mongodb+srv://shop_user:***@cluster0.abc.mongodb.net/(default database)'],
  ['mongodb://127.0.0.1:27017/luxy_local', '', 'mongodb://127.0.0.1:27017/luxy_local'],
];
for (const [uri, password, expected] of cases) {
  const out = describeMongoUri(uri);
  assert.strictEqual(out, expected);
  if (password) assert.ok(!out.includes(password), `password leaked: ${out}`);
}
assert.strictEqual(describeMongoUri('not-a-uri'), '(MONGO_URI is not a mongodb:// or mongodb+srv:// URI)');
console.log(`✅ describeMongoUri: ${cases.length + 1} cases, no password ever shown`);
