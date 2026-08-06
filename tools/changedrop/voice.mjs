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
	stat,
	writeFile,
} from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { validateCaptureScript } from './capture.mjs';

const SCRIPT_SCHEMA_VERSION = 'changedrop-script/1';
const TIMINGS_SCHEMA_VERSION = 'changedrop-timings/1';
const REQUEST_SCHEMA_VERSION = 'voice-order/1';
const OUTPUT_SCHEMA_VERSION = 'changedrop-narration/1';
const ROOT_VARIABLE = 'EZHUD_CHANGEDROP_ROOT';
const PROJECT = 'ezhud';
const VOICE_PROFILE = 'xeri-en-v1';
const MAX_IDENTICAL_ATTEMPTS = 3;
const ORDER_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_BYTES = 1_048_576;

export const DURATION_TOLERANCE_SECONDS = 0.5;

const ERROR_EXIT_CODES = Object.freeze({
	E_SCHEMA_INVALID: 2,
	E_UNKNOWN_FIELD: 2,
	E_PROJECT_NOT_ALLOWED: 3,
	E_PROFILE_UNKNOWN: 3,
	E_TEXT_UNSAFE: 4,
	E_TEXT_TOO_LONG: 4,
	E_OVERRIDE_INVALID: 4,
	E_REQUEST_ID_CONFLICT: 5,
	E_LOCK_TIMEOUT: 6,
	E_RENDER_FAILED: 7,
	E_ARTIFACT_INVALID: 8,
	E_DURATION_OUT_OF_TOLERANCE: 9,
	E_INTERNAL: 10,
});

