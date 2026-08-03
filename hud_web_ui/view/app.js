// view/app.js — the only module allowed to touch the DOM.
//
// Reads from core, calls into core on interaction. Swapping this layer for a
// framework must not require changing anything under core/. See PRODUCT.md.

import { Bridge, BridgeError } from '../core/bridge.js';
import {
	ALIGN_X, ALIGN_Y, Model, Status, colorAllowsNames, formatColor, isColorParam,
	needsRecalculate, parseColor, resizeTo, resizedRect,
} from '../core/model.js';
import {
	consoleToFrame, displayDeltaToConsole, elementAt, quantize, scaleFactors,
} from '../core/geometry.js';

const $ = (id) => document.getElementById(id);
const el = {
	readout: $('readout'), status: $('status'), chrome: $('chrome'),
	sbCursor: $('sb-cursor'), sbDrawn: $('sb-drawn'), sbEngine: $('engine'),
	sbFont: $('sb-font'), sbFrame: $('sb-frame'),
	filter: $('filter'), showHidden: $('show-hidden'), showSpectator: $('show-spectator'), tree: $('tree'), treeCount: $('tree-count'),
	stage: $('stage'), frame: $('frame'), overlay: $('overlay'), empty: $('empty'),
	emptyTitle: $('empty-title'), emptyBody: $('empty-body'),
	inspector: $('inspector'), fontPanel: $('fonts'), groupPanel: $('groups'),
	saveOpen: $('save-open'), saveDialog: $('save-dialog'),
	modePanel: $('hudmodes'), killfeedPanel: $('killfeed'), resetDialog: $('reset-dialog'),
};

const bridge = Bridge.fromLocation(location.search);
const model = new Model();

let frameNonce = 0;
let poll = null;
let pending = new Map();   // cvar -> value the user typed but the engine hasn't confirmed

// ---- engine sync ----------------------------------------------------------

async function refresh() {
	try {
		model.applyState(await bridge.state());
		requestFrame();
	} catch (err) {
		model.applyError(BridgeError.from(err));
		if (model.status === Status.DENIED) {
			stopPolling();
		}
	}
}

// Capturing a frame costs the engine a glReadPixels and a PNG encode, which on
// software GL takes longer than the poll interval. Assigning a new src while the
// last one is still decoding cancels it, so a slow enough engine never finishes
// a single frame and the stage stays black forever. Load out of view and swap
// only once the bytes are decoded, and never have two in flight.

let frameLoading = false;

function requestFrame() {
	if (frameLoading) {
		return;
	}
	frameLoading = true;
	const started = performance.now();
	const next = new Image();
	next.addEventListener('load', () => {
		frameLoading = false;
		// Same URL, already in cache: this swap is instant and cannot fail.
		el.frame.src = next.src;
		model.set({
			frameReady: true,
			frameError: null,
			frameCost: Math.round(performance.now() - started),
		});
	});
	next.addEventListener('error', () => {
		frameLoading = false;
		// Keep whatever is on screen. A stale render beats a black rectangle, as
		// long as we say which one the user is looking at.
		model.set({ frameError: 'The engine did not send a frame.' });
	});
	next.src = bridge.frameUrl(++frameNonce);
}

function startPolling() {
	stopPolling();
	poll = setInterval(() => refresh(), 1000);
}

function stopPolling() {
	if (poll) { clearInterval(poll); poll = null; }
}

// One change that means several cvars is still one change: refresh once at the
// end, or the intermediate states render and a frame capture is paid for each.
async function applyAll(changes) {
	for (const [cvar, value] of changes) {
		pending.set(cvar, String(value));
	}
	render();
	try {
		for (const [cvar, value] of changes) {
			await bridge.setCvar(cvar, value);
		}
	} catch (err) {
		model.applyError(BridgeError.from(err));
		return;
	} finally {
		for (const [cvar] of changes) {
			pending.delete(cvar);
		}
	}
	if (changes.some(([cvar]) => needsRecalculate(cvar))) {
		await bridge.send('hud_recalculate');
	}
	await refresh();
}

const apply = (cvar, value) => applyAll([[cvar, value]]);

// ---- rendering ------------------------------------------------------------

// Every renderer below rebuilds its section with replaceChildren, so a render is
// a full node swap. The state poll runs once a second, which meant the node under
// the pointer was replaced mid-interaction: a click needs pointerdown and pointerup
// on the same element, so any click or drag that straddled a tick was silently
// dropped. Hold renders until the pointer is up, then run the one that is owed.
let interacting = false;
let dirty = false;

window.addEventListener('pointerdown', () => { interacting = true; }, true);
const endInteraction = () => {
	interacting = false;
	if (dirty) {
		dirty = false;
		render();
	}
};
window.addEventListener('pointerup', endInteraction, true);
window.addEventListener('pointercancel', endInteraction, true);
// A native drag swallows pointerup, so without this the interface would stop
// rendering for good the first time someone dragged an element into a group.
window.addEventListener('dragend', endInteraction, true);
window.addEventListener('drop', endInteraction, true);

// A frame arriving is not a reason to rebuild the element tree. Each section
// declares what it draws from and rebuilds only when that changes, so the poll
// stops churning nodes the user is trying to click.
const drawnFrom = new Map();

function stale(section, ...inputs) {
	const key = inputs.join('');
	if (drawnFrom.get(section) === key) {
		return false;
	}
	drawnFrom.set(section, key);
	return true;
}

function render() {
	if (interacting) {
		dirty = true;
		return;
	}
	// A throw in any renderer used to blank the interface with no visible sign,
	// which is indistinguishable from "the engine sent nothing". Surface it.
	try {
		renderBar();
		renderModes();
		renderKillfeed();
		renderGroups();
		renderFonts();
		renderTree();
		renderOverlay();
		renderInspector();
		syncSave();
	} catch (err) {
		console.error(err);
		el.status.textContent = 'Interface error';
		el.status.dataset.status = 'lost';
		el.inspector.replaceChildren(
			notice('Interface error', `${err.message}. Reload the page; the engine is unaffected.`),
		);
	}
}

const STATUS_TEXT = {
	[Status.CONNECTING]: 'Connecting…',
	[Status.LIVE]: 'Live',
	[Status.IDLE]: 'No HUD drawn',
	[Status.LOST]: 'ezQuake not responding',
	[Status.DENIED]: 'Link expired',
};

function renderBar() {
	el.status.textContent = STATUS_TEXT[model.status];
	el.status.dataset.status = model.status;

	// The scale chip carries the one thing the raw telemetry never said: what a
	// console pixel is worth on screen right now. It expands to per-axis form
	// only when the factors differ — because then the layout is stretched and
	// the user has to notice. Both ratios are independent and only look like one
	// number when the console happens to share the screen's aspect; hiding one
	// is what made a whole class of bug invisible during QA.
	const s = model.screen;
	const p = model.physical;
	el.readout.replaceChildren();
	el.readout.hidden = !(s && p);
	if (s && p) {
		const { kx, ky } = scaleFactors(s, p);
		const uneven = Math.abs(kx - ky) > 0.005;
		el.readout.dataset.uneven = String(uneven);
		const fmt = (n) => `${Math.round(n * 100) / 100}×`;
		el.readout.append(
			chipText('editing at '), chipStrong(`${s.vid_width}×${s.vid_height}`),
			chipSep(), chipText('1 px = '),
			chipStrong(uneven ? `${fmt(kx)} wide, ${fmt(ky)} tall` : `${fmt(kx)} on screen`),
		);
		if (uneven) {
			el.readout.append(chipText(' — stretched'));
		}
	}

	// Ambient meta lives in the status bar, where it never competes with a control.
	el.sbEngine.textContent = model.state?.engine ?? '';
	const drawn = model.placedElements.length;
	el.sbDrawn.textContent = model.elements.length
		? `${drawn} of ${model.elements.length} elements drawn`
		: '';
	const f = model.fonts;
	el.sbFont.textContent = f
		? `font ${f.proportional_loaded ? (f.facepath || 'proportional') : 'none'}`
		: '';
	el.sbFrame.textContent = model.frameCost != null ? `frame ${model.frameCost}ms` : '';
}

const chipText = (t) => document.createTextNode(t);

function chipStrong(t) {
	const s = document.createElement('strong');
	s.textContent = t;
	return s;
}

function chipSep() {
	const s = document.createElement('span');
	s.className = 'sep';
	s.textContent = '·';
	return s;
}

// <div><dt>term</dt><dd>value</dd></div> — the shape the inspector's metrics
// grid is made of.
function termCell(term, value) {
	const wrap = document.createElement('div');
	const dt = document.createElement('dt');
	const dd = document.createElement('dd');
	dt.textContent = term;
	dd.textContent = String(value);
	wrap.append(dt, dd);
	return wrap;
}

