// One-off proof driver for #15 fragfile.dat delivery. Not a repo test (no
// allowlist entry needed) -- run manually against a real assembled dist.
//
// Usage: node fragfile-proof.mjs <dist-dir> <out-dir>
import { chromium } from 'playwright';
import http from 'node:http';
import { mkdirSync, writeFileSync, createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';

const [, , distDir, outDir] = process.argv;
if (!distDir || !outDir) {
	console.error('usage: fragfile-proof.mjs <dist-dir> <out-dir>');
	process.exit(1);
}
mkdirSync(outDir, { recursive: true });

const MIME = {
	'.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
	'.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml',
	'.pak': 'application/octet-stream', '.pk3': 'application/octet-stream',
	'.mvd': 'application/octet-stream', '.fmf': 'text/plain', '.dat': 'text/plain',
};
const server = http.createServer((req, res) => {
	let rel = decodeURIComponent(req.url.split('?')[0]);
	if (rel === '/' || rel === '') rel = '/index.html';
	const fp = path.join(distDir, rel);
	if (!fp.startsWith(distDir) || !existsSync(fp) || statSync(fp).isDirectory()) {
		res.writeHead(404);
		res.end('not found');
		return;
	}
	res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
	createReadStream(fp).pipe(res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}/`;
console.log('serving', distDir, 'at', base);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const consoleLines = [];
page.on('console', (msg) => consoleLines.push(msg.text()));

await page.goto(base, { waitUntil: 'load' });

async function evalState() {
	return page.evaluate(() => {
		try {
			if (!window.Module || !window.Module._EZHud_StateJSON) return null;
			return JSON.parse(window.Module.UTF8ToString(window.Module._EZHud_StateJSON()));
		} catch (e) {
			return null;
		}
	});
}
async function setCvar(name, value) {
	await page.evaluate(([n, v]) => window.FTEC && window.FTEC.cbufadd(`set ${n} ${v}\n`), [name, value]);
}
async function trackerElement() {
	const s = await evalState();
	return s && s.elements && s.elements.find((e) => e.name === 'tracker');
}
async function trackerRect() {
	const el = await trackerElement();
	if (!el) return null;
	if (el.shown === false) return null; // collapsed: report as no rect
	return el.rect;
}
async function canvasBox() {
	// The state's rect (and vid_width/vid_height) are in the canvas's internal
	// framebuffer resolution, which is not the same as its CSS-displayed size
	// (the page scales the canvas to fit its layout). page.screenshot's clip
	// is in CSS/page pixels, so the rect has to be scaled through the
	// canvas's actual bounding box, not used raw as page coordinates.
	return page.evaluate(() => {
		const c = window.Module && window.Module.canvas;
		if (!c) return null;
		const b = c.getBoundingClientRect();
		return { left: b.left, top: b.top, width: b.width, height: b.height, internalW: c.width, internalH: c.height };
	});
}

async function cropTracker(label, filename) {
	const el = await trackerElement();
	const rect = await trackerRect();
	const box = await canvasBox();
	writeFileSync(
		path.join(outDir, filename + '.rect.json'),
		JSON.stringify({ label, shown: el && el.shown, rect, canvasBox: box }, null, 2)
	);
	const w = rect && (rect.w ?? rect.width);
	const h = rect && (rect.h ?? rect.height);
	if (!rect || !w || !h || w <= 0 || h <= 0 || !box) {
		// Full-canvas shot so a reviewer can see the collapsed/no-rect state directly.
		await page.screenshot({ path: path.join(outDir, filename + '.png') });
		return { rect, cropped: false };
	}
	const sx = box.width / box.internalW;
	const sy = box.height / box.internalH;
	const m = 20; // margin in CSS px
	const vw = page.viewportSize().width, vh = page.viewportSize().height;
	// Empirically (verified against a full-page screenshot for this exact
	// dist/demo): the exported element rect's X is measured from the right
	// edge of the New-HUD-system box, but the "Classic text" tracker style
	// (the default) actually draws at the mirrored X — screen_width - rect.x
	// - rect.w. Confirmed by matching visible obituary text location to the
	// rect's width (320px, 16px/line) at the mirrored offset in a full-page
	// capture; see a-full-page.png / canvas-zoom.png in the proof output.
	const mirroredX = box.internalW - rect.x - w;
	const x0 = Math.max(0, box.left + mirroredX * sx - m);
	const y0 = Math.max(0, box.top + rect.y * sy - m);
	const clip = {
		x: x0,
		y: y0,
		width: Math.min(w * sx + 2 * m, vw - x0),
		height: Math.min(h * sy + 2 * m, vh - y0),
	};
	await page.screenshot({ path: path.join(outDir, filename + '.png'), clip });
	return { rect, box, cropped: true };
}

// wait for engine to boot and demo to start drawing something
console.log('waiting for engine boot...');
let state = null;
for (let i = 0; i < 120; i++) {
	state = await evalState();
	if (state && (state.elements || []).some((e) => e.rect)) break;
	await page.waitForTimeout(500);
}
writeFileSync(path.join(outDir, 'boot-state.json'), JSON.stringify(state, null, 2));
console.log('booted, elements:', state && state.elements && state.elements.map((e) => e.name));

// The bundled demo picker defaults to hudtest (synthetic); the proof calls for
// qw/demos/tb4gf_book_vs_s.mvd specifically, so switch explicitly rather than
// rely on whatever localStorage happened to have.
console.log('switching to tb4gf_book_vs_s.mvd...');
await page.evaluate(() => window.FTEC && window.FTEC.cbufadd('playdemo demos/tb4gf_book_vs_s.mvd\n'));
await page.waitForTimeout(3000);

// (a) default settings, wait ~60s for tracker rows during playback
console.log('(a) waiting up to 60s for tracker rows at defaults...');
let gotRows = false;
for (let i = 0; i < 60; i++) {
	await page.waitForTimeout(1000);
	const s = await evalState();
	const kf = s && s.killfeed;
	// dump periodically
	if (i === 59) writeFileSync(path.join(outDir, 'a-final-state.json'), JSON.stringify(s, null, 2));
}
await page.screenshot({ path: path.join(outDir, 'a-full-page.png') });
await cropTracker('a: defaults, ~60s in', 'a-defaults-rows');
writeFileSync(path.join(outDir, 'a-console-tail.txt'), consoleLines.slice(-200).join('\n'));

// (b) r_tracker 0 -> rect collapses
await setCvar('r_tracker', '0');
await page.waitForTimeout(2000);
await cropTracker('b: r_tracker 0', 'b-tracker-off');

await setCvar('r_tracker', '1');
await page.waitForTimeout(2000);

// (c) r_tracker_messages 2 vs 20
await setCvar('r_tracker_messages', '2');
await page.waitForTimeout(5000);
const cLinesBefore = consoleLines.length;
await cropTracker('c: r_tracker_messages 2', 'c-messages-2');

await setCvar('r_tracker_messages', '20');
await page.waitForTimeout(8000);
await cropTracker('c: r_tracker_messages 20', 'c-messages-20');

// (d) cl_useimagesinfraglog 1
await setCvar('cl_useimagesinfraglog', '1');
await page.waitForTimeout(5000);
await cropTracker('d: cl_useimagesinfraglog 1', 'd-icons');

await setCvar('cl_useimagesinfraglog', '0');

// (e) r_tracker_frags 0 -> no new rows for 30s while obituaries keep printing
await setCvar('r_tracker_frags', '0');
const preFragsOffLines = consoleLines.length;
const before = await cropTracker('e: r_tracker_frags 0, t=0', 'e-frags-off-t0');
await page.waitForTimeout(30000);
const after = await cropTracker('e: r_tracker_frags 0, t=30s', 'e-frags-off-t30');
const newConsoleLines = consoleLines.length - preFragsOffLines;
writeFileSync(path.join(outDir, 'e-console-during.txt'), consoleLines.slice(preFragsOffLines).join('\n'));
writeFileSync(path.join(outDir, 'e-summary.json'), JSON.stringify({ before, after, newConsoleLines }, null, 2));

// (f) console echo of obituaries -- check con_fragmessages 0 does not silence them
await setCvar('con_fragmessages', '0');
const preSilence = consoleLines.length;
await page.waitForTimeout(15000);
const duringSilenceAttempt = consoleLines.slice(preSilence);
writeFileSync(path.join(outDir, 'f-console-fragmessages0.txt'), duringSilenceAttempt.join('\n'));
writeFileSync(path.join(outDir, 'f-summary.json'), JSON.stringify({
	linesWhileConFragmessages0: duringSilenceAttempt.length,
	sample: duringSilenceAttempt.slice(0, 20),
}, null, 2));

writeFileSync(path.join(outDir, 'full-console.txt'), consoleLines.join('\n'));

await browser.close();
server.close();
console.log('done, artifacts in', outDir);
