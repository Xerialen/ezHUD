#!/usr/bin/env node

import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import {
	parseInternalOnlyExemption,
	parseReleaseNoteFeatures,
} from '../ci/release_note_gate.mjs';

const SCHEMA_VERSION = 'changedrop-value-summary/1';
const ROOT_VARIABLE = 'EZHUD_CHANGEDROP_ROOT';

function surfaceFromEvidence(evidence) {
	return String(evidence)
		.replace(/^.*\//, '')
		.replace(/\.png$/i, '')
		.replace(/-focused(?:-annotated)?$/i, '')
		.replace(/-annotated$/i, '');
}

function requireStructuredValues(features) {
	for (const feature of features) {
		for (const [field, label] of [['before', 'Before'], ['after', 'After'], ['value', 'Value']]) {
			if (!feature[field]) {
				throw new Error(`Canonical NOTES.md feature "${feature.title}" is missing the ${label}: field. `
					+ 'The analyzer cannot state before/after/value without inventing text.');
			}
		}
	}
}

function summaryStrings(value) {
	if (typeof value === 'string') return [value];
	if (Array.isArray(value)) return value.flatMap(summaryStrings);
	if (value && typeof value === 'object') return Object.values(value).flatMap(summaryStrings);
	return [];
}

function privacyChecked(summary) {
	const host = hostname();
	const privateLocation = /\/home\/|\/Users\/|\$USER\b|file:\/\//i;
	const absolutePath = /(^|[\s"'(=])\/(?!\/)[^\s"')]+/;
	const windowsAbsolutePath = /(^|[\s"'(=])(?:[a-z]:[\\/]|\\\\)[^\s"')]+/i;
	const unsafe = summaryStrings(summary).some((value) => privateLocation.test(value)
		|| absolutePath.test(value) || windowsAbsolutePath.test(value)
		|| (host && value.includes(host)));
	if (unsafe) throw new Error('Changedrop value summary contains private location data.');
	return summary;
}

export function analyzeRelease({ note, tickets = [], labels = [] } = {}) {
	const labelNames = labels
		.map((label) => typeof label === 'string' ? label : label?.name)
		.filter(Boolean);
	if (labelNames.includes('internal-only')) {
		const records = tickets.map((ticket) => typeof ticket === 'string' ? ticket : ticket?.body ?? '');
		const exemptions = records.map((record) => parseInternalOnlyExemption(record));
		const exemption = exemptions.find((candidate) => candidate.ok);
		if (!exemption) {
			throw new Error(exemptions[0]?.error ?? parseInternalOnlyExemption('').error);
		}
		return privacyChecked({
			schema_version: SCHEMA_VERSION,
			decision: 'skip',
			skip_reason: exemption.reason,
			features: [],
		});
	}

	const parsed = parseReleaseNoteFeatures(note, { notePath: 'Canonical NOTES.md' });
	requireStructuredValues(parsed.features);
	if (!parsed.ok) throw new Error(parsed.reason);
	const features = parsed.features.map((feature) => ({
		surface: surfaceFromEvidence(feature.evidence),
		before: feature.before,
		after: feature.after,
		value: feature.value,
	}));
	const mappedSurfaces = new Set(features.map((feature) => feature.surface));
	const changedSurfaces = tickets
		.filter((ticket) => ticket && typeof ticket === 'object' && ticket.user_visible !== false)
		.map((ticket) => ticket.surface)
		.filter((surface) => typeof surface === 'string' && surface.trim())
		.map((surface) => surface.trim());
	for (const surface of changedSurfaces) {
		if (!mappedSurfaces.has(surface)) {
			throw new Error(`Changed user-visible surface "${surface}" has no feature block in the canonical note evidence mapping.`);
		}
	}
	return privacyChecked({
		schema_version: SCHEMA_VERSION,
		decision: 'render',
		skip_reason: null,
		features,
	});
}

function parseArguments(argv) {
	const values = new Map();
	for (let index = 0; index < argv.length; index += 1) {
		const name = argv[index];
		if (!['--release', '--out'].includes(name)) {
			throw new Error(`Unknown changedrop analyzer argument: ${name}`);
		}
		const value = argv[index + 1];
		if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
		if (values.has(name)) throw new Error(`${name} may be supplied only once.`);
		values.set(name, value);
		index += 1;
	}
	for (const name of ['--release', '--out']) {
		if (!values.has(name)) throw new Error(`${name} is required.`);
	}
	return { release: values.get('--release'), out: values.get('--out') };
}

function outputInsideRoot(root, requested) {
	const output = path.resolve(root, requested);
	return output.startsWith(`${root}${path.sep}`) ? output : null;
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
		const metadata = await stat(cursor);
		if (!metadata.isDirectory()) throw new Error('output parent is not a directory');
		await chmod(cursor, 0o700);
	}
}

export async function main({
	env = process.env,
	argv = process.argv.slice(2),
	cwd = process.cwd(),
	stdout = console.log,
} = {}) {
	if (!env[ROOT_VARIABLE]?.trim()) {
		throw new Error(`${ROOT_VARIABLE} is required.`);
	}
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

	const { release, out } = parseArguments(argv);
	if (!/^[a-z0-9][a-z0-9._-]*$/.test(release)) {
		throw new Error('--release must be a safe release id.');
	}
	const output = outputInsideRoot(root, out);
	if (!output) throw new Error('--out must resolve inside EZHUD_CHANGEDROP_ROOT.');

	let note;
	try {
		note = await readFile(path.join(cwd, 'docs', release, 'NOTES.md'), 'utf8');
	} catch {
		throw new Error(`Canonical note for release "${release}" is missing or unreadable.`);
	}
	const summary = analyzeRelease({ note, tickets: [], labels: [] });
	const serialized = `${JSON.stringify(summary, null, 2)}\n`;
	try {
		await ensurePrivateParents(root, path.dirname(output));
		await writeFile(output, serialized, { mode: 0o600 });
		await chmod(output, 0o600);
	} catch {
		throw new Error('Could not write changedrop value summary inside EZHUD_CHANGEDROP_ROOT.');
	}
	stdout(JSON.stringify(summary));
	return summary;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
	main().catch((error) => {
		console.error(`changedrop analyze: ${String(error.message ?? error)}`);
		process.exitCode = 1;
	});
}
