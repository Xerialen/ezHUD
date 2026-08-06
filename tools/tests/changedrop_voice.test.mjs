import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { buildTimingReceipt } from '../changedrop/capture.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(here, 'fixtures', 'changedrop');
const repo = path.resolve(here, '../..');
const execFileAsync = promisify(execFile);
const fixture = async (name) => JSON.parse(await readFile(path.join(fixtureDir, name), 'utf8'));
const HASH = 'a'.repeat(64);
const syntheticAudioPath = () => path.resolve(path.sep, 'private-fixture', 'voice.wav');

let voice;
let loadError;
try {
	voice = await import('../changedrop/voice.mjs');
} catch (error) {
	loadError = error;
}

async function inputs() {
	const script = await fixture('capture-script.json');
	const timings = buildTimingReceipt({
		script,
		recording: { basename: 'walkthrough.webm', bytes: 512, duration_seconds: 4.1 },
		observations: await fixture('capture-observations-a.json'),
	});
	return { script, timings };
}

function resultFor(request, audioPath, {
	status = 'rendered', rerendered = true, sha256 = HASH, bytes = 48_044,
} = {}) {
	return {
		schema_version: 'voice-order/1',
		status,
		request_id: request.request_id,
		request_hash: `sha256:${HASH}`,
		project: 'ezhud',
		voice_profile: 'xeri-en-v1',
		profile_revision: 1,
		pronunciation_profile: 'quakeworld-en-v1',
		pronunciation_revision: 1,
		audio: {
			path: audioPath,
			sha256,
			bytes,
			container: 'wav',
			sample_rate: 24_000,
			channels: 1,
			sample_width_bits: 16,
			duration_seconds: request.target.duration_seconds,
		},
		target: {
			duration_seconds: request.target.duration_seconds,
			tolerance_seconds: request.target.tolerance_seconds,
			delta_seconds: 0,
		},
		normalized_text: request.text,
		normalized_text_sha256: HASH,
		engine: {
			name: 'chatterbox-multilingual',
			t3_model: 'fixture-model',
			cli_sha256: HASH,
		},
		rendered_at: '2026-08-06T12:00:00Z',
		rerendered,
	};
}

function failed(request, errorCode, message = 'message text must not drive policy') {
	return {
		schema_version: 'voice-order/1',
		status: 'failed',
		request_id: request.request_id,
		error_code: errorCode,
		message,
	};
}

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

test('case 1: built requests validate with exact fixed fields and no forbidden controls', async () => {
	assert.ifError(loadError);
	const { script, timings } = await inputs();
	const requests = voice.buildVoiceRequests({ script, timings });
	assert.equal(requests.length, script.segments.length);
	for (const request of requests) {
		assert.equal(voice.validateVoiceRequest(request), request);
		assert.deepEqual(Object.keys(request), [
			'schema_version', 'request_id', 'project', 'voice_profile', 'mode', 'style',
			'language', 'text', 'delivery', 'target',
		]);
		assert.deepEqual(request.delivery, { container: 'wav', sample_rate: 24_000, channels: 1 });
		assert.equal(request.schema_version, 'voice-order/1');
		assert.equal(request.project, 'ezhud');
		assert.equal(request.voice_profile, 'xeri-en-v1');
		assert.equal(request.mode, 'spoken');
		assert.equal(request.style, 'neutral');
		assert.equal(request.language, 'en');
		assert.match(request.request_id, /^ezhud-[0-9a-f]{32}$/);
		assert.doesNotMatch(JSON.stringify(request),
			/output|reference|model|generation|seed|renderer|extra[_-]?args/i);
	}
	for (const field of ['output_path', 'reference_path', 'model', 'generation_settings', 'seed', 'renderer_args', 'extra_args']) {
		assert.throws(() => voice.validateVoiceRequest({ ...requests[0], [field]: 'forbidden' }), /unexpected field/i);
	}
	const rerun = voice.buildVoiceRequests({ script: structuredClone(script), timings: structuredClone(timings) });
	assert.deepEqual(rerun.map((request) => request.request_id), requests.map((request) => request.request_id));
	const changed = structuredClone(script);
	changed.segments[1].text += ' Changed.';
	assert.notEqual(voice.buildVoiceRequests({ script: changed, timings })[1].request_id, requests[1].request_id);
});

