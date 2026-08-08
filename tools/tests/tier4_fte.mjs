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

const DEMO_MOMENTS = [
	{ target: '9:00', label: 'Full HUD' },
	{ target: '20:10', label: 'Scoreboard' },
	{ target: '0:10', label: 'Quiet' },
];
const DEMO_STATE_ELEMENTS = [
	'key1', 'gun2', 'gun4', 'teamfrags', 'health', 'tracking',
];

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
const engineConsole = [];
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
page.on('console', (message) => {
	const messageText = message.text();
	engineConsole.push(...messageText.split(/\r?\n/));
	record(`[${message.type()}] ${messageText}`);
});
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
		demo: state.demo ?? null,
		element: target
			? {
				name: target.name, place: target.place, parent: target.parent ?? null,
				align_x: target.align_x, align_y: target.align_y,
				pos_x: target.pos_x, pos_y: target.pos_y, order: target.order, frame: target.frame,
				rect: target.rect ?? null,
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
			name: element.name, place: element.place, parent: element.parent ?? null,
			align_x: element.align_x, align_y: element.align_y,
			pos_x: element.pos_x, pos_y: element.pos_y, rect: element.rect,
		}));
}, BRIDGE);

// #87 covers four empty/non-drawing paths. Native ezQuake still publishes
// unrelated zero-area layouts (for example frags with hud_frags_notintp 1 in
// teamplay), so this contract deliberately rejects non-positive rects only for
// tracker, ownfrags, tracking and net rather than claiming a global invariant.
const readRectContract = () => page.evaluate(async (spec) => {
	const { currentBridge } = await import(spec);
	const state = await currentBridge().state();
	const covered = new Set(['tracker', 'ownfrags', 'tracking', 'net']);
	const byName = (name) => state.elements.find((element) => element.name === name);
	return {
		screen: state.screen,
		tracker: byName('tracker')?.rect ?? null,
		ownfrags: byName('ownfrags')?.rect ?? null,
		tracking: byName('tracking')?.rect ?? null,
		net: byName('net')?.rect ?? null,
		nonPositive: state.elements
			.filter((element) => covered.has(element.name)
				&& element.rect && (element.rect.w <= 0 || element.rect.h <= 0))
			.map((element) => ({ name: element.name, rect: element.rect })),
	};
}, BRIDGE);

// A compact projection of the engine-owned layout at a demo point. These
// elements distinguish the three reviewed frames without depending on a page
// clock or on tracker, whose false zero-area rect is independently tracked by
// #87. Playback is frozen before every read, so three identical projections in
// succession are a settled consumed-packet state rather than a timing guess.
const readDemoMomentState = () => page.evaluate(async ([spec, names]) => {
	const { currentBridge } = await import(spec);
	const state = await currentBridge().state();
	return {
		speed: state.demo?.cl_demospeed ?? null,
		elements: names.map((name) => {
			const element = state.elements.find((entry) => entry.name === name);
			return { name, rect: element?.rect ?? null };
		}),
	};
}, [BRIDGE, DEMO_STATE_ELEMENTS]);

const demoMomentSignature = (state) => JSON.stringify(state.elements);

async function waitForDemoMoment(previousSignature, label) {
	let lastSignature = null;
	let stableReads = 0;
	return eventually(async () => {
		const state = await readDemoMomentState();
		const signature = demoMomentSignature(state);
		if (state.speed !== '0' || signature === previousSignature) {
			lastSignature = null;
			stableReads = 0;
			return null;
		}
		if (signature === lastSignature) {
			stableReads += 1;
		} else {
			lastSignature = signature;
			stableReads = 1;
		}
		return stableReads >= 3 ? { state, signature } : null;
	}, `${label} to settle in engine state while paused`, ENGINE_WAIT);
}

const waitLive = (label) => eventually(
	async () => ((await readState()).live ? true : null), label, ENGINE_WAIT,
);

let cvarProbe = 0;

/**
 * Read one cvar through the engine's public console, not the adapter ledger.
 * The pinned FTE console prints `echo <marker>\nvolume\n` as the marker followed
 * by `"volume" is "0.175"`. FTE also emits the variants
 * `"<name>" is currently "<value>"` and a trailing ` (default)`, so the parser
 * accepts all three. A per-call marker and a starting console offset ensure a
 * delayed line from an older probe can never satisfy this one.
 */
async function readCvar(name) {
	assert(/^[A-Za-z_][A-Za-z0-9_]*$/.test(name), `unsafe cvar probe name ${JSON.stringify(name)}`);
	const marker = `EZHUD_T4_CVAR_${Date.now().toString(36)}_${++cvarProbe}`;
	const start = engineConsole.length;
	await page.evaluate(([probe, cvar]) => {
		const channel = window.EZHUD_FTE?.engine()?.ftec;
		if (!channel) {
			throw new Error('the live FTE command channel is unavailable');
		}
		channel.cbufadd(`echo ${probe}\n${cvar}\n`);
	}, [marker, name]);

	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const valuePattern = new RegExp(
		`"${escaped}"\\s+is(?:\\s+currently)?\\s+"([^"]*)"(?:\\s+\\(default\\))?`, 'i');
	const found = await eventually(() => {
		const lines = engineConsole.slice(start);
		const markerAt = lines.findIndex((line) => line.includes(marker));
		if (markerAt < 0) {
			return null;
		}
		for (const line of lines.slice(markerAt + 1)) {
			const match = valuePattern.exec(line);
			if (match) {
				return { value: match[1] };
			}
		}
		return null;
	}, `FTE console readback for ${name} after ${marker}`, UI_WAIT);
	return found.value;
}

const readExport = () => page.evaluate(async (spec) => {
	const { currentBridge } = await import(spec);
	const bridge = currentBridge();
	await bridge.state();
	return bridge.exportFullCfg();
}, BRIDGE);

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

