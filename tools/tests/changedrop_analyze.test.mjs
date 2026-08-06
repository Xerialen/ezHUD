import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(here, 'fixtures', 'changedrop');
const repo = path.resolve(here, '../..');
const execFileAsync = promisify(execFile);

let analyzeRelease;
let loadError;
try {
	({ analyzeRelease } = await import('../changedrop/analyze.mjs'));
} catch (error) {
	loadError = error;
}

const fixture = (name) => readFile(path.join(fixtureDir, name), 'utf8');

function schemaErrors(value, schema, at = '$') {
	const errors = [];
	const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
	const actualType = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
	if (types.length && !types.includes(actualType)) return [`${at}: expected ${types.join('|')}, got ${actualType}`];
	if ('const' in schema && value !== schema.const) errors.push(`${at}: expected constant ${schema.const}`);
	if (schema.enum && !schema.enum.includes(value)) errors.push(`${at}: value is outside enum`);
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
	for (const child of schema.allOf ?? []) errors.push(...schemaErrors(value, child, at));
	if (schema.if && schemaErrors(value, schema.if, at).length === 0 && schema.then) {
		errors.push(...schemaErrors(value, schema.then, at));
	}
	return errors;
}

function stringsIn(value) {
	if (typeof value === 'string') return [value];
	if (Array.isArray(value)) return value.flatMap(stringsIn);
	if (value && typeof value === 'object') return Object.values(value).flatMap(stringsIn);
	return [];
}

test('case 1: two note feature blocks become two ordered evidence-mapped entries', async () => {
	assert.ifError(loadError);
	assert.equal(typeof analyzeRelease, 'function', 'analyzeRelease must be exported');
	const result = analyzeRelease({
		note: await fixture('two-features.md'),
		tickets: [{ surface: 'window-follow' }, { surface: 'pause-resume' }],
		labels: ['release'],
	});
	assert.equal(result.schema_version, 'changedrop-value-summary/1');
	assert.equal(result.decision, 'render');
	assert.equal(result.skip_reason, null);
	assert.deepEqual(result.features, [
		{
			surface: 'window-follow',
			before: 'Resizing could leave the editor view stale.',
			after: 'The view follows the window.',
			value: 'Players keep the HUD aligned without reopening the editor.',
		},
		{
			surface: 'pause-resume',
			before: 'Lining up a HUD meant waiting for a useful frame.',
			after: 'Pause and Resume follow engine state.',
			value: 'Players can make precise edits on a stable frame.',
		},
	]);
});

test('case 2: the existing recorded internal-only exemption skips with no features', async () => {
	const result = analyzeRelease({
		note: await fixture('two-features.md'),
		tickets: [{
			body: '## Internal-only exemption\n- [x] This change has no user-visible effect.\nReason: Refactors deterministic fixture names only.',
		}],
		labels: ['release', 'internal-only'],
	});
	assert.equal(result.decision, 'skip');
	assert.deepEqual(result.features, []);
	assert.match(result.skip_reason, /deterministic fixture names only/i);
});

test('case 3: each missing value field fails with its feature block and field named', async () => {
	const complete = await fixture('two-features.md');
	const cases = [
		['Before', complete.replace(/^Before:.*\n/m, ''), 'The window follows its new size'],
		['After', complete.replace(/^After:.*\n/m, ''), 'The window follows its new size'],
		['Value', await fixture('missing-value.md'), 'Unstateable settings panel'],
	];
	for (const [field, note, block] of cases) {
		assert.throws(
			() => analyzeRelease({ note, tickets: [], labels: ['release'] }),
			(error) => {
				assert.match(error.message, new RegExp(block, 'i'));
				assert.match(error.message, new RegExp(`missing.*${field}|${field}.*missing`, 'i'));
				return true;
			},
		);
	}
});

test('case 4: a changed surface absent from note evidence fails by surface name', async () => {
	const note = await fixture('two-features.md');
	assert.throws(
		() => analyzeRelease({
			note,
			tickets: [{ surface: 'settings-panel', user_visible: true }],
			labels: ['release'],
		}),
		/error.*settings-panel|settings-panel.*evidence/i,
	);
});

