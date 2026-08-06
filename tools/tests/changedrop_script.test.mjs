import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const INTRO = "Hey guys, it's Xeri with another changedrop.";
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

test('case 1: the exact intro appears once at the start of the first surface segment', async () => {
	assert.ifError(loadError);
	assert.equal(typeof authorChangedropScript, 'function', 'authorChangedropScript must be exported');
	const script = authorChangedropScript(await fixture('script-render.json'));
	const spoken = spokenText(script);
	assert.equal(spoken.slice(0, INTRO.length), INTRO);
	assert.equal(occurrences(spoken, INTRO), 1);
	assert.ok(script.segments[0].text.startsWith(`${INTRO} `));
});

test('case 2: the exact outro appears once at the end of the last surface segment', async () => {
	assert.ifError(loadError);
	const script = authorChangedropScript(await fixture('script-render.json'));
	const spoken = spokenText(script);
	assert.equal(spoken.slice(-OUTRO.length), OUTRO);
	assert.equal(occurrences(spoken, OUTRO), 1);
	assert.ok(script.segments.at(-1).text.endsWith(` ${OUTRO}`));
});

test('case 3: each changed surface has one budgeted segment and a keyed walkthrough', async () => {
	assert.ifError(loadError);
	assert.equal(wordsPerSecond, 2.2);
	const source = await readFile(path.join(repo, 'tools', 'changedrop', 'script.mjs'), 'utf8');
	assert.match(source, /2\.2 words\/(?:second|s)/i);
	assert.match(source, /132 (?:words\/minute|wpm)/i);
	assert.match(source, /conservative/i);

	const summary = await fixture('script-render.json');
	const script = authorChangedropScript(summary);
	assert.deepEqual(script.segments.map((segment) => segment.surface),
		summary.features.map((feature) => feature.surface));
	assert.equal(new Set(script.segments.map((segment) => segment.surface)).size, summary.features.length);
	for (const segment of script.segments) {
		assert.equal(segment.id, segment.surface);
		assert.equal(segment.estimated_duration_seconds,
			Number((wordCount(segment.text) / wordsPerSecond).toFixed(3)));
		assert.ok(segment.estimated_duration_seconds > 0);
		assert.ok(segment.estimated_duration_seconds <= 10.0,
			`${segment.surface} exceeds 10.0 seconds`);
		assert.ok(Array.isArray(segment.walkthrough) && segment.walkthrough.length > 0,
			`${segment.surface} has no walkthrough steps`);
		for (const step of segment.walkthrough) assert.ok(step.trim(), `${segment.surface} has an empty walkthrough step`);
	}
	assert.notDeepEqual(script.segments[0].walkthrough, script.segments[1].walkthrough);
});

test('case 4: authored segment prose is non-empty, unique, and is not a triple concatenation', async () => {
	assert.ifError(loadError);
	const summary = await fixture('script-render.json');
	const script = authorChangedropScript(summary);
	assert.deepEqual(script.segments.map((segment) => segment.text), [
		"Hey guys, it's Xeri with another changedrop. Resizing now keeps your game and HUD aligned.",
		"Pause keeps engine frames steady for HUD edits. Be safe, and don't walk on spawns.",
	]);
	const texts = script.segments.map((segment) => segment.text.trim());
	assert.ok(texts.every(Boolean));
	assert.equal(new Set(texts).size, texts.length);
	for (const [index, feature] of summary.features.entries()) {
		assert.doesNotMatch(script.segments[index].text, new RegExp([
			feature.before, feature.after, feature.value,
		].map((text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')));
	}
	const duplicateSurface = structuredClone(summary);
	duplicateSurface.features[1].surface = duplicateSurface.features[0].surface;
	assert.throws(() => authorChangedropScript(duplicateSurface), /duplicate.*window-follow|window-follow.*duplicate/i);
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

test('supporting contract: schema, privacy, private CLI output, input validation, and npm wiring', async (t) => {
	assert.ifError(loadError);
	const schema = JSON.parse(await readFile(
		path.join(repo, 'tools', 'changedrop', 'schemas', 'changedrop-script.v1.json'), 'utf8'));
	assert.equal(schema.additionalProperties, false);
	assert.equal(schema.properties.segments.items.additionalProperties, false);
	assert.deepEqual(schema.properties.segments.items.required,
		['id', 'surface', 'text', 'estimated_duration_seconds', 'walkthrough']);
	const summary = await fixture('script-render.json');
	const script = authorChangedropScript(summary);
	assert.deepEqual(schemaErrors(script, schema), []);
	for (const value of stringsIn(script)) {
		assert.equal(path.isAbsolute(value), false, `absolute path escaped into output: ${JSON.stringify(value)}`);
		assert.doesNotMatch(value, /\/home\/|\/Users\/|\$USER\b|file:\/\//i);
		if (hostname()) assert.equal(value.includes(hostname()), false, 'hostname escaped into output');
	}

	for (const privateValue of ['/home/example/private', '/Users/example/private', '/var/private',
		'C:\\private\\file', '\\\\server\\share', '$USER', 'file:///private', hostname()].filter(Boolean)) {
		const unsafe = structuredClone(summary);
		unsafe.features[0].value = privateValue;
		assert.throws(() => authorChangedropScript(unsafe), /private location/i);
	}
	assert.throws(
		() => authorChangedropScript({ ...summary, unexpected: true }),
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
			'--out', 'synthetic/run/script.json',
		], { cwd: repo, env }),
		(error) => {
			assert.equal(error.code, 1);
			assert.match(error.stderr, /EZHUD_CHANGEDROP_ROOT/);
			return true;
		},
	);
});
