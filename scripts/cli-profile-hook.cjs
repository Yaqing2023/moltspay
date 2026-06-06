/**
 * alipay-bot CLI profiling preload hook  (observe-only, zero behavior change).
 *
 * Injected into a single `alipay-bot <step>` spawn via
 *   NODE_OPTIONS=--require=<abs path to this file>
 *   MOLTSPAY_CLI_PROFILE_OUT=<abs jsonl path>
 * (runCli sets both, gated by MOLTSPAY_ALIPAY_CLI_PROFILE; see cli.ts).
 *
 * Goal: decompose the opaque ~40s of `402-buyer-pay` (and ~19s of check-wallet)
 * into three buckets so we can tell what is actually unfixable-from-Node:
 *   A. childSync   — synchronous child_process (the device-fingerprint chain:
 *                    general_external_id.js / ps / system_profiler). Local; in
 *                    principle pre-warmable/cacheable.
 *   B. network     — time sockets spend in-flight waiting for the gateway.
 *                    Truly external (Alipay), the only genuinely uncontrollable
 *                    part.
 *   C. loopStall   — event-loop stalls NOT explained by childSync = native
 *                    risk-control compute (apguard.node / blueshield.node).
 *                    Local; in principle pre-warmable.
 *
 * Design rules: never throw, never alter timing-sensitive behavior, buffer
 * events in memory and flush once on exit (no per-event fs writes that would
 * perturb the very latency we measure).
 */
'use strict';

// Only instrument the MAIN cli.js process. NODE_OPTIONS propagates to the
// fingerprint child node scripts too; in those we return immediately so they
// pay ~0 overhead (their blocking time is already measured from the parent's
// child_process hook).
try {
  const entry = process.argv[1] || '';
  if (!entry.includes('cli.js')) return;
} catch (_) {
  return;
}

const fs = require('fs');
// Per-pid output path. The CLI spawns background workers as `node cli.js
// __internal-*`; they pass the argv[1]~cli.js guard AND inherit this same
// MOLTSPAY_CLI_PROFILE_OUT, so a single shared path gets CLOBBERED by a
// late-exiting worker. Suffixing with pid gives every process its own file;
// the reader picks the one whose `argv` is the real command (402-buyer-pay).
const OUT_BASE = process.env.MOLTSPAY_CLI_PROFILE_OUT;
const OUT = OUT_BASE ? OUT_BASE.replace(/\.json$/, '') + '.pid' + process.pid + '.json' : null;
// The subcommand this process is actually running (e.g. "402-buyer-pay …" vs
// "__internal-log-worker") — lets the reader tell the real command from workers.
const ARGV = process.argv.slice(2).join(' ').slice(0, 200);
const T0 = process.hrtime.bigint();
const now = () => Number(process.hrtime.bigint() - T0) / 1e6; // ms since hook load

const events = [];
const log = (type, data) => {
  try { events.push(Object.assign({ t: +now().toFixed(1), type }, data)); } catch (_) {}
};

