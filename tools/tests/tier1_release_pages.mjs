#!/usr/bin/env node
// Deterministic integrity guard for the two static Release 1 Pages documents.
// It deliberately checks assembled bytes, not source paths: BASE_PATH rewriting
// and the public allowlist only become real in dist/.
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const distArg = process.argv[2];
assert(distArg, 'usage: node tools/tests/tier1_release_pages.mjs <dist-dir>');
const dist = path.resolve(distArg);

const pages = [
	'release-1/index.html',
	'release-1/release-notes.html',
];
const assets = [
	'release-1/img/after-bar.png',
	'release-1/img/after-paused.png',
	'release-1/img/after-resized-window.png',
	'release-1/img/after-state.json',
	'release-1/img/before-resized-window.png',
	'release-1/img/before-state.json',
];

async function nonEmpty(rel) {
	const info = await stat(path.join(dist, rel)).catch(() => null);
	assert(info?.isFile(), `${rel} is missing from the assembled dist`);
	assert(info.size > 0, `${rel} is empty in the assembled dist`);
}

function attributes(html) {
	const found = [];
	const pattern = /\b(src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
	for (const match of html.matchAll(pattern)) {
		found.push({ name: match[1].toLowerCase(), value: match[2] ?? match[3] ?? match[4] });
	}
	return found;
}

function isRelative(ref) {
	return !ref.startsWith('/')
		&& !ref.startsWith('//')
		&& !/^[a-z][a-z0-9+.-]*:/i.test(ref);
}

async function resolveLocal(pageRel, ref) {
	const rawPath = ref.split(/[?#]/, 1)[0];
	let decoded;
	try {
		decoded = decodeURIComponent(rawPath);
	} catch {
		assert.fail(`${pageRel}: malformed relative URL ${JSON.stringify(ref)}`);
	}
	assert(!decoded.includes('\\'), `${pageRel}: relative URL uses a backslash: ${JSON.stringify(ref)}`);
	let target = decoded
		? path.resolve(path.dirname(path.join(dist, pageRel)), decoded)
		: path.join(dist, pageRel);
	const withinDist = target === dist || target.startsWith(`${dist}${path.sep}`);
	assert(withinDist, `${pageRel}: relative URL escapes dist: ${JSON.stringify(ref)}`);
	let info = await stat(target).catch(() => null);
	if (info?.isDirectory()) {
		target = path.join(target, 'index.html');
		info = await stat(target).catch(() => null);
	}
	assert(info?.isFile(), `${pageRel}: ${JSON.stringify(ref)} does not resolve to a dist file`);
}

for (const rel of [...pages, ...assets]) await nonEmpty(rel);

for (const rel of pages) {
	const html = await readFile(path.join(dist, rel), 'utf8');
	if (rel.endsWith('release-notes.html')) {
		assert(!/<script\b/i.test(html), `${rel} must not contain runtime JavaScript`);
		assert(!/<link\b[^>]*\brel\s*=\s*["']?stylesheet\b/i.test(html),
			`${rel} must keep its CSS self-contained`);
	}
	for (const { value } of attributes(html)) {
		if (isRelative(value)) await resolveLocal(rel, value);
	}
}

console.log(`tier1_release_pages: ok (${pages.length} pages, ${assets.length} named assets, relative links resolve).`);
