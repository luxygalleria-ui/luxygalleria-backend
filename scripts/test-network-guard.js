/**
 * Preloaded into every test process by scripts/run-tests.js: a socket may connect only to this machine (127.0.0.1,
 * ::1, localhost, its own interface addresses) or a local pipe. Anything else (ICICI, Razorpay, SendGrid, Cloudinary, Google, MongoDB Atlas) fails
 * with an error instead of leaving the machine, so a missed mock can never reach a paid or production service.
 */
const net = require('net');
const os = require('os');

// This machine's own interface addresses count as local (a test may check a server is NOT reachable on the LAN IP)
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '::ffff:127.0.0.1',
  ...Object.values(os.networkInterfaces()).flat().map((i) => i.address.toLowerCase())]);
const original = net.Socket.prototype.connect;

net.Socket.prototype.connect = function guardedConnect(...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0]; // net.connect passes pre-normalised arguments
  let host;
  if (first && typeof first === 'object') {
    if (first.path) return original.apply(this, args);
    host = first.host || 'localhost';
  } else if (typeof first === 'string' && Number.isNaN(Number(first))) {
    return original.apply(this, args); // a pipe path
  } else {
    host = typeof args[1] === 'string' ? args[1] : 'localhost';
  }
  if (LOOPBACK.has(String(host).toLowerCase().replace(/^\[|\]$/g, ''))) return original.apply(this, args);
  const err = Object.assign(new Error(`test network guard: blocked outbound connection to ${host}`), { code: 'ETESTNETWORKBLOCKED' });
  process.nextTick(() => this.destroy(err));
  return this;
};