// ── B. network ────────────────────────────────────────────────────────────
// Wrap http/https request to time dns+connect+TTFB+download per request.
function wrapHttp(mod, scheme) {
  const orig = mod.request;
  if (typeof orig !== 'function' || orig.__profiled) return;
  mod.request = function (...args) {
    const start = now();
    let host = '?';
    try {
      const o = typeof args[0] === 'string' ? require('url').parse(args[0]) : (args[0] || {});
      host = o.host || o.hostname || '?';
    } catch (_) {}
    let req;
    try { req = orig.apply(this, args); } catch (e) { throw e; }
    try {
      let socketAt = null, firstByteAt = null;
      req.on('socket', (s) => {
        socketAt = now();
        s.on('lookup', () => log('net.lookup', { host, ms: +(now() - start).toFixed(1) }));
        s.on('connect', () => log('net.connect', { host, ms: +(now() - start).toFixed(1) }));
        s.on('secureConnect', () => log('net.tls', { host, ms: +(now() - start).toFixed(1) }));
      });
      req.on('response', (res) => {
        const respAt = now();
        log('net.response', {
          host, scheme, status: res.statusCode,
          ttfb: +(respAt - start).toFixed(1),
          sinceSocket: socketAt == null ? null : +(respAt - socketAt).toFixed(1),
        });
        res.once('data', () => { if (firstByteAt == null) firstByteAt = now(); });
        res.on('end', () => log('net.end', {
          host, scheme, status: res.statusCode,
          total: +(now() - start).toFixed(1),
        }));
      });
      req.on('error', (err) => log('net.error', { host, scheme, ms: +(now() - start).toFixed(1), err: String(err && err.message) }));
    } catch (_) {}
    return req;
  };
  mod.request.__profiled = true;
  // .get delegates to .request internally in Node, so wrapping request covers it,
  // but some versions capture a local ref — re-point .get defensively.
  try {
    const og = mod.get;
    if (typeof og === 'function' && !og.__profiled) {
      mod.get = function (...a) { const r = mod.request(...a); r.end(); return r; };
      mod.get.__profiled = true;
    }
  } catch (_) {}
}
try { wrapHttp(require('http'), 'http'); } catch (_) {}
try { wrapHttp(require('https'), 'https'); } catch (_) {}

// fetch()/undici bypasses http.request entirely — instrument it via the
// diagnostics_channel undici publishes. create→headers = request sent until
// response headers arrive (≈ gateway TTFB); headers→trailers = body download.
try {
  const dc = require('diagnostics_channel');
  const reqStart = new WeakMap();
  const pathOf = (r) => { try { return (r && (r.origin || '') + (r.path || '')).slice(0, 120); } catch (_) { return '?'; } };
  dc.subscribe('undici:request:create', ({ request }) => {
    try { reqStart.set(request, now()); log('fetch.create', { url: pathOf(request) }); } catch (_) {}
  });
  dc.subscribe('undici:request:headers', ({ request, response }) => {
    try {
      const s = reqStart.get(request);
      log('fetch.headers', {
        url: pathOf(request),
        status: response && response.statusCode,
        ttfb: s == null ? null : +(now() - s).toFixed(1),
      });
    } catch (_) {}
  });
  dc.subscribe('undici:request:trailers', ({ request }) => {
    try {
      const s = reqStart.get(request);
      log('fetch.done', { url: pathOf(request), total: s == null ? null : +(now() - s).toFixed(1) });
    } catch (_) {}
  });
  dc.subscribe('undici:request:error', ({ request, error }) => {
    try { log('fetch.error', { url: pathOf(request), err: String(error && error.message) }); } catch (_) {}
  });
} catch (_) {}

// Raw TCP connects not going through http(s) (defensive — catches custom agents).
try {
  const net = require('net');
  const origConnect = net.Socket.prototype.connect;
  if (!origConnect.__profiled) {
    net.Socket.prototype.connect = function (...args) {
      const start = now();
      let desc = '?';
      try {
        const o = args[0];
        if (o && typeof o === 'object') desc = (o.host || o.path || '?') + ':' + (o.port || '');
      } catch (_) {}
      this.once('connect', () => log('tcp.connect', { peer: desc, ms: +(now() - start).toFixed(1) }));
      return origConnect.apply(this, args);
    };
    net.Socket.prototype.connect.__profiled = true;
  }
} catch (_) {}

