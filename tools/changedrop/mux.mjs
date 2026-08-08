#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
	chmod,
	lstat,
	mkdir,
	readFile,
	rename,
	rm,
	writeFile,
} from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import {
	CONTAINER_CONTENT_EPSILON_SECONDS,
	validateCaptureScript,
} from './capture.mjs';
import {
	assertNarrationFitsCapture,
	inspectDeliveredWav,
	validateNarrationManifest,
	validateTimingReceipt,
} from './voice.mjs';

const MANIFEST_SCHEMA_VERSION = 'changedrop-manifest/1';
const FIT_SCHEMA_VERSION = 'changedrop-voice-fit/1';
const ROOT_VARIABLE = 'EZHUD_CHANGEDROP_ROOT';
const CAPTURE_DIRECTORY = 'capture-fitted';
const NARRATION_DIRECTORY = 'narration';
const OUTPUT_DIRECTORY = 'mux';
const CAPTURE_BASENAME = 'walkthrough.webm';
const OUTPUT_BASENAME = 'changedrop.mp4';
const MAX_TOOL_OUTPUT_BYTES = 1_048_576;
const PROBE_TIMEOUT_MS = 60_000;
const MUX_TIMEOUT_MS = 600_000;

// MP4 container rounding and encoder flushing can move the reported edge by a
// few milliseconds. Half a second is the already-reviewed changedrop timing
// tolerance: large enough for that boundary, too small to hide a lost segment.
export const OUTPUT_DURATION_TOLERANCE_SECONDS = 0.5;

function exactObject(value, expectedKeys, at) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${at} must be an object.`);
	const expected = new Set(expectedKeys);
	for (const key of Object.keys(value)) {
		if (!expected.has(key)) throw new Error(`${at} has unexpected field "${key}".`);
	}
	for (const key of expectedKeys) {
		if (!(key in value)) throw new Error(`${at} is missing field "${key}".`);
	}
}

function nonEmptyString(value, at) {
	if (typeof value !== 'string' || !value.trim()) throw new Error(`${at} must be a non-empty string.`);
}

function finiteNumber(value, at, { minimum = null, positive = false } = {}) {
	if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${at} must be finite and numeric.`);
	if (positive && value <= 0) throw new Error(`${at} must be positive.`);
	if (minimum !== null && value < minimum) throw new Error(`${at} must be at least ${minimum}.`);
}

function stringsIn(value) {
	if (typeof value === 'string') return [value];
	if (Array.isArray(value)) return value.flatMap(stringsIn);
	if (value && typeof value === 'object') return Object.values(value).flatMap(stringsIn);
	return [];
}

function privacyChecked(value, subject) {
	const host = hostname();
	const user = process.env.USER || process.env.USERNAME || '';
	const privateLocation = /\/home\/|\/Users\/|\$USER\b|file:\/\//i;
	const absolutePath = /(^|[\s"'(=])\/(?!\/)[^\s"')]+/;
	const windowsAbsolutePath = /(^|[\s"'(=])(?:[a-z]:[\\/]|\\\\)[^\s"')]+/i;
	const unsafe = stringsIn(value).some((entry) => privateLocation.test(entry)
		|| absolutePath.test(entry) || windowsAbsolutePath.test(entry)
		|| (host && entry.includes(host)) || (user && entry.includes(user)));
	if (unsafe) throw new Error(`${subject} contains private location or host data.`);
	return value;
}

function canonical(value) {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === 'object') {
		return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
	}
	return value;
}

function hashBytes(value) {
	return createHash('sha256').update(value).digest('hex');
}

function contentHash(value) {
	return hashBytes(JSON.stringify(canonical(value)));
}

async function readJsonRegular(file, subject) {
	let metadata;
	try {
		metadata = await lstat(file);
	} catch {
		throw new Error(`${subject} is missing.`);
	}
	if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
		throw new Error(`${subject} must be an owner-only regular file.`);
	}
	try {
		return JSON.parse(await readFile(file, 'utf8'));
	} catch {
		throw new Error(`${subject} is malformed.`);
	}
}

async function verifiedFile(file, subject, expectedBytes = null, { privateFile = true } = {}) {
	let metadata;
	try {
		metadata = await lstat(file);
	} catch {
		throw new Error(`${subject} is missing.`);
	}
	if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0
		|| (privateFile && (metadata.mode & 0o077) !== 0)) {
		throw new Error(`${subject} must be a non-empty ${privateFile ? 'owner-only ' : ''}regular file.`);
	}
	if (expectedBytes !== null && metadata.size !== expectedBytes) {
		throw new Error(`${subject} byte length differs from its receipt.`);
	}
	const bytes = await readFile(file);
	if (bytes.length !== metadata.size) throw new Error(`${subject} changed while it was being verified.`);
	return { bytes: metadata.size, sha256: hashBytes(bytes), value: bytes };
}

function validateHash(value, at) {
	if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`${at} must be a SHA-256 digest.`);
}

