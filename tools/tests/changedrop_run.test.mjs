import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	chmod,
	mkdtemp,
	readFile,
	readdir,
	rm,
	stat,
} from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const fixtureDir = path.join(here, 'fixtures', 'changedrop');
const execFileAsync = promisify(execFile);

let run;
let loadError;
try {
	run = await import('../changedrop/run.mjs');
} catch (error) {
	loadError = error;
}

const fixture = async (name) => JSON.parse(await readFile(path.join(fixtureDir, name), 'utf8'));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

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
	}
	if (typeof value === 'string') {
		if (schema.minLength != null && value.length < schema.minLength) errors.push(`${at}: string is too short`);
		if (schema.pattern && !(new RegExp(schema.pattern)).test(value)) errors.push(`${at}: string misses pattern`);
	}
	if (Array.isArray(value)) {
		if (schema.minItems != null && value.length < schema.minItems) errors.push(`${at}: too few items`);
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

async function privateRoot(t, prefix = 'changedrop-run-') {
	const root = await mkdtemp(path.join(tmpdir(), prefix));
	t.after(() => rm(root, { recursive: true, force: true }));
	await chmod(root, 0o700);
	return root;
}

async function renderManifest(runId = 'synthetic-run') {
	const manifest = await fixture('orchestrator-render-manifest.json');
	manifest.run_id = runId;
	manifest.source_note.sha256 = sha256(await readFile(path.join(repo, 'docs', 'release-1', 'NOTES.md')));
	return manifest;
}

function stageHarness({ decision = 'render', manifest, voiceErrors = [], profileRevisionOverride = null } = {}) {
	const calls = [];
	let voiceErrorIndex = 0;
	const record = (stage, options) => {
		calls.push({ stage, argv: [...options.argv], maxAttempts: options.maxAttempts });
	};
	return {
		calls,
		stages: {
			analyze: async (options) => {
				record('analyze', options);
				return decision === 'skip'
					? { schema_version: 'changedrop-value-summary/1', decision: 'skip', skip_reason: 'No player-facing change.', features: [] }
					: { schema_version: 'changedrop-value-summary/1', decision: 'render', skip_reason: null, features: [{
						surface: 'snap-magnet', before: 'Loose.', after: 'Aligned.', value: 'Less pixel hunting.',
					}] };
			},
			script: async (options) => { record('script', options); return { schema_version: 'changedrop-script/1' }; },
			capture: async (options) => {
				record('capture', options);
				if (options.argv.at(-1).endsWith('/capture-fitted')) {
					return {
						schema_version: 'changedrop-timings/1',
						segments: manifest.segments.map((entry) => ({
							id: entry.id,
							start_seconds: entry.measured_start_s,
							duration_seconds: entry.measured_duration_s,
						})),
					};
				}
				return { schema_version: 'changedrop-timings/1' };
			},
			voice: async (options) => {
				record(`voice-${options.argv[1]}`, options);
				if (options.argv[1] === 'measure' && voiceErrorIndex < voiceErrors.length) {
					const errorCode = voiceErrors[voiceErrorIndex];
					voiceErrorIndex += 1;
					const error = new Error(`synthetic ${errorCode}`);
					error.errorCode = errorCode;
					throw error;
				}
				if (options.argv[1] === 'validate') {
					return {
						schema_version: 'changedrop-narration/1',
						voice_profile: 'xeri-en-v1',
						segments: manifest.segments.map((entry) => ({
							id: entry.id,
							audio: { sha256: entry.narration.sha256 },
							duration_seconds: entry.narration.duration_s,
							profile_revision: profileRevisionOverride ?? entry.narration.profile_revision,
						})),
					};
				}
				return { schema_version: 'changedrop-narration/1' };
			},
			mux: async (options) => { record('mux', options); return structuredClone(manifest); },
		},
	};
}

const runArgs = (runId = 'synthetic-run') => [
	'--release', 'release-1',
	'--run-id', runId,
	'--dist', 'synthetic-dist',
];

test('case 1: skip creates the owned release/run-id layout, writes a skip manifest, and stops after analyze', async (t) => {
	assert.ifError(loadError);
	const root = await privateRoot(t);
	const harness = stageHarness({ decision: 'skip' });
	const manifest = await run.main({
		env: { ...process.env, EZHUD_CHANGEDROP_ROOT: root },
		argv: runArgs(),
		cwd: repo,
		stages: harness.stages,
		stdout: () => {},
	});
	assert.deepEqual(harness.calls.map((entry) => entry.stage), ['analyze']);
	assert.equal(manifest.decision, 'skip');
	assert.equal(manifest.blocked_reason, 'No player-facing change.');
	assert.deepEqual(manifest.segments, []);
	assert.equal(manifest.capture, null);
	assert.equal(manifest.output, null);
	assert.deepEqual(manifest.publish, { state: 'withheld', destination: null });
	const runRoot = path.join(root, 'release-1', 'synthetic-run');
	assert.deepEqual(await readdir(runRoot), ['manifest.json']);
	assert.deepEqual(JSON.parse(await readFile(path.join(runRoot, 'manifest.json'), 'utf8')), manifest);
	assert.equal((await stat(runRoot)).mode & 0o777, 0o700);
	assert.equal((await stat(path.join(runRoot, 'manifest.json'))).mode & 0o777, 0o600);
	const schema = JSON.parse(await readFile(
		path.join(repo, 'tools', 'changedrop', 'schemas', 'changedrop-manifest.v1.json'), 'utf8'));
	assert.deepEqual(schemaErrors(manifest, schema), []);
});

test('case 2: render chains every stage in order with paths owned by one release/run-id layout', async (t) => {
	assert.ifError(loadError);
	const root = await privateRoot(t);
	const expectedManifest = await renderManifest();
	const harness = stageHarness({ manifest: expectedManifest });
	const manifest = await run.main({
		env: { ...process.env, EZHUD_CHANGEDROP_ROOT: root },
		argv: runArgs(),
		cwd: repo,
		stages: harness.stages,
		stdout: () => {},
	});
	assert.deepEqual(harness.calls.map((entry) => entry.stage), [
		'analyze', 'script', 'capture', 'voice-measure', 'capture', 'voice-validate', 'mux',
	]);
	assert.deepEqual(harness.calls.map((entry) => entry.argv), [
		['--release', 'release-1', '--out', 'release-1/synthetic-run/value-summary.json'],
		['--summary', 'release-1/synthetic-run/value-summary.json', '--authoring', 'docs/release-1/changedrop-script.json', '--out', 'release-1/synthetic-run/script.json'],
		['--script', 'release-1/synthetic-run/script.json', '--dist', 'synthetic-dist', '--out', 'release-1/synthetic-run/capture'],
		['--phase', 'measure', '--script', 'release-1/synthetic-run/script.json', '--timings', 'release-1/synthetic-run/capture/timings.json', '--out', 'release-1/synthetic-run/narration'],
		['--script', 'release-1/synthetic-run/narration/script.json', '--dist', 'synthetic-dist', '--out', 'release-1/synthetic-run/capture-fitted'],
		['--phase', 'validate', '--script', 'release-1/synthetic-run/narration/script.json', '--timings', 'release-1/synthetic-run/capture-fitted/timings.json', '--out', 'release-1/synthetic-run/narration'],
		['--capture', 'release-1/synthetic-run/capture-fitted', '--narration', 'release-1/synthetic-run/narration', '--out', 'release-1/synthetic-run/mux'],
	]);
	assert.deepEqual(manifest.segments.map((entry) => ({
		id: entry.id,
		start: entry.measured_start_s,
		duration: entry.measured_duration_s,
		sha256: entry.narration.sha256,
		narration_duration: entry.narration.duration_s,
		profile_revision: entry.narration.profile_revision,
	})), expectedManifest.segments.map((entry) => ({
		id: entry.id,
		start: entry.measured_start_s,
		duration: entry.measured_duration_s,
		sha256: entry.narration.sha256,
		narration_duration: entry.narration.duration_s,
		profile_revision: 7,
	})));
	assert.deepEqual(JSON.parse(await readFile(
		path.join(root, 'release-1', 'synthetic-run', 'manifest.json'), 'utf8')), manifest);

	const mismatchRoot = await privateRoot(t, 'changedrop-profile-mismatch-');
	const mismatch = stageHarness({
		manifest: await renderManifest('profile-mismatch'),
		profileRevisionOverride: 8,
	});
	await assert.rejects(run.main({
		env: { ...process.env, EZHUD_CHANGEDROP_ROOT: mismatchRoot },
		argv: runArgs('profile-mismatch'), cwd: repo, stages: mismatch.stages, stdout: () => {},
	}), /provenance.*intro|intro.*provenance/i);
	const blocked = JSON.parse(await readFile(
		path.join(mismatchRoot, 'release-1', 'profile-mismatch', 'manifest.json'), 'utf8'));
	assert.equal(blocked.decision, 'blocked');
});

test('case 3: final manifest is schema-valid and strips every private location and service path', async (t) => {
	assert.ifError(loadError);
	const root = await privateRoot(t);
	const harness = stageHarness({ manifest: await renderManifest() });
	const manifest = await run.main({
		env: { ...process.env, EZHUD_CHANGEDROP_ROOT: root },
		argv: runArgs(), cwd: repo, stages: harness.stages, stdout: () => {},
	});
	const schema = JSON.parse(await readFile(
		path.join(repo, 'tools', 'changedrop', 'schemas', 'changedrop-manifest.v1.json'), 'utf8'));
	assert.deepEqual(schemaErrors(manifest, schema), []);
	const serialized = JSON.stringify(manifest);
	assert.equal(serialized.includes(root), false);
	assert.doesNotMatch(serialized, /\/home\/|\/Users\/|\$USER\b|file:\/\/|audio\.path/i);
	if (process.env.USER) assert.equal(serialized.includes(process.env.USER), false);
	if (hostname()) assert.equal(serialized.includes(hostname()), false);
	for (const value of stringsIn(manifest)) assert.equal(path.isAbsolute(value), false);
});

test('case 4: retryable voice failures are bounded and every retry reuses the exact stage order', async (t) => {
	assert.ifError(loadError);
	assert.deepEqual([...run.RETRYABLE_ERROR_CODES], ['E_LOCK_TIMEOUT', 'E_INTERNAL']);
	const root = await privateRoot(t, 'changedrop-retry-');
	const harness = stageHarness({
		manifest: await renderManifest('retry-success'),
		voiceErrors: ['E_INTERNAL', 'E_INTERNAL'],
	});
	await run.main({
		env: { ...process.env, EZHUD_CHANGEDROP_ROOT: root },
		argv: runArgs('retry-success'), cwd: repo, stages: harness.stages, stdout: () => {},
	});
	const attempts = harness.calls.filter((entry) => entry.stage === 'voice-measure');
	assert.equal(attempts.length, 3);
	assert.ok(attempts.every((entry) => entry.maxAttempts === 1));
	assert.deepEqual(attempts.map((entry) => entry.argv), [attempts[0].argv, attempts[0].argv, attempts[0].argv]);

	const failedRoot = await privateRoot(t, 'changedrop-retry-bound-');
	const failed = stageHarness({
		manifest: await renderManifest('retry-bound'),
		voiceErrors: ['E_LOCK_TIMEOUT', 'E_LOCK_TIMEOUT', 'E_LOCK_TIMEOUT'],
	});
	await assert.rejects(run.main({
		env: { ...process.env, EZHUD_CHANGEDROP_ROOT: failedRoot },
		argv: runArgs('retry-bound'), cwd: repo, stages: failed.stages, stdout: () => {},
	}), /E_LOCK_TIMEOUT/);
	assert.equal(failed.calls.filter((entry) => entry.stage === 'voice-measure').length, 3);
	const blocked = JSON.parse(await readFile(
		path.join(failedRoot, 'release-1', 'retry-bound', 'manifest.json'), 'utf8'));
	assert.equal(blocked.decision, 'blocked');
	assert.match(blocked.blocked_reason, /voice-measure.*E_LOCK_TIMEOUT.*3 attempts/i);

	const stopRoot = await privateRoot(t, 'changedrop-no-retry-');
	const stopped = stageHarness({
		manifest: await renderManifest('no-retry'),
		voiceErrors: ['E_RENDER_FAILED'],
	});
	await assert.rejects(run.main({
		env: { ...process.env, EZHUD_CHANGEDROP_ROOT: stopRoot },
		argv: runArgs('no-retry'), cwd: repo, stages: stopped.stages, stdout: () => {},
	}), /E_RENDER_FAILED/);
	assert.equal(stopped.calls.filter((entry) => entry.stage === 'voice-measure').length, 1);
});

test('case 5: command is offline-injectable, refuses repository output, and exposes no publishing path', async () => {
	assert.ifError(loadError);
	assert.throws(() => run.assertExternalRoot(repo, path.join(repo, '.changedrop-private')), /outside.*repository/i);
	assert.equal(run.assertExternalRoot(repo, path.join(path.dirname(repo), '.changedrop-private')), true);
	const packageJson = JSON.parse(await readFile(path.join(repo, 'package.json'), 'utf8'));
	assert.equal(packageJson.scripts?.['changedrop:run'], 'node tools/changedrop/run.mjs');
	const source = await readFile(path.join(repo, 'tools', 'changedrop', 'run.mjs'), 'utf8');
	assert.doesNotMatch(source, /spawn\s*\(|execFile|voice-order|ffmpeg|playwright|chromium/i);
	assert.doesNotMatch(source, /discord|webhook|channel_id|allowed_mentions|\bfetch\s*\(|https?:\/\//i);
	const env = { ...process.env };
	delete env.EZHUD_CHANGEDROP_ROOT;
	await assert.rejects(execFileAsync(process.execPath, [
		path.join(repo, 'tools', 'changedrop', 'run.mjs'), '--release', 'release-1',
	], { cwd: repo, env }), (error) => {
		assert.equal(error.code, 1);
		assert.match(error.stderr, /EZHUD_CHANGEDROP_ROOT/);
		return true;
	});
});
