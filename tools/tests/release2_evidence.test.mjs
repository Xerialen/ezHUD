#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const releaseDir = path.join(repo, 'docs/release-2');
const expectedIds = ['anchor', 'demo-moments', 'drag-assist', 'editor-size'];
const RING_PADDING = 6;

async function readJson(file) {
	return JSON.parse(await readFile(file, 'utf8'));
}

async function sha256(file) {
	const bytes = await readFile(file);
	return {
		bytes: bytes.length,
		sha256: createHash('sha256').update(bytes).digest('hex'),
	};
}

async function pngDimensions(file) {
	const bytes = await readFile(file);
	const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
	assert(bytes.subarray(0, 8).equals(signature), `${file} is not a PNG`);
	assert.equal(bytes.toString('ascii', 12, 16), 'IHDR', `${file} has no leading IHDR`);
	return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function releasePath(relative, label) {
	assert.equal(typeof relative, 'string', `${label} must be a string`);
	const resolved = path.resolve(releaseDir, relative);
	assert(resolved.startsWith(`${releaseDir}${path.sep}`), `${label} escapes docs/release-2`);
	return resolved;
}

function repoPath(relative, label) {
	assert.equal(typeof relative, 'string', `${label} must be a string`);
	const resolved = path.resolve(repo, relative);
	assert(resolved.startsWith(`${repo}${path.sep}`), `${label} escapes the repository`);
	return resolved;
}

function assertRect(rect, width, height, label) {
	assert(rect && typeof rect === 'object' && !Array.isArray(rect), `${label} must be an object`);
	for (const key of ['x', 'y', 'w', 'h']) {
		assert.equal(typeof rect[key], 'number', `${label}.${key} must be numeric`);
		assert(Number.isFinite(rect[key]), `${label}.${key} must be finite`);
	}
	assert(rect.w > 0 && rect.h > 0, `${label} must be non-degenerate`);
	assert(rect.x >= 0 && rect.y >= 0 && rect.x + rect.w <= width && rect.y + rect.h <= height,
		`${label} lies outside ${width}x${height}`);
}

test('Release 2 evidence is focused, ring-only, and bound to capture selectors', async () => {
	const captures = await readJson(path.join(releaseDir, 'captures.json'));
	const annotations = await readJson(path.join(releaseDir, 'annotations.json'));
	assert.equal(captures.version, 1);
	assert.equal(annotations.version, 1);
	assert.deepEqual(captures.captures.map(({ id }) => id).sort(), expectedIds);
	assert.deepEqual(annotations.assets.map(({ id }) => id).sort(), expectedIds);
	const captureById = new Map(captures.captures.map((capture) => [capture.id, capture]));

	for (const asset of annotations.assets) {
		const capture = captureById.get(asset.id);
		assert(capture, `${asset.id} has no capture declaration`);
		assert.equal(capture.deviceScaleFactor, 2, `${asset.id} must use DSF 2`);
		assert.equal(capture.output, asset.source, `${asset.id} annotation source is not its declared capture`);
		assert.notEqual(asset.source, asset.output, `${asset.id} would overwrite its source`);
		assert.equal(asset.callouts.length, 1, `${asset.id} must ring exactly one changed control`);
		assert.deepEqual(Object.keys(asset.callouts[0]).sort(), ['badge', 'target'],
			`${asset.id} callout must contain only badge and target`);
		assert.deepEqual(asset.callouts[0].target, capture.expectedTarget,
			`${asset.id} ring does not match its live focus-selector receipt`);

		const source = releasePath(asset.source, `${asset.id}.source`);
		const output = releasePath(asset.output, `${asset.id}.output`);
		assert((await stat(source)).isFile(), `${asset.source} is missing`);
		assert((await stat(output)).isFile(), `${asset.output} is missing`);
		const sourceSize = await pngDimensions(source);
		const outputSize = await pngDimensions(output);
		assert.deepEqual(sourceSize, {
			width: capture.clip.w * capture.deviceScaleFactor,
			height: capture.clip.h * capture.deviceScaleFactor,
		}, `${asset.id} source dimensions do not match clip × DSF`);
		assert.deepEqual(outputSize, sourceSize, `${asset.id} output dimensions differ from its source`);
		assert(sourceSize.width / sourceSize.height <= 3, `${asset.id} exceeds the 3:1 focused-proof limit`);
		assertRect(asset.callouts[0].target, sourceSize.width, sourceSize.height, `${asset.id}.target`);
		assertRect({
			x: asset.callouts[0].target.x - RING_PADDING,
			y: asset.callouts[0].target.y - RING_PADDING,
			w: asset.callouts[0].target.w + 2 * RING_PADDING,
			h: asset.callouts[0].target.h + 2 * RING_PADDING,
		}, sourceSize.width, sourceSize.height, `${asset.id}.ring`);
	}
});

test('Release 2 provenance binds manifests, sources, outputs, and generator bytes', async () => {
	const receipt = await readJson(path.join(releaseDir, 'PROVENANCE.json'));
	assert.equal(receipt.version, 1);
	assert.equal(receipt.release, 'release-2');
	for (const [label, value] of [
		['source.commit', receipt.source?.commit],
		['baseline.commit', receipt.baseline?.commit],
		['engine.commit', receipt.engine?.commit],
	]) assert.match(value, /^[0-9a-f]{40}$/, `${label} is not a full commit digest`);
	assert.match(receipt.engine?.sha256, /^[0-9a-f]{64}$/, 'engine.sha256 is not a full SHA-256 digest');

	const setup = await readFile(path.join(repo, 'tools/qa/setup-fte-env.sh'), 'utf8');
	const pin = setup.match(/^FTEQW_SHA=([0-9a-f]{40})$/m)?.[1];
	assert.equal(receipt.engine.commit, pin, 'provenance engine commit differs from FTEQW_SHA');
	assert(Array.isArray(receipt.artifacts) && receipt.artifacts.length === 10,
		'provenance must bind two manifests, four sources, and four outputs');
	for (const artifact of receipt.artifacts) {
		const actual = await sha256(releasePath(artifact.path, `artifact ${artifact.path}`));
		assert.deepEqual(actual, { bytes: artifact.bytes, sha256: artifact.sha256 },
			`provenance drift for ${artifact.path}`);
	}
	assert(Array.isArray(receipt.tooling?.files) && receipt.tooling.files.length === 3,
		'provenance must bind capture, annotation, and release-path tools');
	for (const tool of receipt.tooling.files) {
		const actual = await sha256(repoPath(tool.path, `tool ${tool.path}`));
		assert.deepEqual(actual, { bytes: tool.bytes, sha256: tool.sha256 },
			`tooling provenance drift for ${tool.path}`);
	}
});
