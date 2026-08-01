#!/usr/bin/env node
import { readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { chromium } from 'playwright';

function argumentsFrom(argv) {
	const values = {};
	for (let index = 0; index < argv.length; index += 2) values[argv[index].slice(2)] = argv[index + 1];
	return values;
}

const args = argumentsFrom(process.argv.slice(2));
const port = Number(args.port);
const tokenPattern = new RegExp(`HUD bridge: editor at http://127\\.0\\.0\\.1:${port}/\\?t=([0-9a-f]{32})`, 'g');

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function eventually(operation, label, timeout = 20000) {
	const deadline = Date.now() + timeout;
	let last;
	while (Date.now() < deadline) {
		try {
			const value = await operation();
			if (value) return value;
		} catch (err) {
			last = err;
		}
		await sleep(100);
	}
	throw new Error(`timed out waiting for ${label}${last ? `: ${last.message}` : ''}`);
}

async function tokenFromLog() {
	const text = await readFile(args.log, 'utf8');
	return [...text.matchAll(tokenPattern)].at(-1)?.[1];
}

// Generously longer than the other waits. This one covers the engine's entire
// cold start -- SDL, GL context, shader compile, pak load and demo start -- and on
// a software renderer that is tens of seconds, not the couple this would otherwise
// allow. A short timeout here reports "no token" for an engine that was merely
// still starting, which reads exactly like a broken bridge.
let token = await eventually(tokenFromLog, 'HUD bridge token', 120000);
const endpoint = (route) => `http://127.0.0.1:${port}${route}?t=${token}`;

async function json(route, init) {
	const response = await fetch(endpoint(route), init);
	if (!response.ok) throw new Error(`${route} returned HTTP ${response.status}`);
	return response.json();
}

const state = () => json('/state');
await eventually(state, 'live /state');

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
let writtenConfig = null;

try {
	await page.goto(`http://127.0.0.1:${port}/?t=${token}`);
	await page.waitForSelector('#overlay .box', { timeout: 20000 });

	// This positive control is intentionally first. If Playwright cannot deliver a
	// simple checkbox click, every later non-result is meaningless and the run must
	// abort before making engine changes.
	try {
		await page.locator('#chrome').click();
		await page.waitForFunction(() => document.querySelector('#overlay')?.hidden === true);
		await page.locator('#chrome').click();
		await page.waitForFunction(() => document.querySelector('#overlay')?.hidden === false);
	} catch (err) {
		throw new Error(`CONTROL INTERACTION FAILED; aborting E2E before engine edits: ${err.message}`);
	}

	const initial = await state();
	const anchors = {
		x: { left: 'left', after: 'left', right: 'right', before: 'right', center: 'center' },
		y: { top: 'top', after: 'top', bottom: 'bottom', before: 'bottom', center: 'center' },
	};
	const colorName = (element) => Object.keys(element.cvars ?? {}).find((name) =>
		/(^|_)colou?r(_|$)/.test(name.slice(`hud_${element.name}_`.length)));
	const sizeNames = (element) => {
		const prefix = `hud_${element.name}_`;
		const width = element.cvars?.[`${prefix}width`];
		const height = element.cvars?.[`${prefix}height`];
		if (width != null && height != null && !String(width).includes('%') && !String(height).includes('%')) {
			return [`${prefix}width`, `${prefix}height`];
		}
		return element.cvars?.[`${prefix}scale`] != null ? [`${prefix}scale`] : null;
	};
	const candidate = initial.elements.find((element) => {
		if (!element.rect || !colorName(element) || !sizeNames(element)) return false;
		const rect = element.rect;
		if (rect.w < 8 || rect.h < 8 || rect.x < 0 || rect.y < 0 ||
				rect.x + rect.w > initial.screen.vid_width || rect.y + rect.h > initial.screen.vid_height) return false;
		const anchorX = anchors.x[element.align_x] ?? 'left';
		const anchorY = anchors.y[element.align_y] ?? 'top';
		return ['west', 'east'].some((edge) => edge === 'west' ? anchorX !== 'left' : anchorX !== 'right') &&
			['north', 'south'].some((edge) => edge === 'north' ? anchorY !== 'top' : anchorY !== 'bottom');
	});
	if (!candidate) throw new Error('no drawn, on-canvas element supports drag, resize, and colour in this demo');

	await page.locator(`.tree__row[data-name="${candidate.name}"]`).click();
	const selected = page.locator('#overlay .box[data-selected="true"]');
	await selected.waitFor();

	const originalX = Number(candidate.pos_x) || 0;
	const originalY = Number(candidate.pos_y) || 0;
	let box = await selected.boundingBox();
	if (!box) throw new Error(`${candidate.name} selected box is not interactable`);
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width / 2 + 32, box.y + box.height / 2 + 24, { steps: 5 });
	await page.mouse.up();
	const moved = await eventually(async () => {
		const element = (await state()).elements.find((item) => item.name === candidate.name);
		return element && (Number(element.pos_x) !== originalX || Number(element.pos_y) !== originalY) ? element : null;
	}, `${candidate.name} drag to reach engine state`);
	await page.screenshot({ path: path.join(args.artifacts, '01-dragged.png'), fullPage: true });

	const sizeCvars = sizeNames(moved);
	const sizeBefore = Object.fromEntries(sizeCvars.map((name) => [name, moved.cvars[name]]));
	const handle = selected.locator('.handle:not(.handle--anchored)').first();
	await handle.waitFor();
	box = await handle.boundingBox();
	if (!box) throw new Error(`${candidate.name} resize handle is not interactable`);
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width / 2 + 24, box.y + box.height / 2 + 18, { steps: 5 });
	await page.mouse.up();
	await eventually(async () => {
		const element = (await state()).elements.find((item) => item.name === candidate.name);
		return sizeCvars.some((name) => element?.cvars?.[name] !== sizeBefore[name]);
	}, `${candidate.name} resize to reach engine state`);
	await page.screenshot({ path: path.join(args.artifacts, '02-resized.png'), fullPage: true });

	const colorInput = page.locator('#inspector .field--color').first();
	const colorCvar = await colorInput.locator('label').getAttribute('title');
	if (!colorCvar) throw new Error(`${candidate.name} has no editable colour field`);
	await colorInput.locator('.field__raw').fill('12 34 56 200');
	await colorInput.locator('.field__raw').press('Enter');
	await eventually(async () => {
		const element = (await state()).elements.find((item) => item.name === candidate.name);
		return element?.cvars?.[colorCvar] === '12 34 56 200';
	}, `${colorCvar} colour change to reach engine state`);
	await page.screenshot({ path: path.join(args.artifacts, '03-recoloured.png'), fullPage: true });

	const configName = `hud_web_e2e_${process.pid}`;
	await page.locator('#save-open').click();
	await page.locator('#save-name').fill(configName);
	await page.locator('#save-dialog .btn--primary').click();
	await page.waitForFunction(
		() => document.querySelector('#save-dialog .save__message')?.textContent.startsWith('Wrote '),
		undefined,
		{ timeout: 20000 },
	);
	await page.screenshot({ path: path.join(args.artifacts, '04-saved.png'), fullPage: true });

	const configs = await json('/configs');
	const directory = path.isAbsolute(configs.config_dir)
		? configs.config_dir : path.resolve(args.basedir, configs.config_dir);
	writtenConfig = path.join(directory, `${configName}.cfg`);
	const contents = await eventually(async () => readFile(writtenConfig, 'utf8'), `saved config ${writtenConfig}`);

	// Compare the file against the engine's settled position, not against `moved`.
	// `moved` is whatever the first poll saw after the drag first reached the
	// engine, and a drag is coalesced into several writes -- so it is routinely an
	// intermediate value while the config holds the final one. Asserting on it
	// fails whenever the poll lands mid-gesture, which is most of the time.
	const settled = (await state()).elements.find((item) => item.name === candidate.name);
	for (const [suffix, value] of [['pos_x', settled.pos_x], ['pos_y', settled.pos_y]]) {
		const name = `hud_${candidate.name}_${suffix}`;
		// Match the cvar name as a whole token and parse its value, rather than
		// substring-searching the line: "-4" is a substring of "-48", and
		// hud_gun3_pos_x is a substring of nothing useful but the next element's
		// name easily could be. The engine writes floats, so compare numerically.
		const pattern = new RegExp(`^\\s*(?:set\\s+)?${name}\\s+"?(-?[0-9.]+)"?`, 'm');
		const found = pattern.exec(contents);
		if (!found || Number(found[1]) !== Number(value)) {
			throw new Error(`${writtenConfig}: expected ${name} = ${value}, `
				+ `found ${found ? found[1] : 'no such cvar'}`);
		}
	}

	console.log(`Tier 4: control, drag, resize, recolour, and save passed for ${candidate.name}`);
	console.log(`Tier 4 screenshots: ${args.artifacts}`);
} finally {
	await page.close();
	await browser.close();
	if (writtenConfig) await unlink(writtenConfig).catch(() => {});
}