test('case 2: duration target is measured, paired with tolerance, and corrected bookends fit the probe', async () => {
	assert.ifError(loadError);
	const { script, timings } = await inputs();
	const requests = voice.buildVoiceRequests({ script, timings });
	for (const [index, request] of requests.entries()) {
		assert.deepEqual(Object.keys(request.target), ['duration_seconds', 'tolerance_seconds']);
		assert.equal(request.target.duration_seconds, timings.segments[index].duration_seconds);
		assert.equal(request.target.tolerance_seconds, 0.5);
	}
	const unpaired = structuredClone(requests[0]);
	delete unpaired.target.tolerance_seconds;
	assert.throws(() => voice.validateVoiceRequest(unpaired), /target.*both|target.*missing.*tolerance_seconds|tolerance_seconds.*required/i);
	const untargeted = structuredClone(requests[0]);
	delete untargeted.target;
	assert.equal(voice.validateVoiceRequest(untargeted), untargeted);

	const authoring = JSON.parse(await readFile(path.join(repo, 'docs', 'release-1', 'changedrop-script.json'), 'utf8'));
	const introHold = authoring.bookends.intro_walkthrough.find((step) => step.action === 'hold');
	const outroHold = authoring.bookends.outro_walkthrough.find((step) => step.action === 'hold');
	assert.equal(introHold.duration_ms, 4200);
	assert.equal(outroHold.duration_ms, 4200);
	assert.ok(Math.abs(3.840 - introHold.duration_ms / 1000) <= 0.5,
		'known 3.840-second intro render does not fit corrected hold');
	const staleCapture = structuredClone(timings);
	staleCapture.segments[0].actions[0].duration_ms -= 1000;
	assert.throws(() => voice.buildVoiceRequests({ script, timings: staleCapture }),
		/intro.*stale.*capture|action sequence.*intro.*capture/i);
});

test('case 3: every documented error code maps by code to its specified action', async () => {
	assert.ifError(loadError);
	const expected = {
		E_PROJECT_NOT_ALLOWED: 'stop-prerequisite',
		E_PROFILE_UNKNOWN: 'stop-prerequisite',
		E_SCHEMA_INVALID: 'request-builder-bug',
		E_UNKNOWN_FIELD: 'request-builder-bug',
		E_TEXT_UNSAFE: 'script-defect',
		E_TEXT_TOO_LONG: 'script-defect',
		E_OVERRIDE_INVALID: 'script-defect',
		E_DURATION_OUT_OF_TOLERANCE: 'reauthor-segment',
		E_REQUEST_ID_CONFLICT: 'request-builder-bug',
		E_LOCK_TIMEOUT: 'retry-identical',
		E_INTERNAL: 'retry-identical',
		E_RENDER_FAILED: 'stop-report',
		E_ARTIFACT_INVALID: 'stop-report',
	};
	for (const [code, action] of Object.entries(expected)) {
		assert.equal(voice.policyForError(code).action, action);
	}
	assert.deepEqual(voice.policyForError('E_PROJECT_NOT_ALLOWED'),
		voice.policyForError('E_PROJECT_NOT_ALLOWED', 'completely different message'));
	assert.throws(() => voice.policyForError('E_UNDOCUMENTED'), /undocumented.*E_UNDOCUMENTED|E_UNDOCUMENTED.*unknown/i);

	const { script, timings } = await inputs();
	const request = voice.buildVoiceRequests({ script, timings })[0];
	const seen = [];
	const success = resultFor(request, syntheticAudioPath());
	const submitted = await voice.submitWithPolicy(request, async (sameRequest) => {
		seen.push(structuredClone(sameRequest));
		if (seen.length === 1) {
			return { exitCode: 6, stdout: JSON.stringify(failed(request, 'E_LOCK_TIMEOUT')), stderr: '' };
		}
		return { exitCode: 0, stdout: JSON.stringify(success), stderr: '' };
	});
	assert.equal(submitted.attempts, 2);
	assert.deepEqual(seen, [request, request], 'retry changed the effective request');
	let boundedCalls = 0;
	await assert.rejects(
		voice.submitWithPolicy(request, async () => {
			boundedCalls += 1;
			return { exitCode: 10, stdout: JSON.stringify(failed(request, 'E_INTERNAL')), stderr: '' };
		}),
		(error) => error.errorCode === 'E_INTERNAL' && error.action === 'retry-identical',
	);
	assert.equal(boundedCalls, 3);
});

