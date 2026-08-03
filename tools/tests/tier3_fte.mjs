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
	elements: [
		element('health', {
			pos_x: '16', pos_y: '24',
			rect: { x: 16, y: 24, w: 64, h: 24 },
			cvars: { hud_health_scale: '1', hud_health_style: '0' },
		}),
		element('armor', {
			pos_x: '16', pos_y: '60',
			rect: { x: 16, y: 60, w: 64, h: 24 },
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
		// tracker holds the FTE-dialect cvars core/fte-adapter.js's
		// TRACKER_TRANSLATE writes (r_tracker_frags/_lines/_fadetime): they name
		// no element, so `owner()` below never matches them, and without this a
		// translated write would silently vanish rather than prove it reached
		// the fake engine (#15 phase 1).
		const fake = { state, sent: [], engineEvents: [], tracker: {} };
		window.__fake = fake;

		// The adapter reads `physical` off the canvas backing store, so this is
		// where the 2.00/1.80 axis split is set. index-fte.html ships 1920x1080
		// attributes as the pre-engine fallback; the real engine's resize glue
		// overwrites them, and here the test does.
		const el = document.getElementById('canvas');
		el.width = canvas[0];
		el.height = canvas[1];

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

		// What the engine would do with the line, not what it was told: a cvar
		// the plugin never registered is set in the engine but absent from the
		// next state export, so folding it in would hide the drift report's whole
		// reason to exist.
		function fold(line) {
			const m = /^(\S+)\s+(?:"([^"]*)"|(.+?))\s*$/.exec(line);
			if (!m) {
				return;
			}
			const cvar = m[1].toLowerCase();
			const value = m[2] !== undefined ? m[2] : m[3];
			// FTE's own tracker cvars (fragstats.c), the translation's target
			// names -- not owned by any element, so they must be folded here
			// rather than falling through owner()'s hud_<element>_ matching.
			if (cvar === 'r_tracker_frags' || cvar === 'r_tracker_lines' || cvar === 'r_tracker_fadetime') {
				fake.tracker[cvar] = value;
				return;
			}
			const hit = owner(cvar);
			if (!hit) {
				return;
			}
			const { element, suffix } = hit;
			if (suffix === 'pos_x' || suffix === 'pos_y') {
				// The engine re-lays-out from the new position; every fixture
				// element is left/top aligned, so that is the rect plus the delta.
				const axis = suffix === 'pos_x' ? 'x' : 'y';
				const delta = Number(value) - (Number(element[suffix]) || 0);
				element[suffix] = value;
				if (element.rect) {
					element.rect[axis] += delta;
				}
				return;
			}
			if (suffix === 'show') {
				element.shown = value !== '0';
				return;
			}
			if (PLACEMENT.has(suffix)) {
				element[suffix] = value;
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
	for (const line of dragLines) {
		assert(/^hud_health_pos_[xy] -?\d+$/.test(line),
			`drag sent something outside the placement allowlist: ${JSON.stringify(line)}`);
	}
	assert(dragLines.some((l) => l.startsWith('hud_health_pos_x '))
		&& dragLines.some((l) => l.startsWith('hud_health_pos_y ')),
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
	assert(modeLines.includes('scr_newhud 0'),
		`clicking Classic sent ${JSON.stringify(modeLines)} instead of scr_newhud 0`);

	// Narrower than the HUD-system note (#15 phase 1): on/off, timing and line
	// count now preview via TRACKER_TRANSLATE, so only style/console-integration/
	// colours are called out as unpreviewable.
	const killfeedNotes = await page.locator('#killfeed .font-state').allTextContents();
	assert(killfeedNotes.some((t) => t.includes("style, console-integration or colours")),
		'the killfeed section is missing the narrowed dialect-translation honesty note');
	assert(!killfeedNotes.some((t) => t.includes("Preview can't mirror this on the FTE backend")),
		'the killfeed section still shows the old blanket honesty note');

	// The imported r_tracker 0 also wrote FTE's own r_tracker_frags 0
	// (fragstats.c:83), folded here by the fake engine above.
	assert((await page.evaluate(() => window.__fake.tracker.r_tracker_frags)) === '0',
		'importing r_tracker 0 did not translate onto FTE\'s r_tracker_frags');
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
	assert(killfeedLines.includes('r_tracker 1') && killfeedLines.includes('con_fragmessages 0'),
		`the killfeed seg sent ${JSON.stringify(killfeedLines)} instead of the pair`);
	// Flipping "Where kills appear" to Dedicated must send BOTH dialects: the
	// ezQuake pair above, and FTE's own r_tracker_frags 2 (fragstats.c:83, "all
	// kills") so the live preview actually follows.
	assert(killfeedLines.includes('r_tracker_frags 2'),
		`the killfeed seg sent ${JSON.stringify(killfeedLines)}, missing the FTE-dialect r_tracker_frags 2`);
	assert((await page.evaluate(() => window.__fake.tracker.r_tracker_frags)) === '2',
		'the FTE-dialect write did not reach the fake engine');

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

	// ---- 8. reload guard ----------------------------------------------------
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

	console.log('  8 reload guard: engine key and beforeunload listeners released');

	// ---- 9. volume ----------------------------------------------------------
	// The page's own sound knob (#10). The engine side is a plain cvar write, so
	// the assertions are about the contract around it: the quiet boot default,
	// the mute/unmute round trip, the imported line that must never apply, and
	// the localStorage state a reload boots from.
	const bootArgs = await page.evaluate(() => window.Module.arguments.join(' '));
	assert(bootArgs.includes('+volume 0.175'),
		`boot args lack the quiet default +volume 0.175: ${bootArgs}`);
	// Case 4's config said `volume "1"`; the pipeline retains it (cases 5/6
	// proved the export byte-identical) and must never have applied it.
	assert(!(await sentLines()).some((l) => /^volume\b/.test(l)),
		'the imported volume line reached the engine');

	const sentBeforeSlider = (await sentLines()).length;
	await page.locator('#fte-volume').evaluate((el) => {
		el.value = '0.4';
		el.dispatchEvent(new Event('input', { bubbles: true }));
	});
	await page.waitForFunction((n) => window.__fake.sent.length > n, sentBeforeSlider);
	assert((await sentLines()).slice(sentBeforeSlider).includes('volume 0.4'),
		'moving the slider did not send volume 0.4');
	assert(await page.evaluate(() => localStorage.getItem('ezhud.fte.volume')) === '0.4',
		'the slider value was not persisted');

	const sentBeforeMute = (await sentLines()).length;
	await page.locator('#fte-mute').click();
	await page.waitForFunction((n) => window.__fake.sent.length > n, sentBeforeMute);
	assert((await sentLines()).slice(sentBeforeMute).includes('volume 0'),
		'muting did not send volume 0');
	assert(await page.locator('#fte-mute').getAttribute('aria-pressed') === 'true',
		'muting did not flip aria-pressed');
	assert(await page.evaluate(() => localStorage.getItem('ezhud.fte.muted')) === '1',
		'the muted flag was not persisted');

	const sentBeforeUnmute = (await sentLines()).length;
	await page.locator('#fte-mute').click();
	await page.waitForFunction((n) => window.__fake.sent.length > n, sentBeforeUnmute);
	assert((await sentLines()).slice(sentBeforeUnmute).includes('volume 0.4'),
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

	console.log('  9 volume: quiet boot default, mute round trip, import refusal, persistence');

	// The whole suite ran against a page whose engine script never downloaded.
	assert(engineScript.length && engineScript.every((status) => status === 404),
		`ftewebglcl.js should 404 here, got ${JSON.stringify(engineScript)}`);
	assert(crashes.length === 0, `uncaught page errors: ${crashes.join('; ')}`);

	console.log('Tier 3 FTE: 9 cases passed with no wasm (ftewebglcl.js 404 throughout)');
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
