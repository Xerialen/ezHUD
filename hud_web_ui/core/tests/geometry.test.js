import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
	alignmentBase, consoleToFrame, displayDeltaToConsole, elementAt, quantize, scaleFactors,
} from '../geometry.js';

const fixture = JSON.parse(await readFile(
	new URL('../../fixtures/state.json', import.meta.url), 'utf8'));

test('the real fixture preserves the deliberately different axis ratios', () => {
	assert.equal(fixture.elements.length, 83);
	assert.equal(fixture.elements.filter((e) => e.rect).length, 25);
	assert.deepEqual(scaleFactors(fixture.screen, fixture.physical), { kx: 4, ky: 3.6 });
});

test('consoleToFrame scales x/width and y/height on their own axes', () => {
	const source = fixture.elements.find((e) => e.name === 'centerprint').rect;
	assert.deepEqual(source, { x: 51, y: 46, w: 224, h: 68 });
	assert.deepEqual(consoleToFrame(source, fixture.screen, fixture.physical), {
		x: 204,
		y: 165.6,
		w: 896,
		h: 244.8,
	});
});

test('display deltas return to console space with independent kx and ky', () => {
	// At half native display width, 20 CSS px is 40 frame px. That is 10
	// console px horizontally but 11.111... vertically; equality would expose a
	// reintroduced single-ratio shortcut.
	assert.deepEqual(
		displayDeltaToConsole(20, 20, fixture.screen, fixture.physical, 640),
		{ dx: 10, dy: 100 / 9 },
	);
});

test('display deltas are inert until the frame has measurable dimensions', () => {
	assert.deepEqual(
		displayDeltaToConsole(10, 15, fixture.screen, fixture.physical, 0),
		{ dx: 0, dy: 0 },
	);
});

test('scaleFactors has safe fallbacks for an incomplete state', () => {
	assert.deepEqual(scaleFactors(null, null), { kx: 1, ky: 1 });
	assert.deepEqual(scaleFactors({ vid_width: 320 }, [1280]), { kx: 4, ky: 4 });
});

test('elementAt ignores null rects, respects half-open edges, and picks top draw order', () => {
	const elements = [
		{ name: 'hidden', rect: null, order: 100 },
		{ name: 'low', rect: { x: 10, y: 20, w: 30, h: 40 }, order: 2 },
		{ name: 'high', rect: { x: 15, y: 25, w: 10, h: 10 }, order: 7 },
	];
	assert.equal(elementAt(elements, 16, 26).name, 'high');
	assert.equal(elementAt(elements, 39, 59).name, 'low');
	assert.equal(elementAt(elements, 40, 60), null);
});

test('quantize matches the engine integer truncation on both sides of zero', () => {
	assert.equal(quantize(2.9), 2);
	assert.equal(quantize(-2.9), -2);
});

// The engine truncates `align + pos` into an int rect (libhud_place.c:149,
// hud_web_state.c:218) while pos itself is a float cvar. Anything that needs
// the positions an element can actually reach has to undo that the same way the
// engine did it, not by subtracting the float.
test('alignmentBase recovers a whole base from a fractional offset', () => {
	// iammo2 in the checked-in fixture: pos 213.999 against an integer rect.
	assert.equal(alignmentBase(213, 213.999), 0);
	assert.equal(alignmentBase(154, 2.9808), 152);
	assert.equal(alignmentBase(195, 195.892), 0);
});

test('alignmentBase is exact for the whole offsets a drag writes', () => {
	assert.equal(alignmentBase(312, 8), 304);
	assert.equal(alignmentBase(16, 16), 0);
	assert.equal(alignmentBase(440, 8), 432);
});

// The shape the fixture actually produces -- a positive rect with a negative
// fractional pos -- and the one where floor and trunc give different answers.
// Asserting only Number.isInteger here would pass for either.
test('alignmentBase takes the floor for a negative fractional offset', () => {
	// centerprint: trunc(66 + -19.2001) === 46. A trunc-based base of 65 would
	// have produced 45, so the fixture pins which of the two readings is right.
	assert.equal(alignmentBase(46, -19.2001), 66);
	// bar_health: trunc(270 + -195.74) === 74.
	assert.equal(alignmentBase(74, -195.74), 270);
});

test('alignmentBase round-trips through the engine truncation it inverts', () => {
	const engine = (base, pos) => Math.trunc(base + pos);
	for (const pos of [0.26675, -0.4, -19.2001, 12.6, -195.74, 7.5]) {
		for (const rect of [3, 46, 74, 195, 311]) {
			assert.equal(engine(alignmentBase(rect, pos), pos), rect,
				`base for rect=${rect} pos=${pos} does not reproduce that rect`);
		}
	}
});

test('alignmentBase follows truncation toward zero off the left edge', () => {
	// trunc(0 + -4.9) === -4, so the base behind rect -4 was 0, not -1.
	assert.equal(alignmentBase(-4, -4.9), 0);
	// and trunc(-5 + 0.9) === -4, so it was -5 here -- rounding the other way
	// would name a base the engine could not have used.
	assert.equal(alignmentBase(-4, 0.9), -5);
});

test('alignmentBase treats a missing or unusable value as no offset', () => {
	assert.equal(alignmentBase(120, undefined), 120);
	assert.equal(alignmentBase(120, 'not a number'), 120);
	assert.equal(alignmentBase(undefined, 8), 0);
});

// Every base it returns must be a position the engine can store, or the grid
// drawn from it promises a landing spot that does not exist.
test('alignmentBase always returns a whole console pixel', () => {
	for (const pos of [0, 0.001, 0.5, 0.999, 7.25, 213.999, -0.4, -13.7]) {
		for (const rect of [0, 3, 195, 213, -4]) {
			assert(Number.isInteger(alignmentBase(rect, pos)),
				`base for rect=${rect} pos=${pos} was not whole`);
		}
	}
});
