import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
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

let review;
let loadError;
try {
	review = await import('../changedrop/review.mjs');
} catch (error) {
	loadError = error;
}

const fixture = async (name) => JSON.parse(await readFile(path.join(fixtureDir, name), 'utf8'));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function machineAction(step) {
	const { instruction: _instruction, ...action } = step;
	return { ...action, ...(action.crop ? { crop: { ...action.crop } } : {}) };
}

function schemaErrors(value, schema, at = '$', root = schema) {
	if (schema.$ref) {
		const target = schema.$ref.slice(2).split('/').reduce((entry, part) => entry?.[part], root);
		return target ? schemaErrors(value, target, at, root) : [`${at}: unresolved ${schema.$ref}`];
	}
	const errors = [];
	if (schema.oneOf) {
		const matches = schema.oneOf.filter((choice) => schemaErrors(value, choice, at, root).length === 0);
		if (matches.length !== 1) return [`${at}: expected exactly one schema branch`];
	}
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
		if (schema.maxLength != null && value.length > schema.maxLength) errors.push(`${at}: string is too long`);
		if (schema.pattern && !(new RegExp(schema.pattern)).test(value)) errors.push(`${at}: string misses pattern`);
	}
	if (Array.isArray(value)) {
		if (schema.minItems != null && value.length < schema.minItems) errors.push(`${at}: too few items`);
		if (schema.maxItems != null && value.length > schema.maxItems) errors.push(`${at}: too many items`);
		if (schema.items) value.forEach((entry, index) => errors.push(...schemaErrors(entry, schema.items, `${at}[${index}]`, root)));
		if (schema.contains) {
			const count = value.filter((entry) => schemaErrors(entry, schema.contains, at, root).length === 0).length;
			if (schema.minContains != null && count < schema.minContains) errors.push(`${at}: too few matching items`);
			if (schema.maxContains != null && count > schema.maxContains) errors.push(`${at}: too many matching items`);
		}
	}
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		for (const required of schema.required ?? []) {
			if (!(required in value)) errors.push(`${at}: missing ${required}`);
		}
		for (const [key, entry] of Object.entries(value)) {
			if (schema.properties?.[key]) errors.push(...schemaErrors(entry, schema.properties[key], `${at}.${key}`, root));
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

const NOTE = `# Snap into place

Alignment now takes one click instead of repeated nudging.

## Features

### Clean alignment
Before: Lining things up meant repeated pixel-by-pixel corrections.
After: HUD elements now snap cleanly into line when you enable the control.
Value: You spend less time correcting alignment and more time shaping the HUD.
Evidence: img/snap-magnet-focused.png
`;

async function prepareRun(t, runId = 'synthetic-review') {
	const workspace = await mkdtemp(path.join(tmpdir(), 'changedrop-review-'));
	t.after(() => rm(workspace, { recursive: true, force: true }));
	const repositoryRoot = path.join(workspace, 'repository');
	const root = path.join(workspace, 'private');
	const noteDirectory = path.join(repositoryRoot, 'docs', 'release-1');
	const runRoot = path.join(root, 'release-1', runId);
	const captureDirectory = path.join(runRoot, 'capture-fitted');
	const narrationDirectory = path.join(runRoot, 'narration');
	const muxDirectory = path.join(runRoot, 'mux');
	for (const directory of [repositoryRoot, noteDirectory, root, path.join(root, 'release-1'), runRoot,
		captureDirectory, path.join(captureDirectory, 'stills'), narrationDirectory, muxDirectory]) {
		await mkdir(directory, { recursive: true, mode: 0o700 });
		await chmod(directory, 0o700);
	}
	const noteFile = path.join(noteDirectory, 'NOTES.md');
	await writeFile(noteFile, NOTE);

	const script = await fixture('capture-script.json');
	const observations = await fixture('capture-observations-a.json');
	const imageBytes = Buffer.alloc(2304);
	Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(imageBytes);
	const imageFile = path.join(captureDirectory, 'stills', 'snap-magnet-1.png');
	await writeFile(imageFile, imageBytes, { mode: 0o600 });
	const timings = {
		schema_version: 'changedrop-timings/1',
		recording: {
			basename: 'walkthrough.webm', bytes: 4096,
			duration_seconds: 4.1, container_duration_seconds: 5.02,
		},
		setup_actions: script.setup.map(machineAction),
		segments: script.segments.map((segment, index) => ({
			id: segment.id,
			kind: segment.kind,
			surface: segment.surface,
			start_seconds: observations[index].start_seconds,
			duration_seconds: observations[index].duration_seconds,
			actions: segment.walkthrough.map(machineAction),
			highlights: observations[index].highlights.map((entry) => ({
				...entry,
				bytes: entry.basename === 'stills/snap-magnet-1.png' ? imageBytes.length : entry.bytes,
			})),
		})),
	};
	await writeFile(path.join(narrationDirectory, 'script.json'), `${JSON.stringify(script, null, 2)}\n`, { mode: 0o600 });
	await writeFile(path.join(captureDirectory, 'timings.json'), `${JSON.stringify(timings, null, 2)}\n`, { mode: 0o600 });

	const videoBytes = Buffer.from('synthetic muxed video bytes');
	const videoFile = path.join(muxDirectory, 'changedrop.mp4');
	await writeFile(videoFile, videoBytes, { mode: 0o600 });
	const manifest = await fixture('orchestrator-render-manifest.json');
	manifest.run_id = runId;
	manifest.source_note.sha256 = sha256(await readFile(noteFile));
	manifest.output.sha256 = sha256(videoBytes);
	manifest.output.duration_s = 4.1;
	manifest.capture.duration_s = 4.1;
	manifest.segments.forEach((segment, index) => {
		segment.measured_start_s = timings.segments[index].start_seconds;
		segment.measured_duration_s = timings.segments[index].duration_seconds;
	});
	const manifestFile = path.join(runRoot, 'manifest.json');
	await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
	return {
		workspace,
		repositoryRoot,
		root,
		runRoot,
		manifest,
		manifestFile,
		videoFile,
		videoBytes,
		imageFile,
		imageBytes,
		argv: [
			'--manifest', `release-1/${runId}/manifest.json`,
			'--out', `release-1/${runId}/review-payload.json`,
		],
	};
}

async function makePayload(t, runId) {
	assert.ifError(loadError);
	const run = await prepareRun(t, runId);
	const payload = await review.main({
		env: { ...process.env, EZHUD_CHANGEDROP_ROOT: run.root },
		argv: run.argv,
		cwd: run.repositoryRoot,
		stdout: () => {},
	});
	return { run, payload };
}

test('case 1: destination is the one prepared owner-review channel and the command writes privately', async (t) => {
	const { run, payload } = await makePayload(t, 'destination');
	assert.deepEqual(payload.destination, {
		kind: 'discord-channel',
		channel_id: '1534452186266734683',
		purpose: 'owner-review',
		state: 'prepared',
		posted: false,
	});
	const output = path.join(run.runRoot, 'review-payload.json');
	assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), payload);
	assert.equal((await stat(output)).mode & 0o777, 0o600);
	const packageJson = JSON.parse(await readFile(path.join(repo, 'package.json'), 'utf8'));
	assert.equal(packageJson.scripts?.['changedrop:review'], 'node tools/changedrop/review.mjs');
});