function controlLocator(target) {
	let locator = page.locator(target.selector);
	if (target.text) {
		locator = locator.filter({ hasText: new RegExp(`^${target.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) });
	}
	if (target.index != null) {
		locator = locator.nth(target.index);
	}
	return locator;
}

// One DOM snapshot, classified with Sets: a control matched by several rows is
// still one control. Text/index constraints are resolved exactly as
// controlLocator resolves the table, so deleting one segmented option makes
// that row stale instead of another row's broad base selector hiding it.
async function auditInteractiveControls(coverage, exemptions) {
	return page.evaluate(({ covered, exempt }) => {
		const resolve = (entry) => {
			let nodes = [...document.querySelectorAll(entry.selector)];
			if (entry.text) {
				nodes = nodes.filter((node) => node.textContent.trim() === entry.text);
			}
			if (entry.index != null) {
				nodes = nodes[entry.index] ? [nodes[entry.index]] : [];
			}
			return nodes;
		};
		const visibleAndEnabled = (node) => {
			const style = getComputedStyle(node);
			return node.getClientRects().length > 0
				&& style.display !== 'none'
				&& style.visibility !== 'hidden'
				&& style.visibility !== 'collapse'
				&& !node.matches(':disabled')
				&& node.getAttribute('aria-disabled') !== 'true';
		};
		const quoteAttribute = (value) => `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
		const identifier = (node) => {
			if (node.id) {
				return `#${CSS.escape(node.id)}`;
			}
			if (node.title) {
				return `${node.localName}[title=${quoteAttribute(node.title)}]`;
			}
			const titled = node.closest('[title]');
			if (titled && titled !== node) {
				return `${titled.localName}[title=${quoteAttribute(titled.title)}] ${node.localName}`;
			}
			const parts = [];
			let cursor = node;
			while (cursor?.nodeType === Node.ELEMENT_NODE && parts.length < 4) {
				if (cursor.id) {
					parts.unshift(`#${CSS.escape(cursor.id)}`);
					break;
				}
				let part = cursor.localName;
				const stableClass = [...cursor.classList].find((name) => !name.startsWith('is-'));
				if (stableClass) {
					part += `.${CSS.escape(stableClass)}`;
				}
				const peers = cursor.parentElement
					? [...cursor.parentElement.children].filter((child) => child.localName === cursor.localName)
					: [];
				if (peers.length > 1) {
					part += `:nth-of-type(${peers.indexOf(cursor) + 1})`;
				}
				parts.unshift(part);
				cursor = cursor.parentElement;
			}
			return parts.join(' > ');
		};

		const controls = new Set(
			[...document.querySelectorAll('input, select, button, [role="button"], .seg__item')]
				.filter(visibleAndEnabled),
		);
		const coveredNodes = new Set(covered.flatMap(resolve));
		const exemptNodes = new Set(exempt.flatMap(resolve));
		const unmatched = [...controls]
			.filter((node) => !coveredNodes.has(node) && !exemptNodes.has(node))
			.map(identifier)
			.sort();
		const staleCovered = covered
			.filter((entry) => !entry.transient && resolve(entry).length === 0)
			.map((entry) => entry.label);
		const staleExempt = exempt
			.filter((entry) => resolve(entry).length === 0)
			.map((entry) => entry.selector);
		return { controls: controls.size, unmatched, staleCovered, staleExempt };
	}, { covered: coverage, exempt: exemptions });
}

async function operateControl(row) {
	if (row.prepare?.selectElement) {
		await page.locator(`.tree__row[data-name="${row.prepare.selectElement}"]`).click();
		await page.waitForFunction(
			(name) => document.querySelector('#inspector .inspect__name')?.textContent === name,
			row.prepare.selectElement,
			{ timeout: UI_WAIT },
		);
	}
	const locator = controlLocator(row.target);
	await locator.waitFor({ state: 'visible', timeout: UI_WAIT });
	switch (row.operation.kind) {
	case 'click':
		await locator.click();
		break;
	case 'fill':
		await locator.fill(String(row.operation.value));
		if (row.operation.commit) {
			await locator.press('Enter');
		}
		break;
	case 'select':
		await locator.selectOption(String(row.operation.value));
		break;
	case 'reset':
		await locator.click();
		await page.locator('#reset-dialog[open]').waitFor({ timeout: UI_WAIT });
		await page.locator('#reset-dialog button', { hasText: /^Reset$/ }).click();
		await page.locator('#reset-dialog[open]').waitFor({ state: 'hidden', timeout: UI_WAIT });
		break;
	default:
		throw new Error(`unknown operation ${row.operation.kind} for ${row.label}`);
	}
}

async function proveControl(row) {
	let unchangedBefore = null;
	let editorBefore = null;
	if (row.exportOnly) {
		unchangedBefore = await readCvar(row.exportOnly.unchangedCvar);
	}
	if (row.editorOnly) {
		unchangedBefore = await readCvar(row.editorOnly.unchangedCvar);
		const state = await readState();
		editorBefore = {
			metric: await page.locator(row.editorOnly.metricSelector).evaluate(
				(node, property) => node.getBoundingClientRect()[property], row.editorOnly.metricProperty),
			screen: state.screen,
			physical: state.physical,
		};
	}
	await operateControl(row);
	if (row.expect) {
		for (const [cvar, expected] of Object.entries(row.expect)) {
			await eventually(async () => {
				const actual = await readCvar(cvar);
				return actual === String(expected) ? actual : null;
			}, `${row.label} to leave engine ${cvar} at ${expected}`, UI_WAIT);
		}
	}
	if (row.exportOnly) {
		const unchangedAfter = await readCvar(row.exportOnly.unchangedCvar);
		assert(unchangedAfter === unchangedBefore,
			`${row.label} is export-only but changed engine ${row.exportOnly.unchangedCvar} `
			+ `${unchangedBefore} -> ${unchangedAfter}`);
		const exportedText = await eventually(async () => {
			const text = await readExport();
			return text.split('\n').includes(row.exportOnly.line) ? text : null;
		}, `${row.label} to land ${row.exportOnly.line} in the full export`, UI_WAIT);
		assert(exportedText, `${row.label} did not land in the full export`);
	}
	if (row.editorOnly) {
		const changed = await eventually(async () => {
			const metric = await page.locator(row.editorOnly.metricSelector).evaluate(
				(node, property) => node.getBoundingClientRect()[property], row.editorOnly.metricProperty);
			const state = await readState();
			const screenChanged = state.screen?.vid_width !== editorBefore.screen?.vid_width
				|| state.screen?.vid_height !== editorBefore.screen?.vid_height;
			const physicalChanged = state.physical?.[0] !== editorBefore.physical?.[0]
				|| state.physical?.[1] !== editorBefore.physical?.[1];
			return metric > editorBefore.metric * row.editorOnly.minimumFactor
				&& screenChanged && physicalChanged ? { metric, state } : null;
		}, `${row.label} to resize chrome, canvas and exported screen state`, UI_WAIT);
		const unchangedAfter = await readCvar(row.editorOnly.unchangedCvar);
		assert(unchangedAfter === unchangedBefore,
			`${row.label} changed HUD placement ${row.editorOnly.unchangedCvar} `
			+ `${unchangedBefore} -> ${unchangedAfter}`);
		assert(await page.evaluate((key) => localStorage.getItem(key), row.editorOnly.storageKey)
			=== row.operation.value,
			`${row.label} did not persist ${row.operation.value}`);
		const exported = await readExport();
		assert(!exported.includes(row.editorOnly.forbiddenExport),
			`${row.label} leaked editor-only state into the HUD export`);
		const backing = await page.locator('#canvas').evaluate((canvas) =>
			[canvas.width, canvas.height]);
		assert(changed.state.physical[0] === backing[0] && changed.state.physical[1] === backing[1],
			`${row.label} physical state does not match the canvas backing store: `
			+ `${JSON.stringify({ physical: changed.state.physical, backing })}`);
		// vid_conautoscale may intentionally make console screen dimensions a
		// fraction of the physical backing store. "Follows" means both resize by
		// the same ratio, not that they are numerically equal.
		const ratios = {
			screenX: changed.state.screen.vid_width / editorBefore.screen.vid_width,
			screenY: changed.state.screen.vid_height / editorBefore.screen.vid_height,
			physicalX: changed.state.physical[0] / editorBefore.physical[0],
			physicalY: changed.state.physical[1] / editorBefore.physical[1],
		};
		assert(Math.abs(ratios.screenX - ratios.physicalX) < 0.02
			&& Math.abs(ratios.screenY - ratios.physicalY) < 0.02,
			`${row.label} screen did not follow physical resize ratios: ${JSON.stringify(ratios)}`);
		if (row.editorOnly.restore != null) {
			await controlLocator(row.target).selectOption(String(row.editorOnly.restore));
			await eventually(async () => await page.evaluate((value) =>
				document.documentElement.dataset.uiScale === value ? true : null,
			String(row.editorOnly.restore)), `${row.label} cleanup`, UI_WAIT);
		}
	}
}

async function elementClip(name, timeout = UI_WAIT) {
	const state = await eventually(async () => {
		const next = await readState(name);
		const rect = next.element?.rect;
		return rect && rect.w > 0 && rect.h > 0 ? next : null;
	}, `the ${name} element to expose a non-empty engine rect`, timeout);
	const canvasBox = await page.locator('#canvas').boundingBox();
	assert(canvasBox, 'the live engine canvas has no screen bounds');
	const sx = canvasBox.width / state.screen.vid_width;
	const sy = canvasBox.height / state.screen.vid_height;
	const viewport = page.viewportSize();
	const x = Math.max(0, canvasBox.x + state.element.rect.x * sx);
	const y = Math.max(0, canvasBox.y + state.element.rect.y * sy);
	return {
		x, y,
		width: Math.min(Math.max(1, state.element.rect.w * sx), viewport.width - x),
		height: Math.min(Math.max(1, state.element.rect.h * sy), viewport.height - y),
	};
}

async function trackerClip(messageRows, timeout = 90000) {
	const state = await eventually(async () => {
		const next = await readState('tracker');
		const rect = next.element?.rect;
		return rect && rect.w > 0 && rect.h > 0 ? next : null;
	}, 'the tracker element to expose a non-empty engine rect', timeout);
	const canvasBox = await page.locator('#canvas').boundingBox();
	assert(canvasBox, 'the live engine canvas has no screen bounds');
	const sx = canvasBox.width / state.screen.vid_width;
	const sy = canvasBox.height / state.screen.vid_height;
	const viewport = page.viewportSize();
	// Consume the engine-reported rect directly. A tracker-specific mirror here
	// would make the editor overlay disagree with the pixels while both appeared
	// internally consistent, which is exactly the stale #61 workaround this
	// Release 2 contract removes.
	const x = Math.max(0, canvasBox.x + state.element.rect.x * sx);
	const y = Math.max(0, canvasBox.y + state.element.rect.y * sy);
	// The rect reserves r_tracker_messages rows even when only one retained frag
	// is drawn. At the new console scale that unused tail reaches into the 3-D
	// view, so compare the first row where the newest tracker message is painted.
	const rowHeight = state.element.rect.h / Math.max(1, messageRows);
	return {
		x,
		y,
		width: Math.min(Math.max(1, state.element.rect.w * sx), viewport.width - x),
		height: Math.min(Math.max(1, rowHeight * sy), viewport.height - y),
	};
}

// A screenshot is decoded back to RGBA in the browser before comparison. That
// makes this a pixel assertion rather than a comparison of PNG container bytes.
async function pixelSignature(png) {
	return page.evaluate(async (base64) => {
		const response = await fetch(`data:image/png;base64,${base64}`);
		const bitmap = await createImageBitmap(await response.blob());
		const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
		const context = canvas.getContext('2d');
		context.drawImage(bitmap, 0, 0);
		const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
		let a = 2166136261;
		let b = 0;
		for (let i = 0; i < pixels.length; i++) {
			a = Math.imul(a ^ pixels[i], 16777619) >>> 0;
			b = (b + Math.imul(pixels[i], i + 1)) >>> 0;
		}
		return `${bitmap.width}x${bitmap.height}:${a}:${b}`;
	}, png.toString('base64'));
}

const visualFailureShots = new Map();
async function captureRegion(name, clip) {
	const png = await page.screenshot({ clip });
	visualFailureShots.set(name, png);
	return { png, signature: await pixelSignature(png) };
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

	let demoPausePassText;
	let demoReadbackPassText;

	// ---- new case: real demo-time pause/resume ------------------------------
	// cl.time keeps advancing at cl_demospeed 0 in this FTE build, so gameclock
	// cannot prove demo pause. democlock is driven by consumed demo time. Put it
	// over viewsize 30's static border, hide editor outlines and compare its
	// actual pixels: running changes, paused is byte-stable, resume changes.
	const pauseButton = page.locator('#fte-pause');
	await pauseButton.waitFor({ state: 'visible', timeout: UI_WAIT });
	await eventually(async () => (await pauseButton.isEnabled()) ? true : null,
		'the demo pause control to receive engine state', UI_WAIT);
	const originalDemoClockShow = await readCvar('hud_democlock_show');
	const originalViewsize = await readCvar('viewsize');
	const originalNotify = await readCvar('con_notifylines');
	const overlayWasOn = await page.locator('#chrome').isChecked();
	let pausePrepared = false;
	try {
		await page.evaluate(() => {
			const channel = window.EZHUD_FTE?.engine()?.ftec;
			if (!channel) throw new Error('the live FTE command channel is unavailable');
			channel.cbufadd('con_notifylines 0\nviewsize 30\n'
				+ 'set hud_democlock_show 1\nset hud_democlock_place screen\n'
				+ 'set hud_democlock_align_x left\nset hud_democlock_align_y top\n'
				+ 'set hud_democlock_pos_x 8\nset hud_democlock_pos_y 8\n'
				+ 'set hud_democlock_scale 2\nset hud_democlock_blink 0\nhud_recalculate\n');
		});
		pausePrepared = true;
		await eventually(async () => {
			const state = await readState('democlock');
			return state.demo?.cl_demospeed === '1' && state.element?.rect ? state : null;
		}, 'democlock pixels and normal demo speed', UI_WAIT);
		if (overlayWasOn) await page.locator('#chrome').click();
		const clip = await elementClip('democlock');

		const runningBefore = await captureRegion('democlock-running-before', clip);
		await sleep(1300);
		const runningAfter = await captureRegion('democlock-running-after', clip);
		assert(runningAfter.signature !== runningBefore.signature,
			'the demo-time democlock did not change during normal playback');

		await pauseButton.click();
		await eventually(async () => {
			const state = await readState();
			return state.demo?.cl_demospeed === '0'
				&& await pauseButton.getAttribute('aria-pressed') === 'true' ? true : null;
		}, 'the GUI pause to read back cl_demospeed=0', UI_WAIT);
		await sleep(400);
		const pausedBefore = await captureRegion('democlock-paused-before', clip);
		await sleep(1300);
		const pausedAfter = await captureRegion('democlock-paused-after', clip);
		assert(pausedAfter.signature === pausedBefore.signature,
			`demo-time pixels changed while paused (${pausedBefore.signature} -> ${pausedAfter.signature})`);

		await pauseButton.click();
		await eventually(async () => {
			const state = await readState();
			return state.demo?.cl_demospeed === '1'
				&& await pauseButton.getAttribute('aria-pressed') === 'false' ? true : null;
		}, 'the GUI resume to read back cl_demospeed=1', UI_WAIT);
		await sleep(400);
		const resumedBefore = await captureRegion('democlock-resumed-before', clip);
		await sleep(1300);
		const resumedAfter = await captureRegion('democlock-resumed-after', clip);
		assert(resumedAfter.signature !== resumedBefore.signature,
			'the demo-time democlock did not change after resume');
		await writeFile(path.join(artifactDir, 'demo-pause-evidence.json'), JSON.stringify({
			observable: 'hud_democlock pixels over viewsize 30 static border',
			reason: 'democlock follows consumed demo time; cl.time/gameclock continues while frozen',
			commands: { pause: 'demo_setspeed 0', resume: 'demo_setspeed 100' },
			signatures: {
				running: [runningBefore.signature, runningAfter.signature],
				paused: [pausedBefore.signature, pausedAfter.signature],
				resumed: [resumedBefore.signature, resumedAfter.signature],
			},
		}, null, 2));
		demoPausePassText = 'democlock pixels changed running, froze at 0%, and changed after 100% resume';

		// ---- new case: out-of-band engine state -------------------------------
		await page.evaluate(() => window.EZHUD_FTE.engine().ftec.cbufadd('demo_setspeed 0\n'));
		await eventually(async () => {
			const state = await readState();
			return state.demo?.cl_demospeed === '0'
				&& await pauseButton.getAttribute('aria-pressed') === 'true' ? true : null;
		}, 'an out-of-band console pause to update the toggle on poll', UI_WAIT);
		await page.evaluate(() => window.EZHUD_FTE.engine().ftec.cbufadd('demo_setspeed 100\n'));
		await eventually(async () => {
			const state = await readState();
			return state.demo?.cl_demospeed === '1'
				&& await pauseButton.getAttribute('aria-pressed') === 'false' ? true : null;
		}, 'an out-of-band console resume to update the toggle on poll', UI_WAIT);
		demoReadbackPassText = 'console demo_setspeed 0/100 drove the toggle from polled engine state';
	} finally {
		// Always leave playback and the existing visual case in their original
		// state, even if a pixel assertion fails halfway through.
		await page.evaluate(([show, viewsize, notify]) => {
			const channel = window.EZHUD_FTE?.engine()?.ftec;
			if (!channel) return;
			channel.cbufadd(`demo_setspeed 100\nset hud_democlock_show ${show}\n`
				+ `viewsize ${viewsize}\ncon_notifylines ${notify}\nhud_recalculate\n`);
		}, [originalDemoClockShow, originalViewsize, originalNotify]).catch(() => {});
		if (pausePrepared && overlayWasOn && !(await page.locator('#chrome').isChecked())) {
			await page.locator('#chrome').click().catch(() => {});
		}
	}

	// ---- per-control deploy gate -------------------------------------------
	// Interactive engine/export controls rendered by the public FTE page:
	//
	//   FTE chrome: demo picker (case 6), cfg drop target (case 4), demo pause
	//   and resume, volume range, mute and unmute. Editor size (#25) has its own
	//   row proving visible chrome growth, persisted choice, engine resize and
	//   unchanged HUD placement. Overlay/filter/Hidden/Spectator are editor-view
	//   filters only; Save is an export workflow (case 5), not an engine setting.
	//
	//   HUD systems: Classic/New/Both (scr_newhud), QW262 overlay (cl_hud),
	//   classic bar (cl_sbar), compact style (scr_compacthud), viewsize, and
	//   Reset positions. cl_hud and scr_compacthud are honest export-only FTE
	//   controls: their rows prove an effective engine cvar stays unchanged and
	//   the chosen value is present in the full export.
	//
	//   Killfeed: all three Where positions (the r_tracker/con_fragmessages
	//   pair), both Style positions, five toggles (frags, streaks, flags,
	//   pickups, align-right), and the time/messages/scale fields. This panel's
	//   Scale is r_tracker_scale; hud_tracker_scale is the tracker element's
	//   generic inspector field and has its own row below.
	//
	//   Element editor: tree visibility, overlay drag (case 3), one numeric
	//   placement field, tracker scale through the generic parameter inspector,
	//   and Reset. Place/alignment selects, raw/color fields and direction
	//   segments are generated by the same group()/applyAll() path as these
	//   representative inspector edits; the owner-required classic paths are
	//   the visibility, drag and numeric rows.
	//
	// One row is one visible setting/position. The executor below is the only
	// place that operates controls and checks console cvar/export readback, so a
	// future authored control is covered by adding one declarative row here.
	const controlCases = [
		{
			issue: 43,
			label: 'pause demo button', target: { selector: '#fte-pause' },
			operation: { kind: 'click' }, expect: { cl_demospeed: '0' },
		},
		{
			issue: 43,
			label: 'resume demo button', target: { selector: '#fte-pause' },
			operation: { kind: 'click' }, expect: { cl_demospeed: '1' },
		},
		...DEMO_MOMENTS.map((moment) => ({
			issue: 23,
			label: `${moment.label} demo moment`,
			target: { selector: `[data-demo-jump="${moment.target}"]` },
			operation: { kind: 'click' },
			moment,
		})),
		{
			label: 'volume slider', target: { selector: '#fte-volume' },
			operation: { kind: 'fill', value: '0.35' }, expect: { volume: '0.35' },
		},
		{
			label: 'mute button', target: { selector: '#fte-mute' },
			operation: { kind: 'click' }, expect: { volume: '0' },
		},
		{
			label: 'unmute button restores the slider', target: { selector: '#fte-mute' },
			operation: { kind: 'click' }, expect: { volume: '0.35' },
		},
		{
			issue: 24,
			label: 'Snap grid toggle', target: { selector: '#snap-grid' },
			operation: { kind: 'click' },
		},
		{
			issue: 24,
			label: 'Snap grid step', target: { selector: '#snap-step' },
			operation: { kind: 'fill', value: '5' },
		},
		{
			issue: 24,
			label: 'Magnet toggle', target: { selector: '#snap-magnet' },
			operation: { kind: 'click' },
		},
		{
			issue: 25,
			label: 'Editor size: 125%', target: { selector: '#ui-scale' },
			operation: { kind: 'select', value: '1.25' },
			editorOnly: {
				unchangedCvar: `hud_${candidate.name}_pos_y`,
				metricSelector: '.panel--tree', metricProperty: 'width', minimumFactor: 1.15,
				storageKey: 'ezhud.ui.scale', forbiddenExport: 'ezhud.ui.scale', restore: '1',
			},
		},
		{
			label: 'killfeed Where: Console messages',
			target: { selector: '#killfeed .seg__item', text: 'Console messages' },
			operation: { kind: 'click' }, expect: { r_tracker: '0', con_fragmessages: '1' },
		},
		{
			label: 'killfeed Where: Dedicated killfeed',
			target: { selector: '#killfeed .seg__item', text: 'Dedicated killfeed' },
			operation: { kind: 'click' }, expect: { r_tracker: '1', con_fragmessages: '0' },
		},
		{
			label: 'killfeed Where: Both',
			target: { selector: '#killfeed .seg__item', text: 'Both' },
			operation: { kind: 'click' }, expect: { r_tracker: '1', con_fragmessages: '1' },
		},
		{
			label: 'killfeed Style: Weapon icons',
			target: { selector: '#killfeed .seg__item', text: 'Weapon icons' },
			operation: { kind: 'click' }, expect: { cl_useimagesinfraglog: '1' },
		},
		{
			label: 'killfeed Style: Classic text',
			target: { selector: '#killfeed .seg__item', text: 'Classic text' },
			operation: { kind: 'click' }, expect: { cl_useimagesinfraglog: '0' },
		},
		{
			label: 'killfeed Show frags',
			target: { selector: '#killfeed label[title="Sets r_tracker_frags 0/1."] input' },
			operation: { kind: 'click' }, expect: { r_tracker_frags: '0' },
		},
		{
			label: 'killfeed Show streaks',
			target: { selector: '#killfeed label[title="Sets r_tracker_streaks 0/1."] input' },
			operation: { kind: 'click' }, expect: { r_tracker_streaks: '1' },
		},
		{
			label: 'killfeed Show flag events',
			target: { selector: '#killfeed label[title="Sets r_tracker_flags 0/1."] input' },
			operation: { kind: 'click' }, expect: { r_tracker_flags: '1' },
		},
		{
			label: 'killfeed Show pickups',
			target: { selector: '#killfeed label[title="Sets r_tracker_pickups 0/1."] input' },
			operation: { kind: 'click' }, expect: { r_tracker_pickups: '1' },
		},
		{
			label: 'killfeed Align right',
			target: { selector: '#killfeed label[title="Sets r_tracker_align_right 0/1."] input' },
			operation: { kind: 'click' }, expect: { r_tracker_align_right: '0' },
		},
		{
			label: 'killfeed Seconds on screen',
			target: { selector: '#killfeed input[title="Sets r_tracker_time."]' },
			operation: { kind: 'fill', value: '6', commit: true }, expect: { r_tracker_time: '6' },
		},
		{
			label: 'killfeed Max lines',
			target: { selector: '#killfeed input[title="Sets r_tracker_messages."]' },
			operation: { kind: 'fill', value: '7', commit: true }, expect: { r_tracker_messages: '7' },
		},
		{
			label: 'killfeed Scale',
			target: { selector: '#killfeed input[title="Sets r_tracker_scale."]' },
			operation: { kind: 'fill', value: '1.25', commit: true }, expect: { r_tracker_scale: '1.25' },
		},
		{
			label: 'HUD system: Classic',
			target: { selector: '#hudmodes .seg__item', text: 'Classic' },
			operation: { kind: 'click' }, expect: { scr_newhud: '0' },
		},
		{
			label: 'QW262 overlay', target: { selector: '#hudmodes label.toggle input' },
			operation: { kind: 'click' },
			exportOnly: { unchangedCvar: 'scr_newhud', line: 'cl_hud "0"' },
		},
		{
			label: 'classic bar', target: { selector: '#hudmodes select', index: 0 },
			operation: { kind: 'select', value: '1' }, expect: { cl_sbar: '1' },
		},
		{
			label: 'classic compact style', target: { selector: '#hudmodes select', index: 1 },
			operation: { kind: 'select', value: '1' },
			exportOnly: { unchangedCvar: 'scr_newhud', line: 'scr_compacthud "1"' },
		},
		{
			label: 'classic viewsize', target: { selector: '#hudmodes input[type="number"]' },
			operation: { kind: 'fill', value: '110', commit: true }, expect: { viewsize: '110' },
		},
		{
			label: 'HUD system: New',
			target: { selector: '#hudmodes .seg__item', text: 'New' },
			operation: { kind: 'click' }, expect: { scr_newhud: '1' },
		},
		{
			label: 'HUD system: Both',
			target: { selector: '#hudmodes .seg__item', text: 'Both' },
			operation: { kind: 'click' }, expect: { scr_newhud: '2' },
		},
		{
			label: `${candidate.name} visibility`,
			target: { selector: `.tree__row[data-name="${candidate.name}"] .tree__vis` },
			operation: { kind: 'click' }, expect: { [`hud_${candidate.name}_show`]: '0' },
		},
		{
			label: `${candidate.name} numeric placement`, prepare: { selectElement: candidate.name },
			target: { selector: `#f-${candidate.name}-pos_x` },
			operation: { kind: 'fill', value: '37', commit: true },
			expect: { [`hud_${candidate.name}_pos_x`]: '37' },
		},
		{
			label: 'tracker inspector scale', prepare: { selectElement: 'tracker' },
			target: { selector: '#f-tracker-scale' },
			operation: { kind: 'fill', value: '1.5', commit: true },
			expect: { hud_tracker_scale: '1.5' },
		},
		{
			label: 'Reset positions', target: { selector: '#hudmodes button.btn', text: 'Reset positions…' },
			operation: { kind: 'reset' }, expect: { [`hud_${candidate.name}_pos_x`]: String(candidate.pos_x) },
		},
	];
	// Explicit non-engine controls and repeated/generated controls. Keeping these
	// beside the table makes every omission reviewable; the coverage case below
	// also rejects an exemption whose selector has gone stale.
	const controlExemptions = [
		{ selector: '#chrome', reason: 'editor view filter, no engine/export effect' },
		{ selector: '#filter', reason: 'editor view filter, no engine/export effect' },
		{ selector: '#show-hidden', reason: 'editor view filter, no engine/export effect' },
		{ selector: '#show-spectator', reason: 'editor view filter, no engine/export effect' },
		{ selector: '#save-open', reason: 'export workflow proven by case 5' },
		{ selector: '#tree .tree__vis', reason: 'generated visibility buttons share the table visibility path' },
		{ selector: '#groups .grouplist__item', reason: 'generated group selectors, editor placement path' },
		{ selector: '#groups .grouplist__detach', reason: 'editor group placement shortcut' },
		{ selector: '#fonts #face', reason: 'FTE font view has no engine/export setting to apply' },
		{ selector: '#inspector select', reason: 'generated placement selectors share the numeric inspector apply path' },
		{ selector: '#inspector input:not(#f-tracker-scale)', reason: 'generated inspector fields share the table apply path' },
		{ selector: '#inspector button.swatch', reason: 'generated colour picker shares the inspector apply path' },
		{ selector: '#reset-dialog button', reason: 'operated inside the reset operation' },
	];

	let nextCase = 8;
	for (const row of controlCases.filter((entry) => ![23, 24, 25, 43].includes(entry.issue))) {
		await proveControl(row);
		const effect = row.expect
			? Object.entries(row.expect).map(([name, value]) => `${name}=${value}`).join(', ')
			: `${row.exportOnly.line}; ${row.exportOnly.unchangedCvar} unchanged`;
		pass(nextCase++, `${row.label} — ${effect}`);
	}

	// ---- anti-stale control coverage ---------------------------------------
	// Cases 1-7 cover host/editor gestures outside the declarative table. A
	// prepare target is coverage too: selecting its tree row is an operation the
	// corresponding table case must successfully perform before its target can
	// exist. Inspector targets are transient because only one selected element's
	// controls can be in the DOM at a time; proveControl already waited for each.
	const priorCoverage = [
		{ label: 'case 6 demo picker', selector: '#fte-demo' },
		{ label: 'case 4 cfg drop zone', selector: '#fte-drop' },
		{ label: 'case 2 tree rows', selector: '.tree__row' },
		{ label: 'case 3 overlay drag', selector: '#overlay .box' },
	];
	const tableCoverage = controlCases.flatMap((row) => [
		{
			label: `table row: ${row.label}`,
			...row.target,
			transient: Boolean(row.prepare),
		},
		...(row.prepare?.selectElement ? [{
			label: `prepare target: ${row.prepare.selectElement}`,
			selector: `.tree__row[data-name="${row.prepare.selectElement}"]`,
		}] : []),
	]);
	const coverage = [...priorCoverage, ...tableCoverage];

	// Open the reset confirmation so its inner controls are honestly present in
	// the live snapshot and the exemption can itself be stale-checked.
	await page.locator('#hudmodes button.btn', { hasText: /^Reset positions…$/ }).click();
	await page.locator('#reset-dialog[open]').waitFor({ timeout: UI_WAIT });
	try {
		await page.evaluate(() => {
			const fake = document.createElement('button');
			fake.id = 'tier4-fte-uncovered-self-test';
			fake.type = 'button';
			fake.textContent = 'Coverage self-test';
			document.querySelector('.panel--inspect').append(fake);
		});
		try {
			const broken = await auditInteractiveControls(coverage, controlExemptions);
			assert(broken.unmatched.includes('#tier4-fte-uncovered-self-test'),
				`coverage self-test did not name its fake control: ${broken.unmatched.join(', ')}`);
		} finally {
			await page.evaluate(() => document.querySelector('#tier4-fte-uncovered-self-test')?.remove());
		}

		const audit = await auditInteractiveControls(coverage, controlExemptions);
		assert(audit.unmatched.length === 0,
			`new control without a 4F row or exemption: ${audit.unmatched.join(', ')}`);
		assert(audit.staleCovered.length === 0,
			`stale row/covered selector: ${audit.staleCovered.join(', ')}`);
		assert(audit.staleExempt.length === 0,
			`stale row/exemption: ${audit.staleExempt.join(', ')}`);
		pass(nextCase++, `${audit.controls} live controls covered or exempt; fake-button self-test was detected`);
	} finally {
		await page.locator('#reset-dialog button', { hasText: /^Cancel$/ }).click().catch(() => {});
		await page.locator('#reset-dialog[open]').waitFor({ state: 'hidden', timeout: UI_WAIT }).catch(() => {});
	}

	// ---- visual truth: the real tracker pixels -----------------------------
	// Restart the real-frag demo through its visible picker so the 90s budget
	// starts at a known point instead of wherever the control matrix left it.
	await page.selectOption('#fte-demo', host.initialDemo);
	await eventually(async () => (await readChrome()).title.includes(firstDemo),
		`the hot engine to return to ${firstDemo}`, UI_WAIT);
	await page.selectOption('#fte-demo', second.path);
	await eventually(async () => {
		const [chrome, state] = await Promise.all([readChrome(), readState()]);
		return chrome.title.includes(secondName) && state.live ? true : null;
	}, `the engine to restart and draw ${secondName}`, ENGINE_WAIT);
	// Put the moving 3-D view inside FTE's static border. The tracker remains a
	// live new-HUD element over that border, while hiding it now leaves a region
	// whose pixels can honestly stay unchanged during demo playback.
	const visualViewsize = page.locator('#hudmodes input[type="number"]');
	await visualViewsize.fill('30');
	await visualViewsize.press('Enter');
	await eventually(async () => await readCvar('viewsize') === '30' ? true : null,
		'the visual case to establish a static view border', UI_WAIT);
	const visualDeadline = Date.now() + 90000;

	// Remove editor outlines from the capture. This is a real UI operation and
	// prevents the overlay box itself from masquerading as tracker pixels.
	if (await page.locator('#chrome').isChecked()) {
		await page.locator('#chrome').click();
	}
	const dedicated = page.locator('#killfeed .seg__item').filter({ hasText: /^Dedicated killfeed$/ });
	await dedicated.click();
	await eventually(async () => await readCvar('r_tracker') === '1' ? true : null,
		'the visual case to enable r_tracker', UI_WAIT);
	const frags = page.locator('#killfeed label[title="Sets r_tracker_frags 0/1."] input');
	if (!(await frags.isChecked())) {
		await frags.click();
	}
	await eventually(async () => await readCvar('r_tracker_frags') === '1' ? true : null,
		'the visual case to enable frag rows', UI_WAIT);
	const trackerTime = page.locator('#killfeed input[title="Sets r_tracker_time."]');
	await trackerTime.fill('60');
	await trackerTime.press('Enter');
	await eventually(async () => await readCvar('r_tracker_time') === '60' ? true : null,
		'the visual case to retain a frag until the next one', UI_WAIT);

	// Console cvar probes are also drawn as NOTIFY text by FTE. The pinned
	// engine honours con_notifylines as the main console's maximum notify-line
	// count, so preserve it, set it to zero through the raw channel, and prove
	// the live engine accepted that value before taking any comparison image.
	// Restoration and its confirming probe happen only after all captures.
	const originalNotifyLines = await readCvar('con_notifylines');
	assert(/^-?\d+$/.test(originalNotifyLines),
		`con_notifylines is not an integer: ${JSON.stringify(originalNotifyLines)}`);
	let notifyLinesSilenced = false;
	let demoFrozen = false;
	let dynamicHudHidden = false;
	let originalGameclockShow;
	let originalFpsShow;
	let visualPassText;
	try {
		await page.evaluate(() => {
			const channel = window.EZHUD_FTE?.engine()?.ftec;
			if (!channel) {
				throw new Error('the live FTE command channel is unavailable');
			}
			channel.cbufadd('con_notifylines 0\n');
		});
		notifyLinesSilenced = true;
		await eventually(async () => await readCvar('con_notifylines') === '0' ? true : null,
			'the visual case to silence FTE console notify lines', UI_WAIT);

		// At vid_conautoscale 2 the tracker occupies more of the canvas, so its
		// mirrored clip is no longer wholly over viewsize 30's static border.
		// Let the pinned demo reach its first obituary (about ten seconds in), so
		// enabling the tracker has a retained row to reveal, then freeze before
		// establishing either hidden or enabled pixels. Any difference is then
		// the tracker itself, never the moving 3-D view.
		await sleep(12000);
		await page.evaluate(() => {
			const channel = window.EZHUD_FTE?.engine()?.ftec;
			if (!channel) {
				throw new Error('the live FTE command channel is unavailable');
			}
			channel.cbufadd('demo_setspeed 0\n');
		});
		demoFrozen = true;
		await eventually(async () => await readCvar('cl_demospeed') === '0' ? true : null,
			'the visual case to freeze demo playback', UI_WAIT);
		// Let interpolation and any packet already queued before the speed change
		// settle before the hidden baseline starts.
		await sleep(2000);

		// cl_demospeed freezes demo packets, but this FTE build continues to
		// advance cl.time for interpolation. The gameclock (and its child FPS)
		// therefore remains live over the now-larger tracker clip. Preserve and
		// hide those unrelated HUD pixels so the comparison isolates tracker.
		originalGameclockShow = await readCvar('hud_gameclock_show');
		originalFpsShow = await readCvar('hud_fps_show');
		await page.evaluate(() => {
			const channel = window.EZHUD_FTE?.engine()?.ftec;
			if (!channel) {
				throw new Error('the live FTE command channel is unavailable');
			}
			channel.cbufadd('set hud_gameclock_show 0\nset hud_fps_show 0\n');
		});
		dynamicHudHidden = true;
		await eventually(async () => {
			const [gameclock, fps] = await Promise.all([
				readCvar('hud_gameclock_show'), readCvar('hud_fps_show'),
			]);
			return gameclock === '0' && fps === '0' ? true : null;
		}, 'the visual case to hide unrelated dynamic HUD pixels', UI_WAIT);

		const messageRows = Number(await readCvar('r_tracker_messages'));
		assert(Number.isInteger(messageRows) && messageRows > 0,
			`r_tracker_messages is not a positive integer: ${JSON.stringify(messageRows)}`);
		const clip = await trackerClip(messageRows, Math.max(1, visualDeadline - Date.now()));
		const trackerVisibility = page.locator('.tree__row[data-name="tracker"] .tree__vis');
		if ((await readCvar('hud_tracker_show')) !== '0') {
			await trackerVisibility.click();
		}
		await eventually(async () => await readCvar('hud_tracker_show') === '0' ? true : null,
			'the tracker visibility control to hide the tracker', UI_WAIT);

		// From this point until the final enabled capture, do not issue console
		// probes: each comparison window consists only of settling and captures.
		await sleep(500);
		const hiddenBefore = await captureRegion('tracker-hidden-before', clip);
		await sleep(1000);
		const hiddenAfter = await captureRegion('tracker-hidden-after', clip);
		assert(hiddenAfter.signature === hiddenBefore.signature,
			`tracker region changed while hidden (${hiddenBefore.signature} -> ${hiddenAfter.signature})`);

		await trackerVisibility.click();
		await sleep(500);
		const enabled = await captureRegion('tracker-enabled', clip);
		assert(enabled.signature !== hiddenAfter.signature,
			'the enabled tracker never differed from its hidden pixel baseline');
		visualPassText = 'tracker pixels differed from the hidden baseline and stayed static while hidden';
	} finally {
		if (demoFrozen) {
			// Restore normal playback only after the last comparison capture. Keep
			// notify lines silenced until this command has been queued as well.
			await page.evaluate(() => {
				const channel = window.EZHUD_FTE?.engine()?.ftec;
				if (!channel) {
					throw new Error('the live FTE command channel is unavailable');
				}
				channel.cbufadd('demo_setspeed 100\n');
			});
		}
		if (dynamicHudHidden) {
			await page.evaluate(([gameclock, fps]) => {
				const channel = window.EZHUD_FTE?.engine()?.ftec;
				if (!channel) {
					throw new Error('the live FTE command channel is unavailable');
				}
				channel.cbufadd(`set hud_gameclock_show ${gameclock}\nset hud_fps_show ${fps}\n`);
			}, [originalGameclockShow, originalFpsShow]);
		}
		if (notifyLinesSilenced) {
			await page.evaluate((value) => {
				const channel = window.EZHUD_FTE?.engine()?.ftec;
				if (!channel) {
					throw new Error('the live FTE command channel is unavailable');
				}
				channel.cbufadd(`con_notifylines ${value}\n`);
			}, originalNotifyLines);
			await eventually(async () => await readCvar('con_notifylines') === originalNotifyLines ? true : null,
				'the visual case to restore FTE console notify lines', UI_WAIT);
		}
	}
	pass(nextCase++, visualPassText);

	// Preserve the historical 1–36 numbering (especially the anti-stale audit
	// at case 35), then append new-ticket functional/control rows.
	pass(nextCase++, demoPausePassText);
	pass(nextCase++, demoReadbackPassText);
	for (const row of controlCases.filter((entry) => entry.issue === 25)) {
		await proveControl(row);
		pass(nextCase++, `${row.label} — chrome, canvas and state resized; HUD placement unchanged`);
	}

	// ---- #32 alignment-first workflow against the real wasm engine ----------
	// The tracker pixel case deliberately hid editor outlines. Relationship
	// visualization is the subject now, so restore the visible Overlay control.
	if (!(await page.locator('#chrome').isChecked())) {
		await page.locator('#chrome').click();
	}
	const alignmentPool = await readDrawn();
	const anchorParent = alignmentPool.find((entry) => entry.name === candidate.name)
		?? alignmentPool.find((entry) => !entry.parent);
	const anchorChild = alignmentPool.find((entry) => entry.name !== anchorParent?.name
		&& entry.name !== 'tracker'
		&& entry.parent !== anchorParent?.name
		&& anchorParent?.parent !== entry.name
		&& entry.rect.w !== anchorParent?.rect.w);
	assert(anchorParent && anchorChild,
		`could not choose two independent drawn elements for #32: ${JSON.stringify(alignmentPool)}`);
	const originals = {
		parent: await readState(anchorParent.name),
		child: await readState(anchorChild.name),
	};
	const selectForPlacement = async (name) => {
		await page.locator(`.tree__row[data-name="${name}"]`).click();
		await eventually(async () => await page.locator('#inspector .inspect__name').textContent() === name
			? true : null, `the inspector to select ${name}`, UI_WAIT);
	};
	const setPlacementField = async (name, suffix, value) => {
		await selectForPlacement(name);
		const control = page.locator(`#f-${name}-${suffix}`);
		await control.waitFor({ state: 'visible', timeout: UI_WAIT });
		if (await control.evaluate((node) => node.tagName === 'SELECT')) {
			await control.selectOption(String(value));
		} else {
			await control.fill(String(value));
			await control.press('Enter');
		}
		await eventually(async () => await readCvar(`hud_${name}_${suffix}`) === String(value)
			? true : null, `${name} ${suffix}=${value}`, UI_WAIT);
	};
	try {
		await setPlacementField(anchorChild.name, 'place', `@${anchorParent.name}`);
		await setPlacementField(anchorChild.name, 'align_x', 'left');
		await setPlacementField(anchorChild.name, 'align_y', 'top');
		await setPlacementField(anchorChild.name, 'pos_x', '0');
		await setPlacementField(anchorChild.name, 'pos_y', '0');
		await setPlacementField(anchorChild.name, 'order', '7');
		const anchored = await eventually(async () => {
			const parentState = await readState(anchorParent.name);
			const childState = await readState(anchorChild.name);
			return childState.element?.parent === anchorParent.name
				&& childState.element.rect?.x === parentState.element.rect?.x
				&& childState.element.rect?.y === parentState.element.rect?.y
				? { parent: parentState.element, child: childState.element } : null;
		}, 'the child engine rect to land on its parent anchor', UI_WAIT);
		await page.locator(`#overlay .anchor-link[data-child="${anchorChild.name}"]`
			+ `[data-anchor="${anchorParent.name}"]`).waitFor({ timeout: UI_WAIT });

		// Moving the parent through the real overlay gesture must move both engine
		// rects by one identical delta.
		await selectForPlacement(anchorParent.name);
		const parentBox = page.locator('#overlay .box[data-selected="true"]');
		const parentBounds = await parentBox.boundingBox();
		assert(parentBounds, `${anchorParent.name} has no draggable overlay box`);
		await page.mouse.move(parentBounds.x + parentBounds.width / 2,
			parentBounds.y + parentBounds.height / 2);
		await page.mouse.down();
		await page.mouse.move(parentBounds.x + parentBounds.width / 2 + 30,
			parentBounds.y + parentBounds.height / 2, { steps: 6 });
		await page.mouse.up();
		const movedPair = await eventually(async () => {
			const parentState = (await readState(anchorParent.name)).element;
			const childState = (await readState(anchorChild.name)).element;
			return parentState.rect?.x !== anchored.parent.rect.x ? { parentState, childState } : null;
		}, 'the anchored pair to move from one parent drag', UI_WAIT);
		const parentDelta = movedPair.parentState.rect.x - anchored.parent.rect.x;
		const childDelta = movedPair.childState.rect.x - anchored.child.rect.x;
		assert(parentDelta !== 0 && childDelta === parentDelta,
			`parent/child rect delta mismatch: ${parentDelta} vs ${childDelta}`);

		// Alignment and offsets are all checked from engine rect readback.
		for (const alignment of ['left', 'center', 'right']) {
			await setPlacementField(anchorChild.name, 'align_x', alignment);
			const pair = await eventually(async () => {
				const parentState = (await readState(anchorParent.name)).element;
				const childState = (await readState(anchorChild.name)).element;
				return childState.align_x === alignment ? { parentState, childState } : null;
			}, `${alignment} alignment readback`, UI_WAIT);
			const expected = alignment === 'left' ? pair.parentState.rect.x
				: alignment === 'center'
					? pair.parentState.rect.x + Math.trunc((pair.parentState.rect.w - pair.childState.rect.w) / 2)
					: pair.parentState.rect.x + pair.parentState.rect.w - pair.childState.rect.w;
			assert(pair.childState.rect.x === expected,
				`${alignment} expected engine x=${expected}, got ${pair.childState.rect.x}`);
		}
		await setPlacementField(anchorChild.name, 'pos_x', '7');
		await setPlacementField(anchorChild.name, 'pos_y', '9');
		const offsetPair = {
			parent: (await readState(anchorParent.name)).element,
			child: (await readState(anchorChild.name)).element,
		};
		assert(offsetPair.child.rect.x === offsetPair.parent.rect.x + offsetPair.parent.rect.w
			- offsetPair.child.rect.w + 7
			&& offsetPair.child.rect.y === offsetPair.parent.rect.y + 9,
			`fine-tune offsets disagree with engine rects: ${JSON.stringify(offsetPair)}`);

		await selectForPlacement(anchorParent.name);
		const cycle = await page.locator(`#f-${anchorParent.name}-place option[value="@${anchorChild.name}"]`)
			.evaluate((option) => ({ disabled: option.disabled, text: option.textContent }));
		assert(cycle.disabled && /unavailable.*cycle/i.test(cycle.text),
			`placement cycle was not refused with a reason: ${JSON.stringify(cycle)}`);

		const relationshipCfg = await readExport();
		assert(relationshipCfg.split('\n').includes(`hud_${anchorChild.name}_place "@${anchorParent.name}"`),
			'the anchored full export omitted the relationship');
		await page.evaluate(([name]) => {
			const channel = window.EZHUD_FTE?.engine()?.ftec;
			channel.cbufadd(`set hud_${name}_place screen\nhud_recalculate\n`);
		}, [anchorChild.name]);
		await eventually(async () => (await readState(anchorChild.name)).element?.parent === null
			? true : null, 'the child relationship to be disturbed before re-import', UI_WAIT);
		const relationshipTransfer = await page.evaluateHandle(([text, name]) => {
			const data = new DataTransfer();
			data.items.add(new File([text], name, { type: 'text/plain' }));
			return data;
		}, [relationshipCfg, 'alignment-roundtrip.cfg']);
		await page.dispatchEvent('#fte-drop', 'drop', { dataTransfer: relationshipTransfer });
		await eventually(async () => (await readState(anchorChild.name)).element?.parent === anchorParent.name
			? true : null, 're-import to restore the parent relationship', UI_WAIT);
		pass(nextCase++, `${anchorChild.name} anchored to ${anchorParent.name}: drag, 3 alignments, offsets, cycle refusal and relationship round trip`);
	} finally {
		await page.evaluate(({ parentName, childName, parent, child }) => {
			const channel = window.EZHUD_FTE?.engine()?.ftec;
			if (!channel) return;
			for (const [name, value] of [
				[`hud_${parentName}_pos_x`, parent.pos_x], [`hud_${parentName}_pos_y`, parent.pos_y],
				[`hud_${childName}_place`, child.place], [`hud_${childName}_align_x`, child.align_x],
				[`hud_${childName}_align_y`, child.align_y], [`hud_${childName}_pos_x`, child.pos_x],
				[`hud_${childName}_pos_y`, child.pos_y], [`hud_${childName}_order`, child.order],
			]) channel.cbufadd(`set ${name} ${value}\n`);
			channel.cbufadd('hud_recalculate\n');
		}, {
			parentName: anchorParent.name, childName: anchorChild.name,
			parent: originals.parent.element, child: originals.child.element,
		}).catch(() => {});
	}

	// ---- #24 grid + magnet against the real wasm engine ---------------------
	const snapGrid = page.locator('#snap-grid');
	const snapStep = page.locator('#snap-step');
	const snapMagnet = page.locator('#snap-magnet');
	assert(!(await snapGrid.isChecked()) && !(await snapMagnet.isChecked()),
		'drag assistance did not start visibly off');
	const dragSubjectOriginal = (await readState(candidate.name)).element;
	const snapPool = await readDrawn();
	const magnetTarget = snapPool.find((entry) => entry.name !== candidate.name
		&& entry.parent !== candidate.name && candidate.parent !== entry.name
		&& entry.rect.x > candidate.rect.w + 12 && entry.name !== 'tracker');
	assert(magnetTarget, `no drawn target can host the magnet case: ${JSON.stringify(snapPool)}`);
	const placeSubject = async (x, y) => {
		await page.evaluate(({ name, x, y }) => {
			const channel = window.EZHUD_FTE?.engine()?.ftec;
			channel.cbufadd(`set hud_${name}_place screen\nset hud_${name}_align_x left\n`
				+ `set hud_${name}_align_y top\nset hud_${name}_pos_x ${x}\n`
				+ `set hud_${name}_pos_y ${y}\nhud_recalculate\n`);
		}, { name: candidate.name, x, y });
		await eventually(async () => {
			const state = (await readState(candidate.name)).element;
			return state.place === 'screen' && state.align_x === 'left' && state.align_y === 'top'
				&& state.pos_x === String(x) && state.pos_y === String(y) ? state : null;
		}, `${candidate.name} screen placement ${x},${y}`, UI_WAIT);
		await waitEditorCaughtUp(candidate.name);
	};
	const dragSubject = async (dx, dy, { alt = false, beforeUp = null } = {}) => {
		await selectForPlacement(candidate.name);
		const beforeDrag = (await readState(candidate.name)).element;
		const subjectBox = page.locator('#overlay .box[data-selected="true"]');
		const rect = await subjectBox.boundingBox();
		assert(rect, `${candidate.name} has no box for drag assistance`);
		if (alt) await page.keyboard.down('Alt');
		try {
			await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
			await page.mouse.down();
			await page.mouse.move(rect.x + rect.width / 2 + dx,
				rect.y + rect.height / 2 + dy, { steps: 5 });
			if (beforeUp) await beforeUp();
			await page.mouse.up();
		} finally {
			if (alt) await page.keyboard.up('Alt');
		}
		return eventually(async () => {
			const state = (await readState(candidate.name)).element;
			return state && (state.pos_x !== beforeDrag.pos_x || state.pos_y !== beforeDrag.pos_y)
				? state : null;
		}, `${candidate.name} drag readback`, UI_WAIT);
	};
	try {
		await snapGrid.click();
		await snapStep.fill('8');
		await placeSubject(13, 80);
		let gridResult = await dragSubject(29, 0);
		assert(Number(gridResult.pos_x) % 8 === 0,
			`8px live grid produced pos_x=${gridResult.pos_x}`);

		await snapStep.fill('5');
		await placeSubject(13, 80);
		gridResult = await dragSubject(29, 0);
		assert(Number(gridResult.pos_x) % 5 === 0,
			`5px live grid produced pos_x=${gridResult.pos_x}`);

		await snapGrid.click();
		await placeSubject(13, 80);
		const freeResult = await dragSubject(7, 0);
		assert(Number(freeResult.pos_x) % 5 !== 0,
			`grid-off live drag still quantized pos_x=${freeResult.pos_x}`);

		await snapMagnet.click();
		const nearX = magnetTarget.rect.x - candidate.rect.w - 3;
		await placeSubject(nearX, magnetTarget.rect.y);
		let guideTarget = null;
		let guideAxis = null;
		const magnetResult = await dragSubject(4, 0, {
			beforeUp: async () => {
				const guide = page.locator('#overlay .snap-guide').first();
				await guide.waitFor({ timeout: UI_WAIT });
				guideTarget = await guide.getAttribute('data-target');
				guideAxis = (await guide.getAttribute('class')).includes('snap-guide--x') ? 'x' : 'y';
			},
		});
		const targetAfterMagnet = (await readDrawn()).find((entry) => entry.name === guideTarget)?.rect;
		const sourcePoints = guideAxis === 'x'
			? [magnetResult.rect.x, magnetResult.rect.x + magnetResult.rect.w / 2,
				magnetResult.rect.x + magnetResult.rect.w]
			: [magnetResult.rect.y, magnetResult.rect.y + magnetResult.rect.h / 2,
				magnetResult.rect.y + magnetResult.rect.h];
		const targetPoints = !targetAfterMagnet ? [] : guideAxis === 'x'
			? [targetAfterMagnet.x, targetAfterMagnet.x + targetAfterMagnet.w / 2,
				targetAfterMagnet.x + targetAfterMagnet.w]
			: [targetAfterMagnet.y, targetAfterMagnet.y + targetAfterMagnet.h / 2,
				targetAfterMagnet.y + targetAfterMagnet.h];
		assert(sourcePoints.some((value) => targetPoints.includes(value)),
			`live magnet guide ${guideAxis}/${guideTarget} did not end in exact engine alignment`);

		await snapMagnet.click();
		await placeSubject(nearX, magnetTarget.rect.y);
		await dragSubject(4, 0, {
			beforeUp: async () => assert(await page.locator('#overlay .snap-guide').count() === 0,
				'magnet-off live drag still drew a guide'),
		});

		await snapGrid.click();
		await snapMagnet.click();
		await snapStep.fill('8');
		await placeSubject(14, 80);
		const bypassResult = await dragSubject(7, 0, {
			alt: true,
			beforeUp: async () => assert(await page.locator('#overlay .snap-guide').count() === 0,
				'Alt bypass still drew a live guide'),
		});
		assert(Number(bypassResult.pos_x) % 8 !== 0,
			`Alt bypass still grid-snapped live pos_x=${bypassResult.pos_x}`);
		const dragAssistExport = await readExport();
		assert(!/snap|magnet/i.test(dragAssistExport),
			'drag assistance leaked editor-only state into the full export');
		pass(nextCase++, `${candidate.name} drag: 8/5 grids, free pixels, magnet guide + exact engine edge, Alt bypass, clean export`);
	} finally {
		if (await snapGrid.isChecked()) await snapGrid.click().catch(() => {});
		if (await snapMagnet.isChecked()) await snapMagnet.click().catch(() => {});
		await snapStep.fill('8').catch(() => {});
		await page.evaluate(({ name, original }) => {
			const channel = window.EZHUD_FTE?.engine()?.ftec;
			if (!channel) return;
			for (const [suffix, value] of Object.entries({
				place: original.place, align_x: original.align_x, align_y: original.align_y,
				pos_x: original.pos_x, pos_y: original.pos_y, order: original.order,
			})) channel.cbufadd(`set hud_${name}_${suffix} ${value}\n`);
			channel.cbufadd('hud_recalculate\n');
		}, { name: candidate.name, original: dragSubjectOriginal }).catch(() => {});
	}

	// ---- #23 deterministic moments against the real wasm engine -------------
	// Case 6 already selected the bundled tb4gf match. Drive each new authored
	// button while paused, then compare compact engine-state projections: all
	// three points must differ, and a second Scoreboard run must match the first.
	// The exact demo_jump command/argument is independently asserted in tier 3F.
	await eventually(async () => {
		const state = await readState();
		return state.demo?.cl_demospeed === '1'
			&& await pauseButton.getAttribute('aria-pressed') === 'false'
			&& await pauseButton.isEnabled() ? true : null;
	}, 'normal playback to reach the pause toggle before demo moments', UI_WAIT);
	await pauseButton.click();
	await eventually(async () => (await readState()).demo?.cl_demospeed === '0'
		&& await pauseButton.getAttribute('aria-pressed') === 'true' ? true : null,
	'the demo moments to start from paused engine state', UI_WAIT);

	const momentRows = new Map(controlCases
		.filter((entry) => entry.issue === 23)
		.map((row) => [row.moment.target, row]));
	const momentStates = new Map();
	let previousMoment = demoMomentSignature(await readDemoMomentState());
	const momentSubjectOriginal = (await readState(candidate.name)).element;
	try {
		for (const target of ['20:10', '0:10', '9:00', '20:10']) {
			const row = momentRows.get(target);
			assert(row, `missing declarative 4F row for demo moment ${target}`);
			await operateControl(row);
			const settledMoment = await waitForDemoMoment(previousMoment, row.label);
			const first = momentStates.get(target);
			if (first) {
				assert(settledMoment.signature === first,
					`${row.label} was not repeatable: ${first} != ${settledMoment.signature}`);
			} else {
				momentStates.set(target, settledMoment.signature);
				pass(nextCase++, `${row.label} — visible seek reached a settled paused engine state`);
			}
			previousMoment = settledMoment.signature;
		}
		assert(new Set(momentStates.values()).size === DEMO_MOMENTS.length,
			`the three demo controls did not reach distinct engine states: ${JSON.stringify([...momentStates])}`);

		// A visible placement edit while the same consumed-packet cursor is frozen
		// must still cross into the engine and into the user's full config export.
		await selectForPlacement(candidate.name);
		const pausedPosition = String((Number(momentSubjectOriginal.pos_x) || 0) + 3);
		const pausedControl = page.locator(`#f-${candidate.name}-pos_x`);
		await pausedControl.fill(pausedPosition);
		await pausedControl.press('Enter');
		await eventually(async () => await readCvar(`hud_${candidate.name}_pos_x`) === pausedPosition
			? true : null, `paused ${candidate.name} placement readback`, UI_WAIT);
		const pausedExport = await readExport();
		assert(pausedExport.split('\n').includes(`hud_${candidate.name}_pos_x "${pausedPosition}"`),
			`paused placement omitted hud_${candidate.name}_pos_x "${pausedPosition}" from the export`);
		assert((await readState()).demo?.cl_demospeed === '0',
			'the paused placement edit resumed demo playback');
		pass(nextCase++, 'Scoreboard repeated exactly; paused placement reached engine and full export');
	} finally {
		await page.evaluate(({ name, posX }) => {
			const channel = window.EZHUD_FTE?.engine()?.ftec;
			if (!channel) return;
			channel.cbufadd(`set hud_${name}_pos_x ${posX}\nhud_recalculate\ndemo_setspeed 100\n`);
		}, { name: candidate.name, posX: momentSubjectOriginal.pos_x }).catch(() => {});
		await eventually(async () => (await readState()).demo?.cl_demospeed === '1'
			? true : null, 'demo-moment cleanup to resume playback', UI_WAIT).catch(() => {});
	}

	// Case 36 resumes through the raw channel in its finally block, and #23's
	// cleanup does the same. Wait for that engine state to reach the visible
	// toggle before asking the toggle for its opposite; otherwise a deliberately
	// stale aria-pressed=true would correctly request another resume rather than
	// the pause this row expects.
	await eventually(async () => {
		const state = await readState();
		return state.demo?.cl_demospeed === '1'
			&& await pauseButton.getAttribute('aria-pressed') === 'false'
			&& await pauseButton.isEnabled() ? true : null;
	}, 'case 36 resume state to reach the pause toggle', UI_WAIT);
	for (const row of controlCases.filter((entry) => entry.issue === 43)) {
		await proveControl(row);
		const effect = Object.entries(row.expect)
			.map(([name, value]) => `${name}=${value}`).join(', ');
		pass(nextCase++, `${row.label} — ${effect}`);
	}

	// ---- #87: native-sized empty layouts stay positive ----------------------
	// Native ezQuake prepares tracking's real text footprint before deciding
	// whether there is tracking text to draw, and prepares net's fixed footprint
	// before deciding whether live network samples exist. This lane regression-
	// covers tracking off-CAM and pins net's normal positive footprint. It cannot
	// enter capturing=2 in the staged WebAssembly build, so the netstats capture
	// branch is covered by source parity only, as recorded in fork PR #1.
	const trackingLayoutBefore = (await readState('tracking')).element;
	const netLayoutBefore = (await readState('net')).element;
	assert(trackingLayoutBefore && netLayoutBefore,
		`tracking/net are absent from engine state: ${JSON.stringify({ trackingLayoutBefore, netLayoutBefore })}`);
	const nativeLayoutOriginals = {
		trackingShow: await readCvar('hud_tracking_show'),
		trackingScale: await readCvar('hud_tracking_scale'),
		netShow: await readCvar('hud_net_show'),
	};
	try {
		await page.evaluate(() => {
			const channel = window.EZHUD_FTE?.engine()?.ftec;
			if (!channel) throw new Error('the live FTE command channel is unavailable');
			channel.cbufadd('autotrack off\ntrack off\n'
				+ 'set hud_tracking_show 1\nset hud_tracking_place screen\n'
				+ 'set hud_tracking_align_x left\nset hud_tracking_align_y top\n'
				+ 'set hud_tracking_pos_x 24\nset hud_tracking_pos_y 24\n'
				+ 'set hud_tracking_scale 1\n'
				+ 'set hud_net_show 1\nset hud_net_place screen\n'
				+ 'set hud_net_align_x left\nset hud_net_align_y top\n'
				+ 'set hud_net_pos_x 24\nset hud_net_pos_y 48\nhud_recalculate\n');
		});
		await eventually(async () => await readCvar('hud_tracking_scale') === '1' ? true : null,
			'the controlled tracking scale to apply', UI_WAIT);
		await eventually(async () => {
			const nativeEmptyLayouts = await readRectContract();
			const missing = ['tracking', 'net']
				.filter((name) => !nativeEmptyLayouts[name]
					|| nativeEmptyLayouts[name].w <= 0 || nativeEmptyLayouts[name].h <= 0)
				.map((name) => ({ name, rect: nativeEmptyLayouts[name] }));
			assert(missing.length === 0,
				`native-sized empty layouts must stay positive: ${JSON.stringify({ missing, nativeEmptyLayouts })}`);
			assert(nativeEmptyLayouts.tracking.h === 8,
				`tracking must use its real 8px scaled height, got ${JSON.stringify(nativeEmptyLayouts.tracking)}`);
			assert(nativeEmptyLayouts.net.w === 128 && nativeEmptyLayouts.net.h === 132,
				`net must use its real fixed footprint, got ${JSON.stringify(nativeEmptyLayouts.net)}`);
			assert(nativeEmptyLayouts.nonPositive.length === 0,
				`#87 elements reported non-positive rects: ${JSON.stringify(nativeEmptyLayouts)}`);
			return nativeEmptyLayouts;
		}, 'the #87 tracking/net layouts to publish their next-frame contract', UI_WAIT);
		pass(nextCase++, 'off-CAM tracking retains its native positive footprint; net capture path is source-parity only');
	} finally {
		await page.evaluate(({ tracking, net, originals }) => {
			const channel = window.EZHUD_FTE?.engine()?.ftec;
			if (!channel) return;
			channel.cbufadd(`set hud_tracking_show ${originals.trackingShow}\n`
				+ `set hud_tracking_place ${tracking.place}\nset hud_tracking_align_x ${tracking.align_x}\n`
				+ `set hud_tracking_align_y ${tracking.align_y}\nset hud_tracking_pos_x ${tracking.pos_x}\n`
				+ `set hud_tracking_pos_y ${tracking.pos_y}\nset hud_tracking_scale ${originals.trackingScale}\n`
				+ `set hud_net_show ${originals.netShow}\nset hud_net_place ${net.place}\n`
				+ `set hud_net_align_x ${net.align_x}\nset hud_net_align_y ${net.align_y}\n`
				+ `set hud_net_pos_x ${net.pos_x}\nset hud_net_pos_y ${net.pos_y}\n`
				+ 'autotrack\nhud_recalculate\n');
		}, { tracking: trackingLayoutBefore, net: netLayoutBefore, originals: nativeLayoutOriginals })
			.catch(() => {});
	}

	// ---- #87: a truly empty draw path is null, never a zero-area rect -------
	// Preserve a genuinely laid-out tracker, force the exact disabled branch
	// that used to call HUD_PrepareDraw(0, 0), and give its right alignment the
	// owner's positive offset. The old engine then reports x=screen+294,w=h=0.
	// The fixed engine must report null, as ownfrags already should when empty,
	// without suppressing the active tracker when the original layout returns.
	// A child anchored to the tracker must follow the same contract: once its
	// parent has no layout, it cannot invent placement from the parent's stale rect.
	const trackerBeforeEmpty = await eventually(async () => {
		const state = await readState('tracker');
		return state.element?.rect?.w > 0 && state.element.rect.h > 0 ? state : null;
	}, 'an active tracker rect before the empty-path contract', UI_WAIT);
	const trackerLayout = trackerBeforeEmpty.element;
	const anchoredChildName = 'gun2';
	const anchoredChildLayout = (await readDrawn())
		.find((element) => element.name === anchoredChildName);
	assert(anchoredChildLayout?.name === anchoredChildName && !anchoredChildLayout.parent,
		`${anchoredChildName} is not independently drawn before the inactive-parent case: `
		+ JSON.stringify(await readDrawn()));
	try {
		await page.evaluate(({ childName }) => {
			const channel = window.EZHUD_FTE?.engine()?.ftec;
			if (!channel) throw new Error('the live FTE command channel is unavailable');
			channel.cbufadd(`set hud_${childName}_place @tracker\nhud_recalculate\n`);
		}, { childName: anchoredChildLayout.name });
		await eventually(async () => {
			const state = (await readState(anchoredChildLayout.name)).element;
			return state?.parent === 'tracker' && state.rect ? state : null;
		}, `${anchoredChildLayout.name} to lay out from its active tracker parent`, UI_WAIT);
		await page.evaluate(() => {
			const channel = window.EZHUD_FTE?.engine()?.ftec;
			if (!channel) throw new Error('the live FTE command channel is unavailable');
			channel.cbufadd('r_tracker 0\nset hud_tracker_place screen\n'
				+ 'set hud_tracker_align_x right\nset hud_tracker_align_y top\n'
				+ 'set hud_tracker_pos_x 294\nset hud_tracker_pos_y 161\nhud_recalculate\n');
		});
		await eventually(async () => await readCvar('r_tracker') === '0' ? true : null,
			'the tracker content path to become inactive', UI_WAIT);
		await eventually(async () => {
			const inactive = await readRectContract();
			const anchoredInactive = (await readState(anchoredChildLayout.name)).element;
			assert(anchoredInactive?.parent === 'tracker' && anchoredInactive.rect === null,
				`${anchoredChildLayout.name} anchored to inactive tracker must report rect:null, got `
				+ JSON.stringify(anchoredInactive));
			assert(inactive.tracker === null,
				`inactive tracker must report rect:null, got ${JSON.stringify(inactive.tracker)}`);
			assert(inactive.ownfrags === null,
				`empty ownfrags must report rect:null, got ${JSON.stringify(inactive.ownfrags)}`);
			assert(inactive.nonPositive.length === 0,
				`#87 elements reported non-positive rects: ${JSON.stringify(inactive)}`);
			return inactive;
		}, 'the inactive tracker and named child to publish their next-frame contract', UI_WAIT);
	} finally {
		await page.evaluate(({ tracker, child }) => {
			const channel = window.EZHUD_FTE?.engine()?.ftec;
			if (!channel) return;
			channel.cbufadd(`r_tracker 1\nset hud_tracker_place ${tracker.place}\n`
				+ `set hud_tracker_align_x ${tracker.align_x}\nset hud_tracker_align_y ${tracker.align_y}\n`
				+ `set hud_tracker_pos_x ${tracker.pos_x}\nset hud_tracker_pos_y ${tracker.pos_y}\n`
				+ `set hud_${child.name}_place ${child.place}\nhud_recalculate\n`);
		}, { tracker: trackerLayout, child: anchoredChildLayout }).catch(() => {});
	}
	const trackerAfterEmpty = await eventually(async () => {
		const state = await readState('tracker');
		return state.element?.rect ? state.element.rect : null;
	}, 'the active tracker rect after the empty-path contract', UI_WAIT);
	assert(['x', 'y', 'w', 'h'].every((field) =>
		trackerAfterEmpty[field] === trackerLayout.rect[field]),
		`the empty-path fix changed an active tracker rect: ${JSON.stringify({
			before: trackerLayout.rect, after: trackerAfterEmpty,
		})}`);
	await eventually(async () => {
		const state = (await readState(anchoredChildLayout.name)).element;
		return state?.place === anchoredChildLayout.place && state.rect ? state : null;
	}, `${anchoredChildLayout.name} to return to its original active layout`, UI_WAIT);
	pass(nextCase++, 'inactive beyond-screen tracker and empty ownfrags are null; all #87 rects are positive; active tracker unchanged');
	pass(nextCase++, `${anchoredChildLayout.name} anchored to an inactive tracker is also null; restoring the parent restores both layouts`);
} catch (err) {
	failure = err;
	const file = await shot('tier4-fte-failure');
	const logFile = path.join(artifactDir, 'tier4-fte-console.log');
	await writeFile(logFile, `${consoleLog.join('\n')}\n`).catch(() => {});
	for (const [name, png] of visualFailureShots) {
		await writeFile(path.join(artifactDir, `${name}.png`), png).catch(() => {});
	}
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
console.log(`Tier 4 FTE: boot, drag/import/export/demo, per-control readback and tracker pixels passed against `
	+ `${distDir} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(`Tier 4 FTE artifacts: ${artifactDir}`);
