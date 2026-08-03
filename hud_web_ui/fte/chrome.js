// fte/chrome.js — the host page's own controls, outside the editor.
//
// Everything the FTE backend needs that the editor has no concept of: which
// demo is playing, dropping files onto the page, and the drift report saying
// what the preview could not show. None of it lives in view/app.js, which is
// byte-identical to the ezQuake build and knows nothing about any of this.

// Through the mapped specifier, never '../core/fte-adapter.js' directly: the
// import map points '/core/bridge.js' at the adapter, and a second specifier
// resolving to a second URL would be a second module instance with its own
// `current` -- so this file would hold a Bridge nobody is polling.
import { currentBridge } from '../core/bridge.js';
import { importFile, importDemoUrl } from './import.js';

const $ = (id) => document.getElementById(id);
// This caches only boot.js's stable facade. Engine handles themselves must be
// obtained from host.engine() at the moment a future chrome control needs one;
// the existing controls use host.play() or the adapter, which do that already.
const host = window.EZHUD_FTE ?? {};

// ---- demo picker ------------------------------------------------------------

const URL_OPTION = '__url__';

async function cachedDemos() {
	try {
		const cache = await caches.open('user');
		const keys = await cache.keys();
		return keys
			.map((r) => {
				const i = r.url.indexOf('/_/');
				return i < 0 ? null : r.url.slice(i + 3);
			})
			.filter((p) => p && p.startsWith('qw/demos/'));
	} catch {
		// No Cache API (file://, or a locked-down profile). The bundled demos
		// still work; imports are what stop being possible, and the drop
		// handler says so when one is attempted.
		return [];
	}
}

async function buildDemoPicker() {
	const select = $('fte-demo');
	if (!select) {
		return;
	}
	const bundled = host.bundledDemos ?? [];
	const seen = new Set(bundled.map((d) => d.path));
	select.replaceChildren();
	for (const demo of bundled) {
		select.append(new Option(demo.label, demo.path));
	}
	for (const path of await cachedDemos()) {
		if (!seen.has(path)) {
			seen.add(path);
			select.append(new Option(`${path.replace('qw/demos/', '')} (imported)`, path));
		}
	}
	select.append(new Option('From a URL…', URL_OPTION));
	if (host.initialDemo && seen.has(host.initialDemo)) {
		select.value = host.initialDemo;
	}

	select.addEventListener('change', async () => {
		if (select.value !== URL_OPTION) {
			// Straight to the console, not through the adapter: `playdemo` is
			// deliberately not on the editor's allowlist (docs/PROTOCOL.md) and
			// this is the page speaking, not the editor.
			if (!host.play?.(select.value)) {
				note('The engine is not up yet — pick the demo again in a moment.');
			}
			return;
		}
		select.value = host.initialDemo ?? '';
		const url = window.prompt('Demo URL (.mvd). The server has to allow cross-origin reads.');
		if (!url) {
			return;
		}
		try {
			note(`Fetching ${url}…`);
			const report = await importDemoUrl(url);
			reloadFor(report);
		} catch (err) {
			// Almost always CORS, which fetch reports as a bare TypeError with
			// no detail by design. Say what it usually means rather than
			// showing the user "Failed to fetch".
			note(`Could not fetch that demo: ${err.message}. If the console shows a CORS error, `
				+ 'the host does not allow cross-origin reads and the file has to be downloaded '
				+ 'and dropped on the page instead.');
		}
	});
}

// ---- volume -----------------------------------------------------------------
// The demo's sound, owner decision #10: it defaults quiet (0.175, applied by
// boot.js's +volume launch argument, which also replays the state stored here)
// and this pair is the only knob over it. `volume` is editor chrome, not HUD
// state — the adapter allows the exact cvar but keeps it out of the ledger and
// every export path, so a saved config never grows a line the user did not
// write.

const VOLUME_KEY = 'ezhud.fte.volume';
const MUTED_KEY = 'ezhud.fte.muted';
const DEFAULT_VOLUME = 0.175;

function rememberVolume(volume, muted) {
	try {
		window.localStorage.setItem(VOLUME_KEY, String(volume));
		window.localStorage.setItem(MUTED_KEY, muted ? '1' : '0');
	} catch { /* private mode: the session keeps its sound control anyway */ }
}

function sendVolume(value) {
	// The engine already booted at the stored volume (boot.js's +volume), so
	// this only ever runs on a user gesture. A bridge that is not up yet means
	// the engine the write was for is gone too — nothing to recover.
	currentBridge()?.setCvar('volume', value).catch(() => {});
}

function installVolume() {
	const button = $('fte-mute');
	const slider = $('fte-volume');
	if (!button || !slider) {
		return;
	}
	let muted = false;
	try {
		muted = window.localStorage.getItem(MUTED_KEY) === '1';
		const stored = parseFloat(window.localStorage.getItem(VOLUME_KEY));
		if (stored >= 0 && stored <= 1) {
			slider.value = String(stored);
		}
	} catch { /* private mode: the markup's default stands */ }
	button.setAttribute('aria-pressed', String(muted));

	// One engine write per frame, however fast 'input' fires during a drag —
	// the same coalescing shape as the editor's own drag writes.
	let pending = 0;
	function queueVolume() {
		if (!pending) {
			pending = requestAnimationFrame(() => {
				pending = 0;
				sendVolume(slider.value);
			});
		}
	}

	slider.addEventListener('input', () => {
		// Touching the slider while muted unmutes: the gesture says "I want to
		// hear this", and a slider that moves silently would look broken.
		if (muted) {
			muted = false;
			button.setAttribute('aria-pressed', 'false');
		}
		rememberVolume(slider.value, muted);
		queueVolume();
	});

	button.addEventListener('click', () => {
		muted = !muted;
		button.setAttribute('aria-pressed', String(muted));
		if (!muted && !(parseFloat(slider.value) > 0)) {
			// Never unmute to silence: a slider parked at 0 comes back at the
			// default rather than flipping the icon and changing nothing.
			slider.value = String(DEFAULT_VOLUME);
		}
		sendVolume(muted ? 0 : slider.value);
		rememberVolume(slider.value, muted);
	});
}

