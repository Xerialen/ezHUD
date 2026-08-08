import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const INTRO = "Hey guys, it's Xerial. Here's what's new in ezHUD.";
const OUTRO = "Be safe, and don't walk on spawns.";
const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(here, 'fixtures', 'changedrop');
const repo = path.resolve(here, '../..');
const execFileAsync = promisify(execFile);

let authorChangedropScript;
let wordsPerSecond;
let loadError;
try {
	({ authorChangedropScript, WORDS_PER_SECOND: wordsPerSecond } = await import('../changedrop/script.mjs'));
} catch (error) {
	loadError = error;
}

const fixture = async (name) => JSON.parse(await readFile(path.join(fixtureDir, name), 'utf8'));
const occurrences = (text, needle) => text.split(needle).length - 1;
const spokenText = (script) => script.segments.map((segment) => segment.text).join(' ');
const wordCount = (text) => text.trim().split(/\s+/u).filter(Boolean).length;

async function renderFixture() {
	return {
		summary: await fixture('script-render.json'),
		authoring: await fixture('script-authoring.json'),
	};
}

function schemaErrors(value, schema, at = '$') {
	const errors = [];
	const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
	const actualType = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
	if (types.length && !types.includes(actualType)) return [`${at}: expected ${types.join('|')}, got ${actualType}`];
	if ('const' in schema && value !== schema.const) errors.push(`${at}: expected constant ${schema.const}`);
	if (schema.enum && !schema.enum.includes(value)) errors.push(`${at}: value is outside enum`);
	if (typeof value === 'number') {
		if (schema.exclusiveMinimum != null && value <= schema.exclusiveMinimum) errors.push(`${at}: number is too small`);
		if (schema.maximum != null && value > schema.maximum) errors.push(`${at}: number is too large`);
	}
	if (typeof value === 'string') {
		if (schema.minLength != null && value.length < schema.minLength) errors.push(`${at}: string is too short`);
		if (schema.pattern && !(new RegExp(schema.pattern)).test(value)) errors.push(`${at}: string misses pattern`);
	}
	if (Array.isArray(value)) {
		if (schema.minItems != null && value.length < schema.minItems) errors.push(`${at}: too few items`);
		if (schema.maxItems != null && value.length > schema.maxItems) errors.push(`${at}: too many items`);
		if (schema.uniqueItems && new Set(value.map((entry) => JSON.stringify(entry))).size !== value.length) {
			errors.push(`${at}: duplicate items`);
		}
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

async function privateRoot(t) {
	const root = await mkdtemp(path.join(tmpdir(), 'changedrop-script-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	await chmod(root, 0o700);
	await mkdir(path.join(root, 'synthetic', 'run'), { recursive: true, mode: 0o700 });
	await chmod(path.join(root, 'synthetic'), 0o700);
	await chmod(path.join(root, 'synthetic', 'run'), 0o700);
	return root;
}

test('case 1: the exact intro is a standalone segment once and first', async () => {
	assert.ifError(loadError);
	assert.equal(typeof authorChangedropScript, 'function', 'authorChangedropScript must be exported');
	const { summary, authoring } = await renderFixture();
	const script = authorChangedropScript(summary, authoring, { authoringPath: 'docs/release-1/changedrop-script.json' });
	assert.deepEqual(script.segments[0], {
		id: 'intro',
		kind: 'bookend',
		surface: null,
		text: INTRO,
		estimated_duration_seconds: Number((wordCount(INTRO) / wordsPerSecond).toFixed(3)),
		walkthrough: authoring.bookends.intro_walkthrough,
	});
	assert.equal(occurrences(spokenText(script), INTRO), 1);
});

test('case 2: the exact outro is a standalone segment once and last', async () => {
	assert.ifError(loadError);
	const { summary, authoring } = await renderFixture();
	const script = authorChangedropScript(summary, authoring, { authoringPath: 'docs/release-1/changedrop-script.json' });
	assert.deepEqual(script.segments.at(-1), {
		id: 'outro',
		kind: 'bookend',
		surface: null,
		text: OUTRO,
		estimated_duration_seconds: Number((wordCount(OUTRO) / wordsPerSecond).toFixed(3)),
		walkthrough: authoring.bookends.outro_walkthrough,
	});
	assert.equal(occurrences(spokenText(script), OUTRO), 1);
});

test('case 3: each changed surface has one budgeted segment and a keyed walkthrough', async () => {
	assert.ifError(loadError);
	assert.equal(wordsPerSecond, 2.2);
	const source = await readFile(path.join(repo, 'tools', 'changedrop', 'script.mjs'), 'utf8');
	assert.match(source, /2\.2 words\/(?:second|s)/i);
	assert.match(source, /132 (?:words\/minute|wpm)/i);
	assert.match(source, /conservative/i);
	const spec = await readFile(path.join(repo, 'docs', 'specs', '2026-08-06-changelog-video-pipeline.md'), 'utf8');
	assert.match(spec, /standalone bookend segments/i);
	assert.match(spec, /not charged to|outside.*per-surface|separate from.*per-surface/i);

	const { summary, authoring } = await renderFixture();
	const script = authorChangedropScript(summary, authoring, { authoringPath: 'docs/release-1/changedrop-script.json' });
	assert.deepEqual(script.setup, authoring.setup);
	const surfaces = script.segments.filter((segment) => segment.kind === 'surface');
	assert.deepEqual(surfaces.map((segment) => segment.surface), summary.features.map((feature) => feature.surface));
	assert.equal(surfaces.length, summary.features.length);
	assert.equal(new Set(surfaces.map((segment) => segment.surface)).size, summary.features.length);
	for (const segment of script.segments) {
		assert.equal(segment.estimated_duration_seconds,
			Number((wordCount(segment.text) / wordsPerSecond).toFixed(3)));
		assert.ok(segment.estimated_duration_seconds > 0);
		assert.ok(Array.isArray(segment.walkthrough) && segment.walkthrough.length > 0,
			`${segment.id} has no walkthrough steps`);
		for (const step of segment.walkthrough) {
			assert.ok(step.instruction.trim(), `${segment.id} has an empty walkthrough instruction`);
			assert.match(step.action, /^(?:wait-for|resize|click|hold|highlight)$/);
		}
		const padding = segment.walkthrough.filter((step) => step.fit === 'narration');
		assert.ok(padding.length >= 1, `${segment.id} has no narration padding`);
		assert.ok(padding.every((step) => step.action === 'hold'));
	}
	for (const segment of surfaces) {
		assert.equal(segment.id, segment.surface);
		assert.ok(segment.estimated_duration_seconds <= 10.0, `${segment.surface} exceeds 10.0 seconds`);
	}
});

test('case 4: authored prose is non-empty, unique, source-bound, and not a triple concatenation', async () => {
	assert.ifError(loadError);
	const { summary, authoring } = await renderFixture();
	const authoringPath = 'docs/release-1/changedrop-script.json';
	const script = authorChangedropScript(summary, authoring, { authoringPath });
	assert.deepEqual(script.segments.map((segment) => segment.text), [
		INTRO,
		'Resizing the browser now keeps your game view and HUD controls aligned.',
		'Pause now holds frames steady, so you can edit the HUD without losing your moment.',
		OUTRO,
	]);
	const texts = script.segments.map((segment) => segment.text.trim());
	assert.ok(texts.every(Boolean));
	assert.equal(new Set(texts).size, texts.length);
	const surfaces = script.segments.filter((segment) => segment.kind === 'surface');
	for (const [index, feature] of summary.features.entries()) {
		assert.doesNotMatch(surfaces[index].text, new RegExp([
			feature.before, feature.after, feature.value,
		].map((text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')));
	}
	const drifted = structuredClone(summary);
	drifted.features[0].before += ' Changed.';
	assert.throws(
		() => authorChangedropScript(drifted, authoring, { authoringPath }),
		/error.*window-follow.*before|window-follow.*before.*changedrop-script\.json/i,
	);
	const duplicateSurface = structuredClone(summary);
	duplicateSurface.features[1].surface = duplicateSurface.features[0].surface;
	assert.throws(
		() => authorChangedropScript(duplicateSurface, authoring, { authoringPath }),
		/duplicate.*window-follow|window-follow.*duplicate/i,
	);
});

test('case 5: a skip summary returns null and the command leaves no script file', async (t) => {
	assert.ifError(loadError);
	const summary = await fixture('script-skip.json');
	assert.equal(authorChangedropScript(summary), null);

	const root = await privateRoot(t);
	const summaryPath = path.join(root, 'synthetic', 'run', 'value-summary.json');
	const outputPath = path.join(root, 'synthetic', 'run', 'script.json');
	await writeFile(summaryPath, `${JSON.stringify(summary)}\n`, { mode: 0o600 });
	await writeFile(outputPath, '{"stale":true}\n', { mode: 0o600 });
	const { stdout, stderr } = await execFileAsync(process.execPath, [
		path.join(repo, 'tools', 'changedrop', 'script.mjs'),
		'--summary', 'synthetic/run/value-summary.json',
		'--out', 'synthetic/run/script.json',
	], { cwd: repo, env: { ...process.env, EZHUD_CHANGEDROP_ROOT: root } });
	assert.equal(stderr, '');
	assert.equal(stdout, 'changedrop script: skipped\n');
	assert.equal(stdout.includes(root), false);
	await assert.rejects(access(outputPath), (error) => error?.code === 'ENOENT');
});

test('reuse contract: a wholly synthetic surface is authored by data, never tool code', async () => {
	assert.ifError(loadError);
	const summary = await fixture('script-generic-summary.json');
	const authoring = await fixture('script-generic-authoring.json');
	const authoringPath = 'docs/release-2/changedrop-script.json';
	const script = authorChangedropScript(summary, authoring, { authoringPath });
	assert.deepEqual(script.setup, authoring.setup);
	assert.deepEqual(script.segments.map(({ id, kind, surface }) => ({ id, kind, surface })), [
		{ id: 'intro', kind: 'bookend', surface: null },
		{ id: 'snap-magnet', kind: 'surface', surface: 'snap-magnet' },
		{ id: 'outro', kind: 'bookend', surface: null },
	]);
	assert.equal(script.segments[1].text, authoring.treatments[0].text);
	assert.deepEqual(script.segments[1].walkthrough, authoring.treatments[0].walkthrough);
	const toolSource = await readFile(path.join(repo, 'tools', 'changedrop', 'script.mjs'), 'utf8');
	assert.doesNotMatch(toolSource, /window-follow|pause-resume|snap-magnet/);

	const missing = structuredClone(authoring);
	missing.treatments = [];
	assert.throws(
		() => authorChangedropScript(summary, missing, { authoringPath }),
		(error) => {
			assert.match(error.message, /snap-magnet/);
			assert.match(error.message, /docs\/release-2\/changedrop-script\.json/);
			return true;
		},
	);
});

test('supporting contract: schemas, privacy, private CLI output, input validation, and npm wiring', async (t) => {
	assert.ifError(loadError);
	const schema = JSON.parse(await readFile(
		path.join(repo, 'tools', 'changedrop', 'schemas', 'changedrop-script.v1.json'), 'utf8'));
	const authoringSchema = JSON.parse(await readFile(
		path.join(repo, 'tools', 'changedrop', 'schemas', 'changedrop-script-authoring.v1.json'), 'utf8'));
	assert.equal(schema.additionalProperties, false);
	assert.deepEqual(schema.required, ['schema_version', 'setup', 'segments']);
	assert.equal(schema.properties.segments.items.additionalProperties, false);
	assert.deepEqual(schema.properties.segments.items.required,
		['id', 'kind', 'surface', 'text', 'estimated_duration_seconds', 'walkthrough']);
	assert.equal(authoringSchema.additionalProperties, false);
	assert.deepEqual(authoringSchema.required, ['schema_version', 'setup', 'bookends', 'treatments']);
	assert.equal(authoringSchema.properties.treatments.items.additionalProperties, false);
	assert.equal(authoringSchema.properties.treatments.items.properties.source.additionalProperties, false);
	const authoredActions = authoringSchema.$defs.step.oneOf.map((branch) => branch.properties.action.const);
	const emittedActions = schema.$defs.step.oneOf.map((branch) => branch.properties.action.const);
	assert.deepEqual(authoredActions, ['wait-for', 'resize', 'click', 'hold', 'highlight']);
	assert.deepEqual(emittedActions, authoredActions);
	assert.ok(authoringSchema.$defs.step.oneOf.every((branch) => branch.additionalProperties === false));
	assert.ok(schema.$defs.step.oneOf.every((branch) => branch.additionalProperties === false));
	assert.equal(authoringSchema.properties.bookends.properties.intro_walkthrough.$ref, '#/$defs/fitWalkthrough');
	assert.equal(authoringSchema.properties.treatments.items.properties.walkthrough.$ref, '#/$defs/fitWalkthrough');
	assert.equal(schema.properties.segments.items.properties.walkthrough.$ref, '#/$defs/fitWalkthrough');
	const authoredHold = authoringSchema.$defs.step.oneOf.find((branch) => branch.properties.action.const === 'hold');
	const emittedHold = schema.$defs.step.oneOf.find((branch) => branch.properties.action.const === 'hold');
	assert.equal(authoredHold.properties.fit.const, 'narration');
	assert.equal(emittedHold.properties.fit.const, 'narration');

	const { summary, authoring } = await renderFixture();
	const script = authorChangedropScript(summary, authoring, {
		authoringPath: 'tools/tests/fixtures/changedrop/script-authoring.json',
	});
	assert.deepEqual(schemaErrors(script, schema), []);
	assert.deepEqual(schemaErrors(authoring, authoringSchema), []);
	for (const value of stringsIn(script)) {
		assert.equal(path.isAbsolute(value), false, `absolute path escaped into output: ${JSON.stringify(value)}`);
		assert.doesNotMatch(value, /\/home\/|\/Users\/|\$USER\b|file:\/\//i);
		if (hostname()) assert.equal(value.includes(hostname()), false, 'hostname escaped into output');
	}
	for (const privateValue of ['/home/example/private', '/Users/example/private', '/var/private',
		'C:\\private\\file', '\\\\server\\share', '$USER', 'file:///private', hostname()].filter(Boolean)) {
		const unsafe = structuredClone(authoring);
		unsafe.treatments[0].text = privateValue;
		assert.throws(
			() => authorChangedropScript(summary, unsafe, { authoringPath: 'docs/release-1/changedrop-script.json' }),
			/private location/i,
		);
	}
	assert.throws(
		() => authorChangedropScript({ ...summary, unexpected: true }, authoring),
		/unexpected.*unexpected|unexpected.*field/i,
	);

	const packageJson = JSON.parse(await readFile(path.join(repo, 'package.json'), 'utf8'));
	assert.equal(packageJson.scripts?.['changedrop:script'], 'node tools/changedrop/script.mjs');
	const root = await privateRoot(t);
	await writeFile(path.join(root, 'synthetic', 'run', 'value-summary.json'),
		`${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
	const { stdout, stderr } = await execFileAsync(process.execPath, [
		path.join(repo, 'tools', 'changedrop', 'script.mjs'),
		'--summary', 'synthetic/run/value-summary.json',
		'--authoring', 'tools/tests/fixtures/changedrop/script-authoring.json',
		'--out', 'synthetic/run/script.json',
	], { cwd: repo, env: { ...process.env, EZHUD_CHANGEDROP_ROOT: root } });
	assert.equal(stderr, '');
	assert.equal(stdout.includes(root), false, 'command disclosed its data root');
	assert.deepEqual(JSON.parse(stdout), script);
	const writtenPath = path.join(root, 'synthetic', 'run', 'script.json');
	assert.deepEqual(JSON.parse(await readFile(writtenPath, 'utf8')), script);
	assert.equal((await stat(writtenPath)).mode & 0o777, 0o600);
	assert.equal((await stat(path.dirname(writtenPath))).mode & 0o777, 0o700);

	const env = { ...process.env };
	delete env.EZHUD_CHANGEDROP_ROOT;
	await assert.rejects(
		execFileAsync(process.execPath, [
			path.join(repo, 'tools', 'changedrop', 'script.mjs'),
			'--summary', 'synthetic/run/value-summary.json',
			'--authoring', 'tools/tests/fixtures/changedrop/script-authoring.json',
			'--out', 'synthetic/run/script.json',
		], { cwd: repo, env }),
		(error) => {
			assert.equal(error.code, 1);
			assert.match(error.stderr, /EZHUD_CHANGEDROP_ROOT/);
			return true;
		},
	);
});