// ── A. childSync ──────────────────────────────────────────────────────────
// Synchronous child_process calls block the event loop; measure each exactly.
try {
  const cp = require('child_process');
  for (const name of ['execFileSync', 'execSync', 'spawnSync']) {
    const orig = cp[name];
    if (typeof orig !== 'function' || orig.__profiled) continue;
    cp[name] = function (...args) {
      const start = now();
      let cmd = String(args[0] || '');
      try {
        if (name === 'execFileSync' && Array.isArray(args[1])) cmd += ' ' + args[1].slice(0, 3).join(' ');
      } catch (_) {}
      let r, err;
      try { r = orig.apply(this, args); }
      catch (e) { err = e; }
      log('childSync', { name, cmd: cmd.slice(0, 120), ms: +(now() - start).toFixed(1), failed: !!err });
      if (err) throw err;
      return r;
    };
    cp[name].__profiled = true;
  }
  // Async spawns too (e.g. __internal-* workers) — record fire time only.
  for (const name of ['spawn', 'execFile', 'exec', 'fork']) {
    const orig = cp[name];
    if (typeof orig !== 'function' || orig.__profiled) continue;
    cp[name] = function (...args) {
      log('childAsync', { name, cmd: String(args[0] || '').slice(0, 80), at: +now().toFixed(1) });
      return orig.apply(this, args);
    };
    cp[name].__profiled = true;
  }
} catch (_) {}

// ── C. loopStall ──────────────────────────────────────────────────────────
// A 50ms heartbeat: when the loop is blocked (native sync compute or a
// blocking syscall), the timer can't fire and resumes late. drift ≈ block time.
const TICK = 50, THRESH = 120;
let lastTick = now();
const hb = setInterval(() => {
  const t = now();
  const drift = t - lastTick - TICK;
  if (drift > THRESH) log('loopStall', { at: +(lastTick + TICK).toFixed(1), ms: +drift.toFixed(1) });
  lastTick = t;
}, TICK);
if (hb.unref) hb.unref();

// ── flush + summary on exit ────────────────────────────────────────────────
function summarize() {
  const sum = (pred, key) => events.filter(pred).reduce((a, e) => a + (e[key] || 0), 0);
  const wall = +now().toFixed(1);
  const childSync = sum((e) => e.type === 'childSync', 'ms');
  const stallTotal = sum((e) => e.type === 'loopStall', 'ms');
  // stalls overlap childSync (execFileSync blocks the loop too); native compute
  // ≈ stalls beyond what child_process explains.
  const nativeStall = Math.max(0, +(stallTotal - childSync).toFixed(1));
  // network in-flight: fetch()/undici (the CLI's actual path) + any http.request.
  // Sum of per-request total windows (overlap possible; timeline disambiguates).
  const fetchTotal = sum((e) => e.type === 'fetch.done', 'total');
  const httpTotal = sum((e) => e.type === 'net.end', 'total');
  const netTotal = fetchTotal + httpTotal;
  const reqs = events.filter((e) => e.type === 'fetch.create' || e.type === 'net.response').length;
  const isWorker = /__internal/.test(ARGV);
  return {
    argv: ARGV,
    isInternalWorker: isWorker,
    wallMs: wall,
    bucket_A_childSync_ms: +childSync.toFixed(1),
    bucket_B_network_inflight_ms: +netTotal.toFixed(1),
    bucket_C_nativeStall_ms: nativeStall,
    network_requests: reqs,
    fetch_ttfb_ms: +sum((e) => e.type === 'fetch.headers', 'ttfb').toFixed(1),
    loopStall_total_ms: +stallTotal.toFixed(1),
    accounted_ms: +(childSync + netTotal + nativeStall).toFixed(1),
    unaccounted_ms: +(wall - childSync - netTotal - nativeStall).toFixed(1),
  };
}
let flushed = false;
function flush() {
  if (flushed) return; flushed = true;
  try {
    const out = { pid: process.pid, summary: summarize(), events };
    if (OUT) fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
    else process.stderr.write('[cli-profile] ' + JSON.stringify(out.summary) + '\n');
  } catch (_) {}
}
process.on('exit', flush);
process.on('SIGTERM', () => { flush(); process.exit(143); });
process.on('SIGINT', () => { flush(); process.exit(130); });