function validateNaturalFitReceipt({ fit, script, narration }) {
	exactObject(fit, ['schema_version', 'project', 'voice_profile', 'script', 'segments'], 'Changedrop natural fit receipt');
	if (fit.schema_version !== FIT_SCHEMA_VERSION || fit.project !== 'ezhud' || fit.voice_profile !== 'xeri-en-v1') {
		throw new Error('Changedrop natural fit receipt identity is invalid.');
	}
	exactObject(fit.script, ['basename', 'sha256'], 'Changedrop natural fit script');
	if (fit.script.basename !== 'script.json') throw new Error('Changedrop natural fit script basename is invalid.');
	validateHash(fit.script.sha256, 'Changedrop natural fit script hash');
	if (fit.script.sha256 !== contentHash(script)) throw new Error('Changedrop natural fit script hash is stale.');
	if (!Array.isArray(fit.segments) || fit.segments.length !== script.segments.length
		|| fit.segments.length !== narration.segments.length) {
		throw new Error('Changedrop natural fit receipt does not cover the complete narration set.');
	}
	for (const [index, entry] of fit.segments.entries()) {
		exactObject(entry, [
			'id', 'kind', 'surface', 'request_id', 'request_hash', 'status', 'rerendered',
			'audio', 'natural_duration_seconds', 'measured_window_seconds', 'fixed_action_seconds',
			'previous_padding_ms', 'fitted_padding_ms', 'fitted_hold_durations_ms',
			'projected_duration_seconds',
		], `Changedrop natural fit segment ${index + 1}`);
		const scriptSegment = script.segments[index];
		const delivered = narration.segments[index];
		if (entry.id !== scriptSegment.id || entry.kind !== scriptSegment.kind || entry.surface !== scriptSegment.surface
			|| delivered.id !== scriptSegment.id) {
			throw new Error(`Changedrop natural fit order is stale at segment "${scriptSegment.id}".`);
		}
		if (entry.request_id !== delivered.request_id || entry.request_hash !== delivered.request_hash
			|| entry.status !== delivered.status || entry.rerendered !== delivered.rerendered) {
			throw new Error(`Changedrop natural fit request provenance differs for segment "${entry.id}".`);
		}
		exactObject(entry.audio, ['basename', 'sha256'], `Changedrop natural fit audio for "${entry.id}"`);
		validateHash(entry.audio.sha256, `Changedrop natural fit audio hash for "${entry.id}"`);
		if (entry.audio.basename !== delivered.audio.basename || entry.audio.sha256 !== delivered.audio.sha256) {
			throw new Error(`Natural narration SHA-256 differs from the delivered artifact for segment "${entry.id}".`);
		}
		finiteNumber(entry.natural_duration_seconds, `Changedrop natural fit duration for "${entry.id}"`, { positive: true });
		finiteNumber(entry.measured_window_seconds, `Changedrop measured window for "${entry.id}"`, { positive: true });
		finiteNumber(entry.fixed_action_seconds, `Changedrop fixed action time for "${entry.id}"`, { minimum: 0 });
		finiteNumber(entry.projected_duration_seconds, `Changedrop projected duration for "${entry.id}"`, { positive: true });
		if (Math.abs(entry.natural_duration_seconds - delivered.duration_seconds) > 1 / 24_000) {
			throw new Error(`Natural narration duration differs from the delivered artifact for segment "${entry.id}".`);
		}
		if (!Number.isInteger(entry.previous_padding_ms) || entry.previous_padding_ms < 100
			|| !Number.isInteger(entry.fitted_padding_ms) || entry.fitted_padding_ms < 100
			|| !Array.isArray(entry.fitted_hold_durations_ms) || entry.fitted_hold_durations_ms.length === 0
			|| entry.fitted_hold_durations_ms.some((duration) => !Number.isInteger(duration) || duration < 100 || duration > 5_000)
			|| entry.fitted_hold_durations_ms.reduce((sum, duration) => sum + duration, 0) !== entry.fitted_padding_ms) {
			throw new Error(`Changedrop narration padding receipt is invalid for segment "${entry.id}".`);
		}
		const scriptedPadding = scriptSegment.walkthrough
			.filter((step) => step.fit === 'narration')
			.map((step) => step.duration_ms);
		if (JSON.stringify(scriptedPadding) !== JSON.stringify(entry.fitted_hold_durations_ms)) {
			throw new Error(`Changedrop fitted script padding is stale for segment "${entry.id}".`);
		}
		const projected = entry.fixed_action_seconds + entry.fitted_padding_ms / 1000;
		if (Math.abs(projected - entry.projected_duration_seconds) > 0.001) {
			throw new Error(`Changedrop projected fit is inconsistent for segment "${entry.id}".`);
		}
	}
	return privacyChecked(fit, 'Changedrop natural fit receipt');
}

