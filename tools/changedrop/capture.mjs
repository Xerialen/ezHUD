#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import {
	chmod,
	lstat,
	mkdir,
	readFile,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { hostname } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const INPUT_SCHEMA_VERSION = 'changedrop-script/1';
const OUTPUT_SCHEMA_VERSION = 'changedrop-timings/1';
const ROOT_VARIABLE = 'EZHUD_CHANGEDROP_ROOT';
const INTRO = "Hey guys, it's Xerial. Here's what's new in ezHUD.";
const OUTRO = "Be safe, and don't walk on spawns.";
const MAX_WAIT_MS = 120_000;
// Engine-polled controls can cross several browser/engine readback cycles. A
// two-second repeat tolerance admits that measured interaction jitter while
// still rejecting a lost wait or an accidentally extended narration hold.
export const REPEAT_DURATION_TOLERANCE_SECONDS = 2.0;
// Frame timestamps and the browser's performance clock can straddle one final
// scheduling boundary. A tenth of a second permits that boundary but still
// rejects a receipt that describes content materially beyond its container.
export const CONTAINER_CONTENT_EPSILON_SECONDS = 0.1;
const DEVICE_SCALE_FACTOR = 2;
// CSS viewport for the capture page. The recording surface must match this
// pixel-for-pixel: Playwright's video recorder captures the CSS viewport,
// not the device-pixel backing store, so a recordVideo.size larger than
// viewport pads the output with flat background (tested: 75 % of every
// frame was gray when they diverged).
export const CAPTURE_VIEWPORT = Object.freeze({ width: 1400, height: 788 });
const ACCENT = '#ff4116';
const LIGHT = '#fffaf2';
const DARK = '#11100f';
const RING_PADDING = 6;
const MAX_PROBE_OUTPUT_BYTES = 65_536;
const PROBE_TIMEOUT_MS = 30_000;

