#!/usr/bin/env node
/**
 * READ-ONLY ICICI diagnostic for the production VPS. Changes nothing, sends no payment request. Prints no secret,
 * email, user id, payment detail or raw log line: values are reduced to set/unset, hosts, counts and fixed category
 * labels; the only log-derived text printed is an ICICI response code that matches a strict code pattern.
 *
 * Run as the user that owns PM2:   node scripts/icici-diagnose.js [pm2-name-or-id]
 * Optional reachability check:     ICICI_DIAG_CONNECT=1 node scripts/icici-diagnose.js   (a TLS connect to the host only)
 *
 * Facts this relies on (from the code, not guessed):
 * - The backend runs `node dist/server.js`; dotenv loads `.env` from the process CWD and never overrides a variable
 *   already in the process environment. Effective value = process env if present, else .env.
 * - .env changes only apply after a restart; /proc/<pid>/environ and PM2 do not show dotenv-loaded values.
 * - UAT gate (iciciController.ts): unless BOTH sale and command URLs are https://pgpay.icicibank.com (live), only the
 *   user _ids in ICICI_PG_UAT_TEST_USER_IDS may pay, on every server except NODE_ENV exactly "development".
 * - ICICI messages are console.* -> PM2's out/err log files, not logs/*.log. logs/combined.log holds morgan lines.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const KEYS = ['NODE_ENV', 'ICICI_PG_INITIATE_SALE_URL', 'ICICI_PG_COMMAND_URL', 'ICICI_PG_RETURN_URL', 'ICICI_PG_MERCHANT_ID',
  'ICICI_PG_SECRET_KEY', 'ICICI_PG_AGGREGATOR_ID', 'ICICI_PG_CURRENCY_CODE', 'ICICI_PG_UAT_TEST_USER_IDS', 'ICICI_PG_UAT_TEST_EMAILS', 'FRONTEND_URL'];
const URL_KEYS = new Set(['ICICI_PG_INITIATE_SALE_URL', 'ICICI_PG_COMMAND_URL', 'ICICI_PG_RETURN_URL', 'FRONTEND_URL']);

/** Same rule as iciciController.ts: every entry a 24-hex _id, else the whole list is refused. */
const testerIds = (v) => {
  const ids = String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return { count: ids.length, malformed: ids.filter((id) => !/^[a-f\d]{24}$/i.test(id)).length };
};

/** Safe view of one value: URLs -> origin+path, plain-word NODE_ENV / 3-digit currency as-is, the rest set/unset or counts. */
const show = (k, v) => {
  if (v === undefined) return 'UNSET';
  if (k === 'NODE_ENV') return /^[\w.-]{0,20}$/.test(v) ? JSON.stringify(v) : 'set (unusual value, not shown)';
  if (k === 'ICICI_PG_CURRENCY_CODE') return /^\d{3}$/.test(v.trim()) ? JSON.stringify(v.trim()) : 'set (not 3 digits)';
  if (k === 'ICICI_PG_UAT_TEST_USER_IDS') { const t = testerIds(v); return t.malformed ? `INVALID (${t.malformed} of ${t.count} malformed)` : `${t.count} id(s)`; }
  if (k === 'ICICI_PG_UAT_TEST_EMAILS') return v.trim() ? 'set (IGNORED by the code)' : 'EMPTY';
  if (URL_KEYS.has(k)) { try { const u = new URL(v.trim()); return `${u.origin}${u.pathname}`; } catch { return v.trim() ? 'INVALID URL' : 'EMPTY'; } }
  return v.trim() ? 'set' : 'EMPTY';
};

const parseEnvFile = (file) => {
  const out = {};
  if (!fs.existsSync(file)) return null;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*)?$/);
    if (!m) continue;
    let v = (m[2] ?? '').trim();
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1); else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
};

const procEnv = (pid) => {
  try {
    return Object.fromEntries(fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean)
      .map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
  } catch { return null; }
};

const tail = (file, bytes = 4 * 1024 * 1024) => {
  try {
    const fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(bytes, size));
    fs.readSync(fd, buf, 0, buf.length, size - buf.length);
    fs.closeSync(fd);
    return buf.toString('utf8').split('\n');
  } catch { return null; }
};