async function verifyDeliveredNarration({ directory, script, timings, narration, fit }) {
	validateCaptureScript(script);
	validateTimingReceipt(script, timings);
	validateNarrationManifest(narration, script);
	validateNaturalFitReceipt({ fit, script, narration });
	const files = [];
	for (const entry of narration.segments) {
		const file = path.join(directory, entry.audio.basename);
		const artifact = await verifiedFile(file, `Delivered narration for segment "${entry.id}"`);
		if (artifact.sha256 !== entry.audio.sha256) {
			throw new Error(`Delivered narration SHA-256 differs for segment "${entry.id}".`);
		}
		const wav = inspectDeliveredWav(artifact.value);
		if (Math.abs(wav.duration_seconds - entry.duration_seconds) > 1 / wav.sample_rate) {
			throw new Error(`Delivered narration duration differs for segment "${entry.id}".`);
		}
		files.push({ id: entry.id, file, sha256: artifact.sha256, duration_seconds: wav.duration_seconds });
	}
	assertNarrationFitsCapture({ script, timings, narration });
	return files;
}

function validateProbe(value, subject) {
	exactObject(value, ['duration_seconds', 'streams'], subject);
	finiteNumber(value.duration_seconds, `${subject} duration`, { positive: true });
	if (!Array.isArray(value.streams)) throw new Error(`${subject} streams must be an array.`);
	for (const [index, stream] of value.streams.entries()) {
		exactObject(stream, ['codec_type'], `${subject} stream ${index + 1}`);
		if (!['audio', 'video', 'subtitle', 'data', 'attachment', 'unknown'].includes(stream.codec_type)) {
			throw new Error(`${subject} stream type is invalid.`);
		}
	}
	return value;
}

