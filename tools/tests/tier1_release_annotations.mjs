#!/usr/bin/env node
// Tier-1 contract for committed Release 1 annotation bytes. This test uses
// only Node built-ins: PNG validation is zlib inflate + scanline defiltering,
// never a browser or image package.
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const releaseDir = path.join(repo, 'docs/release-1');
const manifestPath = path.join(releaseDir, 'annotations.json');
const capturesPath = path.join(releaseDir, 'captures.json');
const afterStatePath = path.join(releaseDir, 'img/after-state.json');
const FULL_FRAME_BY_ID = {
	'pause-resume': 'img/after-paused.png',
	'canvas-resize': 'img/after-resized-window.png',
};
const CALLOUT_TEST_MARGIN = 10;

function assertObject(value, label) {
	assert(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
}

async function nonEmptyFile(file, label) {
	const info = await stat(file).catch(() => null);
	assert(info?.isFile(), `${label} does not exist`);
	assert(info.size > 0, `${label} is empty`);
	return readFile(file);
}

function releasePath(rel, label) {
	assert.equal(typeof rel, 'string', `${label} must be a string`);
	const resolved = path.resolve(releaseDir, rel);
	assert(resolved.startsWith(`${releaseDir}${path.sep}`), `${label} escapes docs/release-1`);
	return resolved;
}

function paeth(a, b, c) {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function decodePng(bytes, label) {
	const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
	assert(bytes.subarray(0, 8).equals(signature), `${label} is not a PNG`);
	let offset = 8;
	let ihdr = null;
	const idat = [];
	while (offset < bytes.length) {
		assert(offset + 12 <= bytes.length, `${label} has a truncated PNG chunk`);
		const length = bytes.readUInt32BE(offset);
		const type = bytes.toString('ascii', offset + 4, offset + 8);
		const start = offset + 8;
		const end = start + length;
		assert(end + 4 <= bytes.length, `${label} has a truncated ${type} chunk`);
		if (type === 'IHDR') ihdr = bytes.subarray(start, end);
		if (type === 'IDAT') idat.push(bytes.subarray(start, end));
		offset = end + 4; // CRC is not needed to validate committed pixel content.
		if (type === 'IEND') break;
	}
	assert(ihdr && ihdr.length === 13, `${label} has no valid IHDR`);
	const width = ihdr.readUInt32BE(0);
	const height = ihdr.readUInt32BE(4);
	const bitDepth = ihdr[8];
	const colorType = ihdr[9];
	assert.equal(bitDepth, 8, `${label} must be 8-bit PNG`);
	assert([2, 6].includes(colorType), `${label} must be RGB or RGBA PNG`);
	assert.equal(ihdr[10], 0, `${label} uses unsupported PNG compression`);
	assert.equal(ihdr[11], 0, `${label} uses unsupported PNG filtering`);
	assert.equal(ihdr[12], 0, `${label} must be non-interlaced`);
	assert(width > 0 && height > 0, `${label} has degenerate dimensions`);
	const channels = colorType === 2 ? 3 : 4;
	const stride = width * channels;
	const inflated = inflateSync(Buffer.concat(idat));
	assert.equal(inflated.length, height * (stride + 1), `${label} has unexpected scanline bytes`);
	const pixels = Buffer.alloc(width * height * channels);
	let input = 0;
	for (let y = 0; y < height; y += 1) {
		const filter = inflated[input++];
		assert(filter <= 4, `${label} uses unknown PNG filter ${filter}`);
		const row = y * stride;
		const previous = row - stride;
		for (let x = 0; x < stride; x += 1) {
			const raw = inflated[input++];
			const left = x >= channels ? pixels[row + x - channels] : 0;
			const up = y > 0 ? pixels[previous + x] : 0;
			const upperLeft = y > 0 && x >= channels ? pixels[previous + x - channels] : 0;
			let value = raw;
			if (filter === 1) value += left;
			else if (filter === 2) value += up;
			else if (filter === 3) value += Math.floor((left + up) / 2);
			else if (filter === 4) value += paeth(left, up, upperLeft);
			pixels[row + x] = value & 0xff;
		}
	}
	return { width, height, channels, pixels };
}

function parseAccent(value, label) {
	assert.match(value, /^#[0-9a-f]{6}$/i, `${label} must be #rrggbb`);
	return [1, 3, 5].map((at) => Number.parseInt(value.slice(at, at + 2), 16));
}

function countAccent(image, accent, rect) {
	let count = 0;
	const x0 = Math.max(0, Math.floor(rect.x));
	const y0 = Math.max(0, Math.floor(rect.y));
	const x1 = Math.min(image.width, Math.ceil(rect.x + rect.w));
	const y1 = Math.min(image.height, Math.ceil(rect.y + rect.h));
	for (let y = y0; y < y1; y += 1) {
		for (let x = x0; x < x1; x += 1) {
			const at = (y * image.width + x) * image.channels;
			const close = accent.every((channel, i) => Math.abs(image.pixels[at + i] - channel) <= 32);
			if (close) count += 1;
		}
	}
	return count;
}

function finiteNumber(value, label) {
	assert.equal(typeof value, 'number', `${label} must be a number`);
	assert(Number.isFinite(value), `${label} must be finite`);
}

function inside(rect, width, height, label) {
	for (const key of ['x', 'y', 'w', 'h']) finiteNumber(rect[key], `${label}.${key}`);
	assert(rect.w > 0 && rect.h > 0, `${label} must be non-degenerate`);
	assert(rect.x >= 0 && rect.y >= 0 && rect.x + rect.w <= width && rect.y + rect.h <= height,
		`${label} lies outside ${width}x${height}`);
}


const manifestBytes = await nonEmptyFile(manifestPath, 'docs/release-1/annotations.json');
const manifest = JSON.parse(manifestBytes.toString('utf8'));
assertObject(manifest, 'manifest');
assert.equal(manifest.version, 1, 'annotation manifest version must be 1');
assert(Array.isArray(manifest.assets) && manifest.assets.length > 0, 'manifest.assets must be non-empty');
assert.deepEqual(manifest.assets.map((asset) => asset.id).sort(), ['canvas-resize', 'pause-resume'],
	'manifest must carry the reviewed pause and reusable canvas-resize annotations');

const captures = JSON.parse((await nonEmptyFile(capturesPath, 'docs/release-1/captures.json')).toString('utf8'));
assertObject(captures, 'captures manifest');
assert.equal(captures.version, 1, 'capture manifest version must be 1');
assert(Array.isArray(captures.captures), 'captures.captures must be an array');
assert.deepEqual(captures.captures.map((capture) => capture.id).sort(), ['canvas-resize', 'pause-resume'],
	'capture manifest must carry both focused proofs');
const captureById = new Map(captures.captures.map((capture) => [capture.id, capture]));
for (const capture of captures.captures) {
	assert.equal(capture.deviceScaleFactor, 2, `${capture.id} must capture at deviceScaleFactor 2`);
	assert.equal(typeof capture.page, 'string', `${capture.id}.page must be a string`);
	assertObject(capture.state, `${capture.id}.state`);
	assertObject(capture.viewport, `${capture.id}.viewport`);
	assertObject(capture.clip, `${capture.id}.clip`);
	for (const key of ['x', 'y', 'w', 'h']) finiteNumber(capture.clip[key], `${capture.id}.clip.${key}`);
	assert(capture.clip.w > 0 && capture.clip.h > 0, `${capture.id}.clip must be non-degenerate`);
	assert(capture.clip.x >= 0 && capture.clip.y >= 0
		&& capture.clip.x + capture.clip.w <= capture.viewport.width
		&& capture.clip.y + capture.clip.h <= capture.viewport.height,
		`${capture.id}.clip lies outside its viewport`);
}
const documentedAfterState = JSON.parse((await nonEmptyFile(afterStatePath,
	'docs/release-1/img/after-state.json')).toString('utf8'));
const resizeCapture = captureById.get('canvas-resize');
assertObject(resizeCapture.expectedState, 'canvas-resize.expectedState');
assert.deepEqual(resizeCapture.expectedState.screen,
	[documentedAfterState.screen.vid_width, documentedAfterState.screen.vid_height],
	'focused resize proof screen dimensions must match its full-frame context state');
assert.deepEqual(resizeCapture.expectedState.physical, documentedAfterState.physical,
	'focused resize proof physical dimensions must match its full-frame context state');

const decoded = new Map();
const aspectRatioFailures = [];
for (const [assetIndex, asset] of manifest.assets.entries()) {
	const label = `manifest.assets[${assetIndex}]`;
	assertObject(asset, label);
	assert.equal(typeof asset.id, 'string', `${label}.id must be a string`);
	assert(Array.isArray(asset.callouts) && asset.callouts.length > 0 && asset.callouts.length <= 2,
		`${label} must declare one or two callouts`);
	const capture = captureById.get(asset.id);
	assert(capture, `${label} has no capture provenance`);
	assert.equal(capture.output, asset.source, `${label}.source is not the declared focused capture`);
	assert.equal(capture.context, FULL_FRAME_BY_ID[asset.id], `${label} has the wrong full-frame context`);
	const sourceFile = releasePath(asset.source, `${label}.source`);
	const outputFile = releasePath(asset.output, `${label}.output`);
	assert.notEqual(sourceFile, outputFile, `${label} must not overwrite its source`);
	const source = decodePng(await nonEmptyFile(sourceFile, asset.source), asset.source);
	assert.deepEqual([source.width, source.height],
		[capture.clip.w * capture.deviceScaleFactor, capture.clip.h * capture.deviceScaleFactor],
		`${asset.source} dimensions do not match captures.json clip × deviceScaleFactor`);
	const aspectRatio = source.width / source.height;
	if (aspectRatio > 3) aspectRatioFailures.push(`${asset.source} is ${aspectRatio.toFixed(2)}:1`);
	const output = decodePng(await nonEmptyFile(outputFile, asset.output), asset.output);
	assert.deepEqual([output.width, output.height], [source.width, source.height],
		`${asset.output} dimensions differ from ${asset.source}`);
	const fullFrameRel = FULL_FRAME_BY_ID[asset.id];
	const fullFrame = decodePng(await nonEmptyFile(releasePath(fullFrameRel, `${label} full frame`), fullFrameRel), fullFrameRel);
	// Compare the focused clip's CSS area, not its DSF-2 backing pixels, with the
	// context screenshot. This keeps the proof materially focused without
	// punishing the extra pixel density that makes its real control legible.
	const focusedCssArea = (source.width / capture.deviceScaleFactor)
		* (source.height / capture.deviceScaleFactor);
	assert(focusedCssArea <= fullFrame.width * fullFrame.height * 0.35,
		`${asset.source} is not materially smaller than ${fullFrameRel}`);
	decoded.set(asset.id, { source, output, fullFrame });
}
assert.deepEqual(aspectRatioFailures, [],
	`focused proofs must be at most 3:1; violations: ${aspectRatioFailures.join(', ')}`);
console.log(`Case 1: PASS — ${manifest.assets.length} focused capture(s) are at most 3:1, materially smaller than context, and preserve output dimensions`);

for (const [assetIndex, asset] of manifest.assets.entries()) {
	const { source, output } = decoded.get(asset.id);
	const accent = parseAccent(asset.accent, `manifest.assets[${assetIndex}].accent`);
	for (const [calloutIndex, callout] of asset.callouts.entries()) {
		const label = `manifest.assets[${assetIndex}].callouts[${calloutIndex}]`;
		assertObject(callout, label);
		assertObject(callout.target, `${label}.target`);
		const region = {
			x: callout.target.x - CALLOUT_TEST_MARGIN,
			y: callout.target.y - CALLOUT_TEST_MARGIN,
			w: callout.target.w + 2 * CALLOUT_TEST_MARGIN,
			h: callout.target.h + 2 * CALLOUT_TEST_MARGIN,
		};
		const outputCount = countAccent(output, accent, region);
		const sourceCount = countAccent(source, accent, region);
		// A 3px ring should contribute far more than a few lucky pixels. Derive
		// the floor from the declared target perimeter so larger callouts must
		// carry proportionally more visible marker, without snapshot magic nums.
		const minimumAccent = Math.max(24, Math.floor(2 * (callout.target.w + callout.target.h) * 0.6));
		assert(outputCount >= minimumAccent,
			`${label} has only ${outputCount} near-accent pixels; expected at least ${minimumAccent}`);
		assert(sourceCount <= Math.max(2, Math.floor(minimumAccent * 0.02)),
			`${label} source already has ${sourceCount} near-accent pixels in the callout region`);
	}
}
console.log('Case 2: PASS — accent pixels are drawn at each callout and absent from its source region');

for (const [assetIndex, asset] of manifest.assets.entries()) {
	const { source } = decoded.get(asset.id);
	for (const [calloutIndex, callout] of asset.callouts.entries()) {
		const label = `manifest.assets[${assetIndex}].callouts[${calloutIndex}]`;
		assert(!Object.hasOwn(callout, 'inset'), `${label} must not declare an inset`);
		assert(!Object.hasOwn(callout, 'label'), `${label} must not carry prose label text`);
		assert(!Object.hasOwn(callout, 'chip'), `${label} must not declare a prose chip`);
		assert.deepEqual(Object.keys(callout).sort(), ['badge', 'target'],
			`${label} may contain only badge and target`);
		assert(Number.isInteger(callout.badge) && callout.badge > 0, `${label}.badge must be a positive integer`);
		inside(callout.target, source.width, source.height, `${label}.target`);
	}
}
console.log('Case 3: PASS — targets are in bounds and callouts contain no inset, prose label or chip');

// Announcement/payload validation now lives with the release-note gate
// (tools/ci/release_note_gate.mjs), which owns docs/<slug>/NOTES.md.
console.log('tier1_release_annotations: ok (focused, ring-only evidence with manifest provenance).');