/**
 * One log line -> [category, detail] using fixed labels only, or null if it is not an ICICI controller line.
 * Patterns are anchored on the exact messages iciciController.ts writes, so other app output is never classified.
 */
const CODE = /^[A-Z]{0,3}\d{3,5}$/; // ICICI codes look like 0000, 000, R1000, E005, P1001
const classify = (l) => {
  let m;
  if ((m = l.match(/ICICI initiateSale [A-Z0-9]{1,20} failed: (.*)$/))) {
    const why = m[1];
    if (/no response in 20 s|TimeoutError|aborted due to timeout/.test(why)) return ['initiateSale: no reply in 20 s (check ICICI IP allow-list)', ''];
    const http = why.match(/^ICICI HTTP (\d{3}):/);
    if (http) return ['initiateSale: non-JSON reply from gateway', `HTTP ${http[1]}`];
    if (/ENOTFOUND|EAI_AGAIN/.test(why)) return ['initiateSale: DNS failure', ''];
    if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|fetch failed|socket/i.test(why)) return ['initiateSale: network error', ''];
    if (/certificate|TLS|SSL/i.test(why)) return ['initiateSale: TLS error', ''];
    if (/credentials/.test(why)) return ['initiateSale: URL contains credentials', ''];
    return ['initiateSale: other error', ''];
  }
  if ((m = l.match(/ICICI initiateSale [A-Z0-9]{1,20} refused: responseCode (\S*)/))) {
    const flag = /\(secureHash mismatch\)/.test(l) ? ' + secureHash mismatch' : /\(OTP capture page requested\)/.test(l) ? ' + OTP page requested' : '';
    return [`initiateSale: refused by gateway${flag}`, CODE.test(m[1]) ? `code ${m[1]}` : 'code other'];
  }
  if ((m = l.match(/ICICI icici-(callback|advice) REJECTED \((secureHash mismatch|no merchantTxnNo|unexpected merchantId)/))) return [`${m[1]} rejected: ${m[2]}`, ''];
  if ((m = l.match(/ICICI icici-(callback|advice|status): no checkout session for merchantTxnNo/))) return [`${m[1]}: unknown merchantTxnNo`, ''];
  if (/ICICI icici-(callback|advice|status): \S+ paid .* expected .*Refund manually/.test(l)) return ['amount mismatch (refund manually)', ''];
  if (/ICICI STATUS [A-Z0-9]{1,20}: secureHash mismatch/.test(l)) return ['status check: secureHash mismatch', ''];
  if ((m = l.match(/Error (initiating ICICI payment|handling ICICI callback|handling ICICI payment advice|handling ICICI settlement advice|checking ICICI status|refunding ICICI order)/))) return [`exception: ${m[1]}`, ''];
  if (/ICICI UAT gate: ICICI_PG_UAT_TEST_USER_IDS has a malformed entry/.test(l)) return ['UAT gate: malformed tester id list', ''];
  if (/ICICI UAT gate: ICICI_PG_UAT_TEST_EMAILS is no longer used/.test(l)) return ['UAT gate: stale ICICI_PG_UAT_TEST_EMAILS set', ''];
  return null;
};

let apps;
try {
  apps = JSON.parse(execFileSync('pm2', ['jlist'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }));
} catch (e) {
  console.error('Could not run `pm2 jlist` (is PM2 installed for this user?)'); process.exit(1);
}
const want = process.argv[2];
const candidates = apps.filter((a) => want
  ? a.name === want || String(a.pm_id) === want
  : /dist[\\/]server\.js$/.test(a.pm2_env?.pm_exec_path || '') || /luxy-backend/.test(a.pm2_env?.pm_cwd || ''));

console.log(`PM2 apps: ${apps.map((a) => `${a.pm_id}:${a.name}(${a.pm2_env?.status})`).join(', ') || 'none'}`);
if (!candidates.length) { console.error('No backend app found. Pass the PM2 name or id as the first argument.'); process.exit(1); }
if (candidates.length > 1 && !want) console.log(`More than one candidate; checking all. Pass a name/id to pick one.`);