test('case 4: project/profile refusal stops once with a recorded prerequisite and no fallback', async () => {
	assert.ifError(loadError);
	const { script, timings } = await inputs();
	const request = voice.buildVoiceRequests({ script, timings })[0];
	for (const code of ['E_PROJECT_NOT_ALLOWED', 'E_PROFILE_UNKNOWN']) {
		let calls = 0;
		await assert.rejects(
			voice.submitWithPolicy(request, async () => {
				calls += 1;
				return { exitCode: 3, stdout: JSON.stringify(failed(request, code)), stderr: 'ignored diagnostic' };
			}),
			(error) => {
				assert.equal(error.errorCode, code);
				assert.equal(error.action, 'stop-prerequisite');
				assert.match(error.prerequisite, /project ezhud|profile xeri-en-v1/i);
				assert.doesNotMatch(error.message, /fallback|substitut/i);
				return true;
			},
		);
		assert.equal(calls, 1);
	}
});

test('case 5: duplicate with rerendered false succeeds once and never retries', async () => {
	assert.ifError(loadError);
	const { script, timings } = await inputs();
	const request = voice.buildVoiceRequests({ script, timings })[0];
	let calls = 0;
	const duplicate = resultFor(request, syntheticAudioPath(), { status: 'duplicate', rerendered: false });
	const submitted = await voice.submitWithPolicy(request, async () => {
		calls += 1;
		return { exitCode: 0, stdout: JSON.stringify(duplicate), stderr: '' };
	});
	assert.equal(calls, 1);
	assert.equal(submitted.result.status, 'duplicate');
	assert.equal(submitted.attempts, 1);
	const invalid = resultFor(request, syntheticAudioPath(), { status: 'duplicate', rerendered: true });
	await assert.rejects(
		voice.submitWithPolicy(request, async () => ({ exitCode: 0, stdout: JSON.stringify(invalid), stderr: '' })),
		/duplicate.*rerendered false|rerendered.*duplicate/i,
	);
});

test('case 6: tier-1 command contract is offline and refuses before any service call', async () => {
	assert.ifError(loadError);
	const packageJson = JSON.parse(await readFile(path.join(repo, 'package.json'), 'utf8'));
	assert.equal(packageJson.scripts?.['changedrop:voice'], 'node tools/changedrop/voice.mjs');
	const source = await readFile(path.join(repo, 'tools', 'changedrop', 'voice.mjs'), 'utf8');
	assert.doesNotMatch(source, /microphone|fallback voice|substitute engine/i);
	assert.doesNotMatch(source, /execFileSync|spawnSync|execSync/);
	const env = { ...process.env };
	delete env.EZHUD_CHANGEDROP_ROOT;
	await assert.rejects(execFileAsync(process.execPath, [
		path.join(repo, 'tools', 'changedrop', 'voice.mjs'),
		'--script', 'release-1/run/script.json',
		'--timings', 'release-1/run/capture/timings.json',
		'--out', 'release-1/run/narration',
	], { cwd: repo, env }), (error) => {
		assert.equal(error.code, 1);
		assert.match(error.stderr, /EZHUD_CHANGEDROP_ROOT/);
		return true;
	});
});

