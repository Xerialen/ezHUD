import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(here, 'fixtures', 'changedrop');
const repo = path.resolve(here, '../..');
const execFileAsync = promisify(execFile);

let capture;
let loadError;
try {
	capture = await import('../changedrop/capture.mjs');
} catch (error) {
	loadError = error;
}

const fixture = async (name) => JSON.parse(await readFile(path.join(fixtureDir, name), 'utf8'));

function schemaErrors(value, schema, at = '$') {
	const errors = [];
	const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
	const actualType = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
	const typeMatches = types.includes(actualType) || (types.includes('integer') && Number.isInteger(value));
	if (types.length && !typeMatches) return [`${at}: expected ${types.join('|')}, got ${actualType}`];
	if ('const' in schema && value !== schema.const) errors.push(`${at}: expected constant ${schema.const}`);
	if (schema.enum && !schema.enum.includes(value)) errors.push(`${at}: value is outside enum`);
	if (typeof value === 'number') {
		if (schema.exclusiveMinimum != null && value <= schema.exclusiveMinimum) errors.push(`${at}: number is too small`);
		if (schema.minimum != null && value < schema.minimum) errors.push(`${at}: number is too small`);
		if (schema.maximum != null && value > schema.maximum) errors.push(`${at}: number is too large`);
	}
	if (typeof value === 'string') {
		if (schema.minLength != null && value.length < schema.minLength) errors.push(`${at}: string is too short`);
		if (schema.pattern && !(new RegExp(schema.pattern)).test(value)) errors.push(`${at}: string misses pattern`);
	}
	if (Array.isArray(value)) {
		if (schema.minItems != null && value.length < schema.minItems) errors.push(`${at}: too few items`);
		if (schema.maxItems != null && value.length > schema.maxItems) errors.push(`${at}: too many items`);
		if (schema.items) value.forEach((entry, index) => errors.push(...schemaErrors(entry, schema.items, `${at}[${index}]`)));
	}
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		for (const required of schema.required ?? []) {
			if (!(required in value)) errors.push(`${at}: missing ${required}`);
		}
		for (const [key, entry] of Object.entries(value)) {
			if (schema.properties?.[key]) errors.push(...schemaErrors(entry, schema.properties[key], `${at}.${key}`));
			else if (schema.additionalProperties === false) errors.push(`${at}: unexpected ${key}`);
		}
	}
	return errors;
}

function stringsIn(value) {
	if (typeof value === 'string') return [value];
	if (Array.isArray(value)) return value.flatMap(stringsIn);
	if (value && typeof value === 'object') return Object.values(value).flatMap(stringsIn);
	return [];
}

const recording = (duration_seconds = 4.1, bytes = 512, container_duration_seconds = duration_seconds + 0.92) => ({
	basename: 'walkthrough.webm',
	bytes,
	duration_seconds,
	container_duration_seconds,
});

