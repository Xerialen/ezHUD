#!/usr/bin/env node
// Contract proof for #61: consume the tracker rect exactly as /state reports it.
// No mirror or tracker-specific coordinate arithmetic is permitted here.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const origin = process.env.BRIDGE_URL;
const token = process.env.BRIDGE_TOKEN;
const artifacts = process.env.TRACKER_ARTIFACTS || '/tmp/ezhud-r2/tracker-contract';
assert(origin && token, 'BRIDGE_URL and BRIDGE_TOKEN are required');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const url = (route, extra = {}) => {
	const target = new URL(route, origin);
	target.searchParams.set('t', token);
	for (const [key, value] of Object.entries(extra)) target.searchParams.set(key, String(value));
	return target;
};

async function state() {
	const response = await fetch(url('/state'), { cache: 'no-store' });
	assert.equal(response.status, 200, `/state HTTP ${response.status}`);
	return response.json();
}

async function cmd(command) {
	const response = await fetch(url('/cmd'), {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ cmd: command }),
	});
	assert.equal(response.status, 200, `/cmd ${JSON.stringify(command)} HTTP ${response.status}`);
}

async function eventually(operation, label, timeout = 30000) {
	const deadline = Date.now() + timeout;
	let last;
	while (Date.now() <= deadline) {
		try {
			const result = await operation();
			if (result) return result;
		} catch (error) {
			last = error;
		}
		await sleep(200);
	}
	throw new Error(`timed out waiting for ${label}${last ? `: ${last.message}` : ''}`);
}

async function trackerState({ drawn = true } = {}) {
	return eventually(async () => {
		const next = await state();
		const tracker = next.elements.find((element) => element.name === 'tracker');
		return tracker && (!drawn || tracker.rect) ? { state: next, tracker } : null;
	}, drawn ? 'tracker /state rect' : 'tracker state entry');
}

async function pixels(rect, rows, label, { raw = false } = {}) {
	const receipt = await fetch(url('/pixels', { element: 'tracker', rows, raw: raw ? 1 : 0, ...rect })).then(async (response) => {
		if (response.status !== 200) {
			assert.fail(`/pixels HTTP ${response.status}: ${await response.text()}`);
		}
		return response.json();
	});
	await writeFile(path.join(artifacts, `${label}.png`), Buffer.from(receipt.png, 'base64'));
	delete receipt.png;
	return receipt;
}

function changedBounds(before, after) {
	assert.equal(after.width, before.width, 'pixel receipts have different widths');
	assert.equal(after.height, before.height, 'pixel receipts have different heights');
	const a = Buffer.from(before.rgba, 'base64');
	const b = Buffer.from(after.rgba, 'base64');
	assert.equal(b.length, a.length, 'pixel receipts have different byte lengths');
	let minX = Infinity;
	let maxX = -1;
	let minY = Infinity;
	let maxY = -1;
	for (let pixel = 0; pixel < a.length / 4; pixel++) {
		const offset = pixel * 4;
		if (a[offset] === b[offset] && a[offset + 1] === b[offset + 1]
			&& a[offset + 2] === b[offset + 2] && a[offset + 3] === b[offset + 3]) continue;
		const x = pixel % before.width;
		const y = Math.floor(pixel / before.width);
		minX = Math.min(minX, x);
		maxX = Math.max(maxX, x);
		minY = Math.min(minY, y);
		maxY = Math.max(maxY, y);
	}
	return maxX < 0 ? null : { minX, maxX, minY, maxY };
}

await mkdir(artifacts, { recursive: true });

// Use a wide canvas and a non-zero left offset so the reported and historically
// mirrored tracker regions do not overlap. An overlapping clip can produce a
// false pass even when its origin is wrong.
await cmd('set vid_width 1920');
await cmd('set vid_height 1080');
await eventually(async () => {
	const next = await state();
	return next.screen.vid_width >= 640 && next.screen.vid_height >= 360 ? next : null;
}, 'wide non-overlapping tracker canvas');