function icon(id) {
	const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
	use.setAttribute('href', `#${id}`);
	svg.append(use);
	return svg;
}

// HUD element taxonomy: rows are tinted by element family so 83 entries stay
// scannable. Purely presentational — classification lives here in the view, by
// name, because the engine has no such concept. Unknown names read as system.
const FAMILIES = [
	[/^(face|health|armor|iarmor|bar_(health|armor)|(health|armor)damage)$/, 'combat'],
	[/^(gun[0-9]?|ammo|iammo|weapon)/, 'weapons'],
	[/^(quad|ring|pent|suit|key[0-9]|powerup)/, 'powerups'],
	[/^(sigil[0-9]?|items?$|ibar|sbar)/, 'items'],
	[/^(.*clock|fps|ping|score|match|frags|teamfrags|rank)/, 'score'],
	[/^(tracking|teaminfo|notify|chat|centerprint|message)/, 'comms'],
];

function familyOf(name) {
	for (const [re, fam] of FAMILIES) {
		if (re.test(name)) {
			return fam;
		}
	}
	return 'system';
}

function updateTreeMeta() {
	for (const row of el.tree.querySelectorAll('.tree__row')) {
		const rect = model.element(row.dataset.name)?.rect;
		const meta = row.querySelector('.tree__meta');
		if (meta) {
			meta.textContent = rect ? `${rect.x},${rect.y}` : '—';
		}
	}
	updateTreeCount();
}

function renderTree() {
	if (!stale('tree', model.treeFingerprint, '|', model.filter, '|', model.showHidden,
		'|', model.showSpectator, '|', model.selected, '|', model.status)) {
		// The rows are still right; only the live coordinates moved. Writing text
		// into the nodes that are already there keeps them alive for a drag, which
		// rebuilding the list would not.
		updateTreeMeta();
		return;
	}
	const rows = model.treeRows;
	el.tree.replaceChildren();

	for (const { element: item, depth } of rows) {
		const li = document.createElement('li');
		const row = document.createElement('div');
		row.className = 'tree__row';
		row.setAttribute('role', 'option');
		row.setAttribute('aria-selected', String(item.name === model.selected));
		row.dataset.shown = String(item.shown);
		row.dataset.depth = String(depth);
		row.style.paddingLeft = `${10 + depth * 13}px`;
		row.tabIndex = -1;
		const kids = model.childrenOf(item.name);
		if (kids.length) {
			row.dataset.parent = 'true';
			row.title = `${kids.length} element${kids.length === 1 ? '' : 's'} anchored here: ${kids.map((k) => k.name).join(', ')}`;
		}

		const vis = document.createElement('button');
		vis.className = 'tree__vis';
		vis.type = 'button';
		vis.title = item.shown ? `Hide ${item.name}` : `Show ${item.name}`;
		vis.setAttribute('aria-label', vis.title);
		vis.append(icon(item.shown ? 'i-shown' : 'i-hidden'));
		vis.addEventListener('click', (ev) => {
			ev.stopPropagation();
			apply(`hud_${item.name}_show`, item.shown ? 0 : 1);
		});

		const fam = document.createElement('span');
		fam.className = 'tree__fam';
		fam.style.setProperty('--fam', `var(--fam-${familyOf(item.name)})`);

		const name = document.createElement('span');
		name.className = 'tree__name';
		name.textContent = item.name;

		row.append(vis, fam, name);

		// Assigning an element to a group is setting its `place` cvar, which is not
		// something anyone guesses. Dragging it onto the group says the same thing
		// in the direction people already think about it. The place picker stays:
		// dragging cannot express "@group1" or an arbitrary anchor element.
		row.draggable = true;
		row.addEventListener('dragstart', (ev) => {
			ev.dataTransfer.setData('text/plain', item.name);
			ev.dataTransfer.effectAllowed = 'move';
			el.groupPanel.dataset.dropping = 'true';
		});
		row.addEventListener('dragend', () => { delete el.groupPanel.dataset.dropping; });

		if (item.spec_required || item.needs_pov) {
			const badge = document.createElement('span');
			badge.className = 'tree__badge';
			badge.textContent = item.spec_required ? 'spec' : 'pov';
			badge.title = item.spec_required
				? 'Only drawn while spectating'
				: 'Needs a player POV; hidden when free-flying';
			row.append(badge);
		}

		row.dataset.name = item.name;
		const meta = document.createElement('span');
		meta.className = 'tree__meta';
		// Say what the engine knows: a drawn element has a real position, an
		// undrawn one genuinely has none.
		meta.textContent = item.rect ? `${item.rect.x},${item.rect.y}` : '—';

		row.append(meta);
		row.addEventListener('click', () => model.set({ selected: item.name }));
		row.addEventListener('mouseenter', () => model.set({ hovered: item.name }));
		row.addEventListener('mouseleave', () => model.set({ hovered: null }));
		li.append(row);
		el.tree.append(li);
	}

	updateTreeCount();
}

function updateTreeCount() {
	const shown = model.treeRows.length;
	const drawn = model.placedElements.length;
	const hidden = model.elements.filter((e) => !e.shown).length;
	el.treeCount.textContent =
		`${shown} of ${model.elements.length} registered · ${drawn} placed · ${hidden} hidden`;
}

let dragging = false;

function renderOverlay() {
	el.overlay.hidden = !model.chromeVisible;
	// A gesture owns the overlay until it ends. Rebuilding mid-drag would replace
	// the node under the pointer with one the engine has not caught up to yet, so
	// the box would snap backwards a frame at a time.
	if (dragging) {
		return;
	}
	// Boxes are positioned from the state and the frame's displayed size, so a new
	// frame of the same size changes nothing about them. Rebuilding anyway is what
	// used to pull the resize handles out from under the pointer.
	if (!stale('overlay', model.version, '|', model.selected, '|', model.hovered,
		'|', model.chromeVisible, '|', model.frameReady, '|', model.status,
		'|', el.frame.clientWidth, '|', el.frame.naturalWidth)) {
		return;
	}
	el.overlay.replaceChildren();

	const s = model.screen;
	const p = model.physical;
	const natural = el.frame.naturalWidth;
	const shown = el.frame.clientWidth;

	// A stage with no render used to be an unexplained black rectangle, which
	// reads as a broken editor. Say which of the two things is actually true.
	// Boxes stay off until a real frame has arrived: scaled against the 1x1
	// placeholder they would land nowhere near the elements they describe.
	if (!model.frameReady || !natural) {
		el.empty.hidden = false;
		el.emptyTitle.textContent = model.status === Status.IDLE
			? "ezQuake isn't drawing a HUD yet"
			: 'Waiting for the first render';
		el.emptyBody.textContent = model.status === Status.IDLE
			? 'The editor can only place elements the engine is actually rendering. Start a demo or join a server, and they\'ll appear here.'
			: model.frameError
				? `${model.frameError} Element positions below are still live — only the picture is missing.`
				: 'Capturing the frame takes the engine a moment, and longer on software rendering.';
		return;
	}
	el.empty.hidden = true;

	// A zero in `physical` is not a scale of 1, it is "the engine has not told us
	// the size of the picture yet". scaleFactors would fall back to kx=ky=1 and lay
	// every box out in console coordinates over a framebuffer-sized image -- wrong
	// position, wrong size, and no error anywhere to explain it. Draw nothing.
	if (!s || !p || !p[0] || !p[1] || !shown) {
		return;
	}
	const displayScale = shown / natural;

	for (const item of model.placedElements) {
		const r = consoleToFrame(item.rect, s, p);
		const box = document.createElement('div');
		box.className = 'box';
		box.dataset.selected = String(item.name === model.selected);
		// Selecting a container should show what moves with it.
		box.dataset.child = String(item.parent != null && item.parent === model.selected);
		placeBox(box, item.rect, s, p);

		if (item.name === model.selected || item.name === model.hovered) {
			const tag = document.createElement('span');
			tag.className = 'box__tag';
			tag.textContent = `${item.name} · ${item.rect.w}×${item.rect.h}`;
			const left = r.x * displayScale;
			const top = r.y * displayScale;
			const bottom = (r.y + r.h) * displayScale;
			// Clamp into the render: sit above the box unless that is off the top,
			// and never let the badge start so far right that it leaves the frame.
			tag.style.left = `${Math.min(Math.max(left, 2), Math.max(shown - 150, 2))}px`;
			tag.style.top = top < 22 ? `${bottom + 3}px` : `${top - 19}px`;
			el.overlay.append(tag);
		}

		box.addEventListener('mouseenter', () => model.set({ hovered: item.name }));
		box.addEventListener('mouseleave', () => model.set({ hovered: null }));
		box.addEventListener('pointerdown', (ev) => beginDrag(ev, item));
		if (item.name === model.selected) {
			addResizeHandles(box, item);
		}
		el.overlay.append(box);
	}
}

