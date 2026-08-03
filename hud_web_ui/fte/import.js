// fte/import.js — what happens when a file lands on the stage.
//
// Three kinds of file, three completely different mechanisms:
//
//   .cfg              parsed here, line by line, and applied cvar by cvar
//                     through the adapter. Never exec'd: `exec` is off the
//                     allowlist on both backends (docs/PROTOCOL.md), and a
//                     config is a script -- it can bind, alias, and connect.
//   .pak/.pk3/.zip    written to the Cache API and the page reloaded.
//   .mvd              same, plus the name is remembered so boot replays it.
//
// The reload is not laziness. engine/web/prejs.js reads the 'user' cache into
// the engine's file layer exactly once, in preRun, and nothing re-reads it
// afterwards; the buffer-creating export it uses is module-private, so a page
// cannot push bytes into a running engine at all. Writing the cache and then
// sending `playdemo` would find nothing there. See spikes/fte-web/NOTES.md.

const CACHE_NAME = 'user';
const CACHE_PREFIX = '/_/';

// Cvars this pipeline will *apply*. Everything else in the file is kept
// verbatim and left alone -- see the module comment: we are reading someone's
// whole ezQuake config, most of which has nothing to do with the HUD and some
// of which would be actively rude to run.
const APPLY_EXACT = new Set([
	'scr_newhud', 'cl_sbar', 'viewsize',
	// The killfeed set. Every write here goes through bridge.setCvar(), which
	// is core/fte-adapter.js's send() -- so core/fte-adapter.js's
	// TRACKER_TRANSLATE table (on/off, timing, line count) fires for imports
	// exactly as it does for inspector edits, with no extra plumbing needed
	// here. The adapter's ledger still tracks the ezQuake-dialect value of
	// each one, so applying seeds the synthetic killfeed/hud_modes blocks and
	// keeps the export honest. Unknown cvars are simply created on the FTE
	// side, so the engine-side set is harmless. No entry in this file's own
	// TRANSLATE map: that one is name-only and unsuited to a value
	// transformation like r_tracker's 0/1 -> r_tracker_frags 0/2.
	'r_tracker', 'con_fragmessages', 'cl_useimagesinfraglog', 'r_tracker_inconsole',
	'r_tracker_time', 'r_tracker_messages', 'r_tracker_frags', 'r_tracker_streaks',
	'r_tracker_flags', 'r_tracker_pickups', 'r_tracker_scale', 'r_tracker_align_right',
	// The con-size family: it decides what "console pixels" means, so the
	// preview is laid out at the wrong size without it.
	'vid_conwidth', 'vid_conheight', 'vid_conautoscale',
	// The charset. ezQuake resolves it as textures/charsets/<name>.png; FTE
	// does exactly the same — through its own cvar. See TRANSLATE below.
	'gl_consolefont',
]);

// Cvars whose ezQuake spelling has a different FTE name for the same file
// convention. The ezQuake cvar is applied as itself (harmless, keeps the
// export honest) and then again under the FTE name so the preview follows.
// gl_font is how hub.quakeworld.nu's fmf loads charsets (`+set gl_font
// povo5f_xtm` against textures/charsets/povo5f_xtm.png in their assets).
const TRANSLATE = new Map([
	['gl_consolefont', 'gl_font'],
]);

// The placement fields live on hud_t rather than in a params array, so they
// never appear in an element's `cvars` and have to be named here for the
// element/suffix split below.
const PLACEMENT_SUFFIXES = ['show', 'place', 'align_x', 'align_y', 'pos_x', 'pos_y', 'order', 'frame'];

/** True if this pipeline should push the cvar into the engine. */
export function appliable(name) {
	if (!name) {
		return false;
	}
	// The bridge's own settings on the ezQuake side; meaningless here, and
	// excluded in both places so the two backends refuse the same things.
	if (name.startsWith('hud_web')) {
		return false;
	}
	return name.startsWith('hud_') || APPLY_EXACT.has(name);
}

/**
 * One config line as `{cvar, value}`, or null when it is not an assignment.
 * Comments, blanks and bare commands all come back null and are retained.
 */
export function parseCfgLine(raw) {
	const line = String(raw).trim();
	if (!line || line.startsWith('//')) {
		return null;
	}
	const tokens = [];
	const re = /"([^"]*)"|(\S+)/g;
	let m;
	while ((m = re.exec(line)) !== null) {
		if (m[1] !== undefined) {
			tokens.push(m[1]);
			continue;
		}
		if (m[2].startsWith('//')) {
			break; // trailing comment; a `//` inside quotes took the branch above
		}
		tokens.push(m[2]);
	}
	// `set` and `seta` are the same assignment with a different persistence
	// flag, which is not a distinction the preview has anywhere to keep.
	const head = (tokens[0] === 'set' || tokens[0] === 'seta') ? 1 : 0;
	if (tokens.length <= head + 1) {
		return null; // a bare command, not `<cvar> <value>`
	}
	return { cvar: tokens[head].toLowerCase(), value: tokens.slice(head + 1).join(' ') };
}

