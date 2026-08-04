import assert from 'node:assert/strict';
import test from 'node:test';

import {
	alignment, containment, DYNAMIC_WIDTH, hudCvars, logShape, metamorphic, proportionality, roundTrip,
} from '../invariants.mjs';

function snapshot(width, height, elements) {
	return { screen: { vid_width: width, vid_height: height }, elements };
}

function el(name, rect, cvars = {}, extra = {}) {
	return { name, rect, cvars, pos_x: 0, pos_y: 0, shown: true, ...extra };
}

test('proportionality passes a perfect rescale and fails a kept size', () => {
	const before = snapshot(2560, 1440, [
		el('health', { x: 400, y: 800, w: 100, h: 40 }),
		el('armor', { x: 800, y: 800, w: 100, h: 40 }),
	]);
	const after = snapshot(1920, 1080, [
		el('health', { x: 300, y: 600, w: 75, h: 30 }),
		el('armor', { x: 600, y: 600, w: 100, h: 40 }),   // size not rescaled
	]);
	const report = proportionality(before, after);
	assert.equal(report.pass, false);
	assert.deepEqual(report.failures.map((f) => f.element), ['armor']);
	assert.ok(report.failures[0].deltas.w > 8);
});

test('dynamic ping width is ignored by proportionality but health width is still judged', () => {
	const before = (name) => snapshot(960, 540, [el(name, { x: 100, y: 100, w: 176, h: 20 })]);
	const after = (name) => snapshot(672, 378, [el(name, { x: 70, y: 70, w: 136, h: 14 })]);
	const ping = proportionality(before('ping'), after('ping'));
	assert.equal(ping.pass, true);
	assert.deepEqual(ping.exempt_width, ['ping']);
	const health = proportionality(before('health'), after('health'));
	assert.equal(health.pass, false);
	assert.deepEqual(health.failures[0].judged, ['x', 'y', 'w', 'h']);
});

test('dynamic ping width is ignored by metamorphic but health width is still judged', () => {
	const original = (name) => snapshot(960, 540, [el(name, { x: 100, y: 100, w: 176, h: 20 })]);
	const returned = (name) => snapshot(960, 540, [el(name, { x: 100, y: 100, w: 136, h: 20 })]);
	const ping = metamorphic(original('ping'), returned('ping'));
	assert.equal(ping.pass, true);
	assert.deepEqual(ping.exempt_width, ['ping']);
	const health = metamorphic(original('health'), returned('health'));
	assert.equal(health.pass, false);
	assert.deepEqual(health.failures[0].judged, ['x', 'y', 'w', 'h']);
});

test('dynamic-width exemption is the reviewed ping list', () => {
	assert.deepEqual(DYNAMIC_WIDTH, ['ping']);
});

test('dynamic ping width exemption does not hide position drift', () => {
	const original = snapshot(960, 540, [el('ping', { x: 100, y: 100, w: 176, h: 20 })]);
	const drifted = snapshot(960, 540, [el('ping', { x: 120, y: 100, w: 176, h: 20 })]);
	const proportional = proportionality(original, drifted);
	const thereAndBack = metamorphic(original, drifted);
	assert.equal(proportional.pass, false);
	assert.deepEqual(proportional.failures[0].judged, ['x', 'y', 'h']);
	assert.equal(thereAndBack.pass, false);
	assert.deepEqual(thereAndBack.failures[0].judged, ['x', 'y', 'h']);
});

test('proportionality tolerance widens with the element scale', () => {
	const before = snapshot(2560, 1440, [
		el('big', { x: 0, y: 0, w: 200, h: 80 }, { hud_big_scale: '4' }),
	]);
	// 12px off: over the 8px glyph at scale 1, under the 32px glyph at scale 4.
	const after = snapshot(1920, 1080, [
		el('big', { x: 12, y: 0, w: 150, h: 60 }, { hud_big_scale: '4' }),
	]);
	assert.equal(proportionality(before, after).pass, true);
});

test('proportionality skips elements without a rect on either side', () => {
	const before = snapshot(2560, 1440, [el('ghost', null)]);
	const after = snapshot(1920, 1080, [el('ghost', { x: 0, y: 0, w: 8, h: 8 })]);
	assert.equal(proportionality(before, after).pass, true);
});