// Corners that can move get a grab handle; corners the engine has pinned get an
// anchor dot that says which cvar pinned it. A handle that refused to follow the
// pointer would be worse than no handle at all.
function addResizeHandles(box, item) {
	const control = model.sizeControl(item);
	if (!control) {
		return;
	}
	if (control.mode === 'relative') {
		// No handles, but say why rather than leaving the corners mysteriously bare.
		box.title = `${item.name}: ${control.reason}`;
		return;
	}
	const anchor = model.anchorOf(item);
	const what = control.mode === 'box'
		? `width and height${control.alsoScales ? ' (scale is separate, in the inspector)' : ''}`
		: 'scale, which is uniform — both sides move together';

	for (const handle of model.resizeHandles(item)) {
		const dot = document.createElement('div');
		dot.className = handle.active ? 'handle' : 'handle handle--anchored';
		dot.dataset.corner = handle.id;
		if (handle.active) {
			dot.title = `Drag to resize ${item.name} by ${what}.`;
			dot.addEventListener('pointerdown', (ev) => beginResize(ev, item.name, handle));
		} else {
			const pinned = [
				handle.x === 'west' && anchor.x === 'left' ? 'align_x left' : null,
				handle.x === 'east' && anchor.x === 'right' ? 'align_x right' : null,
				handle.y === 'north' && anchor.y === 'top' ? 'align_y top' : null,
				handle.y === 'south' && anchor.y === 'bottom' ? 'align_y bottom' : null,
			].filter(Boolean);
			dot.title = `Held here by ${pinned.join(' and ')}. The element grows away from this corner — resize from an open one, or change the alignment.`;
		}
		box.append(dot);
	}
}

function beginResize(ev, name, handle) {
	// Without this the box's own pointerdown starts a move at the same time.
	ev.preventDefault();
	ev.stopPropagation();

	// Read the element again now rather than trusting what the render closed over
	// a second ago: a stale control.width poisons the transfer ratio, and a stale
	// rect anchors the preview to a size the engine has already left.
	const item = model.element(name);
	const control = model.sizeControl(item);
	if (!item?.rect || !control) {
		return;
	}

	const box = ev.currentTarget.parentElement;
	const startX = ev.clientX;
	const startY = ev.clientY;
	const rect = { ...item.rect };
	const anchor = model.anchorOf(item);
	const screen = model.screen;
	const physical = model.physical;
	const displayWidth = el.frame.clientWidth;
	const gesture = beginGesture();

	const move = (e) => {
		const { dx, dy } = displayDeltaToConsole(
			e.clientX - startX, e.clientY - startY, screen, physical, displayWidth,
		);
		const changes = resizeTo(control, rect, dx * handle.signX * handle.gainX,
			dy * handle.signY * handle.gainY);

		// Draw the outcome now. The engine is authoritative and corrects this on
		// release, but a capture costs it most of a second on software GL, and a
		// gesture that lags that far behind is not a gesture.
		const factor = control.mode === 'box' ? null : changes[0][1] / (control.scale || 1);
		const width = control.mode === 'box'
			? Math.max(1, changes[0][1] * (rect.w / (control.width || 1)))
			: rect.w * factor;
		const height = control.mode === 'box'
			? Math.max(1, changes[1][1] * (rect.h / (control.height || 1)))
			: rect.h * factor;
		placeBox(box, resizedRect(rect, anchor, width, height), screen, physical);
		gesture.commit(changes);
	};
	const guarded = (e) => {
		try {
			move(e);
		} catch (err) {
			console.error('resize', err);
			up();
		}
	};

	const up = () => {
		window.removeEventListener('pointermove', guarded);
		window.removeEventListener('pointerup', up);
		// Take the engine's answer, which may differ: a group with a grow-mode
		// picture will not shrink below its picture, and centring truncates.
		gesture.end();
	};
	window.addEventListener('pointermove', guarded);
	window.addEventListener('pointerup', up);
}

// The one place a console-space rect becomes a positioned box. Steady-state
// rendering and both drag previews go through it, so a preview can never be drawn
// by different arithmetic than the engine's own answer that replaces it.
// displayScale is recomputed per call rather than captured, so a window resize
// mid-gesture still lands the box correctly.
function placeBox(box, rect, screen = model.screen, physical = model.physical) {
	const displayScale = el.frame.clientWidth / (el.frame.naturalWidth || 1);
	const r = consoleToFrame(rect, screen, physical);
	box.style.left = `${r.x * displayScale}px`;
	box.style.top = `${r.y * displayScale}px`;
	box.style.width = `${Math.max(r.w * displayScale, 3)}px`;
	box.style.height = `${Math.max(r.h * displayScale, 3)}px`;
}

// One write in flight at a time, always the newest.
//
// The bridge accepts four concurrent clients. A pointermove that fires an
// unawaited POST per axis exhausts that within a second of dragging, and every
// write after it is refused with a connection reset -- which is silent, because
// by then the user has moved on to the next pointermove. Coalesce instead:
// remember only the latest intent, send it when the previous send returns.
function beginGesture() {
	let queued = null;
	let sending = null;
	let failure = null;
	dragging = true;

	const drain = async () => {
		while (queued) {
			const batch = queued;
			queued = null;
			for (const [cvar, value] of batch) {
				try {
					await bridge.setCvar(cvar, value);
				} catch (err) {
					failure = err;
					queued = null;
					return;
				}
			}
		}
	};

	return {
		commit(changes) {
			queued = changes;
			if (!sending) {
				sending = drain().finally(() => { sending = null; });
			}
		},
		async end() {
			await sending;
			await drain();
			dragging = false;
			if (failure) {
				model.applyError(BridgeError.from(failure));
				return;
			}
			await refresh();
		},
	};
}

function beginDrag(ev, item) {
	ev.preventDefault();

	const box = ev.currentTarget;
	const startX = ev.clientX;
	const startY = ev.clientY;
	const originX = Number(item.pos_x) || 0;
	const originY = Number(item.pos_y) || 0;
	const rect = { ...item.rect };
	// Claim the overlay before changing the selection. Selecting re-renders, and a
	// re-render calls replaceChildren() -- which would leave every placeBox()
	// below writing to a node that is no longer in the document, so the drag would
	// look frozen until release. Style the live node instead; the full render with
	// handles arrives when the gesture ends.
	const gesture = beginGesture();
	model.set({ selected: item.name });
	for (const other of el.overlay.querySelectorAll('.box[data-selected="true"]')) {
		other.dataset.selected = 'false';
		other.querySelectorAll('.handle').forEach((h) => h.remove());
	}
	box.dataset.selected = 'true';
	let last = null;

	const move = (e) => {
		const { dx, dy } = displayDeltaToConsole(
			e.clientX - startX, e.clientY - startY,
			model.screen, model.physical, el.frame.clientWidth,
		);
		// Quantize to what the engine will actually store, so the preview never
		// promises sub-pixel precision the engine discards.
		const nx = quantize(originX + dx);
		const ny = quantize(originY + dy);
		placeBox(box, { ...rect, x: rect.x + (nx - originX), y: rect.y + (ny - originY) });

		const key = `${nx},${ny}`;
		if (key === last) {
			return;
		}
		last = key;
		gesture.commit([
			[`hud_${item.name}_pos_x`, nx],
			[`hud_${item.name}_pos_y`, ny],
		]);
	};

	const up = () => {
		window.removeEventListener('pointermove', move);
		window.removeEventListener('pointerup', up);
		gesture.end();
	};
	window.addEventListener('pointermove', move);
	window.addEventListener('pointerup', up);
}

