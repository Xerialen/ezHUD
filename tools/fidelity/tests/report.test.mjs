// tools/fidelity/tests/report.test.mjs — tier 1. The report is generated.
//
// These cases exist because the failure mode this ticket is about is a report
// that *looks* measured and is not: PARITY.md is a hand-written table, and it
// cannot tell you whether anything changed since 1 August. So the rules under
// test are "every row came from the measurement" and "the reader is told what
// the numbers are scoped to".

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compareStates, carryClaims } from '../compare.mjs';
import { renderReport } from '../report.mjs';

const el = (name, rect) => ({ name, shown: rect !== null, rect, cvars: {} });
const state = (elements, size = 640) => ({
	protocol: 1,
	engine: 'test-engine',
	screen: { vid_width: size, vid_height: 480 },
	elements,
});

const PROVENANCE = {
	'ezHUD commit': 'abc1234',
	'ezQuake build': '3.7.0-dev 8187~464b250c3',
	'FTE wasm sha256': 'deadbeef',
	config: 'owner.cfg (sha256 cafe1234)',
	demo: 'tb4gf_book_vs_s.mvd (sha256 f00d5678)',
	'freeze point': 'demo_jump 9:00, demo_setspeed 0',
	'console size': '640x480',
};

const render = (result, carried = []) =>
	renderReport({ result, carried, provenance: PROVENANCE, date: '2026-08-07' });

test('every element in the measurement appears in the table, and none other', () => {
	const names = ['armor', 'health', 'teaminfo'];
	const result = compareStates({
		reference: state(names.map((n) => el(n, { x: 1, y: 2, w: 3, h: 4 }))),
		preview: state(names.map((n) => el(n, { x: 1, y: 2, w: 3, h: 4 }))),
	});
	const markdown = render(result);
	for (const name of names) {
		assert.equal(markdown.split('\n').filter((l) => l.startsWith(`| ${name} |`)).length, 1);
	}
	const bodyRows = markdown.split('\n').filter((l) => /^\| \w+ \| [✓✗—·]/.test(l));
	assert.equal(bodyRows.length, names.length);
});

test('a divergence is visible in the table with its delta, not buried', () => {
	const result = compareStates({
		reference: state([el('teaminfo', { x: 10, y: 20, w: 156, h: 56 })]),
		preview: state([el('teaminfo', { x: 483, y: 308, w: 156, h: 56 })]),
	});
	const row = render(result).split('\n').find((l) => l.startsWith('| teaminfo |'));
	assert.match(row, /✗/);
	assert.match(row, /x\+473 y\+288/);
});

test('a matching row leaves the delta column empty, so divergences are the only numbers on the page', () => {
	const result = compareStates({
		reference: state([el('health', { x: 1, y: 2, w: 3, h: 4 })]),
		preview: state([el('health', { x: 1, y: 2, w: 3, h: 4 })]),
	});
	const row = render(result).split('\n').find((l) => l.startsWith('| health |'));
	assert.equal(/[xywh][+-]\d/.test(row), false, `expected no delta on a matching row, got: ${row}`);
});

test('a size divergence still prints its delta even when the position matched', () => {
	const result = compareStates({
		reference: state([el('health', { x: 1, y: 2, w: 3, h: 4 })]),
		preview: state([el('health', { x: 1, y: 2, w: 9, h: 4 })]),
	});
	const row = render(result).split('\n').find((l) => l.startsWith('| health |'));
	assert.match(row, /w\+6 h\+0/);
});

test('the headline counts match the measurement', () => {
	const result = compareStates({
		reference: state([el('a', { x: 0, y: 0, w: 1, h: 1 }), el('b', { x: 0, y: 0, w: 1, h: 1 })]),
		preview: state([el('a', { x: 0, y: 0, w: 1, h: 1 }), el('b', { x: 9, y: 0, w: 1, h: 1 })]),
	});
	assert.match(render(result), new RegExp(`\\*\\*${result.counts.diverging} diverging\\*\\*`));
});

test('every provenance input reaches the report', () => {
	const result = compareStates({ reference: state([]), preview: state([]) });
	const markdown = render(result);
	for (const [key, value] of Object.entries(PROVENANCE)) {
		assert.ok(markdown.includes(key), `provenance key missing: ${key}`);
		assert.ok(markdown.includes(value), `provenance value missing: ${value}`);
	}
});

test('the report refuses to generalize beyond its inputs, in words', () => {
	const markdown = render(compareStates({ reference: state([]), preview: state([]) }));
	assert.match(markdown, /says nothing about any other config/i);
	assert.match(markdown, /has not\s*\n?been shown not to exist/i);
	assert.match(markdown, /`texture` and `colour` are not measured/i);
});

test('the report states that it cannot prove the two engines share a demo frame', () => {
	const markdown = render(compareStates({ reference: state([]), preview: state([]) }));
	assert.match(markdown, /cannot prove the two engines sit on the same demo frame/i);
	assert.match(markdown, /as a question, not a verdict/i);
});

test('an incomparable pair prints no element table at all', () => {
	const result = compareStates({
		reference: state([el('health', { x: 1, y: 1, w: 1, h: 1 })], 640),
		preview: state([el('health', { x: 1, y: 1, w: 1, h: 1 })], 320),
	});
	const markdown = render(result);
	assert.match(markdown, /Not comparable/);
	assert.equal(markdown.split('\n').some((l) => l.startsWith('| health |')), false);
});

test('carried claims render with their source and observation date', () => {
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
	const markdown = render(result, carried);
	assert.match(markdown, /\| armor \| colour \| asserted \|.*PARITY\.md \| 2026-08-01 \|/);
});

test('rendering is pure — same inputs, byte-identical output', () => {
	const result = compareStates({
		reference: state([el('health', { x: 1, y: 2, w: 3, h: 4 })]),
		preview: state([el('health', { x: 5, y: 2, w: 3, h: 4 })]),
	});
	assert.equal(render(result), render(result));
});