test('case 5: output validates against the committed schema and contains no private location', async () => {
	const schema = JSON.parse(await readFile(
		path.join(here, '..', 'changedrop', 'schemas', 'changedrop-value-summary.v1.json'),
		'utf8',
	));
	assert.deepEqual(schema.properties.features.items.required,
		['surface', 'before', 'after', 'value']);
	assert.equal(schema.properties.features.items.additionalProperties, false);
	const result = analyzeRelease({
		note: await fixture('two-features.md'),
		tickets: [{ surface: 'window-follow' }, { surface: 'pause-resume' }],
		labels: ['release'],
	});
	assert.deepEqual(schemaErrors(result, schema), []);
	for (const value of stringsIn(result)) {
		assert.equal(path.isAbsolute(value), false, `absolute path escaped into output field: ${JSON.stringify(value)}`);
		assert.doesNotMatch(value, /\/home\/|\/Users\/|\$USER\b|file:\/\//i);
		if (hostname()) assert.equal(value.includes(hostname()), false, 'hostname escaped into output');
	}
	const source = await fixture('two-features.md');
	const privateValues = [
		'/home/example/private', '/Users/example/private', '/var/private',
		'C:\\private\\file', '\\\\server\\share', '$USER', 'file:///private',
	];
	if (hostname()) privateValues.push(hostname());
	for (const privateValue of privateValues) {
		assert.throws(
			() => analyzeRelease({
				note: source.replace('Players keep the HUD aligned', `${privateValue} Players keep the HUD aligned`),
				tickets: [],
				labels: ['release'],
			}),
			/private location/i,
		);
	}
});

test('pilot contract: Release 1 exposes two real structured value triples', async () => {
	const note = await readFile(path.join(repo, 'docs', 'release-1', 'NOTES.md'), 'utf8');
	const result = analyzeRelease({ note, tickets: [], labels: ['release'] });
	assert.deepEqual(result.features.map((feature) => feature.surface), ['window-follow', 'pause-resume']);
	for (const feature of result.features) {
		assert.deepEqual(Object.keys(feature), ['surface', 'before', 'after', 'value']);
		assert.ok(feature.before);
		assert.ok(feature.after);
		assert.ok(feature.value);
	}
});

test('supporting command contract: writes a private schema-valid summary without disclosing its root', async (t) => {
	const root = await mkdtemp(path.join(tmpdir(), 'changedrop-output-'));
	const source = await mkdtemp(path.join(tmpdir(), 'changedrop-source-'));
	t.after(() => Promise.all([
		rm(root, { recursive: true, force: true }),
		rm(source, { recursive: true, force: true }),
	]));
	await chmod(root, 0o700);
	await mkdir(path.join(source, 'docs', 'synthetic'), { recursive: true });
	await writeFile(path.join(source, 'docs', 'synthetic', 'NOTES.md'), await fixture('two-features.md'));
	const relativeOutput = 'synthetic/test-run/value-summary.json';
	const { stdout, stderr } = await execFileAsync(process.execPath, [
		path.join(repo, 'tools', 'changedrop', 'analyze.mjs'),
		'--release', 'synthetic', '--out', relativeOutput,
	], { cwd: source, env: { ...process.env, EZHUD_CHANGEDROP_ROOT: root } });
	assert.equal(stderr, '');
	assert.equal(stdout.includes(root), false, 'command disclosed its data root');
	const written = JSON.parse(await readFile(path.join(root, relativeOutput), 'utf8'));
	const schema = JSON.parse(await readFile(
		path.join(repo, 'tools', 'changedrop', 'schemas', 'changedrop-value-summary.v1.json'), 'utf8'));
	assert.deepEqual(schemaErrors(written, schema), []);
	assert.equal((await stat(path.join(root, relativeOutput))).mode & 0o777, 0o600);
	assert.equal((await stat(path.dirname(path.join(root, relativeOutput)))).mode & 0o777, 0o700);
});

test('case 6: command refuses to run without the required data-root variable', async () => {
	const packageJson = JSON.parse(await readFile(path.join(repo, 'package.json'), 'utf8'));
	assert.equal(packageJson.scripts?.['changedrop:analyze'],
		'node tools/changedrop/analyze.mjs', 'changedrop analyzer command is not wired');
	const env = { ...process.env };
	delete env.EZHUD_CHANGEDROP_ROOT;
	await assert.rejects(
		execFileAsync(process.execPath, [
			path.join(repo, 'tools', 'changedrop', 'analyze.mjs'),
			'--release', 'release-1',
			'--out', 'release-1/test-run/value-summary.json',
		], { cwd: repo, env }),
		(error) => {
			assert.equal(error.code, 1);
			assert.match(error.stderr, /EZHUD_CHANGEDROP_ROOT/);
			return true;
		},
	);
});