function renderInspector() {
	// Never rebuild under the user's caret. A state tick that arrives mid-edit
	// (an import just changed this element, another client moved it) would
	// replace the focused input and silently discard what was typed — the edit
	// looks accepted and never lands. Deferring is safe: the tick after blur
	// still sees the changed fingerprint below and rebuilds then.
	if (el.inspector.contains(document.activeElement)) {
		return;
	}
	// The inspector is full of inputs the user is mid-edit in. Rebuilding it on a
	// frame tick loses focus and caret position for no benefit.
	if (!stale('inspector', model.elementFingerprint(model.selected), '|', model.selected,
		'|', model.status, '|', model.palette.length, '|', [...pending].join(','))) {
		return;
	}
	const item = model.selectedElement;
	el.inspector.replaceChildren();

	if (model.status === Status.DENIED) {
		el.inspector.append(notice(
			'Link expired',
			'The engine minted a new token. Run hud_web 1 in the ezQuake console again and open the URL it prints.',
		));
		return;
	}
	if (model.status === Status.LOST) {
		el.inspector.append(notice(
			'ezQuake not responding',
			'The engine may have closed. Reconnecting automatically — leave this tab open.',
		));
		return;
	}
	if (!item) {
		const p = document.createElement('p');
		p.className = 'empty-note';
		p.textContent = 'Select an element to edit it.';
		el.inspector.append(p);
		return;
	}

	const head = document.createElement('div');
	head.className = 'inspect__head';
	const h = document.createElement('h2');
	h.className = 'inspect__name';
	h.textContent = item.name;
	head.append(h);
	if (item.description) {
		const d = document.createElement('p');
		d.className = 'inspect__desc';
		d.textContent = item.description;
		head.append(d);
	}
	head.append(metrics(item));
	el.inspector.append(head);

	if (!item.rect) {
		el.inspector.append(notice(
			'Not currently drawn',
			`${model.reasonUnplaced(item)} Its values are still editable.`,
		));
	}

	const direction = model.directionControl(item);
	const { placement, rest } = Model.partitionCvars(item, [direction?.param]);
	if (placement.length) {
		el.inspector.append(group('Placement', placement, item));
	}
	if (direction) {
		el.inspector.append(directionGroup(direction, item));
	}
	if (rest.length) {
		el.inspector.append(group('Parameters', rest, item));
	}
}

// The one way a segmented control is built. Three sections need the same
// buttons-with-one-active shape (directionGroup, renderModes, renderKillfeed),
// and each hand-rolling its own loop is how the active-state comparison drifted
// between string and number once already.
function seg(options, current, onPick) {
	const wrap = document.createElement('div');
	wrap.className = 'seg';
	for (const option of options) {
		const b = document.createElement('button');
		b.type = 'button';
		b.className = 'seg__item';
		b.dataset.on = String(String(current) === String(option.value));
		b.textContent = option.label;
		if (option.title) {
			b.title = option.title;
		}
		b.addEventListener('click', () => onPick(option.value));
		wrap.append(b);
	}
	return wrap;
}

// The bars and speed spell this three different ways and none of them is a number
// worth typing. Buttons also make the swap-width-and-height rule enforceable: it
// happens as part of the change, instead of being a second edit to remember.
function directionGroup(control, item) {
	const section = document.createElement('section');
	section.className = 'group';
	const h = document.createElement('h3');
	h.className = 'group__title';
	h.textContent = control.label;
	section.append(h);

	section.append(seg(
		control.options.map((option) => ({
			...option, title: `Sets ${control.cvar} ${option.value}.`,
		})),
		control.value,
		(value) => applyAll(model.directionChanges(item, value)),
	));

	if (control.swaps) {
		const note = document.createElement('p');
		note.className = 'empty-note';
		note.textContent =
			'Switching between a horizontal and a vertical layout swaps width and height too — '
			+ 'the engine keeps the same box either way, so on its own the change would leave '
			+ 'the bar the wrong shape.';
		section.append(note);
	}
	return section;
}

function metrics(item) {
	const dl = document.createElement('dl');
	dl.className = 'metrics';
	const r = item.rect;
	for (const term of ['x', 'y', 'w', 'h']) {
		dl.append(termCell(term, r ? r[term] : '—'));
	}
	return dl;
}

function group(title, entries, item) {
	const section = document.createElement('section');
	section.className = 'group';
	const h = document.createElement('h3');
	h.className = 'group__title';
	h.textContent = title;
	section.append(h);

	for (const entry of entries) {
		const row = document.createElement('div');
		row.className = 'field';
		const id = `f-${item.name}-${entry.suffix}`;
		const label = document.createElement('label');
		label.htmlFor = id;
		label.textContent = entry.suffix;
		label.title = entry.name;

		let input;
		const enumerated = entry.suffix === 'align_x' ? ALIGN_X
			: entry.suffix === 'align_y' ? ALIGN_Y : null;
		if (enumerated) {
			input = document.createElement('select');
			for (const v of enumerated) {
				input.append(new Option(v, v));
			}
			const current = pending.get(entry.name) ?? entry.value;
			if (!enumerated.includes(current)) {
				input.append(new Option(`${current} — unknown, falls back to ${enumerated[0]}`, current));
			}
			input.value = current;
		} else if (entry.suffix === 'place') {
			// Assigning an element to a group IS setting this cvar, so it must be a
			// choice from what exists rather than a remembered string.
			input = document.createElement('select');
			for (const opt of model.placeOptions(item.name)) {
				input.append(new Option(opt.label, opt.value));
			}
			const current = pending.get(entry.name) ?? entry.value;
			if (![...input.options].some((o) => o.value === current)) {
				input.append(new Option(`${current} — unknown, falls back to screen`, current));
			}
			input.value = current;
		} else if (isColorParam(entry.suffix)) {
			section.append(colorField(entry, item));
			continue;
		} else {
			input = document.createElement('input');
			input.type = 'text';
			input.value = pending.get(entry.name) ?? entry.value;
			input.spellcheck = false;
		}
		input.id = id;
		if (pending.has(entry.name)) {
			input.dataset.dirty = 'true';
		}
		const inert = model.inertReason(entry.suffix);
		if (inert) {
			row.dataset.inert = 'true';
			label.title = `${entry.name} — ${inert}`;
			input.title = inert;
		}
		input.addEventListener('change', () => apply(entry.name, input.value.trim()));
		input.addEventListener('keydown', (ev) => {
			if (ev.key === 'Enter') { input.blur(); }
		});

		row.append(label, input);
		if (inert) {
			// Its own cell: inside the label it was clipped by the ellipsis, which
			// defeated the point of marking it at all.
			const mark = document.createElement('span');
			mark.className = 'field__inert';
			mark.textContent = 'inert';
			mark.title = inert;
			row.append(mark);
		}
		section.append(row);
	}
	return section;
}

// A colour cvar holds one of four things and looks like a number in three of them.
// The swatch shows what the engine will actually draw; the raw text stays, because
// a value we cannot parse must still be editable rather than quietly rewritten.
function colorField(entry, item) {
	const raw = pending.get(entry.name) ?? entry.value;
	const names = colorAllowsNames(entry.suffix);
	const parsed = parseColor(raw, model.palette, { allowNames: names });

	const row = document.createElement('div');
	row.className = 'field field--color';
	const label = document.createElement('label');
	label.textContent = entry.suffix;
	label.title = entry.name;

	const swatch = document.createElement('button');
	swatch.type = 'button';
	swatch.className = 'swatch';
	const rgb = [1, 3, 5].map((i) => parseInt(parsed.hex.slice(i, i + 2), 16) || 0);
	swatch.style.setProperty('--swatch-fill', `rgba(${rgb.join(',')},${(parsed.alpha ?? 255) / 255})`);
	swatch.dataset.unknown = String(!parsed.valid);
	swatch.setAttribute('aria-expanded', 'false');
	swatch.title = parsed.form === 'index'
		? `Palette index ${parsed.index} — ${parsed.hex}. Click to change.`
		: parsed.form === 'name'
			? `Named colour "${parsed.name}" — ${parsed.hex}. Click to change.`
			: parsed.valid
				? `${parsed.form.toUpperCase()} ${parsed.hex}${parsed.form === 'rgba' ? ` at ${parsed.alpha}/255 alpha` : ''}. Click to change.`
				: `ezQuake cannot read "${raw}" as a colour and will draw white. Click to set one.`;

	const text = document.createElement('input');
	text.type = 'text';
	text.value = raw;
	text.spellcheck = false;
	text.className = 'field__raw';
	text.addEventListener('change', () => apply(entry.name, text.value.trim()));
	text.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { text.blur(); } });

	if (pending.has(entry.name)) {
		text.dataset.dirty = 'true';
	}
	const inert = model.inertReason(entry.suffix);
	if (inert) {
		row.dataset.inert = 'true';
		label.title = `${entry.name} — ${inert}`;
		swatch.title = inert;
	}

	row.append(label, swatch, text);

	const pop = document.createElement('div');
	pop.className = 'swatchpop';
	pop.hidden = true;
	swatch.addEventListener('click', async () => {
		const open = pop.hidden;
		pop.hidden = !open;
		swatch.setAttribute('aria-expanded', String(open));
		if (!open) {
			return;
		}
		// Built fresh on every open rather than cached: caching it once meant a
		// picker opened before the palette arrived stayed empty for good.
		if (!model.palette.length) {
			await loadPalette();
		}
		pop.replaceChildren();
		buildColorPop(pop, entry, parseColor(pending.get(entry.name) ?? entry.value,
			model.palette, { allowNames: names }));
	});

	const wrap = document.createElement('div');
	wrap.append(row, pop);
	if (parsed.note) {
		const n = document.createElement('p');
		n.className = 'font-state';
		n.textContent = parsed.note;
		wrap.append(n);
	}
	return wrap;
}