export function assertMuxMediaGates({
	captureContentDurationSeconds,
	captureContainerDurationSeconds,
	captureProbe,
	outputProbe,
} = {}) {
	finiteNumber(captureContentDurationSeconds, 'Fitted capture content duration', { positive: true });
	finiteNumber(captureContainerDurationSeconds, 'Fitted capture container duration', { positive: true });
	if (captureContainerDurationSeconds + CONTAINER_CONTENT_EPSILON_SECONDS < captureContentDurationSeconds) {
		throw new Error('Fitted capture container duration is shorter than measured content duration.');
	}
	validateProbe(captureProbe, 'Fitted capture probe');
	validateProbe(outputProbe, 'Changedrop output probe');
	const captureDelta = Math.abs(captureProbe.duration_seconds - captureContainerDurationSeconds);
	if (captureDelta > OUTPUT_DURATION_TOLERANCE_SECONDS) {
		throw new Error(`Fitted capture probe duration ${captureProbe.duration_seconds.toFixed(3)}s differs from container receipt ${captureContainerDurationSeconds.toFixed(3)}s beyond tolerance ${OUTPUT_DURATION_TOLERANCE_SECONDS.toFixed(3)}s.`);
	}
	const outputDelta = Math.abs(outputProbe.duration_seconds - captureContentDurationSeconds);
	if (outputDelta > OUTPUT_DURATION_TOLERANCE_SECONDS) {
		throw new Error(`Mux output duration ${outputProbe.duration_seconds.toFixed(3)}s differs from fitted capture content ${captureContentDurationSeconds.toFixed(3)}s beyond tolerance ${OUTPUT_DURATION_TOLERANCE_SECONDS.toFixed(3)}s.`);
	}
	const captureVideos = captureProbe.streams.filter((stream) => stream.codec_type === 'video').length;
	if (captureVideos !== 1) throw new Error('Fitted capture must contain exactly one video stream.');
	const outputVideos = outputProbe.streams.filter((stream) => stream.codec_type === 'video').length;
	const outputAudio = outputProbe.streams.filter((stream) => stream.codec_type === 'audio').length;
	if (outputProbe.streams.length !== 2 || outputVideos !== 1 || outputAudio !== 1) {
		throw new Error('Mux output must contain exactly one audio and one video stream.');
	}
	return true;
}

function decimalSeconds(value) {
	return Number(value.toFixed(6)).toString();
}

export function buildFfmpegArguments({ captureFile, narrationFiles, timings, outputFile } = {}) {
	nonEmptyString(captureFile, 'Fitted capture file');
	nonEmptyString(outputFile, 'Changedrop output file');
	if (!Array.isArray(narrationFiles) || narrationFiles.length === 0
		|| !timings || !Array.isArray(timings.segments)
		|| narrationFiles.length !== timings.segments.length) {
		throw new Error('Complete narration files and fitted timings are required to build the mux.');
	}
	const args = ['-y', '-nostdin', '-hide_banner', '-loglevel', 'error', '-i', captureFile];
	for (const narration of narrationFiles) {
		nonEmptyString(narration.file, 'Delivered narration file');
		args.push('-i', narration.file);
	}
	// The capture recording starts before the first segment. Trim everything
	// before the intro so the output begins at the first spoken word.
	// S is the measured offset from capture start to the intro segment start;
	// the four coupled mux parameters (trim, adelay, apad, -t) all shift by S.
	const trimStart = timings.segments[0].start_seconds;
	const trimmedDuration = decimalSeconds(timings.recording.duration_seconds - trimStart);
	const filters = [`[0:v]trim=start=${decimalSeconds(trimStart)}:duration=${trimmedDuration},setpts=PTS-STARTPTS[muxvideo]`];
	for (const [index, segment] of timings.segments.entries()) {
		finiteNumber(segment.start_seconds, `Mux timing start for "${segment.id}"`, { minimum: 0 });
		const adjustedDelay = Math.round((segment.start_seconds - trimStart) * 1000);
		filters.push(`[${index + 1}:a]asetpts=PTS-STARTPTS,adelay=${adjustedDelay}:all=1[segment${index}]`);
	}
	const labels = timings.segments.map((_segment, index) => `[segment${index}]`).join('');
	filters.push(`${labels}amix=inputs=${timings.segments.length}:duration=longest:dropout_transition=0:normalize=0,apad=whole_dur=${trimmedDuration}[muxaudio]`);
	args.push(
		'-filter_complex', filters.join(';'),
		'-map', '[muxvideo]',
		'-map', '[muxaudio]',
		'-c:v', 'libx264',
		'-preset', 'medium',
		'-crf', '18',
		'-pix_fmt', 'yuv420p',
		'-c:a', 'aac',
		'-b:a', '192k',
		'-movflags', '+faststart',
		'-t', trimmedDuration,
		outputFile,
	);
	return args;
}

