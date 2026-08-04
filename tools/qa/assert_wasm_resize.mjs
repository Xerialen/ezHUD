#!/usr/bin/env node
// QA-level regressions for #40/#41: a browser viewport resize must reach the
// FTE canvas backing store and both dimensions exported by EZHud_StateJSON.
//
//   node tools/qa/assert_wasm_resize.mjs --bridge http://127.0.0.1:PORT --token TOKEN

import assert from 'node:assert/strict';
import process from 'node:process';

const args = process.argv.slice(2);
const flag = (name) => {
	const index = args.indexOf(`--${name}`);
	return index >= 0 ? args[index + 1] : null;
};
const origin = flag('bridge') ?? process.env.BRIDGE_URL;
const token = flag('token') ?? process.env.BRIDGE_TOKEN;
if (!origin || !token) {
	console.error('usage: assert_wasm_resize.mjs --bridge <origin> --token <token>');
	process.exit(2);
}

const url = (route) => `${origin}${route}?t=${encodeURIComponent(token)}`;

async function command(cmd) {
	const response = await fetch(url('/cmd'), {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ cmd }),
	});
	assert.equal(response.status, 200, `${cmd}: HTTP ${response.status}`);
}

async function metrics() {
	const response = await fetch(url('/metrics'), { cache: 'no-store' });
	assert.equal(response.status, 200, `/metrics: HTTP ${response.status}`);
	return response.json();
}

async function resize(width, height) {
	await command(`set vid_width ${width}`);
	await command(`set vid_height ${height}`);

	let previous = '';
	let stable = 0;
	let value;
	for (let attempt = 0; attempt < 40; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 100));
		value = await metrics();
		const signature = JSON.stringify({
			canvas: value.canvas, physical: value.physical, screen: value.screen,
		});
		stable = signature === previous ? stable + 1 : 0;
		previous = signature;
		if (value.viewport.width === width && value.viewport.height === height && stable >= 2) {
			return value;
		}
	}
	throw new Error(`resize ${width}x${height} did not settle: ${JSON.stringify(value)}`);
}

function assertPhysical(snapshot, label) {
	assert.ok(Array.isArray(snapshot.physical),
		`${label} /state.physical must be an array, got ${JSON.stringify(snapshot.physical)}`);
	assert.equal(snapshot.physical.length, 2,
		`${label} /state.physical must have exactly two entries`);
	assert.ok(snapshot.physical.every(Number.isInteger),
		`${label} /state.physical must contain integers, got ${JSON.stringify(snapshot.physical)}`);
	assert.deepEqual(snapshot.physical, [snapshot.canvas.width, snapshot.canvas.height],
		`${label} /state.physical must equal the canvas backing-store size`);
}

const source = await resize(2560, 1440);
const resized = await resize(1920, 1080);

assertPhysical(source, 'source');
assertPhysical(resized, 'resized');

assert.notEqual(resized.canvas.css_width, source.canvas.css_width,
	`canvas CSS width stayed ${source.canvas.css_width}px after viewport resize`);
assert.notEqual(resized.canvas.css_height, source.canvas.css_height,
	`canvas CSS height stayed ${source.canvas.css_height}px after viewport resize`);
assert.notEqual(resized.canvas.width, source.canvas.width,
	`canvas backing width stayed ${source.canvas.width}px after viewport resize`);
assert.notEqual(resized.canvas.height, source.canvas.height,
	`canvas backing height stayed ${source.canvas.height}px after viewport resize`);
assert.notEqual(resized.screen.vid_width, source.screen.vid_width,
	`state.screen width stayed ${source.screen.vid_width} after viewport resize`);
assert.notEqual(resized.screen.vid_height, source.screen.vid_height,
	`state.screen height stayed ${source.screen.vid_height} after viewport resize`);
assert.notEqual(resized.physical[0], source.physical[0],
	`state.physical width stayed ${source.physical[0]} after viewport resize`);
assert.notEqual(resized.physical[1], source.physical[1],
	`state.physical height stayed ${source.physical[1]} after viewport resize`);

const ratio = {
	x: resized.screen.vid_width / source.screen.vid_width,
	y: resized.screen.vid_height / source.screen.vid_height,
};
assert.notEqual(ratio.x, 1, 'state.screen x resize ratio must not be 1.0');
assert.notEqual(ratio.y, 1, 'state.screen y resize ratio must not be 1.0');

console.log(JSON.stringify({ source, resized, ratio }, null, 2));
console.log('Wasm resize propagation: PASS');
