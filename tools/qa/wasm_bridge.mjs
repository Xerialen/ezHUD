// tools/qa/wasm_bridge.mjs — expose the FTE wasm engine as an HTTP bridge.
//
//   node tools/qa/wasm_bridge.mjs [--dist ../dist] [--port 0] [--base-path /]
//
// matrix.mjs speaks the loopback bridge protocol (/state, /cmd, /log). The
// forked FTE engine speaks page globals: Module._EZHud_StateJSON() out,
// FTEC.cbufadd() in (see hud_web_ui/core/fte-adapter.js). This shim serves the
// assembled dist to headless Chrome, waits for the engine to draw HUD state,
// and proxies the three routes into the page — so one matrix runner covers
// both backends without either learning about the other.
//
// Prints "BRIDGE <origin> <token>" when ready and stays up until killed.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { chromium } from 'playwright';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : fallback;
};
const distDir = path.resolve(flag('dist', path.join(process.cwd(), '..', 'dist')));
const basePath = flag('base-path', '/');
if (!/^\/(?:.*\/)?$/.test(basePath)) {
	throw new Error('--base-path must start and end with /');
}
const token = 'wasm-qa';

const TYPES = {
	'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
	'.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml',
	'.pak': 'application/octet-stream', '.pk3': 'application/octet-stream',
	'.mvd': 'application/octet-stream', '.fmf': 'text/plain', '.dat': 'application/octet-stream',
};

// ---- static dist server (the page needs an origin to load from) ------------
const site = createServer(async (request, response) => {
	try {
		const url = new URL(request.url, 'http://qa.invalid');
		if (!url.pathname.startsWith(basePath)) throw new Error('outside base path');
		const stripped = url.pathname.slice(basePath.length);
		const rel = stripped === '' ? 'index.html' : stripped;
		const file = path.join(distDir, path.normalize(rel).replace(/^([/\\])+/, ''));
		if (!file.startsWith(distDir)) throw new Error('traversal');
		await stat(file);
		response.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
		response.end(await readFile(file));
	} catch {
		response.writeHead(404).end('not found');
	}
});
await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
const siteOrigin = `http://127.0.0.1:${site.address().port}`;

// ---- the engine, headless ---------------------------------------------------
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const deviceScaleFactor = Number(flag('device-scale-factor', 1));
if (!Number.isFinite(deviceScaleFactor) || deviceScaleFactor <= 0) {
	throw new Error('--device-scale-factor must be a positive number');
}
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor });
page.on('pageerror', (err) => console.error('[page]', err.message));
await page.goto(`${siteOrigin}${basePath}index.html`, { waitUntil: 'domcontentloaded' });

// Ready means: state export present, command channel up, and at least one
// element drawn (the editor can only place what the engine draws).
await page.waitForFunction(() => {
	const m = globalThis.Module;
	if (!m || !m._EZHud_StateJSON || !globalThis.FTEC?.cbufadd) return false;
	try {
		const state = JSON.parse(m.UTF8ToString(m._EZHud_StateJSON()));
		return state.elements?.some((e) => e.rect);
	} catch {
		return false;
	}
}, { timeout: 240_000, polling: 500 });

async function pageState() {
	return page.evaluate(() => {
		const m = globalThis.Module;
		return JSON.parse(m.UTF8ToString(m._EZHud_StateJSON()));
	});
}

async function pageMetrics() {
	return page.evaluate(() => {
		const canvas = document.getElementById('canvas');
		const rect = canvas.getBoundingClientRect();
		const frameRect = document.getElementById('stage')?.getBoundingClientRect();
		const stageRect = document.querySelector('.stage')?.getBoundingClientRect();
		const railRect = document.querySelector('.panel--tree')?.getBoundingClientRect();
		const inspectorRect = document.querySelector('.panel--inspect')?.getBoundingClientRect();
		const m = globalThis.Module;
		const state = JSON.parse(m.UTF8ToString(m._EZHud_StateJSON()));
		return {
			viewport: { width: innerWidth, height: innerHeight },
			resize_callback: globalThis.FTEC?.evcb?.resize ?? null,
			editor_ready: Boolean(document.getElementById('empty')?.hidden
				&& document.querySelector('#overlay .box')),
			canvas: {
				width: canvas.width,
				height: canvas.height,
				css_width: rect.width,
				css_height: rect.height,
				inline_width: canvas.style.width,
				inline_height: canvas.style.height,
			},
			layout: {
				frame: frameRect ? [frameRect.width, frameRect.height] : null,
				stage: stageRect ? [stageRect.width, stageRect.height] : null,
				rail: railRect ? [railRect.width, railRect.height] : null,
				inspector: inspectorRect ? [inspectorRect.width, inspectorRect.height] : null,
			},
			physical: state.physical,
			screen: state.screen,
		};
	});
}