// ---- drop zone --------------------------------------------------------------

function note(text) {
	const el = $('fte-note');
	if (el) {
		el.textContent = text;
		el.hidden = !text;
	}
}

function reloadFor(report) {
	const what = report.kind === 'demo' ? 'demo' : 'package';
	note(`Stored ${report.name}. Reloading so the engine picks the ${what} up — `
		+ 'it reads imported files once, at startup.');
	// Long enough for the sentence above to be read, short enough not to feel
	// like nothing happened.
	setTimeout(() => location.reload(), 1200);
}

function installDropZone() {
	const zone = $('fte-drop');
	if (!zone) {
		return;
	}
	zone.addEventListener('dragover', (ev) => {
		ev.preventDefault();
		ev.dataTransfer.dropEffect = 'copy';
		zone.dataset.over = 'true';
	});
	zone.addEventListener('dragleave', () => { delete zone.dataset.over; });
	zone.addEventListener('drop', async (ev) => {
		ev.preventDefault();
		delete zone.dataset.over;
		const bridge = currentBridge();
		const files = [...(ev.dataTransfer?.files ?? [])];
		if (!files.length) {
			return;
		}
		if (!bridge) {
			note('The editor has not started yet.');
			return;
		}
		for (const file of files) {
			try {
				note(`Reading ${file.name}…`);
				const report = await importFile(file, bridge);
				if (report.kind === 'unknown') {
					note(`Nothing to do with ${file.name}. Drop a .cfg, a .pak/.pk3/.zip, or a .mvd.`);
					continue;
				}
				if (report.needsReload) {
					reloadFor(report);
					return; // the page is going away; a second file would be lost
				}
				note(`${report.name}: applied ${report.applied} of ${report.lines} lines.`);
				renderDrift(report);
			} catch (err) {
				note(`${file.name}: ${err.message}`);
			}
		}
	});
}

// ---- drift report -----------------------------------------------------------
// Requirement 5. An import that silently drops a third of someone's config is
// worse than one that refuses it, so every line is accounted for here: applied,
// carried verbatim, or named as something this preview cannot show.

function line(text, className) {
	const p = document.createElement('p');
	p.className = className ?? 'fte-drift__line';
	p.textContent = text;
	return p;
}

function renderDrift(report) {
	const box = $('fte-drift');
	const body = $('fte-drift-body');
	const summary = $('fte-drift-summary');
	if (!box || !body || !summary) {
		return;
	}
	box.hidden = false;

	const problems = report.missingElements.length + report.unpreviewed.length + report.refused.length;
	summary.textContent = problems
		? `${report.name}: ${report.applied} applied, ${problems} thing${problems === 1 ? '' : 's'} this preview cannot show`
		: `${report.name}: ${report.applied} applied, nothing lost`;

	body.replaceChildren();

	if (report.missingElements.length) {
		body.append(line(
			`${report.missingElements.length} element${report.missingElements.length === 1 ? '' : 's'} `
			+ 'in your config are not registered by FTE\'s ezhud plugin, so they have no preview here. '
			+ 'Their settings are kept and written back on export:',
			'fte-drift__head'));
		for (const element of report.missingElements) {
			body.append(line(`${element.name} — ${element.cvars.length} cvar${element.cvars.length === 1 ? '' : 's'}`));
		}
	}

	if (report.unpreviewed.length) {
		body.append(line(
			'Applied, but the preview reports no value back for them, so the editor cannot show '
			+ 'or re-export them from the engine. EZHud_StateJSON() only reports per-element hud '
			+ 'cvars — the scr_/cl_/vid_ families are set but not read back:',
			'fte-drift__head'));
		body.append(line(report.unpreviewed.join(', ')));
	}

	if (report.translated?.length) {
		body.append(line(
			'Applied under FTE\'s own name too, so the preview follows the same file:',
			'fte-drift__head'));
		for (const t of report.translated) {
			body.append(line(`${t.from} "${t.value}" → ${t.to}`));
		}
	}

	if (report.refused.length) {
		body.append(line('Refused by the command allowlist:', 'fte-drift__head'));
		for (const r of report.refused) {
			body.append(line(`${r.cvar} — ${r.reason}`));
		}
	}

	if (report.retainedHud.length) {
		body.append(line('hud_ lines kept verbatim rather than applied:', 'fte-drift__head'));
		for (const raw of report.retainedHud) {
			body.append(line(raw));
		}
	}

	body.append(line(
		`${report.retained} line${report.retained === 1 ? '' : 's'} carried verbatim `
		+ '(binds, aliases, and every other cvar). They are written back byte-identical when you save.',
		'fte-drift__foot'));
}

// ---- go ---------------------------------------------------------------------

buildDemoPicker();
installVolume();
installDropZone();
