// tools/qa/wasm_bridge.mjs — expose the FTE wasm engine as an HTTP bridge.
//
//   node tools/qa/wasm_bridge.mjs [--dist ../dist] [--port 0]
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
		const rel = url.pathname === '/' ? '/index.html' : url.pathname;
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
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (err) => console.error('[page]', err.message));
await page.goto(`${siteOrigin}/index.html`, { waitUntil: 'domcontentloaded' });

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
		const m = globalThis.Module;
		const state = JSON.parse(m.UTF8ToString(m._EZHud_StateJSON()));
		return {
			viewport: { width: innerWidth, height: innerHeight },
			resize_callback: globalThis.FTEC?.evcb?.resize ?? null,
			canvas: {
				width: canvas.width,
				height: canvas.height,
				css_width: rect.width,
				css_height: rect.height,
			},
			physical: state.physical,
			screen: state.screen,
		};
	});
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
