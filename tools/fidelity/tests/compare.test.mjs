// tools/fidelity/tests/compare.test.mjs — tier 1. The judgement, not the plumbing.
//
// Every case here is a hand-built pair of state snapshots, so a failure names a
// rule rather than an engine. The plumbing (two live bridges) is proven
// separately by tools/fidelity/run.sh --selftest.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compareStates, carryClaims, DIMENSIONS } from '../compare.mjs';

const el = (name, rect, extra = {}) => ({
	name,
	shown: rect !== null,
	place: 'screen',
	align_x: 'left',
	align_y: 'top',
	pos_x: 0,
	pos_y: 0,
	rect,
	cvars: {},
	...extra,
});

const state = (elements, { width = 640, height = 480 } = {}) => ({
	protocol: 1,
	engine: 'test-engine',
	screen: { vid_width: width, vid_height: height, scr_con_current: 0 },
	physical: [width, height],
	elements,
});

const rowFor = (result, element, dimension) =>
	result.measured.find((r) => r.element === element && r.dimension === dimension);

// --- comparability guard ----------------------------------------------------

test('states measured at different console sizes are refused, not compared', () => {
	const result = compareStates({
		reference: state([el('health', { x: 10, y: 10, w: 20, h: 20 })], { width: 640, height: 480 }),
		preview: state([el('health', { x: 10, y: 10, w: 20, h: 20 })], { width: 320, height: 240 }),
	});
	assert.equal(result.comparable, false);
	assert.match(result.incomparable_reason, /console size/i);
	assert.deepEqual(result.measured, []);
});

test('a comparable pair reports the console size it was measured at', () => {
	const result = compareStates({
		reference: state([el('health', { x: 1, y: 2, w: 3, h: 4 })]),
		preview: state([el('health', { x: 1, y: 2, w: 3, h: 4 })]),
	});
	assert.equal(result.comparable, true);
	assert.deepEqual(result.console, { width: 640, height: 480 });
});

// --- presence ---------------------------------------------------------------

test('drawn on both sides is a presence match', () => {
	const result = compareStates({
		reference: state([el('health', { x: 1, y: 2, w: 3, h: 4 })]),
		preview: state([el('health', { x: 1, y: 2, w: 3, h: 4 })]),
	});
	assert.equal(rowFor(result, 'health', 'presence').verdict, 'match');
});

test('registered but not drawn in the preview is a divergence naming the direction', () => {
	const result = compareStates({
		reference: state([el('tracker', { x: 1, y: 2, w: 3, h: 4 })]),
		preview: state([el('tracker', null)]),
	});
	const row = rowFor(result, 'tracker', 'presence');
	assert.equal(row.verdict, 'diverges');
	assert.equal(row.code, 'preview-not-drawn');
});

test('absent from the preview registry entirely is a distinct code from not-drawn', () => {
	const result = compareStates({
		reference: state([el('radar', { x: 1, y: 2, w: 3, h: 4 })]),
		preview: state([]),
	});
	const row = rowFor(result, 'radar', 'presence');
	assert.equal(row.verdict, 'diverges');
	assert.equal(row.code, 'not-registered-in-preview');
});

test('drawn only in the preview is a divergence too — the preview must not invent elements', () => {
	const result = compareStates({
		reference: state([el('face', null)]),
		preview: state([el('face', { x: 337, y: 111, w: 48, h: 48 })]),
	});
	const row = rowFor(result, 'face', 'presence');
	assert.equal(row.verdict, 'diverges');
	assert.equal(row.code, 'reference-not-drawn');
});

test('drawn by neither is recorded as absent-both, and is not a gap', () => {
	const result = compareStates({
		reference: state([el('qtv_buffer', null)]),
		preview: state([el('qtv_buffer', null)]),
	});
	assert.equal(rowFor(result, 'qtv_buffer', 'presence').verdict, 'absent-both');
	assert.equal(result.counts.diverging, 0);
});

// --- position and size ------------------------------------------------------

test('identical rects match on both geometric dimensions', () => {
	const result = compareStates({
		reference: state([el('frags', { x: 100, y: 200, w: 32, h: 16 })]),
		preview: state([el('frags', { x: 100, y: 200, w: 32, h: 16 })]),
	});
	assert.equal(rowFor(result, 'frags', 'position').verdict, 'match');
	assert.equal(rowFor(result, 'frags', 'size').verdict, 'match');
});

test('a position divergence is caught and reports the signed delta', () => {
	const result = compareStates({
		reference: state([el('teaminfo', { x: 10, y: 20, w: 156, h: 56 })]),
		preview: state([el('teaminfo', { x: 483, y: 308, w: 156, h: 56 })]),
	});
	const row = rowFor(result, 'teaminfo', 'position');
	assert.equal(row.verdict, 'diverges');
	assert.equal(row.code, 'position-differs');
	assert.deepEqual(row.delta, { x: 473, y: 288 });
	assert.equal(rowFor(result, 'teaminfo', 'size').verdict, 'match');
});

test('a size divergence is caught independently of position', () => {
	const result = compareStates({
		reference: state([el('bar_health', { x: 394, y: 338, w: 50, h: 20 })]),
		preview: state([el('bar_health', { x: 394, y: 338, w: 64, h: 20 })]),
	});
	assert.equal(rowFor(result, 'bar_health', 'position').verdict, 'match');
	const row = rowFor(result, 'bar_health', 'size');
	assert.equal(row.verdict, 'diverges');
	assert.deepEqual(row.delta, { w: 14, h: 0 });
});

