#!/usr/bin/env node
// Tier 4, FTE backend: the deploy artifact, tested.
//
// Everything here runs against the assembled public dist -- the same bytes
// Pages serves -- with the real wasm engine in real Chrome. Nothing is faked:
// the drag is a mouse drag, the import is a DataTransfer drop, the demo switch
// is the <select> the user sees. In-page evaluate is used only to *read*
// (currentBridge().state(), exportFullCfg()); every action goes through the
// GUI, because an action performed in evaluate proves the model works and says
// nothing about whether anyone can reach it.
//
// The dist is served under BASE_PATH rather than at /, because
// assemble-public.sh bakes that prefix into the import map's resolved URLs and
// a resolved URL is only right if the page really is under the prefix. A node
// server maps it instead of serve-public.sh's temp symlink + python: this suite
// needs an ephemeral port and a process it can shut down, and node is already
// a dependency where python3 is not.
//
// Known flake surface (TESTING.md tier-4 policy: a failure here needs human
// eyes and never auto-blocks):
//
//   - Engine cold start. pak load, GL context, shader compile and demo start
//     take seconds, and tens of them on Chrome's SwiftShader fallback where
//     there is no GPU. Every engine wait is condition-based with a 60s cap.
//   - The playdemo retry. fte/boot.js re-sends playdemo once at 8s because
//     +playdemo on the command line can run before the manifest's gamedirs are
//     mounted. A boot that needs the retry is slow, not broken.
//   - Drag values are coalesced. app.js writes placement cvars during the
//     gesture, so a poll can catch an intermediate value; assertions compare
//     against a state read after the gesture, never against the first change
//     seen.
//   - id1/pak1.pak 404s by design. The public dist ships no registered Quake
//     data; engine/web/prejs.js drops the run dependency and carries on, so
//     that one request failure is expected and is not a test failure.

import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const workspace = path.resolve(repo, '..');
const distDir = path.resolve(process.env.DIST_DIR || path.join(workspace, 'dist'));
const basePath = process.env.BASE_PATH || '/ezHUD/';
const artifactDir = process.env.HUD_WEB_ARTIFACT_DIR || '/tmp/ezhud-tier4-fte-artifacts';

// The whole cold start plus the 8s playdemo retry, with room for a software
// renderer. Generous on purpose: a short cap reports "the engine never came up"
// for an engine that was merely still coming up, which reads as a broken dist.
const ENGINE_WAIT = 60000;
// Editor-side waits: the DOM reacting to something the engine already did.
const UI_WAIT = 20000;

// Import-map key, not a file path: index.html maps `${basePath}core/bridge.js`
// to the FTE adapter, so importing that exact specifier from page context
// hands back the same module instance app.js is polling -- and therefore the
// same Bridge, with the retainedLines an import just wrote onto it.
const BRIDGE = `${basePath}core/bridge.js`;