test('FTE proportionality keeps screen anchors strict while ping width varies', () => {
	const before = {
		...snapshot(960, 540, [
			el('left', { x: 8, y: 8, w: 64, h: 16 }, {}, { place: 'screen', align_x: 'left', align_y: 'top' }),
			el('center', { x: 376, y: 262, w: 208, h: 16 }, {}, { place: 'screen', align_x: 'center', align_y: 'center' }),
			el('right', { x: 872, y: 516, w: 64, h: 16 }, {}, { place: 'screen', align_x: 'right', align_y: 'bottom' }),
			el('ping', { x: 8, y: 32, w: 176, h: 16 }, {}, { place: 'screen', align_x: 'left', align_y: 'top' }),
		]),
		engine: 'fteqw ezhud (web)',
	};
	const after = {
		...snapshot(672, 378, [
			el('left', { x: 8, y: 8, w: 64, h: 16 }, {}, { place: 'screen', align_x: 'left', align_y: 'top' }),
			el('center', { x: 232, y: 181, w: 208, h: 16 }, {}, { place: 'screen', align_x: 'center', align_y: 'center' }),
			el('right', { x: 584, y: 354, w: 64, h: 16 }, {}, { place: 'screen', align_x: 'right', align_y: 'bottom' }),
			el('ping', { x: 8, y: 32, w: 136, h: 16 }, {}, { place: 'screen', align_x: 'left', align_y: 'top' }),
		]),
		engine: 'fteqw ezhud (web)',
	};
	const report = proportionality(before, after);
	assert.equal(report.pass, true);
	assert.deepEqual(report.ratio, { x: 0.7, y: 0.7 });
	assert.deepEqual(report.exempt_width, ['ping']);
});

test('containment flags any rect leaving the screen', () => {
	const state = snapshot(1920, 1080, [
		el('inside', { x: 0, y: 0, w: 100, h: 100 }),
		el('outside', { x: 1900, y: 0, w: 100, h: 100 }),
	]);
	const report = containment(state);
	assert.equal(report.pass, false);
	assert.deepEqual(report.failures.map((f) => f.element), ['outside']);
});

test('alignment keeps flush-right elements flush after resize', () => {
	const before = snapshot(2560, 1440, [el('clock', { x: 2460, y: 0, w: 100, h: 24 })]);
	const flush = snapshot(1920, 1080, [el('clock', { x: 1845, y: 0, w: 75, h: 18 })]);
	const drifted = snapshot(1920, 1080, [el('clock', { x: 1700, y: 0, w: 75, h: 18 })]);
	assert.equal(alignment(before, flush).pass, true);
	assert.equal(alignment(before, drifted).pass, false);
});

test('roundTrip demands byte-identical cvar strings', () => {
	const exported = { hud_health_pos_x: '12.5', hud_health_scale: '2' };
	assert.equal(roundTrip(exported, { ...exported }).pass, true);
	const mangled = roundTrip(exported, { hud_health_pos_x: '12.50', hud_health_scale: '2' });
	assert.equal(mangled.pass, false);
	assert.equal(mangled.failures[0].cvar, 'hud_health_pos_x');
});

test('metamorphic requires exact rect reproduction', () => {
	const original = snapshot(2560, 1440, [el('fps', { x: 10, y: 10, w: 40, h: 8 })]);
	const exact = snapshot(2560, 1440, [el('fps', { x: 10, y: 10, w: 40, h: 8 })]);
	const off = snapshot(2560, 1440, [el('fps', { x: 10, y: 10, w: 41, h: 8 })]);
	assert.equal(metamorphic(original, exact).pass, true);
	assert.equal(metamorphic(original, off).pass, false);
});

test('logShape fails on unexpected errors and excess warns, with the entries as evidence', () => {
	const entries = [
		{ level: 'error', msg: 'Lost contact' },
		{ level: 'warn', msg: 'rect null' },
		{ level: 'info', msg: 'set hud_fps_show' },
	];
	assert.equal(logShape(entries, { errors: 1, maxWarns: 1 }).pass, true);
	const report = logShape(entries, { errors: 0, maxWarns: 0 });
	assert.equal(report.pass, false);
	assert.equal(report.failures.length, 2);
	assert.equal(report.failures[0].entries[0].msg, 'Lost contact');
});

test('hudCvars flattens element cvars and adds the placement trio', () => {
	const state = snapshot(2560, 1440, [
		el('fps', { x: 0, y: 0, w: 8, h: 8 }, { hud_fps_style: '1' }, { pos_x: '3.5', pos_y: '0', shown: false }),
	]);
	assert.deepEqual(hudCvars(state), {
		hud_fps_style: '1',
		hud_fps_pos_x: '3.5',
		hud_fps_pos_y: '0',
		hud_fps_show: '0',
	});
});
