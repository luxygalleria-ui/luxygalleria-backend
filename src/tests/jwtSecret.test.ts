/**
 * JWT_SECRET startup rules (config/env.ts). Each case loads env.ts in a fresh child process, in an EMPTY temp folder
 * (so no .env is read) with a scrubbed environment: only NODE_ENV / JWT_SECRET as the case sets them.
 * Also checks statically that every jwt.sign / jwt.verify uses the one validated ENV.JWT_SECRET.
 * No database, no network. Run: npx ts-node --transpile-only src/tests/jwtSecret.test.ts
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const ROOT = path.resolve(__dirname, '../..');
const ENV_TS = path.join(ROOT, 'src/config/env.ts');
const DEV_FALLBACK = 'dev_only_insecure_jwt_secret_do_not_use';
const SECRET = 'TEST-ONLY-9f2c4e7a1b3d5f60718293a4b5c6d7e8f9012345';
const SHORT = 'tiny-test-secret-x7';
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'jwt-secret-test-'));

/** Loads env.ts under exactly `vars`; returns whether it started and what it reported (never the secret itself). */
const load = (vars: Record<string, string>) => {
  const code = `const { ENV } = require(${JSON.stringify(ENV_TS)});
    console.log('RESULT ' + JSON.stringify({ devFallback: ENV.JWT_SECRET === ${JSON.stringify(DEV_FALLBACK)}, matches: ENV.JWT_SECRET === process.env.JWT_SECRET }));`;
  const r = spawnSync(process.execPath, ['-r', require.resolve('ts-node/register/transpile-only'), '-e', code], {
    cwd, encoding: 'utf8', timeout: 60_000,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', TS_NODE_PROJECT: path.join(ROOT, 'tsconfig.json'), ...vars },
  });
  const out = `${r.stdout}\n${r.stderr}`;
  const line = r.stdout.split('\n').find((l) => l.startsWith('RESULT '));
  return { started: r.status === 0 && !!line, result: line ? JSON.parse(line.slice(7)) : null, out };
};

let passed = 0;
const test = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ✅ ${name}`); };
const neverPrints = (out: string, ...values: string[]) => {
  for (const v of values) {
    assert.ok(!out.includes(v), 'secret value printed');
    assert.ok(!new RegExp(`\\b${v.length}\\b`).test(out.replace(/\d+:\d+|line \d+|:\d+\)/g, '')), `secret length (${v.length}) printed`);
  }
};

try {
  console.log('JWT_SECRET startup rules');
  test('development without a secret: starts on the development fallback', () => {
    const r = load({ NODE_ENV: 'development' });
    assert.ok(r.started, r.out);
    assert.deepStrictEqual(r.result, { devFallback: true, matches: false });
  });

  test('development with a secret: uses it, not the fallback', () => {
    const r = load({ NODE_ENV: 'development', JWT_SECRET: SECRET });
    assert.ok(r.started, r.out);
    assert.deepStrictEqual(r.result, { devFallback: false, matches: true });
    neverPrints(r.out, SECRET);
  });

  test('production with a secret: starts and uses exactly that secret', () => {
    const r = load({ NODE_ENV: 'production', JWT_SECRET: SECRET });
    assert.ok(r.started, r.out);
    assert.deepStrictEqual(r.result, { devFallback: false, matches: true });
    neverPrints(r.out, SECRET);
  });

  for (const [label, vars, shown] of [
    ['production without a secret', { NODE_ENV: 'production' }, '"production"'],
    ['production with an empty secret', { NODE_ENV: 'production', JWT_SECRET: '' }, '"production"'],
    ['production with a whitespace-only secret', { NODE_ENV: 'production', JWT_SECRET: '   ' }, '"production"'],
    ['staging without a secret', { NODE_ENV: 'staging' }, '"staging"'],
    ['"Production" (not exact) without a secret', { NODE_ENV: 'Production' }, '"Production"'],
    ['NODE_ENV unset without a secret (ENV.NODE_ENV would default to development: must NOT count)', {}, 'unset'],
  ] as [string, Record<string, string>, string][]) {
    test(`${label}: clear startup failure, no fallback`, () => {
      const r = load(vars);
      assert.ok(!r.started, `must refuse to start: ${r.out}`);
      assert.ok(r.out.includes(`JWT_SECRET is missing or empty and NODE_ENV is ${shown}: refusing to start`), r.out);
      assert.ok(!r.out.includes('RESULT '), 'nothing ran past env.ts');
    });
  }

  test('NODE_ENV unset with a secret: starts and uses it', () => {
    const r = load({ JWT_SECRET: SECRET });
    assert.ok(r.started, r.out);
    assert.deepStrictEqual(r.result, { devFallback: false, matches: true });
    neverPrints(r.out, SECRET);
  });

  test('a weak secret warns without printing the secret or its length', () => {
    const r = load({ NODE_ENV: 'production', JWT_SECRET: SHORT });
    assert.ok(r.started, r.out);
    assert.ok(r.out.includes('JWT_SECRET does not meet the recommended strength'), r.out);
    neverPrints(r.out, SHORT);
  });

  test('every jwt.sign / jwt.verify uses ENV.JWT_SECRET; only config/env.ts reads process.env.JWT_SECRET', () => {
    const files: string[] = [];
    const walk = (d: string) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'tests') walk(p); } else if (p.endsWith('.ts')) files.push(p);
    });
    walk(path.join(ROOT, 'src'));
    let calls = 0;
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(/jwt\.(sign|verify)\(/g)) {
        calls++;
        const args = src.slice(m.index!, m.index! + 300);
        assert.ok(/^jwt\.(sign|verify)\([^;]*?,\s*ENV\.JWT_SECRET\b/.test(args), `${path.relative(ROOT, f)}: ${args.split('\n')[0]}`);
      }
      if (!f.endsWith(path.join('config', 'env.ts'))) assert.ok(!src.includes('process.env.JWT_SECRET'), `${path.relative(ROOT, f)} reads process.env.JWT_SECRET directly`);
    }
    assert.ok(calls >= 2, `found ${calls} jwt.sign/verify calls`); // authController (sign) and authMiddleware (verify)
    // Order emails carry no sign-in token any more (a link in a mailbox must never open the account)
    const pay = fs.readFileSync(path.join(ROOT, 'src', 'controllers', 'paymentController.ts'), 'utf8');
    assert.ok(!/jwt\.sign\(/.test(pay) && !/profile\?token=/.test(pay), 'paymentController mints no token and links no ?token=');
  });

  console.log(`\n${passed} passed`);
} finally {
  fs.rmSync(cwd, { recursive: true, force: true });
}