// `hud_gameclock_big` is hud_ + gameclock + big, and there is no rule that
// says where the element name ends -- so ask the engine, which just told us
// every suffix it actually registers. Longest match wins, or `pos_x` would be
// read as the suffix `x` on an element called `gameclock_pos`.
function suffixesFrom(state) {
	const out = new Set(PLACEMENT_SUFFIXES);
	for (const element of state?.elements ?? []) {
		const head = `hud_${element.name}_`;
		for (const cvar of Object.keys(element.cvars ?? {})) {
			if (cvar.startsWith(head)) {
				out.add(cvar.slice(head.length));
			}
		}
	}
	return out;
}

function splitHudCvar(cvar, suffixes) {
	if (!cvar.startsWith('hud_')) {
		return null;
	}
	const body = cvar.slice(4);
	let best = null;
	for (const suffix of suffixes) {
		if (body.endsWith(`_${suffix}`) && (!best || suffix.length > best.length)) {
			best = suffix;
		}
	}
	return best ? { element: body.slice(0, -(best.length + 1)), suffix: best } : null;
}

// Requirement 5: say what the FTE preview cannot show, rather than letting the
// user find out by exporting a config that quietly lost something.
function driftReport(entries, state, bridge, refused) {
	const registered = new Set((state?.elements ?? []).map((e) => e.name));
	const suffixes = suffixesFrom(state);
	const snapshot = bridge.cvarSnapshot();

	const missing = new Map();     // element name -> cvars naming it
	const unpreviewed = [];        // applied, but the state never reports it back
	const retainedHud = [];        // unapplied hud_* lines, worth naming one by one
	let retained = 0;

	for (const entry of entries) {
		let explained = false;
		if (entry.cvar && entry.cvar.startsWith('hud_')) {
			const split = splitHudCvar(entry.cvar, suffixes);
			if (split && !registered.has(split.element)) {
				if (!missing.has(split.element)) {
					missing.set(split.element, []);
				}
				missing.get(split.element).push(entry.cvar);
				// Absent from the snapshot too, necessarily -- but "FTE does
				// not have this element" already says why, and saying it twice
				// in two lists reads as two separate problems.
				explained = true;
			}
		}
		if (entry.applied) {
			if (!explained && !snapshot.has(entry.cvar)) {
				unpreviewed.push(entry.cvar);
			}
			continue;
		}
		const text = entry.raw.trim();
		if (!text || text.startsWith('//')) {
			continue; // comments and blanks are carried, not "dropped"
		}
		retained++;
		if (entry.cvar && entry.cvar.startsWith('hud_')) {
			retainedHud.push(entry.raw.trim());
		}
	}

	return {
		missingElements: [...missing].map(([name, cvars]) => ({ name, cvars })),
		unpreviewed: [...new Set(unpreviewed)].sort(),
		retained,
		retainedHud,
		refused,
	};
}

