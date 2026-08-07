// tools/fidelity/selftest.mjs — prove the run catches a divergence it is shown.
//
// The whole value of this gate is the claim "if the preview stops matching the
// game, this run says so". That claim needs its own evidence, and it cannot
// come from a run where the two sides happened to agree — a comparator that
// returns "match" unconditionally passes that test too.
//
// So: two fake engines off the same fixture (clean — must report nothing), then
// the same pair with one divergence introduced into the preview through the
// real /cmd path (must report exactly that divergence and no other). No engine,
// no browser, no GPU; this tests the machinery, never the engines.

import assert from 'node:assert/strict';
import process from 'node:process';

import { startFakeEngine } from '../qa/fake_engine.mjs';
import { Bridge, measure, baselineOf, baselineDrift } from './measure.mjs';

const DATE = '1970-01-01';   // fixed: the selftest asserts on output bytes

async function pair() {
	const reference = await startFakeEngine({ token: 'fid-ref' });
	const preview = await startFakeEngine({ token: 'fid-prev' });
	return {
		reference, preview,
		bridges: {
			reference: new Bridge(reference.origin, reference.token, 'reference'),
			preview: new Bridge(preview.origin, preview.token, 'preview'),
		},
		close: async () => { await reference.close(); await preview.close(); },
	};
}

const run = (bridges) => measure({ ...bridges, freeze: ['demo_setspeed 0'], date: DATE, claims: [] });

let failures = 0;
const check = async (name, body) => {
	try {
		await body();
		console.log(`ok   ${name}`);
	} catch (error) {
		failures++;
		console.error(`FAIL ${name}\n     ${error.message}`);
	}
};

// 1. Clean: identical engines must produce no divergence at all. If this fails,
//    every "caught it" result below is meaningless.
const clean = await pair();
let cleanMeasurement;
await check('two identical engines diverge on nothing', async () => {
	cleanMeasurement = await run(clean.bridges);
	assert.equal(cleanMeasurement.result.comparable, true);
	assert.equal(cleanMeasurement.result.counts.diverging, 0,
		`expected no divergences, got: ${JSON.stringify(cleanMeasurement.result.measured.filter((r) => r.verdict === 'diverges'))}`);
	assert.ok(cleanMeasurement.result.counts.elements > 10, 'the fixture should carry a real element set');
});

await check('the clean run is deterministic and says so in the report', async () => {
	assert.equal(cleanMeasurement.deterministic, true);
	assert.match(cleanMeasurement.markdown, /repeated verdicts identical \| yes/);
});

await check('a second clean run reproduces the first verdict for verdict', async () => {
	const again = await run(clean.bridges);
	assert.deepEqual(baselineOf(again).measured, baselineOf(cleanMeasurement).measured);
});

const cleanBaseline = baselineOf(cleanMeasurement);
await clean.close();

// 2. Planted position divergence, introduced through /cmd rather than by
//    editing a snapshot — so the path under test is the one a real drift takes.
const moved = await pair();
await check('a planted position divergence is caught, and named', async () => {
	await moved.bridges.preview.cmd('set hud_teaminfo_pos_x 300');
	const measurement = await run(moved.bridges);
	const diverging = measurement.result.measured.filter((r) => r.verdict === 'diverges');
	assert.equal(diverging.length, 1, `expected exactly one divergence, got ${JSON.stringify(diverging)}`);
	assert.equal(diverging[0].element, 'teaminfo');
	assert.equal(diverging[0].dimension, 'position');
	assert.equal(diverging[0].code, 'position-differs');
	assert.notEqual(diverging[0].delta.x, 0);
});

await check('the planted divergence shows up as drift against the clean baseline', async () => {
	const measurement = await run(moved.bridges);
	const drift = baselineDrift(baselineOf(measurement), cleanBaseline);
	assert.equal(drift.length, 1, `expected one drifted row, got ${JSON.stringify(drift)}`);
	assert.equal(drift[0].row, 'teaminfo/position');
});

await check('the planted divergence reaches the rendered table', async () => {
	const measurement = await run(moved.bridges);
	const row = measurement.markdown.split('\n').find((l) => l.startsWith('| teaminfo |'));
	assert.ok(row, 'teaminfo has no row in the generated table');
	assert.match(row, /✗/);
});
await moved.close();

// 3. Planted presence divergence — a different failure mode with a different
//    code, because "the preview stopped drawing it" and "it moved" must not
//    collapse into one verdict.
const hidden = await pair();
await check('an element the preview stops drawing is caught as a presence divergence', async () => {
	await hidden.bridges.preview.cmd('set hud_health_show 0');
	const measurement = await run(hidden.bridges);
	const presence = measurement.result.measured.find(
		(r) => r.element === 'health' && r.dimension === 'presence');
	assert.equal(presence.verdict, 'diverges');
	assert.equal(presence.code, 'preview-not-drawn');
	for (const dimension of ['position', 'size']) {
		const row = measurement.result.measured.find((r) => r.element === 'health' && r.dimension === dimension);
		assert.equal(row.verdict, 'not-assessable',
			'geometry must not be judged for an element only one side draws');
	}
});

await check('a claim about a no-longer-drawn element goes stale instead of passing quietly', async () => {
	const measurement = await measure({
		...hidden.bridges, freeze: ['demo_setspeed 0'], date: DATE,
		claims: [{ element: 'health', dimension: 'colour', claim: 'x', source: 'selftest', observed: DATE }],
	});
	assert.equal(measurement.carried[0].verdict, 'stale');
});
await hidden.close();

console.log(failures
	? `\nFIDELITY SELFTEST FAILED: ${failures} check(s).`
	: '\nFidelity selftest: clean run is clean, planted divergences are caught. Machinery is sound.');
process.exit(failures ? 1 : 0);
