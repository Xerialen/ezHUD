#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
	consoleToFrame, displayDeltaToConsole, scaleFactors,
} from '../../hud_web_ui/core/geometry.js';

let chromium;
try {
	({ chromium } = await import('playwright'));
} catch (err) {
	if (err?.code === 'ERR_MODULE_NOT_FOUND') {
		console.error('TIER 3 SKIP: Playwright is not installed; run npm install and npx playwright install chromium.');
		process.exit(0);
	}
	throw err;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const uiRoot = path.join(repo, 'hud_web_ui');
const fixture = JSON.parse(await readFile(path.join(uiRoot, 'fixtures/state.json'), 'utf8'));
const frame = await readFile(path.join(uiRoot, 'fixtures/frame.png'));

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function near(actual, expected, label) {
	assert(Math.abs(actual - expected) <= 0.8,
		`${label}: expected ${expected.toFixed(3)}, got ${actual.toFixed(3)}`);
}

// The view fixture starts from the real capture. Only data absent from that old
// capture is supplied inline, plus percentage syntax on a genuinely captured
// bar rect so the handle test does not invent geometry.
const state = structuredClone(fixture);
state.fonts = { proportional_loaded: false, facepath: '' };
state.view = { spectator: true, tracking: true };
state.hud_modes = {
	new_drawn: true,
	classic_drawn: true,
	standard_bar: true,
	scr_newhud: 2,
	cl_hud: false,
	cl_sbar: true,
	scr_compacthud: 0,
	viewsize: 100,
};
state.killfeed = {
	r_tracker: '1', con_fragmessages: '0', cl_useimagesinfraglog: '1',
	r_tracker_inconsole: '0', r_tracker_time: '4', r_tracker_messages: '4',
	r_tracker_frags: '1', r_tracker_streaks: '1', r_tracker_flags: '1',
	r_tracker_pickups: '0', r_tracker_scale: '1', r_tracker_align_right: '1',
};
const percentage = state.elements.find((element) => element.name === 'bar_health');
percentage.cvars.hud_bar_health_width = '30%';
percentage.cvars.hud_bar_health_height = '25%';

const fonts = {
	protocol: 1,
	directory: '/fixture/fonts',
	facepath: '',
	proportional_loaded: false,
	available: ['fixture.ttf'],
};

const contentTypes = new Map([
	['.html', 'text/html; charset=utf-8'], ['.css', 'text/css; charset=utf-8'],
	['.js', 'text/javascript; charset=utf-8'], ['.svg', 'image/svg+xml'],
]);

const server = http.createServer(async (request, response) => {
	try {
		const url = new URL(request.url, 'http://fixture.invalid');
		const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
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
		console.error(`TIER 3 SKIP: this sandbox forbids the required loopback static server (${err.code}).`);
		process.exit(0);
	}
	throw err;
}

let browser;
try {
	browser = await chromium.launch({ headless: true });
} catch (err) {
	await new Promise((resolve) => server.close(resolve));
	if (/executable|browser.*install/i.test(String(err))) {
		console.error('TIER 3 SKIP: Playwright Chromium is not installed; run npx playwright install chromium.');
		process.exit(0);
	}
	throw err;
}

let frameRequests = 0;
const commands = [];

function applyCommand(command) {
	commands.push(command);
	// The killfeed cvars are global, not per-element: fold them straight into
	// the fixture's killfeed block so the panel's active states settle.
	const killfeed = /^(\S+) (.+)$/.exec(command);
	if (killfeed && state.killfeed
			&& Object.prototype.hasOwnProperty.call(state.killfeed, killfeed[1])) {
		state.killfeed[killfeed[1]] = killfeed[2];
		return;
	}
	const match = /^(hud_([^ ]+)_(pos_x|pos_y|scale)) ([^ ]+)$/.exec(command);
	if (!match) return;
	const [, cvar, name, suffix, raw] = match;
	const element = state.elements.find((item) => item.name === name);
	if (!element) return;
	const value = Number(raw);
	if (suffix === 'pos_x' || suffix === 'pos_y') {
		const axis = suffix === 'pos_x' ? 'x' : 'y';
		const previous = Number(element[suffix]) || 0;
		element[suffix] = value;
		if (element.rect) element.rect[axis] += value - previous;
	} else {
		element.cvars[cvar] = raw;
	}
}

const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.route('**/*', async (route) => {
	const url = new URL(route.request().url());
	const json = (body) => route.fulfill({
		status: 200, contentType: 'application/json', body: JSON.stringify(body),
	});
	if (url.pathname === '/state') return json(state);
	if (url.pathname === '/fonts') return json(fonts);
	if (url.pathname === '/palette') return json({ protocol: 1, colors: [] });
	if (url.pathname === '/configs') return json({
		protocol: 1, config_dir: '/fixture/configs', export_dir: '/fixture/configs',
		main: 'config.cfg', backup_enabled: false, available: [], exports: [],
	});
	if (url.pathname === '/cmd') {
		applyCommand(route.request().postDataJSON().cmd);
		return json({ ok: true });
	}
	if (url.pathname === '/frame.png') {
		frameRequests++;
		return route.fulfill({ status: 200, contentType: 'image/png', body: frame });
	}
	return route.continue();
});

try {
	const address = server.address();
	await page.goto(`http://127.0.0.1:${address.port}/?t=fixture-token`);
	await page.waitForSelector('#overlay .box');
	await page.waitForFunction(() => document.querySelector('#frame')?.naturalWidth === 1280);

	const factors = scaleFactors(fixture.screen, fixture.physical);
	assert(factors.kx === 4 && factors.ky === 3.6,
		`fixture must exercise unequal axes, got ${JSON.stringify(factors)}`);

	const placed = fixture.elements.filter((element) => element.rect);
	const measurements = await page.evaluate(() => {
		const frameNode = document.querySelector('#frame');
		const frameRect = frameNode.getBoundingClientRect();
		return {
			frame: { left: frameRect.left, top: frameRect.top, width: frameRect.width, naturalWidth: frameNode.naturalWidth },
			boxes: [...document.querySelectorAll('#overlay .box')].map((box) => {
				const rect = box.getBoundingClientRect();
				return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
			}),
		};
	});
	assert(measurements.boxes.length === placed.length,
		`expected ${placed.length} captured boxes, got ${measurements.boxes.length}`);
	const displayScale = measurements.frame.width / measurements.frame.naturalWidth;
	for (const index of [0, 1, 3, placed.length - 1]) {
		const expected = consoleToFrame(placed[index].rect, fixture.screen, fixture.physical);
		const actual = measurements.boxes[index];
		near(actual.left - measurements.frame.left, expected.x * displayScale, `${placed[index].name} x`);
		near(actual.top - measurements.frame.top, expected.y * displayScale, `${placed[index].name} y`);
		near(actual.width, Math.max(expected.w * displayScale, 3), `${placed[index].name} width`);
		near(actual.height, Math.max(expected.h * displayScale, 3), `${placed[index].name} height`);
	}

	const dragged = state.elements.find((element) => element.name === 'centerprint');
	const origin = { x: Number(dragged.pos_x) || 0, y: Number(dragged.pos_y) || 0 };
	await page.locator('.tree__row[data-name="centerprint"]').click();
	let selectedBox = page.locator('#overlay .box[data-selected="true"]');
	let bounds = await selectedBox.boundingBox();
	assert(bounds, 'centerprint selected box is not interactable');
	const cssDelta = { x: 36, y: 36 };
	const frameWidth = await page.locator('#frame').evaluate((node) => node.clientWidth);
	const expectedDelta = displayDeltaToConsole(
		cssDelta.x, cssDelta.y, fixture.screen, fixture.physical, frameWidth,
	);
	await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
	await page.mouse.down();
	await page.mouse.move(
		bounds.x + bounds.width / 2 + cssDelta.x,
		bounds.y + bounds.height / 2 + cssDelta.y,
		{ steps: 4 },
	);
	await page.mouse.up();
	await page.waitForFunction(() => document.querySelector('.tree__row[data-name="centerprint"] .tree__meta')?.textContent !== '51,46');
	assert(dragged.pos_x === Math.trunc(origin.x + expectedDelta.dx),
		`drag x did not use kx: expected ${Math.trunc(origin.x + expectedDelta.dx)}, got ${dragged.pos_x}`);
	assert(dragged.pos_y === Math.trunc(origin.y + expectedDelta.dy),
		`drag y did not use ky: expected ${Math.trunc(origin.y + expectedDelta.dy)}, got ${dragged.pos_y}`);
	assert(commands.some((command) => command.startsWith('hud_centerprint_pos_x ')) &&
		commands.some((command) => command.startsWith('hud_centerprint_pos_y ')),
		'drag did not write both placement cvars');

	selectedBox = page.locator('#overlay .box[data-selected="true"]');
	const activeHandle = selectedBox.locator('.handle:not(.handle--anchored)').last();
	bounds = await activeHandle.boundingBox();
	assert(bounds, 'centerprint active corner handle is not interactable');
	const scaleBefore = dragged.cvars.hud_centerprint_scale;
	await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
	await page.mouse.down();
	await page.mouse.move(bounds.x + bounds.width / 2 + 24, bounds.y + bounds.height / 2 + 18, { steps: 4 });
	await page.mouse.up();
	await page.waitForFunction((previous) => {
		const input = [...document.querySelectorAll('#inspector .field')]
			.find((row) => row.querySelector('label')?.textContent === 'scale')?.querySelector('input');
		return input && input.value !== previous;
	}, scaleBefore);
	assert(dragged.cvars.hud_centerprint_scale !== scaleBefore,
		'corner resize did not update the scale-backed fixture element');

	await page.locator('.tree__row[data-name="bar_health"]').click();
	const selected = page.locator('#overlay .box[data-selected="true"]');
	await selected.waitFor();
	assert(await selected.locator('.handle').count() === 0,
		'percentage-sized bar_health unexpectedly received corner handles');
	assert(/percentage/.test(await selected.getAttribute('title') ?? ''),
		'percentage-sized element did not explain why its handles are absent');

	// The killfeed's "where" seg is one choice writing a *pair* of cvars, so a
	// click must send both r_tracker and con_fragmessages together.
	await page.waitForSelector('#killfeed .seg__item');
	const commandsBeforeKillfeed = commands.length;
	await page.locator('#killfeed .seg__item', { hasText: 'Console messages' }).click();
	await page.waitForFunction(() => [...document.querySelectorAll('#killfeed .seg__item')]
		.some((b) => b.textContent === 'Console messages' && b.dataset.on === 'true'));
	const killfeedSent = commands.slice(commandsBeforeKillfeed);
	assert(killfeedSent.includes('r_tracker 0') && killfeedSent.includes('con_fragmessages 1'),
		`the "where" seg did not send the cvar pair: ${JSON.stringify(killfeedSent)}`);
	assert(await page.locator('#killfeed .font-state').first().textContent()
		=== 'Kills appear only among console messages (weapon icons).',
	'the killfeed summary does not describe the new combination');

	await page.waitForSelector('#hudmodes > *, #killfeed > *, #groups > *, #fonts > *');
	await page.evaluate(() => {
		for (const id of ['hudmodes', 'killfeed', 'groups', 'fonts']) {
			document.querySelector(`#${id} > *`).__tier3Identity = id;
		}
	});
	const beforeTick = frameRequests;
	const deadline = Date.now() + 4000;
	while (frameRequests <= beforeTick && Date.now() < deadline) {
		await page.waitForTimeout(50);
	}
	assert(frameRequests > beforeTick, 'no frame tick arrived to exercise stale() guards');
	const identities = await page.evaluate(() => Object.fromEntries(
		['hudmodes', 'killfeed', 'groups', 'fonts'].map((id) => [id, document.querySelector(`#${id} > *`)?.__tier3Identity]),
	));
	assert(identities.hudmodes === 'hudmodes', 'renderModes rebuilt its DOM on a frame-only tick');
	assert(identities.killfeed === 'killfeed', 'renderKillfeed rebuilt its DOM on a frame-only tick');
	assert(identities.groups === 'groups', 'renderGroups rebuilt its DOM on a frame-only tick');
	assert(identities.fonts === 'fonts', 'renderFonts rebuilt its DOM on a frame-only tick');

	console.log('Tier 3: geometry, killfeed pair-write, percentage resize refusal, and stale DOM guards passed');
} finally {
	await page.close();
	await browser.close();
	await new Promise((resolve) => server.close(resolve));
}
