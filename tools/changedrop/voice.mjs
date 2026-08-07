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

import {
	CONTAINER_CONTENT_EPSILON_SECONDS,
	MAX_HOLD_MS,
	validateCaptureScript,
} from './capture.mjs';

const SCRIPT_SCHEMA_VERSION = 'changedrop-script/1';
const TIMINGS_SCHEMA_VERSION = 'changedrop-timings/1';
const REQUEST_SCHEMA_VERSION = 'voice-order/1';
const OUTPUT_SCHEMA_VERSION = 'changedrop-narration/1';
const FIT_SCHEMA_VERSION = 'changedrop-voice-fit/1';
const ROOT_VARIABLE = 'EZHUD_CHANGEDROP_ROOT';
const PROJECT = 'ezhud';
const VOICE_PROFILE = 'xeri-en-v1';
const MAX_IDENTICAL_ATTEMPTS = 3;
const ORDER_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_BYTES = 1_048_576;

// A tenth of a second covers audio/frame boundary quantisation without
// permitting narration to audibly spill into the next segment.
export const NARRATION_OVERRUN_EPSILON_SECONDS = 0.1;
// Up to two seconds of quiet picture is an ordinary editing beat. More than
// that is long enough to indicate a lost action or accidental dead-air hold.
export const MAX_NARRATION_UNDERSHOOT_SECONDS = 2.0;
// The fitter deliberately leaves a quarter-second visual handle. Together
// with the 100 ms overrun epsilon it covers the observed 283 ms short-side
// engine-readback drift while staying far below the two-second dead-air bound.
export const FIT_SAFETY_MARGIN_SECONDS = 0.25;
// Pure-padding holds can measure a fraction under their declared timer because
// browser clocks are sampled on opposite sides of a scheduling boundary. A
// 25 ms allowance covers that boundary noise while remaining far below both
// the 100 ms minimum hold and narration fit margins.
export const FIXED_ACTION_NEGATIVE_EPSILON_SECONDS = 0.025;

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
	E_DURATION_OUT_OF_TOLERANCE: Object.freeze({ action: 'service-contract-bug', retry: false }),
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

export function validateTimingReceipt(script, timings) {
	exactObject(timings, ['schema_version', 'recording', 'setup_actions', 'segments'], 'Changedrop timings');
	if (timings.schema_version !== TIMINGS_SCHEMA_VERSION) {
		throw new Error(`Changedrop timings must use ${TIMINGS_SCHEMA_VERSION}.`);
	}
	exactObject(timings.recording,
		['basename', 'bytes', 'duration_seconds', 'container_duration_seconds'],
		'Changedrop timing recording');
	if (timings.recording.basename !== 'walkthrough.webm'
		|| !Number.isInteger(timings.recording.bytes) || timings.recording.bytes <= 0) {
		throw new Error('Changedrop timing recording is invalid.');
	}
	finiteNumber(timings.recording.duration_seconds, 'Changedrop recording content duration', { positive: true });
	finiteNumber(timings.recording.container_duration_seconds,
		'Changedrop recording container duration', { positive: true });
	if (timings.recording.container_duration_seconds + CONTAINER_CONTENT_EPSILON_SECONDS
		< timings.recording.duration_seconds) {
		throw new Error('Changedrop recording container duration is shorter than its measured content duration.');
	}
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
	const expected = [
		'schema_version', 'request_id', 'project', 'voice_profile', 'mode', 'style',
		'language', 'text', 'delivery',
	];
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
	return privacyChecked(request, 'Voice request');
}

function voiceRequest(segment) {
	const effectiveOrder = {
		schema_version: REQUEST_SCHEMA_VERSION,
		project: PROJECT,
		voice_profile: VOICE_PROFILE,
		mode: 'spoken',
		style: 'neutral',
		language: 'en',
		text: segment.text,
		delivery: { container: 'wav', sample_rate: 24_000, channels: 1 },
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
	});
}

