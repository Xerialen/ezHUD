// tools/fidelity/tests/settle.test.mjs — tier 1. Getting both engines to the
// same starting line, and refusing to pretend when one of them will not come.
//
// These cases exist because of a measured fact, not a hypothetical. The
// FTE-web preview IGNORES vid_conwidth/vid_conheight while vid_conautoscale is
// non-zero: probed 2026-08-07 against dist ftewebglcl.wasm, `set vid_conwidth
// 640` left it reporting 352x200 (canvas 704x396, autoscaled) and it stayed
// there. With autoscale set to 0 first, the same two commands land 640x480.
//
// The spike's whole method was "vid_conwidth/conheight 640x480 on both, so
// console pixels are physical pixels and positions compare 1:1"
// (spikes/fte-web/PARITY.md). A run that issues those commands, does not check
// they took, and compares anyway is measuring two different coordinate systems
// and calling the difference a fidelity gap.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { settle, confirmConsoleSize } from '../measure.mjs';

function stubBridge({ honoursAutoscale = true, initial = { vid_width: 352, vid_height: 200 } } = {}) {
	const sent = [];
	const screen = { ...initial };
	let autoscale = 2;
	const pending = {};
	return {
		label: 'stub',
		sent,
		async cmd(line) {
			sent.push(line);
			const [, name, value] = line.match(/^set\s+(\S+)\s+(\S+)$/) ?? [];
			if (name === 'vid_conautoscale') autoscale = Number(value);
			if (name === 'vid_conwidth') pending.vid_width = Number(value);
			if (name === 'vid_conheight') pending.vid_height = Number(value);
			// The engine applies the console cvars only when it is not deriving
			// the console size from the canvas.
			if (!honoursAutoscale || autoscale === 0) Object.assign(screen, pending);
		},
		async state() {
			return { screen: { ...screen }, elements: [] };
		},
	};
}

const noSleep = async () => {};

test('autoscale is disarmed before the console cvars are sent, not after', async () => {
	const bridge = stubBridge();
	await settle(bridge, { freeze: [], consoleSize: { width: 640, height: 480 } });
	const order = bridge.sent.filter((l) => /vid_conautoscale|vid_conwidth|vid_conheight/.test(l));
	assert.equal(order[0], 'set vid_conautoscale 0');
	assert.deepEqual(order.slice(1), ['set vid_conwidth 640', 'set vid_conheight 480']);
});

test('with autoscale disarmed the console size actually lands', async () => {
	const bridge = stubBridge();
	await settle(bridge, { freeze: [], consoleSize: { width: 640, height: 480 } });
	const confirmed = await confirmConsoleSize(bridge, { width: 640, height: 480 }, { attempts: 3, sleep: noSleep });
	assert.equal(confirmed.ok, true);
	assert.deepEqual(confirmed.actual, { width: 640, height: 480 });
});

test('an engine that never takes the console size is reported, not waited on forever', async () => {
	// Model the failure directly: an engine that ignores the cvars outright.
	const bridge = stubBridge({ honoursAutoscale: true });
	bridge.cmd = async (line) => { bridge.sent.push(line); };
	const confirmed = await confirmConsoleSize(bridge, { width: 640, height: 480 }, { attempts: 3, sleep: noSleep });
	assert.equal(confirmed.ok, false);
	assert.deepEqual(confirmed.actual, { width: 352, height: 200 });
	assert.match(confirmed.reason, /never reached/i);
	assert.match(confirmed.reason, /640x480/);
	assert.match(confirmed.reason, /352x200/);
});

test('confirmation polls rather than reading once — a slow engine is not a failure', async () => {
	let reads = 0;
	const bridge = {
		label: 'slow',
		async cmd() {},
		async state() {
			reads++;
			return { screen: reads < 3 ? { vid_width: 352, vid_height: 200 } : { vid_width: 640, vid_height: 480 } };
		},
	};
	const confirmed = await confirmConsoleSize(bridge, { width: 640, height: 480 }, { attempts: 5, sleep: noSleep });
	assert.equal(confirmed.ok, true);
	assert.equal(reads, 3);
});

test('the demo is frozen before anything else is sent', async () => {
	const bridge = stubBridge();
	await settle(bridge, {
		freeze: ['demo_setspeed 0.01', 'cl_demospeed 0.01'],
		consoleSize: { width: 640, height: 480 },
		configText: 'hud_health_pos_x 10\n',
	});
	assert.deepEqual(bridge.sent.slice(0, 2), ['demo_setspeed 0.01', 'cl_demospeed 0.01']);
});

test('the layout is recalculated last — ezHUD caches parsed enums until it is', async () => {
	const bridge = stubBridge();
	await settle(bridge, { freeze: [], configText: 'hud_health_pos_x 10\n' });
	assert.equal(bridge.sent.at(-1), 'hud_recalculate');
});

test('config comments and blank lines are not sent to the engine', async () => {
	const bridge = stubBridge();
	await settle(bridge, { freeze: [], configText: '// a comment\n\n   \nhud_health_pos_x 10\n' });
	assert.deepEqual(bridge.sent.filter((l) => l !== 'hud_recalculate'), ['set hud_health_pos_x 10']);
});

test('a config line that already says set is not double-prefixed', async () => {
	const bridge = stubBridge();
	await settle(bridge, { freeze: [], configText: 'set hud_health_pos_x 10\n' });
	assert.ok(bridge.sent.includes('set hud_health_pos_x 10'));
	assert.equal(bridge.sent.some((l) => l.startsWith('set set ')), false);
});
