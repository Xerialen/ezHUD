#!/usr/bin/env node
// Deterministically capture focused release evidence sources from an assembled
// FTE-web dist. Cropping is declared in captures.json and performed by
// Playwright's screenshot clip; no committed source is hand-cropped.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { resolveReleaseDir } from './paths.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workspace = path.dirname(repo);
const releaseDir = resolveReleaseDir(repo);
const releaseSlug = path.basename(releaseDir);
const dist = path.resolve(process.env.DIST_DIR ?? path.join(workspace, 'dist'));
const basePath = process.env.BASE_PATH ?? '/ezHUD/';
const manifest = JSON.parse(await readFile(path.join(releaseDir, 'captures.json'), 'utf8'));

assert.match(basePath, /^\/.*\/$/, 'BASE_PATH must start and end with /');
assert.equal(manifest.version, 1, 'capture manifest version must be 1');
assert(Array.isArray(manifest.captures) && manifest.captures.length > 0, 'captures must be non-empty');
await stat(path.join(dist, 'index.html')).catch(() => {
	assert.fail(`capture: DIST_DIR has no index.html; assemble the public dist first`);
});

const mime = new Map([
	['.css', 'text/css; charset=utf-8'],
	['.html', 'text/html; charset=utf-8'],
	['.js', 'text/javascript; charset=utf-8'],
	['.json', 'application/json; charset=utf-8'],
	['.pak', 'application/octet-stream'],
	['.pk3', 'application/octet-stream'],
	['.png', 'image/png'],
	['.svg', 'image/svg+xml'],
	['.wasm', 'application/wasm'],
]);

function releasePath(rel, label) {
	assert.equal(typeof rel, 'string', `${label} must be a string`);
	const resolved = path.resolve(releaseDir, rel);
	assert(resolved.startsWith(`${releaseDir}${path.sep}`), `${label} escapes docs/${releaseSlug}`);
	return resolved;
}

