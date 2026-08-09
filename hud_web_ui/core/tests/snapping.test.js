import assert from 'node:assert/strict';
import test from 'node:test';

import { gridLines, magnetizeRect, snapToGrid } from '../snapping.js';

test('grid snapping rounds symmetrically to the configured positive step', () => {
	assert.equal(snapToGrid(13, 8), 16);
	assert.equal(snapToGrid(11, 8), 8);
	assert.equal(snapToGrid(-13, 8), -16);
	assert.equal(snapToGrid(-11, 8), -8);
	assert.equal(snapToGrid(13, 5), 15);
	assert.equal(snapToGrid(13, 0), 13);
});

test('magnet picks the nearest edge or centre independently per axis', () => {
	const result = magnetizeRect(
		{ x: 93, y: 26, w: 10, h: 10 },
		[{ name: 'target', rect: { x: 110, y: 40, w: 20, h: 20 } }],
		{ x: 8, y: 5 },
	);
	assert.deepEqual(result.rect, { x: 100, y: 30, w: 10, h: 10 });
	assert.deepEqual(result.delta, { x: 7, y: 4 });
	assert.deepEqual(result.guides.map(({ axis, value, target }) => ({ axis, value, target })), [
		{ axis: 'x', value: 110, target: 'target' },
		{ axis: 'y', value: 40, target: 'target' },
	]);
});

test('magnet stays inert outside threshold and uses deterministic target order on ties', () => {
	assert.deepEqual(magnetizeRect(
		{ x: 0, y: 0, w: 10, h: 10 },
		[{ name: 'far', rect: { x: 40, y: 40, w: 10, h: 10 } }],
		{ x: 4, y: 4 },
	), { rect: { x: 0, y: 0, w: 10, h: 10 }, delta: { x: 0, y: 0 }, guides: [] });

	const tie = magnetizeRect(
		{ x: 10, y: 10, w: 10, h: 10 },
		[
			{ name: 'first', rect: { x: 24, y: 100, w: 10, h: 10 } },
			{ name: 'second', rect: { x: 24, y: 100, w: 10, h: 10 } },
		],
		{ x: 4, y: 0 },
	);
	assert.equal(tie.delta.x, 4);
	assert.equal(tie.guides[0].target, 'first');
});

// gridLines draws what snapToGrid does. The two must agree by construction: a
// drawn line the drag does not land on is worse than no grid at all, because it
// is a promise the editor breaks on every drag.
test('every drawn line is a position a drag actually snaps to', () => {
	const { x, y } = gridLines(8, { w: 320, h: 200 });
	for (const value of [...x, ...y]) {
		assert.equal(snapToGrid(value, 8), value, `line ${value} is not a snap target`);
	}
});

test('lines start at the origin and cover the console extent without leaving it', () => {
	const { x, y } = gridLines(8, { w: 320, h: 200 });
	assert.equal(x[0], 0);
	assert.equal(y[0], 0);
	assert.equal(x.at(-1), 320);
	assert.equal(y.at(-1), 200);
	assert.equal(x.length, 41);
	assert.equal(y.length, 26);
});

test('a step that does not divide the extent stops before the far edge', () => {
	const { x } = gridLines(7, { w: 20, h: 20 });
	assert.deepEqual(x, [0, 7, 14]);
});

test('a step the engine cannot use draws nothing', () => {
	assert.deepEqual(gridLines(0, { w: 320, h: 200 }), { x: [], y: [] });
	assert.deepEqual(gridLines(-8, { w: 320, h: 200 }), { x: [], y: [] });
	assert.deepEqual(gridLines(Number.NaN, { w: 320, h: 200 }), { x: [], y: [] });
	assert.deepEqual(gridLines(8, { w: 0, h: 0 }), { x: [], y: [] });
});

// vid_conwidth and vid_conheight are independent, so the two axes can be
// legible at different cadences on the same screen. Coarsening both because one
// is too dense would thin out a grid the user can see perfectly well.
test('an axis below the legibility floor is coarsened alone, not blanked', () => {
	const dense = gridLines(2, { w: 320, h: 200 }, { x: 5, y: 1 });
	// x: 2 is under the floor of 5, so every third line -> a cadence of 6.
	assert.equal(dense.x[1], 6);
	assert.equal(dense.x.at(-1), 318);
	// y: 2 already clears its floor of 1 and keeps the step it was given.
	assert.equal(dense.y[1], 2);
	assert.equal(dense.y.length, 101);
});

// The whole point of coarsening rather than blanking: ticking Grid must never
// answer with an empty stage, which is the defect this function exists to fix.
test('a step far under the floor still draws lines a drag lands on', () => {
	const { x } = gridLines(1, { w: 320, h: 200 }, { x: 12, y: 12 });
	assert(x.length > 1, 'a 1px step under a 12px floor drew nothing');
	for (const value of x) {
		assert.equal(snapToGrid(value, 1), value);
	}
	assert.equal(x[1], 12);
});

test('the legibility floor is inclusive so a step exactly at it keeps its cadence', () => {
	const { x } = gridLines(4, { w: 320, h: 200 }, { x: 4, y: 4 });
	assert.equal(x.length, 81);
});