export const ACTIONS = Object.freeze(['wait-for', 'resize', 'click', 'hold', 'highlight']);
export const SELECTOR_PATTERN = /^(?:#[A-Za-z][A-Za-z0-9_-]{0,63}|\[data-changedrop="[a-z0-9]+(?:-[a-z0-9]+)*"\])$/;

// Five seconds (5000 ms) is long enough to hold a current narration beat or
// changed control legibly, but short enough that one typo cannot stall a run.
export const MAX_HOLD_MS = 5_000;
// Three minutes (180 seconds) bounds the complete browser operation. Existing
// WebAssembly/demo boot may consume two minutes; the remaining minute is ample
// for these short walkthroughs while ensuring a stalled browser is finite.
export const MAX_CAPTURE_MS = 180_000;

const ACTION_SET = new Set(ACTIONS);

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

function validateSelector(value, at) {
	if (typeof value !== 'string' || !SELECTOR_PATTERN.test(value)) {
		throw new Error(`${at} selector must be id-style (#name) or [data-changedrop="kebab-name"].`);
	}
}

function validateWalkthrough(value, at, { setup = false } = {}) {
	if (!Array.isArray(value) || value.length === 0) throw new Error(`${at} must be a non-empty array.`);
	for (const [index, step] of value.entries()) {
		const label = `${at} step ${index + 1}`;
		if (!step || typeof step !== 'object' || Array.isArray(step)) throw new Error(`${label} must be an object.`);
		nonEmptyString(step.instruction, `${label} instruction`);
		if (!ACTION_SET.has(step.action)) throw new Error(`${label} has unknown action "${String(step.action)}".`);
		switch (step.action) {
		case 'wait-for':
			exactObject(step, ['instruction', 'action', 'selector', 'state'], label);
			validateSelector(step.selector, label);
			if (!['visible', 'enabled', 'pressed', 'unpressed'].includes(step.state)) {
				throw new Error(`${label} wait-for state is not allowed.`);
			}
			break;
		case 'resize':
			exactObject(step, ['instruction', 'action', 'width', 'height'], label);
			if (!Number.isInteger(step.width) || step.width < 320 || step.width > 3840
				|| !Number.isInteger(step.height) || step.height < 240 || step.height > 2160) {
				throw new Error(`${label} resize dimensions are outside 320x240 to 3840x2160.`);
			}
			break;
		case 'click':
			exactObject(step, ['instruction', 'action', 'selector'], label);
			validateSelector(step.selector, label);
			break;
		case 'hold':
			exactObject(step, step.fit === undefined
				? ['instruction', 'action', 'duration_ms']
				: ['instruction', 'action', 'duration_ms', 'fit'], label);
			if (!Number.isInteger(step.duration_ms) || step.duration_ms < 100 || step.duration_ms > MAX_HOLD_MS) {
				throw new Error(`${label} hold duration must be between 100 and 5000 ms.`);
			}
			if (step.fit !== undefined && step.fit !== 'narration') {
				throw new Error(`${label} hold fit must be narration.`);
			}
			if (setup && step.fit !== undefined) throw new Error(`${label} cannot fit narration during setup.`);
			break;
		case 'highlight': {
			exactObject(step, ['instruction', 'action', 'selector', 'badge', 'crop'], label);
			if (setup) throw new Error(`${label} highlight is not allowed during setup.`);
			validateSelector(step.selector, label);
			if (!Number.isInteger(step.badge) || step.badge < 1 || step.badge > 99) {
				throw new Error(`${label} highlight badge must be an integer from 1 to 99.`);
			}
			exactObject(step.crop, ['width', 'height'], `${label} crop`);
			if (!Number.isInteger(step.crop.width) || step.crop.width < 320 || step.crop.width > 1200
				|| !Number.isInteger(step.crop.height) || step.crop.height < 180 || step.crop.height > 800) {
				throw new Error(`${label} highlight crop dimensions are outside the allowed bounds.`);
			}
			const ratio = step.crop.width / step.crop.height;
			if (ratio < 1.6 || ratio > 2.2) throw new Error(`${label} highlight crop must be between 1.6:1 and 2.2:1.`);
			break;
		}
		default:
			throw new Error(`${label} has unknown action "${String(step.action)}".`);
		}
	}
}

function assertNarrationPadding(walkthrough, at) {
	const indices = walkthrough.flatMap((step, index) => step.fit === 'narration' ? [index] : []);
	if (indices.length === 0) throw new Error(`${at} must contain a narration-fitted hold.`);
	if (indices.some((index, offset) => offset > 0 && index !== indices[offset - 1] + 1)) {
		throw new Error(`${at} narration-fitted holds must be contiguous.`);
	}
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

export function validateCaptureScript(script) {
	exactObject(script, ['schema_version', 'setup', 'segments'], 'Changedrop script');
	if (script.schema_version !== INPUT_SCHEMA_VERSION) throw new Error(`Changedrop script must use ${INPUT_SCHEMA_VERSION}.`);
	validateWalkthrough(script.setup, 'Changedrop capture setup', { setup: true });
	if (!Array.isArray(script.segments) || script.segments.length < 3) {
		throw new Error('Changedrop script must contain intro, surface, and outro segments.');
	}
	const ids = new Set();
	const texts = new Set();
	for (const [index, segment] of script.segments.entries()) {
		exactObject(segment, ['id', 'kind', 'surface', 'text', 'estimated_duration_seconds', 'walkthrough'],
			`Changedrop script segment ${index + 1}`);
		if (typeof segment.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(segment.id)) {
			throw new Error(`Changedrop script segment ${index + 1} has an invalid id.`);
		}
		if (ids.has(segment.id)) throw new Error(`Changedrop script has duplicate segment id "${segment.id}".`);
		ids.add(segment.id);
		if (!['bookend', 'surface'].includes(segment.kind)) throw new Error(`Changedrop segment "${segment.id}" has invalid kind.`);
		if (segment.kind === 'surface') {
			if (segment.surface !== segment.id) throw new Error(`Changedrop surface segment "${segment.id}" must key its own surface.`);
		} else if (segment.surface !== null) {
			throw new Error(`Changedrop bookend "${segment.id}" must have a null surface.`);
		}
		nonEmptyString(segment.text, `Changedrop segment "${segment.id}" text`);
		if (texts.has(segment.text)) throw new Error('Changedrop script contains duplicated segment text.');
		texts.add(segment.text);
		finiteNumber(segment.estimated_duration_seconds, `Changedrop segment "${segment.id}" estimate`, { positive: true });
		if (segment.estimated_duration_seconds > 10) throw new Error(`Changedrop segment "${segment.id}" exceeds 10 seconds.`);
		validateWalkthrough(segment.walkthrough, `Changedrop segment "${segment.id}" walkthrough`);
		assertNarrationPadding(segment.walkthrough, `Changedrop segment "${segment.id}" walkthrough`);
	}
	const first = script.segments[0];
	const last = script.segments.at(-1);
	if (first.id !== 'intro' || first.kind !== 'bookend' || first.text !== INTRO) {
		throw new Error('Changedrop script intro must be a standalone first segment.');
	}
	if (last.id !== 'outro' || last.kind !== 'bookend' || last.text !== OUTRO) {
		throw new Error('Changedrop script outro must be a standalone last segment.');
	}
	if (script.segments.slice(1, -1).some((segment) => segment.kind !== 'surface')) {
		throw new Error('Only the first and last changedrop segments may be bookends.');
	}
	return privacyChecked(script, 'Changedrop script');
}

function safeRelativePng(value, source) {
	const pattern = source
		? /^stills\/sources\/[a-z0-9]+(?:-[a-z0-9]+)*-[1-9][0-9]*\.png$/
		: /^stills\/[a-z0-9]+(?:-[a-z0-9]+)*-[1-9][0-9]*\.png$/;
	if (typeof value !== 'string' || !pattern.test(value)) throw new Error('Highlight still basename is invalid.');
}

function validateRecording(recording) {
	exactObject(recording, ['basename', 'bytes', 'duration_seconds', 'container_duration_seconds'], 'Changedrop recording');
	if (recording.basename !== 'walkthrough.webm') throw new Error('Changedrop recording basename must be walkthrough.webm.');
	if (!Number.isInteger(recording.bytes) || recording.bytes <= 0) throw new Error('Changedrop recording must be non-empty.');
	finiteNumber(recording.duration_seconds, 'Changedrop recording content duration', { positive: true });
	finiteNumber(recording.container_duration_seconds, 'Changedrop recording container duration', { positive: true });
	if (recording.container_duration_seconds + CONTAINER_CONTENT_EPSILON_SECONDS < recording.duration_seconds) {
		throw new Error('Changedrop recording container duration is shorter than its measured content duration.');
	}
}

export function probeRecordingDuration(file) {
	return new Promise((resolve, reject) => {
		const child = spawn('ffprobe', [
			'-v', 'error',
			'-show_entries', 'format=duration',
			'-of', 'default=noprint_wrappers=1:nokey=1',
			file,
		], { stdio: ['ignore', 'pipe', 'pipe'] });
		let stdout = '';
		let outputBytes = 0;
		let settled = false;
		let timer;
		const finish = (callback, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			callback(value);
		};
		for (const stream of [child.stdout, child.stderr]) {
			stream.on('data', (chunk) => {
				outputBytes += chunk.length;
				if (stream === child.stdout && outputBytes <= MAX_PROBE_OUTPUT_BYTES) stdout += chunk.toString('utf8');
			});
		}
		child.once('error', () => finish(reject, new Error('Could not start fitted capture duration probe.')));
		child.once('close', (exitCode) => {
			if (outputBytes > MAX_PROBE_OUTPUT_BYTES) {
				return finish(reject, new Error('Fitted capture duration probe output exceeded its bound.'));
			}
			const duration = Number(stdout.trim());
			if (exitCode !== 0 || !Number.isFinite(duration) || duration <= 0) {
				return finish(reject, new Error('Could not measure fitted capture container duration.'));
			}
			return finish(resolve, duration);
		});
		timer = setTimeout(() => {
			child.kill('SIGKILL');
			finish(reject, new Error('Fitted capture duration probe exceeded its bounded runtime.'));
		}, PROBE_TIMEOUT_MS);
		timer.unref?.();
	});
}

// Flat-grey detection. Playwright padding produces near-uniform 127–129 luminance
// across padded quadrants with negligible variation (σ ≪ 5). Real content may hit
// the same mean but always carries substantial variation (σ ≫ 5). A quadrant is
// flagged only when it is both mid-grey AND nearly uniform.
const GREY_CENTER = 128;
const GREY_TOLERANCE = 3;
const GREY_STDDEV_MAX = 5;

/**
 * Check that no quadrant of a decoded frame is flat grey.
 *
 * Flat grey = mean luminance in [GREY_CENTER ± GREY_TOLERANCE] AND standard
 * deviation under GREY_STDDEV_MAX. A checkerboard with mean 128 and σ ≈ 88
 * passes because the high variation proves real content. A dark editor panel
 * whose mean happens to fall in the band also passes for the same reason.
 *
 * @param {Buffer} pixels  - raw RGB bytes (width × height × 3), row-major
 * @param {number}  width   - frame width in pixels
 * @param {number}  height  - frame height in pixels
 * @throws if any quadrant is both mid-grey and near-uniform
 */
export function assertFrameFilled(pixels, width, height) {
	if (!Buffer.isBuffer(pixels)) throw new Error('Frame pixels must be a Buffer.');
	if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
		throw new Error('Frame dimensions must be positive integers.');
	}
	const expected = width * height * 3;
	// This length guard is load-bearing, not defensive: a truncated buffer
	// would read undefined past its end, producing NaN for every pixel.
	// NaN compares false against both the mean-band and stddev conditions,
	// so a truncated frame would be silently declared filled without this check.
	if (pixels.length < expected) throw new Error(`Frame buffer is too small (need ${expected}, got ${pixels.length}).`);

	const qw = Math.floor(width / 2);
	const qh = Math.floor(height / 2);
	const quadrants = [
		{ name: 'TL', ox: 0, oy: 0, w: qw, h: qh },
		{ name: 'TR', ox: qw, oy: 0, w: width - qw, h: qh },
		{ name: 'BL', ox: 0, oy: qh, w: qw, h: height - qh },
		{ name: 'BR', ox: qw, oy: qh, w: width - qw, h: height - qh },
	];

	for (const q of quadrants) {
		const n = q.w * q.h;
		// First pass: collect luminance values.
		const lum = new Float64Array(n);
		let i = 0;
		let sum = 0;
		for (let y = q.oy; y < q.oy + q.h; y++) {
			const rowBase = y * width * 3;
			for (let x = q.ox; x < q.ox + q.w; x++) {
				const idx = rowBase + x * 3;
				const v = (pixels[idx] + pixels[idx + 1] + pixels[idx + 2]) / 3;
				lum[i] = v;
				sum += v;
				i += 1;
			}
		}
		const mean = sum / n;
		if (mean < GREY_CENTER - GREY_TOLERANCE || mean > GREY_CENTER + GREY_TOLERANCE) continue;

		// Second pass: standard deviation.
		let sqSum = 0;
		for (let j = 0; j < n; j++) {
			const d = lum[j] - mean;
			sqSum += d * d;
		}
		const stddev = Math.sqrt(sqSum / n);
		if (stddev < GREY_STDDEV_MAX) {
			throw new Error(`Frame quadrant ${q.name} is flat grey (mean ${mean.toFixed(2)}, σ ${stddev.toFixed(2)}), indicating unfilled padding.`);
		}
	}
}

/**
 * Validate a captured video: dimensions must match the expected viewport and no
 * quadrant of a sampled frame may be flat grey.
 *
 * Uses ffprobe for dimensions and ffmpeg to extract a single raw RGB frame.
 *
 * @param {string} file             - path to the webm recording
 * @param {{width: number, height: number}} expected - expected frame dimensions
 * @throws if validation fails
 */
export async function validateRecordingFrame(file, expected) {
	// 1. Check dimensions via ffprobe.
	const dimensions = await new Promise((resolve, reject) => {
		const child = spawn('ffprobe', [
			'-v', 'error',
			'-select_streams', 'v:0',
			'-show_entries', 'stream=width,height',
			'-of', 'csv=p=0',
			file,
		], { stdio: ['ignore', 'pipe', 'pipe'] });
		let stdout = '';
		let settled = false;
		let timer;
		const finish = (callback, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			callback(value);
		};
		child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
		child.once('error', () => finish(reject, new Error('Could not probe recording dimensions.')));
		child.once('close', (code) => {
			if (code !== 0) return finish(reject, new Error('ffprobe exited non-zero on recording.'));
			const [w, h] = stdout.trim().split(',').map(Number);
			if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) {
				return finish(reject, new Error('Could not parse recording dimensions.'));
			}
			finish(resolve, { width: w, height: h });
		});
		timer = setTimeout(() => {
			child.kill('SIGKILL');
			finish(reject, new Error('Dimension probe timed out.'));
		}, PROBE_TIMEOUT_MS);
		timer.unref?.();
	});

	if (dimensions.width !== expected.width || dimensions.height !== expected.height) {
		throw new Error(`Recording dimensions ${dimensions.width}x${dimensions.height} do not match expected ${expected.width}x${expected.height}.`);
	}

	// 2. Extract a frame well past the first (which is often transitional) as raw
	//    RGB24 and check quadrant luminance. If the seek point exceeds the recording
	//    duration ffmpeg produces zero bytes — fall back to the first frame.
	const extractFrame = async (seek) => new Promise((resolve, reject) => {
		const args = ['-v', 'error', '-i', file, '-vframes', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'];
		if (seek !== null) args.splice(2, 0, '-ss', String(seek));
		const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
		const chunks = [];
		let settled = false;
		let timer;
		const finish = (callback, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			callback(value);
		};
		child.stdout.on('data', (chunk) => chunks.push(chunk));
		child.once('error', () => finish(reject, new Error('Could not extract frame from recording.')));
		child.once('close', (code) => {
			if (code !== 0) return finish(reject, new Error('ffmpeg exited non-zero extracting frame.'));
			finish(resolve, Buffer.concat(chunks));
		});
		timer = setTimeout(() => {
			child.kill('SIGKILL');
			finish(reject, new Error('Frame extraction timed out.'));
		}, PROBE_TIMEOUT_MS);
		timer.unref?.();
	});

	let pixels = await extractFrame(2);
	if (pixels.length === 0) pixels = await extractFrame(null);

	assertFrameFilled(pixels, dimensions.width, dimensions.height);
}

export async function recordingMetadata(file, measuredDurationSeconds, containerDurationSeconds) {
	finiteNumber(measuredDurationSeconds, 'Changedrop recording content duration', { positive: true });
	finiteNumber(containerDurationSeconds, 'Changedrop recording container duration', { positive: true });
	let metadata;
	try {
		metadata = await stat(file);
	} catch {
		throw new Error('Changedrop recording is missing.');
	}
	if (!metadata.isFile() || metadata.size <= 0) throw new Error('Changedrop recording must exist and be non-empty.');
	const recording = {
		basename: 'walkthrough.webm',
		bytes: metadata.size,
		duration_seconds: measuredDurationSeconds,
		container_duration_seconds: containerDurationSeconds,
	};
	validateRecording(recording);
	return recording;
}

function machineAction(step) {
	const { instruction: _instruction, ...action } = step;
	return {
		...action,
		...(action.crop ? { crop: { ...action.crop } } : {}),
	};
}

export function buildTimingReceipt({ script, recording, observations } = {}) {
	validateCaptureScript(script);
	validateRecording(recording);
	if (!Array.isArray(observations) || observations.length !== script.segments.length) {
		throw new Error('Capture must provide exactly one timing observation per script segment.');
	}

	let previousStart = -1;
	let previousEnd = 0;
	const segments = script.segments.map((scriptSegment, index) => {
		const observed = observations[index];
		exactObject(observed, ['id', 'start_seconds', 'duration_seconds', 'highlights'],
			`Capture observation ${index + 1}`);
		if (observed.id !== scriptSegment.id) {
			throw new Error(`Capture segment order mismatch: expected "${scriptSegment.id}", got "${String(observed.id)}".`);
		}
		finiteNumber(observed.start_seconds, `Capture segment "${observed.id}" start`, { minimum: 0 });
		finiteNumber(observed.duration_seconds, `Capture segment "${observed.id}" duration`, { positive: true });
		if (observed.start_seconds <= previousStart) throw new Error('Capture segment starts must be strictly monotonic.');
		if (index && observed.start_seconds < previousEnd) throw new Error('Capture segments must not overlap.');
		previousStart = observed.start_seconds;
		previousEnd = observed.start_seconds + observed.duration_seconds;
		if (!Array.isArray(observed.highlights)) throw new Error(`Capture segment "${observed.id}" highlights must be an array.`);
		const expectedHighlights = scriptSegment.walkthrough.filter((step) => step.action === 'highlight');
		if (observed.highlights.length !== expectedHighlights.length) {
			throw new Error(`Capture segment "${observed.id}" must receipt every highlight action exactly once.`);
		}
		const highlights = observed.highlights.map((highlight, highlightIndex) => {
			exactObject(highlight, [
				'timestamp_seconds', 'selector', 'badge', 'source_basename', 'source_bytes', 'basename', 'bytes',
			], `Capture highlight ${highlightIndex + 1} for "${observed.id}"`);
			finiteNumber(highlight.timestamp_seconds, 'Capture highlight timestamp', { minimum: 0 });
			if (highlight.timestamp_seconds < observed.start_seconds || highlight.timestamp_seconds > previousEnd) {
				throw new Error(`Capture highlight for "${observed.id}" must lie inside its segment interval.`);
			}
			const expected = expectedHighlights[highlightIndex];
			if (highlight.selector !== expected.selector || highlight.badge !== expected.badge) {
				throw new Error(`Capture highlight for "${observed.id}" does not match its action sequence.`);
			}
			validateSelector(highlight.selector, 'Capture highlight');
			safeRelativePng(highlight.source_basename, true);
			safeRelativePng(highlight.basename, false);
			if (!Number.isInteger(highlight.source_bytes) || highlight.source_bytes <= 0
				|| !Number.isInteger(highlight.bytes) || highlight.bytes <= 0) {
				throw new Error('Capture focused source and annotated still must be non-empty.');
			}
			return { ...highlight };
		});
		return {
			id: scriptSegment.id,
			kind: scriptSegment.kind,
			surface: scriptSegment.surface,
			start_seconds: observed.start_seconds,
			duration_seconds: observed.duration_seconds,
			actions: scriptSegment.walkthrough.map(machineAction),
			highlights,
		};
	});
	if (recording.duration_seconds < previousEnd) throw new Error('Changedrop recording ends before its final segment.');
	return privacyChecked({
		schema_version: OUTPUT_SCHEMA_VERSION,
		recording: { ...recording },
		setup_actions: script.setup.map(machineAction),
		segments,
	}, 'Changedrop timings');
}

export function assertRepeatableStructure(first, second) {
	for (const receipt of [first, second]) {
		if (!receipt || receipt.schema_version !== OUTPUT_SCHEMA_VERSION || !Array.isArray(receipt.segments)) {
			throw new Error('Repeat capture requires two changedrop-timings/1 receipts.');
		}
	}
	if (JSON.stringify(first.setup_actions) !== JSON.stringify(second.setup_actions)) {
		throw new Error('Repeat capture setup action sequence changed.');
	}
	if (first.segments.length !== second.segments.length) throw new Error('Repeat capture segment count changed.');
	for (let index = 0; index < first.segments.length; index += 1) {
		const left = first.segments[index];
		const right = second.segments[index];
		if (left.id !== right.id || left.kind !== right.kind || left.surface !== right.surface) {
			throw new Error(`Repeat capture segment ordering changed at index ${index}.`);
		}
		if (JSON.stringify(left.actions) !== JSON.stringify(right.actions)) {
			throw new Error(`Repeat capture action sequence changed for "${left.id}".`);
		}
		const leftHighlights = left.highlights.map(({ selector, badge, source_basename, basename }) => ({
			selector, badge, source_basename, basename,
		}));
		const rightHighlights = right.highlights.map(({ selector, badge, source_basename, basename }) => ({
			selector, badge, source_basename, basename,
		}));
		if (JSON.stringify(leftHighlights) !== JSON.stringify(rightHighlights)) {
			throw new Error(`Repeat capture highlight sequence changed for "${left.id}".`);
		}
		if (Math.abs(left.duration_seconds - right.duration_seconds) > REPEAT_DURATION_TOLERANCE_SECONDS) {
			throw new Error(`Repeat capture duration for "${left.id}" exceeds the two-second tolerance.`);
		}
	}
	return true;
}

function parseArguments(argv) {
	const values = new Map();
	for (let index = 0; index < argv.length; index += 1) {
		const name = argv[index];
		if (!['--script', '--dist', '--out'].includes(name)) throw new Error(`Unknown changedrop capture argument: ${name}`);
		const value = argv[index + 1];
		if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
		if (values.has(name)) throw new Error(`${name} may be supplied only once.`);
		values.set(name, value);
		index += 1;
	}
	for (const name of ['--script', '--dist', '--out']) {
		if (!values.has(name)) throw new Error(`${name} is required.`);
	}
	return { script: values.get('--script'), dist: values.get('--dist'), out: values.get('--out') };
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
		if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('capture parent is not a private directory');
		await chmod(cursor, 0o700);
	}
}