const ERROR_POLICIES = Object.freeze({
	E_PROJECT_NOT_ALLOWED: Object.freeze({ action: 'stop-prerequisite', retry: false }),
	E_PROFILE_UNKNOWN: Object.freeze({ action: 'stop-prerequisite', retry: false }),
	E_SCHEMA_INVALID: Object.freeze({ action: 'request-builder-bug', retry: false }),
	E_UNKNOWN_FIELD: Object.freeze({ action: 'request-builder-bug', retry: false }),
	E_TEXT_UNSAFE: Object.freeze({ action: 'script-defect', retry: false }),
	E_TEXT_TOO_LONG: Object.freeze({ action: 'script-defect', retry: false }),
	E_OVERRIDE_INVALID: Object.freeze({ action: 'script-defect', retry: false }),
	E_DURATION_OUT_OF_TOLERANCE: Object.freeze({ action: 'reauthor-segment', retry: false }),
	E_REQUEST_ID_CONFLICT: Object.freeze({ action: 'request-builder-bug', retry: false }),
	E_LOCK_TIMEOUT: Object.freeze({ action: 'retry-identical', retry: true }),
	E_INTERNAL: Object.freeze({ action: 'retry-identical', retry: true }),
	E_RENDER_FAILED: Object.freeze({ action: 'stop-report', retry: false }),
	E_ARTIFACT_INVALID: Object.freeze({ action: 'stop-report', retry: false }),
});

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
	const privateLocation = /\/home\/|\/Users\/|\$USER\b|file:\/\//i;
	const absolutePath = /(^|[\s"'(=])\/(?!\/)[^\s"')]+/;
	const windowsAbsolutePath = /(^|[\s"'(=])(?:[a-z]:[\\/]|\\\\)[^\s"')]+/i;
	const unsafe = stringsIn(value).some((entry) => privateLocation.test(entry)
		|| absolutePath.test(entry) || windowsAbsolutePath.test(entry)
		|| (host && entry.includes(host)));
	if (unsafe) throw new Error(`${subject} contains private location data.`);
	return value;
}

function canonical(value) {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === 'object') {
		return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
	}
	return value;
}

function requestIdFor(effectiveOrder) {
	const digest = createHash('sha256').update(JSON.stringify(canonical(effectiveOrder))).digest('hex');
	return `ezhud-${digest.slice(0, 32)}`;
}

function machineAction(step) {
	const { instruction: _instruction, ...action } = step;
	return {
		...action,
		...(action.crop ? { crop: { ...action.crop } } : {}),
	};
}

function validateTimingReceipt(script, timings) {
	exactObject(timings, ['schema_version', 'recording', 'setup_actions', 'segments'], 'Changedrop timings');
	if (timings.schema_version !== TIMINGS_SCHEMA_VERSION) {
		throw new Error(`Changedrop timings must use ${TIMINGS_SCHEMA_VERSION}.`);
	}
	exactObject(timings.recording, ['basename', 'bytes', 'duration_seconds'], 'Changedrop timing recording');
	if (timings.recording.basename !== 'walkthrough.webm'
		|| !Number.isInteger(timings.recording.bytes) || timings.recording.bytes <= 0) {
		throw new Error('Changedrop timing recording is invalid.');
	}
	finiteNumber(timings.recording.duration_seconds, 'Changedrop recording duration', { positive: true });
	if (!Array.isArray(timings.setup_actions)
		|| JSON.stringify(timings.setup_actions) !== JSON.stringify(script.setup.map(machineAction))) {
		throw new Error('Changedrop timings setup action sequence is stale; capture the script again.');
	}
	if (!Array.isArray(timings.segments) || timings.segments.length !== script.segments.length) {
		throw new Error('Changedrop timings must contain exactly one entry per script segment.');
	}
	let previousStart = -1;
	let previousEnd = 0;
	for (const [index, timing] of timings.segments.entries()) {
		exactObject(timing, [
			'id', 'kind', 'surface', 'start_seconds', 'duration_seconds', 'actions', 'highlights',
		], `Changedrop timing segment ${index + 1}`);
		const segment = script.segments[index];
		if (timing.id !== segment.id || timing.kind !== segment.kind || timing.surface !== segment.surface) {
			throw new Error(`Changedrop timing segment order is stale at "${segment.id}"; capture the script again.`);
		}
		finiteNumber(timing.start_seconds, `Changedrop timing "${timing.id}" start`, { minimum: 0 });
		finiteNumber(timing.duration_seconds, `Changedrop timing "${timing.id}" duration`, { positive: true });
		if (timing.start_seconds <= previousStart || (index && timing.start_seconds < previousEnd)) {
			throw new Error('Changedrop timing segment starts must be monotonic and non-overlapping.');
		}
		previousStart = timing.start_seconds;
		previousEnd = timing.start_seconds + timing.duration_seconds;
		if (segment.kind === 'surface' && timing.duration_seconds > 10) {
			throw new Error(`Measured surface "${segment.surface}" exceeds the 10-second narration budget.`);
		}
		if (JSON.stringify(timing.actions) !== JSON.stringify(segment.walkthrough.map(machineAction))) {
			throw new Error(`Changedrop timing action sequence for "${segment.id}" is stale; capture the script again.`);
		}
		if (!Array.isArray(timing.highlights)) throw new Error(`Changedrop timing "${timing.id}" highlights must be an array.`);
		const expectedHighlights = segment.walkthrough.filter((step) => step.action === 'highlight');
		if (timing.highlights.length !== expectedHighlights.length) {
			throw new Error(`Changedrop timing "${timing.id}" must receipt every scripted highlight exactly once.`);
		}
		for (const [highlightIndex, highlight] of timing.highlights.entries()) {
			exactObject(highlight, [
				'timestamp_seconds', 'selector', 'badge', 'source_basename', 'source_bytes', 'basename', 'bytes',
			], `Changedrop timing highlight for "${timing.id}"`);
			finiteNumber(highlight.timestamp_seconds, 'Changedrop highlight timestamp', { minimum: timing.start_seconds });
			if (highlight.timestamp_seconds > previousEnd) throw new Error('Changedrop highlight lies outside its segment.');
			const expected = expectedHighlights[highlightIndex];
			const number = highlightIndex + 1;
			if (highlight.selector !== expected.selector || highlight.badge !== expected.badge
				|| highlight.source_basename !== `stills/sources/${segment.id}-${number}.png`
				|| highlight.basename !== `stills/${segment.id}-${number}.png`) {
				throw new Error(`Changedrop timing highlight for "${timing.id}" is stale or malformed.`);
			}
			if (!Number.isInteger(highlight.source_bytes) || highlight.source_bytes <= 0
				|| !Number.isInteger(highlight.bytes) || highlight.bytes <= 0) {
				throw new Error('Changedrop highlight files must be non-empty.');
			}
		}
	}
	if (timings.recording.duration_seconds < previousEnd) throw new Error('Changedrop recording ends before its final segment.');
	return privacyChecked(timings, 'Changedrop timings');
}

export function validateVoiceRequest(request) {
	const baseKeys = [
		'schema_version', 'request_id', 'project', 'voice_profile', 'mode', 'style',
		'language', 'text', 'delivery',
	];
	const expected = request?.target === undefined ? baseKeys : [...baseKeys, 'target'];
	exactObject(request, expected, 'Voice order request');
	if (request.schema_version !== REQUEST_SCHEMA_VERSION) throw new Error('Voice request schema_version is invalid.');
	if (!/^ezhud-[0-9a-f]{32}$/.test(request.request_id)) throw new Error('Voice request_id is invalid.');
	if (request.project !== PROJECT || request.voice_profile !== VOICE_PROFILE
		|| request.mode !== 'spoken' || request.style !== 'neutral' || request.language !== 'en') {
		throw new Error('Voice request fixed fields are invalid.');
	}
	nonEmptyString(request.text, 'Voice request text');
	if (request.text.length > 1200 || /[\u0000-\u001f\u007f]/u.test(request.text)) throw new Error('Voice request text is unsafe or too long.');
	exactObject(request.delivery, ['container', 'sample_rate', 'channels'], 'Voice request delivery');
	if (request.delivery.container !== 'wav' || request.delivery.sample_rate !== 24_000 || request.delivery.channels !== 1) {
		throw new Error('Voice request delivery must be 24 kHz mono WAV.');
	}
	if (request.target !== undefined) {
		exactObject(request.target, ['duration_seconds', 'tolerance_seconds'], 'Voice request target');
		finiteNumber(request.target.duration_seconds, 'Voice target duration', { positive: true });
		if (request.target.duration_seconds > 120) throw new Error('Voice target duration exceeds the service maximum.');
		if (request.target.tolerance_seconds !== DURATION_TOLERANCE_SECONDS) {
			throw new Error('Voice target duration_seconds and tolerance_seconds must both use the fixed fitting contract.');
		}
	}
	return privacyChecked(request, 'Voice request');
}

export function buildVoiceRequests({ script, timings } = {}) {
	validateCaptureScript(script);
	if (script.schema_version !== SCRIPT_SCHEMA_VERSION) throw new Error(`Changedrop script must use ${SCRIPT_SCHEMA_VERSION}.`);
	validateTimingReceipt(script, timings);
	return script.segments.map((segment, index) => {
		const effectiveOrder = {
			schema_version: REQUEST_SCHEMA_VERSION,
			project: PROJECT,
			voice_profile: VOICE_PROFILE,
			mode: 'spoken',
			style: 'neutral',
			language: 'en',
			text: segment.text,
			delivery: { container: 'wav', sample_rate: 24_000, channels: 1 },
			target: {
				duration_seconds: timings.segments[index].duration_seconds,
				tolerance_seconds: DURATION_TOLERANCE_SECONDS,
			},
		};
		return validateVoiceRequest({
			schema_version: effectiveOrder.schema_version,
			request_id: requestIdFor(effectiveOrder),
			project: effectiveOrder.project,
			voice_profile: effectiveOrder.voice_profile,
			mode: effectiveOrder.mode,
			style: effectiveOrder.style,
			language: effectiveOrder.language,
			text: effectiveOrder.text,
			delivery: effectiveOrder.delivery,
			target: effectiveOrder.target,
		});
	});
}

export function policyForError(errorCode, _messageIgnored) {
	const policy = ERROR_POLICIES[errorCode];
	if (!policy) throw new Error(`Undocumented voice error code "${String(errorCode)}" is unknown.`);
	return policy;
}

class VoiceOrderFailure extends Error {
	constructor(errorCode, policy) {
		const prerequisite = errorCode === 'E_PROJECT_NOT_ALLOWED'
			? `Owner must allow project ${PROJECT}.`
			: errorCode === 'E_PROFILE_UNKNOWN'
				? `Owner must provide profile ${VOICE_PROFILE}.`
				: null;
		super(`Voice order stopped with ${errorCode} (${policy.action}).`);
		this.name = 'VoiceOrderFailure';
		this.errorCode = errorCode;
		this.action = policy.action;
		this.prerequisite = prerequisite;
	}
}

function parseTransportResult(request, transportResult) {
	exactObject(transportResult, ['exitCode', 'stdout', 'stderr'], 'Voice transport result');
	if (!Number.isInteger(transportResult.exitCode)) throw new Error('Voice transport exit code is invalid.');
	let result;
	try {
		result = JSON.parse(transportResult.stdout);
	} catch {
		throw new Error('Voice service returned malformed JSON.');
	}
	if (!result || result.schema_version !== REQUEST_SCHEMA_VERSION || result.request_id !== request.request_id) {
		throw new Error('Voice service returned a mismatched result.');
	}
	if (result.status === 'failed') {
		exactObject(result, ['schema_version', 'status', 'request_id', 'error_code', 'message'], 'Voice failure result');
		if (typeof result.error_code !== 'string' || typeof result.message !== 'string' || !result.message) {
			throw new Error('Voice service failure result is malformed.');
		}
		const policy = policyForError(result.error_code);
		if (transportResult.exitCode !== ERROR_EXIT_CODES[result.error_code]) {
			throw new Error('Voice service failure exit code does not match error_code.');
		}
		return { result, policy };
	}
	if (!['rendered', 'duplicate'].includes(result.status) || transportResult.exitCode !== 0) {
		throw new Error('Voice service success result or exit code is malformed.');
	}
	return { result, policy: null };
}

function validateSuccessResult(request, result) {
	exactObject(result, [
		'schema_version', 'status', 'request_id', 'request_hash', 'project', 'voice_profile',
		'profile_revision', 'pronunciation_profile', 'pronunciation_revision', 'audio', 'target',
		'normalized_text', 'normalized_text_sha256', 'engine', 'rendered_at', 'rerendered',
	], 'Voice success result');
	if (result.schema_version !== REQUEST_SCHEMA_VERSION || result.request_id !== request.request_id
		|| !['rendered', 'duplicate'].includes(result.status)) throw new Error('Voice success identity is invalid.');
	if (result.status === 'duplicate' && result.rerendered !== false) {
		throw new Error('Voice duplicate must report rerendered false.');
	}
	if (typeof result.rerendered !== 'boolean') throw new Error('Voice rerendered flag is invalid.');
	if (!/^sha256:[0-9a-f]{64}$/.test(result.request_hash)) throw new Error('Voice request hash is invalid.');
	if (result.project !== PROJECT || result.voice_profile !== VOICE_PROFILE
		|| !Number.isInteger(result.profile_revision) || result.profile_revision < 1) {
		throw new Error('Voice result project or profile is invalid.');
	}
	nonEmptyString(result.pronunciation_profile, 'Voice pronunciation profile');
	if (!Number.isInteger(result.pronunciation_revision) || result.pronunciation_revision < 0) {
		throw new Error('Voice pronunciation revision is invalid.');
	}
	nonEmptyString(result.normalized_text, 'Voice normalized text');
	if (!/^[0-9a-f]{64}$/.test(result.normalized_text_sha256)) throw new Error('Voice normalized text hash is invalid.');
	exactObject(result.audio, [
		'path', 'sha256', 'bytes', 'container', 'sample_rate', 'channels', 'sample_width_bits', 'duration_seconds',
	], 'Voice audio result');
	if (typeof result.audio.path !== 'string' || !path.isAbsolute(result.audio.path)) throw new Error('Voice audio result path is invalid.');
	if (!/^[0-9a-f]{64}$/.test(result.audio.sha256)
		|| !Number.isInteger(result.audio.bytes) || result.audio.bytes <= 0
		|| result.audio.container !== 'wav' || result.audio.sample_rate !== 24_000
		|| result.audio.channels !== 1 || result.audio.sample_width_bits !== 16) {
		throw new Error('Voice audio result is invalid.');
	}
	finiteNumber(result.audio.duration_seconds, 'Voice audio duration', { positive: true });
	exactObject(result.target, ['duration_seconds', 'tolerance_seconds', 'delta_seconds'], 'Voice result target');
	if (result.target.duration_seconds !== request.target.duration_seconds
		|| result.target.tolerance_seconds !== request.target.tolerance_seconds) {
		throw new Error('Voice service target does not match the measured request target.');
	}
	finiteNumber(result.target.delta_seconds, 'Voice target delta');
	exactObject(result.engine, ['name', 't3_model', 'cli_sha256'], 'Voice engine result');
	if (result.engine.name !== 'chatterbox-multilingual' || !/^[0-9a-f]{64}$/.test(result.engine.cli_sha256)) {
		throw new Error('Voice engine provenance is invalid.');
	}
	nonEmptyString(result.engine.t3_model, 'Voice engine model provenance');
	nonEmptyString(result.rendered_at, 'Voice rendered_at');
	if (Number.isNaN(Date.parse(result.rendered_at))) throw new Error('Voice rendered_at is invalid.');
	return result;
}

export async function submitWithPolicy(request, transport) {
	validateVoiceRequest(request);
	if (typeof transport !== 'function') throw new Error('Voice transport must be a function.');
	for (let attempts = 1; attempts <= MAX_IDENTICAL_ATTEMPTS; attempts += 1) {
		const parsed = parseTransportResult(request, await transport(request));
		if (parsed.result.status !== 'failed') {
			return { result: validateSuccessResult(request, parsed.result), attempts };
		}
		if (parsed.policy.retry && attempts < MAX_IDENTICAL_ATTEMPTS) continue;
		throw new VoiceOrderFailure(parsed.result.error_code, parsed.policy);
	}
	throw new Error('Voice order retry bound is unreachable.');
}

export function sanitizeVoiceResult({ segment, request, result, basename } = {}) {
	validateVoiceRequest(request);
	validateSuccessResult(request, result);
	if (!segment || typeof segment.id !== 'string' || basename !== `${segment.id}.wav`) {
		throw new Error('Voice narration basename must derive from its segment id.');
	}
	return privacyChecked({
		id: segment.id,
		kind: segment.kind,
		surface: segment.surface,
		request_id: result.request_id,
		request_hash: result.request_hash,
		status: result.status,
		rerendered: result.rerendered,
		profile_revision: result.profile_revision,
		pronunciation_profile: result.pronunciation_profile,
		pronunciation_revision: result.pronunciation_revision,
		normalized_text_sha256: result.normalized_text_sha256,
		audio: {
			basename,
			sha256: result.audio.sha256,
		},
		duration_seconds: result.audio.duration_seconds,
		target: { ...result.target },
		engine: { ...result.engine },
		rendered_at: result.rendered_at,
	}, 'Changedrop narration entry');
}

function spawnVoiceOrder(request) {
	return new Promise((resolve, reject) => {
		const child = spawn('voice-order', ['submit', '--wait'], { stdio: ['pipe', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		let overflow = false;
		const append = (current, chunk) => {
			const next = current + chunk.toString('utf8');
			if (Buffer.byteLength(next) > MAX_OUTPUT_BYTES) overflow = true;
			return overflow ? current : next;
		};
		child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
		child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
		child.once('error', () => reject(new Error('Could not start the voice order transport.')));
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			reject(new Error('Voice order transport exceeded its bounded wait.'));
		}, ORDER_TIMEOUT_MS);
		timer.unref?.();
		child.once('close', (exitCode) => {
			clearTimeout(timer);
			if (overflow) return reject(new Error('Voice order transport output exceeded its bound.'));
			resolve({ exitCode, stdout, stderr });
		});
		child.stdin.end(`${JSON.stringify(request)}\n`);
	});
}

function parseArguments(argv) {
	const values = new Map();
	for (let index = 0; index < argv.length; index += 1) {
		const name = argv[index];
		if (!['--script', '--timings', '--out'].includes(name)) throw new Error(`Unknown changedrop voice argument: ${name}`);
		const value = argv[index + 1];
		if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
		if (values.has(name)) throw new Error(`${name} may be supplied only once.`);
		values.set(name, value);
		index += 1;
	}
	for (const name of ['--script', '--timings', '--out']) {
		if (!values.has(name)) throw new Error(`${name} is required.`);
	}
	return { script: values.get('--script'), timings: values.get('--timings'), out: values.get('--out') };
}

function pathInsideRoot(root, requested) {
	const resolved = path.resolve(root, requested);
	return resolved.startsWith(`${root}${path.sep}`) ? resolved : null;
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
		if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('narration parent is not a private directory');
		await chmod(cursor, 0o700);
	}
}

async function verifiedAudioBytes(result) {
	let metadata;
	try {
		metadata = await lstat(result.audio.path);
	} catch {
		throw new Error('Voice audio artifact is missing.');
	}
	if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== result.audio.bytes) {
		throw new Error('Voice audio artifact is not the verified regular file described by the service.');
	}
	const bytes = await readFile(result.audio.path);
	const digest = createHash('sha256').update(bytes).digest('hex');
	if (digest !== result.audio.sha256) throw new Error('Voice audio artifact hash differs from the service result.');
	return bytes;
}

export async function main({
	env = process.env,
	argv = process.argv.slice(2),
	transport = spawnVoiceOrder,
	stdout = console.log,
} = {}) {
	if (!env[ROOT_VARIABLE]?.trim()) throw new Error(`${ROOT_VARIABLE} is required.`);
	const root = path.resolve(env[ROOT_VARIABLE]);
	let rootMetadata;
	try {
		rootMetadata = await stat(root);
	} catch {
		throw new Error(`${ROOT_VARIABLE} must name an existing owner-only directory.`);
	}
	if (!rootMetadata.isDirectory() || (rootMetadata.mode & 0o077) !== 0) {
		throw new Error(`${ROOT_VARIABLE} must name an existing owner-only directory.`);
	}
	const args = parseArguments(argv);
	const scriptPath = pathInsideRoot(root, args.script);
	const timingsPath = pathInsideRoot(root, args.timings);
	const output = pathInsideRoot(root, args.out);
	if (!scriptPath) throw new Error('--script must resolve inside EZHUD_CHANGEDROP_ROOT.');
	if (!timingsPath) throw new Error('--timings must resolve inside EZHUD_CHANGEDROP_ROOT.');
	if (!output) throw new Error('--out must resolve inside EZHUD_CHANGEDROP_ROOT.');
	if (scriptPath.startsWith(`${output}${path.sep}`) || timingsPath.startsWith(`${output}${path.sep}`)) {
		throw new Error('--out may not contain a voice input file.');
	}
	let script;
	let timings;
	try {
		[script, timings] = await Promise.all([
			readFile(scriptPath, 'utf8').then(JSON.parse),
			readFile(timingsPath, 'utf8').then(JSON.parse),
		]);
	} catch {
		throw new Error('Could not read changedrop voice inputs inside EZHUD_CHANGEDROP_ROOT.');
	}
	const requests = buildVoiceRequests({ script, timings });
	await ensurePrivateParents(root, path.dirname(output));
	const staging = `${output}.staging-${process.pid}`;
	await rm(staging, { recursive: true, force: true });
	await mkdir(staging, { mode: 0o700 });
	await chmod(staging, 0o700);
	try {
		const segments = [];
		for (const [index, request] of requests.entries()) {
			const { result } = await submitWithPolicy(request, transport);
			const basename = `${script.segments[index].id}.wav`;
			const bytes = await verifiedAudioBytes(result);
			const target = path.join(staging, basename);
			await writeFile(target, bytes, { mode: 0o600 });
			await chmod(target, 0o600);
			segments.push(sanitizeVoiceResult({ segment: script.segments[index], request, result, basename }));
		}
		const narration = privacyChecked({
			schema_version: OUTPUT_SCHEMA_VERSION,
			project: PROJECT,
			voice_profile: VOICE_PROFILE,
			segments,
		}, 'Changedrop narration');
		const manifest = path.join(staging, 'narration.json');
		await writeFile(manifest, `${JSON.stringify(narration, null, 2)}\n`, { mode: 0o600 });
		await chmod(manifest, 0o600);
		await rm(output, { recursive: true, force: true });
		await rename(staging, output);
		await chmod(output, 0o700);
		stdout(JSON.stringify(narration));
		return narration;
	} catch (error) {
		await rm(staging, { recursive: true, force: true });
		throw error;
	}
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
	main().catch((error) => {
		if (error instanceof VoiceOrderFailure) {
			const prerequisite = error.prerequisite ? ` Prerequisite: ${error.prerequisite}` : '';
			console.error(`changedrop voice: ${error.errorCode} (${error.action}).${prerequisite}`);
		} else {
			console.error(`changedrop voice: ${String(error.message ?? error)}`);
		}
		process.exitCode = 1;
	});
}