function captureProcess(child, { timeoutMs, failure }) {
	return new Promise((resolve, reject) => {
		let stdout = '';
		let stderrBytes = 0;
		let overflow = false;
		let settled = false;
		let timer;
		const finish = (callback, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			callback(value);
		};
		child.stdout?.on('data', (chunk) => {
			if (Buffer.byteLength(stdout) + chunk.length > MAX_TOOL_OUTPUT_BYTES) overflow = true;
			else stdout += chunk.toString('utf8');
		});
		child.stderr?.on('data', (chunk) => {
			stderrBytes += chunk.length;
			if (stderrBytes > MAX_TOOL_OUTPUT_BYTES) overflow = true;
		});
		child.once('error', () => finish(reject, new Error(`${failure} could not start.`)));
		child.once('close', (exitCode) => {
			if (overflow) return finish(reject, new Error(`${failure} output exceeded its bound.`));
			if (exitCode !== 0) return finish(reject, new Error(`${failure} failed with exit code ${String(exitCode)}.`));
			return finish(resolve, stdout);
		});
		timer = setTimeout(() => {
			child.kill('SIGKILL');
			finish(reject, new Error(`${failure} exceeded its bounded runtime.`));
		}, timeoutMs);
		timer.unref?.();
	});
}

export async function probeMedia(file) {
	const child = spawn('ffprobe', [
		'-v', 'error',
		'-show_entries', 'format=duration:stream=codec_type',
		'-of', 'json',
		file,
	], { stdio: ['ignore', 'pipe', 'pipe'] });
	const stdout = await captureProcess(child, { timeoutMs: PROBE_TIMEOUT_MS, failure: 'ffprobe' });
	let result;
	try {
		result = JSON.parse(stdout);
	} catch {
		throw new Error('ffprobe returned malformed JSON.');
	}
	const duration = Number(result?.format?.duration);
	const streams = Array.isArray(result?.streams)
		? result.streams.map((stream) => ({ codec_type: String(stream.codec_type ?? 'unknown') }))
		: [];
	return validateProbe({ duration_seconds: duration, streams }, 'Media probe');
}

export async function runFfmpeg({ args } = {}) {
	if (!Array.isArray(args) || args.length === 0) throw new Error('ffmpeg arguments are incomplete.');
	const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
	await captureProcess(child, { timeoutMs: MUX_TIMEOUT_MS, failure: 'ffmpeg mux' });
}

export function buildManifest({
	release,
	runId,
	sourceNoteHash,
	script,
	timings,
	narration,
	captureHash,
	outputHash,
	outputDurationSeconds,
} = {}) {
	if (typeof release !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(release)
		|| typeof runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
		throw new Error('Changedrop release or run id is unsafe.');
	}
	validateHash(sourceNoteHash, 'Changedrop source note hash');
	validateHash(captureHash, 'Changedrop capture hash');
	validateHash(outputHash, 'Changedrop output hash');
	finiteNumber(outputDurationSeconds, 'Changedrop output duration', { positive: true });
	if (!script || !timings || !narration || script.segments.length !== timings.segments.length
		|| script.segments.length !== narration.segments.length) {
		throw new Error('Changedrop manifest inputs are incomplete.');
	}
	const segments = script.segments.map((segment, index) => {
		const timing = timings.segments[index];
		const voice = narration.segments[index];
		return {
			id: segment.id,
			surface: segment.surface,
			script_sha256: contentHash(segment),
			measured_start_s: timing.start_seconds,
			measured_duration_s: timing.duration_seconds,
			narration: {
				basename: voice.audio.basename,
				sha256: voice.audio.sha256,
				duration_s: voice.duration_seconds,
				voice_profile: narration.voice_profile,
				profile_revision: voice.profile_revision,
				request_status: voice.status,
				engine: { ...voice.engine },
			},
		};
	});
	return privacyChecked({
		schema_version: MANIFEST_SCHEMA_VERSION,
		release,
		run_id: runId,
		source_note: { path: `docs/${release}/NOTES.md`, sha256: sourceNoteHash },
		decision: 'render',
		blocked_reason: null,
		segments,
		capture: {
			basename: CAPTURE_BASENAME,
			sha256: captureHash,
			duration_s: timings.recording.duration_seconds,
		},
		output: {
			basename: OUTPUT_BASENAME,
			sha256: outputHash,
			duration_s: outputDurationSeconds,
		},
		publish: { state: 'withheld', destination: null },
	}, 'Changedrop manifest');
}

