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
const PREFIXES = ['hud_', 'vid_', 'scr_', 'cl_hud', 'font_'];

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
	if (BARE_COMMANDS.has(name) || name === 'gl_consolefont') {
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
		ftec.cbufadd(line + '\n');
		return { ok: true };
	}

	setCvar(name, value) {
		const text = String(value);
		return this.send(/\s/.test(text) || text === '' ? `${name} "${text}"` : `${name} ${text}`);
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
		return out;
	}

	/** Just the hud cvars, sorted, the way ezQuake's `hud_export` writes them. */
	exportHudCfg() {
		const lines = ['// HUD exported by ez-hud (FTE-web preview backend)', ''];
		const snapshot = [...this.cvarSnapshot()].sort(([a], [b]) => a.localeCompare(b));
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
