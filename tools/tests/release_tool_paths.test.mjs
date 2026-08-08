#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { resolveReleaseDir } from '../release/paths.mjs';

const repo = path.resolve('/tmp/ezhud-release-tool-test');

test('release tools default to the Release 1 exemplar', () => {
	assert.equal(resolveReleaseDir(repo, []), path.join(repo, 'docs/release-1'));
});

test('release tools accept an explicit repository-relative release directory', () => {
	assert.equal(
		resolveReleaseDir(repo, ['--release-dir', 'docs/release-2']),
		path.join(repo, 'docs/release-2'),
	);
	assert.equal(
		resolveReleaseDir(repo, ['--release-dir=docs/release-2']),
		path.join(repo, 'docs/release-2'),
	);
});

test('release tools reject missing, unknown, absolute, and escaping arguments', () => {
	assert.throws(() => resolveReleaseDir(repo, ['--release-dir']), /requires a value/);
	assert.throws(() => resolveReleaseDir(repo, ['--unknown']), /unknown argument/);
	assert.throws(() => resolveReleaseDir(repo, ['--release-dir', '/tmp/release-2']), /repository-relative/);
	assert.throws(() => resolveReleaseDir(repo, ['--release-dir', '../release-2']), /inside docs/);
	assert.throws(() => resolveReleaseDir(repo, ['--release-dir', 'docs']), /direct child of docs/);
	assert.throws(() => resolveReleaseDir(repo, ['--release-dir', 'docs/release-2/nested']), /direct child of docs/);
});