function pngDimensions(bytes, label) {
	const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
	assert(bytes.subarray(0, 8).equals(signature), `${label} is not a PNG`);
	assert.equal(bytes.toString('ascii', 12, 16), 'IHDR', `${label} has no leading IHDR`);
	return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function finitePositive(value, label) {
	assert.equal(typeof value, 'number', `${label} must be numeric`);
	assert(Number.isFinite(value) && value > 0, `${label} must be positive and finite`);
}

const server = createServer(async (request, response) => {
	try {
		const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://capture.invalid').pathname);
		if (!pathname.startsWith(basePath)) {
			response.writeHead(404).end('not found');
			return;
		}
		let rel = pathname.slice(basePath.length);
		if (!rel || rel.endsWith('/')) rel += 'index.html';
		const file = path.resolve(dist, rel);
		if (file !== dist && !file.startsWith(`${dist}${path.sep}`)) {
			response.writeHead(403).end('forbidden');
			return;
		}
		const info = await stat(file).catch(() => null);
		if (!info?.isFile()) {
			response.writeHead(404).end('not found');
			return;
		}
		response.writeHead(200, {
			'Content-Type': mime.get(path.extname(file).toLowerCase()) ?? 'application/octet-stream',
			'Cache-Control': 'no-store',
		});
		createReadStream(file).pipe(response);
	} catch (error) {
		response.writeHead(500).end(String(error));
	}
});
await new Promise((resolve, reject) => {
	server.once('error', reject);
	server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
assert(address && typeof address === 'object', 'capture server did not bind');
const site = `http://127.0.0.1:${address.port}${basePath}`;

async function waitForStableReadout(page) {
	await page.waitForFunction(() => {
		const readout = document.querySelector('#readout');
		return readout && !readout.hidden && /editing at/i.test(readout.textContent ?? '');
	}, null, { timeout: 120_000 });
	let previous = '';
	for (let attempt = 0; attempt < 10; attempt += 1) {
		const current = await page.locator('#readout').textContent();
		if (current === previous) return current;
		previous = current ?? '';
		await page.waitForTimeout(250);
	}
	assert.fail('capture: scale readout did not settle');
}

async function waitForStableCanvas(page) {
	let previous = '';
	let stable = 0;
	for (let attempt = 0; attempt < 20; attempt += 1) {
		const bytes = await page.locator('#canvas').screenshot({ animations: 'disabled', caret: 'hide' });
		const current = createHash('sha256').update(bytes).digest('hex');
		stable = current === previous ? stable + 1 : 0;
		if (stable >= 2) return current;
		previous = current;
		await page.waitForTimeout(150);
	}
	assert.fail('capture: canvas pixels did not settle');
}

async function freezeEngineFrame(page) {
	await page.waitForTimeout(1000);
	const froze = await page.evaluate(() => {
		const ftec = window.EZHUD_FTE.engine().ftec;
		if (!ftec || typeof ftec.step !== 'function') return false;
		ftec.aborted = true;
		return ftec.aborted;
	});
	assert(froze, 'capture: FTE frame loop cannot be frozen');
	await page.waitForTimeout(100);
	return waitForStableCanvas(page);
}

async function waitForExpectedState(page, expectedState) {
	await page.waitForFunction((expected) => {
		const readout = document.querySelector('#readout')?.textContent ?? '';
		const match = readout.match(/editing at\s*(\d+)[×x](\d+)/i);
		const canvas = document.querySelector('#canvas');
		return match
			&& Number(match[1]) === expected.screen[0]
			&& Number(match[2]) === expected.screen[1]
			&& canvas?.width === expected.physical[0]
			&& canvas?.height === expected.physical[1];
	}, expectedState, { timeout: 120_000 });
}

async function driveState(page, state) {
	await page.waitForFunction(() => Boolean(window.Module && window.EZHUD_FTE), null, { timeout: 120_000 });
	await page.waitForFunction(() => {
		const button = document.querySelector('#fte-pause');
		return button && !button.disabled;
	}, null, { timeout: 120_000 });
	if (state?.uiScale !== undefined) {
		assert(['1', '1.25', '1.5'].includes(String(state.uiScale)),
			'uiScale must be one of 1, 1.25, or 1.5');
		await page.locator('#ui-scale').selectOption(String(state.uiScale));
		await page.waitForFunction((scale) =>
			document.documentElement.dataset.uiScale === scale
			&& getComputedStyle(document.documentElement).getPropertyValue('--ui-scale').trim() === scale,
		String(state.uiScale));
	}
	if (state?.demoTimeSeconds !== undefined) {
		assert.equal(state.demo, 'paused', 'demoTimeSeconds requires a paused demo');
		assert(Number.isInteger(state.demoTimeSeconds) && state.demoTimeSeconds > 0,
			'demoTimeSeconds must be a positive integer');
		assert.equal(typeof state.demoPath, 'string', 'demoTimeSeconds requires demoPath');
		assert.match(state.demoPath, /^demos\/[A-Za-z0-9_.-]+\.mvd$/, 'demoPath must be a safe demos/*.mvd path');
		await page.evaluate((demoPath) => {
			window.EZHUD_FTE.engine().ftec.cbufadd(
				`set cl_autotrack user\nautotrack user\nplaydemo ${demoPath}\n`);
		}, state.demoPath);
		// Let playdemo replace the boot playback before issuing controls that must
		// apply to the replacement rather than to the outgoing demo.
		await page.waitForTimeout(1000);
		await page.waitForFunction(() => {
			const button = document.querySelector('#fte-pause');
			return !button?.disabled && button?.getAttribute('aria-pressed') === 'false';
		}, null, { timeout: 30_000 });
		await page.evaluate(({ seconds, hideDynamicHud }) => {
			const channel = window.EZHUD_FTE.engine().ftec;
			let commands = `demo_setspeed 0\ndemo_jump 0\ndemo_jump ${seconds}\n`;
			if (hideDynamicHud) {
				commands += 'set hud_gameclock_show 0\nset hud_fps_show 0\n';
				commands += 'set r_dynamic 0\nset r_lightstylespeed 0\nset r_waterwarp 0\n';
				commands += 'set v_idlescale 0\nset r_drawviewmodel 0\n';
				commands += 'set r_drawentities 0\nset r_fastturb 1\n';
			}
			channel.cbufadd(commands);
		}, { seconds: state.demoTimeSeconds, hideDynamicHud: Boolean(state.hideDynamicHud) });
		await page.waitForFunction(() => {
			const button = document.querySelector('#fte-pause');
			return !button?.disabled && button?.getAttribute('aria-pressed') === 'true';
		}, null, { timeout: 30_000 });
		// Restart plus forward seeking can span many demo messages. Keep the frame
		// loop alive long enough to reach the declared packet time before selecting
		// one reviewed POV; neither may depend on host speed.
		await page.waitForTimeout(5000);
		if (state.trackPlayer !== undefined) {
			assert.equal(typeof state.trackPlayer, 'string', 'trackPlayer must be a string');
			assert.match(state.trackPlayer, /^[A-Za-z0-9 _-]+$/, 'trackPlayer contains unsafe characters');
			await page.evaluate((player) => {
				window.EZHUD_FTE.engine().ftec.cbufadd(`track "${player}"\n`);
			}, state.trackPlayer);
			await page.waitForTimeout(1000);
		}
	} else if (state?.demo) {
		const wantPaused = state.demo === 'paused';
		assert(wantPaused || state.demo === 'running', `unsupported demo state ${state.demo}`);
		const button = page.locator('#fte-pause');
		const isPaused = await button.getAttribute('aria-pressed') === 'true';
		if (isPaused !== wantPaused) await button.click();
		await page.waitForFunction((paused) => {
			const button = document.querySelector('#fte-pause');
			return !button?.disabled && button?.getAttribute('aria-pressed') === String(paused);
		}, wantPaused, { timeout: 30_000 });
	}
	if (state?.selectElement !== undefined) {
		assert.equal(typeof state.selectElement, 'string', 'selectElement must be a string');
		assert.match(state.selectElement, /^[a-z0-9_]+$/, 'selectElement contains unsafe characters');
		await page.locator(`.tree__row[data-name="${state.selectElement}"]`).click();
		await page.waitForSelector(`#f-${state.selectElement}-place`);
	}
	return waitForStableReadout(page);
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
	for (const capture of manifest.captures) {
		const initialViewport = capture.state?.resizeFrom ?? capture.viewport;
		for (const key of ['width', 'height']) finitePositive(initialViewport[key], `${capture.id}.initialViewport.${key}`);
		for (const key of ['width', 'height']) finitePositive(capture.viewport[key], `${capture.id}.viewport.${key}`);
		finitePositive(capture.deviceScaleFactor, `${capture.id}.deviceScaleFactor`);
		for (const key of ['w', 'h']) finitePositive(capture.clip[key], `${capture.id}.clip.${key}`);
		assert(capture.clip.x >= 0 && capture.clip.y >= 0
			&& capture.clip.x + capture.clip.w <= capture.viewport.width
			&& capture.clip.y + capture.clip.h <= capture.viewport.height,
			`${capture.id}.clip lies outside the final viewport`);

		const context = await browser.newContext({
			viewport: initialViewport,
			deviceScaleFactor: capture.deviceScaleFactor,
			colorScheme: 'dark',
		});
		const page = await context.newPage();
		page.setDefaultTimeout(120_000);
		const url = new URL(capture.page, site).href;
		await page.goto(url, { waitUntil: 'domcontentloaded' });
		let readout = await driveState(page, capture.state);
		if (capture.state?.resizeFrom) await page.setViewportSize(capture.viewport);
		let physical = null;
		if (capture.expectedState) {
			assert.deepEqual(Object.keys(capture.expectedState).sort(), ['physical', 'screen'],
				`${capture.id}.expectedState may contain only physical and screen`);
			for (const key of ['screen', 'physical']) {
				assert(Array.isArray(capture.expectedState[key]) && capture.expectedState[key].length === 2,
					`${capture.id}.expectedState.${key} must be a pair`);
				for (const [index, value] of capture.expectedState[key].entries()) {
					assert(Number.isInteger(value) && value > 0,
						`${capture.id}.expectedState.${key}[${index}] must be a positive integer`);
				}
			}
			await waitForExpectedState(page, capture.expectedState);
			readout = await waitForStableReadout(page);
			await page.waitForTimeout(500);
			const match = readout?.match(/editing at\s*(\d+)[×x](\d+)/i);
			assert(match, `${capture.id}: cannot read screen dimensions from ${JSON.stringify(readout)}`);
			const screen = match.slice(1, 3).map(Number);
			assert.deepEqual(screen, capture.expectedState.screen,
				`${capture.id}: readout does not match its documented screen state`);
			physical = await page.locator('#canvas').evaluate((canvas) => [canvas.width, canvas.height]);
			assert.deepEqual(physical, capture.expectedState.physical,
				`${capture.id}: canvas does not match its documented physical state`);
		}
		if (capture.state?.demoTimeSeconds !== undefined) await freezeEngineFrame(page);
		await page.evaluate(() => document.fonts.ready);
		if (capture.state?.scrollFocus) {
			await page.locator(capture.focusSelector).scrollIntoViewIfNeeded();
		}
		const focus = await page.locator(capture.focusSelector).boundingBox();
		assert(focus, `${capture.id}.focusSelector has no box`);
		assert(focus.x >= capture.clip.x && focus.y >= capture.clip.y
			&& focus.x + focus.width <= capture.clip.x + capture.clip.w
			&& focus.y + focus.height <= capture.clip.y + capture.clip.h,
			`${capture.id}.focusSelector ${JSON.stringify(focus)} lies outside clip ${JSON.stringify(capture.clip)}`);

		const outputPath = releasePath(capture.output, `${capture.id}.output`);
		await mkdir(path.dirname(outputPath), { recursive: true });
		await page.screenshot({
			path: outputPath,
			type: 'png',
			clip: { x: capture.clip.x, y: capture.clip.y, width: capture.clip.w, height: capture.clip.h },
			animations: 'disabled',
			caret: 'hide',
		});
		const size = pngDimensions(await readFile(outputPath), capture.output);
		assert.deepEqual(size, {
			width: capture.clip.w * capture.deviceScaleFactor,
			height: capture.clip.h * capture.deviceScaleFactor,
		}, `${capture.id}: output dimensions do not match clip × deviceScaleFactor`);
		const target = {
			x: Math.round((focus.x - capture.clip.x) * capture.deviceScaleFactor),
			y: Math.round((focus.y - capture.clip.y) * capture.deviceScaleFactor),
			w: Math.round(focus.width * capture.deviceScaleFactor),
			h: Math.round(focus.height * capture.deviceScaleFactor),
		};
		if (capture.expectedTarget !== undefined) {
			assert.deepEqual(Object.keys(capture.expectedTarget).sort(), ['h', 'w', 'x', 'y'],
				`${capture.id}.expectedTarget may contain only x, y, w, and h`);
			assert.deepEqual(target, capture.expectedTarget,
				`${capture.id}: live focus selector differs from its declared annotation target`);
		}
		const stateReceipt = physical ? ` readout=${JSON.stringify(readout)} physical=${JSON.stringify(physical)}` : '';
		console.log(`capture: ${capture.output} (${size.width}x${size.height}) focus=${JSON.stringify(target)}${stateReceipt}`);
		await context.close();
	}
} finally {
	await browser.close();
	await new Promise((resolve) => server.close(resolve));
}
