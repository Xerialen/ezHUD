// core/fte-adapter.js — the FTE-web engine client. Sibling of bridge.js.
//
// Same interface as core/bridge.js, different transport: instead of HTTP to a
// loopback bridge in ezQuake, this talks to an FTE engine running as wasm in
// the same page. Commands go through window.FTEC.cbufadd (the channel
// hub.quakeworld.nu uses); state comes from the ezhud plugin's
// EZHud_StateJSON() export, read synchronously per call.
//
// The host page (index-fte.html) maps the '../core/bridge.js' import to this
// file with an import map, so view/app.js is byte-identical to the ezQuake
// build. No DOM access beyond the engine's own canvas, which is this backend's
// "framebuffer" the same way /frame.png is the ezQuake bridge's.

export class BridgeError extends Error {
	constructor(message, { status = 0 } = {}) {
		super(message);
		this.name = 'BridgeError';
		this.status = status;
	}

	static from(err) {
		return err instanceof BridgeError ? err : new BridgeError(String(err));
	}
}

// The classic Quake palette. The ezQuake bridge asks the engine because a pak
// can replace it; FTE offers no such export yet, so this is the id1 palette
// and a known, reported drift when a custom pak changes colours.
// Generated from id1/pak0.pak gfx/palette.lmp.
import { QUAKE_PALETTE } from './quake-palette.js';

// Commands the editor is allowed to send, mirroring the ezQuake bridge's
// allowlist (docs/PROTOCOL.md). The engine is local to the page, so this is
// not a security boundary the way it is over HTTP — it is a correctness one:
// the same refusals produce the same editor behaviour on both backends.
const BARE_COMMANDS = new Set([
	'hud_recalculate', 'vid_restart', 'cfg_save', 'move', 'align', 'place',
	'toggleconsole', 'fontload', 'hud_export', 'hud_reset_layout',
]);
const PREFIXES = ['hud_', 'vid_', 'scr_', 'cl_hud', 'font_', 'r_tracker'];
// Exact cvar names outside those prefixes the editor legitimately writes:
// the killfeed pair and the classic bar's shape, mirroring hud_web.c's
// allowlist so the two backends accept the same things.
const EXACT_CVARS = new Set([
	'gl_consolefont', 'gl_font', 'con_fragmessages', 'cl_useimagesinfraglog',
	'cl_sbar', 'viewsize',
	// The page's own demo-sound knob (#10). Exact on purpose — no prefix, so
	// `volumefoo` stays refused — and deliberately absent from the ledger and
	// every export path: it is editor chrome, not HUD state, and a saved
	// config must never grow a volume line the user did not write.
	'volume',
]);

// Cvars the FTE plugin ignores but the editor edits anyway. The adapter keeps
// their last written value in a ledger so state() can synthesize the
// hud_modes and killfeed blocks the plugin's export lacks -- honestly flagged
// `synthetic`, because the preview pixels will not follow them.
// Seeds are ezQuake's registered defaults; scr_newhud is re-seeded from
// boot.js's own launch arguments (it forces +scr_newhud 1 for the preview),
// so the HUD-system switch never claims "Classic" while the page drew the new
// HUD.
const LEDGER_SEED = [
	['scr_newhud', '0'], ['cl_sbar', '0'], ['viewsize', '100'],
	['cl_hud', '1'], ['scr_compacthud', '0'],
	['r_tracker', '1'], ['con_fragmessages', '1'], ['cl_useimagesinfraglog', '0'],
	['r_tracker_inconsole', '0'], ['r_tracker_time', '4'], ['r_tracker_messages', '20'],
	['r_tracker_frags', '1'], ['r_tracker_streaks', '0'], ['r_tracker_flags', '0'],
	['r_tracker_pickups', '0'], ['r_tracker_scale', '1'], ['r_tracker_align_right', '1'],
];
const KILLFEED_CVARS = [
	'r_tracker', 'con_fragmessages', 'cl_useimagesinfraglog', 'r_tracker_inconsole',
	'r_tracker_time', 'r_tracker_messages', 'r_tracker_frags', 'r_tracker_streaks',
	'r_tracker_flags', 'r_tracker_pickups', 'r_tracker_scale', 'r_tracker_align_right',
];