function validatedVoiceInputs(script, timings) {
	validateCaptureScript(script);
	if (script.schema_version !== SCRIPT_SCHEMA_VERSION) throw new Error(`Changedrop script must use ${SCRIPT_SCHEMA_VERSION}.`);
	validateTimingReceipt(script, timings);
}

export function buildMeasurementRequests({ script, timings } = {}) {
	validatedVoiceInputs(script, timings);
	return script.segments.map((segment) => voiceRequest(segment));
}

function splitPadding(totalMilliseconds) {
	const count = Math.ceil(totalMilliseconds / MAX_HOLD_MS);
	const base = Math.floor(totalMilliseconds / count);
	const remainder = totalMilliseconds % count;
	const holds = Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0));
	if (holds.some((duration) => duration < 100 || duration > MAX_HOLD_MS)) {
		throw new Error('Narration padding cannot be represented by bounded hold actions.');
	}
	return holds;
}

function copiedStep(step) {
	return { ...step, ...(step.crop ? { crop: { ...step.crop } } : {}) };
}

export function fitCaptureScript({ script, timings, measurements } = {}) {
	validatedVoiceInputs(script, timings);
	if (!Array.isArray(measurements) || measurements.length !== script.segments.length) {
		throw new Error('Natural narration measurements must contain exactly one entry per segment.');
	}
	const fittedScript = {
		...script,
		setup: script.setup.map(copiedStep),
		segments: [],
	};
	const fittedSegments = [];
	for (const [index, segment] of script.segments.entries()) {
		const measurement = measurements[index];
		exactObject(measurement, ['id', 'duration_seconds'], `Natural narration measurement ${index + 1}`);
		if (measurement.id !== segment.id) throw new Error(`Natural narration measurement order is stale at "${segment.id}".`);
		finiteNumber(measurement.duration_seconds, `Natural narration "${segment.id}" duration`, { positive: true });
		const paddingIndices = segment.walkthrough.flatMap((step, stepIndex) => step.fit === 'narration' ? [stepIndex] : []);
		if (paddingIndices.length === 0) throw new Error(`Segment "${segment.id}" has no narration padding hold.`);
		const previousPaddingMs = paddingIndices.reduce((sum, stepIndex) => sum + segment.walkthrough[stepIndex].duration_ms, 0);
		const rawFixedActionSeconds = timings.segments[index].duration_seconds - previousPaddingMs / 1000;
		if (rawFixedActionSeconds < -FIXED_ACTION_NEGATIVE_EPSILON_SECONDS) {
			throw new Error(`Measured fixed action time for segment "${segment.id}" is negative beyond the 25 ms timer-noise epsilon; timings and script disagree.`);
		}
		const fixedActionSeconds = rawFixedActionSeconds < 0 ? 0 : Number(rawFixedActionSeconds.toFixed(6));
		const fittedPaddingMs = Math.round((
			measurement.duration_seconds + FIT_SAFETY_MARGIN_SECONDS - fixedActionSeconds
		) * 1000);
		if (fittedPaddingMs < 100) {
			throw new Error(`Natural narration for segment "${segment.id}" leaves less than 100 ms for padding.`);
		}
		const fittedHoldDurationsMs = splitPadding(fittedPaddingMs);
		const firstPaddingIndex = paddingIndices[0];
		const paddingIndexSet = new Set(paddingIndices);
		const paddingInstruction = segment.walkthrough[firstPaddingIndex].instruction;
		const walkthrough = segment.walkthrough.flatMap((step, stepIndex) => {
			if (stepIndex === firstPaddingIndex) {
				return fittedHoldDurationsMs.map((duration_ms) => ({
					instruction: paddingInstruction,
					action: 'hold',
					duration_ms,
					fit: 'narration',
				}));
			}
			if (paddingIndexSet.has(stepIndex)) return [];
			return [copiedStep(step)];
		});
		const projectedDurationSeconds = Number((fixedActionSeconds + fittedPaddingMs / 1000).toFixed(6));
		if (segment.kind === 'surface' && projectedDurationSeconds > 10) {
			throw new Error(`Fitted segment "${segment.id}" exceeds the 10-second surface budget.`);
		}
		fittedScript.segments.push({ ...segment, walkthrough });
		fittedSegments.push({
			id: segment.id,
			natural_duration_seconds: measurement.duration_seconds,
			measured_window_seconds: timings.segments[index].duration_seconds,
			fixed_action_seconds: fixedActionSeconds,
			previous_padding_ms: previousPaddingMs,
			fitted_padding_ms: fittedPaddingMs,
			fitted_hold_durations_ms: fittedHoldDurationsMs,
			projected_duration_seconds: projectedDurationSeconds,
		});
	}
	validateCaptureScript(fittedScript);
	return privacyChecked({ script: fittedScript, segments: fittedSegments }, 'Changedrop voice fit');
}