test('review blocker: capture receipts measured content and finalized container durations separately', async (t) => {
	assert.ifError(loadError);
	const directory = await mkdtemp(path.join(tmpdir(), 'changedrop-container-duration-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	await chmod(directory, 0o700);
	const file = path.join(directory, 'walkthrough.webm');
	await writeFile(file, Buffer.from('synthetic-webm-fixture'), { mode: 0o600 });
	assert.deepEqual(await capture.recordingMetadata(file, 22.543, 23.48), {
		basename: 'walkthrough.webm',
		bytes: 22,
		duration_seconds: 22.543,
		container_duration_seconds: 23.48,
	});
	const schema = JSON.parse(await readFile(
		path.join(repo, 'tools', 'changedrop', 'schemas', 'changedrop-timings.v1.json'), 'utf8'));
	assert.ok(schema.properties.recording.required.includes('container_duration_seconds'));
	await assert.rejects(capture.recordingMetadata(file, 22.543, 22.0),
		/container duration.*content duration|container.*shorter.*content/i);
});

test('case 1: recording metadata requires a real non-empty file and positive measured duration', async (t) => {
	assert.ifError(loadError);
	assert.equal(typeof capture.recordingMetadata, 'function');
	const directory = await mkdtemp(path.join(tmpdir(), 'changedrop-c1-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	await chmod(directory, 0o700);
	const file = path.join(directory, 'walkthrough.webm');
	await writeFile(file, Buffer.from('synthetic-webm-fixture'));
	assert.deepEqual(await capture.recordingMetadata(file, 1.25, 2.17), {
		basename: 'walkthrough.webm',
		bytes: 22,
		duration_seconds: 1.25,
		container_duration_seconds: 2.17,
	});
	await writeFile(file, Buffer.alloc(0));
	await assert.rejects(capture.recordingMetadata(file, 1.25, 2.17), /recording.*non-empty|non-empty.*recording/i);
	await writeFile(file, Buffer.from('x'));
	await assert.rejects(capture.recordingMetadata(file, 0, 1), /duration.*positive|positive.*duration/i);
});

test('case 2: timings contain exactly one positive, strictly monotonic entry per script segment', async () => {
	assert.ifError(loadError);
	const script = await fixture('capture-script.json');
	const observations = await fixture('capture-observations-a.json');
	const receipt = capture.buildTimingReceipt({ script, recording: recording(), observations });
	assert.equal(receipt.schema_version, 'changedrop-timings/1');
	assert.deepEqual(receipt.segments.map((entry) => entry.id), script.segments.map((entry) => entry.id));
	assert.equal(receipt.segments.length, script.segments.length);
	assert.deepEqual(receipt.setup_actions,
		script.setup.map(({ instruction: _instruction, ...action }) => action));
	assert.deepEqual(receipt.segments[1].actions,
		script.segments[1].walkthrough.map(({ instruction: _instruction, ...action }) => action));
	for (const [index, entry] of receipt.segments.entries()) {
		assert.ok(entry.duration_seconds > 0);
		if (index) assert.ok(entry.start_seconds > receipt.segments[index - 1].start_seconds);
	}
	const duplicated = structuredClone(observations);
	duplicated[1].id = duplicated[0].id;
	assert.throws(() => capture.buildTimingReceipt({ script, recording: recording(), observations: duplicated }),
		/segment.*order|exactly one|intro.*snap-magnet/i);
	const zero = structuredClone(observations);
	zero[1].duration_seconds = 0;
	assert.throws(() => capture.buildTimingReceipt({ script, recording: recording(), observations: zero }),
		/duration.*positive|positive.*duration/i);
});

test('case 3: every highlight timestamp and focused ring receipt lies inside its segment', async () => {
	assert.ifError(loadError);
	const script = await fixture('capture-script.json');
	const observations = await fixture('capture-observations-a.json');
	const receipt = capture.buildTimingReceipt({ script, recording: recording(), observations });
	const highlighted = receipt.segments.find((entry) => entry.id === 'snap-magnet');
	assert.equal(highlighted.highlights.length, 1);
	const highlight = highlighted.highlights[0];
	assert.ok(highlight.timestamp_seconds >= highlighted.start_seconds);
	assert.ok(highlight.timestamp_seconds <= highlighted.start_seconds + highlighted.duration_seconds);
	assert.match(highlight.basename, /^stills\/[a-z0-9-]+-\d+\.png$/);
	assert.match(highlight.source_basename, /^stills\/sources\/[a-z0-9-]+-\d+\.png$/);

	const late = structuredClone(observations);
	late[1].highlights[0].timestamp_seconds = late[1].start_seconds + late[1].duration_seconds + 0.01;
	assert.throws(() => capture.buildTimingReceipt({ script, recording: recording(), observations: late }),
		/highlight.*inside|outside.*segment/i);
});

test('case 4: repeat runs compare the complete action sequence while allowing timing drift', async () => {
	assert.ifError(loadError);
	const script = await fixture('capture-script.json');
	const first = capture.buildTimingReceipt({
		script,
		recording: recording(4.1, 512),
		observations: await fixture('capture-observations-a.json'),
	});
	const second = capture.buildTimingReceipt({
		script,
		recording: recording(4.3, 530),
		observations: await fixture('capture-observations-b.json'),
	});
	assert.equal(capture.assertRepeatableStructure(first, second), true);
	assert.notDeepEqual(first.segments.map((entry) => [entry.start_seconds, entry.duration_seconds]),
		second.segments.map((entry) => [entry.start_seconds, entry.duration_seconds]));

	const changed = structuredClone(second);
	changed.segments[1].actions[0].width += 1;
	assert.throws(() => capture.assertRepeatableStructure(first, changed), /action sequence.*snap-magnet|snap-magnet.*action sequence/i);
	const outsideTolerance = structuredClone(second);
	outsideTolerance.segments[1].duration_seconds = first.segments[1].duration_seconds + 2.01;
	assert.throws(() => capture.assertRepeatableStructure(first, outsideTolerance), /duration.*snap-magnet.*tolerance/i);
});

test('supporting contract: closed safe DSL, bounded runtime, schema/privacy, npm wiring, and no browser in tier 1', async () => {
	assert.ifError(loadError);
	assert.deepEqual([...capture.ACTIONS], ['wait-for', 'resize', 'click', 'hold', 'highlight']);
	assert.equal(capture.basePathFromIndex('<script type="importmap">{"imports":{"/ezHUD/core/bridge.js":"/ezHUD/core/fte-adapter.js"}}</script>'), '/ezHUD/');
	assert.equal(capture.basePathFromIndex('<script type="importmap">{"imports":{"/core/bridge.js":"/core/fte-adapter.js"}}</script>'), '/');
	assert.equal(capture.MAX_HOLD_MS, 5_000);
	assert.equal(capture.MAX_CAPTURE_MS, 180_000);
	assert.equal(capture.REPEAT_DURATION_TOLERANCE_SECONDS, 2.0);
	const script = await fixture('capture-script.json');
	assert.equal(capture.validateCaptureScript(script), script);
	for (const forbidden of ['unknown', 'evaluate', 'run-script', 'arbitrary-js']) {
		const bad = structuredClone(script);
		bad.segments[0].walkthrough[0].action = forbidden;
		assert.throws(() => capture.validateCaptureScript(bad), new RegExp(`unknown.*${forbidden}|${forbidden}.*not allowed`, 'i'));
	}
	for (const selector of ['body #snap-toggle', '.snap-toggle', '[role="button"]', '#x:hover']) {
		const bad = structuredClone(script);
		bad.segments[1].walkthrough[1].selector = selector;
		assert.throws(() => capture.validateCaptureScript(bad), /selector.*id-style|data-changedrop|selector.*invalid/i);
	}
	const tooLong = structuredClone(script);
	tooLong.segments[0].walkthrough[0].duration_ms = capture.MAX_HOLD_MS + 1;
	assert.throws(() => capture.validateCaptureScript(tooLong), /hold.*5000|duration.*maximum/i);

	const source = await readFile(path.join(repo, 'tools', 'changedrop', 'capture.mjs'), 'utf8');
	assert.doesNotMatch(source, /\.evaluate\s*\(/);
	assert.match(source, /spawn\('ffprobe'/);
	const sourceCapture = source.indexOf('const sourceBytes = await page.screenshot');
	const liveRing = source.indexOf('await page.addStyleTag({ content: liveRingCss');
	assert.ok(sourceCapture >= 0 && liveRing >= 0 && sourceCapture < liveRing,
		'focused source must be captured before the live ring is drawn');
	assert.doesNotMatch(source, /window-follow|pause-resume|snap-magnet/);
	assert.match(source, /three minutes|180 seconds/i);
	assert.match(source, /five seconds|5000 ms/i);
	const packageJson = JSON.parse(await readFile(path.join(repo, 'package.json'), 'utf8'));
	assert.equal(packageJson.scripts?.['changedrop:capture'], 'node tools/changedrop/capture.mjs');

	const schema = JSON.parse(await readFile(
		path.join(repo, 'tools', 'changedrop', 'schemas', 'changedrop-timings.v1.json'), 'utf8'));
	assert.equal(schema.additionalProperties, false);
	assert.equal(schema.properties.segments.items.additionalProperties, false);
	const receipt = capture.buildTimingReceipt({
		script,
		recording: recording(),
		observations: await fixture('capture-observations-a.json'),
	});
	assert.deepEqual(schemaErrors(receipt, schema), []);
	for (const value of stringsIn(receipt)) {
		assert.equal(path.isAbsolute(value), false, `absolute path escaped into timings: ${JSON.stringify(value)}`);
		assert.doesNotMatch(value, /\/home\/|\/Users\/|\$USER\b|file:\/\//i);
		if (hostname()) assert.equal(value.includes(hostname()), false, 'hostname escaped into timings');
	}

	const env = { ...process.env };
	delete env.EZHUD_CHANGEDROP_ROOT;
	await assert.rejects(execFileAsync(process.execPath, [
		path.join(repo, 'tools', 'changedrop', 'capture.mjs'),
		'--script', 'synthetic/run/script.json',
		'--dist', 'dist',
		'--out', 'synthetic/run/capture',
	], { cwd: repo, env }), (error) => {
		assert.equal(error.code, 1);
		assert.match(error.stderr, /EZHUD_CHANGEDROP_ROOT/);
		return true;
	});
});
