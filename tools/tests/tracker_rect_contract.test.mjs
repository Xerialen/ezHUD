import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('case 6: trackerClip consumes the reported rect without a manual mirror', () => {
	const source = readFileSync(path.join(repo, 'tools/tests/tier4_fte.mjs'), 'utf8');
	const match = source.match(/async function trackerClip\([\s\S]*?\n}\n\n\/\/ A screenshot/);
	assert(match, 'trackerClip function was not found');
	const trackerClip = match[0];
	assert.doesNotMatch(trackerClip, /vid_width\s*-\s*state\.element\.rect\.x\s*-\s*state\.element\.rect\.w/,
		'trackerClip still mirrors /state rect.x by hand');
	assert.doesNotMatch(trackerClip, /reports its right-aligned rect X|mirrored screen coordinate|same mapping/,
		'trackerClip still explains the deleted export mismatch');
});