test('case 7: sanitized narration strips audio.path and validates with basename and sha256 only', async (t) => {
	assert.ifError(loadError);
	const { script, timings } = await inputs();
	const request = voice.buildVoiceRequests({ script, timings })[0];
	const result = resultFor(request, syntheticAudioPath());
	const entry = voice.sanitizeVoiceResult({
		segment: script.segments[0],
		request,
		result,
		basename: 'intro.wav',
	});
	assert.equal('path' in entry.audio, false);
	assert.deepEqual(Object.keys(entry.audio), ['basename', 'sha256']);
	assert.equal(entry.audio.basename, 'intro.wav');
	assert.equal(entry.audio.sha256, HASH);
	assert.equal(entry.duration_seconds, result.audio.duration_seconds);
	assert.equal(JSON.stringify(entry).includes(result.audio.path), false);
	const narration = {
		schema_version: 'changedrop-narration/1',
		project: 'ezhud',
		voice_profile: 'xeri-en-v1',
		segments: [entry],
	};
	const schema = JSON.parse(await readFile(
		path.join(repo, 'tools', 'changedrop', 'schemas', 'changedrop-narration.v1.json'), 'utf8'));
	assert.equal(schema.additionalProperties, false);
	assert.equal(schema.properties.segments.items.properties.audio.additionalProperties, false);
	assert.equal('path' in schema.properties.segments.items.properties.audio.properties, false);
	assert.deepEqual(schemaErrors(narration, schema), []);
	for (const value of stringsIn(narration)) {
		assert.equal(path.isAbsolute(value), false, `absolute path escaped into narration: ${JSON.stringify(value)}`);
		assert.doesNotMatch(value, /\/home\/|\/Users\/|\$USER\b|file:\/\//i);
		if (hostname()) assert.equal(value.includes(hostname()), false, 'hostname escaped into narration');
	}

	const root = await mkdtemp(path.join(path.dirname(repo), '.voice-offline-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	await chmod(root, 0o700);
	await mkdir(path.join(root, 'release', 'run'), { recursive: true, mode: 0o700 });
	await chmod(path.join(root, 'release'), 0o700);
	await chmod(path.join(root, 'release', 'run'), 0o700);
	await writeFile(path.join(root, 'release', 'run', 'script.json'), `${JSON.stringify(script)}\n`, { mode: 0o600 });
	await writeFile(path.join(root, 'release', 'run', 'timings.json'), `${JSON.stringify(timings)}\n`, { mode: 0o600 });
	const requests = voice.buildVoiceRequests({ script, timings });
	const results = new Map();
	for (const built of requests) {
		const audioBytes = Buffer.from(`offline audio ${built.request_id}`);
		const audioPath = path.join(root, 'release', 'run', `${built.request_id}.source.wav`);
		await writeFile(audioPath, audioBytes, { mode: 0o600 });
		const sha256 = (await import('node:crypto')).createHash('sha256').update(audioBytes).digest('hex');
		results.set(built.request_id, resultFor(built, audioPath, { sha256, bytes: audioBytes.length }));
	}
	let printed = '';
	const written = await voice.main({
		env: { ...process.env, EZHUD_CHANGEDROP_ROOT: root },
		argv: [
			'--script', 'release/run/script.json',
			'--timings', 'release/run/timings.json',
			'--out', 'release/run/narration',
		],
		transport: async (built) => ({
			exitCode: 0,
			stdout: JSON.stringify(results.get(built.request_id)),
			stderr: '',
		}),
		stdout: (line) => { printed += line; },
	});
	assert.equal(printed.includes(root), false, 'voice command disclosed its root');
	assert.equal(JSON.stringify(written).includes(root), false, 'voice manifest retained audio.path');
	const manifestPath = path.join(root, 'release', 'run', 'narration', 'narration.json');
	const manifestText = await readFile(manifestPath, 'utf8');
	assert.equal(manifestText.includes(root), false, 'written manifest retained audio.path');
	assert.deepEqual(JSON.parse(manifestText), written);
	assert.equal((await stat(manifestPath)).mode & 0o777, 0o600);
	for (const segment of written.segments) {
		assert.equal((await stat(path.join(root, 'release', 'run', 'narration', segment.audio.basename))).mode & 0o777, 0o600);
	}
});