function buildColorPop(pop, entry, parsed) {
	// Free colour first, since that is what "I don't want to write colour codes"
	// means; the palette below it is the only way to say "whatever slot 52 is",
	// which survives a pak replacing the palette and an RGB triple does not.
	const mixRow = document.createElement('div');
	mixRow.className = 'swatchpop__row';

	const picker = document.createElement('input');
	picker.type = 'color';
	picker.value = parsed.valid ? parsed.hex : '#ffffff';

	const alpha = document.createElement('input');
	alpha.type = 'range';
	alpha.min = '0';
	alpha.max = '255';
	alpha.value = String(parsed.alpha ?? 255);
	const alphaOut = document.createElement('span');
	alphaOut.className = 'swatchpop__alpha';
	alphaOut.textContent = `α ${alpha.value}`;

	// Keep RGB as RGB unless the user asks for transparency: adding a fourth token
	// to a cvar that had three is a change to the value's meaning, not a no-op.
	const writeMix = () => {
		const form = alpha.value === '255' && parsed.form !== 'rgba' ? 'rgb' : 'rgba';
		apply(entry.name, formatColor({ form, hex: picker.value, alpha: Number(alpha.value) }));
	};
	picker.addEventListener('change', writeMix);
	alpha.addEventListener('input', () => { alphaOut.textContent = `α ${alpha.value}`; });
	alpha.addEventListener('change', writeMix);

	mixRow.append(picker, alpha, alphaOut);
	pop.append(mixRow);

	const grid = document.createElement('div');
	grid.className = 'palette';
	const colors = model.palette;
	if (!colors.length) {
		const p = document.createElement('p');
		p.className = 'font-state';
		p.textContent = 'The engine has not sent its palette yet.';
		pop.append(p);
		return;
	}
	for (let i = 0; i < colors.length; i++) {
		const cell = document.createElement('button');
		cell.type = 'button';
		cell.className = 'palette__cell';
		cell.style.background = colors[i];
		cell.dataset.on = String(parsed.form === 'index' && parsed.index === i);
		cell.title = `Palette ${i} — ${colors[i]}`;
		cell.addEventListener('click', () => apply(entry.name, formatColor({ form: 'index', index: i })));
		grid.append(cell);
	}
	const gridNote = document.createElement('p');
	gridNote.className = 'font-state';
	gridNote.textContent = 'Palette slots are stored as their index, so they follow the palette if a pak replaces it. Alpha is always 255 for these.';
	pop.append(grid, gridNote);
}

function notice(title, body) {
	const p = document.createElement('p');
	p.className = 'notice';
	const strong = document.createElement('strong');
	strong.textContent = title;
	p.append(strong, document.createTextNode(body));
	return p;
}

// ---- HUD systems ----------------------------------------------------------
// ezQuake has more than one HUD, and which are drawn is four independent axes
// rather than a setting. Presenting five cvars would just move the confusion; the
// panel names the axes, says what the current combination draws, and hides the
// classic-bar controls when nothing classic is being drawn.

const NEWHUD_MODES = [
	['0', 'Classic', 'The original status bar only.'],
	['1', 'New', 'The hud_ element system only — what this editor edits.'],
	['2', 'Both', 'Classic bar with the new elements drawn over it.'],
];
const COMPACT_STYLES = [
	['0', 'Normal'], ['1', 'Compact'], ['2', 'Compact TF'],
	['3', 'Compact bare'], ['4', 'Compact with icons'],
];

function field(label, control, hint) {
	const row = document.createElement('div');
	row.className = 'field';
	const l = document.createElement('label');
	l.textContent = label;
	row.append(l, control);
	if (!hint) {
		return row;
	}
	const wrap = document.createElement('div');
	const note = document.createElement('p');
	note.className = 'font-state';
	note.textContent = hint;
	wrap.append(row, note);
	return wrap;
}

function picker(options, value, onChange) {
	const select = document.createElement('select');
	for (const [v, label] of options) {
		select.append(new Option(label, v));
	}
	select.value = String(value);
	select.addEventListener('change', () => onChange(select.value));
	return select;
}

function renderModes() {
	const m = model.modes;
	// Same rule as the tree, overlay and inspector: rebuild only when what this
	// section draws from actually changed. Without this the panel was rebuilt on
	// every render -- including every frame arrival, since frameCost changes each
	// time -- which dropped focus out of the viewsize input and the two selects
	// mid-edit, the same node-churn failure the interaction guards exist to stop.
	if (!stale('modes', JSON.stringify(m), '|', model.sbarInert, '|', model.modeSummary)) {
		return;
	}
	const box = el.modePanel;
	box.replaceChildren();
	if (!m) {
		return;
	}

	const section = document.createElement('section');
	section.className = 'group';
	const h = document.createElement('h3');
	h.className = 'group__title';
	h.textContent = 'HUD system';
	section.append(h);

	section.append(seg(
		NEWHUD_MODES.map(([value, label, hint]) => ({ value, label, title: hint })),
		m.scr_newhud,
		(value) => apply('scr_newhud', value),
	));

	const summary = document.createElement('p');
	summary.className = 'font-state';
	summary.dataset.ok = 'true';
	summary.textContent = model.modeSummary;
	section.append(summary);
	if (m.synthetic) {
		section.append(syntheticNote());
	}

	// QW262 is drawn outside any scr_newhud test, so it is genuinely a third HUD
	// rather than an alternative to the other two.
	const qw262 = document.createElement('label');
	qw262.className = 'toggle toggle--sm';
	const cb = document.createElement('input');
	cb.type = 'checkbox';
	cb.checked = Boolean(m.cl_hud);
	cb.addEventListener('change', () => apply('cl_hud', cb.checked ? 1 : 0));
	const cbText = document.createElement('span');
	cbText.textContent = 'QW262 overlay (stacks on top)';
	qw262.append(cb, cbText);
	section.append(qw262);

	if (m.classic_drawn) {
		section.append(field('bar',
			picker([['1', 'Standard'], ['0', 'Heads-up']], m.cl_sbar ? '1' : '0',
				(v) => apply('cl_sbar', v)),
			model.sbarInert
				? 'Heads-up needs viewsize 100 or more; below that the engine forces standard.'
				: null));
		section.append(field('style',
			picker(COMPACT_STYLES, m.scr_compacthud, (v) => apply('scr_compacthud', v))));

		const size = document.createElement('input');
		size.type = 'number';
		size.min = '30';
		size.max = '120';
		size.value = String(m.viewsize);
		size.addEventListener('change', () => apply('viewsize', size.value));
		section.append(field('viewsize', size,
			m.viewsize >= 120 ? 'At 120 the classic bar is not drawn at all.' : null));
	}

	const reset = document.createElement('button');
	reset.type = 'button';
	reset.className = 'btn';
	reset.textContent = 'Reset positions…';
	reset.addEventListener('click', () => openReset());
	section.append(reset);
	box.append(section);
}

// The FTE adapter synthesizes these blocks from its own ledger because the
// plugin ignores the cvars; the pixels will not move, and saying so beats
// letting the user conclude the control is broken (PARITY.md:93). Since the
// engine pin gained the plugin-side scr_newhud (#15 P1), the Classic/New/Both
// switch itself drives the engine for real — the note now covers only what is
// still ledger-backed: the QW262 overlay and the readback (the engine does not
// report these cvars back yet, so the shown values are the editor's own ledger).
function syntheticNote() {
	const note = document.createElement('p');
	note.className = 'font-state';
	note.textContent =
		'The Classic/New/Both switch drives the engine preview for real. ' +
		"The QW262 overlay can't be previewed on the FTE backend; every setting still lands in your exported config.";
	return note;
}