const contentTypes = new Map([
	['.html', 'text/html; charset=utf-8'],
	['.css', 'text/css; charset=utf-8'],
	['.js', 'text/javascript; charset=utf-8'],
	['.svg', 'image/svg+xml'],
	['.json', 'application/json'],
	// Streaming compile refuses anything else and Chrome falls back to a slower
	// path with a console warning. python3's http.server has served .wasm as
	// application/wasm since 3.9; this stand-in has to match it.
	['.wasm', 'application/wasm'],
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assert(condition, message) {
	if (!condition) {
		throw new Error(message);
	}
}

async function eventually(operation, label, timeout) {
	const deadline = Date.now() + timeout;
	let last;
	for (;;) {
		try {
			const value = await operation();
			if (value) {
				return value;
			}
		} catch (err) {
			last = err;
		}
		if (Date.now() > deadline) {
			throw new Error(`timed out after ${timeout}ms waiting for ${label}`
				+ `${last ? `: ${last.message}` : ''}`);
		}
		await sleep(250);
	}
}

// ---- the server -------------------------------------------------------------

const prefix = basePath.endsWith('/') ? basePath : `${basePath}/`;
const server = http.createServer(async (request, response) => {
	try {
		const url = new URL(request.url, 'http://dist.invalid');
		if (!url.pathname.startsWith(prefix)) {
			response.writeHead(404).end('outside BASE_PATH');
			return;
		}
		const relative = decodeURIComponent(url.pathname.slice(prefix.length)) || 'index.html';
		const target = path.resolve(distDir, relative);
		if (!target.startsWith(`${distDir}${path.sep}`) || !(await stat(target)).isFile()) {
			response.writeHead(404).end('not found');
			return;
		}
		const body = await readFile(target);
		response.writeHead(200, {
			'content-type': contentTypes.get(path.extname(target)) ?? 'application/octet-stream',
			'content-length': body.length,
		});
		response.end(body);
	} catch {
		response.writeHead(404).end('not found');
	}
});
// Loopback only, ephemeral port: nothing here is meant to be reachable, and a
// fixed port collides with tools/fte-web/serve-public.sh, which is routinely up
// on the same machine while someone looks at the same dist by hand.
await new Promise((resolve, reject) => {
	server.once('error', reject);
	server.listen(0, '127.0.0.1', resolve);
});
const { port } = server.address();
const pageUrl = `http://127.0.0.1:${port}${prefix}index.html`;

// ---- browser ----------------------------------------------------------------

await mkdir(artifactDir, { recursive: true });

const consoleLog = [];
const record = (text) => consoleLog.push(`${new Date().toISOString()} ${text}`);

let browser;
try {
	browser = await chromium.launch({ channel: 'chrome', headless: true });
} catch (err) {
	await new Promise((resolve) => server.close(resolve));
	// Not a skip. The preflight already proved Chrome is installed, so a launch
	// failure here is a real fault of this machine or this suite.
	throw new Error(`could not launch system Chrome (channel:'chrome'): ${err.message}`);
}

const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on('console', (message) => record(`[${message.type()}] ${message.text()}`));
page.on('pageerror', (err) => record(`[pageerror] ${err.message}`));
page.on('requestfailed', (request) => record(`[requestfailed] ${request.url()} ${request.failure()?.errorText}`));
page.on('response', (response) => {
	if (response.status() >= 400) {
		record(`[http ${response.status()}] ${response.url()}`);
	}
});

// ---- page reads -------------------------------------------------------------
// Projections, not whole states: EZHud_StateJSON reports 70-odd elements with
// every cvar, and a poll that ships all of it over CDP four times a second is
// the slowest thing in the suite.

const readHost = () => page.evaluate(() => ({
	initialDemo: window.EZHUD_FTE?.initialDemo ?? null,
	bundled: (window.EZHUD_FTE?.bundledDemos ?? []).map((demo) => ({ label: demo.label, path: demo.path })),
}));

const readChrome = () => page.evaluate(() => ({
	title: document.title,
	engine: document.querySelector('#engine')?.textContent ?? '',
	status: document.querySelector('#status')?.textContent ?? '',
	note: document.querySelector('#fte-note')?.textContent ?? '',
	inspected: document.querySelector('#inspector .inspect__name')?.textContent ?? '',
	boxes: document.querySelectorAll('#overlay .box').length,
	rows: document.querySelectorAll('.tree__row').length,
}));

/** Live-engine summary plus one element, read through the adapter app.js uses. */
const readState = (name) => page.evaluate(async ([spec, wanted]) => {
	const { currentBridge } = await import(spec);
	const bridge = currentBridge();
	if (!bridge) {
		return { bridge: false, live: false };
	}
	let state;
	try {
		state = await bridge.state();
	} catch (err) {
		return { bridge: true, live: false, error: String(err.message ?? err) };
	}
	const drawn = (state.elements ?? []).filter((element) => element.rect);
	const target = wanted ? state.elements.find((element) => element.name === wanted) : null;
	return {
		bridge: true,
		// The engineLive condition, and the single strongest assertion in this
		// tier: a rect means the engine laid an element out this frame, which
		// takes wasm + pak0 + dm3 + the demo all working.
		live: drawn.length > 0,
		drawn: drawn.length,
		screen: state.screen,
		physical: state.physical,
		element: target
			? {
				name: target.name, place: target.place, align_x: target.align_x, align_y: target.align_y,
				pos_x: target.pos_x, pos_y: target.pos_y, rect: target.rect ?? null,
			}
			: null,
	};
}, [BRIDGE, name ?? null]);

/** Every drawn element, once, for choosing what to drag. */
const readDrawn = () => page.evaluate(async (spec) => {
	const { currentBridge } = await import(spec);
	const state = await currentBridge().state();
	return (state.elements ?? [])
		.filter((element) => element.rect)
		.map((element) => ({
			name: element.name, place: element.place,
			align_x: element.align_x, align_y: element.align_y,
			pos_x: element.pos_x, pos_y: element.pos_y, rect: element.rect,
		}));
}, BRIDGE);

const waitLive = (label) => eventually(
	async () => ((await readState()).live ? true : null), label, ENGINE_WAIT,
);

// The tree prints the engine's own rect for each element, so it is the cheapest
// proof that the editor's model has caught up with a change made behind its
// back. app.js polls once a second (app.js:83) and drags from the position the
// model last saw, so an import followed immediately by a drag would drag from
// the pre-import origin -- a race no human hits and this suite otherwise would.
const waitEditorCaughtUp = (name) => eventually(async () => {
	const state = await readState(name);
	const rect = state.element?.rect;
	if (!rect) {
		return null;
	}
	const shown = await page.evaluate(
		(wanted) => document.querySelector(`.tree__row[data-name="${wanted}"] .tree__meta`)?.textContent ?? '',
		name,
	);
	return shown === `${rect.x},${rect.y}` ? shown : null;
}, `the tree to show ${name}'s current rect`, UI_WAIT);

// The basename is what FTE puts in the window caption ("Quake: demos/<x>.mvd"),
// which is the only observable that says *which* demo is playing.
const demoBasename = (demoPath) => path.basename(String(demoPath)).replace(/\.[^.]+$/, '');

// ---- the run ----------------------------------------------------------------

const started = Date.now();
const passed = [];
function pass(number, text) {
	passed.push(number);
	console.log(`tier 4 FTE ${number}: PASS — ${text}`);
}

async function shot(name) {
	const file = path.join(artifactDir, `${name}.png`);
	await page.screenshot({ path: file, fullPage: false }).catch(() => {});
	return file;
}

let failure = null;
try {
	await page.goto(pageUrl);

	// ---- 1. boot ------------------------------------------------------------
	await waitLive('the engine to draw a HUD (wasm, pak0, gpl_maps dm3, bundled demo)');
	const host = await readHost();
	assert(host.bundled.length >= 2, `expected two bundled demos, got ${host.bundled.length}`);
	const firstDemo = demoBasename(host.initialDemo);
	const chromeState = await eventually(
		async () => {
			const view = await readChrome();
			return view.title.includes(firstDemo) && view.engine ? view : null;
		},
		`the page title to name ${firstDemo} and #engine to report a backend`,
		UI_WAIT,
	);
	assert(/fte/i.test(chromeState.engine),
		`#engine should name the FTE backend, got "${chromeState.engine}"`);
	assert(chromeState.boxes > 0, 'the engine is drawing but the overlay has no boxes');
	pass(1, `booted in ${((Date.now() - started) / 1000).toFixed(1)}s — "${chromeState.title}", `
		+ `engine "${chromeState.engine}", ${chromeState.boxes} placed elements`);

	// ---- pick what to drag --------------------------------------------------
	// health is the intended subject (TESTPLAN), but which elements the demo's
	// default layout actually draws is the engine's business, not this file's:
	// in the bundled hudtest layout health is placed *at* face rather than at
	// the screen, and an element that is not drawn at all has no box to grab.
	// So confirm health from the live state and fall back to another drawn,
	// grabbable element rather than failing on a layout change.
	const drawn = await readDrawn();
	const grabbable = drawn.filter((element) => element.rect.w >= 16 && element.rect.h >= 8
		// left/after put the element's own +x to the right of its anchor, so
		// "drag right, pos_x goes up" is the engine's arithmetic too. right and
		// before mirror it, and asserting a direction against them would be
		// asserting this test's guess about hud.c.
		&& ['left', 'after'].includes(element.align_x));
	const candidate = grabbable.find((element) => element.name === 'health')
		?? grabbable.find((element) => element.place === 'screen')
		?? grabbable[0];
	assert(candidate, 'no drawn element is big enough to drag in this demo\'s layout');

	// ---- 2. control interaction --------------------------------------------
	// First, and fatal: if a click on a tree row cannot open the inspector then
	// every later "the GUI did not do X" is meaningless, and the run must stop
	// before it starts editing the engine.
	try {
		await page.locator(`.tree__row[data-name="${candidate.name}"]`).click();
		await page.waitForFunction(
			(name) => document.querySelector('#inspector .inspect__name')?.textContent === name,
			candidate.name,
			{ timeout: UI_WAIT },
		);
		await page.locator('#overlay .box[data-selected="true"]').waitFor({ timeout: UI_WAIT });
	} catch (err) {
		throw new Error(`CONTROL INTERACTION FAILED; aborting before engine edits: ${err.message}`);
	}
	pass(2, `clicking the ${candidate.name} row selected it and opened the inspector`);

	// ---- 3. drag ------------------------------------------------------------
	await waitEditorCaughtUp(candidate.name);
	const selected = page.locator('#overlay .box[data-selected="true"]');
	const box = await selected.boundingBox();
	assert(box, `${candidate.name}'s selected box is not interactable`);

	// Cross-check the box against the console rect the engine reported, mapped
	// through the live canvas: the overlay is what the drag grabs, so if it has
	// drifted from the picture underneath, the gesture is landing somewhere the
	// user did not click.
	const canvas = await page.locator('#canvas').boundingBox();
	const live = await readState(candidate.name);
	const scale = canvas.width / live.screen.vid_width;
	const expectedCentre = {
		x: canvas.x + (live.element.rect.x + live.element.rect.w / 2) * scale,
		y: canvas.y + (live.element.rect.y + live.element.rect.h / 2) * scale,
	};
	const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
	for (const axis of ['x', 'y']) {
		assert(Math.abs(centre[axis] - expectedCentre[axis]) <= 4,
			`${candidate.name}'s overlay box is ${Math.abs(centre[axis] - expectedCentre[axis]).toFixed(1)}px `
			+ `off the engine's own rect on ${axis}`);
	}

	const before = Number(live.element.pos_x) || 0;
	const drag = async (dx) => {
		const current = await selected.boundingBox();
		assert(current, `${candidate.name}'s box vanished before a drag`);
		await page.mouse.move(current.x + current.width / 2, current.y + current.height / 2);
		await page.mouse.down();
		await page.mouse.move(current.x + current.width / 2 + dx, current.y + current.height / 2, { steps: 8 });
		await page.mouse.up();
	};
	await drag(50);
	const moved = await eventually(async () => {
		const state = await readState(candidate.name);
		return Number(state.element?.pos_x) !== before ? state.element : null;
	}, `${candidate.name}'s hud_${candidate.name}_pos_x to change in the engine`, UI_WAIT);
	// Settled value, not the first change seen: the gesture writes several
	// times and the poll routinely lands mid-drag.
	const settled = (await readState(candidate.name)).element;
	assert(Number.isFinite(Number(settled.pos_x)),
		`hud_${candidate.name}_pos_x is not a number: ${JSON.stringify(settled.pos_x)}`);
	assert(Number(settled.pos_x) > before,
		`dragging right should raise hud_${candidate.name}_pos_x: ${before} -> ${settled.pos_x}`);
	await drag(-50);
	const back = await eventually(async () => {
		const state = await readState(candidate.name);
		return Number(state.element?.pos_x) !== Number(settled.pos_x) ? state.element : null;
	}, `${candidate.name} to move back`, UI_WAIT);
	assert(Math.abs(Number(back.pos_x) - before) <= 2,
		`dragging back should land within 2 console px of ${before}, got ${back.pos_x}`);
	pass(3, `mouse-drag moved hud_${candidate.name}_pos_x ${before} -> ${settled.pos_x} -> ${back.pos_x}`);

	// ---- 4. import over a live engine --------------------------------------
	const importedPos = 64;
	const bindLine = 'bind x "say tier4-fte"';
	const cfgName = 'tier4-fte.cfg';
	const cfg = [
		'// tier 4 FTE import probe',
		`hud_${candidate.name}_pos_x ${importedPos}`,
		bindLine,
		'',
	].join('\n');
	// A real DataTransfer built in the page: the drop zone reads
	// ev.dataTransfer.files, and a synthetic event without one is not the code
	// path a user takes.
	const transfer = await page.evaluateHandle(([text, name]) => {
		const data = new DataTransfer();
		data.items.add(new File([text], name, { type: 'text/plain' }));
		return data;
	}, [cfg, cfgName]);
	await page.dispatchEvent('#fte-drop', 'drop', { dataTransfer: transfer });
	const note = await eventually(async () => {
		const view = await readChrome();
		return /applied \d+ of \d+ lines/.test(view.note) ? view.note : null;
	}, 'the import note to report applied/total lines', UI_WAIT);
	assert(note.includes(cfgName), `the note should name the dropped file, got "${note}"`);
	assert(/applied 1 of 3 lines/.test(note),
		`only hud_${candidate.name}_pos_x is appliable, so the note should say "applied 1 of 3 lines": "${note}"`);
	const imported = await eventually(async () => {
		const state = await readState(candidate.name);
		return Number(state.element?.pos_x) === importedPos ? state.element : null;
	}, `the engine to hold the imported hud_${candidate.name}_pos_x ${importedPos}`, UI_WAIT);
	const importedMeta = await waitEditorCaughtUp(candidate.name);
	pass(4, `dropped ${cfgName} over the live engine: "${note}", pos_x now ${imported.pos_x}, `
		+ `tree shows rect ${importedMeta}`);

	// ---- 5. export ----------------------------------------------------------
	// One deliberate edit after the import, through the GUI again, so the export
	// has something to rewrite. Without it the exporter writes the user's own
	// line back verbatim -- correct, and untestable as a rewrite.
	await page.locator(`.tree__row[data-name="${candidate.name}"]`).click();
	await page.locator('#overlay .box[data-selected="true"]').waitFor({ timeout: UI_WAIT });
	await drag(50);
	await eventually(async () => {
		const state = await readState(candidate.name);
		return Number(state.element?.pos_x) !== importedPos ? state.element : null;
	}, `${candidate.name} to move away from the imported position`, UI_WAIT);
	// Export and the value it should carry, read together: exportFullCfg works
	// off the Bridge's last state, so refreshing that state in the same call is
	// what makes the comparison exact rather than a race with the next poll.
	const exported = await page.evaluate(async ([spec, name]) => {
		const { currentBridge } = await import(spec);
		const bridge = currentBridge();
		const state = await bridge.state();
		const element = state.elements.find((item) => item.name === name);
		return { text: bridge.exportFullCfg(), pos_x: element.pos_x };
	}, [BRIDGE, candidate.name]);
	const lines = exported.text.split('\n');
	assert(lines.includes(bindLine),
		`the bind must survive byte-identical; export has ${JSON.stringify(lines.slice(0, 5))}`);
	assert(lines.includes('// tier 4 FTE import probe'), 'the comment line was not carried verbatim');
	const rewritten = `hud_${candidate.name}_pos_x "${exported.pos_x}"`;
	assert(lines.includes(rewritten),
		`the edited line should be rewritten as ${rewritten}; export has `
		+ `${JSON.stringify(lines.filter((line) => line.startsWith(`hud_${candidate.name}_pos_x`)))}`);
	assert(!lines.includes(`hud_${candidate.name}_pos_x ${importedPos}`),
		'the stale imported value is still in the export');
	pass(5, `exportFullCfg kept the bind byte-identical and rewrote ${rewritten}`);

	// ---- 6. demo picker -----------------------------------------------------
	const second = host.bundled.find((demo) => demo.path !== host.initialDemo);
	assert(second, 'the dist bundles no second demo to switch to');
	const secondName = demoBasename(second.path);
	await page.selectOption('#fte-demo', second.path);
	await eventually(async () => (await readChrome()).title.includes(secondName),
		`the engine to start ${secondName} (the window caption is what says which demo is playing)`,
		ENGINE_WAIT);
	await waitLive(`${secondName} to draw a HUD`);
	const after = await readChrome();
	assert(after.boxes > 0, `${secondName} is playing but the overlay has no boxes`);
	pass(6, `the demo picker played ${secondName} through the host's playdemo path — "${after.title}"`);

	// ---- 7. artifacts -------------------------------------------------------
	const successShot = await shot('tier4-fte-pass');
	pass(7, `success screenshot at ${successShot}`);
} catch (err) {
	failure = err;
	const file = await shot('tier4-fte-failure');
	const logFile = path.join(artifactDir, 'tier4-fte-console.log');
	await writeFile(logFile, `${consoleLog.join('\n')}\n`).catch(() => {});
	console.error(`\ntier 4 FTE FAILED after cases [${passed.join(', ')}]: ${err.message}`);
	console.error(`  screenshot: ${file}`);
	console.error(`  console log: ${logFile}`);
} finally {
	await page.close().catch(() => {});
	await browser.close().catch(() => {});
	await new Promise((resolve) => server.close(resolve));
}

if (failure) {
	process.exit(1);
}
console.log(`Tier 4 FTE: boot, control, drag, import, export and demo switch passed against `
	+ `${distDir} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(`Tier 4 FTE artifacts: ${artifactDir}`);