export function validateNarrationManifest(narration, script) {
	exactObject(narration, ['schema_version', 'project', 'voice_profile', 'segments'], 'Changedrop narration');
	if (narration.schema_version !== OUTPUT_SCHEMA_VERSION || narration.project !== PROJECT
		|| narration.voice_profile !== VOICE_PROFILE || !Array.isArray(narration.segments)
		|| narration.segments.length !== script.segments.length) {
		throw new Error('Changedrop narration identity or segment count is invalid.');
	}
	for (const [index, entry] of narration.segments.entries()) {
		exactObject(entry, [
			'id', 'kind', 'surface', 'request_id', 'request_hash', 'status', 'rerendered',
			'profile_revision', 'pronunciation_profile', 'pronunciation_revision',
			'normalized_text_sha256', 'audio', 'duration_seconds', 'engine', 'rendered_at',
		], `Changedrop narration segment ${index + 1}`);
		const segment = script.segments[index];
		if (entry.id !== segment.id || entry.kind !== segment.kind || entry.surface !== segment.surface) {
			throw new Error(`Changedrop narration order is stale at segment "${segment.id}".`);
		}
		if (!/^ezhud-[0-9a-f]{32}$/.test(entry.request_id) || !/^sha256:[0-9a-f]{64}$/.test(entry.request_hash)
			|| !['rendered', 'duplicate'].includes(entry.status) || typeof entry.rerendered !== 'boolean') {
			throw new Error(`Changedrop narration request provenance is invalid for segment "${entry.id}".`);
		}
		if (!Number.isInteger(entry.profile_revision) || entry.profile_revision < 1
			|| !Number.isInteger(entry.pronunciation_revision) || entry.pronunciation_revision < 0) {
			throw new Error(`Changedrop narration profile provenance is invalid for segment "${entry.id}".`);
		}
		nonEmptyString(entry.pronunciation_profile, `Changedrop narration "${entry.id}" pronunciation profile`);
		if (!/^[0-9a-f]{64}$/.test(entry.normalized_text_sha256)) {
			throw new Error(`Changedrop narration normalized text hash is invalid for segment "${entry.id}".`);
		}
		exactObject(entry.audio, ['basename', 'sha256'], `Changedrop narration "${entry.id}" audio`);
		if (entry.audio.basename !== `${entry.id}.wav` || !/^[0-9a-f]{64}$/.test(entry.audio.sha256)) {
			throw new Error(`Changedrop narration audio identity is invalid for segment "${entry.id}".`);
		}
		finiteNumber(entry.duration_seconds, `Changedrop narration "${entry.id}" duration`, { positive: true });
		exactObject(entry.engine, ['name', 't3_model', 'cli_sha256'], `Changedrop narration "${entry.id}" engine`);
		if (entry.engine.name !== 'chatterbox-multilingual' || !/^[0-9a-f]{64}$/.test(entry.engine.cli_sha256)) {
			throw new Error(`Changedrop narration engine provenance is invalid for segment "${entry.id}".`);
		}
		nonEmptyString(entry.engine.t3_model, `Changedrop narration "${entry.id}" engine model`);
		nonEmptyString(entry.rendered_at, `Changedrop narration "${entry.id}" rendered_at`);
	}
	return privacyChecked(narration, 'Changedrop narration');
}

