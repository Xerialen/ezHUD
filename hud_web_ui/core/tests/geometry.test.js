import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
	consoleToFrame, displayDeltaToConsole, elementAt, quantize, scaleFactors,
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