function parseArguments(argv) {
	const values = new Map();
	for (let index = 0; index < argv.length; index += 1) {
		const name = argv[index];
		if (!['--capture', '--narration', '--out'].includes(name)) throw new Error(`Unknown changedrop mux argument: ${name}`);
		const value = argv[index + 1];
		if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
		if (values.has(name)) throw new Error(`${name} may be supplied only once.`);
		values.set(name, value);
		index += 1;
	}
	for (const name of ['--capture', '--narration', '--out']) {
		if (!values.has(name)) throw new Error(`${name} is required.`);
	}
	return {
		capture: values.get('--capture'),
		narration: values.get('--narration'),
		out: values.get('--out'),
	};
}

function pathInsideRoot(root, requested) {
	const resolved = path.resolve(root, requested);
	return resolved.startsWith(`${root}${path.sep}`) ? resolved : null;
}

async function requirePrivateDirectory(directory, subject) {
	let metadata;
	try {
		metadata = await lstat(directory);
	} catch {
		throw new Error(`${subject} is missing.`);
	}
	if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
		throw new Error(`${subject} must be an owner-only directory.`);
	}
}

async function ensurePrivateParents(root, directory) {
	const relative = path.relative(root, directory);
	let cursor = root;
	for (const part of relative.split(path.sep).filter(Boolean)) {
		cursor = path.join(cursor, part);
		try {
			await mkdir(cursor, { mode: 0o700 });
		} catch (error) {
			if (error?.code !== 'EEXIST') throw error;
		}
		const metadata = await lstat(cursor);
		if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Mux output parent is not a private directory.');
		await chmod(cursor, 0o700);
	}
}

function runIdentity(root, captureDirectory, narrationDirectory, outputDirectory) {
	const runRoot = path.dirname(outputDirectory);
	if (path.basename(captureDirectory) !== CAPTURE_DIRECTORY
		|| path.basename(narrationDirectory) !== NARRATION_DIRECTORY
		|| path.basename(outputDirectory) !== OUTPUT_DIRECTORY
		|| path.dirname(captureDirectory) !== runRoot || path.dirname(narrationDirectory) !== runRoot) {
		throw new Error('Mux requires capture-fitted, narration, and mux directories from the same run.');
	}
	const components = path.relative(root, runRoot).split(path.sep).filter(Boolean);
	if (components.length !== 2 || !/^[a-z0-9][a-z0-9._-]*$/.test(components[0])
		|| !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(components[1])) {
		throw new Error('Mux run must use the private <release>/<run-id> layout.');
	}
	privacyChecked({ release: components[0], run_id: components[1] }, 'Changedrop run identity');
	return { runRoot, release: components[0], runId: components[1] };
}