export function assertNarrationFitsCapture({ script, timings, narration } = {}) {
	validatedVoiceInputs(script, timings);
	if (!narration || narration.schema_version !== OUTPUT_SCHEMA_VERSION || !Array.isArray(narration.segments)
		|| narration.segments.length !== script.segments.length) {
		throw new Error('Changedrop narration must contain exactly one entry per fitted capture segment.');
	}
	const segments = narration.segments.map((entry, index) => {
		const expected = script.segments[index];
		if (!entry || entry.id !== expected.id) {
			throw new Error(`Changedrop narration order is stale at segment "${expected.id}".`);
		}
		finiteNumber(entry.duration_seconds, `Narration "${entry.id}" audio duration`, { positive: true });
		const captureDurationSeconds = timings.segments[index].duration_seconds;
		const deltaSeconds = Number((entry.duration_seconds - captureDurationSeconds).toFixed(6));
		if (deltaSeconds > NARRATION_OVERRUN_EPSILON_SECONDS) {
			throw new Error(`Narration fit failed for segment "${entry.id}": overrun; audio ${entry.duration_seconds.toFixed(3)}s, capture ${captureDurationSeconds.toFixed(3)}s, epsilon ${NARRATION_OVERRUN_EPSILON_SECONDS.toFixed(3)}s.`);
		}
		const quietPictureSeconds = Number(Math.max(0, -deltaSeconds).toFixed(6));
		if (quietPictureSeconds > MAX_NARRATION_UNDERSHOOT_SECONDS) {
			throw new Error(`Narration fit failed for segment "${entry.id}": dead air; audio ${entry.duration_seconds.toFixed(3)}s, capture ${captureDurationSeconds.toFixed(3)}s, undershoot bound ${MAX_NARRATION_UNDERSHOOT_SECONDS.toFixed(3)}s.`);
		}
		return {
			id: entry.id,
			audio_duration_seconds: entry.duration_seconds,
			capture_duration_seconds: captureDurationSeconds,
			delta_seconds: deltaSeconds,
			quiet_picture_seconds: quietPictureSeconds,
		};
	});
	return privacyChecked({ valid: true, segments }, 'Changedrop narration fit validation');
}

export function policyForError(errorCode, _messageIgnored) {
	const policy = ERROR_POLICIES[errorCode];
	if (!policy) throw new Error(`Undocumented voice error code "${String(errorCode)}" is unknown.`);
	return policy;
}

