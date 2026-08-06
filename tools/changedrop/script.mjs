#!/usr/bin/env node

import { chmod, lstat, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const INPUT_SCHEMA_VERSION = 'changedrop-value-summary/1';
const AUTHORING_SCHEMA_VERSION = 'changedrop-script-authoring/1';
const OUTPUT_SCHEMA_VERSION = 'changedrop-script/1';
const ROOT_VARIABLE = 'EZHUD_CHANGEDROP_ROOT';
const INTRO = "Hey guys, it's Xeri with another changedrop.";
const OUTRO = "Be safe, and don't walk on spawns.";
const MAX_SURFACE_SECONDS = 10.0;
const MAX_HOLD_MS = 5_000;
const ACTIONS = new Set(['wait-for', 'resize', 'click', 'hold', 'highlight']);
const SELECTOR_PATTERN = /^(?:#[A-Za-z][A-Za-z0-9_-]{0,63}|\[data-changedrop="[a-z0-9]+(?:-[a-z0-9]+)*"\])$/;

// 2.2 words/s is 132 wpm: a deliberately conservative planning rate near the
// low end of clear conversational narration. It leaves room for natural pauses;
// Stage V2 remains authoritative because it checks the measured audio duration.
export const WORDS_PER_SECOND = 2.2;

function exactObject(value, expectedKeys, at) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`${at} must be an object.`);
	}
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

