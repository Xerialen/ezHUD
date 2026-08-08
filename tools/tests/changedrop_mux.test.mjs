import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
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
const fixtureDir = path.join(here, 'fixtures', 'changedrop');
const repo = path.resolve(here, '../..');
const execFileAsync = promisify(execFile);

let mux;
let voice;
let loadError;
try {
	mux = await import('../changedrop/mux.mjs');
	voice = await import('../changedrop/voice.mjs');
} catch (error) {
	loadError = error;
}

const fixture = async (name) => JSON.parse(await readFile(path.join(fixtureDir, name), 'utf8'));

function canonical(value) {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === 'object') {
		return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
	}
	return value;
}

const hashBytes = (value) => createHash('sha256').update(value).digest('hex');
const hashValue = (value) => hashBytes(JSON.stringify(canonical(value)));

function wavBytes(durationSeconds) {
	const sampleRate = 24_000;
	const channels = 1;
	const bits = 16;
	const frames = Math.round(durationSeconds * sampleRate);
	const dataBytes = frames * channels * bits / 8;
	const bytes = Buffer.alloc(44 + dataBytes);
	bytes.write('RIFF', 0, 'ascii');
	bytes.writeUInt32LE(bytes.length - 8, 4);
	bytes.write('WAVE', 8, 'ascii');
	bytes.write('fmt ', 12, 'ascii');
	bytes.writeUInt32LE(16, 16);
	bytes.writeUInt16LE(1, 20);
	bytes.writeUInt16LE(channels, 22);
	bytes.writeUInt32LE(sampleRate, 24);
	bytes.writeUInt32LE(sampleRate * channels * bits / 8, 28);
	bytes.writeUInt16LE(channels * bits / 8, 32);
	bytes.writeUInt16LE(bits, 34);
	bytes.write('data', 36, 'ascii');
	bytes.writeUInt32LE(dataBytes, 40);
	return bytes;
}