// Value-transforming dialect translation for the killfeed, keyed by the
// ezQuake cvar name send() just wrote. Each entry returns the FTE-dialect
// writes (name/value pairs) that make the vanilla FTE tracker (verified
// against fte-team/fteqw@f937b9d engine/client/fragstats.c) do the same
// thing, so the preview follows an inspector edit or an imported line
// exactly the way it follows a native FTE cvar.
//
// IMPORTANT COLLISION: ezQuake's own `r_tracker_frags` (in KILLFEED_CVARS
// above, the "show frags" content toggle -- see renderKillfeed's
// toggle('Show frags', 'r_tracker_frags') in view/app.js) is a *different
// cvar that happens to share a name* with FTE's `r_tracker_frags`
// (fragstats.c:83, the tracker's 0/1/2 mode switch that `r_tracker`
// translates to). Writing the FTE side must never touch the ledger entry
// for the ezQuake cvar of the same name -- see #emitTranslation(), which
// writes straight to cbufadd and deliberately skips #recordWrite.
const TRACKER_TRANSLATE = new Map([
	// ezQuake: 0/1 on/off. FTE: 0 = vanilla obituaries only, 2 = all kills in
	// the tracker (fragstats.c:83). ezQuake's "on" means "show everyone's
	// kills", i.e. FTE's 2, not its unused middle value 1.
	['r_tracker', (value) => [['r_tracker_frags', Number(value) ? '2' : '0']]],
	// Identical name and unit (seconds, fragstats.c:84) in both dialects, so
	// there is nothing to transform today -- but FTE also has
	// r_tracker_fadetime (fragstats.c:85, how long a line takes to fully fade
	// once fading starts) with no ezQuake equivalent yet. Kept as a mapping
	// entry (that emits nothing) so a future fadetime pairing has exactly one
	// place to add it, per the issue's phase 1 notes.
	['r_tracker_time', () => []],
	// FTE's cvar is named r_tracker_lines; fragstats.c:89 registers
	// "r_tracker_messages" only as CVARAFCD's alt-name for its own console
	// alias resolution, which this wasm build's ezhud plugin does not expose
	// to the JS side -- write the primary name explicitly rather than assume
	// the alias resolves through the embind boundary.
	['r_tracker_messages', (value) => [['r_tracker_lines', String(value)]]],
]);

// ezQuake-dialect cvars whose raw write must never reach cbufadd, because
// FTE registers a cvar under the identical name with different semantics.
// Audited against fragstats.c's full registration list (Cvar_Register calls,
// fragstats.c:632-638: r_tracker_frags, r_tracker_time, r_tracker_fadetime,
// r_tracker_x/y/w, r_tracker_lines) versus every entry in KILLFEED_CVARS
// above:
//   - r_tracker_frags: collision (see TRACKER_TRANSLATE's comment) -> here.
//   - r_tracker_time: same name, same unit (seconds) -> safe to forward.
//   - everything else in KILLFEED_CVARS (con_fragmessages,
//     cl_useimagesinfraglog, r_tracker_inconsole, r_tracker_messages,
//     r_tracker_streaks, r_tracker_flags, r_tracker_pickups, r_tracker_scale,
//     r_tracker_align_right) has no FTE registration at all -> forwarding
//     just creates an inert cvar FTE never reads, which is harmless.
// The value still reaches the ledger (#recordWrite runs first in send()), so
// export and the synthetic killfeed block stay honest; only the engine write
// that would otherwise stomp FTE's real tracker-mode cvar is skipped.
const SUPPRESS_RAW = new Set(['r_tracker_frags']);

function formatCvarLine(name, value) {
	const text = String(value);
	return /\s/.test(text) || text === '' ? `${name} "${text}"` : `${name} ${text}`;
}