test('case 2: message is bounded player-facing what-changed and why copy without issue or internal jargon', async (t) => {
	const { payload } = await makePayload(t, 'message');
	assert.ok(payload.message.content.length > 0 && payload.message.content.length <= 1900);
	assert.match(payload.message.content, /Clean alignment/);
	assert.match(payload.message.content, /Now: HUD elements now snap cleanly into line/);
	assert.match(payload.message.content, /Why it matters: You spend less time/);
	assert.doesNotMatch(payload.message.content, /(?:^|\s)#\d+\b/);
	assert.doesNotMatch(payload.message.content, /\b(?:manifest|pipeline|mux|artifact|provenance|sha-?256|ffmpeg|playwright|voice-order)\b/i);
	assert.throws(() => review.buildReviewMessage({
		title: 'A player update',
		features: [{ title: 'Too much', after: 'a'.repeat(1900), value: 'Useful.' }],
	}), /1900|too long/i);
	assert.throws(() => review.buildReviewMessage({
		title: 'A player update',
		features: [{ title: 'Internal', after: 'The mux artifact is ready.', value: 'Useful.' }],
	}), /player-facing|internal jargon/i);
});

test('case 3: mentions are inert, embeds are suppressed, and every message URL is angle-wrapped', async (t) => {
	const { payload } = await makePayload(t, 'message-safety');
	assert.deepEqual(payload.message.allowed_mentions, { parse: [] });
	assert.equal(payload.message.suppress_embeds, true);
	assert.doesNotMatch(payload.message.content, /@everyone|@here|<@(?:!|&)?\d+>/i);
	const linked = review.buildReviewMessage({
		title: 'A player update',
		features: [{
			title: 'Try it',
			after: 'Open https://example.invalid/play to try the new control.',
			value: 'You can start immediately.',
		}],
	});
	assert.match(linked, /<https:\/\/example\.invalid\/play>/);
	for (const mutation of [
		(value) => { value.message.allowed_mentions.parse = ['users']; },
		(value) => { value.message.suppress_embeds = false; },
		(value) => { value.message.content = 'See https://example.invalid/bare'; },
		(value) => { value.message.content = '@everyone take a look'; },
		(value) => { value.message.content = '<@&123456789012345678> take a look'; },
	]) {
		const unsafe = structuredClone(payload);
		mutation(unsafe);
		assert.throws(() => review.validateReviewPayload(unsafe), /mention|URL|embed|prepared payload/i);
	}
});

test('case 4: attachments are verified local files with hashes, sizes, kinds, surfaces, and mux duration', async (t) => {
	const { run, payload } = await makePayload(t, 'attachments');
	assert.equal(payload.attachments.length, 2);
	assert.deepEqual(payload.attachments[0], {
		name: 'changedrop.mp4',
		kind: 'video',
		sha256: sha256(run.videoBytes),
		bytes: run.videoBytes.length,
		duration_seconds: run.manifest.output.duration_s,
	});
	assert.deepEqual(payload.attachments[1], {
		name: 'snap-magnet-1.png',
		kind: 'image',
		surface: 'snap-magnet',
		sha256: sha256(run.imageBytes),
		bytes: run.imageBytes.length,
	});
	for (const attachment of payload.attachments) {
		assert.equal('path' in attachment, false);
		assert.equal('url' in attachment, false);
	}

	const stale = await prepareRun(t, 'stale-video');
	await writeFile(stale.videoFile, Buffer.from('substituted video'), { mode: 0o600 });
	await assert.rejects(review.main({
		env: { ...process.env, EZHUD_CHANGEDROP_ROOT: stale.root },
		argv: stale.argv, cwd: stale.repositoryRoot, stdout: () => {},
	}), /video.*sha-?256|sha-?256.*video|output.*hash/i);
});

test('case 5: schema and provenance bind the payload to manifest, capture, narration, and output', async (t) => {
	const { run, payload } = await makePayload(t, 'provenance');
	const schema = JSON.parse(await readFile(
		path.join(repo, 'tools', 'changedrop', 'schemas', 'changedrop-review-payload.v1.json'), 'utf8'));
	assert.deepEqual(schemaErrors(payload, schema), []);
	assert.equal(payload.schema_version, 'changedrop-review-payload/1');
	assert.equal(payload.release, run.manifest.release);
	assert.equal(payload.provenance.manifest_sha256, sha256(await readFile(run.manifestFile)));
	assert.equal(payload.provenance.capture_sha256, run.manifest.capture.sha256);
	assert.deepEqual(payload.provenance.narration, run.manifest.segments.map((segment) => ({
		id: segment.id,
		sha256: segment.narration.sha256,
		duration_seconds: segment.narration.duration_s,
	})));
});

test('case 6: non-render manifests and every path, host, user, or audio.path leak are rejected', async (t) => {
	const { payload } = await makePayload(t, 'privacy');
	const privateValues = [
		'/home/private/changedrop.mp4',
		'/Users/private/changedrop.mp4',
		'$USER/private',
		'file:///private/changedrop.mp4',
		hostname(),
	].filter(Boolean);
	for (const value of privateValues) {
		const unsafe = structuredClone(payload);
		unsafe.message.content = `Private value: ${value}`;
		assert.throws(() => review.validateReviewPayload(unsafe), /private|host|user|path|player-facing/i);
	}
	const userLeak = structuredClone(payload);
	userLeak.message.content = 'synthetic-private-user';
	assert.throws(() => review.validateReviewPayload(userLeak, { USER: 'synthetic-private-user' }), /private|user/i);
	const pathField = structuredClone(payload);
	pathField.attachments[0].path = 'mux/changedrop.mp4';
	assert.throws(() => review.validateReviewPayload(pathField), /path/i);
	const audioPath = structuredClone(payload);
	audioPath.provenance['audio.path'] = '/private/order.wav';
	assert.throws(() => review.validateReviewPayload(audioPath), /audio\.path|path/i);
	for (const value of stringsIn(payload)) {
		assert.equal(path.isAbsolute(value), false);
		assert.doesNotMatch(value, /\/home\/|\/Users\/|\$USER\b|file:\/\//i);
	}

	const stopped = await prepareRun(t, 'stopped');
	stopped.manifest.decision = 'blocked';
	stopped.manifest.blocked_reason = 'Synthetic stop.';
	stopped.manifest.segments = [];
	stopped.manifest.capture = null;
	stopped.manifest.output = null;
	await writeFile(stopped.manifestFile, `${JSON.stringify(stopped.manifest, null, 2)}\n`, { mode: 0o600 });
	await assert.rejects(review.main({
		env: { ...process.env, EZHUD_CHANGEDROP_ROOT: stopped.root },
		argv: stopped.argv, cwd: stopped.repositoryRoot, stdout: () => {},
	}), /render manifest|rendered output|decision/i);
});

test('case 7: repository grep proves tools contain no Discord posting call, webhook, or token handling', async () => {
	assert.ifError(loadError);
	const source = await readFile(path.join(repo, 'tools', 'changedrop', 'review.mjs'), 'utf8');
	assert.doesNotMatch(source, /\bfetch\s*\(|\bspawn\s*\(|execFile|axios|\.request\s*\(/i);
	const postingPattern = [
		['discord(?:app)?', '\\.com/api'].join(''),
		['hooks\\.', 'discord'].join(''),
		['process\\.env\\.', 'DISCORD_'].join(''),
		['DISCORD_', '(?:BOT_)?(?:TOKEN|SECRET|KEY|WEBHOOK)(?:_URL)?[ \\t]*='].join(''),
		['fetch\\s*\\([^\\n]*', 'discord'].join(''),
		['curl[^\\n]*', 'discord'].join(''),
		['discord', '\\.(?:js|py)'].join(''),
		['Routes\\.', 'channelMessages'].join(''),
		['channel\\.', 'send\\s*\\('].join(''),
		['client\\.', 'login\\s*\\('].join(''),
	].join('|');
	await assert.rejects(execFileAsync('grep', [
		'-RInE',
		postingPattern,
		'tools',
	], { cwd: repo }), (error) => {
		assert.equal(error.code, 1, error.stdout || error.stderr);
		assert.equal(error.stdout, '');
		return true;
	});
});