function machineAction(step) {
	const { instruction: _instruction, ...action } = step;
	return { ...action, ...(action.crop ? { crop: { ...action.crop } } : {}) };
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

async function prepareRun(t) {
	const root = await mkdtemp(path.join(tmpdir(), 'changedrop-mux-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	await chmod(root, 0o700);
	const runRoot = path.join(root, 'release-1', 'synthetic-run');
	const captureDir = path.join(runRoot, 'capture-fitted');
	const narrationDir = path.join(runRoot, 'narration');
	await mkdir(captureDir, { recursive: true, mode: 0o700 });
	await mkdir(narrationDir, { recursive: true, mode: 0o700 });
	await chmod(path.join(root, 'release-1'), 0o700);
	await chmod(runRoot, 0o700);
	await chmod(captureDir, 0o700);
	await chmod(narrationDir, 0o700);

	const script = await fixture('capture-script.json');
	const observations = await fixture('capture-observations-a.json');
	const previousPaddingById = new Map(script.segments.map((segment) => [
		segment.id,
		segment.walkthrough.filter((step) => step.fit === 'narration')
			.reduce((sum, step) => sum + step.duration_ms, 0),
	]));
	for (const [index, segment] of script.segments.entries()) {
		if (segment.id === 'intro' || segment.id === 'outro') {
			segment.walkthrough.find((step) => step.fit === 'narration').duration_ms =
				Math.round(observations[index].duration_seconds * 1000);
		}
	}
	const captureBytes = Buffer.from('synthetic-fitted-recording');
	const timings = {
		schema_version: 'changedrop-timings/1',
		recording: {
			basename: 'walkthrough.webm',
			bytes: captureBytes.length,
			duration_seconds: 4.1,
			container_duration_seconds: 5.02,
		},
		setup_actions: script.setup.map(machineAction),
		segments: script.segments.map((segment, index) => ({
			id: segment.id,
			kind: segment.kind,
			surface: segment.surface,
			start_seconds: observations[index].start_seconds,
			duration_seconds: observations[index].duration_seconds,
			actions: segment.walkthrough.map(machineAction),
			highlights: observations[index].highlights,
		})),
	};
	await writeFile(path.join(captureDir, 'walkthrough.webm'), captureBytes, { mode: 0o600 });
	await writeFile(path.join(captureDir, 'timings.json'), `${JSON.stringify(timings, null, 2)}\n`, { mode: 0o600 });
	await writeFile(path.join(narrationDir, 'script.json'), `${JSON.stringify(script, null, 2)}\n`, { mode: 0o600 });

	const narrationSegments = [];
	const fitSegments = [];
	for (const [index, segment] of script.segments.entries()) {
		const duration = timings.segments[index].duration_seconds;
		const audio = wavBytes(duration);
		const sha256 = hashBytes(audio);
		await writeFile(path.join(narrationDir, `${segment.id}.wav`), audio, { mode: 0o600 });
		const requestDigest = hashBytes(`request:${segment.id}`);
		const normalizedDigest = hashBytes(`text:${segment.text}`);
		narrationSegments.push({
			id: segment.id,
			kind: segment.kind,
			surface: segment.surface,
			request_id: `ezhud-${requestDigest.slice(0, 32)}`,
			request_hash: `sha256:${requestDigest}`,
			status: 'rendered',
			rerendered: true,
			profile_revision: 1,
			pronunciation_profile: 'default',
			pronunciation_revision: 1,
			normalized_text_sha256: normalizedDigest,
			audio: { basename: `${segment.id}.wav`, sha256 },
			duration_seconds: duration,
			engine: {
				name: 'chatterbox-multilingual',
				t3_model: 'synthetic-t3',
				cli_sha256: hashBytes('synthetic-cli'),
			},
			rendered_at: '2026-08-07T12:00:00Z',
		});
		const fittedHoldDurations = segment.walkthrough
			.filter((step) => step.fit === 'narration')
			.map((step) => step.duration_ms);
		const fittedPaddingMs = fittedHoldDurations.reduce((sum, value) => sum + value, 0);
		const fixedActionSeconds = Number((duration - fittedPaddingMs / 1000).toFixed(6));
		fitSegments.push({
			id: segment.id,
			kind: segment.kind,
			surface: segment.surface,
			request_id: `ezhud-${requestDigest.slice(0, 32)}`,
			request_hash: `sha256:${requestDigest}`,
			status: 'rendered',
			rerendered: true,
			audio: { basename: `${segment.id}.wav`, sha256 },
			natural_duration_seconds: duration,
			measured_window_seconds: duration,
			fixed_action_seconds: fixedActionSeconds,
			previous_padding_ms: previousPaddingById.get(segment.id),
			fitted_padding_ms: fittedPaddingMs,
			fitted_hold_durations_ms: fittedHoldDurations,
			projected_duration_seconds: Number((fixedActionSeconds + fittedPaddingMs / 1000).toFixed(6)),
		});
	}
	const narration = {
		schema_version: 'changedrop-narration/1',
		project: 'ezhud',
		voice_profile: 'xeri-en-v1',
		segments: narrationSegments,
	};
	const fit = {
		schema_version: 'changedrop-voice-fit/1',
		project: 'ezhud',
		voice_profile: 'xeri-en-v1',
		script: { basename: 'script.json', sha256: hashValue(script) },
		segments: fitSegments,
	};
	await writeFile(path.join(narrationDir, 'narration.json'), `${JSON.stringify(narration, null, 2)}\n`, { mode: 0o600 });
	await writeFile(path.join(narrationDir, 'fit.json'), `${JSON.stringify(fit, null, 2)}\n`, { mode: 0o600 });

	return { root, runRoot, captureDir, narrationDir, script, timings, narration, fit };
}

function fixtureProbe(observations) {
	return async (file) => path.basename(file) === 'walkthrough.webm'
		? structuredClone(observations.capture)
		: structuredClone(observations.output);
}

async function fakeMuxer({ outputFile }) {
	await writeFile(outputFile, Buffer.from('synthetic-mp4-output'), { mode: 0o600 });
}

test('case no-narration: mux refuses before media execution when narration is incomplete', async (t) => {
	assert.ifError(loadError);
	const run = await prepareRun(t);
	await rm(path.join(run.narrationDir, 'narration.json'));
	const observations = await fixture('mux-media-observations.json');
	let muxCalls = 0;
	await assert.rejects(mux.main({
		env: { ...process.env, EZHUD_CHANGEDROP_ROOT: run.root },
		argv: [
			'--capture', 'release-1/synthetic-run/capture-fitted',
			'--narration', 'release-1/synthetic-run/narration',
			'--out', 'release-1/synthetic-run/mux',
		],
		cwd: repo,
		probe: fixtureProbe(observations),
		muxer: async () => { muxCalls += 1; },
	}), /narration.*complete|complete.*narration|narration.*missing/i);
	assert.equal(muxCalls, 0, 'media executor ran without narration');
});

test('review blocker: a finalized trailing pad is reconciled against explicit container and content durations', async () => {
	assert.ifError(loadError);
	assert.equal(mux.assertMuxMediaGates({
		captureContentDurationSeconds: 22.543,
		captureContainerDurationSeconds: 23.48,
		captureProbe: { duration_seconds: 23.48, streams: [{ codec_type: 'video' }] },
		outputProbe: {
			duration_seconds: 22.543,
			streams: [{ codec_type: 'video' }, { codec_type: 'audio' }],
		},
	}), true);
});

test('regression: four coupled trim points all shift by S with a long-head fixture', async () => {
	assert.ifError(loadError);
	// Real-world head: 4.419304 s of setup before the intro segment starts.
	// All four mux parameters must shift by exactly S = 4.419304.
	const args = mux.buildFfmpegArguments({
		captureFile: 'capture-fitted/walkthrough.webm',
		narrationFiles: [
			{ id: 'intro', file: 'narration/intro.wav' },
			{ id: 'drag-assist', file: 'narration/drag-assist.wav' },
			{ id: 'outro', file: 'narration/outro.wav' },
		],
		timings: {
			recording: {
				basename: 'walkthrough.webm',
				bytes: 2048,
				duration_seconds: 36.272525,
				container_duration_seconds: 37.16,
			},
			segments: [
				{ id: 'intro', start_seconds: 4.419304 },
				{ id: 'drag-assist', start_seconds: 23.785 },
				{ id: 'outro', start_seconds: 32.14 },
			],
		},
		outputFile: 'mux/changedrop.mp4',
	});
	const filter = args.join(' ');
	// 1. Video trim starts at S, keeps (duration - S) = 31.853221.
	assert.match(filter, /trim=start=4\.419304:duration=31\.853221/);
	// 2. Audio delays are shifted by -S.
	assert.match(filter, /adelay=0:all=1/);
	assert.match(filter, /adelay=19366:all=1/);
	assert.match(filter, /adelay=27721:all=1/);
	// 3. apad whole_dur uses trimmed duration, not container or raw content.
	assert.match(filter, /apad=whole_dur=31\.853221/);
	// 4. -t uses trimmed duration.
	assert.equal(args[args.indexOf('-t') + 1], '31.853221');
	// Container duration (37.16) must never leak into the trim.
	assert.equal(filter.includes('37.16'), false);
	// Raw content duration (36.272525) must never appear as a trim/duration or -t target.
	assert.equal(filter.includes('trim=duration=36.272525'), false);
	assert.equal(args.includes('36.272525'), false);
});

test('regression: trimStart assertion guards against the parameter drifting from segments[0]', async () => {
	assert.ifError(loadError);
	// trimStart defaults to segments[0].start_seconds in production, so the
	// intro adelay is always 0 ms. The assertion cannot fire from fixture data
	// alone — RED only comes from injecting trimStart = 0, which simulates a
	// future code change that removes the trim. This is a regression guard, not
	// a data-driven check. It does NOT close FAIL 2.
	const baseFixture = {
		captureFile: 'capture-fitted/walkthrough.webm',
		narrationFiles: [
			{ id: 'intro', file: 'narration/intro.wav' },
			{ id: 'drag-assist', file: 'narration/drag-assist.wav' },
			{ id: 'outro', file: 'narration/outro.wav' },
		],
		timings: {
			recording: {
				basename: 'walkthrough.webm',
				bytes: 2048,
				duration_seconds: 36.272525,
				container_duration_seconds: 37.16,
			},
			segments: [
				{ id: 'intro', start_seconds: 4.419304 },
				{ id: 'drag-assist', start_seconds: 23.785 },
				{ id: 'outro', start_seconds: 32.14 },
			],
		},
		outputFile: 'mux/changedrop.mp4',
	};
	// GREEN: default trimStart equals segments[0].start_seconds → adelay[0] = 0 ms, passes.
	assert.doesNotThrow(() => mux.buildFfmpegArguments(baseFixture));
	// RED: injecting trimStart = 0 makes the intro adelay 4419 ms (> 2000 ms bound).
	assert.throws(
		() => mux.buildFfmpegArguments({ ...baseFixture, trimStart: 0 }),
		/adelay.*4419.*ms.*exceeds.*2000.*ms dead-air bound/i,
	);
});

test('review blocker: ffmpeg trims the capture lead-in and uses the content duration minus S', async () => {
	assert.ifError(loadError);
	const args = mux.buildFfmpegArguments({
		captureFile: 'capture-fitted/walkthrough.webm',
		narrationFiles: [{ id: 'intro', file: 'narration/intro.wav' }],
		timings: {
			recording: {
				basename: 'walkthrough.webm',
				bytes: 512,
				duration_seconds: 22.543,
				container_duration_seconds: 23.48,
			},
			segments: [{ id: 'intro', start_seconds: 0.4 }],
		},
		outputFile: 'mux/changedrop.mp4',
	});
	assert.match(args.join(' '), /trim=start=0\.4:duration=22\.143/);
	assert.equal(args[args.indexOf('-t') + 1], '22.143');
	assert.equal(args.join(' ').includes('trim=duration=23.48'), false);
	assert.equal(args.join(' ').includes('trim=duration=22.543'), false);
});

test('case M1: output duration must equal the fitted capture within the stated tolerance', async () => {
	assert.ifError(loadError);
	assert.equal(mux.OUTPUT_DURATION_TOLERANCE_SECONDS, 0.5);
	const observations = await fixture('mux-media-observations.json');
	assert.equal(mux.assertMuxMediaGates({
		captureContentDurationSeconds: 4.1,
		captureContainerDurationSeconds: 5.02,
		captureProbe: observations.capture,
		outputProbe: observations.output,
	}), true);
	const tooLong = structuredClone(observations.output);
	tooLong.duration_seconds = 4.601;
	assert.throws(() => mux.assertMuxMediaGates({
		captureContentDurationSeconds: 4.1,
		captureContainerDurationSeconds: 5.02,
		captureProbe: observations.capture,
		outputProbe: tooLong,
	}), /output duration.*4\.601.*capture content.*4\.100.*tolerance.*0\.500/i);
});

test('case M2: mux output contains exactly one video and one audio stream', async () => {
	assert.ifError(loadError);
	const observations = await fixture('mux-media-observations.json');
	for (const streams of [
		[{ codec_type: 'video' }],
		[{ codec_type: 'video' }, { codec_type: 'audio' }, { codec_type: 'audio' }],
		[{ codec_type: 'video' }, { codec_type: 'audio' }, { codec_type: 'subtitle' }],
	]) {
		const outputProbe = { ...observations.output, streams };
		assert.throws(() => mux.assertMuxMediaGates({
			captureContentDurationSeconds: 4.1,
			captureContainerDurationSeconds: 5.02,
			captureProbe: observations.capture,
			outputProbe,
		}), /exactly one audio and one video stream/i);
	}
});

test('case M3: substituted narration fails both delivered-file and natural-fit SHA-256 gates', async (t) => {
	assert.ifError(loadError);
	const run = await prepareRun(t);
	const observations = await fixture('mux-media-observations.json');
	let muxCalls = 0;
	await writeFile(path.join(run.narrationDir, 'intro.wav'), wavBytes(0.72), { mode: 0o600 });
	await assert.rejects(mux.main({
		env: { ...process.env, EZHUD_CHANGEDROP_ROOT: run.root },
		argv: [
			'--capture', 'release-1/synthetic-run/capture-fitted',
			'--narration', 'release-1/synthetic-run/narration',
			'--out', 'release-1/synthetic-run/mux',
		],
		cwd: repo,
		probe: fixtureProbe(observations),
		muxer: async () => { muxCalls += 1; },
	}), /intro.*sha-?256|sha-?256.*intro|hash.*intro/i);
	assert.equal(muxCalls, 0);

	await writeFile(path.join(run.narrationDir, 'intro.wav'), wavBytes(0.71), { mode: 0o600 });
	const fit = JSON.parse(await readFile(path.join(run.narrationDir, 'fit.json'), 'utf8'));
	fit.segments[0].audio.sha256 = hashBytes('substituted-natural-render');
	await writeFile(path.join(run.narrationDir, 'fit.json'), `${JSON.stringify(fit, null, 2)}\n`, { mode: 0o600 });
	await assert.rejects(mux.main({
		env: { ...process.env, EZHUD_CHANGEDROP_ROOT: run.root },
		argv: [
			'--capture', 'release-1/synthetic-run/capture-fitted',
			'--narration', 'release-1/synthetic-run/narration',
			'--out', 'release-1/synthetic-run/mux',
		],
		cwd: repo,
		probe: fixtureProbe(observations),
		muxer: async () => { muxCalls += 1; },
	}), /natural.*sha-?256.*intro|intro.*natural.*sha-?256|fit.*hash.*intro/i);
	assert.equal(muxCalls, 0);
});

test('case manifest: offline fixture mux emits a private changedrop-manifest/1 in the run root', async (t) => {
	assert.ifError(loadError);
	const run = await prepareRun(t);
	const observations = await fixture('mux-media-observations.json');
	let muxCalls = 0;
	let plan;
	const manifest = await mux.main({
		env: { ...process.env, EZHUD_CHANGEDROP_ROOT: run.root },
		argv: [
			'--capture', 'release-1/synthetic-run/capture-fitted',
			'--narration', 'release-1/synthetic-run/narration',
			'--out', 'release-1/synthetic-run/mux',
		],
		cwd: repo,
		probe: fixtureProbe(observations),
		muxer: async (value) => {
			muxCalls += 1;
			plan = value;
			await fakeMuxer(value);
		},
		stdout: () => {},
	});
	assert.equal(muxCalls, 1);
	assert.deepEqual(plan.timings.segments.map((entry) => entry.start_seconds), [0.4, 1.12, 3.01]);
	assert.match(plan.args.join(' '), /trim=start=0\.4:duration=3\.7/);
	assert.equal(plan.args.join(' ').includes('trim=duration=5.02'), false);
	assert.equal(plan.args.join(' ').includes('trim=duration=4.1'), false);
	assert.match(plan.args.join(' '), /adelay=0:all=1/);
	assert.match(plan.args.join(' '), /adelay=720:all=1/);
	assert.match(plan.args.join(' '), /adelay=2610:all=1/);
	assert.deepEqual(await readdir(path.join(run.runRoot, 'mux')), ['changedrop.mp4']);
	const manifestPath = path.join(run.runRoot, 'manifest.json');
	assert.deepEqual(JSON.parse(await readFile(manifestPath, 'utf8')), manifest);
	assert.equal((await stat(manifestPath)).mode & 0o777, 0o600);
	assert.equal((await stat(path.join(run.runRoot, 'mux'))).mode & 0o777, 0o700);
	assert.equal(manifest.schema_version, 'changedrop-manifest/1');
	assert.equal(manifest.release, 'release-1');
	assert.equal(manifest.run_id, 'synthetic-run');
	assert.equal(manifest.decision, 'render');
	assert.equal(manifest.blocked_reason, null);
	assert.deepEqual(manifest.publish, { state: 'withheld', destination: null });
	assert.equal(manifest.capture.basename, 'walkthrough.webm');
	assert.equal(manifest.capture.duration_s, 4.1);
	assert.equal(manifest.output.duration_s, 4.1);
	assert.equal(manifest.output.basename, 'changedrop.mp4');
	assert.deepEqual(manifest.segments.map((entry) => entry.narration.sha256),
		run.narration.segments.map((entry) => entry.audio.sha256));
	const schema = JSON.parse(await readFile(
		path.join(repo, 'tools', 'changedrop', 'schemas', 'changedrop-manifest.v1.json'), 'utf8'));
	assert.deepEqual(schemaErrors(manifest, schema), []);
	for (const value of stringsIn(manifest)) {
		assert.equal(path.isAbsolute(value), false, `absolute path escaped into manifest: ${JSON.stringify(value)}`);
		assert.doesNotMatch(value, /\/home\/|\/Users\/|\$USER\b|file:\/\//i);
		if (hostname()) assert.equal(value.includes(hostname()), false, 'hostname escaped into manifest');
	}
	assert.equal(JSON.stringify(manifest).includes('audio.path'), false);
});

test('supporting contract: fitted-only paths, npm wiring, bounded local tools, and no publishing path', async (t) => {
	assert.ifError(loadError);
	const run = await prepareRun(t);
	const observations = await fixture('mux-media-observations.json');
	let muxCalls = 0;
	await assert.rejects(mux.main({
		env: { ...process.env, EZHUD_CHANGEDROP_ROOT: run.root },
		argv: [
			'--capture', 'release-1/synthetic-run/capture',
			'--narration', 'release-1/synthetic-run/narration',
			'--out', 'release-1/synthetic-run/mux',
		],
		cwd: repo,
		probe: fixtureProbe(observations),
		muxer: async () => { muxCalls += 1; },
	}), /capture-fitted|fitted capture/i);
	assert.equal(muxCalls, 0);

	const packageJson = JSON.parse(await readFile(path.join(repo, 'package.json'), 'utf8'));
	assert.equal(packageJson.scripts?.['changedrop:mux'], 'node tools/changedrop/mux.mjs');
	const source = await readFile(path.join(repo, 'tools', 'changedrop', 'mux.mjs'), 'utf8');
	assert.doesNotMatch(source, /discord|webhook|channel_id|allowed_mentions/i);
	assert.doesNotMatch(source, /\bfetch\s*\(|https?:\/\//i);
	assert.match(source, /spawn\('ffmpeg'/);
	assert.match(source, /spawn\('ffprobe'/);

	const env = { ...process.env };
	delete env.EZHUD_CHANGEDROP_ROOT;
	await assert.rejects(execFileAsync(process.execPath, [
		path.join(repo, 'tools', 'changedrop', 'mux.mjs'),
		'--capture', 'release-1/synthetic-run/capture-fitted',
		'--narration', 'release-1/synthetic-run/narration',
		'--out', 'release-1/synthetic-run/mux',
	], { cwd: repo, env }), (error) => {
		assert.equal(error.code, 1);
		assert.match(error.stderr, /EZHUD_CHANGEDROP_ROOT/);
		return true;
	});
	assert.equal(muxCalls, 0);
});