class VoiceOrderFailure extends Error {
	constructor(errorCode, policy, { segmentId, request } = {}) {
		const prerequisite = errorCode === 'E_PROJECT_NOT_ALLOWED'
			? `Owner must allow project ${PROJECT}.`
			: errorCode === 'E_PROFILE_UNKNOWN'
				? `Owner must provide profile ${VOICE_PROFILE}.`
				: null;
		const segment = segmentId ? ` for segment "${segmentId}"` : '';
		super(`Natural voice order${segment} stopped with ${errorCode} (${policy.action}).`);
		this.name = 'VoiceOrderFailure';
		this.errorCode = errorCode;
		this.action = policy.action;
		this.prerequisite = prerequisite;
		this.segmentId = segmentId ?? null;
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
	const successKeys = [
		'schema_version', 'status', 'request_id', 'request_hash', 'project', 'voice_profile',
		'profile_revision', 'pronunciation_profile', 'pronunciation_revision', 'audio',
		'normalized_text', 'normalized_text_sha256', 'engine', 'rendered_at', 'rerendered',
	];
	exactObject(result, successKeys, 'Voice success result');
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
	exactObject(result.engine, ['name', 't3_model', 'cli_sha256'], 'Voice engine result');
	if (result.engine.name !== 'chatterbox-multilingual' || !/^[0-9a-f]{64}$/.test(result.engine.cli_sha256)) {
		throw new Error('Voice engine provenance is invalid.');
	}
	nonEmptyString(result.engine.t3_model, 'Voice engine model provenance');
	nonEmptyString(result.rendered_at, 'Voice rendered_at');
	if (Number.isNaN(Date.parse(result.rendered_at))) throw new Error('Voice rendered_at is invalid.');
	return result;
}

export async function submitWithPolicy(request, transport, context = {}) {
	validateVoiceRequest(request);
	if (typeof transport !== 'function') throw new Error('Voice transport must be a function.');
	for (let attempts = 1; attempts <= MAX_IDENTICAL_ATTEMPTS; attempts += 1) {
		const parsed = parseTransportResult(request, await transport(request));
		if (parsed.result.status !== 'failed') {
			return { result: validateSuccessResult(request, parsed.result), attempts };
		}
		if (parsed.policy.retry && attempts < MAX_IDENTICAL_ATTEMPTS) continue;
		throw new VoiceOrderFailure(parsed.result.error_code, parsed.policy, { ...context, request });
	}
	throw new Error('Voice order retry bound is unreachable.');
}

export function sanitizeVoiceResult({ segment, request, result, basename, localDurationSeconds } = {}) {
	validateVoiceRequest(request);
	validateSuccessResult(request, result);
	finiteNumber(localDurationSeconds, 'Locally measured narration duration', { positive: true });
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
		duration_seconds: localDurationSeconds,
		engine: { ...result.engine },
		rendered_at: result.rendered_at,
	}, 'Changedrop narration entry');
}

function contentHash(value) {
	return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export function buildFitReceipt({ fitted, script, requests, results } = {}) {
	if (!fitted || !script || !Array.isArray(requests) || !Array.isArray(results)
		|| requests.length !== script.segments.length || results.length !== script.segments.length) {
		throw new Error('Changedrop voice fit receipt inputs are incomplete.');
	}
	const segments = fitted.segments.map((fit, index) => {
		const request = requests[index];
		const result = validateSuccessResult(request, results[index]);
		if (fit.id !== script.segments[index].id) {
			throw new Error(`Natural narration fit result is stale at "${fit.id}".`);
		}
		return {
			id: fit.id,
			kind: script.segments[index].kind,
			surface: script.segments[index].surface,
			request_id: result.request_id,
			request_hash: result.request_hash,
			status: result.status,
			rerendered: result.rerendered,
			audio: { basename: `${fit.id}.wav`, sha256: result.audio.sha256 },
			natural_duration_seconds: fit.natural_duration_seconds,
			measured_window_seconds: fit.measured_window_seconds,
			fixed_action_seconds: fit.fixed_action_seconds,
			previous_padding_ms: fit.previous_padding_ms,
			fitted_padding_ms: fit.fitted_padding_ms,
			fitted_hold_durations_ms: [...fit.fitted_hold_durations_ms],
			projected_duration_seconds: fit.projected_duration_seconds,
		};
	});
	return privacyChecked({
		schema_version: FIT_SCHEMA_VERSION,
		project: PROJECT,
		voice_profile: VOICE_PROFILE,
		script: { basename: 'script.json', sha256: contentHash(fitted.script) },
		segments,
	}, 'Changedrop voice fit receipt');
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
		if (!['--phase', '--script', '--timings', '--out'].includes(name)) throw new Error(`Unknown changedrop voice argument: ${name}`);
		const value = argv[index + 1];
		if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
		if (values.has(name)) throw new Error(`${name} may be supplied only once.`);
		values.set(name, value);
		index += 1;
	}
	for (const name of ['--phase', '--script', '--timings', '--out']) {
		if (!values.has(name)) throw new Error(`${name} is required.`);
	}
	if (!['measure', 'validate'].includes(values.get('--phase'))) throw new Error('--phase must be measure or validate.');
	return {
		phase: values.get('--phase'),
		script: values.get('--script'),
		timings: values.get('--timings'),
		out: values.get('--out'),
	};
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
		if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('voice output parent is not a private directory');
		await chmod(cursor, 0o700);
	}
}

