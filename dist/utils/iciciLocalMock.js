"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.localMock = void 0;
const child_process_1 = require("child_process");
const path_1 = __importDefault(require("path"));
/**
 * Local development only: when checkout finds the loopback ICICI mock not running (plain `npm run dev`), start
 * scripts/icici-local-mock.js once (it refuses real keys and binds 127.0.0.1 only) and wait for it to answer.
 * Off outside NODE_ENV=development, or with ICICI_LOCAL_MOCK_AUTOSTART=false. Resolves true once the mock answers.
 */
let child = null;
let starting = null;
const answers = async (port) => {
    try {
        return (await fetch(`http://127.0.0.1:${port}/__stats`, { signal: AbortSignal.timeout(1000) })).ok;
    }
    catch {
        return false;
    }
};
const start = (apiUrl) => {
    if (process.env.NODE_ENV !== 'development' || process.env.ICICI_LOCAL_MOCK_AUTOSTART === 'false')
        return Promise.resolve(false);
    if (starting)
        return starting;
    starting = (async () => {
        const port = new URL(apiUrl).port || '80';
        if (await answers(port))
            return true;
        const script = path_1.default.resolve(__dirname, '../../scripts/icici-local-mock.js');
        console.warn(`ICICI local mock not running on :${port}: starting ${path_1.default.relative(process.cwd(), script)} (development only)`);
        const c = (0, child_process_1.spawn)(process.execPath, [script], { stdio: 'inherit', env: { ...process.env, MOCK_ICICI_API_PORT: port, MOCK_BACKEND_PORT: String(process.env.PORT || 5000) } });
        child = c;
        c.on('exit', () => { if (child === c) {
            child = null;
            starting = null;
        } });
        const until = Date.now() + 15_000;
        while (Date.now() < until) {
            if (c.exitCode !== null)
                return false; // the mock refused its config (it prints why)
            if (await answers(port))
                return true;
            await new Promise((r) => setTimeout(r, 300));
        }
        c.kill();
        return false;
    })().then((ok) => { if (!ok)
        starting = null; return ok; });
    return starting;
};
process.on('exit', () => { child?.kill(); });
/** An object so tests can replace start without spawning anything. */
exports.localMock = { start };
//# sourceMappingURL=iciciLocalMock.js.map