const MIME = new Map([
	['.css', 'text/css; charset=utf-8'],
	['.html', 'text/html; charset=utf-8'],
	['.js', 'text/javascript; charset=utf-8'],
	['.json', 'application/json; charset=utf-8'],
	['.pak', 'application/octet-stream'],
	['.pk3', 'application/octet-stream'],
	['.png', 'image/png'],
	['.svg', 'image/svg+xml'],
	['.wasm', 'application/wasm'],
]);

export function basePathFromIndex(source) {
	const match = String(source).match(/"(\/(?:[A-Za-z0-9._-]+\/)*)core\/bridge\.js"\s*:/);
	if (!match) throw new Error('Assembled dist import map does not declare its core/bridge.js base path.');
	const basePath = match[1];
	if (!basePath.startsWith('/') || !basePath.endsWith('/')
		|| basePath.split('/').some((part) => part === '.' || part === '..')) {
		throw new Error('Assembled dist has an unsafe base path.');
	}
	return basePath;
}

async function serveDist(dist, basePath) {
	const server = createServer(async (request, response) => {
		try {
			const url = new URL(request.url ?? '/', 'http://capture.invalid');
			const pathname = decodeURIComponent(url.pathname);
			if (!pathname.startsWith(basePath)) return response.writeHead(404).end('not found');
			let relative = pathname.slice(basePath.length);
			if (!relative || relative.endsWith('/')) relative += 'index.html';
			const file = path.resolve(dist, relative);
			if (file !== dist && !file.startsWith(`${dist}${path.sep}`)) return response.writeHead(403).end('forbidden');
			const metadata = await stat(file).catch(() => null);
			if (!metadata?.isFile()) return response.writeHead(404).end('not found');
			response.writeHead(200, {
				'Content-Type': MIME.get(path.extname(file).toLowerCase()) ?? 'application/octet-stream',
				'Cache-Control': 'no-store',
			});
			createReadStream(file).pipe(response);
		} catch {
			response.writeHead(500).end('capture server failure');
		}
	});
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const address = server.address();
	if (!address || typeof address !== 'object') throw new Error('Changedrop capture server did not bind.');
	return {
		url: `http://127.0.0.1:${address.port}${basePath}`,
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}

function pngDimensions(bytes) {
	const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
	if (!bytes.subarray(0, 8).equals(signature) || bytes.toString('ascii', 12, 16) !== 'IHDR') {
		throw new Error('Focused capture is not a PNG.');
	}
	return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function ringSvg(target, badge) {
	const ring = {
		x: target.x - RING_PADDING,
		y: target.y - RING_PADDING,
		width: target.width + 2 * RING_PADDING,
		height: target.height + 2 * RING_PADDING,
	};
	const radius = Math.min(9, ring.height / 2);
	const badgeX = ring.x >= 18 ? ring.x - 9 : ring.x + ring.width + 9;
	const badgeY = ring.y + ring.height / 2;
	const common = `x="${ring.x}" y="${ring.y}" width="${ring.width}" height="${ring.height}" rx="${radius}" fill="none"`;
	return `<rect ${common} stroke="${LIGHT}" stroke-width="5"/>`
		+ `<rect ${common} stroke="${ACCENT}" stroke-width="3"/>`
		+ `<circle cx="${badgeX}" cy="${badgeY}" r="8" fill="${ACCENT}" stroke="${LIGHT}" stroke-width="1"/>`
		+ `<text x="${badgeX}" y="${badgeY + 4}" text-anchor="middle" fill="${DARK}" `
		+ `font-family="monospace" font-size="11" font-weight="800">${badge}</text>`;
}

function annotationHtml(sourceBytes, size, target, badge) {
	return `<!doctype html><html><head><meta charset="utf-8"><style>`
		+ `html,body{margin:0;width:${size.width}px;height:${size.height}px;overflow:hidden;background:#000}`
		+ `#frame,#source,svg{position:absolute;inset:0;width:${size.width}px;height:${size.height}px;display:block}`
		+ `</style></head><body><div id="frame"><img id="source" alt="" `
		+ `src="data:image/png;base64,${sourceBytes.toString('base64')}">`
		+ `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" `
		+ `viewBox="0 0 ${size.width} ${size.height}">${ringSvg(target, badge)}</svg></div></body></html>`;
}

async function annotateFocusedStill(annotationPage, sourceBytes, target, badge, output) {
	const size = pngDimensions(sourceBytes);
	await annotationPage.setViewportSize(size);
	await annotationPage.setContent(annotationHtml(sourceBytes, size, target, badge), { waitUntil: 'load' });
	await annotationPage.locator('#source').waitFor({ state: 'visible' });
	await annotationPage.locator('#frame').screenshot({ path: output, type: 'png', animations: 'disabled', caret: 'hide' });
	const annotated = await readFile(output);
	const outputSize = pngDimensions(annotated);
	if (outputSize.width !== size.width || outputSize.height !== size.height) {
		throw new Error('Annotated focused still changed dimensions.');
	}
	await chmod(output, 0o600);
	return annotated.length;
}

function liveRingCss(selector, badge) {
	return `${selector}{position:relative!important;outline:3px solid ${ACCENT}!important;`
		+ `box-shadow:0 0 0 5px ${LIGHT},inset 0 0 0 1px ${LIGHT}!important}`
		+ `${selector}::after{content:"${badge}"!important;position:absolute!important;z-index:2147483647!important;`
		+ `left:-18px!important;top:50%!important;transform:translateY(-50%)!important;width:16px!important;`
		+ `height:16px!important;border-radius:50%!important;background:${ACCENT}!important;color:${DARK}!important;`
		+ `border:1px solid ${LIGHT}!important;font:800 11px/16px monospace!important;text-align:center!important}`;
}

function clearRingCss(selector) {
	return `${selector}{outline:none!important;box-shadow:none!important}`
		+ `${selector}::after{content:none!important;display:none!important}`;
}

function focusedClip(box, crop, viewport) {
	if (crop.width > viewport.width || crop.height > viewport.height) throw new Error('Highlight crop exceeds the active viewport.');
	if (box.width > crop.width || box.height > crop.height) throw new Error('Highlighted control does not fit inside its focused crop.');
	const x = Math.max(0, Math.min(viewport.width - crop.width, box.x + box.width / 2 - crop.width / 2));
	const y = Math.max(0, Math.min(viewport.height - crop.height, box.y + box.height / 2 - crop.height / 2));
	if (box.x < x || box.y < y || box.x + box.width > x + crop.width || box.y + box.height > y + crop.height) {
		throw new Error('Highlighted control lies outside its focused crop.');
	}
	return { x, y, width: crop.width, height: crop.height };
}

function remainingMs(deadline) {
	const remaining = deadline - performance.now();
	if (remaining <= 0) throw new Error('Changedrop capture exceeded the three-minute total limit.');
	return remaining;
}

async function bounded(operation, deadline, label) {
	const remaining = remainingMs(deadline);
	let timer;
	try {
		return await Promise.race([
			operation,
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} exceeded the total capture limit.`)), remaining);
				timer.unref?.();
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

async function executeStep({
	page,
	annotationPage,
	step,
	deadline,
	output,
	segmentId,
	highlightIndex,
	captureStart,
	activeRing,
}) {
	const timeout = Math.min(MAX_WAIT_MS, remainingMs(deadline));
	switch (step.action) {
	case 'wait-for': {
		let locator = page.locator(step.selector);
		if (step.state === 'pressed' || step.state === 'unpressed') {
			locator = page.locator(`${step.selector}[aria-pressed="${step.state === 'pressed'}"]`);
		}
		if (step.state === 'enabled') await bounded(locator.click({ trial: true, timeout }), deadline, 'wait-for enabled');
		else await bounded(locator.waitFor({ state: 'visible', timeout }), deadline, `wait-for ${step.state}`);
		return null;
	}
	case 'resize':
		await bounded(page.setViewportSize({ width: step.width, height: step.height }), deadline, 'resize');
		return null;
	case 'click':
		await bounded(page.locator(step.selector).click({ timeout }), deadline, 'click');
		return null;
	case 'hold':
		await bounded(page.waitForTimeout(step.duration_ms), deadline, 'hold');
		return null;
	case 'highlight': {
		if (!segmentId) throw new Error('Highlight action requires a timed segment.');
		if (activeRing.selector) await page.addStyleTag({ content: clearRingCss(activeRing.selector) });
		const locator = page.locator(step.selector);
		await bounded(locator.waitFor({ state: 'visible', timeout }), deadline, 'highlight target');
		const box = await locator.boundingBox();
		if (!box) throw new Error('Highlight selector has no visible geometry.');
		const viewport = page.viewportSize();
		if (!viewport) throw new Error('Capture page has no viewport.');
		const clip = focusedClip(box, step.crop, viewport);
		const sourceRelative = `stills/sources/${segmentId}-${highlightIndex}.png`;
		const annotatedRelative = `stills/${segmentId}-${highlightIndex}.png`;
		const source = path.join(output, ...sourceRelative.split('/'));
		const annotated = path.join(output, ...annotatedRelative.split('/'));
		await mkdir(path.dirname(source), { recursive: true, mode: 0o700 });
		await chmod(path.dirname(source), 0o700);
		await mkdir(path.dirname(annotated), { recursive: true, mode: 0o700 });
		await chmod(path.dirname(annotated), 0o700);
		const sourceBytes = await page.screenshot({ clip, type: 'png', animations: 'disabled', caret: 'hide' });
		await writeFile(source, sourceBytes, { mode: 0o600 });
		await chmod(source, 0o600);
		const target = {
			x: Math.round((box.x - clip.x) * DEVICE_SCALE_FACTOR),
			y: Math.round((box.y - clip.y) * DEVICE_SCALE_FACTOR),
			width: Math.round(box.width * DEVICE_SCALE_FACTOR),
			height: Math.round(box.height * DEVICE_SCALE_FACTOR),
		};
		const annotatedBytes = await annotateFocusedStill(annotationPage, sourceBytes, target, step.badge, annotated);
		await page.addStyleTag({ content: liveRingCss(step.selector, step.badge) });
		activeRing.selector = step.selector;
		const timestamp = (performance.now() - captureStart) / 1000;
		return {
			timestamp_seconds: timestamp,
			selector: step.selector,
			badge: step.badge,
			source_basename: sourceRelative,
			source_bytes: sourceBytes.length,
			basename: annotatedRelative,
			bytes: annotatedBytes,
		};
	}
	default:
		throw new Error(`Unknown changedrop capture action "${String(step.action)}".`);
	}
}

async function runBrowserCapture({ script, dist, output }) {
	const operationStart = performance.now();
	const deadline = operationStart + MAX_CAPTURE_MS;
	const basePath = basePathFromIndex(await readFile(path.join(dist, 'index.html'), 'utf8'));
	const hosted = await bounded(serveDist(dist, basePath), deadline, 'capture server');
	let browser;
	let context;
	let annotationContext;
	try {
		const { chromium } = await bounded(import('playwright'), deadline, 'Playwright load');
		browser = await bounded(chromium.launch({ channel: 'chrome', headless: true }), deadline, 'browser launch');
		const videoDirectory = path.join(output, '.video');
		await mkdir(videoDirectory, { mode: 0o700 });
		context = await browser.newContext({
			viewport: { ...CAPTURE_VIEWPORT },
			deviceScaleFactor: DEVICE_SCALE_FACTOR,
			colorScheme: 'dark',
			recordVideo: { dir: videoDirectory, size: { ...CAPTURE_VIEWPORT } },
		});
		annotationContext = await browser.newContext({ viewport: { width: 550, height: 300 }, deviceScaleFactor: 1 });
		const annotationPage = await annotationContext.newPage();
		const page = await context.newPage();
		page.setDefaultTimeout(MAX_WAIT_MS);
		await page.route('**/*', async (route) => {
			const requestUrl = new URL(route.request().url());
			const hostedUrl = new URL(hosted.url);
			if (requestUrl.hostname === hostedUrl.hostname && requestUrl.port === hostedUrl.port) await route.continue();
			else await route.abort();
		});
		const video = page.video();
		if (!video) throw new Error('Playwright did not create a walkthrough recording.');
		const captureStart = performance.now();
		await bounded(page.goto(hosted.url, { waitUntil: 'domcontentloaded', timeout: Math.min(MAX_WAIT_MS, remainingMs(deadline)) }),
			deadline, 'page load');
		const activeRing = { selector: null };
		for (const step of script.setup) {
			await executeStep({ page, annotationPage, step, deadline, output, captureStart, activeRing });
		}
		const observations = [];
		for (const segment of script.segments) {
			if (activeRing.selector) {
				await page.addStyleTag({ content: clearRingCss(activeRing.selector) });
				activeRing.selector = null;
			}
			const segmentStarted = performance.now();
			const highlights = [];
			let highlightIndex = 0;
			for (const step of segment.walkthrough) {
				if (step.action === 'highlight') highlightIndex += 1;
				const highlight = await executeStep({
					page, annotationPage, step, deadline, output,
					segmentId: segment.id,
					highlightIndex,
					captureStart,
					activeRing,
				});
				if (highlight) highlights.push(highlight);
			}
			const segmentEnded = performance.now();
			observations.push({
				id: segment.id,
				start_seconds: (segmentStarted - captureStart) / 1000,
				duration_seconds: (segmentEnded - segmentStarted) / 1000,
				highlights,
			});
		}
		if (activeRing.selector) await page.addStyleTag({ content: clearRingCss(activeRing.selector) });
		const captureEnded = performance.now();
		await bounded(context.close(), deadline, 'video finalization');
		context = null;
		const recordingPath = path.join(output, 'walkthrough.webm');
		await bounded(video.saveAs(recordingPath), deadline, 'video save');
		await chmod(recordingPath, 0o600);
		await rm(videoDirectory, { recursive: true, force: true });
		await bounded(
			validateRecordingFrame(recordingPath, CAPTURE_VIEWPORT), deadline, 'recording frame validation');
		const containerDurationSeconds = await bounded(
			probeRecordingDuration(recordingPath), deadline, 'recording duration probe');
		const recording = await recordingMetadata(
			recordingPath,
			(captureEnded - captureStart) / 1000,
			containerDurationSeconds,
		);
		return buildTimingReceipt({ script, recording, observations });
	} finally {
		if (context) await context.close().catch(() => {});
		if (annotationContext) await annotationContext.close().catch(() => {});
		if (browser) await browser.close().catch(() => {});
		await hosted.close();
	}
}

export async function main({
	env = process.env,
	argv = process.argv.slice(2),
	cwd = process.cwd(),
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
	const output = pathInsideRoot(root, args.out);
	if (!scriptPath) throw new Error('--script must resolve inside EZHUD_CHANGEDROP_ROOT.');
	if (!output) throw new Error('--out must resolve inside EZHUD_CHANGEDROP_ROOT.');
	if (scriptPath.startsWith(`${output}${path.sep}`)) throw new Error('--out may not contain the input script.');
	const dist = path.resolve(cwd, args.dist);
	const distIndex = await stat(path.join(dist, 'index.html')).catch(() => null);
	if (!distIndex?.isFile()) throw new Error('--dist must name an assembled dist with index.html.');
	let script;
	try {
		script = JSON.parse(await readFile(scriptPath, 'utf8'));
	} catch {
		throw new Error('Could not read changedrop script inside EZHUD_CHANGEDROP_ROOT.');
	}
	validateCaptureScript(script);
	try {
		await ensurePrivateParents(root, path.dirname(output));
		await rm(output, { recursive: true, force: true });
		await mkdir(output, { mode: 0o700 });
		await chmod(output, 0o700);
	} catch {
		throw new Error('Could not prepare private changedrop capture output.');
	}
	const receipt = await runBrowserCapture({ script, dist, output });
	const timingsPath = path.join(output, 'timings.json');
	await writeFile(timingsPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
	await chmod(timingsPath, 0o600);
	stdout(JSON.stringify(receipt));
	return receipt;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
	main().catch((error) => {
		console.error(`changedrop capture: ${String(error.message ?? error)}`);
		process.exitCode = 1;
	});
}