// Wire format for cbufadd. FTE's bare `<cvar> <value>` goes through
// Cvar_Command (engine/common/cvar.c), which only recognises already-
// registered cvars -- an unregistered name (scr_newhud, cl_sbar,
// con_fragmessages, cl_useimagesinfraglog, and most of the ezQuake-dialect
// r_tracker_* names, none of which FTE registers) falls through to
// Cmd_ExecuteString's "Unknown command" print into the notify area, spammed
// over the live demo every time the editor touches one. `set` (and `seta`)
// are registered explicitly for this (engine/common/cmd.c:4466 — "Changes
// the current value of the named cvar, creating it if it doesn't yet
// exist") -- an unknown name is created silently, a known one is assigned
// exactly like the bare form. So every cvar write here goes out prefixed
// `set `, and only the genuine commands in BARE_COMMANDS (which `set` does
// not apply to at all) stay bare. Allowlist checks and ledger parsing all
// read the unprefixed line -- this only changes what reaches the wire.
function wireLine(line) {
	const text = String(line);
	const name = text.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
	return BARE_COMMANDS.has(name) ? text : `set ${text}`;
}

// Parses "<cvar> <value>" / "<cvar> \"value\"" the same way #recordWrite does,
// shared so translation reads exactly what was just sent.
function parseAssignment(line) {
	const m = /^(\S+)\s+(?:"([^"]*)"|(.*?))\s*$/.exec(String(line).trim());
	if (!m) {
		return null;
	}
	return { name: m[1].toLowerCase(), value: m[2] !== undefined ? m[2] : m[3] };
}

function commandAllowed(line) {
	if (/[;\r\n$]/.test(line)) {
		return false;
	}
	const name = line.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
	if (!name) {
		return false;
	}
	if (name.startsWith('hud_web')) {
		return false;
	}
	// gl_font is FTE's spelling of gl_consolefont — same file convention
	// (textures/charsets/<name>.png), different cvar. The import pipeline
	// translates one into the other; both go through this gate.
	if (BARE_COMMANDS.has(name) || EXACT_CVARS.has(name)) {
		return true;
	}
	return PREFIXES.some((p) => name.startsWith(p));
}

// The host page's own chrome (demo picker, config import) has to act on the
// same Bridge app.js is polling: retainedLines, importedName and defaults all
// live on the instance, and app.js keeps the one it built module-private.
// fromLocation() is the single place app.js constructs one, so record it there
// and let the chrome ask. Both sides resolve to this module — the import map
// points '/core/bridge.js' at this file, so the specifier does not matter.
let current = null;

/** The Bridge app.js is using, or null before app.js has started. */
export function currentBridge() {
	return current;
}

export class Bridge {
	// `engine` lets tests inject a fake; the page passes nothing and the real
	// Module/FTEC globals are picked up lazily (they appear only after the wasm
	// runtime has started).
	constructor({ engine = null } = {}) {
		this.engine = engine;
		// Exported .cfg files, so /configs can list what was already saved and
		// the save dialog's overwrite warning stays meaningful.
		this.exported = [];
		// Set by the import pipeline: lines from the user's config the parser
		// kept verbatim, written back on export for the lossless round-trip.
		this.retainedLines = [];
		this.importedName = null;
		// Last state handed out, so the exporter can read current cvar values
		// without a second engine call.
		this.lastState = null;
		// Pre-import cvar snapshot, set by captureDefaults(). Null means "we
		// never took one", which exportFullCfg() treats as "append nothing":
		// without a baseline every cvar looks changed.
		this.defaults = null;
		// Last written value of every cvar the plugin ignores but the editor
		// edits (see LEDGER_SEED). send() records writes into it; state() reads
		// it back out as the synthetic hud_modes/killfeed blocks.
		this.ledger = new Map(LEDGER_SEED);
		this.seededFromBoot = false;
	}

	static fromLocation() {
		current = new Bridge({});
		return current;
	}

	get configured() {
		return true;
	}

