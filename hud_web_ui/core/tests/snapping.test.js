import assert from 'node:assert/strict';
import test from 'node:test';

import { gridLines, magnetizeRect, screenMagnetTarget, snapToGrid } from '../snapping.js';

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
	// Exclusive of the far edge: a line at x === w projects to the overlay's own
	// right edge, where it is clipped away and only inflates the node count.
	assert.equal(x.at(-1), 312);
	assert.equal(y.at(-1), 192);
	assert.equal(x.length, 40);
	assert.equal(y.length, 25);
});

// The whole point of a fixed grid is that things snap INTO it. The drag snaps
// the element's POSITION and solves back for the offset (view/app.js beginDrag),
// so an element lands on a drawn line whatever its anchor put its base at --
// and two elements with different bases land on the SAME lines.
test('every element lands on a drawn line, whatever its base', () => {
	const step = 8;
	const drawn = new Set(gridLines(step, { w: 320, h: 200 }).x);
	for (const base of [0, 3, 47, 152, 163, 299, -5]) {
		for (const proposedOffset of [11, 12, 13, 100, 101, 254]) {
			// exactly what beginDrag computes: snap the position, solve for the offset
			const offset = snapToGrid(base + proposedOffset, step) - base;
			const landed = base + offset;
			assert(Number.isInteger(offset),
				`base ${base} at offset ${proposedOffset} produced a fractional offset ${offset}`);
			if (landed >= 0 && landed < 320) {
				assert(drawn.has(landed),
					`base ${base} at offset ${proposedOffset} landed on ${landed}, not a drawn line`);
			}
		}
	}
});

test('two elements dragged to the same place land on the same line', () => {
	const step = 8;
	// The pointer proposes a POSITION; beginDrag turns it into this element's
	// offset, snaps, and solves back. Two different anchors, one answer.
	const land = (base, target) => {
		const proposed = target - base;
		return base + (snapToGrid(base + proposed, step) - base);
	};
	for (const target of [100, 101, 104, 255]) {
		const answers = [0, 3, 47, 152, 299, -5].map((base) => land(base, target));
		assert.equal(new Set(answers).size, 1,
			`dragging to ${target} gave ${answers.join(', ')} depending on the anchor`);
	}
});

// The caller's floor is fractional (12 * vid_width / shown), so the cadence can
// be fractional too and an accumulating loop would drift off the lattice.
test('a fractional floor does not drift the lattice across the extent', () => {
	const { x } = gridLines(3, { w: 300, h: 10 }, { x: 8.89, y: 8.89 });
	assert.equal(x[1] - x[0], 9);
	assert(Math.abs(x.at(-1) - 297) < 1e-9, `last line drifted to ${x.at(-1)}`);
	for (const value of x) {
		assert(Math.abs(value / 3 - Math.round(value / 3)) < 1e-9,
			`${value} is not a multiple of the step a drag uses`);
	}
});

test('a step that does not divide the extent stops before the far edge', () => {
	const { x } = gridLines(7, { w: 20, h: 20 });
	assert.deepEqual(x, [0, 7, 14]);
});

// The coarsened cadence has to actually clear the floor it was given, or the
// coarsening is decoration and the picture is still a veil.
test('the coarsened cadence clears the floor it was given', () => {
	for (const [step, floor] of [[2, 5], [1, 12], [3, 12], [5, 12], [8, 11.94]]) {
		const { x } = gridLines(step, { w: 1000, h: 10 }, { x: floor, y: floor });
		assert(x[1] - x[0] >= floor,
			`step ${step} under floor ${floor} drew lines ${(x[1] - x[0])} apart`);
	}
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
	assert.equal(dense.y.at(-1), 198);
	// y: 2 already clears its floor of 1 and keeps the step it was given.
	assert.equal(dense.y[1], 2);
	assert.equal(dense.y.length, 100);
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
	assert.equal(x.length, 80);
	assert.equal(x[1] - x[0], 4, 'a step exactly at the floor was coarsened anyway');
});

// The screen is a surface like any other: a HUD hangs off its bottom and right
// edges, and until the screen was a magnet target there was no way to meet them.
// magnetizeRect already offers start/centre/end per axis, so one target gives
// both edges and the centre line, with the guides it already renders.
test('the screen rect is a magnet target like any element', () => {
	const screen = screenMagnetTarget({ vid_width: 320, vid_height: 200 });
	assert.deepEqual(screen, { name: 'screen', rect: { x: 0, y: 0, w: 320, h: 200 } });
	// an element 4px short of the bottom edge, within threshold
	const result = magnetizeRect({ x: 100, y: 172, w: 40, h: 24 }, [screen], { x: 0, y: 8 });
	assert.equal(result.rect.y, 176, 'the element did not meet the bottom edge');
	assert.equal(result.rect.y + 24, 200);
	assert.deepEqual(result.guides.map((g) => ({ axis: g.axis, value: g.value, target: g.target })),
		[{ axis: 'y', value: 200, target: 'screen' }]);
});

test('a missing screen silently omits the synthetic magnet target', () => {
	assert.equal(screenMagnetTarget(null), null);
	assert.equal(screenMagnetTarget({ vid_width: 320, vid_height: 0 }), null);
});

test('the screen offers its centre line, not only its edges', () => {
	const screen = screenMagnetTarget({ vid_width: 320, vid_height: 200 });
	// x=153,w=10 puts the element's own centre 2 from the screen centre and its
	// right edge 3 away, so the centre-to-centre match is the nearest one. Pick
	// the geometry deliberately: the magnet takes the closest point of the three,
	// and an element whose EDGE is nearer meets the centre line with its edge --
	// which is correct, and not what this test is about.
	const off = magnetizeRect({ x: 153, y: 10, w: 10, h: 10 }, [screen], { x: 8, y: 0 });
	assert.equal(off.rect.x + 5, 160, 'the element centre did not meet the screen centre');
	assert.deepEqual(off.guides.map((g) => ({ axis: g.axis, value: g.value, target: g.target })),
		[{ axis: 'x', value: 160, target: 'screen' }]);
});