// Killfeed-specific: the plugin's vx_tracker.c registers the ezQuake-dialect
// r_tracker* cvars natively now (#15 P2), so the preview follows every one of
// them for real. Three honest exceptions remain, so this note is narrower
// than syntheticNote() above but not empty: pickups (r_tracker_pickups is a
// stub -- no event source in the engine yet), the weapon-icon style
// (best-effort image lookup, verified live against the real dist -- #15
// fragfile proof: cl_useimagesinfraglog 1 produced no visible icon and the
// engine held to the text row instead), and silencing the console echo
// (con_fragmessages 0 does not stop the engine's own obituary prints --
// verified live, same proof run -- a passthrough gap in the engine, not this
// editor).
function killfeedSyntheticNote() {
	const note = document.createElement('p');
	note.className = 'font-state';
	note.textContent =
		"Everything previews for real except pickups (no event source in the engine yet), weapon-icon style (best-effort) and silencing the console echo. All settings still land in your exported config.";
	return note;
}

// ---- killfeed --------------------------------------------------------------
// Where kills are announced is three cvars pretending to be one setting, plus a
// family of r_tracker_* content knobs. The seg writes the r_tracker /
// con_fragmessages *pair*, because each combination is a distinct behaviour
// and setting one cvar at a time walks through the others on the way.

const KILLFEED_WHERE = [
	{
		value: 'tracker', label: 'Dedicated killfeed',
		title: 'Sets r_tracker 1, con_fragmessages 0.',
		changes: [['r_tracker', 1], ['con_fragmessages', 0]],
	},
	{
		value: 'console', label: 'Console messages',
		title: 'Sets r_tracker 0, con_fragmessages 1.',
		changes: [['r_tracker', 0], ['con_fragmessages', 1]],
	},
	{
		value: 'both', label: 'Both',
		title: 'Sets r_tracker 1, con_fragmessages 1.',
		changes: [['r_tracker', 1], ['con_fragmessages', 1]],
	},
];

function renderKillfeed() {
	const k = model.killfeed;
	// Same stale() discipline as renderModes: a frame-only tick must not churn
	// the nodes under an open select or a half-typed number.
	if (!stale('killfeed', JSON.stringify(k), '|', model.killfeedSummary)) {
		return;
	}
	const box = el.killfeedPanel;
	box.replaceChildren();
	// Absent block means this engine does not expose the killfeed cvars, which
	// is not a state worth an empty section.
	if (!k) {
		return;
	}

	const section = document.createElement('section');
	section.className = 'group';
	const h = document.createElement('h3');
	h.className = 'group__title';
	h.textContent = 'Killfeed';
	section.append(h);

	const on = (cvar) => Number(k[cvar]) !== 0;
	const where = on('r_tracker')
		? (on('con_fragmessages') ? 'both' : 'tracker')
		: (on('con_fragmessages') ? 'console' : 'none');
	section.append(field('Where kills appear', seg(KILLFEED_WHERE, where,
		(value) => applyAll(KILLFEED_WHERE.find((o) => o.value === value).changes))));

	section.append(field('Style', seg([
		{ value: '0', label: 'Classic text', title: 'Sets cl_useimagesinfraglog 0.' },
		{ value: '1', label: 'Weapon icons', title: 'Sets cl_useimagesinfraglog 1.' },
	], on('cl_useimagesinfraglog') ? '1' : '0',
	(value) => apply('cl_useimagesinfraglog', value))));

	const toggle = (label, cvar) => {
		const wrap = document.createElement('label');
		wrap.className = 'toggle toggle--sm';
		wrap.title = `Sets ${cvar} 0/1.`;
		const cb = document.createElement('input');
		cb.type = 'checkbox';
		cb.checked = on(cvar);
		cb.addEventListener('change', () => apply(cvar, cb.checked ? 1 : 0));
		const text = document.createElement('span');
		text.textContent = label;
		wrap.append(cb, text);
		return wrap;
	};
	section.append(
		toggle('Show frags', 'r_tracker_frags'),
		toggle('Show streaks', 'r_tracker_streaks'),
		toggle('Show flag events', 'r_tracker_flags'),
		toggle('Show pickups', 'r_tracker_pickups'),
		toggle('Align right', 'r_tracker_align_right'),
	);

	const numeric = (label, cvar) => {
		const input = document.createElement('input');
		input.type = 'text';
		input.value = String(k[cvar] ?? '');
		input.spellcheck = false;
		input.title = `Sets ${cvar}.`;
		input.addEventListener('change', () => apply(cvar, input.value.trim()));
		input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { input.blur(); } });
		return field(label, input);
	};
	section.append(
		numeric('Seconds on screen', 'r_tracker_time'),
		numeric('Max lines', 'r_tracker_messages'),
		numeric('Scale', 'r_tracker_scale'),
	);

	const summary = document.createElement('p');
	summary.className = 'font-state';
	summary.dataset.ok = 'true';
	summary.textContent = model.killfeedSummary;
	section.append(summary);
	if (k.synthetic) {
		section.append(killfeedSyntheticNote());
	}
	box.append(section);
}

// ---- reset ----------------------------------------------------------------
// A confirmation that only says "are you sure" teaches nothing. The engine
// reports every element's registered defaults, so this one can count and name
// what it would undo, and say plainly what it will leave alone.

function openReset() {
	const changes = model.resetChanges;
	el.resetDialog.replaceChildren(buildReset(changes));
	el.resetDialog.showModal();
}

function buildReset(changes) {
	const form = document.createElement('form');
	form.method = 'dialog';
	form.className = 'save__form';

	const title = document.createElement('h2');
	title.id = 'reset-title';
	title.textContent = 'Reset positions and visibility';
	form.append(title);

	const body = document.createElement('p');
	body.className = 'save__path';
	const count = changes.reduce((n, e) => n + e.fields.length, 0);
	const defaultsKnown = model.resetDefaultsKnown;
	body.textContent = count
		? `${count} value${count === 1 ? '' : 's'} across ${changes.length} element${changes.length === 1 ? '' : 's'} will go back to what ezQuake registered.`
		: defaultsKnown
			? 'Everything already matches the defaults. Nothing would change.'
			: 'This preview backend does not report registered defaults, so no per-element count is available -- Reset will still restore every element\'s placement and visibility.';
	form.append(body);

	if (count) {
		const list = document.createElement('p');
		list.className = 'save__message';
		list.hidden = false;
		const names = changes.map((c) => c.name);
		list.textContent = names.slice(0, 12).join(', ') +
			(names.length > 12 ? `, and ${names.length - 12} more` : '');
		form.append(list);
	}

	if (count || !defaultsKnown) {
		const scope = document.createElement('div');
		scope.className = 'save__warn';
		const p = document.createElement('p');
		p.textContent = 'Positions, alignment and which elements are shown. Scales, colours, fonts and every other per-element setting are left alone — and nothing is written to disk until you save.';
		scope.append(p);
		form.append(scope);
	}

	const footer = document.createElement('footer');
	footer.className = 'save__footer';
	const cancel = document.createElement('button');
	cancel.type = 'button';
	cancel.className = 'btn';
	cancel.textContent = 'Cancel';
	cancel.addEventListener('click', () => el.resetDialog.close());
	const go = document.createElement('button');
	go.type = 'button';
	go.className = 'btn btn--primary';
	go.textContent = 'Reset';
	// Disabled only when this backend both knows the defaults AND confirms
	// nothing differs from them. When it cannot report defaults at all (the
	// FTE-web preview -- see model.resetDefaultsKnown), the button stays live:
	// hud_reset_layout is a safe, idempotent restore either way.
	go.disabled = count === 0 && defaultsKnown;
	go.addEventListener('click', async () => {
		go.disabled = true;
		go.textContent = 'Resetting…';
		try {
			await bridge.send('hud_reset_layout');
		} catch (err) {
			model.applyError(BridgeError.from(err));
		}
		await refresh();
		el.resetDialog.close();
	});
	footer.append(cancel, go);
	form.append(footer);
	form.addEventListener('submit', (ev) => ev.preventDefault());
	return form;
}

// ---- groups ---------------------------------------------------------------
// ezQuake has exactly nine, statically registered, hidden by default, and sized
// by width/height rather than scale. There is no membership list: an element
// belongs to a group purely by naming it in `place`. This panel makes all of
// that visible instead of leaving it to be discovered.

// A drop target has to say so before the button is released, or the user is
// guessing. dragover must be cancelled or the browser refuses the drop outright.
function acceptDrop(node, place, verb) {
	node.dataset.drop = 'true';
	node.addEventListener('dragover', (ev) => {
		ev.preventDefault();
		ev.dataTransfer.dropEffect = 'move';
		node.dataset.over = 'true';
	});
	node.addEventListener('dragleave', () => { delete node.dataset.over; });
	node.addEventListener('drop', (ev) => {
		ev.preventDefault();
		delete node.dataset.over;
		delete el.groupPanel.dataset.dropping;
		const name = ev.dataTransfer.getData('text/plain');
		// An element placed on itself is rejected by HUD_FindPlace (`par != hud`)
		// and silently falls back to the screen, so refuse it here where we can say
		// nothing happened rather than let it look like a move that did nothing.
		if (!name || place === name || place === `@${name}`) {
			return;
		}
		model.set({ selected: name });
		apply(`hud_${name}_place`, place);
	});
	node.title = node.title ? `${node.title}\n${verb} by dragging it here.` : `${verb} by dragging it here.`;
}