for (const a of candidates) {
  const e = a.pm2_env || {};
  const cwd = e.pm_cwd || '';
  console.log(`\n=== ${a.pm_id}:${a.name}  status=${e.status} pid=${a.pid} restarts=${e.restart_time} instances=${e.instances} exec_mode=${e.exec_mode}`);
  console.log(`script=${e.pm_exec_path}  cwd=${cwd}  node=${e.node_version ?? 'unknown'}`);
  const started = e.pm_uptime ? new Date(e.pm_uptime) : null;
  console.log(`started=${started?.toISOString() ?? 'unknown'}`);

  // The running process's own environment (Linux), else what PM2 recorded when it started the app
  const proc = (a.pid && procEnv(a.pid)) || null;
  const pmEnv = proc ? null : { ...(e.env || {}), ...Object.fromEntries(KEYS.filter((k) => typeof e[k] === 'string').map((k) => [k, e[k]])) };
  const runEnv = proc || pmEnv;
  const envFile = path.join(cwd, '.env');
  const dot = parseEnvFile(envFile);
  console.log(`process env source: ${proc ? `/proc/${a.pid}/environ` : 'pm2 jlist (proc not readable)'}`);
  if (!dot) console.log(`.env: NOT FOUND at ${envFile} (dotenv reads it from the process cwd)`);
  else {
    const mtime = fs.statSync(envFile).mtime;
    console.log(`.env: ${envFile} modified ${mtime.toISOString()}${started && mtime > started ? '  <-- CHANGED AFTER START: running values may be stale, restart needed' : ''}`);
  }

  const eff = {};
  console.log('\nkey                           effective        | process env      | .env');
  for (const k of KEYS) {
    const p = runEnv?.[k];
    const d = dot?.[k];
    eff[k] = p !== undefined ? p : d;
    const src = p !== undefined ? 'process' : d !== undefined ? '.env' : 'none';
    console.log(`${k.padEnd(30)}${show(k, eff[k])} [${src}]  | ${show(k, p)}  | ${show(k, d)}`);
    if (p !== undefined && d !== undefined && p !== d) console.log(`${''.padEnd(30)}^ process env and .env DIFFER: the process value wins (dotenv does not override)`);
  }

  // JWT_SECRET: presence only (same rule as config/env.ts: empty / whitespace counts as unset). Kept out of the table
  // above so not even "process env and .env differ" is reported for it.
  const jwtRaw = runEnv?.JWT_SECRET !== undefined ? runEnv.JWT_SECRET : dot?.JWT_SECRET;
  console.log(`\nJWT_SECRET: ${String(jwtRaw ?? '').trim() ? 'SET' : 'UNSET'}`);

  // Mirror the code's own checks
  const sale = (eff.ICICI_PG_INITIATE_SALE_URL || '').trim();
  const cmd = (eff.ICICI_PG_COMMAND_URL || '').trim();
  const configured = ['ICICI_PG_MERCHANT_ID', 'ICICI_PG_SECRET_KEY', 'ICICI_PG_INITIATE_SALE_URL', 'ICICI_PG_COMMAND_URL', 'ICICI_PG_RETURN_URL']
    .every((k) => (eff[k] || '').trim());
  const saleUat = sale.includes('pgpayuat');
  console.log(`\niciciConfigured: ${configured ? 'yes' : 'NO -> /icici/initiate answers 503'}`);
  console.log(`environment: initiateSale=${sale ? (saleUat ? 'UAT' : 'LIVE?') : '-'} command=${cmd ? (cmd.includes('pgpayuat') ? 'UAT' : 'LIVE?') : '-'}${sale && cmd && saleUat !== cmd.includes('pgpayuat') ? '  <-- MIXED UAT/LIVE' : ''}`);
  if (eff.NODE_ENV === undefined) {
    console.log('NODE_ENV: UNSET. The ICICI UAT gate treats this as NOT development (gated), and so do the rate limiters (active);');
    console.log('          config/env.ts defaults it to "development" for logging (morgan dev + console logger) and other ENV.NODE_ENV checks.');
  } else console.log(`NODE_ENV: ${show('NODE_ENV', eff.NODE_ENV)}${eff.NODE_ENV === 'development' ? '  <-- development: UAT gate, rate limiters and production logging are OFF' : ''}`);

  const liveHost = (u) => { try { const x = new URL(u); return x.protocol === 'https:' && x.hostname === 'pgpay.icicibank.com'; } catch { return false; } };
  const live = liveHost(sale) && liveHost(cmd);
  const gated = !live && eff.NODE_ENV !== 'development'; // raw value: unset is gated
  const t = testerIds(eff.ICICI_PG_UAT_TEST_USER_IDS);
  console.log(`gateway config: ${live ? 'LIVE (both URLs https://pgpay.icicibank.com)' : 'TEST (UAT, mixed or unknown host)'}`);
  if (!live) {
    console.log(`UAT tester gate: ${!gated ? 'INACTIVE: NODE_ENV is exactly "development", ANY customer can pay with test config'
      : t.malformed ? 'ACTIVE, tester list INVALID: every customer gets 403'
      : t.count ? `ACTIVE: only ${t.count} listed user id(s) may pay (confirm each is the intended account; see .env.example)`
      : 'ACTIVE, tester list EMPTY: every customer gets 403'}`);
  }
  if ((eff.ICICI_PG_UAT_TEST_EMAILS || '').trim()) console.log('ICICI_PG_UAT_TEST_EMAILS is set but IGNORED: testers are authorised by ICICI_PG_UAT_TEST_USER_IDS only');
  const ret = (eff.ICICI_PG_RETURN_URL || '').trim();
  if (ret && !/\/api\/v1\/payments\/icici\/callback\/?$/.test(ret)) console.log('RETURN_URL does not end in /api/v1/payments/icici/callback');
  if (ret && !ret.startsWith('https://')) console.log('RETURN_URL is not https');
  const major = Number(String(e.node_version || '').split('.')[0]);
  if (major && major < 21) console.log(`node ${e.node_version}: JSON advices sending amounts as numbers (e.g. 600.00) will fail the hash check (needs JSON.parse source text, Node 21+)`);

  // PM2 logs: where every ICICI console.* line goes. Aggregates only: no log text is printed.
  for (const f of [e.pm_err_log_path, e.pm_out_log_path].filter(Boolean)) {
    const lines = tail(f);
    console.log(`\nPM2 log ${f}: ${lines ? `${lines.length} recent lines scanned` : 'not readable'}`);
    if (!lines) continue;
    const counts = new Map();
    for (const l of lines) {
      const c = classify(l);
      if (!c) continue;
      const k = c[1] ? `${c[0]} [${c[1]}]` : c[0];
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    if (!counts.size) console.log('  no ICICI controller entries');
    for (const [k, n] of [...counts].sort()) console.log(`  ${k}: ${n}`);
  }

  // morgan "combined" lines (winston JSON in logs/combined.log): ICICI routes by status, query strings dropped
  const combined = tail(path.join(cwd, 'logs', 'combined.log'));
  if (combined) {
    const counts = {};
    for (const l of combined) {
      const m = l.match(/"(GET|POST) (\/api\/v1\/payments\/icici\/(?:initiate|callback|payment-advice|settlement-advice|status|refund))(?=[/?\s])[^"]* HTTP\/[\d.]+\\?" (\d{3})/i);
      if (m) { const k = `${m[1]} ${m[2].toLowerCase()} ${m[3]}`; counts[k] = (counts[k] || 0) + 1; }
    }
    console.log(`\nlogs/combined.log ICICI requests (method path status: count):`);
    for (const [k, n] of Object.entries(counts).sort()) console.log(`  ${k}: ${n}`);
    if (!Object.keys(counts).length) console.log('  none in the scanned tail');
  }

  if (process.env.ICICI_DIAG_CONNECT === '1') {
    for (const u of [...new Set([sale, cmd].filter(Boolean).map((x) => { try { return new URL(x).origin; } catch { return null; } }).filter(Boolean))]) {
      try {
        const code = execFileSync('curl', ['-sS', '-o', '/dev/null', '-w', '%{http_code} connect=%{time_connect}s tls=%{time_appconnect}s', '--connect-timeout', '10', '--max-time', '15', `${u}/`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        console.log(`reach ${u}/ -> HTTP ${code} (any HTTP code means TCP+TLS work; a timeout suggests the IP is not allow-listed)`);
      } catch (err) {
        const exit = typeof err.status === 'number' ? err.status : 'unknown';
        console.log(`reach ${u}/ -> FAILED (curl exit ${exit}; 28 = timeout, 6 = DNS, 7 = refused, 35/60 = TLS)`);
      }
    }
  }
}
