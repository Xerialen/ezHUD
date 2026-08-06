#!/usr/bin/env node

import { chmod, lstat, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const INPUT_SCHEMA_VERSION = 'changedrop-value-summary/1';
const OUTPUT_SCHEMA_VERSION = 'changedrop-script/1';
const ROOT_VARIABLE = 'EZHUD_CHANGEDROP_ROOT';
const INTRO = "Hey guys, it's Xeri with another changedrop.";
const OUTRO = "Be safe, and don't walk on spawns.";
const MAX_SURFACE_SECONDS = 10.0;

// 2.2 words/s is 132 wpm: a deliberately conservative planning rate near the
// low end of clear conversational narration. It leaves room for natural pauses;
// Stage V2 remains authoritative because it checks the measured audio duration.
export const WORDS_PER_SECOND = 2.2;

const AUTHORED_SURFACES = Object.freeze({
	'window-follow': Object.freeze({
		text: 'Resizing now keeps your game and HUD aligned.',
		requires: Object.freeze({
			before: Object.freeze([/resiz/i]),
			after: Object.freeze([/view/i, /browser|window/i]),
			value: Object.freeze([/HUD/i, /align/i]),
		}),
		walkthrough: Object.freeze([
			'Show the game view before changing the browser size.',
			'Resize the browser while keeping the game view and HUD handles visible.',
			'Hold on the resized view with a HUD handle aligned to its element.',
		]),
	}),
	'pause-resume': Object.freeze({
		text: 'Pause keeps engine frames steady for HUD edits.',
		requires: Object.freeze({
			before: Object.freeze([/frame/i]),
			after: Object.freeze([/pause/i, /engine/i]),
			value: Object.freeze([/frame/i, /HUD|adjust|edit/i]),
		}),
		walkthrough: Object.freeze([
			'Load a demo with Pause visible beside the demo selector.',
			'Pause on a quiet frame and hold while the demo clock stays still.',
			'Resume and hold while the demo clock advances again.',
		]),
	}),
});

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

function assertTreatmentMatches(feature, treatment) {
	for (const [field, patterns] of Object.entries(treatment.requires)) {
		if (!patterns.every((pattern) => pattern.test(feature[field]))) {
			throw new Error(`Authored script for surface "${feature.surface}" no longer matches its ${field} value.`);
		}
	}
}

function wordCount(text) {
	return text.trim().split(/\s+/u).filter(Boolean).length;
}

function occurrences(text, needle) {
	return text.split(needle).length - 1;
}

function assertScriptContract(script) {
	const texts = script.segments.map((segment) => segment.text);
	if (texts.some((text) => !text.trim())) throw new Error('Changedrop script contains an empty segment.');
	if (new Set(texts).size !== texts.length) throw new Error('Changedrop script contains duplicated segment text.');
	const spoken = texts.join(' ');
	if (!spoken.startsWith(INTRO) || occurrences(spoken, INTRO) !== 1) {
		throw new Error('Changedrop script intro must appear exactly once and first.');
	}
	if (!spoken.endsWith(OUTRO) || occurrences(spoken, OUTRO) !== 1) {
		throw new Error('Changedrop script outro must appear exactly once and last.');
	}
	for (const segment of script.segments) {
		if (segment.estimated_duration_seconds > MAX_SURFACE_SECONDS) {
			throw new Error(`Changedrop script surface "${segment.surface}" exceeds the 10.0 second budget.`);
		}
	}
	return script;
}

/**
 * Pure stage-2 author. Curated treatments are intentionally tied to source
 * facts; unknown or drifted prose fails rather than inventing narration.
 */
export function authorChangedropScript(summary) {
	validateValueSummary(summary);
	privacyChecked(summary, 'Changedrop value summary');
	if (summary.decision === 'skip') return null;

	const segments = summary.features.map((feature, index) => {
		const treatment = AUTHORED_SURFACES[feature.surface];
		if (!treatment) {
			throw new Error(`No authored changedrop treatment exists for surface "${feature.surface}".`);
		}
		assertTreatmentMatches(feature, treatment);
		const parts = [];
		if (index === 0) parts.push(INTRO);
		parts.push(treatment.text);
		if (index === summary.features.length - 1) parts.push(OUTRO);
		const text = parts.join(' ');
		const duration = wordCount(text) / WORDS_PER_SECOND;
		if (duration > MAX_SURFACE_SECONDS) {
			throw new Error(`Changedrop script surface "${feature.surface}" exceeds the 10.0 second budget.`);
		}
		return {
			id: feature.surface,
			surface: feature.surface,
			text,
			estimated_duration_seconds: Number(duration.toFixed(3)),
			walkthrough: [...treatment.walkthrough],
		};
	});

	return privacyChecked(assertScriptContract({
		schema_version: OUTPUT_SCHEMA_VERSION,
		segments,
	}), 'Changedrop script');
}

function parseArguments(argv) {
	const values = new Map();
	for (let index = 0; index < argv.length; index += 1) {
		const name = argv[index];
		if (!['--summary', '--out'].includes(name)) {
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
	return { summary: values.get('--summary'), out: values.get('--out') };
}

function pathInsideRoot(root, requested) {
	const resolved = path.resolve(root, requested);
	return resolved.startsWith(`${root}${path.sep}`) ? resolved : null;
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
	const script = authorChangedropScript(summary);
	if (script === null) {
		try {
			await rm(output, { force: true });
		} catch {
			throw new Error('Could not suppress skipped changedrop script output.');
		}
		stdout('changedrop script: skipped');
		return null;
	}

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
