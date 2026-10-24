"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Safe diagnostic for the optional read-only history connection. Prints no credentials: only presence, scheme,
 * a redacted host, the opt-in, database name and NODE_ENV. With --connect it makes ONE read-only connection
 * attempt (no queries beyond the login/role/collection checks) and prints the outcome category.
 * Run: npm run diagnose:history            (config only)
 *      npm run diagnose:history -- --connect
 */
require("dotenv/config");
const historyDb_1 = require("../config/historyDb");
const uri = (process.env.HISTORY_READ_URI || '').trim();
const m = uri.match(/^(mongodb(?:\+srv)?):\/\/(?:[^@/]*@)?([^/?]+)/);
// Keep the first label (e.g. cluster0) and the provider domain; hide the project-specific part
const redactHost = (h) => h.split(',').map((x) => { const p = x.split('.'); return p.length > 3 ? [p[0], '***', ...p.slice(-2)].join('.') : '***'; }).join(',');
const cfg = (0, historyDb_1.historyConfig)();
const checkDns = async () => {
    if (!m)
        return null;
    const host = m[2].split(',')[0].replace(/:\d+$/, '');
    const dns = await import('dns');
    try {
        if (m[1] === 'mongodb+srv') {
            const r = await dns.promises.resolveSrv(`_mongodb._tcp.${host}`);
            return `SRV record resolves (${r.length} servers)`;
        }
        await dns.promises.lookup(host);
        return 'host resolves';
    }
    catch (e) {
        return `does not resolve (${e.code})`;
    }
};
console.log(JSON.stringify({
    NODE_ENV: process.env.NODE_ENV || '(unset: treated as development)',
    HISTORY_READ_ENABLED: process.env.HISTORY_READ_ENABLED ?? '(unset)',
    HISTORY_READ_DB: process.env.HISTORY_READ_DB ?? '(unset)',
    HISTORY_READ_URI: {
        present: !!uri, scheme: m ? m[1] : uri ? 'not a mongodb URI' : null, host: m ? redactHost(m[2]) : null,
        hostIsAtlas: m ? /\.mongodb\.net(:\d+)?$/.test(m[2]) : null, hasCredentials: /\/\/[^/]*@/.test(uri),
    },
    wouldStart: cfg.enabled, ...(cfg.enabled ? {} : { reason: cfg.reason }),
}, null, 2));
(async () => {
    const dnsResult = await checkDns();
    if (dnsResult)
        console.log(`DNS: ${dnsResult}`);
    if (process.argv.includes('--connect')) {
        const r = await (0, historyDb_1.checkHistoryConnection)();
        console.log(`connection check: ${r.ok ? 'OK' : 'FAILED'}: ${r.reason}`);
        process.exit(r.ok ? 0 : 1);
    }
})();
//# sourceMappingURL=diagnoseHistory.js.map