export function inspectDeliveredWav(value) {
	const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value ?? []);
	if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF'
		|| bytes.toString('ascii', 8, 12) !== 'WAVE') {
		throw new Error('Delivered narration is not a RIFF/WAVE file.');
	}
	if (bytes.readUInt32LE(4) + 8 !== bytes.length) throw new Error('Delivered WAV RIFF length is invalid.');
	let format = null;
	let dataBytes = null;
	for (let offset = 12; offset + 8 <= bytes.length;) {
		const id = bytes.toString('ascii', offset, offset + 4);
		const size = bytes.readUInt32LE(offset + 4);
		const start = offset + 8;
		const end = start + size;
		if (end > bytes.length) throw new Error('Delivered WAV contains a truncated chunk.');
		if (id === 'fmt ') {
			if (size < 16) throw new Error('Delivered WAV format chunk is too short.');
			format = {
				encoding: bytes.readUInt16LE(start),
				channels: bytes.readUInt16LE(start + 2),
				sampleRate: bytes.readUInt32LE(start + 4),
				byteRate: bytes.readUInt32LE(start + 8),
				blockAlign: bytes.readUInt16LE(start + 12),
				bitsPerSample: bytes.readUInt16LE(start + 14),
			};
		} else if (id === 'data' && dataBytes === null) {
			dataBytes = size;
		}
		offset = end + (size % 2);
	}
	if (!format || dataBytes === null || dataBytes <= 0) throw new Error('Delivered WAV is missing format or positive audio data.');
	if (format.encoding !== 1 || format.bitsPerSample !== 16) throw new Error('Delivered WAV must contain 16-bit PCM audio.');
	if (format.sampleRate !== 24_000) throw new Error('Delivered WAV must use a 24 kHz sample rate.');
	if (format.channels !== 1) throw new Error('Delivered WAV must be mono (one channel).');
	const expectedBlockAlign = format.channels * format.bitsPerSample / 8;
	if (format.blockAlign !== expectedBlockAlign || format.byteRate !== format.sampleRate * expectedBlockAlign
		|| dataBytes % format.blockAlign !== 0) {
		throw new Error('Delivered WAV format and data lengths are inconsistent.');
	}
	const durationSeconds = dataBytes / format.byteRate;
	finiteNumber(durationSeconds, 'Delivered WAV duration', { positive: true });
	return {
		sample_rate: format.sampleRate,
		channels: format.channels,
		sample_width_bits: format.bitsPerSample,
		data_bytes: dataBytes,
		duration_seconds: durationSeconds,
	};
}

async function verifiedStoredNarration(file, entry) {
	if (!entry || entry.audio?.basename !== `${entry.id}.wav` || !/^[0-9a-f]{64}$/.test(entry.audio.sha256)) {
		throw new Error('Changedrop narration audio identity is invalid.');
	}
	let metadata;
	try {
		metadata = await lstat(file);
	} catch {
		throw new Error(`Delivered narration for segment "${entry.id}" is missing.`);
	}
	if (!metadata.isFile() || metadata.isSymbolicLink()) {
		throw new Error(`Delivered narration for segment "${entry.id}" is not a regular file.`);
	}
	const bytes = await readFile(file);
	const digest = createHash('sha256').update(bytes).digest('hex');
	if (digest !== entry.audio.sha256) throw new Error(`Delivered narration hash differs for segment "${entry.id}".`);
	const wav = inspectDeliveredWav(bytes);
	if (Math.abs(wav.duration_seconds - entry.duration_seconds) > 1 / wav.sample_rate) {
		throw new Error(`Delivered narration duration differs from its manifest for segment "${entry.id}".`);
	}
	return wav;
}

