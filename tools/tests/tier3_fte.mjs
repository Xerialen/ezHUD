#!/usr/bin/env node
// tools/tests/tier3_fte.mjs — the deterministic FTE-backend suite.
//
// Real DOM, real adapter/import/chrome modules, fake engine. The tier-3 lane for
// the ezQuake bridge (tier3.mjs) mocks an HTTP transport the FTE page does not
// have; this one mocks the two globals the FTE page actually talks to instead:
// Module._EZHud_StateJSON (plugins/ezhud/hud.c's export) and FTEC.cbufadd (the
// console channel). Everything between those two globals and the pixels is the
// shipping code.
//
// Three things make this a test rather than a demonstration:
//
//  * hud_web_ui/ is served at the site root, because index-fte.html's import map
//    keys on the resolved URL '/core/bridge.js'. Served from anywhere else the
//    page silently loads core/bridge.js — the ezQuake HTTP client — instead.
//  * ftewebglcl.js is not under hud_web_ui/ and 404s. That is the point: the
//    page has to be drivable with no wasm at all, so boot.js's download-failed
//    note is an expected condition here, not a failure.
//  * the fake cbufadd PARSES what the editor sends and folds it back into the
//    state the poll loop reads. Asserting "the right string was sent" would pass
//    against an editor that computed the wrong number and drew it correctly
//    anyway; the closed loop is what catches that.

import { readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { consoleToFrame, displayDeltaToConsole, scaleFactors } from '../../hud_web_ui/core/geometry.js';

let chromium;
try {
	({ chromium } = await import('playwright'));
} catch (err) {
	if (err?.code === 'ERR_MODULE_NOT_FOUND') {
		console.error('TIER 3 FTE SKIP: Playwright is not installed; run npm install.');
		process.exit(0);
	}
	throw err;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const uiRoot = path.join(repo, 'hud_web_ui');

function assert(condition, message) {
	if (!condition) {
		throw new Error(message);
	}
}

// Same tolerance as tier3.mjs: a box is positioned in CSS pixels from a chain of
// floating-point ratios, so sub-pixel disagreement with the arithmetic is the
// browser rounding, not the editor getting it wrong.
function near(actual, expected, label) {
	assert(Math.abs(actual - expected) <= 0.8,
		`${label}: expected ${expected.toFixed(3)}, got ${actual.toFixed(3)}`);
}

// ---- the fixture ------------------------------------------------------------
// Shaped exactly like plugins/ezhud/hud.c's EZHud_StateJSON(): pos_x/order/frame
// are strings (the C prints the cvar's own string so a round trip stays
// byte-identical), there is no `hud_modes`, no `fonts` and no `defaults` block —
// the FTE plugin exports none of them, and a fixture that invented them would
// test panels this backend never fills.
const SCREEN = { vid_width: 640, vid_height: 400, scr_con_current: 0 };
// TESTING.md's aspect-ratio rule. 640x400 console on a 1280x720 canvas is
// kx=2.00 and ky=1.80: a suite where the two agree cannot catch the bug class
// that has cost this project the most (one ratio used for both axes).
const CANVAS = [1280, 720];

function element(name, extra) {
	return {
		name,
		description: `${name} (tier3-fte fixture)`,
		shown: true,
		place: 'screen',
		parent: null,
		align_x: 'left',
		align_y: 'top',
		pos_x: '0',
		pos_y: '0',
		order: '0',
		frame: '0',
		spec_required: false,
		needs_pov: false,
		rect: null,
		cvars: {},
		...extra,
	};
}

const FIXTURE = {
	protocol: 1,
	engine: 'fteqw ezhud (web)',
	screen: SCREEN,
	view: { spectator: true, tracking: true },
	demo: { cl_demospeed: '1' },
	elements: [
		element('health', {
			pos_x: '16', pos_y: '24',
			rect: { x: 16, y: 24, w: 64, h: 24 },
			cvars: { hud_health_scale: '1', hud_health_style: '0' },
		}),
		element('armor', {
			pos_x: '16', pos_y: '60',
			rect: { x: 16, y: 60, w: 48, h: 24 },
			cvars: { hud_armor_scale: '1' },
		}),
		// Percentage-sized, which model.sizeControl() answers 'relative' for: no
		// corner handles, because a drag would replace "30%" with fixed pixels.
		element('radar', {
			pos_x: '8', pos_y: '8', align_x: 'right',
			rect: { x: 400, y: 8, w: 192, h: 100 },
			cvars: { hud_radar_width: '30%', hud_radar_height: '25%' },
		}),
		// Registered but not drawn this frame — the state the editor must render
		// as "—" rather than guessing a position for.
		element('teaminfo', { shown: false, cvars: { hud_teaminfo_scale: '1' } }),
	],
};

// The config dropped in case 4. Every line is here to exercise one branch of
// fte/import.js: an applying placement cvar, an applying param, a hud_ cvar for
// an element FTE does not register, the gl_consolefont → gl_font translation, an
// applying non-hud cvar the state never reports back, a `volume` line the
// pipeline must retain rather than apply (#10 — the editor owns the preview's
// volume), and a line the parser must keep verbatim rather than run.
const IMPORT_CFG = [
	'// tier3-fte import fixture',
	'hud_health_pos_x 12',
	'hud_health_scale 2',
	'hud_dogtag_pos_x 40',
	'gl_consolefont povo5f',
	'scr_newhud 1',
	'r_tracker 0',
	'volume "1"',
	'bind SPACE +jump',
	'',
].join('\n');
const IMPORT_NAME = 'tier3f.cfg';
const IMPORT_APPLIED = 6;   // everything but the comment, the bind and volume
const IMPORT_LINES = 9;

// ---- static server ----------------------------------------------------------
// hud_web_ui/ at the root, the way tools/fte-web/serve.sh serves it. Nothing is
// synthesised: a request for ftewebglcl.js falls through to the 404 below,
// exactly as it will on a dist that was never assembled.

const contentTypes = new Map([
	['.html', 'text/html; charset=utf-8'], ['.css', 'text/css; charset=utf-8'],
	['.js', 'text/javascript; charset=utf-8'], ['.svg', 'image/svg+xml'],
	['.json', 'application/json'], ['.png', 'image/png'],
]);

const server = http.createServer(async (request, response) => {
	try {
		const url = new URL(request.url, 'http://fixture.invalid');
		const relative = url.pathname === '/' ? 'index-fte.html' : decodeURIComponent(url.pathname.slice(1));
		const target = path.resolve(uiRoot, relative);
		if (!target.startsWith(`${uiRoot}${path.sep}`) || !(await stat(target)).isFile()) {
			response.writeHead(404).end('not found');
			return;
		}
		response.writeHead(200, { 'content-type': contentTypes.get(path.extname(target)) ?? 'application/octet-stream' });
		response.end(await readFile(target));
	} catch {
		response.writeHead(404).end('not found');
	}
});

try {
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
} catch (err) {
	if (err?.code === 'EPERM' || err?.code === 'EACCES') {
		console.error(`TIER 3 FTE SKIP: this sandbox forbids the required loopback static server (${err.code}).`);
		process.exit(0);
	}
	throw err;
}

let browser;
try {
	// channel:'chrome' is the system Google Chrome, never a Playwright download:
	// this machine has Chrome and GitHub's ubuntu runners ship it preinstalled,
	// and tier 4 needs the same browser's SwiftShader for real WebGL.
	browser = await chromium.launch({ channel: 'chrome', headless: true });
} catch (err) {
	await new Promise((resolve) => server.close(resolve));
	if (/executable|channel|not found|install/i.test(String(err))) {
		console.error('TIER 3 FTE SKIP: system Google Chrome is not installed (playwright channel "chrome").');
		process.exit(0);
	}
	throw err;
}

const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
// Nothing here should ever wait seconds: every wait is a condition that either
// holds within a poll interval or is a real failure. The suite's budget is 30s.
page.setDefaultTimeout(10000);

const crashes = [];
page.on('pageerror', (err) => crashes.push(String(err)));
const conlog = [];
page.on('console', (m) => conlog.push(`${m.type()}: ${m.text()}`));
const engineScript = [];
page.on('response', (res) => {
	if (res.url().endsWith('/ftewebglcl.js')) {
		engineScript.push(res.status());
	}
});

// Reading the fake engine's own state is reading the engine, not the editor's
// internals — it is the other side of the wire this suite is testing.
const engineState = () => page.evaluate(() => structuredClone(window.__fake.state));
const sentLines = () => page.evaluate(() => [...window.__fake.sent]);
const named = (state, name) => state.elements.find((e) => e.name === name);

try {
	const { port } = server.address();
	await page.goto(`http://127.0.0.1:${port}/index-fte.html`);

	// boot.js is a classic script in <body>, so Module exists before any module
	// script has run. Waiting on it rather than on load means the fake is in
	// place for app.js's very first poll if it wins the race, and picked up
	// lazily by the adapter if it does not — which is the design, not luck.
	await page.waitForFunction(() => Boolean(window.Module && window.EZHUD_FTE));

	await page.evaluate(({ state, canvas }) => {
		const fake = { state, sent: [], engineEvents: [], demoCursor: 0, refuseDemo: false };
		window.__fake = fake;
		// A deterministic stand-in for the demo packet cursor. Unlike cl.time,
		// this advances only while cl_demospeed is non-zero, matching the engine
		// fact case 1 needs to prove rather than a wall/game clock.
		fake.demoTimer = setInterval(() => {
			if (Number(fake.state.demo?.cl_demospeed) > 0) {
				fake.demoCursor += 1;
			}
		}, 100);

		// The adapter reads `physical` off the canvas backing store, so this is
		// where the 2.00/1.80 axis split is set. index-fte.html ships 1920x1080
		// attributes as the pre-engine fallback; the real engine's resize glue
		// overwrites them, and here the test does.
		const el = document.getElementById('canvas');
		el.width = canvas[0];
		el.height = canvas[1];

		// FTE's real resize glue owns this in tier 4F: it follows the canvas CSS
		// box, multiplies by devicePixelRatio, then exports the new video size in
		// state.screen. Mirror only that boundary here so the editor-scale case can
		// prove a chrome-only layout change still propagates through engine state.
		window.addEventListener('resize', () => requestAnimationFrame(() => {
			const rect = el.getBoundingClientRect();
			el.width = Math.max(1, Math.round(rect.width * window.devicePixelRatio));
			el.height = Math.max(1, Math.round(rect.height * window.devicePixelRatio));
			fake.state.screen = { ...fake.state.screen,
				vid_width: el.width, vid_height: el.height };
		}));

		// These live on hud_t rather than in the params array (hud.c), which is
		// why they are named here instead of being found in `cvars`.
		const PLACEMENT = new Set(['place', 'align_x', 'align_y', 'order', 'frame']);

		// `hud_bar_health_width` is hud_ + bar_health + width and nothing in the
		// name says where the element ends, so ask the registered elements —
		// longest match wins, the same rule fte/import.js uses.
		function owner(cvar) {
			let best = null;
			for (const e of fake.state.elements) {
				const head = `hud_${e.name}_`;
				if (cvar.startsWith(head) && (!best || e.name.length > best.element.name.length)) {
					best = { element: e, suffix: cvar.slice(head.length) };
				}
			}
			return best;
		}

		// Registered defaults, snapshotted before any write -- what
		// HUD_ResetLayout_f (plugins/ezhud/hud.c) restores placement/visibility
		// to. Ported to the FTE plugin because the editor's "Reset positions..."
		// button always sent `hud_reset_layout`, but the plugin had no such
		// command; the fake engine needs the same behaviour to keep this suite
		// honest about the fix.
		const resetDefaults = new Map(fake.state.elements.map((e) => [e.name, structuredClone(e)]));
		const regions = new Set(['screen', 'top', 'view', 'sbar', 'ibar', 'hbar', 'sfree', 'ifree', 'hfree']);
		const parentFromPlace = (value) => {
			const name = String(value ?? '').replace(/^@/, '');
			return regions.has(name) ? null : fake.state.elements.find((e) => e.name === name)?.name ?? null;
		};
		const aligned = (start, size, content, align, offset) => {
			switch (align) {
			case 'center': return start + Math.trunc((size - content) / 2) + offset;
			case 'right': case 'bottom': return start + size - content + offset;
			case 'before': return start - content + offset;
			case 'after': return start + size + offset;
			default: return start + offset;
			}
		};
		// Minimal fake of the engine-owned placement boundary: enough to fold the
		// fixture's screen/element anchors and recursively move children. Product
		// code still consumes only rects exported by this side of the wire.
		function reflow(element, seen = new Set()) {
			if (!element?.rect || seen.has(element.name)) return;
			seen.add(element.name);
			const parent = element.parent ? fake.state.elements.find((e) => e.name === element.parent) : null;
			const area = parent?.rect ?? {
				x: 0, y: 0,
				w: fake.state.screen.vid_width, h: fake.state.screen.vid_height,
			};
			element.rect.x = aligned(area.x, area.w, element.rect.w,
				String(element.align_x).toLowerCase(), Number(element.pos_x) || 0);
			element.rect.y = aligned(area.y, area.h, element.rect.h,
				String(element.align_y).toLowerCase(), Number(element.pos_y) || 0);
			for (const child of fake.state.elements.filter((e) => e.parent === element.name)) {
				reflow(child, seen);
			}
		}

		// What the engine would do with the line, not what it was told: a cvar
		// the plugin never registered is set in the engine but absent from the
		// next state export, so folding it in would hide the drift report's whole
		// reason to exist.
		function fold(line) {
			const demoSpeed = /^demo_setspeed\s+(0|100)$/i.exec(line.trim());
			if (demoSpeed) {
				fake.state.demo.cl_demospeed = demoSpeed[1] === '0' ? '0' : '1';
				return;
			}
			if (line.trim().toLowerCase() === 'hud_reset_layout') {
				for (const element of fake.state.elements) {
					const base = resetDefaults.get(element.name);
					if (!base) {
						continue;
					}
					for (const field of ['place', 'parent', 'align_x', 'align_y', 'pos_x', 'pos_y']) {
						element[field] = base[field];
					}
					element.shown = base.shown;
					if (element.rect && base.rect) {
						element.rect = { ...base.rect };
					}
				}
				return;
			}
			// core/fte-adapter.js's wireLine() now prefixes every cvar write
			// with `set` (v2 of #15's set-prefix fix); strip it here the same
			// way FTE's own Cmd_Set does, case-insensitively, so folding sees
			// the same "<cvar> <value>" shape it always has.
			const unset = line.replace(/^set\s+/i, '');
			const m = /^(\S+)\s+(?:"([^"]*)"|(.+?))\s*$/.exec(unset);
			if (!m) {
				return;
			}
			const cvar = m[1].toLowerCase();
			const value = m[2] !== undefined ? m[2] : m[3];
			const hit = owner(cvar);
			if (!hit) {
				return;
			}
			const { element, suffix } = hit;
			if (suffix === 'pos_x' || suffix === 'pos_y') {
				element[suffix] = value;
				reflow(element);
				return;
			}
			if (suffix === 'show') {
				element.shown = value !== '0';
				return;
			}
			if (PLACEMENT.has(suffix)) {
				element[suffix] = value;
				if (suffix === 'place') {
					element.parent = parentFromPlace(value);
				}
				if (suffix === 'place' || suffix === 'align_x' || suffix === 'align_y') {
					reflow(element);
				}
				return;
			}
			if (Object.prototype.hasOwnProperty.call(element.cvars, cvar)) {
				element.cvars[cvar] = value;
			}
		}

		// FTEC first, and handleevent with it: boot.js's watch() stops ticking as
		// soon as a state with rects arrives (it clears its own interval), so a
		// keyboard listener installed after the state export would never be seen
		// by releaseKeyboard() and case 7 would pass for the wrong reason.
		const handle = (ev) => { fake.engineEvents.push(ev.type); };
		window.FTEC = {
			handleevent: handle,
			cbufadd(line) {
				const text = String(line).replace(/\n+$/, '');
				fake.sent.push(text);
				if (fake.refuseDemo && /^demo_setspeed\b/i.test(text)) {
					throw new Error('demo_setspeed refused by fake backend');
				}
				fold(text);
			},
		};
		// ftejslib.js:603-609 registers exactly these, capture phase, on document
		// (plus beforeunload on window). Same shape here, or removing them proves
		// nothing.
		for (const type of ['keypress', 'keydown', 'keyup']) {
			document.addEventListener(type, handle, true);
		}
		window.addEventListener('beforeunload', handle, true);
		// On body rather than on document: a capture listener on document sees it
		// either way, and app.js's window-level nudge reads ev.target.matches(),
		// which only an Element has. A real keystroke always targets one.
		document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
		fake.registered = fake.engineEvents.length;

		window.Module._EZHud_StateJSON = () => 1;
		// stateReads counts poll ticks, so a case can wait for "the app has
		// seen this state" instead of sleeping (case 5's mid-edit tick).
		fake.stateReads = 0;
		window.Module.UTF8ToString = (ptr) => {
			if (!ptr) {
				return '';
			}
			fake.stateReads += 1;
			return JSON.stringify(fake.state);
		};
	}, { state: FIXTURE, canvas: CANVAS });

	assert(await page.evaluate(() => window.__fake.registered) === 1,
		'the fake engine keyboard listener never fired, so case 7 could not prove a removal');

	const factors = scaleFactors(SCREEN, CANVAS);
	assert(factors.kx !== factors.ky,
		`fixture must exercise unequal axes, got ${JSON.stringify(factors)}`);

	// ---- 1. control ---------------------------------------------------------
	// TESTING.md's rule: prove the thing works at all before proving it works
	// under stress, or a green suite can be reporting on an editor that never
	// drew anything.
	await page.waitForSelector('#overlay .box');
	await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'Live');

	const rows = await page.locator('.tree__row').evaluateAll(
		(nodes) => nodes.map((n) => n.dataset.name));
	// Sorted, because the tree orders by name and nesting rather than by the
	// order the plugin happened to register the elements in.
	const expectedRows = FIXTURE.elements.map((e) => e.name).sort().join(',');
	assert(rows.join(',') === expectedRows,
		`tree does not list the fixture's elements: ${rows.join(',')}`);
	assert(await page.locator('#overlay .box').count() === 3,
		'the overlay should draw a box for each of the three elements with a rect');
	assert(await page.locator('#engine').textContent() === 'fteqw ezhud (web)',
		'the top bar does not name the FTE backend');

	await page.locator('.tree__row[data-name="health"]').click();
	assert(await page.locator('#inspector .inspect__name').textContent() === 'health',
		'clicking a tree row did not open the inspector on that element');
	await page.locator('#overlay .box[data-selected="true"]').waitFor();

	// The percentage-sized element is here to prove the refusal survives the
	// backend swap: same model code, different transport.
	await page.locator('.tree__row[data-name="radar"]').click();
	assert(await page.locator('#overlay .box[data-selected="true"] .handle').count() === 0,
		'percentage-sized radar unexpectedly received corner handles on the FTE backend');
	await page.locator('.tree__row[data-name="health"]').click();

	console.log('  1 control: tree, selection and inspector');

	// ---- 2. drag ------------------------------------------------------------
	const before = named(await engineState(), 'health');
	const sentBeforeDrag = (await sentLines()).length;
	const frameWidth = await page.locator('#frame').evaluate((node) => node.clientWidth);
	const cssDelta = { x: 40, y: 40 };
	const expectedDelta = displayDeltaToConsole(cssDelta.x, cssDelta.y, SCREEN, CANVAS, frameWidth);
	const expectedPos = {
		x: Math.trunc(Number(before.pos_x) + expectedDelta.dx),
		y: Math.trunc(Number(before.pos_y) + expectedDelta.dy),
	};
	assert(expectedPos.x !== expectedPos.y,
		'the drag must land different numbers per axis or it cannot prove kx and ky are used separately');

	const box = page.locator('#overlay .box[data-selected="true"]');
	const bounds = await box.boundingBox();
	assert(bounds, 'the selected health box is not interactable');
	await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
	await page.mouse.down();
	await page.mouse.move(
		bounds.x + bounds.width / 2 + cssDelta.x,
		bounds.y + bounds.height / 2 + cssDelta.y,
		{ steps: 5 },
	);
	await page.mouse.up();

	// Wait on the editor having read the engine's answer back, not on a timer:
	// the tree's meta cell is the element's rect as the last poll reported it.
	const settled = {
		x: before.rect.x + (expectedPos.x - Number(before.pos_x)),
		y: before.rect.y + (expectedPos.y - Number(before.pos_y)),
	};
	await page.waitForFunction((text) => document.querySelector(
		'.tree__row[data-name="health"] .tree__meta')?.textContent === text, `${settled.x},${settled.y}`);

	const dragged = named(await engineState(), 'health');
	assert(Number(dragged.pos_x) === expectedPos.x,
		`drag x did not use kx: expected ${expectedPos.x}, got ${dragged.pos_x}`);
	assert(Number(dragged.pos_y) === expectedPos.y,
		`drag y did not use ky: expected ${expectedPos.y}, got ${dragged.pos_y}`);

	const dragLines = (await sentLines()).slice(sentBeforeDrag);
	assert(dragLines.length > 0, 'the drag sent nothing to FTEC');
	// wireLine() prefixes every cvar write with `set` (v2 of #15's set-prefix
	// fix); placement writes are cvars, not bare commands, so they get it too.
	for (const line of dragLines) {
		assert(/^set hud_health_pos_[xy] -?\d+$/.test(line),
			`drag sent something outside the placement allowlist: ${JSON.stringify(line)}`);
	}
	assert(dragLines.some((l) => l.startsWith('set hud_health_pos_x '))
		&& dragLines.some((l) => l.startsWith('set hud_health_pos_y ')),
		'the drag did not write both placement cvars');

	// Where the box actually landed, against what core/geometry.js says those
	// cvar values mean. This is the assertion a "the right string was sent" test
	// cannot make.
	const measured = await page.evaluate(() => {
		const frame = document.querySelector('#frame').getBoundingClientRect();
		const b = document.querySelector('#overlay .box[data-selected="true"]').getBoundingClientRect();
		return { frame: { left: frame.left, top: frame.top, width: frame.width }, box: { left: b.left, top: b.top, width: b.width, height: b.height } };
	});
	const expectedRect = consoleToFrame(dragged.rect, SCREEN, CANVAS);
	const displayScale = measured.frame.width / CANVAS[0];
	near(measured.box.left - measured.frame.left, expectedRect.x * displayScale, 'health box x');
	near(measured.box.top - measured.frame.top, expectedRect.y * displayScale, 'health box y');
	near(measured.box.width, Math.max(expectedRect.w * displayScale, 3), 'health box width');
	near(measured.box.height, Math.max(expectedRect.h * displayScale, 3), 'health box height');

	console.log('  2 drag: placement cvars and the overlay rect geometry.js predicts');

	// ---- 3. allowlist -------------------------------------------------------
	// currentBridge() through the mapped specifier, which is also the proof that
	// the import map is doing its job: '/core/bridge.js' resolves to the FTE
	// adapter, so this is the Bridge app.js is polling, not a second one.
	const sentBeforeRefusals = (await sentLines()).length;
	const refusals = await page.evaluate(async () => {
		const bridge = (await import('/core/bridge.js')).currentBridge();
		const out = [];
		for (const command of ['quit', 'hud_web_port 99']) {
			try {
				await bridge.send(command);
				out.push({ command, status: 'accepted' });
			} catch (err) {
				out.push({ command, status: err.status, message: err.message });
			}
		}
		return out;
	});
	for (const result of refusals) {
		assert(result.status === 403,
			`${result.command} was not refused with 403: ${JSON.stringify(result)}`);
	}
	assert((await sentLines()).length === sentBeforeRefusals,
		'a refused command still reached FTEC');

	console.log('  3 allowlist: quit and hud_web_port refused, nothing reached FTEC');

	// ---- 4. import ----------------------------------------------------------
	// A real DataTransfer drop on #fte-drop, so the drop handler, importFile's
	// extension dispatch, importCfg's apply loop and the drift renderer all run.
	await page.evaluate(({ text, name }) => {
		const dt = new DataTransfer();
		dt.items.add(new File([text], name, { type: 'text/plain' }));
		document.getElementById('fte-drop').dispatchEvent(
			new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
	}, { text: IMPORT_CFG, name: IMPORT_NAME });

	await page.waitForFunction(() => document.querySelector('#fte-note')?.textContent.includes('applied'));
	const note = await page.locator('#fte-note').textContent();
	assert(note === `${IMPORT_NAME}: applied ${IMPORT_APPLIED} of ${IMPORT_LINES} lines.`,
		`import note reads ${JSON.stringify(note)}`);

	// Two things, not three: scr_newhud and r_tracker are in the adapter's
	// ledger now, so the synthetic state does report them back — only
	// gl_consolefont stays unpreviewed.
	const summary = await page.locator('#fte-drift-summary').textContent();
	assert(summary === `${IMPORT_NAME}: ${IMPORT_APPLIED} applied, 2 things this preview cannot show`,
		`drift summary reads ${JSON.stringify(summary)}`);
	const drift = await page.locator('#fte-drift-body').textContent();
	assert(drift.includes('dogtag — 1 cvar'),
		'the drift panel does not name the element FTE never registered');
	assert(drift.includes('gl_consolefont'),
		'the drift panel does not list the cvar the state cannot report back');
	assert(!drift.includes('scr_newhud') && !drift.includes('r_tracker'),
		'a ledger-tracked cvar is still reported as something the preview cannot show');
	assert(drift.includes('gl_consolefont "povo5f" → gl_font'),
		'the drift panel does not report the charset cvar translation');
	assert(drift.includes('2 lines carried verbatim'),
		'the drift panel does not count the retained lines');
	assert(await page.locator('#fte-drift').getAttribute('hidden') === null,
		'the drift panel stayed hidden after an import that lost things');

	// The closed loop again: the file said 12, the engine holds 12.
	await page.waitForFunction(() => window.__fake.state.elements
		.find((e) => e.name === 'health').pos_x === '12');
	assert(named(await engineState(), 'health').cvars.hud_health_scale === '2',
		'the imported scale never reached the engine');

	console.log('  4 import: applied count, drift report and the values in the engine');

	// ---- 5. export ----------------------------------------------------------
	// One deliberate edit through the inspector, the way a user would make it.
	const scaleField = page.locator('#inspector .field', { has: page.locator('label', { hasText: /^scale$/ }) }).locator('input');
	await scaleField.fill('3');
	// A state tick lands mid-edit, on purpose: mutate the selected element's
	// fingerprint and let the poll loop see it before Enter. Without the
	// focus-guard in renderInspector this rebuilds the section, the focused
	// input is replaced, and the typed value silently never reaches the engine
	// — which is exactly how this case failed on a slow CI runner while
	// passing on fast machines. Deterministic here, timing-free.
	// rect is in the fingerprint but not in any export path, so the tick is
	// provoked without disturbing the byte-identity assertions below.
	const [ticksBefore, savedRect] = await page.evaluate(() => {
		const health = window.__fake.state.elements.find((e) => e.name === 'health');
		const saved = health.rect;
		health.rect = null;
		return [window.__fake.stateReads, saved];
	});
	await page.waitForFunction((n) => window.__fake.stateReads > n + 1, ticksBefore);
	assert(await scaleField.inputValue() === '3',
		'the mid-edit state tick rebuilt the inspector and discarded the typed value');
	await page.evaluate((rect) => {
		window.__fake.state.elements.find((e) => e.name === 'health').rect = rect;
	}, savedRect);
	await scaleField.press('Enter');   // app.js blurs on Enter, which fires change
	await page.waitForFunction(() => window.__fake.state.elements
		.find((e) => e.name === 'health').cvars.hud_health_scale === '3');

	const exported = await page.evaluate(async () =>
		(await import('/core/bridge.js')).currentBridge().exportFullCfg());
	const original = IMPORT_CFG.split('\n');
	const written = exported.split('\n');
	assert(written.length === original.length,
		`export changed the line count: ${original.length} in, ${written.length} out`);
	const differing = original.map((line, i) => [i, line, written[i]]).filter(([, a, b]) => a !== b);
	assert(differing.length === 1,
		`expected exactly the edited line to differ, got ${JSON.stringify(differing)}`);
	assert(differing[0][1] === 'hud_health_scale 2' && differing[0][2] === 'hud_health_scale "3"',
		`the wrong line was rewritten: ${JSON.stringify(differing[0])}`);

	console.log('  5 export: one edited line rewritten, the rest byte-identical');

	// ---- 6. hud system + killfeed -------------------------------------------
	// Both blocks are synthetic on this backend: the adapter's ledger answers
	// for cvars the plugin ignores. The sections must render, start on what
	// actually happened (+scr_newhud 1 from boot, r_tracker 0 from the import),
	// carry the honesty note, and still land every edit in the export.
	await page.waitForSelector('#hudmodes .seg__item');
	assert(await page.locator('#hudmodes .seg__item', { hasText: 'New' })
		.getAttribute('data-on') === 'true',
	'the HUD system switch does not show "New" active after boot');
	// The engine pin carries the plugin-side scr_newhud (#15 P1), so the note
	// now claims the switch drives the preview for real and scopes the caveat
	// to the QW262 overlay + ledger-backed readback.
	const modeNotes = await page.locator('#hudmodes .font-state').allTextContents();
	assert(modeNotes.some((t) => t.includes('drives the engine preview for real')),
		'the HUD system section is missing the updated P1 honesty note');
	assert(!modeNotes.some((t) => t.includes("Preview can't mirror this on the FTE backend")),
		'the HUD system section still shows the pre-P1 blanket note');

	const sentBeforeModes = (await sentLines()).length;
	await page.locator('#hudmodes .seg__item', { hasText: 'Classic' }).click();
	await page.waitForFunction(() => [...document.querySelectorAll('#hudmodes .seg__item')]
		.some((b) => b.textContent === 'Classic' && b.dataset.on === 'true'));
	const modeLines = (await sentLines()).slice(sentBeforeModes);
	// wireLine() prefixes cvar writes with `set` (v2 of #15's set-prefix fix).
	assert(modeLines.includes('set scr_newhud 0'),
		`clicking Classic sent ${JSON.stringify(modeLines)} instead of set scr_newhud 0`);

	// The plugin's vx_tracker.c registers the ezQuake-dialect r_tracker* cvars
	// natively now (#15 P2), so the note narrows to three remaining honest
	// exceptions: pickups (stubbed, no event source), weapon-icon style, and
	// silencing the console echo (con_fragmessages does not stop the engine's
	// own print -- verified live against the real dist, #15 fragfile proof).
	const killfeedNotes = await page.locator('#killfeed .font-state').allTextContents();
	assert(killfeedNotes.some((t) => t.includes('pickups') && t.includes('weapon-icon style')
		&& t.includes('console echo')),
		'the killfeed section is missing the narrowed #15 P2/P3 honesty note');
	assert(!killfeedNotes.some((t) => t.includes("Preview can't mirror this on the FTE backend")),
		'the killfeed section still shows the old blanket honesty note');

	// The imported r_tracker 0 seeded the ledger (con_fragmessages stays at its
	// default 1), so the seg must start on Console messages.
	assert(await page.locator('#killfeed .seg__item', { hasText: 'Console messages' })
		.getAttribute('data-on') === 'true',
	'the imported r_tracker 0 did not seed the killfeed seg');

	const sentBeforeKillfeed = (await sentLines()).length;
	await page.locator('#killfeed .seg__item', { hasText: 'Dedicated killfeed' }).click();
	await page.waitForFunction(() => [...document.querySelectorAll('#killfeed .seg__item')]
		.some((b) => b.textContent === 'Dedicated killfeed' && b.dataset.on === 'true'));
	const killfeedLines = (await sentLines()).slice(sentBeforeKillfeed);
	// wireLine() prefixes cvar writes with `set` (v2 of #15's set-prefix fix,
	// re-implemented here now that the translation layer that blocked it in
	// the original PR #17 is retired).
	assert(killfeedLines.includes('set r_tracker 1') && killfeedLines.includes('set con_fragmessages 0'),
		`the killfeed seg sent ${JSON.stringify(killfeedLines)} instead of the pair`);
	// No FTE-dialect side-write: the plugin's own r_tracker IS the cvar the
	// tracker reads, so the ezQuake pair above is the whole story.
	assert(!killfeedLines.includes('set r_tracker_frags 2') && !killfeedLines.includes('r_tracker_frags 2'),
		`the killfeed seg sent ${JSON.stringify(killfeedLines)}, but the translation layer is retired -- no r_tracker_frags side-write should appear`);

	// §D4's round trip: the imported r_tracker line is rewritten to the edit,
	// scr_newhud likewise, con_fragmessages (never in the file) is appended,
	// and everything else — including case 5's scale edit — stays put.
	const exported2 = (await page.evaluate(async () =>
		(await import('/core/bridge.js')).currentBridge().exportFullCfg())).split('\n');
	const expected2 = IMPORT_CFG.split('\n').slice(0, -1).map((line) =>
		line === 'hud_health_scale 2' ? 'hud_health_scale "3"'
			: line === 'r_tracker 0' ? 'r_tracker "1"'
				: line === 'scr_newhud 1' ? 'scr_newhud "0"'
					: line);
	expected2.push('', '// added in ez-hud', 'con_fragmessages "0"', '');
	assert(JSON.stringify(exported2) === JSON.stringify(expected2),
		`killfeed/newhud export mismatch:\n--- got ---\n${exported2.join('\n')}\n--- want ---\n${expected2.join('\n')}`);

	console.log('  6 hud system + killfeed: synthetic blocks render, note shown, edits exported');

	// ---- 7. demo picker -----------------------------------------------------
	await page.waitForFunction(() => document.querySelector('#fte-demo')?.options.length >= 3);
	const sentBeforeDemo = (await sentLines()).length;
	await page.selectOption('#fte-demo', 'qw/demos/tb4gf_book_vs_s.mvd');
	await page.waitForFunction((n) => window.__fake.sent.length > n, sentBeforeDemo);
	const demoLines = (await sentLines()).slice(sentBeforeDemo);
	// Gamedir-relative, no 'qw/': the manifest's `basegame qw` is already the
	// active gamedir, and 'playdemo qw/demos/x.mvd' finds nothing (boot.js:52).
	assert(demoLines.length === 1 && demoLines[0] === 'playdemo demos/tb4gf_book_vs_s.mvd',
		`the demo picker sent ${JSON.stringify(demoLines)}`);

	console.log('  7 demo picker: playdemo through the host path, gamedir-relative');

	// ---- 8. demo pause/resume -----------------------------------------------
	// The fake cursor represents consumed demo packets, not cl.time: FTE keeps
	// cl.time advancing while frozen, so a wall/game clock would prove the wrong
	// thing. The visible button must follow state.demo.cl_demospeed as app.js
	// polls it, and the cursor must stop and restart around the GUI gestures.
	const pause = page.locator('#fte-pause');
	await pause.waitFor();
	await page.waitForFunction(() => !document.querySelector('#fte-pause')?.disabled);
	const runningFrom = await page.evaluate(() => window.__fake.demoCursor);
	await page.waitForTimeout(300);
	assert(await page.evaluate(() => window.__fake.demoCursor) > runningFrom,
		'the fake demo cursor did not advance before pausing');

	const sentBeforePause = (await sentLines()).length;
	await pause.click();
	await page.waitForFunction((n) => window.__fake.sent.length > n, sentBeforePause);
	assert((await sentLines()).slice(sentBeforePause).includes('demo_setspeed 0'),
		'the pause toggle did not send demo_setspeed 0');
	await page.waitForFunction(() => document.querySelector('#fte-pause')?.getAttribute('aria-pressed') === 'true');
	const frozenAt = await page.evaluate(() => window.__fake.demoCursor);
	await page.waitForTimeout(1100);
	assert(await page.evaluate(() => window.__fake.demoCursor) === frozenAt,
		'the fake demo packet cursor advanced while paused');

	await pause.click();
	await page.waitForFunction(() => document.querySelector('#fte-pause')?.getAttribute('aria-pressed') === 'false');
	const resumedAt = await page.evaluate(() => window.__fake.demoCursor);
	await page.waitForTimeout(300);
	assert(await page.evaluate(() => window.__fake.demoCursor) > resumedAt,
		'the fake demo packet cursor did not advance after resume');
	assert((await sentLines()).includes('demo_setspeed 100'),
		'the pause toggle did not send the percent-form resume command demo_setspeed 100');
	console.log('  8 demo pause: fake packet cursor stops on 0 and resumes on percent-form 100');

	// ---- 9. external engine-state readback ----------------------------------
	const readsBeforeConsolePause = await page.evaluate(() => window.__fake.stateReads);
	await page.evaluate(() => window.FTEC.cbufadd('demo_setspeed 0\n'));
	await page.waitForFunction(() => document.querySelector('#fte-pause')?.getAttribute('aria-pressed') === 'true');
	assert(await page.evaluate(() => window.__fake.stateReads) > readsBeforeConsolePause,
		'the pause toggle changed without a subsequent engine-state poll');
	await page.evaluate(() => window.FTEC.cbufadd('demo_setspeed 100\n'));
	await page.waitForFunction(() => document.querySelector('#fte-pause')?.getAttribute('aria-pressed') === 'false');
	console.log('  9 demo pause readback: out-of-band engine commands drive the toggle on poll');

	// ---- 10. disabled/refused backend ---------------------------------------
	await page.evaluate(() => { window.__fake.refuseDemo = true; });
	await pause.click();
	await page.waitForFunction(() => document.querySelector('#fte-pause')?.disabled
		&& !document.querySelector('#fte-pause-reason')?.hidden);
	assert(/unavailable|refused/i.test(await page.locator('#fte-pause-reason').textContent()),
		'the refused command path did not show an honest reason');
	await page.waitForTimeout(1100);
	const pauseWarnings = await page.evaluate(async () => {
		const log = await import('/core/log.js');
		return log.snapshot().filter((entry) => entry.level === 'warn'
			&& /demo pause unavailable/i.test(entry.msg));
	});
	assert(pauseWarnings.length === 1,
		`the refused backend produced ${pauseWarnings.length} demo-pause warnings instead of one`);
	console.log('  10 demo pause refusal: disabled reason shown and exactly one warn logged');

	// ---- 11. reload guard ----------------------------------------------------
	// The contract the boot race fix bought, not its timing: whatever FTEC
	// registered on document is gone once the engine is drawing, so the editor
	// gets its own keystrokes and location.reload() is not blocked.
	await page.waitForFunction(() => {
		const fake = window.__fake;
		const seen = fake.engineEvents.length;
		document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
		window.dispatchEvent(new Event('beforeunload'));
		return fake.engineEvents.length === seen;
	}, null, { polling: 100 });

	await page.locator('.tree__row[data-name="health"]').click();
	const nudgeFrom = Number(named(await engineState(), 'health').pos_x);
	const eventsBefore = await page.evaluate(() => window.__fake.engineEvents.length);
	await page.keyboard.press('ArrowRight');
	// app.js's own arrow-key nudge listens on window and bubbles, which a
	// capture-phase guard of ours would have stopped: the released listener has
	// to be gone, not merely silenced.
	await page.waitForFunction((n) => window.__fake.state.elements
		.find((e) => e.name === 'health').pos_x === String(n + 1), nudgeFrom);
	assert(await page.evaluate(() => window.__fake.engineEvents.length) === eventsBefore,
		'FTE\'s own keyboard listener is still on document after the engine came up');

	console.log('  11 reload guard: engine key and beforeunload listeners released');

	// ---- 12. alignment-first editing (#32) ----------------------------------
	// Start from authored controls, then judge only the fake engine's exported
	// parent/cvars/rects. DOM geometry is used solely for the drag gesture and for
	// the relationship line's presence, never as placement truth.
	await page.locator('.tree__row[data-name="armor"]').click();
	assert(await page.locator('#inspector .placement-workflow').count() === 1,
		'the inspector has no first-class anchor/alignment workflow');
	const setPlacementField = async (id, value) => {
		const control = page.locator(`#${id}`);
		await control.waitFor();
		if (await control.evaluate((node) => node.tagName === 'SELECT')) {
			await control.selectOption(String(value));
		} else {
			await control.fill(String(value));
			await control.press('Enter');
		}
	};
	await setPlacementField('f-armor-place', '@health');
	await setPlacementField('f-armor-align_x', 'left');
	await setPlacementField('f-armor-align_y', 'top');
	await setPlacementField('f-armor-pos_x', '0');
	await setPlacementField('f-armor-pos_y', '0');
	await setPlacementField('f-armor-order', '7');
	await page.waitForFunction(() => {
		const armor = window.__fake.state.elements.find((e) => e.name === 'armor');
		const health = window.__fake.state.elements.find((e) => e.name === 'health');
		return armor.parent === 'health' && armor.order === '7'
			&& armor.rect.x === health.rect.x && armor.rect.y === health.rect.y;
	});
	await page.waitForSelector('#overlay .anchor-link[data-child="armor"][data-anchor="health"]');

	// One parent drag moves both engine rects by the same delta.
	const beforeGroupDrag = await engineState();
	await page.locator('.tree__row[data-name="health"]').click();
	const parentBox = page.locator('#overlay .box[data-selected="true"]');
	const parentBounds = await parentBox.boundingBox();
	assert(parentBounds, 'anchored parent has no draggable overlay box');
	await page.mouse.move(parentBounds.x + parentBounds.width / 2, parentBounds.y + parentBounds.height / 2);
	await page.mouse.down();
	await page.mouse.move(parentBounds.x + parentBounds.width / 2 + 32,
		parentBounds.y + parentBounds.height / 2, { steps: 4 });
	await page.mouse.up();
	await page.waitForFunction((previous) => window.__fake.state.elements
		.find((e) => e.name === 'health').pos_x !== previous,
		named(beforeGroupDrag, 'health').pos_x);
	const afterGroupDrag = await engineState();
	const parentDx = named(afterGroupDrag, 'health').rect.x - named(beforeGroupDrag, 'health').rect.x;
	const childDx = named(afterGroupDrag, 'armor').rect.x - named(beforeGroupDrag, 'armor').rect.x;
	assert(parentDx !== 0 && childDx === parentDx,
		`parent/child engine rects did not move together: ${parentDx} vs ${childDx}`);

	// Three alignments and a fine-tune offset are exact against engine rects.
	await page.locator('.tree__row[data-name="armor"]').click();
	for (const alignment of ['left', 'center', 'right']) {
		await setPlacementField('f-armor-align_x', alignment);
		await page.waitForFunction((wanted) => window.__fake.state.elements
			.find((e) => e.name === 'armor').align_x === wanted, alignment);
		const state = await engineState();
		const parent = named(state, 'health').rect;
		const child = named(state, 'armor').rect;
		const expected = alignment === 'left' ? parent.x
			: alignment === 'center' ? parent.x + Math.trunc((parent.w - child.w) / 2)
				: parent.x + parent.w - child.w;
		assert(child.x === expected,
			`${alignment} engine alignment expected x=${expected}, got ${child.x}`);
	}
	await setPlacementField('f-armor-pos_x', '7');
	await setPlacementField('f-armor-pos_y', '9');
	await page.waitForFunction(() => window.__fake.state.elements
		.find((e) => e.name === 'armor').pos_y === '9');
	{
		const state = await engineState();
		const parent = named(state, 'health').rect;
		const child = named(state, 'armor').rect;
		assert(child.x === parent.x + parent.w - child.w + 7 && child.y === parent.y + 9,
			`fine-tune offsets did not land on top of the anchor: ${JSON.stringify({ parent, child })}`);
	}

	// The relationship visualization follows a changed anchor.
	await setPlacementField('f-armor-place', '@radar');
	await page.waitForSelector('#overlay .anchor-link[data-child="armor"][data-anchor="radar"]');
	await setPlacementField('f-armor-place', '@health');
	await page.waitForSelector('#overlay .anchor-link[data-child="armor"][data-anchor="health"]');

	// A parent cannot be anchored to its own descendant. The option remains
	// visible so the refusal explains itself instead of silently disappearing.
	await page.locator('.tree__row[data-name="health"]').click();
	const cycleOption = page.locator('#f-health-place option[value="@armor"]');
	assert(await cycleOption.isDisabled(), 'the descendant anchor option is not disabled');
	assert(/unavailable.*cycle/i.test(await cycleOption.textContent()),
		'the disabled cycle option does not state why it was refused');

	// Export the relationship, disturb it, then feed those exact bytes through
	// the shipping import path. Parent readback, not a frozen rect, is the pass.
	const anchoredCfg = await page.evaluate(async () =>
		(await import('/core/bridge.js')).currentBridge().exportFullCfg());
	assert(anchoredCfg.split('\n').includes('hud_armor_place "@health"'),
		'the full export omitted the anchor relationship');
	assert(anchoredCfg.split('\n').includes('hud_armor_align_x "right"')
		&& anchoredCfg.split('\n').includes('hud_armor_pos_x "7"')
		&& anchoredCfg.split('\n').includes('hud_armor_pos_y "9"'),
		'the full export omitted alignment or fine-tune offsets');
	await page.evaluate(async () => {
		const bridge = (await import('/core/bridge.js')).currentBridge();
		await bridge.setCvar('hud_armor_place', 'screen');
		await bridge.send('hud_recalculate');
	});
	await page.waitForFunction(() => window.__fake.state.elements
		.find((e) => e.name === 'armor').parent === null);
	await page.evaluate((text) => {
		const transfer = new DataTransfer();
		transfer.items.add(new File([text], 'anchored-roundtrip.cfg', { type: 'text/plain' }));
		document.getElementById('fte-drop').dispatchEvent(
			new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
	}, anchoredCfg);
	await page.waitForFunction(() => window.__fake.state.elements
		.find((e) => e.name === 'armor').parent === 'health');
	console.log('  12 alignment-first: anchor/group move, 3 alignments, offsets, relationship line, cycle refusal, round trip');

	// ---- 13. reset positions -------------------------------------------------
	// The tracker cvar-wiring fix (fix/tracker-cvar-wiring): plugins/ezhud/hud.c
	// gained HUD_ResetLayout_f, ported from ezQuake's engine-integration.diff, so
	// the FTE-web preview's "Reset positions..." button (which has always sent
	// `hud_reset_layout`) actually does something instead of hitting "Unknown
	// command". Move an element, then prove the button reverts it. Run before
	// the volume case below, which ends in a page reload that kills the fake.
	await page.locator('.tree__row[data-name="health"]').click();
	await page.evaluate(async () => {
		const bridge = (await import('/core/bridge.js')).currentBridge();
		await bridge.setCvar('hud_health_pos_x', 250);
		await bridge.setCvar('hud_health_pos_y', 260);
	});
	await page.waitForFunction(() => window.__fake.state.elements
		.find((e) => e.name === 'health').pos_x === '250');

	const sentBeforeReset = (await sentLines()).length;
	await page.locator('button', { hasText: 'Reset positions' }).first().click();
	await page.waitForSelector('#reset-dialog[open]');
	await page.locator('#reset-dialog button', { hasText: 'Reset' }).click();
	await page.waitForFunction((n) => window.__fake.sent.length > n, sentBeforeReset);
	const resetLines = (await sentLines()).slice(sentBeforeReset);
	assert(resetLines.includes('hud_reset_layout'),
		`the reset button sent ${JSON.stringify(resetLines)} instead of the bare hud_reset_layout command`);
	await page.waitForFunction(() => window.__fake.state.elements
		.find((e) => e.name === 'health').pos_x === '16');
	const healthAfterReset = named(await engineState(), 'health');
	assert(healthAfterReset.pos_x === '16' && healthAfterReset.pos_y === '24',
		`reset did not restore health's registered pos_x/pos_y, got ${JSON.stringify(healthAfterReset)}`);

	console.log('  13 reset positions: hud_reset_layout reverts a moved element to its registered default');

	// ---- 14. snap grid + magnet alignment (#24) -----------------------------
	const gridToggle = page.locator('#snap-grid');
	const magnetToggle = page.locator('#snap-magnet');
	const gridStep = page.locator('#snap-step');
	await gridToggle.waitFor();
	assert(!(await gridToggle.isChecked()) && !(await magnetToggle.isChecked()),
		'drag assistance must start visibly off rather than silently changing old drags');
	const setEnginePlacement = async (name, x, y) => {
		await page.evaluate(async ([element, px, py]) => {
			const bridge = (await import('/core/bridge.js')).currentBridge();
			await bridge.setCvar(`hud_${element}_pos_x`, px);
			await bridge.setCvar(`hud_${element}_pos_y`, py);
		}, [name, x, y]);
		await page.waitForFunction(([element, px, py]) => {
			const current = window.__fake.state.elements.find((e) => e.name === element);
			return current.pos_x === String(px) && current.pos_y === String(py);
		}, [name, x, y]);
		await page.waitForFunction((element) => {
			const current = window.__fake.state.elements.find((e) => e.name === element);
			return document.querySelector(`.tree__row[data-name="${element}"] .tree__meta`)?.textContent
				=== `${current.rect.x},${current.rect.y}`;
		}, name);
	};
	const dragHealth = async (dx, dy, { alt = false, beforeUp = null } = {}) => {
		await page.locator('.tree__row[data-name="health"]').click();
		const selectedHealth = page.locator('#overlay .box[data-selected="true"]');
		const rect = await selectedHealth.boundingBox();
		assert(rect, 'health has no draggable box for snap/magnet cases');
		if (alt) await page.keyboard.down('Alt');
		try {
			await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
			await page.mouse.down();
			await page.mouse.move(rect.x + rect.width / 2 + dx, rect.y + rect.height / 2 + dy,
				{ steps: 4 });
			if (beforeUp) await beforeUp();
			await page.mouse.up();
		} finally {
			if (alt) await page.keyboard.up('Alt');
		}
		return named(await engineState(), 'health');
	};

	await gridToggle.click();
	await setEnginePlacement('health', 13, 24);
	let snapped = await dragHealth(19, 0);
	assert(Number(snapped.pos_x) % 8 === 0,
		`8px grid produced pos_x=${snapped.pos_x}`);
	await gridStep.fill('5');
	await gridStep.press('Enter');
	await setEnginePlacement('health', 13, 24);
	snapped = await dragHealth(19, 0);
	assert(Number(snapped.pos_x) % 5 === 0,
		`5px grid produced pos_x=${snapped.pos_x}`);

	await gridToggle.click();
	await setEnginePlacement('health', 13, 24);
	const free = await dragHealth(5, 0);
	assert(Number(free.pos_x) % 5 !== 0,
		`grid-off drag still quantized pos_x=${free.pos_x} to step 5`);

	await magnetToggle.click();
	await setEnginePlacement('health', 16, 30);
	let magnetTarget = null;
	const magnetized = await dragHealth(1, 1, {
		beforeUp: async () => {
			const guide = page.locator('#overlay .snap-guide--y');
			await guide.waitFor();
			magnetTarget = await guide.getAttribute('data-target');
		},
	});
	const magnetState = await engineState();
	const targetRect = named(magnetState, magnetTarget)?.rect;
	const sourceY = [magnetized.rect.y, magnetized.rect.y + magnetized.rect.h / 2,
		magnetized.rect.y + magnetized.rect.h];
	const targetY = targetRect
		? [targetRect.y, targetRect.y + targetRect.h / 2, targetRect.y + targetRect.h]
		: [];
	assert(sourceY.some((value) => targetY.includes(value)),
		`magnet guide named ${magnetTarget} but no health edge/centre exactly aligned: `
		+ `${JSON.stringify({ sourceY, targetY })}`);

	await magnetToggle.click();
	await setEnginePlacement('health', 16, 30);
	const freeNearEdge = await dragHealth(1, 1);
	assert(freeNearEdge.rect.y + freeNearEdge.rect.h !== named(await engineState(), 'armor').rect.y,
		'magnet-off drag still aligned the two edges');

	await gridToggle.click();
	await magnetToggle.click();
	await gridStep.fill('8');
	await gridStep.press('Enter');
	await setEnginePlacement('health', 17, 30);
	const bypassed = await dragHealth(5, 0, {
		alt: true,
		beforeUp: async () => assert(await page.locator('#overlay .snap-guide').count() === 0,
			'Alt bypass still drew a magnet guide'),
	});
	assert(Number(bypassed.pos_x) % 8 !== 0,
		`Alt bypass still snapped pos_x=${bypassed.pos_x}`);
	const dragExport = await page.evaluate(async () =>
		(await import('/core/bridge.js')).currentBridge().exportFullCfg());
	assert(!/snap|magnet/i.test(dragExport),
		'drag-assistance editor state leaked into the exported cfg');

	await gridToggle.click();
	await magnetToggle.click();
	await page.evaluate(async () => (await import('/core/bridge.js')).currentBridge().send('hud_reset_layout'));
	await page.waitForFunction(() => window.__fake.state.elements
		.find((e) => e.name === 'health').pos_x === '16');
	console.log('  14 drag assistance: grid steps, free drag, edge magnet + guide, Alt bypass, clean export');

	// ---- 15. editor window scaling (#25) ------------------------------------
	// The control scales editor chrome, never HUD coordinates. Its CSS change
	// also has to wake FTE's resize glue because changing a custom property does
	// not itself emit a browser resize event.
	const uiScale = page.locator('#ui-scale');
	await uiScale.waitFor();
	assert(await uiScale.inputValue() === '1',
		'the editor scale did not start at the usable 100% default');
	const layoutAt100 = await page.evaluate(() => {
		const box = (selector) => {
			const rect = document.querySelector(selector).getBoundingClientRect();
			return { width: rect.width, height: rect.height };
		};
		return {
			rail: box('.panel--tree'), inspect: box('.panel--inspect'),
			stage: box('.stage'), frame: box('.stage__frame'), canvas: box('#canvas'),
		};
	});
	assert(layoutAt100.rail.width >= 240 && layoutAt100.inspect.width >= 280
		&& layoutAt100.stage.width >= 600 && layoutAt100.stage.height >= 700,
		`1440p-class default layout is not usable: ${JSON.stringify(layoutAt100)}`);
	near(layoutAt100.canvas.width, layoutAt100.frame.width, 'default canvas/frame width');
	near(layoutAt100.canvas.height, layoutAt100.frame.height, 'default canvas/frame height');

	const placementBeforeScale = named(await engineState(), 'health');
	const sentBeforeScale = (await sentLines()).length;
	const screenBeforeScale = (await engineState()).screen;
	await uiScale.selectOption('1.25');
	await page.waitForFunction(() => localStorage.getItem('ezhud.ui.scale') === '1.25'
		&& getComputedStyle(document.documentElement).getPropertyValue('--ui-scale').trim() === '1.25');
	await page.waitForFunction(([width, height]) => {
		const screen = window.__fake.state.screen;
		return screen.vid_width !== width || screen.vid_height !== height;
	}, [screenBeforeScale.vid_width, screenBeforeScale.vid_height]);
	const layoutAt125 = await page.evaluate(() => {
		const box = (selector) => {
			const rect = document.querySelector(selector).getBoundingClientRect();
			return { width: rect.width, height: rect.height };
		};
		return {
			rail: box('.panel--tree'), inspect: box('.panel--inspect'),
			stage: box('.stage'), frame: box('.stage__frame'), canvas: box('#canvas'),
		};
	});
	assert(layoutAt125.rail.width > layoutAt100.rail.width
		&& layoutAt125.inspect.width > layoutAt100.inspect.width,
		`125% did not visibly enlarge editor chrome: ${JSON.stringify({ layoutAt100, layoutAt125 })}`);
	assert(layoutAt125.stage.width > 500 && layoutAt125.stage.height > 700,
		`125% collapsed the usable stage: ${JSON.stringify(layoutAt125.stage)}`);
	near(layoutAt125.canvas.width, layoutAt125.frame.width, 'scaled canvas/frame width');
	near(layoutAt125.canvas.height, layoutAt125.frame.height, 'scaled canvas/frame height');
	const placementAfterScale = named(await engineState(), 'health');
	assert(placementAfterScale.pos_x === placementBeforeScale.pos_x
		&& placementAfterScale.pos_y === placementBeforeScale.pos_y,
		'editor scaling changed engine placement values');
	assert((await sentLines()).length === sentBeforeScale,
		'editor scaling sent a command to the engine');
	const scaledState = await page.evaluate(async () =>
		(await import('/core/bridge.js')).currentBridge().state());
	assert(scaledState.screen.vid_width === scaledState.physical[0]
		&& scaledState.screen.vid_height === scaledState.physical[1],
		`state.screen did not follow the resized canvas: ${JSON.stringify({ screen: scaledState.screen, physical: scaledState.physical })}`);

	// A second chrome scale must produce a second engine resize, not merely the
	// first one after boot. Leave 125% stored so the volume case's reload proves
	// persistence from actual storage rather than a same-document variable.
	const screenAt125 = structuredClone((await engineState()).screen);
	await uiScale.selectOption('1.5');
	await page.waitForFunction(([width, height]) => {
		const screen = window.__fake.state.screen;
		return screen.vid_width !== width || screen.vid_height !== height;
	}, [screenAt125.vid_width, screenAt125.vid_height]);
	await uiScale.selectOption('1.25');
	await page.waitForFunction(() => localStorage.getItem('ezhud.ui.scale') === '1.25');
	console.log('  15 editor scale: 1440p minimums, visible presets, persistence seed, canvas and state propagation');

	// ---- 16. volume ----------------------------------------------------------
	// The page's own sound knob (#10). The engine side is a plain cvar write, so
	// the assertions are about the contract around it: the quiet boot default,
	// the mute/unmute round trip, the imported line that must never apply, and
	// the localStorage state a reload boots from.
	const bootArgs = await page.evaluate(() => window.Module.arguments.join(' '));
	assert(bootArgs.includes('+volume 0.175'),
		`boot args lack the quiet default +volume 0.175: ${bootArgs}`);
	// Case 4's config said `volume "1"`; the pipeline retains it (cases 5/6
	// proved the export byte-identical) and must never have applied it.
	assert(!(await sentLines()).some((l) => /^(set\s+)?volume\b/i.test(l)),
		'the imported volume line reached the engine');

	// wireLine() prefixes cvar writes with `set` (v2 of #15's set-prefix fix);
	// the volume slider/mute button go through bridge.setCvar(), same as any
	// other cvar.
	const sentBeforeSlider = (await sentLines()).length;
	await page.locator('#fte-volume').evaluate((el) => {
		el.value = '0.4';
		el.dispatchEvent(new Event('input', { bubbles: true }));
	});
	await page.waitForFunction((n) => window.__fake.sent.length > n, sentBeforeSlider);
	assert((await sentLines()).slice(sentBeforeSlider).includes('set volume 0.4'),
		'moving the slider did not send set volume 0.4');
	assert(await page.evaluate(() => localStorage.getItem('ezhud.fte.volume')) === '0.4',
		'the slider value was not persisted');

	const sentBeforeMute = (await sentLines()).length;
	await page.locator('#fte-mute').click();
	await page.waitForFunction((n) => window.__fake.sent.length > n, sentBeforeMute);
	assert((await sentLines()).slice(sentBeforeMute).includes('set volume 0'),
		'muting did not send set volume 0');
	assert(await page.locator('#fte-mute').getAttribute('aria-pressed') === 'true',
		'muting did not flip aria-pressed');
	assert(await page.evaluate(() => localStorage.getItem('ezhud.fte.muted')) === '1',
		'the muted flag was not persisted');

	const sentBeforeUnmute = (await sentLines()).length;
	await page.locator('#fte-mute').click();
	await page.waitForFunction((n) => window.__fake.sent.length > n, sentBeforeUnmute);
	assert((await sentLines()).slice(sentBeforeUnmute).includes('set volume 0.4'),
		'unmuting did not restore the prior volume');
	assert(await page.locator('#fte-mute').getAttribute('aria-pressed') === 'false',
		'unmuting did not flip aria-pressed back');

	// The reload half of persistence: storage now says 0.4/unmuted, so a fresh
	// boot must launch with that value and the slider must read it back. The
	// fake engine dies with the page, which is fine — everything asserted here
	// happens before any engine exists.
	await page.reload();
	await page.waitForFunction(() => Boolean(window.Module && window.EZHUD_FTE));
	const rebootArgs = await page.evaluate(() => window.Module.arguments.join(' '));
	assert(rebootArgs.includes('+volume 0.4'),
		`a reload did not boot at the stored volume: ${rebootArgs}`);
	await page.waitForFunction(() => document.getElementById('fte-volume')?.value === '0.4');
	assert(await page.locator('#fte-mute').getAttribute('aria-pressed') === 'false',
		'the unmuted state did not survive the reload');
	await page.waitForFunction(() => document.getElementById('ui-scale')?.value === '1.25');
	assert(await page.evaluate(() => getComputedStyle(document.documentElement)
		.getPropertyValue('--ui-scale').trim()) === '1.25',
		'the editor scale did not survive the reload');

	console.log('  16 volume: quiet boot default, mute round trip, import refusal, persistence');

	// A second page at DPR 2 is the monitor-move half of #25. Playwright fixes
	// deviceScaleFactor per browser context, so exercise that layout, then change
	// its viewport while DPR stays fixed. Neither path may degenerate the rails or
	// stop the canvas filling its frame.
	const dprPage = await browser.newPage({
		viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2,
	});
	try {
		// Install the same public FTE boundary before the module app starts polling,
		// but no command folding is needed: this page only exercises monitor/layout
		// behaviour. A real rect keeps the live 16:9 stage path active rather than
		// the intentional 4:3 empty-state placeholder.
		await dprPage.addInitScript((state) => {
			window.FTEC = { cbufadd() {}, handleevent() {} };
			const install = setInterval(() => {
				if (!window.Module) {
					return;
				}
				clearInterval(install);
				window.Module._EZHud_StateJSON = () => 1;
				window.Module.UTF8ToString = () => JSON.stringify(state);
			}, 0);
		}, structuredClone(FIXTURE));
		await dprPage.goto(`http://127.0.0.1:${port}/index-fte.html`);
		await dprPage.waitForSelector('#overlay .box');
		await dprPage.waitForSelector('#ui-scale');
		const measure = () => dprPage.evaluate(() => {
			const box = (selector) => {
				const rect = document.querySelector(selector).getBoundingClientRect();
				return { width: rect.width, height: rect.height };
			};
			return {
				dpr: window.devicePixelRatio,
				rail: box('.panel--tree'), inspect: box('.panel--inspect'),
				stage: box('.stage'), frame: box('.stage__frame'), canvas: box('#canvas'),
			};
		});
		const dpr1440 = await measure();
		assert(dpr1440.dpr === 2, `deviceScaleFactor did not produce DPR 2: ${dpr1440.dpr}`);
		assert(dpr1440.rail.width >= 240 && dpr1440.inspect.width >= 280
			&& dpr1440.stage.width >= 600,
			`DPR 2 collapsed the 1440 layout: ${JSON.stringify(dpr1440)}`);
		near(dpr1440.canvas.width, dpr1440.frame.width, 'DPR 2 canvas/frame width');
		near(dpr1440.canvas.height, dpr1440.frame.height, 'DPR 2 canvas/frame height');

		await dprPage.setViewportSize({ width: 1280, height: 800 });
		const dpr1280 = await measure();
		assert(dpr1280.dpr === 2, 'viewport change unexpectedly changed DPR');
		assert(dpr1280.rail.width >= 220 && dpr1280.inspect.width >= 260
			&& dpr1280.stage.width >= 500 && dpr1280.stage.height >= 600,
			`fixed-DPR viewport resize collapsed the layout: ${JSON.stringify(dpr1280)}`);
		near(dpr1280.canvas.width, dpr1280.frame.width, 'resized DPR 2 canvas/frame width');
		near(dpr1280.canvas.height, dpr1280.frame.height, 'resized DPR 2 canvas/frame height');
	} finally {
		await dprPage.close();
	}

	// The whole suite ran against a page whose engine script never downloaded.
	assert(engineScript.length && engineScript.every((status) => status === 404),
		`ftewebglcl.js should 404 here, got ${JSON.stringify(engineScript)}`);
	assert(crashes.length === 0, `uncaught page errors: ${crashes.join('; ')}`);

	console.log('Tier 3 FTE: 16 cases passed with no wasm (ftewebglcl.js 404 throughout)');
} catch (err) {
	// A CI-only failure is undiagnosable from a TimeoutError alone; dump what
	// the editor actually did before dying. Temporary debug aid — cheap enough
	// to keep.
	console.error('--- failure diagnostics ---');
	try {
		console.error('console:', JSON.stringify(conlog.slice(-40), null, 1));
		console.error('crashes:', JSON.stringify(crashes));
		console.error('sent:', JSON.stringify(await sentLines()));
		console.error('probe:', JSON.stringify(await page.evaluate(() => ({
			inspector: [...document.querySelectorAll('#inspector .field label')].map((l) => l.textContent),
			active: document.activeElement?.tagName,
			note: document.querySelector('#fte-note')?.textContent,
			status: document.querySelector('#status')?.textContent,
			health: window.__fake?.state?.elements?.find((e) => e.name === 'health')?.cvars,
		}))));
	} catch (probeErr) {
		console.error('diagnostics failed:', String(probeErr));
	}
	throw err;
} finally {
	await page.close();
	await browser.close();
	await new Promise((resolve) => server.close(resolve));
}