	#module() {
		return this.engine?.module ?? globalThis.Module ?? null;
	}

	#ftec() {
		return this.engine?.ftec ?? globalThis.FTEC ?? null;
	}

	/** True once the wasm runtime has both the state export and the command channel. */
	ready() {
		const m = this.#module();
		return Boolean(m && m._EZHud_StateJSON && this.#ftec());
	}

	// boot.js launches the engine with +cvar value pairs (notably +scr_newhud 1
	// for the preview), which the ledger's ezQuake-default seeds would
	// contradict. Read the actual launch arguments once, so the HUD-system
	// switch starts on what the page really booted with — never a lie.
	#seedFromBoot() {
		if (this.seededFromBoot) {
			return;
		}
		const args = this.#module()?.arguments;
		if (!Array.isArray(args)) {
			return;
		}
		this.seededFromBoot = true;
		for (let i = 0; i < args.length; i++) {
			const token = String(args[i]);
			// '+set <name> <value>' triad -- boot.js uses this for cvars FTE does
			// not register natively (scr_newhud), per wireLine()'s comment above:
			// a bare '+scr_newhud 1' would print "Unknown command" before the
			// editor ever gets a state to read.
			if (token === '+set' && i + 2 < args.length) {
				const name = String(args[i + 1]);
				if (this.ledger.has(name)) {
					this.ledger.set(name, String(args[i + 2]));
				}
				i += 2;
				continue;
			}
			// '+<name> <value>' pair, for cvars FTE registers natively
			// (+plug_sbar, +volume).
			if (token.startsWith('+') && i + 1 < args.length) {
				const name = token.slice(1);
				if (this.ledger.has(name)) {
					this.ledger.set(name, String(args[i + 1]));
				}
				i += 1;
			}
		}
	}

	// If `line` assigns a ledger-tracked cvar, remember the value. This is what
	// stands in for the engine reporting it back: the plugin ignores the cvar,
	// so without the ledger the next state() would quietly undo the control.
	#recordWrite(line) {
		// Boot's seed first, or an edit made before the first poll would be
		// clobbered when state() applies the launch arguments over it.
		this.#seedFromBoot();
		const parsed = parseAssignment(line);
		if (!parsed) {
			return;
		}
		if (this.ledger.has(parsed.name)) {
			this.ledger.set(parsed.name, parsed.value);
		}
	}

	// Writes the FTE-dialect side of a killfeed cvar straight to cbufadd,
	// deliberately bypassing #recordWrite: the ledger holds ezQuake-dialect
	// values keyed by ezQuake names, and (per TRACKER_TRANSLATE's collision
	// note above) an FTE-dialect name can be identical to an unrelated
	// ezQuake cvar's name. Recording this write into the ledger would
	// silently overwrite that ezQuake cvar's value and corrupt every export
	// from here on -- exactly the dishonesty the ledger exists to prevent.
	#emitTranslation(line) {
		const parsed = parseAssignment(line);
		const translate = parsed && TRACKER_TRANSLATE.get(parsed.name);
		if (!translate) {
			return;
		}
		const ftec = this.#ftec();
		if (!ftec) {
			return; // send() already required this for the primary write
		}
		for (const [name, value] of translate(parsed.value)) {
			const translated = formatCvarLine(name, value);
			if (commandAllowed(translated)) {
				ftec.cbufadd(wireLine(translated) + '\n');
			}
		}
	}

	// Same field names and derivations as hud_web_state.c's hud_modes emission,
	// so the model cannot tell the backends apart -- except for `synthetic`,
	// which is the flag the view keys its honesty note on.
	#syntheticModes() {
		const n = (name) => Number(this.ledger.get(name)) || 0;
		const newhud = n('scr_newhud');
		return {
			scr_newhud: newhud,
			cl_hud: n('cl_hud'),
			cl_sbar: n('cl_sbar'),
			viewsize: n('viewsize'),
			scr_compacthud: n('scr_compacthud'),
			classic_drawn: newhud !== 1,
			new_drawn: newhud !== 0,
			standard_bar: Boolean(n('cl_sbar')) || n('viewsize') < 100,
			synthetic: true,
		};
	}

	#syntheticKillfeed() {
		const out = { synthetic: true };
		for (const name of KILLFEED_CVARS) {
			out[name] = this.ledger.get(name);
		}
		return out;
	}

	// Thrown with status 0 rather than 403 on purpose: model.applyError maps
	// anything but 403 to Status.LOST, and app.js only stops polling on DENIED
	// (app.js:40), so the poll started by the first refresh keeps running and
	// the first state after the engine comes up is applied normally.
	async state() {
		const m = this.#module();
		if (!this.ready()) {
			throw new BridgeError('FTE is still starting');
		}
		const ptr = m._EZHud_StateJSON();
		const text = m.UTF8ToString(ptr);
		let state;
		try {
			state = JSON.parse(text);
		} catch (cause) {
			throw new BridgeError('EZHud_StateJSON returned malformed JSON', { cause });
		}
		// `physical` is the size of the picture the rects map onto. For the
		// ezQuake bridge that is the framebuffer /frame.png captures; here it is
		// the engine's canvas backing store, read from the same object the
		// overlay is drawn over so the two can never disagree.
		const canvas = m.canvas
			?? (typeof document === 'undefined' ? null : document.getElementById('canvas'));
		state.physical = [canvas?.width ?? 0, canvas?.height ?? 0];
		// The plugin's export has no hud_modes and no killfeed cvars. Synthesize
		// both from the ledger so the panels render on this backend too; the
		// `synthetic` flags keep the view honest about pixels not following.
		this.#seedFromBoot();
		state.hud_modes = this.#syntheticModes();
		state.killfeed = this.#syntheticKillfeed();
		this.lastState = state;
		return state;
	}

	// FTE has its own font system (a known parity gap the drift report names);
	// there is no face to load, so the panel truthfully reports none.
	async fonts() {
		return {
			protocol: 1,
			directory: '(FTE renders its own fonts — a known preview difference)',
			facepath: '',
			proportional_loaded: false,
			consolefont: '',
			available: [],
		};
	}

	async configs() {
		return {
			protocol: 1,
			config_dir: 'your browser’s downloads',
			export_dir: 'your browser’s downloads',
			main: this.importedName ?? 'config.cfg',
			backup_enabled: false,
			available: [...this.exported],
			exports: [...this.exported],
		};
	}

	async palette() {
		return { protocol: 1, colors: QUAKE_PALETTE };
	}

	// Saving on this backend is a download, not an engine write: the export
	// target is ezQuake, and the only file that ever touches disk is this one.
	async save({ name, hudOnly = false }) {
		const text = hudOnly ? this.exportHudCfg() : this.exportFullCfg();
		const blob = new Blob([text], { type: 'text/plain' });
		const a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = name;
		a.click();
		URL.revokeObjectURL(a.href);
		if (!this.exported.includes(name)) {
			this.exported.push(name);
		}
		return { ok: true };
	}

	async backupEnabled() {
		return false;
	}

	loadFace(name) {
		return this.send(`fontload ${name || 'none'}`);
	}

	// No frame capture on this backend: the live canvas sits behind the
	// overlay. app.js still polls an <img>, so hand it a transparent pixel —
	// its 'load' fires, frameReady goes true, and the stage shows the canvas.
	frameUrl() {
		return 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
	}

	async send(command) {
		const ftec = this.#ftec();
		if (!ftec) {
			throw new BridgeError('FTE is still starting');
		}
		const line = String(command);
		if (!commandAllowed(line)) {
			throw new BridgeError('command not permitted', { status: 403 });
		}
		this.#recordWrite(line);
		// SUPPRESS_RAW: the ledger write above already made this value honest for
		// export/synthetic state; forwarding it here as well would hand FTE's
		// real, differently-meaning cvar of the same name a value it was never
		// meant to receive (see SUPPRESS_RAW's comment for the audit).
		const parsedForSuppress = parseAssignment(line);
		if (!parsedForSuppress || !SUPPRESS_RAW.has(parsedForSuppress.name)) {
			ftec.cbufadd(wireLine(line) + '\n');
		}
		// Value-transforming killfeed translation, on every write regardless of
		// origin (inspector or import.js's importCfg, since both call send()/
		// setCvar() -- see fte-adapter.js's module comment and TRACKER_TRANSLATE
		// above). Export is untouched: #emitTranslation never records into the
		// ledger, and cvarSnapshot() only ever reads the ledger and the plugin's
		// own state.
		this.#emitTranslation(line);
		return { ok: true };
	}

	setCvar(name, value) {
		return this.send(formatCvarLine(name, value));
	}

	// ---- export -------------------------------------------------------------
	// The deliverable is an ezQuake config. Values come from the engine's own
	// cvars via the last state; lines the importer could not apply are written
	// back verbatim, which is what makes import → edit → export lossless.

	/**
	 * Current value of every hud cvar the engine reports, including the
	 * placement fields that live on hud_t rather than in params.
	 * @returns {Map<string, string>} cvar name -> value, as strings.
	 */
	cvarSnapshot() {
		const out = new Map();
		for (const e of this.lastState?.elements ?? []) {
			for (const [cvar, value] of Object.entries(e.cvars ?? {})) {
				out.set(cvar, String(value));
			}
			out.set(`hud_${e.name}_show`, e.shown ? '1' : '0');
			out.set(`hud_${e.name}_place`, String(e.place ?? 'screen'));
			out.set(`hud_${e.name}_align_x`, String(e.align_x ?? 'left'));
			out.set(`hud_${e.name}_align_y`, String(e.align_y ?? 'top'));
			out.set(`hud_${e.name}_pos_x`, String(e.pos_x ?? 0));
			out.set(`hud_${e.name}_pos_y`, String(e.pos_y ?? 0));
			out.set(`hud_${e.name}_order`, String(e.order ?? 0));
		}
		// The ledger too: these cvars never appear in the plugin's state, and
		// without them here an editor-set scr_newhud or r_tracker would vanish
		// from the export — the exact dishonesty the ledger exists to prevent.
		for (const [cvar, value] of this.ledger) {
			out.set(cvar, String(value));
		}
		return out;
	}

	/** Just the hud cvars, sorted, the way ezQuake's `hud_export` writes them. */
	exportHudCfg() {
		const lines = ['// HUD exported by ez-hud (FTE-web preview backend)', ''];
		// hud_ only, matching ezQuake's hud_export: the ledger's scr_/r_tracker
		// entries belong to a full config, not a HUD overlay.
		const snapshot = [...this.cvarSnapshot()]
			.filter(([cvar]) => cvar.startsWith('hud_'))
			.sort(([a], [b]) => a.localeCompare(b));
		for (const [cvar, value] of snapshot) {
			lines.push(`${cvar} "${value}"`);
		}
		return lines.join('\n') + '\n';
	}

	/**
	 * The imported config, with every line the importer applied rewritten to
	 * the current engine value and everything else byte-identical.
	 * @returns {string} the whole file, newline-terminated.
	 */
	exportFullCfg() {
		const snapshot = this.cvarSnapshot();
		const written = new Set();
		const out = [];
		for (const entry of this.retainedLines) {
			if (entry.applied && snapshot.has(entry.cvar)) {
				written.add(entry.cvar);
				// Rewrite only what actually changed. An applied line whose value
				// the engine still holds is the user's own line, column-aligned
				// however they aligned it — regenerating it as `cvar "value"`
				// churned 481 lines of a real config for zero information.
				// String first (the engine stores set values verbatim), numeric
				// second ("1.0" and "1" are the same cvar to both engines).
				const now = snapshot.get(entry.cvar);
				const same = now === entry.value
					|| (entry.value !== null && Number(now) === Number(entry.value)
						&& now.trim() !== '' && String(entry.value).trim() !== '');
				out.push(same ? entry.raw : `${entry.cvar} "${now}"`);
			} else {
				out.push(entry.raw);
			}
		}
		// Cvars the user changed in the editor that the imported file never
		// mentioned. Without this an edit to an element absent from the config
		// would survive the session and vanish from the export.
		//
		// With no defaults snapshot there is nothing to compare against, and
		// "differs from the default" would be true of every cvar the engine
		// reports -- appending all of them would bury the user's config in a
		// few hundred lines it never asked for. Append nothing instead: what
		// the file already said is still written back, only the editor's own
		// additions are lost, and captureDefaults() is one call away.
		//
		// A cvar missing from `defaults` is an addition too: get() returns
		// undefined, which no snapshot value can equal.
		const additions = !this.defaults ? [] : [...snapshot]
			.filter(([cvar, value]) => !written.has(cvar) && this.defaults.get(cvar) !== value)
			.sort(([a], [b]) => a.localeCompare(b));
		if (additions.length) {
			out.push('', '// added in ez-hud');
			for (const [cvar, value] of additions) {
				out.push(`${cvar} "${value}"`);
			}
		}
		return out.join('\n') + '\n';
	}

	// Snapshot taken before any user config is applied, so the export can tell
	// "changed in the editor" from "engine default".
	captureDefaults() {
		this.defaults = this.cvarSnapshot();
	}
}
