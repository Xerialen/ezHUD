// core/log.js — the session log.
//
// One ring buffer for everything the editor does, so a failure can be explained
// from a single dump instead of scattered console output. No DOM access: sinks
// live in view/ (see PRODUCT.md ## Stack); debug gating is decided by the caller
// via setDebug(), because reading location/localStorage is a view/ concern.
//
// Spec: docs/specs/2026-08-04-logging.md.

export const LEVELS = ['error', 'warn', 'info', 'debug'];
export const AREAS = ['bridge', 'model', 'geometry', 'view', 'fte', 'import'];

const CAPACITY = 500;

const entries = [];
let dropped = 0;
let debugEnabled = false;
const sinks = new Set();
let seq = 0;

export function setDebug(on) {
	debugEnabled = Boolean(on);
}

export function debugOn() {
	return debugEnabled;
}

// Sinks receive every entry that passes the debug gate. A sink that throws is
// removed rather than allowed to break logging for everyone else.
export function addSink(fn) {
	sinks.add(fn);
	return () => sinks.delete(fn);
}

export function log(level, area, msg, data) {
	if (level === 'debug' && !debugEnabled) return;
	const entry = {
		seq: ++seq,
		t: Date.now(),
		level,
		area,
		msg,
		...(data !== undefined ? { data } : {}),
	};
	entries.push(entry);
	if (entries.length > CAPACITY) {
		entries.shift();
		dropped++;
	}
	for (const sink of [...sinks]) {
		try {
			sink(entry);
		} catch {
			sinks.delete(sink);
		}
	}
	return entry;
}

export const error = (area, msg, data) => log('error', area, msg, data);
export const warn = (area, msg, data) => log('warn', area, msg, data);
export const info = (area, msg, data) => log('info', area, msg, data);
export const debug = (area, msg, data) => log('debug', area, msg, data);

export function snapshot({ level, area } = {}) {
	const max = level ? LEVELS.indexOf(level) : LEVELS.length - 1;
	return entries.filter(
		(e) => LEVELS.indexOf(e.level) <= max && (!area || e.area === area)
	);
}

// The copy-paste blob. `meta` is whatever the caller knows (protocol, engine
// string, screen dims); `engineLog` is the raw text from GET /log when the
// bridge could fetch it.
export function dump({ meta = {}, engineLog = '' } = {}) {
	const lines = ['=== ezHUD log dump ==='];
	for (const [k, v] of Object.entries(meta)) {
		lines.push(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
	}
	if (dropped) lines.push(`(ring overflow: ${dropped} oldest entries dropped)`);
	lines.push('', '--- ui ---');
	for (const e of entries) {
		const data = 'data' in e ? ` ${safeJson(e.data)}` : '';
		lines.push(`${new Date(e.t).toISOString()} ${e.level} [${e.area}] ${e.msg}${data}`);
	}
	lines.push('', '--- engine ---');
	lines.push(engineLog || '(unavailable)');
	return lines.join('\n');
}

function safeJson(v) {
	try {
		return JSON.stringify(v);
	} catch {
		return String(v);
	}
}

// Request ids correlate a UI log line with the engine's request line (the
// engine echoes X-HUD-Req). Monotonic + random page suffix so two editor tabs
// don't collide.
const pageId = Math.random().toString(36).slice(2, 6);
let reqSeq = 0;

export function nextReqId() {
	return `${pageId}-${++reqSeq}`;
}

// Test-only: reset module state between cases.
export function _reset() {
	entries.length = 0;
	dropped = 0;
	seq = 0;
	reqSeq = 0;
	debugEnabled = false;
	sinks.clear();
}
