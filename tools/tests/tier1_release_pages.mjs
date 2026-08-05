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
	'release-1/img/pause-resume-focused-annotated.png',
	'release-1/img/window-follow-focused-annotated.png',
	'release-1/img/after-state.json',
	'release-1/img/before-resized-window.png',
	'release-1/img/before-state.json',
	'release-1/img/pause-resume-focused-annotated.png',
	'release-1/img/window-follow-focused-annotated.png',
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

// Case 4 (#55): both primary proofs use focused annotated crops, not marked-up
// full frames. Each crop remains its own full-size link for phone readers;
// behaviour belongs in adjacent prose while the image contains only a ring and
// optional numeric badge. Full frames may remain when captioned as context.
const report = await readFile(path.join(dist, 'release-1/index.html'), 'utf8');
const resizeSection = report.match(/<h2>#40\b[\s\S]*?(?=<h2>|<\/body>)/i)?.[0] ?? '';
const pauseSection = report.match(/<h2>#43\b[\s\S]*?(?=<h2>|<\/body>)/i)?.[0] ?? '';
assert(resizeSection, 'release report has no #40 resize section');
assert(pauseSection, 'release report has no #43 pause section');

function requireLinkedAnnotatedFigure(section, filename, uiPattern, label) {
	const escaped = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const figurePattern = new RegExp(`<figure>\\s*<a\\s+href="img/${escaped}"[^>]*>\\s*`
		+ `<img\\s+src="img/${escaped}"\\s+alt="([^"]+)"[^>]*>\\s*</a>\\s*`
		+ `<figcaption>([\\s\\S]*?)</figcaption>\\s*</figure>`, 'i');
	const figure = section.match(figurePattern);
	assert(figure, `${label} proof is not a captioned, full-size link to img/${filename}`);
	assert(uiPattern.test(figure[1]) && /annotat|callout|ring|marker|badge/i.test(figure[1]),
		`${label} alt text must describe both the UI and its annotation`);
	assert(!/inset|magnif/i.test(figure[1]), `${label} alt text still describes a rejected inset`);
	assert(/(?:marker|callout|badge)\s*(?:<[^>]+>)*\s*1\b/i.test(figure[2]),
		`${label} caption must explain numbered marker 1`);
	assert(/open full size/i.test(figure[2]), `${label} caption must offer an open-full-size hint`);
}

requireLinkedAnnotatedFigure(resizeSection, 'window-follow-focused-annotated.png', /canvas|window|960|pixel/i, 'resize');
requireLinkedAnnotatedFigure(pauseSection, 'pause-resume-focused-annotated.png', /pause|resume/i, 'pause');
assert(/<img\s+src="img\/before-resized-window\.png"/i.test(resizeSection),
	'the unannotated BEFORE resize contrast is missing');
assert(/<img\s+src="img\/after-resized-window\.png"/i.test(resizeSection)
	&& /full-frame context/i.test(resizeSection), 'resize full-frame context is missing or not identified');
assert(/<img\s+src="img\/after-paused\.png"/i.test(pauseSection)
	&& /full-frame context/i.test(pauseSection), 'pause full-frame context is missing or not identified');
assert(!/after-(?:paused|resized-window)-annotated\.png/i.test(report),
	'report still references a rejected full-frame annotation');
console.log('Case 4: PASS — report uses focused ring-only proofs and identifies full-frame context');

console.log(`tier1_release_pages: ok (${pages.length} pages, ${assets.length} named assets, relative links resolve).`);
