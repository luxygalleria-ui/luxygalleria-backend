/**
 * describeMongoUri never reveals the password. No database needed.
 * Run: npx ts-node --transpile-only src/tests/dbUri.test.ts
 */
import assert from 'assert';
import { describeMongoUri, productionDbInDevelopment } from '../config/db';

const cases: [string, string, string][] = [
  ['mongodb+srv://shop_user:S3cretPass99@cluster0.abc.mongodb.net/luxy?retryWrites=true', 'S3cretPass99', 'mongodb+srv://***:***@cluster0.abc.mongodb.net/luxy'],
  ['mongodb+srv://shop_user:p@ss:w0rd@cluster0.abc.mongodb.net/luxy', 'p@ss:w0rd', 'mongodb+srv://***:***@cluster0.abc.mongodb.net/luxy'],
  ['mongodb+srv://shop_user:p%40ss%2Fx@cluster0.abc.mongodb.net/', 'p%40ss%2Fx', 'mongodb+srv://***:***@cluster0.abc.mongodb.net/(default database)'],
  ['mongodb://127.0.0.1:27017/luxy_local', '', 'mongodb://127.0.0.1:27017/luxy_local'],
];
for (const [uri, password, expected] of cases) {
  const out = describeMongoUri(uri);
  assert.strictEqual(out, expected);
  if (password) assert.ok(!out.includes(password), `password leaked: ${out}`);
  assert.ok(!out.includes('shop_user'), `username leaked: ${out}`);
}
assert.strictEqual(describeMongoUri('not-a-uri'), '(MONGO_URI is not a mongodb:// or mongodb+srv:// URI)');
console.log(`✅ describeMongoUri: ${cases.length + 1} cases, no password or username ever shown`);

// Development never targets the production database "luxy" unless explicitly allowed
const prodIn = (uri: string, env = 'development', allow?: string) => productionDbInDevelopment(uri, env, allow);
assert.strictEqual(prodIn('mongodb+srv://u:p@c.mongodb.net/luxy?retryWrites=true'), true);
assert.strictEqual(prodIn('mongodb+srv://u:p@c.mongodb.net/luxy'), true);
assert.strictEqual(prodIn('mongodb+srv://u:p@c.mongodb.net/luxy_staging'), false);
assert.strictEqual(prodIn('mongodb://127.0.0.1:27017/luxy-galleria'), false);
assert.strictEqual(prodIn('mongodb+srv://u:p@c.mongodb.net/luxy', 'production'), false);
assert.strictEqual(prodIn('mongodb+srv://u:p@c.mongodb.net/luxy', 'development', 'true'), false);
console.log('✅ productionDbInDevelopment: blocks "luxy" in development only, unless allowed');