// The reviewed demo has a real obituary roughly ten seconds in. Establish the
// classic text path, then wait past that event before freezing. Other live HUD
// text is hidden so the clipped pixels can only change with the tracker row.
await cmd('playdemo demos/tb4gf_book_vs_s.mvd');
await sleep(2000);
for (const command of [
	'r_tracker 1',
	'r_tracker_frags 1',
	'r_tracker_time 60',
	'r_tracker_messages 7',
	'r_tracker_align_right 0',
	'cl_useimagesinfraglog 0',
	'set hud_tracker_show 1',
	'set hud_tracker_place screen',
	'set hud_tracker_align_x left',
	'set hud_tracker_align_y top',
	'set hud_tracker_pos_x 16',
	'set hud_tracker_pos_y 24',
	'set hud_tracker_scale 1',
	'set hud_tracker_frame 0',
	'viewsize 30',
	'con_notifylines 0',
	'set hud_clock_show 0',
	'set hud_gameclock_show 0',
	'set hud_democlock_show 0',
	'set hud_fps_show 0',
	'set hud_notify_show 0',
	'hud_recalculate',
]) await cmd(command);
await trackerState();
await sleep(12000);
await cmd('demo_setspeed 0');
await eventually(async () => (await state()).demo?.cl_demospeed === '0', 'frozen demo speed');
await sleep(2000);

const before = await trackerState();
const rect = before.tracker.rect;
const screen = before.state.screen;
assert.equal(before.tracker.align_x, 'left', 'tracker must be left-aligned for the Release 2 contract');
assert(rect.x >= 0 && rect.y >= 0, `tracker rect starts outside screen: ${JSON.stringify(rect)}`);
assert(rect.x + rect.w <= screen.vid_width,
	`tracker x containment failed: ${rect.x} + ${rect.w} > ${screen.vid_width}`);
assert(rect.y + rect.h <= screen.vid_height,
	`tracker y containment failed: ${rect.y} + ${rect.h} > ${screen.vid_height}`);

const rows = 7;
await cmd('set hud_tracker_show 0');
await eventually(async () => !(await trackerState({ drawn: false })).tracker.rect, 'hidden tracker rect');
await sleep(500);
const fullRow = { x: 0, y: rect.y, w: screen.vid_width, h: rect.h };
const hiddenBefore = await pixels(fullRow, rows, 'screen-row-hidden-before', { raw: true });
await sleep(1000);
const hiddenAfter = await pixels(fullRow, rows, 'screen-row-hidden-after', { raw: true });
assert.equal(hiddenAfter.signature, hiddenBefore.signature,
	`tracker screen row changed while hidden (${hiddenBefore.signature} -> ${hiddenAfter.signature})`);

await cmd('set hud_tracker_show 1');
await trackerState();
await sleep(500);
const enabled = await pixels(fullRow, rows, 'screen-row-enabled', { raw: true });
const exact = await pixels(rect, rows, 'tracker-reported-rect');
assert(exact.overlay, 'the editor has no overlay box for the drawn tracker');
for (const key of ['x', 'y', 'width']) {
	assert(Math.abs(exact.overlay[key] - exact.browserClip[key]) <= 1.5,
		`tracker overlay ${key}=${exact.overlay[key]} does not follow reported-rect clip ${exact.browserClip[key]}`);
}
assert(Math.abs(exact.overlay.height - exact.browserClip.height * rows) <= 1.5,
	`tracker overlay height=${exact.overlay.height} does not cover ${rows} reported rows of ${exact.browserClip.height}px`);
const changed = changedBounds(hiddenAfter, enabled);
assert(changed, 'enabling the tracker changed no pixels in its screen row');
const cssPerConsoleX = enabled.width / screen.vid_width;
const firstDrawnConsoleX = changed.minX / cssPerConsoleX;
assert(firstDrawnConsoleX >= rect.x && firstDrawnConsoleX < rect.x + 8,
	`/state tracker rect.x=${rect.x} but its first drawn glyph cell starts at x=${firstDrawnConsoleX.toFixed(2)}`);

const receipt = {
	consumer_coordinate_rule: 'clip /state tracker rect directly; no mirroring',
	screen,
	rect,
	containment: { x: rect.x + rect.w <= screen.vid_width, y: rect.y + rect.h <= screen.vid_height },
	drawn: { first_console_x: firstDrawnConsoleX, changed_css_bounds: changed },
	overlay: { box: exact.overlay, reported_rect_clip: exact.browserClip },
	signatures: {
		hidden: [hiddenBefore.signature, hiddenAfter.signature],
		enabled: enabled.signature,
	},
};
await writeFile(path.join(artifacts, 'receipt.json'), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt));
console.log('wasm tracker rect contract: PASS');