function validateValueSummary(summary) {
	exactObject(summary, ['schema_version', 'decision', 'skip_reason', 'features'], 'Changedrop value summary');
	if (summary.schema_version !== INPUT_SCHEMA_VERSION) {
		throw new Error(`Changedrop value summary must use ${INPUT_SCHEMA_VERSION}.`);
	}
	if (!['render', 'skip'].includes(summary.decision)) {
		throw new Error('Changedrop value summary decision must be render or skip.');
	}
	if (!Array.isArray(summary.features)) throw new Error('Changedrop value summary features must be an array.');

	const surfaces = new Set();
	for (const [index, feature] of summary.features.entries()) {
		exactObject(feature, ['surface', 'before', 'after', 'value'], `Changedrop value summary feature ${index + 1}`);
		if (typeof feature.surface !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(feature.surface)) {
			throw new Error(`Changedrop value summary feature ${index + 1} has an invalid surface.`);
		}
		for (const field of ['before', 'after', 'value']) {
			nonEmptyString(feature[field], `Changedrop value summary feature "${feature.surface}" ${field}`);
		}
		if (surfaces.has(feature.surface)) {
			throw new Error(`Changedrop value summary has duplicate surface "${feature.surface}".`);
		}
		surfaces.add(feature.surface);
	}

	if (summary.decision === 'render') {
		if (summary.skip_reason !== null) throw new Error('A render summary must have a null skip_reason.');
		if (summary.features.length === 0) throw new Error('A render summary must contain at least one feature.');
	} else {
		nonEmptyString(summary.skip_reason, 'A skip summary skip_reason');
		if (summary.features.length !== 0) throw new Error('A skip summary must contain zero features.');
	}
	return summary;
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
		if (!ACTIONS.has(step.action)) throw new Error(`${label} has unknown action "${String(step.action)}".`);
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
			exactObject(step, ['instruction', 'action', 'duration_ms'], label);
			if (!Number.isInteger(step.duration_ms) || step.duration_ms < 100 || step.duration_ms > MAX_HOLD_MS) {
				throw new Error(`${label} hold duration must be between 100 and 5000 ms.`);
			}
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

function copyWalkthrough(walkthrough) {
	return walkthrough.map((step) => ({
		...step,
		...(step.crop ? { crop: { ...step.crop } } : {}),
	}));
}

function validateAuthoring(authoring) {
	exactObject(authoring, ['schema_version', 'setup', 'bookends', 'treatments'], 'Changedrop script authoring');
	if (authoring.schema_version !== AUTHORING_SCHEMA_VERSION) {
		throw new Error(`Changedrop script authoring must use ${AUTHORING_SCHEMA_VERSION}.`);
	}
	validateWalkthrough(authoring.setup, 'Changedrop capture setup', { setup: true });
	exactObject(authoring.bookends, ['intro_walkthrough', 'outro_walkthrough'], 'Changedrop script authoring bookends');
	validateWalkthrough(authoring.bookends.intro_walkthrough, 'Changedrop intro walkthrough');
	validateWalkthrough(authoring.bookends.outro_walkthrough, 'Changedrop outro walkthrough');
	if (!Array.isArray(authoring.treatments)) throw new Error('Changedrop script authoring treatments must be an array.');

	const surfaces = new Set();
	for (const [index, treatment] of authoring.treatments.entries()) {
		exactObject(treatment, ['surface', 'source', 'text', 'walkthrough'], `Changedrop authored treatment ${index + 1}`);
		if (typeof treatment.surface !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(treatment.surface)) {
			throw new Error(`Changedrop authored treatment ${index + 1} has an invalid surface.`);
		}
		if (surfaces.has(treatment.surface)) {
			throw new Error(`Changedrop script authoring has duplicate surface "${treatment.surface}".`);
		}
		surfaces.add(treatment.surface);
		exactObject(treatment.source, ['before', 'after', 'value'], `Authored source for surface "${treatment.surface}"`);
		for (const field of ['before', 'after', 'value']) {
			nonEmptyString(treatment.source[field], `Authored source for surface "${treatment.surface}" ${field}`);
		}
		nonEmptyString(treatment.text, `Authored narration for surface "${treatment.surface}"`);
		validateWalkthrough(treatment.walkthrough, `Authored walkthrough for surface "${treatment.surface}"`);
	}
	return authoring;
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

function safeAuthoringPath(value) {
	const candidate = typeof value === 'string' && value.trim()
		? value.trim().replaceAll('\\', '/')
		: 'the per-release changedrop-script.json file';
	if (candidate.startsWith('/') || /^[a-z]:\//i.test(candidate) || candidate.startsWith('//')
		|| candidate.split('/').includes('..')) {
		throw new Error('The changedrop authoring path must be repository-relative.');
	}
	return candidate;
}

function assertTreatmentMatches(feature, treatment, authoringPath) {
	for (const field of ['before', 'after', 'value']) {
		if (feature[field] !== treatment.source[field]) {
			throw new Error(`Authored treatment for surface "${feature.surface}" in ${authoringPath} `
				+ `no longer matches its ${field} value.`);
		}
	}
}

function wordCount(text) {
	return text.trim().split(/\s+/u).filter(Boolean).length;
}

function occurrences(text, needle) {
	return text.split(needle).length - 1;
}

function segment({ id, kind, surface, text, walkthrough }) {
	return {
		id,
		kind,
		surface,
		text,
		estimated_duration_seconds: Number((wordCount(text) / WORDS_PER_SECOND).toFixed(3)),
		walkthrough: copyWalkthrough(walkthrough),
	};
}

function assertScriptContract(script) {
	const texts = script.segments.map((entry) => entry.text);
	if (texts.some((text) => !text.trim())) throw new Error('Changedrop script contains an empty segment.');
	if (new Set(texts).size !== texts.length) throw new Error('Changedrop script contains duplicated segment text.');
	const spoken = texts.join(' ');
	if (script.segments[0]?.kind !== 'bookend' || script.segments[0]?.text !== INTRO
		|| occurrences(spoken, INTRO) !== 1) {
		throw new Error('Changedrop script intro must be a standalone segment exactly once and first.');
	}
	if (script.segments.at(-1)?.kind !== 'bookend' || script.segments.at(-1)?.text !== OUTRO
		|| occurrences(spoken, OUTRO) !== 1) {
		throw new Error('Changedrop script outro must be a standalone segment exactly once and last.');
	}
	for (const entry of script.segments.filter((candidate) => candidate.kind === 'surface')) {
		if (entry.estimated_duration_seconds > MAX_SURFACE_SECONDS) {
			throw new Error(`Changedrop script surface "${entry.surface}" exceeds the 10.0 second budget.`);
		}
	}
	return script;
}

/**
 * Pure stage-2 author. Human-authored treatments arrive as per-release data;
 * this function only binds them to source facts and enforces the contract.
 */
export function authorChangedropScript(summary, authoring, { authoringPath: requestedPath } = {}) {
	validateValueSummary(summary);
	privacyChecked(summary, 'Changedrop value summary');
	if (summary.decision === 'skip') return null;

	const authoringPath = safeAuthoringPath(requestedPath);
	validateAuthoring(authoring);
	privacyChecked(authoring, 'Changedrop script authoring');
	const treatments = new Map(authoring.treatments.map((treatment) => [treatment.surface, treatment]));
	const summarySurfaces = new Set(summary.features.map((feature) => feature.surface));
	for (const treatment of authoring.treatments) {
		if (!summarySurfaces.has(treatment.surface)) {
			throw new Error(`Authored surface "${treatment.surface}" in ${authoringPath} is absent from the value summary.`);
		}
	}

	const surfaceSegments = summary.features.map((feature) => {
		const treatment = treatments.get(feature.surface);
		if (!treatment) {
			throw new Error(`No authored changedrop treatment exists for surface "${feature.surface}" in ${authoringPath}; `
				+ 'add the missing entry to that file.');
		}
		assertTreatmentMatches(feature, treatment, authoringPath);
		const authoredSegment = segment({
			id: feature.surface,
			kind: 'surface',
			surface: feature.surface,
			text: treatment.text,
			walkthrough: treatment.walkthrough,
		});
		if (authoredSegment.estimated_duration_seconds > MAX_SURFACE_SECONDS) {
			throw new Error(`Changedrop script surface "${feature.surface}" exceeds the 10.0 second budget.`);
		}
		return authoredSegment;
	});

	const segments = [
		segment({
			id: 'intro',
			kind: 'bookend',
			surface: null,
			text: INTRO,
			walkthrough: authoring.bookends.intro_walkthrough,
		}),
		...surfaceSegments,
		segment({
			id: 'outro',
			kind: 'bookend',
			surface: null,
			text: OUTRO,
			walkthrough: authoring.bookends.outro_walkthrough,
		}),
	];
	return privacyChecked(assertScriptContract({
		schema_version: OUTPUT_SCHEMA_VERSION,
		setup: copyWalkthrough(authoring.setup),
		segments,
	}), 'Changedrop script');
}

function parseArguments(argv) {
	const values = new Map();
	for (let index = 0; index < argv.length; index += 1) {
		const name = argv[index];
		if (!['--summary', '--authoring', '--out'].includes(name)) {
			throw new Error(`Unknown changedrop script argument: ${name}`);
		}
		const value = argv[index + 1];
		if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
		if (values.has(name)) throw new Error(`${name} may be supplied only once.`);
		values.set(name, value);
		index += 1;
	}
	for (const name of ['--summary', '--out']) {
		if (!values.has(name)) throw new Error(`${name} is required.`);
	}
	return {
		summary: values.get('--summary'),
		authoring: values.get('--authoring') ?? null,
		out: values.get('--out'),
	};
}

function pathInsideRoot(root, requested) {
	const resolved = path.resolve(root, requested);
	return resolved.startsWith(`${root}${path.sep}`) ? resolved : null;
}

function repositoryAuthoring(cwd, requested) {
	const display = safeAuthoringPath(requested);
	const resolved = path.resolve(cwd, display);
	if (!resolved.startsWith(`${path.resolve(cwd)}${path.sep}`)) {
		throw new Error('--authoring must resolve inside the repository.');
	}
	return { display, resolved };
}

async function ensurePrivateParents(root, directory) {
	const relative = path.relative(root, directory);
	let cursor = root;
	for (const segment of relative.split(path.sep).filter(Boolean)) {
		cursor = path.join(cursor, segment);
		try {
			await mkdir(cursor, { mode: 0o700 });
		} catch (error) {
			if (error?.code !== 'EEXIST') throw error;
		}
		const metadata = await lstat(cursor);
		if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
			throw new Error('output parent is not a private directory');
		}
		await chmod(cursor, 0o700);
	}
}

async function refuseSymlink(file) {
	try {
		const metadata = await lstat(file);
		if (metadata.isSymbolicLink()) throw new Error('output file may not be a symbolic link');
	} catch (error) {
		if (error?.code !== 'ENOENT') throw error;
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
	const input = pathInsideRoot(root, args.summary);
	const output = pathInsideRoot(root, args.out);
	if (!input) throw new Error('--summary must resolve inside EZHUD_CHANGEDROP_ROOT.');
	if (!output) throw new Error('--out must resolve inside EZHUD_CHANGEDROP_ROOT.');
	if (input === output) throw new Error('--summary and --out must name different files.');

	let summary;
	try {
		summary = JSON.parse(await readFile(input, 'utf8'));
	} catch {
		throw new Error('Could not read a changedrop value summary inside EZHUD_CHANGEDROP_ROOT.');
	}
	validateValueSummary(summary);
	if (summary.decision === 'skip') {
		authorChangedropScript(summary);
		try {
			await rm(output, { force: true });
		} catch {
			throw new Error('Could not suppress skipped changedrop script output.');
		}
		stdout('changedrop script: skipped');
		return null;
	}
	if (!args.authoring) throw new Error('--authoring is required for a render summary.');
	const authoringFile = repositoryAuthoring(cwd, args.authoring);
	let authoring;
	try {
		authoring = JSON.parse(await readFile(authoringFile.resolved, 'utf8'));
	} catch {
		throw new Error(`Could not read changedrop script authoring from ${authoringFile.display}.`);
	}
	const script = authorChangedropScript(summary, authoring, { authoringPath: authoringFile.display });

	try {
		await ensurePrivateParents(root, path.dirname(output));
		await refuseSymlink(output);
		await writeFile(output, `${JSON.stringify(script, null, 2)}\n`, { mode: 0o600 });
		await chmod(output, 0o600);
	} catch {
		throw new Error('Could not write changedrop script inside EZHUD_CHANGEDROP_ROOT.');
	}
	stdout(JSON.stringify(script));
	return script;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
	main().catch((error) => {
		console.error(`changedrop script: ${String(error.message ?? error)}`);
		process.exitCode = 1;
	});
}