// The engine keeps mounting its filesystem for a while after boot, and a
// config applied into that window half-takes: the cvars land, but gl_font
// cannot find the charset file yet and the classic bar's geometry shifts
// every screen-placed element. Measured: the same drop 5 seconds after a
// reload lost the charset and moved health 119px; on a settled engine it
// applied completely. So wait until the engine is actually drawing — that is
// also when app.js reports Live, so the user sees the same readiness.
async function engineLive(bridge, timeoutMs = 15000) {
	const until = Date.now() + timeoutMs;
	for (;;) {
		try {
			const state = await bridge.state();
			if (state.elements?.some((e) => e.rect)) {
				return state;
			}
		} catch { /* still booting */ }
		if (Date.now() > until) {
			return null; // apply anyway; the drift report says what stuck
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
}

/**
 * Parse a config, apply what the preview can show, keep the rest verbatim.
 * @returns {Promise<object>} a report for the host page's drift panel.
 */
export async function importCfg(text, name, bridge) {
	await engineLive(bridge);
	// Defaults have to be pre-import, or every value the file sets looks like
	// an editor change and exportFullCfg appends the lot. cvarSnapshot reads
	// lastState, so there has to be one before we ask.
	await bridge.state();
	bridge.captureDefaults();

	const raw = String(text).split(/\r?\n/);
	// A file ending in a newline splits to a trailing '', which would grow the
	// config by one blank line on every import/export round trip.
	if (raw.length && raw[raw.length - 1] === '') {
		raw.pop();
	}

	const entries = raw.map((line) => {
		const parsed = parseCfgLine(line);
		return { raw: line, cvar: parsed?.cvar ?? null, value: parsed?.value ?? null, applied: false };
	});

	const refused = [];
	const translated = [];
	for (const entry of entries) {
		if (!appliable(entry.cvar)) {
			continue;
		}
		try {
			// Through the adapter, so the same refusals fire as when the user
			// types the value into the inspector.
			await bridge.setCvar(entry.cvar, entry.value);
			entry.applied = true;
		} catch (err) {
			refused.push({ cvar: entry.cvar, reason: err?.message ?? String(err) });
			continue;
		}
		const twin = TRANSLATE.get(entry.cvar);
		if (twin) {
			try {
				await bridge.setCvar(twin, entry.value);
				translated.push({ from: entry.cvar, to: twin, value: entry.value });
			} catch { /* the drift report's unpreviewed list already covers it */ }
		}
	}

	// One recalculate for the whole file, then one refresh: the intermediate
	// layouts are not worth a frame each.
	try {
		await bridge.send('hud_recalculate');
	} catch { /* reported by the state refresh below if it mattered */ }
	const state = await bridge.state();

	// `value` rides along so the exporter can tell "applied and unchanged"
	// (write the user's own line back) from "applied and edited" (rewrite).
	bridge.retainedLines = entries.map(({ raw: line, cvar, value, applied }) => ({ raw: line, cvar, value, applied }));
	bridge.importedName = name;

	const applied = entries.filter((e) => e.applied).length;
	return { kind: 'cfg', name, applied, lines: entries.length, translated, ...driftReport(entries, state, bridge, refused) };
}

// ---- files that have to go through a reload --------------------------------

async function cachePut(path, bytes) {
	const cache = await caches.open(CACHE_NAME);
	await cache.put(CACHE_PREFIX + path, new Response(bytes, {
		// Matching what the engine writes for its own downloads
		// (engine/web/ftejslib.js:1134), so a cache entry looks the same
		// whichever side put it there.
		headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.byteLength) },
	}));
}

function rememberDemo(path) {
	const key = 'ezhud.fte.demos';
	let list = [];
	try {
		list = JSON.parse(window.localStorage.getItem(key) ?? '[]');
	} catch { /* private mode, or someone else's key */ }
	if (!Array.isArray(list)) {
		list = [];
	}
	if (!list.includes(path)) {
		list.push(path);
	}
	try {
		window.localStorage.setItem(key, JSON.stringify(list));
		window.localStorage.setItem('ezhud.fte.demo', path);
	} catch { /* the demo still plays this session; it just will not be the default */ }
}

/** Store a package where the engine's preRun will find it next time. */
export async function importPackage(file) {
	const bytes = await file.arrayBuffer();
	const path = `id1/${file.name}`;
	await cachePut(path, bytes);
	return { kind: 'package', name: file.name, path, needsReload: true };
}

/** Store a demo, make it the one boot plays, and ask for a reload. */
export async function importDemo(file) {
	const bytes = await file.arrayBuffer();
	const path = `qw/demos/${file.name}`;
	await cachePut(path, bytes);
	rememberDemo(path);
	return { kind: 'demo', name: file.name, path, needsReload: true };
}

/** Fetch a demo from a URL and import it. Hub playback is stretch scope. */
export async function importDemoUrl(url) {
	// Any cross-origin host has to send Access-Control-Allow-Origin for this to
	// be readable at all; the findings for hub.quakeworld.nu are in
	// spikes/fte-web/NOTES.md rather than guessed at here.
	const response = await fetch(url, { mode: 'cors' });
	if (!response.ok) {
		throw new Error(`${url} returned ${response.status}`);
	}
	const bytes = await response.arrayBuffer();
	const name = (url.split('/').pop() || 'demo.mvd').split('?')[0];
	const path = `qw/demos/${name}`;
	await cachePut(path, bytes);
	rememberDemo(path);
	return { kind: 'demo', name, path, needsReload: true };
}

/** Dispatch on the file's extension. Unknown types are reported, not guessed at. */
export async function importFile(file, bridge) {
	const lower = file.name.toLowerCase();
	if (lower.endsWith('.cfg')) {
		return importCfg(await file.text(), file.name, bridge);
	}
	if (lower.endsWith('.pak') || lower.endsWith('.pk3') || lower.endsWith('.zip')) {
		return importPackage(file);
	}
	if (lower.endsWith('.mvd') || lower.endsWith('.qwd') || lower.endsWith('.dem')) {
		return importDemo(file);
	}
	return { kind: 'unknown', name: file.name };
}