export async function main({
	env = process.env,
	argv = process.argv.slice(2),
	cwd = process.cwd(),
	probe = probeMedia,
	muxer = runFfmpeg,
	stdout = console.log,
} = {}) {
	if (!env[ROOT_VARIABLE]?.trim()) throw new Error(`${ROOT_VARIABLE} is required.`);
	const root = path.resolve(env[ROOT_VARIABLE]);
	let rootMetadata;
	try {
		rootMetadata = await lstat(root);
	} catch {
		throw new Error(`${ROOT_VARIABLE} must name an existing owner-only directory.`);
	}
	if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink() || (rootMetadata.mode & 0o077) !== 0) {
		throw new Error(`${ROOT_VARIABLE} must name an existing owner-only directory.`);
	}
	if (typeof probe !== 'function' || typeof muxer !== 'function') throw new Error('Mux media tools must be functions.');
	const args = parseArguments(argv);
	const captureDirectory = pathInsideRoot(root, args.capture);
	const narrationDirectory = pathInsideRoot(root, args.narration);
	const outputDirectory = pathInsideRoot(root, args.out);
	if (!captureDirectory) throw new Error('--capture must resolve inside EZHUD_CHANGEDROP_ROOT.');
	if (!narrationDirectory) throw new Error('--narration must resolve inside EZHUD_CHANGEDROP_ROOT.');
	if (!outputDirectory) throw new Error('--out must resolve inside EZHUD_CHANGEDROP_ROOT.');
	const identity = runIdentity(root, captureDirectory, narrationDirectory, outputDirectory);
	await ensurePrivateParents(root, identity.runRoot);
	await requirePrivateDirectory(captureDirectory, 'Fitted capture directory');
	await requirePrivateDirectory(narrationDirectory, 'Complete narration directory');

	let timings;
	try {
		timings = await readJsonRegular(path.join(captureDirectory, 'timings.json'), 'Fitted capture timings');
	} catch (error) {
		throw new Error(`Fitted capture is incomplete: ${error.message}`);
	}
	let script;
	let narration;
	let fit;
	try {
		[script, narration, fit] = await Promise.all([
			readJsonRegular(path.join(narrationDirectory, 'script.json'), 'Fitted narration script'),
			readJsonRegular(path.join(narrationDirectory, 'narration.json'), 'Delivered narration manifest'),
			readJsonRegular(path.join(narrationDirectory, 'fit.json'), 'Natural narration fit receipt'),
		]);
	} catch (error) {
		throw new Error(`Complete locally validated narration is missing: ${error.message}`);
	}

	const captureFile = path.join(captureDirectory, CAPTURE_BASENAME);
	const captureArtifact = await verifiedFile(
		captureFile,
		'Fitted capture recording',
		timings?.recording?.bytes ?? null,
	);
	const narrationFiles = await verifyDeliveredNarration({
		directory: narrationDirectory,
		script,
		timings,
		narration,
		fit,
	});
	const captureProbe = await probe(captureFile);
	validateProbe(captureProbe, 'Fitted capture probe');
	if (Math.abs(captureProbe.duration_seconds - timings.recording.container_duration_seconds)
		> OUTPUT_DURATION_TOLERANCE_SECONDS) {
		throw new Error('Fitted capture probe duration differs from its container timing receipt beyond tolerance.');
	}
	if (captureProbe.streams.filter((stream) => stream.codec_type === 'video').length !== 1) {
		throw new Error('Fitted capture must contain exactly one video stream.');
	}

	const notePath = path.join(cwd, 'docs', identity.release, 'NOTES.md');
	const sourceNote = await verifiedFile(
		notePath,
		`Canonical note for release "${identity.release}"`,
		null,
		{ privateFile: false },
	);
	const staging = `${outputDirectory}.staging-${process.pid}`;
	const stagedManifest = path.join(identity.runRoot, `.manifest.staging-${process.pid}.json`);
	await rm(staging, { recursive: true, force: true });
	await rm(stagedManifest, { force: true });
	await mkdir(staging, { mode: 0o700 });
	await chmod(staging, 0o700);
	try {
		const outputFile = path.join(staging, OUTPUT_BASENAME);
		const plan = {
			captureFile,
			narrationFiles,
			timings,
			outputFile,
			args: buildFfmpegArguments({ captureFile, narrationFiles, timings, outputFile }),
		};
		await muxer(plan);
		await chmod(outputFile, 0o600).catch(() => {});
		const outputArtifact = await verifiedFile(outputFile, 'Changedrop mux output');
		const outputProbe = await probe(outputFile);
		assertMuxMediaGates({
			captureContentDurationSeconds: timings.recording.duration_seconds,
			captureContainerDurationSeconds: timings.recording.container_duration_seconds,
			captureProbe,
			outputProbe,
		});
		const manifest = buildManifest({
			release: identity.release,
			runId: identity.runId,
			sourceNoteHash: sourceNote.sha256,
			script,
			timings,
			narration,
			captureHash: captureArtifact.sha256,
			outputHash: outputArtifact.sha256,
			outputDurationSeconds: outputProbe.duration_seconds,
		});
		await writeFile(stagedManifest, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
		await chmod(stagedManifest, 0o600);
		await rm(outputDirectory, { recursive: true, force: true });
		await rename(staging, outputDirectory);
		await chmod(outputDirectory, 0o700);
		await rename(stagedManifest, path.join(identity.runRoot, 'manifest.json'));
		await chmod(path.join(identity.runRoot, 'manifest.json'), 0o600);
		stdout(JSON.stringify(manifest));
		return manifest;
	} catch (error) {
		await rm(staging, { recursive: true, force: true });
		await rm(stagedManifest, { force: true });
		throw error;
	}
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
	main().catch((error) => {
		console.error(`changedrop mux: ${String(error.message ?? error)}`);
		process.exitCode = 1;
	});
}