async function verifiedDeliveredAudio(result) {
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
	if (bytes.length !== result.audio.bytes) throw new Error('Voice audio artifact byte length differs from the service result.');
	const digest = createHash('sha256').update(bytes).digest('hex');
	if (digest !== result.audio.sha256) throw new Error('Voice audio artifact hash differs from the service result.');
	const wav = inspectDeliveredWav(bytes);
	if (wav.sample_rate !== result.audio.sample_rate || wav.channels !== result.audio.channels
		|| wav.sample_width_bits !== result.audio.sample_width_bits) {
		throw new Error('Voice audio artifact format differs from the service result.');
	}
	return { bytes, wav };
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
	if (args.phase === 'measure'
		&& (scriptPath.startsWith(`${output}${path.sep}`) || timingsPath.startsWith(`${output}${path.sep}`))) {
		throw new Error('--out may not contain a voice input file during measurement.');
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
	if (args.phase === 'validate') {
		let narration;
		try {
			narration = JSON.parse(await readFile(path.join(output, 'narration.json'), 'utf8'));
		} catch {
			throw new Error('Could not read delivered changedrop narration inside EZHUD_CHANGEDROP_ROOT.');
		}
		validateNarrationManifest(narration, script);
		for (const entry of narration.segments) {
			await verifiedStoredNarration(path.join(output, entry.audio.basename), entry);
		}
		assertNarrationFitsCapture({ script, timings, narration });
		stdout(JSON.stringify(narration));
		return narration;
	}

	const requests = buildMeasurementRequests({ script, timings });
	await ensurePrivateParents(root, path.dirname(output));
	const staging = `${output}.staging-${process.pid}`;
	await rm(staging, { recursive: true, force: true });
	await mkdir(staging, { mode: 0o700 });
	await chmod(staging, 0o700);
	try {
		const results = [];
		const localMeasurements = [];
		const narrationSegments = [];
		for (const [index, request] of requests.entries()) {
			const segment = script.segments[index];
			const { result } = await submitWithPolicy(request, transport, { segmentId: segment.id });
			const basename = `${segment.id}.wav`;
			const delivered = await verifiedDeliveredAudio(result);
			const audioFile = path.join(staging, basename);
			await writeFile(audioFile, delivered.bytes, { mode: 0o600 });
			await chmod(audioFile, 0o600);
			results.push(result);
			localMeasurements.push({ id: segment.id, duration_seconds: delivered.wav.duration_seconds });
			narrationSegments.push(sanitizeVoiceResult({
				segment,
				request,
				result,
				basename,
				localDurationSeconds: delivered.wav.duration_seconds,
			}));
		}
		const fitted = fitCaptureScript({ script, timings, measurements: localMeasurements });
		const fitReceipt = buildFitReceipt({ fitted, script, requests, results });
		const narration = validateNarrationManifest(privacyChecked({
			schema_version: OUTPUT_SCHEMA_VERSION,
			project: PROJECT,
			voice_profile: VOICE_PROFILE,
			segments: narrationSegments,
		}, 'Changedrop narration'), script);
		const fittedScriptFile = path.join(staging, 'script.json');
		const fitManifest = path.join(staging, 'fit.json');
		const narrationManifest = path.join(staging, 'narration.json');
		await writeFile(fittedScriptFile, `${JSON.stringify(fitted.script, null, 2)}\n`, { mode: 0o600 });
		await writeFile(fitManifest, `${JSON.stringify(fitReceipt, null, 2)}\n`, { mode: 0o600 });
		await writeFile(narrationManifest, `${JSON.stringify(narration, null, 2)}\n`, { mode: 0o600 });
		await chmod(fittedScriptFile, 0o600);
		await chmod(fitManifest, 0o600);
		await chmod(narrationManifest, 0o600);
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
			console.error(`changedrop voice: ${error.message}${prerequisite}`);
		} else {
			console.error(`changedrop voice: ${String(error.message ?? error)}`);
		}
		process.exitCode = 1;
	});
}