function renderGroups() {
	const groups = model.groups;
	// Membership is "which elements name this group in place", which treeFingerprint
	// already captures, plus the selection the hint text is written from.
	if (!stale('groups', model.treeFingerprint, '|', model.selected,
		'|', groups.map((g) => `${g.name}:${g.shown ? 1 : 0}`).join(','))) {
		return;
	}
	const box = el.groupPanel;
	box.replaceChildren();
	if (!groups.length) {
		return;
	}

	const section = document.createElement('section');
	section.className = 'group';
	const h = document.createElement('h3');
	h.className = 'group__title';
	h.textContent = 'Groups';
	section.append(h);

	const list = document.createElement('div');
	list.className = 'grouplist';
	for (const g of groups) {
		const kids = model.childrenOf(g.name);
		const item = document.createElement('button');
		item.type = 'button';
		item.className = 'grouplist__item';
		item.dataset.on = String(g.shown);
		item.dataset.selected = String(g.name === model.selected);

		const name = document.createElement('span');
		name.className = 'grouplist__name';
		name.textContent = g.name.replace('group', 'G');

		const count = document.createElement('span');
		count.className = 'grouplist__count';
		count.textContent = kids.length ? String(kids.length) : '·';
		item.title = kids.length
			? `${g.name}: ${kids.map((k) => k.name).join(', ')}`
			: `${g.name}: empty. Set an element's place to ${g.name} to add it.`;

		item.append(name, count);
		item.addEventListener('click', () => model.set({ selected: g.name }));
		// "@" is the whole difference between inside the group and beside it
		// (hud.c:281). Dropping onto a group means inside it; the bare form stays
		// available in the place picker for anyone who wants the other one.
		acceptDrop(item, `@${g.name}`, `Move it inside ${g.name}`);
		list.append(item);
	}
	section.append(list);

	// Somewhere to drop an element to take it back out again. Without this the
	// drag is one-way and the only exit is the place picker it was meant to replace.
	const detach = document.createElement('button');
	detach.type = 'button';
	detach.className = 'grouplist__detach';
	detach.textContent = 'Drop here to remove from a group';
	acceptDrop(detach, 'screen', 'Place it on the screen instead');
	detach.addEventListener('click', () => {
		const sel = model.selectedElement;
		if (sel && sel.parent) { apply(`hud_${sel.name}_place`, 'screen'); }
	});
	section.append(detach);

	const selected = model.selectedElement;
	const hint = document.createElement('p');
	hint.className = 'font-state';
	if (selected && /^group[1-9]$/.test(selected.name)) {
		const kids = model.childrenOf(selected.name);
		hint.textContent = selected.shown
			? `${selected.name} holds ${kids.length} element${kids.length === 1 ? '' : 's'}. Size it with width and height below — groups have no scale. Moving it moves them.`
			: `${selected.name} is off. Turn it on to place it; its ${kids.length} member${kids.length === 1 ? '' : 's'} anchor to it either way.`;
	} else {
		hint.textContent = 'Pick a group to size or move it. Add an element by setting its place to the group.';
	}
	section.append(hint);
	box.append(section);
}

// ---- fonts ----------------------------------------------------------------
// The engine makes this needlessly hard: `set font_facepath` fails silently, a
// non-empty facepath does not mean a face loaded, `fontlist` hides .otf files,
// and the bake-time options need a reload. The user should meet none of that.

let fontState = null;
let fontBusy = false;

// Fetched once: the palette only changes when a different pak is loaded, which
// means restarting the engine anyway.
async function loadPalette() {
	try {
		const { colors } = await bridge.palette();
		model.set({ palette: Array.isArray(colors) ? colors : [] });
	} catch (err) {
		// A missing palette costs the swatch grid, not the editor — but swallowing
		// it silently is how an empty grid became impossible to explain.
		console.warn('palette unavailable', err);
	}
}

async function loadFonts() {
	try {
		fontState = await bridge.fonts();
	} catch {
		fontState = null;
	}
	renderFonts();
}

async function chooseFace(name) {
	fontBusy = true;
	renderFonts();
	try {
		await bridge.loadFace(name);
	} catch { /* verified below rather than trusted */ }
	// Never report success from the command returning 200 — the engine rejects a
	// failed load by cancelling the cvar change, so ask what actually happened.
	await new Promise((r) => setTimeout(r, 250));
	fontBusy = false;
	await loadFonts();
	await refresh();
}

function renderFonts() {
	// The face picker is a <select> the user opens; rebuilding it under them closes
	// it. fontState only changes when a load actually completes.
	if (!stale('fonts', JSON.stringify(fontState), '|', fontBusy)) {
		return;
	}
	const box = el.fontPanel;
	box.replaceChildren();
	if (!fontState) {
		return;
	}

	const section = document.createElement('section');
	section.className = 'group';
	const h = document.createElement('h3');
	h.className = 'group__title';
	h.textContent = 'Fonts';
	section.append(h);

	const row = document.createElement('div');
	row.className = 'field';
	const label = document.createElement('label');
	label.htmlFor = 'face';
	label.textContent = 'face';
	label.title = `Proportional font, from ${fontState.directory}`;

	const select = document.createElement('select');
	select.id = 'face';
	select.disabled = fontBusy;
	const none = new Option('none (8px charset)', '');
	select.append(none);
	for (const f of fontState.available ?? []) {
		select.append(new Option(f, f));
	}
	// A face named in the config but missing from disk must still be visible,
	// otherwise the picker silently disagrees with what the engine is holding.
	if (fontState.facepath && !(fontState.available ?? []).includes(fontState.facepath)) {
		select.append(new Option(`${fontState.facepath} (not found)`, fontState.facepath));
	}
	select.value = fontState.facepath ?? '';
	select.addEventListener('change', () => chooseFace(select.value));

	row.append(label, select);
	section.append(row);

	const state = document.createElement('p');
	state.className = 'font-state';
	if (fontBusy) {
		state.textContent = 'Loading…';
	} else if (fontState.proportional_loaded) {
		state.dataset.ok = 'true';
		state.textContent = 'Loaded. Proportional spacing is active.';
	} else if (fontState.facepath) {
		state.dataset.warn = 'true';
		state.textContent = `"${fontState.facepath}" did not load — everything renders at 8px. Check it exists in ${fontState.directory}.`;
	} else {
		state.textContent = 'No proportional font. Text renders at a fixed 8px cell.';
	}
	section.append(state);
	box.append(section);
}

// ---- saving ---------------------------------------------------------------
// Built once when the dialog opens and then patched, never rebuilt: the engine
// poll re-renders every second, and replacing a text field the user is typing
// into would eat the caret.

const save = {};

async function openSave() {
	try {
		model.applyConfigs(await bridge.configs());
	} catch (err) {
		model.setSave({ error: err instanceof BridgeError ? err.message : String(err) });
	}
	buildSave();
	model.setSave({ open: true, done: null, error: null });
	el.saveDialog.showModal();
	save.name.focus();
	save.name.select();
}