// Capture exactly the rectangle the engine exported. This deliberately has no
// element-specific coordinate correction: a consumer must be able to trust
// rect.x as drawn. `rows` limits content-sized proofs such as the tracker to
// their first painted row instead of including reserved empty rows.
async function pageElementPixels(name, rows = 1, suppliedRect = null, includeRaw = false) {
	const state = await pageState();
	const element = state.elements?.find((entry) => entry.name === name);
	const rect = suppliedRect ?? element?.rect;
	if (!rect || rect.w <= 0 || rect.h <= 0) {
		throw new Error(`${name} has no non-empty exported rect`);
	}
	const canvasBox = await page.locator('#canvas').boundingBox();
	if (!canvasBox) throw new Error('canvas has no browser bounds');
	const sx = canvasBox.width / state.screen.vid_width;
	const sy = canvasBox.height / state.screen.vid_height;
	const viewport = page.viewportSize();
	const x = Math.max(0, canvasBox.x + rect.x * sx);
	const y = Math.max(0, canvasBox.y + rect.y * sy);
	const width = Math.min(Math.max(1, rect.w * sx), viewport.width - x);
	const rowHeight = rect.h / Math.max(1, rows);
	const height = Math.min(Math.max(1, rowHeight * sy), viewport.height - y);
	if (width <= 0 || height <= 0) {
		throw new Error(`${name} exported rect lies outside the browser viewport`);
	}
	const browserClip = { x, y, width, height };
	let overlay = null;
	if (element?.rect) {
		const overlayBox = page.locator(`#overlay .box[data-name="${name}"]`);
		await overlayBox.waitFor({ state: 'visible', timeout: 5000 });
		const box = await overlayBox.boundingBox();
		overlay = box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
	}
	const overlayVisibility = await page.locator('#overlay').evaluate((node) => node.style.visibility);
	await page.locator('#overlay').evaluate((node) => { node.style.visibility = 'hidden'; });
	let png;
	try {
		png = await page.screenshot({ clip: { x, y, width, height } });
	} finally {
		await page.locator('#overlay').evaluate((node, value) => { node.style.visibility = value; }, overlayVisibility);
	}
	const decoded = await page.evaluate(async ([base64, raw]) => {
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
		let rgba = null;
		if (raw) {
			let binary = '';
			for (let i = 0; i < pixels.length; i += 0x8000) {
				binary += String.fromCharCode(...pixels.subarray(i, i + 0x8000));
			}
			rgba = btoa(binary);
		}
		return { signature: `${bitmap.width}x${bitmap.height}:${a}:${b}`, width: bitmap.width,
			height: bitmap.height, rgba };
	}, [png.toString('base64'), includeRaw]);
	return { ...decoded, png: png.toString('base64'), rect, screen: state.screen, browserClip, overlay };
}

async function pageCmd(line) {
	await page.evaluate((l) => globalThis.FTEC.cbufadd(l + '\n'), line);
}

const wanted = { width: 0, height: 0 };

// ---- the bridge ------------------------------------------------------------
const bridge = createServer(async (request, response) => {
	const url = new URL(request.url, 'http://qa.invalid');
	if (url.searchParams.get('t') !== token) {
		response.writeHead(403).end('{"ok":false,"error":"forbidden"}');
		return;
	}
	try {
		if (url.pathname === '/state') {
			// Writes land on the next engine frame; settle once per read
			// instead of once per write — the matrix writes in bursts and
			// reads rarely, so this is where the wait belongs.
			await page.waitForTimeout(150);
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end(JSON.stringify(await pageState()));
			return;
		}
		if (url.pathname === '/metrics') {
			// QA-only browser/engine receipt: proves a requested viewport resize
			// reached both the canvas backing store and EZHud_StateJSON.
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end(JSON.stringify(await pageMetrics()));
			return;
		}
		if (url.pathname === '/pixels') {
			const rows = Number(url.searchParams.get('rows') ?? 1);
			const name = url.searchParams.get('element') ?? '';
			const includeRaw = url.searchParams.get('raw') === '1';
			const rectValues = ['x', 'y', 'w', 'h'].map((key) => url.searchParams.has(key)
				? Number(url.searchParams.get(key)) : null);
			const hasSuppliedRect = rectValues.every(Number.isFinite);
			const suppliedRect = hasSuppliedRect
				? Object.fromEntries(['x', 'y', 'w', 'h'].map((key, index) => [key, rectValues[index]]))
				: null;
			if (!/^[a-z0-9_]+$/i.test(name) || !Number.isInteger(rows) || rows < 1
				|| (rectValues.some((value) => value !== null) && !hasSuppliedRect)) {
				response.writeHead(400).end('{"ok":false,"error":"invalid pixel probe"}');
				return;
			}
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end(JSON.stringify(await pageElementPixels(name, rows, suppliedRect, includeRaw)));
			return;
		}
		if (url.pathname === '/log') {
			const dump = await page.evaluate(() =>
				globalThis.__ezhudLogDump ? globalThis.__ezhudLogDump() : '');
			response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
			response.end(String(dump ?? ''));
			return;
		}
		if (url.pathname === '/cmd' && request.method === 'POST') {
			const chunks = [];
			for await (const chunk of request) chunks.push(chunk);
			const { cmd } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
			// The wasm engine's resolution is the canvas, not a cvar: a
			// vid_width/vid_height write becomes a viewport resize and the
			// engine recomputes its console pixels itself.
			const vid = cmd.match(/^set vid_(width|height) (\d+)$/);
			if (vid) {
				wanted[vid[1]] = Number(vid[2]);
				if (wanted.width && wanted.height) {
					await page.setViewportSize({ width: wanted.width, height: wanted.height });
					await page.waitForTimeout(300);
				}
				response.writeHead(200, { 'content-type': 'application/json' });
				response.end('{"ok":true}');
				return;
			}
			await pageCmd(cmd);
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end('{"ok":true}');
			return;
		}
		response.writeHead(404).end('{"ok":false,"error":"not found"}');
	} catch (err) {
		response.writeHead(500).end(JSON.stringify({ ok: false, error: String(err) }));
	}
});
await new Promise((resolve) => bridge.listen(Number(flag('port', 0)), '127.0.0.1', resolve));

console.log(`BRIDGE http://127.0.0.1:${bridge.address().port} ${token}`);

process.on('SIGTERM', async () => {
	await browser.close();
	process.exit(0);
});
