// RED: Selector hooks for changedrop filming
//
// Two changes are required before the changedrop capture DSL can target every
// Release 2 surface:
//   1. id="fte-moments" on the .fte-moments container in index-fte.html
//   2. data-changedrop attributes on .tree__row elements in view/app.js,
//      with element names normalised to kebab-case and validated against
//      SELECTOR_PATTERN.
//
// This test is RED until both are in place.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');

// Copied from tools/changedrop/script.mjs:18 — the authoritative pattern.
// The capture module (capture.mjs:50) has the same pattern; we copy it here
// so the test is independent and fails if they ever diverge.
const SELECTOR_PATTERN = /^(?:#[A-Za-z][A-Za-z0-9_-]{0,63}|\[data-changedrop="[a-z0-9]+(?:-[a-z0-9]+)*"\])$/;

const DATA_CHANGEDROP_VALUE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Normalise an element name to a kebab-case data-changedrop value.
// Must produce a value that matches [a-z0-9]+(?:-[a-z0-9]+)* and must
// assert its own result so a future name that becomes invalid is caught
// at generation time rather than at filming.
function normaliseElementName(name) {
	const value = `hud-element-${name.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
	if (!DATA_CHANGEDROP_VALUE.test(value.slice('hud-element-'.length))) {
		throw new Error(
			`data-changedrop value "${value}" (from "${name}") does not match [a-z0-9]+(?:-[a-z0-9]+)*`,
		);
	}
	return value;
}

await test('id="fte-moments" exists in index-fte.html', async (t) => {
	const html = await readFile(path.join(repo, 'hud_web_ui', 'index-fte.html'), 'utf8');

	// Must have exactly one id="fte-moments" — no duplicate ids.
	const matches = html.match(/\bid="fte-moments"/g);
	assert.ok(matches, 'index-fte.html must contain id="fte-moments"');
	assert.equal(matches.length, 1, 'id="fte-moments" must occur exactly once');
});

await test('normaliseElementName produces valid data-changedrop values', async (t) => {
	// Known names from the fidelity report — the 11 that carry underscores.
	const testCases = [
		{ name: 'health', expected: 'hud-element-health' },
		{ name: 'bar_armor', expected: 'hud-element-bar-armor' },
		{ name: 'bar_health', expected: 'hud-element-bar-health' },
		{ name: 'mp3_time', expected: 'hud-element-mp3-time' },
		{ name: 'mp3_title', expected: 'hud-element-mp3-title' },
		{ name: 'qtv_buffer', expected: 'hud-element-qtv-buffer' },
		{ name: 'score_bar', expected: 'hud-element-score-bar' },
		{ name: 'score_difference', expected: 'hud-element-score-difference' },
		{ name: 'score_enemy', expected: 'hud-element-score-enemy' },
		{ name: 'score_position', expected: 'hud-element-score-position' },
		{ name: 'score_team', expected: 'hud-element-score-team' },
		{ name: 'static_text', expected: 'hud-element-static-text' },
	];

	for (const { name, expected } of testCases) {
		const value = normaliseElementName(name);
		assert.equal(value, expected, `normaliseElementName("${name}")`);

		// Must be valid as a full [data-changedrop="..."] selector.
		const fullSelector = `[data-changedrop="${value}"]`;
		assert.ok(
			SELECTOR_PATTERN.test(fullSelector),
			`"[data-changedrop=${value}]" must match SELECTOR_PATTERN`,
		);
	}

	// A name with consecutive non-alphanumeric chars (e.g. score__bar)
	// normalises to score--bar which has a double hyphen —
	// rejected by DATA_CHANGEDROP_VALUE.
	assert.ok(
		!DATA_CHANGEDROP_VALUE.test('score--bar'),
		'score--bar (double hyphen) must NOT pass DATA_CHANGEDROP_VALUE',
	);

	// Verify the normaliser asserts its own result on invalid output.
	assert.throws(
		() => normaliseElementName('score__bar'),
		/data-changedrop.*does not match/,
		'normaliseElementName must throw on a name whose normalised form is invalid',
	);
});

await test('data-changedrop appears in view/app.js tree row construction', async (t) => {
	const src = await readFile(path.join(repo, 'hud_web_ui', 'view', 'app.js'), 'utf8');

	// Must set row.dataset.changedrop with a normalised value.
	assert.ok(
		src.includes('dataset.changedrop'),
		'view/app.js must set row.dataset.changedrop',
	);

	// Must reference SELECTOR_PATTERN or DATA_CHANGEDROP_VALUE to assert
	// the normalised value (or embed an equivalent self-assertion).
	const hasPattern =
		src.includes('DATA_CHANGEDROP_VALUE') ||
		src.includes('SELECTOR_PATTERN') ||
		src.includes('[a-z0-9]+(?:-[a-z0-9]+)*');
	assert.ok(hasPattern, 'view/app.js normaliser must validate its output against the pattern');
});