test('tolerance is applied per axis and recorded in the result', () => {
	const pair = {
		reference: state([el('ammo3', { x: 307, y: 305, w: 32, h: 16 })]),
		preview: state([el('ammo3', { x: 309, y: 305, w: 32, h: 16 })]),
	};
	assert.equal(rowFor(compareStates(pair), 'ammo3', 'position').verdict, 'diverges');
	const tolerant = compareStates({ ...pair, tolerance: 2 });
	assert.equal(rowFor(tolerant, 'ammo3', 'position').verdict, 'match');
	assert.equal(tolerant.tolerance_px, 2);
});

test('geometry is not assessable when either side does not draw the element', () => {
	const result = compareStates({
		reference: state([el('itemsclock', { x: 1, y: 278, w: 208, h: 8 })]),
		preview: state([el('itemsclock', null)]),
	});
	for (const dimension of ['position', 'size']) {
		const row = rowFor(result, 'itemsclock', dimension);
		assert.equal(row.verdict, 'not-assessable');
		assert.equal(row.code, 'not-drawn-on-both-sides');
	}
});

// --- shape, ordering, determinism -------------------------------------------

test('every element yields exactly one row per measured dimension', () => {
	const names = ['health', 'armor', 'frags'];
	const result = compareStates({
		reference: state(names.map((n) => el(n, { x: 1, y: 1, w: 1, h: 1 }))),
		preview: state(names.map((n) => el(n, { x: 1, y: 1, w: 1, h: 1 }))),
	});
	assert.equal(result.measured.length, names.length * DIMENSIONS.length);
});

test('rows are sorted by element then dimension, so two reports diff line by line', () => {
	const forward = ['zoom', 'armor', 'health'];
	const backward = [...forward].reverse();
	const build = (order) => compareStates({
		reference: state(order.map((n) => el(n, { x: 1, y: 1, w: 1, h: 1 }))),
		preview: state(order.map((n) => el(n, { x: 1, y: 1, w: 1, h: 1 }))),
	});
	assert.deepEqual(build(forward).measured, build(backward).measured);
	assert.deepEqual(
		build(forward).measured.filter((r) => r.dimension === 'presence').map((r) => r.element),
		['armor', 'health', 'zoom'],
	);
});

test('the same input twice produces byte-identical output', () => {
	const pair = {
		reference: state([el('health', { x: 1, y: 2, w: 3, h: 4 }), el('face', null)]),
		preview: state([el('health', { x: 9, y: 2, w: 3, h: 4 }), el('face', { x: 0, y: 0, w: 8, h: 8 })]),
	};
	assert.equal(JSON.stringify(compareStates(pair)), JSON.stringify(compareStates(pair)));
});

test('counts add up to the rows they summarise', () => {
	const result = compareStates({
		reference: state([
			el('health', { x: 1, y: 1, w: 1, h: 1 }),
			el('tracker', { x: 1, y: 1, w: 1, h: 1 }),
			el('qtv_buffer', null),
		]),
		preview: state([
			el('health', { x: 1, y: 1, w: 1, h: 1 }),
			el('tracker', null),
			el('qtv_buffer', null),
		]),
	});
	const tally = (verdict) => result.measured.filter((r) => r.verdict === verdict).length;
	assert.equal(result.counts.matching, tally('match'));
	assert.equal(result.counts.diverging, tally('diverges'));
	assert.equal(result.counts.not_assessable, tally('not-assessable'));
	assert.equal(result.counts.absent_both, tally('absent-both'));
	assert.equal(result.counts.elements, 3);
});

// --- carried claims ---------------------------------------------------------

test('a carried claim about a still-drawn element is re-emitted as asserted, with its source', () => {
	const result = compareStates({
		reference: state([el('armor', { x: 1, y: 1, w: 1, h: 1 })]),
		preview: state([el('armor', { x: 1, y: 1, w: 1, h: 1 })]),
	});
	const carried = carryClaims(result, [{
		element: 'armor',
		dimension: 'colour',
		claim: 'ezQuake colours the number by armour type; the preview draws it white',
		source: 'spikes/fte-web/PARITY.md',
		observed: '2026-08-01',
	}]);
	assert.equal(carried.length, 1);
	assert.equal(carried[0].verdict, 'asserted');
	assert.equal(carried[0].source, 'spikes/fte-web/PARITY.md');
	assert.equal(carried[0].observed, '2026-08-01');
});

test('a claim about an element no longer drawn on both sides goes stale rather than silently passing', () => {
	const result = compareStates({
		reference: state([el('armor', { x: 1, y: 1, w: 1, h: 1 })]),
		preview: state([el('armor', null)]),
	});
	const carried = carryClaims(result, [{
		element: 'armor', dimension: 'colour', claim: 'x', source: 'y', observed: '2026-08-01',
	}]);
	assert.equal(carried[0].verdict, 'stale');
	assert.match(carried[0].note, /not drawn on both sides/i);
});

test('a claim naming an element that no engine registers is stale too', () => {
	const result = compareStates({ reference: state([]), preview: state([]) });
	const carried = carryClaims(result, [{
		element: 'gone', dimension: 'texture', claim: 'x', source: 'y', observed: '2026-08-01',
	}]);
	assert.equal(carried[0].verdict, 'stale');
});

test('carried claims never enter the measured rows or the divergence count', () => {
	const result = compareStates({
		reference: state([el('armor', { x: 1, y: 1, w: 1, h: 1 })]),
		preview: state([el('armor', { x: 1, y: 1, w: 1, h: 1 })]),
	});
	assert.equal(result.measured.some((r) => ['texture', 'colour'].includes(r.dimension)), false);
	assert.equal(result.counts.diverging, 0);
});