function buildSave() {
	if (save.built) {
		save.name.value = model.save.name;
		return;
	}
	save.built = true;

	const form = document.createElement('form');
	form.method = 'dialog';
	form.className = 'save__form';

	const title = document.createElement('h2');
	title.id = 'save-title';
	title.textContent = 'Save config';
	form.append(title);

	// What to write. Two real choices, because the engine has two commands.
	const what = document.createElement('fieldset');
	what.className = 'save__what';
	const legend = document.createElement('legend');
	legend.textContent = 'Contents';
	what.append(legend);
	const modes = [
		['false', 'Everything', 'Binds, aliases, settings and the HUD — a config you can load on its own.'],
		['true', 'HUD only', 'Just the hud_ cvars, to exec on top of a config you already have.'],
	];
	for (const [value, label, hint] of modes) {
		const wrap = document.createElement('label');
		wrap.className = 'save__mode';
		const radio = document.createElement('input');
		radio.type = 'radio';
		radio.name = 'save-what';
		radio.value = value;
		radio.checked = String(model.save.hudOnly) === value;
		radio.addEventListener('change', () => model.setSave({ hudOnly: value === 'true' }));
		const text = document.createElement('span');
		const strong = document.createElement('strong');
		strong.textContent = label;
		const small = document.createElement('small');
		small.textContent = hint;
		text.append(strong, small);
		wrap.append(radio, text);
		what.append(wrap);
	}
	form.append(what);

	const field = document.createElement('div');
	field.className = 'save__field';
	const nameLabel = document.createElement('label');
	nameLabel.htmlFor = 'save-name';
	nameLabel.textContent = 'Name';
	save.name = document.createElement('input');
	save.name.id = 'save-name';
	save.name.type = 'text';
	save.name.autocomplete = 'off';
	save.name.spellcheck = false;
	save.name.value = model.save.name;
	save.name.addEventListener('input', () => model.setSave({ name: save.name.value }));
	const ext = document.createElement('span');
	ext.className = 'save__ext';
	ext.textContent = '.cfg';
	field.append(nameLabel, save.name, ext);
	form.append(field);

	save.path = document.createElement('p');
	save.path.className = 'save__path';
	form.append(save.path);

	// The overwrite gate. cfg_backup defaults to 0, so without this the previous
	// config is simply gone — which is exactly the accident worth preventing.
	save.warn = document.createElement('div');
	save.warn.className = 'save__warn';
	save.warn.hidden = true;
	save.warnText = document.createElement('p');
	const confirmWrap = document.createElement('label');
	confirmWrap.className = 'save__confirm';
	save.confirm = document.createElement('input');
	save.confirm.type = 'checkbox';
	save.confirm.addEventListener('change',
		() => model.setSave({ confirmedOverwrite: save.confirm.checked }));
	const confirmText = document.createElement('span');
	confirmText.textContent = 'Replace it';
	confirmWrap.append(save.confirm, confirmText);
	save.warn.append(save.warnText, confirmWrap);
	form.append(save.warn);

	save.message = document.createElement('p');
	save.message.className = 'save__message';
	save.message.hidden = true;
	form.append(save.message);

	const footer = document.createElement('footer');
	footer.className = 'save__footer';
	const cancel = document.createElement('button');
	cancel.type = 'button';
	cancel.className = 'btn';
	cancel.textContent = 'Cancel';
	cancel.addEventListener('click', () => el.saveDialog.close());
	save.submit = document.createElement('button');
	save.submit.type = 'button';
	save.submit.className = 'btn btn--primary';
	save.submit.textContent = 'Save';
	save.submit.addEventListener('click', () => commitSave());
	footer.append(cancel, save.submit);
	form.append(footer);

	// method="dialog" would close on Enter and look like a save that happened.
	form.addEventListener('submit', (ev) => {
		ev.preventDefault();
		commitSave();
	});
	el.saveDialog.replaceChildren(form);
	el.saveDialog.addEventListener('close', () => model.setSave({ open: false }));
}

function syncSave() {
	if (!save.built || !model.save.open) {
		return;
	}
	const s = model.save;
	const nameError = model.saveNameError;
	const dir = model.saveDirectory;

	save.path.textContent = nameError
		? nameError
		: dir ? `Writes ${model.saveFile} to ${dir}` : `Writes ${model.saveFile}`;
	save.path.dataset.error = String(Boolean(nameError));

	save.warn.hidden = !model.saveOverwrites;
	if (model.saveOverwrites) {
		save.warnText.textContent =
			// hud_export ignores cfg_backup entirely (config_manager.c:882), so a
			// HUD-only overwrite keeps nothing. Promising a .bak there was a lie the
			// user would only discover after losing the file.
			(model.save.hudOnly
				? `${model.saveFile} already exists. Saving replaces it, and HUD-only export keeps no backup — the current contents are gone.`
				: `${model.saveFile} already exists. Saving replaces it — a copy is kept as ${model.saveFile}.bak.`);
	}
	if (save.confirm.checked !== s.confirmedOverwrite) {
		save.confirm.checked = s.confirmedOverwrite;
	}

	save.message.hidden = !(s.done || s.error);
	save.message.dataset.error = String(Boolean(s.error));
	save.message.textContent = s.error ?? s.done ?? '';

	save.submit.disabled = !model.canSave;
	save.submit.textContent = s.busy ? 'Saving…' : 'Save';
}

async function commitSave() {
	if (!model.canSave) {
		return;
	}
	const file = model.saveFile;
	const dir = model.saveDirectory;
	model.setSave({ busy: true, done: null, error: null });
	try {
		await bridge.save({
			name: file,
			hudOnly: model.save.hudOnly,
			// Only when we know we are landing on something. Setting cfg_backup
			// otherwise would change a preference the user never asked us to touch.
			keepBackup: model.saveOverwrites,
		});
	} catch (err) {
		model.setSave({ busy: false, error: err instanceof BridgeError ? err.message : String(err) });
		return;
	}
	// The command returning 200 only means it was queued. Re-read the directory
	// and report what is actually there.
	let listing = null;
	try {
		listing = await bridge.configs();
	} catch { /* reported as unverified below */ }
	if (listing) {
		model.applyConfigs(listing);
	}
	const landed = model.saveListing.some((f) => f.toLowerCase() === file.toLowerCase());
	model.setSave({
		busy: false,
		confirmedOverwrite: false,
		done: landed
			? `Wrote ${file} to ${dir}`
			: `Sent to ezQuake, but ${file} is not in ${dir} yet.`,
	});
}

// ---- input ----------------------------------------------------------------

el.filter.addEventListener('input', () => model.set({ filter: el.filter.value }));
el.showHidden.addEventListener('change', () => model.set({ showHidden: el.showHidden.checked }));
el.showSpectator.addEventListener('change', () => model.set({ showSpectator: el.showSpectator.checked }));
el.chrome.addEventListener('change', () => model.set({ chromeVisible: el.chrome.checked }));
el.saveOpen.addEventListener('click', () => openSave());
el.frame.addEventListener('load', renderOverlay);
window.addEventListener('resize', renderOverlay);

// Click empty stage to deselect; click a rendered element to select it, which
// keeps the canvas behaving the way the tree does.
el.frame.addEventListener('pointerdown', (ev) => {
	const s = model.screen;
	const p = model.physical;
	if (!s || !p) { return; }
	const rect = el.frame.getBoundingClientRect();
	// Per axis. This one line kept using the horizontal ratio for both while
	// consoleToFrame and displayDeltaToConsole were fixed around it, so an element's
	// clickable region sat at y/(ky/kx) -- above where it is drawn -- for anyone
	// whose console shape differs from their screen's.
	const displayScale = rect.width / el.frame.naturalWidth;
	const { kx, ky } = scaleFactors(s, p);
	const hit = elementAt(
		model.placedElements,
		(ev.clientX - rect.left) / (kx * displayScale),
		(ev.clientY - rect.top) / (ky * displayScale),
	);
	model.set({ selected: hit?.name ?? null });
});

// The status bar's cursor readout, in console pixels — the coordinate space the
// engine stores. Written directly rather than through the model: a mousemove per
// frame must not trigger the render pipeline.
el.stage.addEventListener('mousemove', (ev) => {
	const s = model.screen;
	const p = model.physical;
	if (!s || !p || !el.frame.naturalWidth) { return; }
	const rect = el.frame.getBoundingClientRect();
	const displayScale = rect.width / el.frame.naturalWidth;
	const { kx, ky } = scaleFactors(s, p);
	const x = Math.round((ev.clientX - rect.left) / (kx * displayScale));
	const y = Math.round((ev.clientY - rect.top) / (ky * displayScale));
	el.sbCursor.dataset.live = 'true';
	el.sbCursor.textContent = `x ${Math.max(0, x)} y ${Math.max(0, y)}`;
});
el.stage.addEventListener('mouseleave', () => {
	delete el.sbCursor.dataset.live;
	el.sbCursor.textContent = 'x — y —';
});

// Arrow keys nudge, matching the engine's integer steps. Shift multiplies.
window.addEventListener('keydown', (ev) => {
	const item = model.selectedElement;
	if (!item || ev.target.matches('input, select')) { return; }
	const step = ev.shiftKey ? 10 : 1;
	const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
	const move = moves[ev.key];
	if (!move) { return; }
	ev.preventDefault();
	if (move[0]) { apply(`hud_${item.name}_pos_x`, quantize((Number(item.pos_x) || 0) + move[0])); }
	if (move[1]) { apply(`hud_${item.name}_pos_y`, quantize((Number(item.pos_y) || 0) + move[1])); }
});

model.subscribe(render);

if (!bridge.configured) {
	model.applyError(new BridgeError('No token in this URL', { status: 403 }));
} else {
	refresh().then(() => { loadFonts(); loadPalette(); startPolling(); });
}
