import assert from 'node:assert/strict';
import test from 'node:test';

import { magnetizeRect, snapToGrid } from '../snapping.js';

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
