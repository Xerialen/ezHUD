// core/model.js — editor state, derived from engine state.
//
// The engine is the source of truth: this never invents geometry, and anything it
// cannot know it reports as unknown rather than guessing.
//
// No DOM access: see PRODUCT.md ## Stack.

export const Status = {
	CONNECTING: 'connecting',
	LIVE: 'live',
	IDLE: 'idle',      // connected, but the engine is drawing no HUD (menu, no demo)
	LOST: 'lost',      // engine went away; recoverable
	DENIED: 'denied',  // token rejected; not recoverable by retrying
};

// The nine screen regions an element can sit in. Anything else in `place` names
// another element, optionally prefixed with '@' to anchor inside its frame
// rather than outside it (hud.c HUD_FindPlace).
// Deliberately ordered by how they are reasoned about, not alphabetically:
// where it sits, then how it aligns there, then the nudge.
const PLACEMENT_ORDER = ['place', 'align_x', 'align_y', 'pos_x', 'pos_y', 'order', 'frame'];
const PLACEMENT_KEYS = new Set(PLACEMENT_ORDER);

// hud.c align_strings_x / align_strings_y
export const ALIGN_X = ['left', 'center', 'right', 'before', 'after'];
export const ALIGN_Y = ['top', 'center', 'bottom', 'before', 'after', 'console'];

export const PLACE_REGIONS = [
	'screen', 'top', 'view', 'sbar', 'ibar', 'hbar', 'sfree', 'ifree', 'hfree',
];

import { quantize } from './geometry.js';

// A scale of zero makes the element vanish with no way back except the inspector,
// so the drag refuses to go there.
const MIN_SCALE = 0.05;
const MAX_SCALE = 20;

// What the cvars should become, given how far the pointer moved in console pixels.
// Pure, so the arithmetic is testable without a browser.
export function resizeTo(control, rect, dw, dh) {
	if (control.mode === 'box') {
		// width/height are not always console pixels. A group passes them straight
		// to HUD_PrepareDraw (hud_groups.c), but speed multiplies by scale first
		// (hud_speed.c:386), so adding console pixels to the cvar would overshoot
		// by exactly that factor. Rather than encode which elements do what, read
		// the transfer ratio off the engine's own rect: drawn pixels per cvar unit,
		// whatever produced it.
		const kx = control.width > 0 && rect.w > 0 ? rect.w / control.width : 1;
		const ky = control.height > 0 && rect.h > 0 ? rect.h / control.height : 1;
		return [
			[control.widthCvar, Math.max(1, quantize(control.width + dw / kx))],
			[control.heightCvar, Math.max(1, quantize(control.height + dh / ky))],
		];
	}
	// Scale is uniform: one number drives both axes. Follow whichever axis the
	// pointer pushed hardest in relative terms, so the corner tracks the gesture
	// instead of averaging it into something that follows neither.
	const fw = rect.w > 0 ? (rect.w + dw) / rect.w : 1;
	const fh = rect.h > 0 ? (rect.h + dh) / rect.h : 1;
	const factor = Math.abs(fw - 1) >= Math.abs(fh - 1) ? fw : fh;
	const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, control.scale * factor));
	return [[control.cvar, Number(next.toFixed(3))]];
}

// Where a resized element lands, using the engine's own placement formula rather
// than an approximation of it: the pinned edge stays put and a centred one keeps
// its middle, truncating on the odd pixel exactly as hud.c:1070 does.
export function resizedRect(rect, anchor, width, height) {
	const x = anchor.x === 'right' ? rect.x + rect.w - width
		: anchor.x === 'center' ? rect.x + quantize((rect.w - width) / 2)
			: rect.x;
	const y = anchor.y === 'bottom' ? rect.y + rect.h - height
		: anchor.y === 'center' ? rect.y + quantize((rect.h - height) / 2)
			: rect.y;
	return { x, y, w: width, h: height };
}

// ezQuake reads a colour cvar by counting its tokens (StringToRGB_W, utils.c:137):
// one number is an index into the 256-colour palette, three are RGB 0-255, four are
// RGBA. So "16" is not dark grey, it is whatever palette slot 16 holds — which a pak
// can change. Getting that backwards silently produces the wrong colour, so the form
// is carried alongside the value rather than guessed at on the way back out.
export const COLOR_NAMES = {
	red: '#ff0000', green: '#00ff00', blue: '#0000ff', black: '#000000',
	yellow: '#ffff00', pink: '#ff00ff', white: '#ffffff',
};

// The engine reads each token with Q_atoi (q_shared.c:35), which is not just a
// decimal parser: it takes an optional sign, then 0x/0X hex, then a 'c' character
// literal, then decimal, and ignores whatever follows. It returns an int which is
// then cast to byte, so it truncates and wraps rather than rounding and clamping.
// "1.9" is 1, "256" is 0, and "0xff" is 255.
function qAtoi(text) {
	const m = /^\s*([+-]?)(.*)$/s.exec(String(text));
	const sign = m[1] === '-' ? -1 : 1;
	const rest = m[2];

	const hex = /^0[xX]([0-9a-fA-F]*)/.exec(rest);
	if (hex) {
		return sign * (hex[1] ? parseInt(hex[1], 16) : 0);
	}
	if (rest[0] === "'") {
		// sign * str[1]: the char's code, or 0 when the quote ends the string.
		return sign * (rest.length > 1 ? rest.charCodeAt(1) : 0);
	}
	const dec = /^\d+/.exec(rest);
	return dec ? sign * parseInt(dec[0], 10) : 0;
}

function qByte(n) {
	return ((n % 256) + 256) % 256;
}

// `allowNames` is false by default on purpose. ColorNameToRGBString is not part of
// StringToRGB_W; it is installed by specific OnChange callbacks, and frame_color is
// the only HUD one (hud.c:924). Everywhere else "red" is not red -- Q_atoi gives 0,
// so it is palette slot 0. Treating names as colours generally would have shown a
// confident red swatch for a value the engine draws as palette 0.
export function parseColor(value, palette = [], { allowNames = false } = {}) {
	const text = String(value ?? '').trim();
	const parts = text.split(/\s+/).filter(Boolean);

	// Empty is not "unset". strtok finds no tokens, so i is 0, which is under 3 and
	// falls into the palette branch against the pre-filled 255 — index 255.
	if (!parts.length) {
		return { form: 'index', index: 255, hex: palette[255] ?? '#000000', alpha: 255,
			valid: palette.length > 0, note: 'Empty reads as palette 255, not as unset.' };
	}
	// ColorNameToRGBString compares with strncmp (utils.c:121), so it is case
	// sensitive: "RED" is not a name, it is Q_atoi("RED") = 0, i.e. palette slot 0.
	if (allowNames && parts.length === 1 && COLOR_NAMES[text]) {
		return { form: 'name', name: text, hex: COLOR_NAMES[text], alpha: 255, valid: true };
	}
	// One token or two: both leave i under 3, so both are a palette index taken from
	// the first number. The second is read and then thrown away.
	if (parts.length <= 2) {
		const index = qByte(qAtoi(parts[0]));
		const note = parts.length === 2
			? 'Two numbers is still just a palette index; the second is ignored.'
			: (!/^\s*[+-]?(0[xX][0-9a-fA-F]|'|\d)/.test(parts[0])
				? `ezQuake reads "${parts[0]}" as 0 here, so this is palette slot 0.`
				: undefined);
		return { form: 'index', index, hex: palette[index] ?? '#000000', alpha: 255,
			valid: palette.length > 0, note };
	}
	// Three or more: RGB, plus alpha if a fourth is present. StringToRGB_W stops
	// after four tokens rather than rejecting the value, so extra tokens are noise
	// and not an error.
	const [r, g, b] = parts.slice(0, 3).map((t) => qByte(qAtoi(t)));
	const hex = `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
	return {
		form: parts.length >= 4 ? 'rgba' : 'rgb',
		hex,
		alpha: parts.length >= 4 ? qByte(qAtoi(parts[3])) : 255,
		valid: true,
		note: parts.length > 4 ? 'Tokens after the fourth are ignored by the engine.' : undefined,
	};
}

// Writes back in the form the user chose. Picking a palette swatch stores the index
// rather than its RGB, because that is what survives a pak changing the palette.
export function formatColor({ form, hex, alpha, index, name }) {
	if (form === 'index') {
		return String(index ?? 0);
	}
	if (form === 'name') {
		return String(name ?? 'white');
	}
	const h = String(hex || '#000000').replace('#', '');
	const rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) || 0);
	return form === 'rgba' ? [...rgb, alpha ?? 255].join(' ') : rgb.join(' ');
}

// Only frame_color runs its value through ColorNameToRGBString (hud.c:924).
export function colorAllowsNames(suffix) {
	return String(suffix ?? '').endsWith('frame_color');
}

// Suffixes ezQuake reads through StringToRGB_W. Matching on the name is what lets
// one rule cover all 83 elements without a table that goes stale.
export function isColorParam(suffix) {
	return /(^|_)colou?r(_|$)/.test(String(suffix ?? ''));
}

// place, align_x and align_y are strings the engine parses into place_num,
// place_hud and the align enums — and it only parses them in HUD_Recalculate
// (hud.c:786). Unlike `order` and `frame_color`, none of the three has an OnChange,
// so writing the cvar alone changes nothing on screen: the old parse stays in
// effect until something calls recalculate. pos_x/pos_y are read at draw time and
// need none of this, which is why nudging always worked and aligning never did.
// ezQuake accepts a size as a bare number or as a percentage of the console
// (hud_radar.c:1307 is the only current user, but the notation is the cvar's).
function percentOrNumber(raw) {
	const text = String(raw ?? '').trim();
	if (text.endsWith('%')) {
		return { percent: true, value: Number(text.slice(0, -1)) || 0 };
	}
	return { percent: false, value: Number(text) || 0 };
}

export function needsRecalculate(cvar) {
	return /_(place|align_x|align_y)$/.test(String(cvar ?? ''));
}

// Which edge the engine pins when an element changes size (hud.c:1063, hud.c:1088).
// left  -> x = area_x                          the left edge stays, it grows right
// right -> x = area_x + area_width - width     the right edge stays, it grows left
// before-> x = area_x - width                  same: the right edge stays
// after -> x = area_x + area_width             same as left
// center-> x = area_x + (area_width - width)/2 it grows both ways, half each side
// An unrecognised name falls back to left/top in the engine (hud.c:333), so it does
// here too rather than guessing something more interesting.
export const ANCHOR_X = {
	left: 'left', after: 'left', right: 'right', before: 'right', center: 'center',
};
export const ANCHOR_Y = {
	top: 'top', after: 'top', bottom: 'bottom', before: 'bottom', center: 'center',
};

// Corners, and which edges each one owns.
export const CORNERS = [
	{ id: 'nw', x: 'west', y: 'north' },
	{ id: 'ne', x: 'east', y: 'north' },
	{ id: 'sw', x: 'west', y: 'south' },
	{ id: 'se', x: 'east', y: 'south' },
];

// Both save commands take the name as a single console token and strip any path
// from it, so anything outside this is either rejected by the engine or quietly
// turned into something else. Refuse it here instead, where we can say why.
const SAFE_NAME = /^[A-Za-z0-9._-]{1,48}$/;

export class Model {
	// Last state serialization, so an unchanged poll can be dropped before it costs
	// a rebuild. Set only in applyState.
	#fingerprint = null;

	// Bumped only when the state actually differs, so a view can ask "is anything
	// I draw from stale?" with one integer compare instead of a deep one.
	version = 0;

	// The engine's 256 colours, fetched once. Empty until then, which every reader
	// has to tolerate rather than assume.
	palette = [];

	constructor() {
		this.status = Status.CONNECTING;
		this.error = null;
		this.state = null;
		this.selected = null;
		this.hovered = null;
		this.filter = '';
		this.showHidden = true;
		this.showSpectator = true;
		this.chromeVisible = true;
		// The render is a separate stream from the state, and can fail on its own.
		// frameReady is tracked rather than inferred from the <img>: it starts life
		// holding a 1x1 placeholder, so naturalWidth is truthy before any real
		// frame has ever arrived.
		this.frameReady = false;
		this.frameError = null;
		this.frameCost = null;
		this.configs = null;
		this.save = {
			open: false,
			name: '',
			hudOnly: false,
			confirmedOverwrite: false,
			busy: false,
			done: null,
			error: null,
		};
		this.listeners = new Set();
	}

	subscribe(fn) {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	#emit() {
		for (const fn of this.listeners) {
			fn(this);
		}
	}

	applyState(state) {
		// The poll asks once a second whether anything moved, and usually nothing
		// has. Emitting anyway costs a full DOM rebuild for an identical answer, so
		// compare first: every field here is derived from the state, which means an
		// identical state is an identical view.
		const fingerprint = JSON.stringify(state);
		if (this.state && fingerprint === this.#fingerprint) {
			return;
		}
		this.#fingerprint = fingerprint;
		this.version++;
		this.state = state;
		this.error = null;
		// A rect IS "the engine laid this out this frame"; the bridge sends null when
		// it did not, and never a guess. There is no separate `drawn` flag to disagree
		// with.
		this.status = state.elements.some((e) => e.rect) ? Status.LIVE : Status.IDLE;
		// A selection can outlive a state refresh; keep it only if it still exists.
		if (this.selected && !state.elements.some((e) => e.name === this.selected)) {
			this.selected = null;
		}
		this.#emit();
	}

	applyError(err) {
		// The next good state must be allowed through even if it is byte-identical
		// to the last one, or the interface stays stuck on the error.
		this.#fingerprint = null;
		this.status = err?.status === 403 ? Status.DENIED : Status.LOST;
		this.error = err;
		this.#emit();
	}

	set(patch) {
		Object.assign(this, patch);
		this.#emit();
	}

	get elements() {
		return this.state?.elements ?? [];
	}

	get screen() {
		return this.state?.screen ?? null;
	}

	get fonts() {
		return this.state?.fonts ?? null;
	}

	// Why does this parameter currently do nothing? Returning the reason beats
	// presenting an inert control as though it were live. Deliberately not
	// per-element: every reason here is a property of the loaded font.
	inertReason(suffix) {
		if (suffix !== 'proportional') {
			return null;
		}
		const f = this.fonts;
		if (f && !f.proportional_loaded) {
			return f.facepath
				? `No proportional font loaded — font_facepath is "${f.facepath}" but it did not load. Renders at 8px.`
				: 'No proportional font loaded — font_facepath is empty. Renders at 8px.';
		}
		// Picture-drawing styles never consult it. Which styles those are is
		// per-element in the engine, so say it may not apply rather than claim
		// precision we cannot derive here.
		return 'Only applies on text styles; picture styles ignore it.';
	}

	get view() {
		return this.state?.view ?? null;
	}

	// ---- saving ------------------------------------------------------------
	// The user asked for three ways to save: a new full config, a HUD-only
	// config, and overwriting an existing one. Those are three outcomes but only
	// two decisions — what to write, and what name to write it under. Overwrite
	// is what happens when that name is already taken, so it is surfaced as a
	// consequence the user has to acknowledge rather than a mode they can pick by
	// accident. All three outcomes remain reachable.

	applyConfigs(configs) {
		this.configs = configs;
		if (!this.save.name) {
			this.save.name = configs?.main?.replace(/\.cfg$/i, '') ?? 'config';
		}
		this.#emit();
	}

	setSave(patch) {
		// Any edit to what or where invalidates a confirmation given for the old
		// target, and clears the last result so it cannot be read as this one's.
		const retargeted = 'name' in patch || 'hudOnly' in patch;
		Object.assign(this.save, patch);
		if (retargeted) {
			this.save.confirmedOverwrite = false;
			this.save.done = null;
			this.save.error = null;
		}
		this.#emit();
	}

	get saveFile() {
		const name = this.save.name.trim();
		return name ? `${name.replace(/\.cfg$/i, '')}.cfg` : '';
	}

	get saveDirectory() {
		if (!this.configs) {
			return '';
		}
		return this.save.hudOnly ? this.configs.export_dir : this.configs.config_dir;
	}

	// Against the listing for the directory this mode actually writes to. The two
	// can differ, so checking the wrong one would either warn about a file that
	// is not in the way or miss one that is.
	get saveListing() {
		if (!this.configs) {
			return [];
		}
		return (this.save.hudOnly ? this.configs.exports : this.configs.available) ?? [];
	}

	get saveOverwrites() {
		const file = this.saveFile.toLowerCase();
		return Boolean(file) && this.saveListing.some((f) => f.toLowerCase() === file);
	}

	get saveNameError() {
		const name = this.save.name.trim();
		if (!name) {
			return 'Give it a name.';
		}
		if (!SAFE_NAME.test(name.replace(/\.cfg$/i, ''))) {
			return 'Letters, digits, dot, dash and underscore only — no spaces or slashes.';
		}
		return null;
	}

	get canSave() {
		return !this.save.busy && !this.saveNameError &&
			(!this.saveOverwrites || this.save.confirmedOverwrite);
	}

	// ---- HUD systems --------------------------------------------------------
	// Not one setting. scr_newhud picks classic / new / both; cl_hud stacks the
	// QW262 HUD on top of either; cl_sbar and viewsize shape the classic bar and
	// are coupled to each other. The editor names all of that rather than
	// presenting five cvars and leaving the user to discover the interactions.

	get modes() {
		return this.state?.hud_modes ?? null;
	}

	// What the current combination actually means, in one sentence. Only this
	// editor is in a position to say it, because only it can see all the axes.
	get modeSummary() {
		const m = this.modes;
		if (!m) {
			return '';
		}
		const parts = [];
		if (m.new_drawn) {
			parts.push('the new HUD');
		}
		if (m.classic_drawn) {
			parts.push(m.viewsize >= 120
				? 'the classic bar (hidden: viewsize is 120)'
				: `the classic bar (${m.standard_bar ? 'standard' : 'heads-up'})`);
		}
		if (m.cl_hud) {
			parts.push('the QW262 overlay');
		}
		if (!parts.length) {
			return 'Nothing is drawing a HUD right now.';
		}
		return `Drawing ${parts.join(' and ')}.`;
	}

	// ---- killfeed -----------------------------------------------------------
	// Where kills are announced is three cvars that read like one setting:
	// r_tracker (the dedicated feed), con_fragmessages (frag lines among normal
	// console messages) and cl_useimagesinfraglog (text obituaries vs weapon
	// icons). Values arrive as the engine's own cvar strings; absence of the
	// whole block means the engine does not expose it, which is different from
	// "everything off" and is why null is returned rather than defaults.

	get killfeed() {
		return this.state?.killfeed ?? null;
	}

	// One sentence for what the current combination does, same spirit as
	// modeSummary: only the editor sees all three cvars at once.
	get killfeedSummary() {
		const k = this.killfeed;
		if (!k) {
			return '';
		}
		const tracker = Number(k.r_tracker) !== 0;
		const inConsole = Number(k.con_fragmessages) !== 0;
		const style = Number(k.cl_useimagesinfraglog) !== 0 ? 'weapon icons' : 'classic text obituaries';
		if (tracker && inConsole) {
			return `Kills go to the dedicated tracker (${style}), and also to the console.`;
		}
		if (tracker) {
			return `Kills go to the dedicated tracker (${style}).`;
		}
		if (inConsole) {
			return `Kills appear only among console messages (${style}).`;
		}
		return 'Kills are announced nowhere — both the tracker and console frag messages are off.';
	}

	// cl_sbar cannot take effect below viewsize 100 (sbar.c:156). Saying so beats
	// offering a control that silently does nothing.
	get sbarInert() {
		const m = this.modes;
		return Boolean(m && m.viewsize < 100 && !m.cl_sbar);
	}

	// ---- resetting ----------------------------------------------------------
	// The engine reports each element's registered defaults, so a reset can name
	// what it would change before doing it.

	static RESET_FIELDS = ['show', 'place', 'align_x', 'align_y', 'pos_x', 'pos_y'];

	#currentFor(element, field) {
		if (field === 'show') {
			return element.shown ? '1' : '0';
		}
		return String(element[field] ?? '');
	}

	// A value counts as changed only if it differs in the way the engine would
	// see it: "0" and "0.0" are the same number, and an unset align really is the
	// engine's own fallback rather than a difference worth reporting.
	static differs(current, fallback) {
		const a = Number(current);
		const b = Number(fallback);
		if (Number.isFinite(a) && Number.isFinite(b)) {
			return a !== b;
		}
		return String(current).toLowerCase() !== String(fallback).toLowerCase();
	}

	get resetChanges() {
		const out = [];
		for (const element of this.elements) {
			const defaults = element.defaults;
			if (!defaults) {
				continue;
			}
			const fields = Model.RESET_FIELDS
				.filter((f) => defaults[f] !== '' && defaults[f] != null)
				.filter((f) => Model.differs(this.#currentFor(element, f), defaults[f]))
				.map((f) => ({ field: f, from: this.#currentFor(element, f), to: defaults[f] }));
			if (fields.length) {
				out.push({ name: element.name, fields });
			}
		}
		return out.sort((a, b) => a.name.localeCompare(b.name));
	}

	// ---- resizing ----------------------------------------------------------

	#params(element) {
		const prefix = `hud_${element.name}_`;
		const out = new Map();
		for (const [name, value] of Object.entries(element.cvars ?? {})) {
			out.set(name.slice(prefix.length), value);
		}
		return out;
	}

	// How this element's size is actually controlled. Every registered element has
	// one or the other; six have both, and there width/height is the box while
	// scale multiplies it — the box is the predictable knob, so it wins.
	sizeControl(element) {
		if (!element) {
			return null;
		}
		const p = this.#params(element);
		if (p.has('width') && p.has('height')) {
			// radar ships width "30%" / height "25%" and resolves them against the
			// console size (hud_radar.c:1307). Number("30%") is NaN, so the old
			// `|| 0` turned a percentage into zero and the first corner drag
			// rewrote it as a small absolute number -- silently destroying a
			// working radar. A percentage is a real size the engine understands;
			// refusing to drag it is right, quietly replacing it is not.
			const width = percentOrNumber(p.get('width'));
			const height = percentOrNumber(p.get('height'));
			if (width.percent || height.percent) {
				return {
					mode: 'relative',
					reason: 'Sized as a percentage of the console, which a corner drag '
						+ 'would replace with fixed pixels. Edit width and height below to change it.',
				};
			}
			return {
				mode: 'box',
				width: width.value,
				height: height.value,
				widthCvar: `hud_${element.name}_width`,
				heightCvar: `hud_${element.name}_height`,
				alsoScales: p.has('scale'),
			};
		}
		if (p.has('scale')) {
			return {
				mode: 'scale',
				scale: Number(p.get('scale')) || 1,
				cvar: `hud_${element.name}_scale`,
			};
		}
		return null;
	}

	// Nine elements can be laid out along either axis, and ezQuake spells it three
	// different ways: `direction` on the bars (common_draw.c:934), `vertical` on
	// speed and the team bars, `orientation` on speed2 (hud_speed.c:449). The
	// editor offers one control and writes whichever cvar that element has.
	//
	// `swaps` is the part worth encoding. Only speed2 recomputes its own rect from
	// the new axis; for everything else the rect stays width x height, so turning a
	// 64x16 health bar vertical without also swapping the two leaves a wide box
	// filling bottom-up — technically what was asked for, never what was meant.
	directionControl(element) {
		if (!element) {
			return null;
		}
		const p = this.#params(element);
		const cvar = ['direction', 'vertical', 'orientation'].find((n) => p.has(n));
		if (!cvar) {
			return null;
		}
		const value = String(p.get(cvar) ?? '');
		const base = { cvar: `hud_${element.name}_${cvar}`, param: cvar, value };

		if (cvar === 'direction') {
			return {
				...base,
				label: 'Fill direction',
				swaps: true,
				options: [
					{ value: '0', label: 'Left to right', axis: 'x' },
					{ value: '1', label: 'Right to left', axis: 'x' },
					{ value: '2', label: 'Bottom to top', axis: 'y' },
					{ value: '3', label: 'Top to bottom', axis: 'y' },
				],
			};
		}
		if (cvar === 'orientation') {
			// speed2 sizes itself from `radius`, so there is nothing to swap.
			return {
				...base,
				label: 'Orientation',
				swaps: false,
				options: [
					{ value: '0', label: 'Up', axis: 'x' },
					{ value: '1', label: 'Down', axis: 'x' },
					{ value: '2', label: 'Right', axis: 'y' },
					{ value: '3', label: 'Left', axis: 'y' },
				],
			};
		}
		// `vertical` means two unrelated things. On frags it is grid fill order, not
		// an axis (hud_frags.c:890) — mislabelling it "orientation" would be a lie.
		if (p.has('rows') || p.has('cols')) {
			return {
				...base,
				label: 'Fill order',
				swaps: false,
				options: [
					{ value: '0', label: 'Rows first', axis: 'x' },
					{ value: '1', label: 'Columns first', axis: 'y' },
					{ value: '2', label: 'Grouped by team', axis: 'y' },
				],
			};
		}
		return {
			...base,
			label: 'Orientation',
			swaps: true,
			options: [
				{ value: '0', label: 'Horizontal', axis: 'x' },
				{ value: '1', label: 'Vertical', axis: 'y' },
			],
		};
	}

	// Changing axis on a rect-driven element is two cvars, not one. Returns every
	// write the change implies, so the caller cannot apply half of it.
	directionChanges(element, next) {
		const control = this.directionControl(element);
		if (!control) {
			return [];
		}
		const from = control.options.find((o) => o.value === control.value);
		const to = control.options.find((o) => o.value === String(next));
		const changes = [[control.cvar, String(next)]];
		if (!control.swaps || !from || !to || from.axis === to.axis) {
			return changes;
		}
		const size = this.sizeControl(element);
		if (size?.mode !== 'box' || !size.width || !size.height) {
			return changes;
		}
		changes.push([size.widthCvar, String(size.height)]);
		changes.push([size.heightCvar, String(size.width)]);
		return changes;
	}

	// What the inspector actually shows for one element: its cvars and placement,
	// never its rect. In a live game the rect moves every frame while none of the
	// controls change, so keying the inspector on the whole state made it rebuild
	// once a second — closing any open colour picker and dropping focus out of any
	// input the user was typing in.
	elementFingerprint(name) {
		const e = this.element(name);
		if (!e) {
			return '';
		}
		return JSON.stringify([
			e.cvars, e.place, e.align_x, e.align_y, e.pos_x, e.pos_y, e.shown, !!e.rect, e.parent,
		]);
	}

	// The tree shows names, nesting and visibility. Values changing behind it are
	// not a reason to rebuild it and interrupt a drag.
	get treeFingerprint() {
		return this.treeRows
			.map(({ element: e, depth }) => `${e.name}:${depth}:${e.shown ? 1 : 0}:${e.rect ? 1 : 0}:${e.parent ?? ''}`)
			.join('|');
	}

	anchorOf(element) {
		return {
			x: ANCHOR_X[String(element?.align_x ?? '').toLowerCase()] ?? 'left',
			y: ANCHOR_Y[String(element?.align_y ?? '').toLowerCase()] ?? 'top',
		};
	}

	// A corner can be dragged only when both of its edges are free to move. Anything
	// else would be a handle that refuses to follow the pointer, so the pinned
	// corners are shown as anchors instead — which is also the clearest way to teach
	// what align_x and align_y are doing.
	resizeHandles(element) {
		const control = this.sizeControl(element);
		// A percentage-sized element has no corner to drag: see sizeControl.
		if (!control || control.mode === 'relative' || !element?.rect) {
			return [];
		}
		const anchor = this.anchorOf(element);
		const freeX = { west: anchor.x !== 'left', east: anchor.x !== 'right' };
		const freeY = { north: anchor.y !== 'top', south: anchor.y !== 'bottom' };
		return CORNERS.map((corner) => ({
			...corner,
			active: freeX[corner.x] && freeY[corner.y],
			// Centred alignment grows from both edges, so the pointer has to move
			// only half as far as the size changes for the corner to keep up.
			gainX: anchor.x === 'center' ? 2 : 1,
			gainY: anchor.y === 'center' ? 2 : 1,
			signX: corner.x === 'east' ? 1 : -1,
			signY: corner.y === 'south' ? 1 : -1,
		}));
	}

	// Why can the engine not place this element? Answering with the engine's own
	// viewing context beats leaving the user staring at a blank rect.
	reasonUnplaced(element) {
		if (!element || element.rect) {
			return null;
		}
		if (!element.shown) {
			return 'Hidden. Turn it on to place it.';
		}
		const v = this.view;
		if (element.spec_required && v && !v.spectator) {
			return 'Only drawn while spectating.';
		}
		if (element.needs_pov && v && v.spectator && !v.tracking) {
			return 'Needs a player POV. Track someone instead of free-flying.';
		}
		if (this.status === Status.IDLE) {
			return 'ezQuake is not drawing a HUD yet.';
		}
		return 'Not drawn in the current situation.';
	}

	get physical() {
		return this.state?.physical ?? null;
	}

	element(name) {
		return this.elements.find((e) => e.name === name) ?? null;
	}

	get selectedElement() {
		return this.selected ? this.element(this.selected) : null;
	}

	// Elements the stage can draw a handle for. An element with no rect was not
	// drawn this frame, so the engine genuinely does not know where it is.
	get placedElements() {
		return this.elements.filter((e) => e.rect);
	}

	get visibleInTree() {
		const needle = this.filter.trim().toLowerCase();
		return this.elements
			.filter((e) => this.showHidden || e.shown)
			.filter((e) => this.showSpectator || !e.spec_required)
			.filter((e) => !needle ||
				e.name.toLowerCase().includes(needle) ||
				(e.description ?? '').toLowerCase().includes(needle))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	// Elements anchored to this one. This is what group membership actually is:
	// there is no membership list anywhere, only children naming a parent.
	childrenOf(name) {
		return this.elements
			.filter((e) => e.parent === name)
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	get groups() {
		return this.elements
			.filter((e) => /^group[1-9]$/.test(e.name))
			// The engine's list is in draw order; a picker must be in name order.
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	// Every legal value for `place`, so assigning an element to a group is a
	// choice from a list rather than a remembered string.
	placeOptions(forElement) {
		const anchors = this.elements
			.map((e) => e.name)
			.filter((n) => n !== forElement)
			.sort();
		return [
			...PLACE_REGIONS.map((r) => ({ value: r, label: r })),
			...anchors.map((n) => ({ value: n, label: `${n} — outside frame` })),
			...anchors.map((n) => ({ value: `@${n}`, label: `@${n} — inside frame` })),
		];
	}

	// Depth-first ordering so a group's members read as belonging to it. A child
	// whose parent is filtered out is shown at the root rather than hidden.
	get treeRows() {
		const visible = this.visibleInTree;
		const present = new Set(visible.map((e) => e.name));
		const byParent = new Map();
		const roots = [];
		for (const e of visible) {
			if (e.parent && present.has(e.parent)) {
				if (!byParent.has(e.parent)) byParent.set(e.parent, []);
				byParent.get(e.parent).push(e);
			} else {
				roots.push(e);
			}
		}
		const rows = [];
		const seen = new Set();
		const walk = (element, depth) => {
			// A cycle would otherwise recurse forever; the depth guard alone never
			// fired, because every member of a cycle has a present parent and so
			// none of them was a root — the whole cycle simply vanished from the
			// tree instead of being capped.
			if (seen.has(element.name)) return;
			seen.add(element.name);
			rows.push({ element, depth });
			if (depth > 6) return;
			for (const child of byParent.get(element.name) ?? []) walk(child, depth + 1);
		};
		for (const r of roots) walk(r, 0);
		// Anything still unvisited is in a placement cycle. Show it at the root
		// rather than dropping it: an element you cannot see is one you cannot fix.
		for (const e of visible) {
			if (!seen.has(e.name)) walk(e, 0);
		}
		return rows;
	}

	// Placement lives on hud_t's own cvar fields rather than in hud->params, so
	// the bridge reports it as top-level keys. Rebuild the real cvar names here:
	// without this the inspector silently omits place, pos and align, which are
	// the controls the editor exists for.
	// `omit` drops suffixes that already have a dedicated control, so a param never
	// appears twice with two different editors.
	static partitionCvars(element, omit = []) {
		const placement = PLACEMENT_ORDER
			.filter((suffix) => element[suffix] != null)
			.map((suffix) => ({
				name: `hud_${element.name}_${suffix}`,
				suffix,
				value: String(element[suffix]),
			}));

		const hidden = new Set(omit.filter(Boolean));
		const rest = [];
		for (const [name, value] of Object.entries(element.cvars ?? {})) {
			const suffix = name.slice(`hud_${element.name}_`.length);
			// A param that duplicates a placement key would otherwise appear twice.
			if (PLACEMENT_KEYS.has(suffix) || hidden.has(suffix)) {
				continue;
			}
			rest.push({ name, suffix, value });
		}
		rest.sort((a, b) => a.suffix.localeCompare(b.suffix));
		return { placement, rest };
	}
}
