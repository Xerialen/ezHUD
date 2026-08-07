#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import {
	chmod,
	lstat,
	mkdir,
	readFile,
	rename,
	writeFile,
} from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { main as analyzeMain } from './analyze.mjs';
import { main as captureMain } from './capture.mjs';
import { main as muxMain } from './mux.mjs';
import { main as scriptMain } from './script.mjs';
import { main as voiceMain } from './voice.mjs';

const ROOT_VARIABLE = 'EZHUD_CHANGEDROP_ROOT';
const MANIFEST_SCHEMA_VERSION = 'changedrop-manifest/1';
const MAX_RETRYABLE_ATTEMPTS = 3;

export const RETRYABLE_ERROR_CODES = Object.freeze(['E_LOCK_TIMEOUT', 'E_INTERNAL']);
const RETRYABLE_ERROR_SET = new Set(RETRYABLE_ERROR_CODES);

const DEFAULT_STAGES = Object.freeze({
	analyze: analyzeMain,
	script: scriptMain,
	capture: captureMain,
	voice: voiceMain,
	mux: muxMain,
});

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

function positiveNumber(value, at, { zero = false } = {}) {
	if (typeof value !== 'number' || !Number.isFinite(value) || (zero ? value < 0 : value <= 0)) {
		throw new Error(`${at} must be ${zero ? 'non-negative' : 'positive'} and finite.`);
	}
}

function hashPattern(value, at) {
	if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`${at} must be a SHA-256 digest.`);
}

function stringsIn(value) {
	if (typeof value === 'string') return [value];
	if (Array.isArray(value)) return value.flatMap(stringsIn);
	if (value && typeof value === 'object') return Object.values(value).flatMap(stringsIn);
	return [];
}

function privacyChecked(value, subject, env = process.env) {
	const host = hostname();
	const user = env.USER || env.USERNAME || '';
	const privateLocation = /\/home\/|\/Users\/|\$USER\b|file:\/\//i;
	const absolutePath = /(^|[\s"'(=])\/(?!\/)[^\s"')]+/;
	const windowsAbsolutePath = /(^|[\s"'(=])(?:[a-z]:[\\/]|\\\\)[^\s"')]+/i;
	const unsafe = stringsIn(value).some((entry) => privateLocation.test(entry)
		|| absolutePath.test(entry) || windowsAbsolutePath.test(entry)
		|| (host && entry.includes(host)) || (user && entry.includes(user)));
	if (unsafe) throw new Error(`${subject} contains private location, host, or user data.`);
	return value;
}

export function assertExternalRoot(repositoryRoot, outputRoot) {
	const repository = path.resolve(repositoryRoot);
	const output = path.resolve(outputRoot);
	const relative = path.relative(repository, output);
	if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
		throw new Error('EZHUD_CHANGEDROP_ROOT must be outside the repository.');
	}
	return true;
}

export function generateRunId({ now = new Date(), entropy = randomBytes(4) } = {}) {
	if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error('Run timestamp is invalid.');
	const random = Buffer.isBuffer(entropy) ? entropy : Buffer.from(entropy ?? []);
	if (random.length !== 4) throw new Error('Run id entropy must contain four bytes.');
	const timestamp = now.toISOString().replace(/[-:.]/g, '');
	return `${timestamp}-${random.toString('hex')}`;
}

function safeRelease(value) {
	if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(value)) {
		throw new Error('--release must be a safe release id.');
	}
	return value;
}

function safeRunId(value) {
	if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
		throw new Error('--run-id must be an opaque safe id.');
	}
	return value;
}

function parseArguments(argv) {
	const values = new Map();
	for (let index = 0; index < argv.length; index += 1) {
		const name = argv[index];
		if (!['--release', '--run-id', '--dist'].includes(name)) throw new Error(`Unknown changedrop run argument: ${name}`);
		const value = argv[index + 1];
		if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
		if (values.has(name)) throw new Error(`${name} may be supplied only once.`);
		values.set(name, value);
		index += 1;
	}
	if (!values.has('--release')) throw new Error('--release is required.');
	return {
		release: safeRelease(values.get('--release')),
		runId: values.has('--run-id') ? safeRunId(values.get('--run-id')) : generateRunId(),
		dist: values.get('--dist') ?? 'dist',
	};
}

export function buildRunLayout(release, runId) {
	safeRelease(release);
	safeRunId(runId);
	const prefix = path.posix.join(release, runId);
	return Object.freeze({
		prefix,
		valueSummary: `${prefix}/value-summary.json`,
		script: `${prefix}/script.json`,
		capture: `${prefix}/capture`,
		captureTimings: `${prefix}/capture/timings.json`,
		narration: `${prefix}/narration`,
		fittedScript: `${prefix}/narration/script.json`,
		fittedCapture: `${prefix}/capture-fitted`,
		fittedTimings: `${prefix}/capture-fitted/timings.json`,
		mux: `${prefix}/mux`,
		manifest: `${prefix}/manifest.json`,
	});
}

async function ensurePrivateDirectory(directory, { create = false } = {}) {
	if (create) {
		try {
			await mkdir(directory, { mode: 0o700 });
		} catch (error) {
			if (error?.code !== 'EEXIST') throw error;
		}
	}
	const metadata = await lstat(directory);
	if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
		throw new Error('Changedrop output directories must be owner-only and may not be symbolic links.');
	}
	await chmod(directory, 0o700);
}

async function createRunRoot(root, release, runId) {
	const releaseRoot = path.join(root, release);
	await ensurePrivateDirectory(releaseRoot, { create: true });
	const runRoot = path.join(releaseRoot, runId);
	try {
		await mkdir(runRoot, { mode: 0o700 });
	} catch (error) {
		if (error?.code === 'EEXIST') throw new Error(`Changedrop run id "${runId}" already exists.`);
		throw error;
	}
	await chmod(runRoot, 0o700);
	return runRoot;
}

async function writeManifest(runRoot, manifest) {
	const target = path.join(runRoot, 'manifest.json');
	const staging = path.join(runRoot, `.manifest-${process.pid}.tmp`);
	await writeFile(staging, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
	await chmod(staging, 0o600);
	await rename(staging, target);
	await chmod(target, 0o600);
}

function validateTerminalFields(manifest, { release, runId, sourceNoteHash, env }) {
	exactObject(manifest, [
		'schema_version', 'release', 'run_id', 'source_note', 'decision', 'blocked_reason',
		'segments', 'capture', 'output', 'publish',
	], 'Changedrop manifest');
	if (manifest.schema_version !== MANIFEST_SCHEMA_VERSION || manifest.release !== release || manifest.run_id !== runId) {
		throw new Error('Changedrop manifest identity differs from its run.');
	}
	exactObject(manifest.source_note, ['path', 'sha256'], 'Changedrop manifest source note');
	if (manifest.source_note.path !== `docs/${release}/NOTES.md` || manifest.source_note.sha256 !== sourceNoteHash) {
		throw new Error('Changedrop manifest source note provenance differs from its run.');
	}
	exactObject(manifest.publish, ['state', 'destination'], 'Changedrop manifest publication state');
	if (manifest.publish.state !== 'withheld' || manifest.publish.destination !== null) {
		throw new Error('Changedrop manifest publication must remain withheld with no destination.');
	}
	return privacyChecked(manifest, 'Changedrop manifest', env);
}

export function validateRunManifest(manifest, context = {}) {
	validateTerminalFields(manifest, context);
	if (!['render', 'skip', 'blocked'].includes(manifest.decision)) throw new Error('Changedrop manifest decision is invalid.');
	if (!Array.isArray(manifest.segments)) throw new Error('Changedrop manifest segments must be an array.');
	if (manifest.decision !== 'render') {
		nonEmptyString(manifest.blocked_reason, 'Changedrop terminal reason');
		if (manifest.segments.length !== 0 || manifest.capture !== null || manifest.output !== null) {
			throw new Error(`Changedrop ${manifest.decision} manifest may not claim rendered artifacts.`);
		}
		return manifest;
	}
	if (manifest.blocked_reason !== null || manifest.segments.length === 0) {
		throw new Error('Changedrop render manifest must contain segments and no blocked reason.');
	}
	for (const [index, segment] of manifest.segments.entries()) {
		exactObject(segment, [
			'id', 'surface', 'script_sha256', 'measured_start_s', 'measured_duration_s', 'narration',
		], `Changedrop manifest segment ${index + 1}`);
		nonEmptyString(segment.id, `Changedrop manifest segment ${index + 1} id`);
		hashPattern(segment.script_sha256, `Changedrop manifest segment "${segment.id}" script hash`);
		positiveNumber(segment.measured_start_s, `Changedrop manifest segment "${segment.id}" start`, { zero: true });
		positiveNumber(segment.measured_duration_s, `Changedrop manifest segment "${segment.id}" duration`);
		exactObject(segment.narration, [
			'basename', 'sha256', 'duration_s', 'voice_profile', 'profile_revision', 'request_status', 'engine',
		], `Changedrop manifest narration for "${segment.id}"`);
		if (segment.narration.basename !== `${segment.id}.wav` || segment.narration.voice_profile !== 'xeri-en-v1') {
			throw new Error(`Changedrop manifest narration identity is invalid for "${segment.id}".`);
		}
		hashPattern(segment.narration.sha256, `Changedrop manifest narration hash for "${segment.id}"`);
		positiveNumber(segment.narration.duration_s, `Changedrop manifest narration duration for "${segment.id}"`);
		if (!Number.isInteger(segment.narration.profile_revision) || segment.narration.profile_revision < 1) {
			throw new Error(`Changedrop manifest API profile revision is invalid for "${segment.id}".`);
		}
		if (!['rendered', 'duplicate'].includes(segment.narration.request_status)) {
			throw new Error(`Changedrop manifest request status is invalid for "${segment.id}".`);
		}
		exactObject(segment.narration.engine, ['name', 't3_model', 'cli_sha256'],
			`Changedrop manifest engine for "${segment.id}"`);
		nonEmptyString(segment.narration.engine.name, `Changedrop manifest engine name for "${segment.id}"`);
		nonEmptyString(segment.narration.engine.t3_model, `Changedrop manifest engine model for "${segment.id}"`);
		hashPattern(segment.narration.engine.cli_sha256, `Changedrop manifest engine hash for "${segment.id}"`);
	}
	for (const [name, artifact, basename] of [
		['capture', manifest.capture, 'walkthrough.webm'],
		['output', manifest.output, 'changedrop.mp4'],
	]) {
		exactObject(artifact, ['basename', 'sha256', 'duration_s'], `Changedrop manifest ${name}`);
		if (artifact.basename !== basename) throw new Error(`Changedrop manifest ${name} basename is invalid.`);
		hashPattern(artifact.sha256, `Changedrop manifest ${name} hash`);
		positiveNumber(artifact.duration_s, `Changedrop manifest ${name} duration`);
	}
	return manifest;
}

function validateCompletedHandoffs(manifest, timings, narration) {
	if (!timings || !Array.isArray(timings.segments) || !narration || !Array.isArray(narration.segments)
		|| timings.segments.length !== manifest.segments.length
		|| narration.segments.length !== manifest.segments.length) {
		throw new Error('Completed changedrop handoffs do not cover every manifest segment.');
	}
	for (const [index, segment] of manifest.segments.entries()) {
		const timing = timings.segments[index];
		const voice = narration.segments[index];
		if (timing?.id !== segment.id || voice?.id !== segment.id
			|| timing.start_seconds !== segment.measured_start_s
			|| timing.duration_seconds !== segment.measured_duration_s
			|| voice.audio?.sha256 !== segment.narration.sha256
			|| voice.duration_seconds !== segment.narration.duration_s
			|| voice.profile_revision !== segment.narration.profile_revision) {
			throw new Error(`Completed changedrop provenance differs at segment "${segment.id}".`);
		}
	}
	return true;
}

function terminalManifest({ release, runId, sourceNoteHash, decision, reason, env }) {
	return validateRunManifest({
		schema_version: MANIFEST_SCHEMA_VERSION,
		release,
		run_id: runId,
		source_note: { path: `docs/${release}/NOTES.md`, sha256: sourceNoteHash },
		decision,
		blocked_reason: reason,
		segments: [],
		capture: null,
		output: null,
		publish: { state: 'withheld', destination: null },
	}, { release, runId, sourceNoteHash, env });
}

export async function runRetryableVoiceStage(operation) {
	if (typeof operation !== 'function') throw new Error('Retryable voice stage must be a function.');
	for (let attempt = 1; attempt <= MAX_RETRYABLE_ATTEMPTS; attempt += 1) {
		try {
			return await operation(attempt);
		} catch (error) {
			if (!RETRYABLE_ERROR_SET.has(error?.errorCode) || attempt === MAX_RETRYABLE_ATTEMPTS) {
				if (error && typeof error === 'object' && Object.isExtensible(error)) error.pipelineAttempts = attempt;
				throw error;
			}
		}
	}
	throw new Error('Retryable voice stage bound is unreachable.');
}

function validateStages(stages) {
	exactObject(stages, ['analyze', 'script', 'capture', 'voice', 'mux'], 'Changedrop stages');
	for (const [name, stage] of Object.entries(stages)) {
		if (typeof stage !== 'function') throw new Error(`Changedrop ${name} stage must be a function.`);
	}
	return stages;
}

function blockedReason(stage, error) {
	const code = typeof error?.errorCode === 'string' ? ` ${error.errorCode}` : '';
	const attempts = Number.isInteger(error?.pipelineAttempts) && error.pipelineAttempts > 1
		? ` after ${error.pipelineAttempts} attempts`
		: '';
	const prerequisite = typeof error?.prerequisite === 'string' && error.prerequisite.trim()
		? ` Prerequisite: ${error.prerequisite.trim()}`
		: '';
	return `${stage} stopped with${code || ' an error'}${attempts}.${prerequisite}`;
}

export async function main({
	env = process.env,
	argv = process.argv.slice(2),
	cwd = process.cwd(),
	stages = DEFAULT_STAGES,
	stdout = console.log,
} = {}) {
	if (!env[ROOT_VARIABLE]?.trim()) throw new Error(`${ROOT_VARIABLE} is required.`);
	const repositoryRoot = path.resolve(cwd);
	const root = path.resolve(env[ROOT_VARIABLE]);
	assertExternalRoot(repositoryRoot, root);
	await ensurePrivateDirectory(root);
	validateStages(stages);
	const args = parseArguments(argv);
	privacyChecked({ release: args.release, run_id: args.runId }, 'Changedrop run identity', env);
	const layout = buildRunLayout(args.release, args.runId);
	const noteFile = path.join(repositoryRoot, 'docs', args.release, 'NOTES.md');
	let noteBytes;
	try {
		noteBytes = await readFile(noteFile);
	} catch {
		throw new Error(`Canonical note for release "${args.release}" is missing or unreadable.`);
	}
	const sourceNoteHash = createHash('sha256').update(noteBytes).digest('hex');
	const runRoot = await createRunRoot(root, args.release, args.runId);
	const common = { env, cwd: repositoryRoot, stdout: () => {} };
	let currentStage = 'analyze';
	try {
		const summary = await stages.analyze({
			...common,
			argv: ['--release', args.release, '--out', layout.valueSummary],
		});
		if (!summary || !['render', 'skip'].includes(summary.decision)) {
			throw new Error('Changedrop analyzer returned an invalid decision.');
		}
		if (summary.decision === 'skip') {
			nonEmptyString(summary.skip_reason, 'Changedrop skip reason');
			const manifest = terminalManifest({
				release: args.release,
				runId: args.runId,
				sourceNoteHash,
				decision: 'skip',
				reason: summary.skip_reason,
				env,
			});
			await writeManifest(runRoot, manifest);
			stdout(JSON.stringify(manifest));
			return manifest;
		}

		currentStage = 'script';
		await stages.script({
			...common,
			argv: [
				'--summary', layout.valueSummary,
				'--authoring', `docs/${args.release}/changedrop-script.json`,
				'--out', layout.script,
			],
		});
		currentStage = 'capture-initial';
		await stages.capture({
			...common,
			argv: ['--script', layout.script, '--dist', args.dist, '--out', layout.capture],
		});
		currentStage = 'voice-measure';
		const measureOptions = Object.freeze({
			...common,
			argv: Object.freeze([
				'--phase', 'measure',
				'--script', layout.script,
				'--timings', layout.captureTimings,
				'--out', layout.narration,
			]),
			maxAttempts: 1,
		});
		await runRetryableVoiceStage(() => stages.voice(measureOptions));
		currentStage = 'capture-fitted';
		const fittedTimings = await stages.capture({
			...common,
			argv: ['--script', layout.fittedScript, '--dist', args.dist, '--out', layout.fittedCapture],
		});
		currentStage = 'voice-validate';
		const validatedNarration = await stages.voice({
			...common,
			argv: [
				'--phase', 'validate',
				'--script', layout.fittedScript,
				'--timings', layout.fittedTimings,
				'--out', layout.narration,
			],
			maxAttempts: 1,
		});
		currentStage = 'mux';
		const manifest = await stages.mux({
			...common,
			argv: [
				'--capture', layout.fittedCapture,
				'--narration', layout.narration,
				'--out', layout.mux,
			],
		});
		validateRunManifest(manifest, {
			release: args.release,
			runId: args.runId,
			sourceNoteHash,
			env,
		});
		validateCompletedHandoffs(manifest, fittedTimings, validatedNarration);
		await writeManifest(runRoot, manifest);
		stdout(JSON.stringify(manifest));
		return manifest;
	} catch (error) {
		const reason = blockedReason(currentStage, error);
		const manifest = terminalManifest({
			release: args.release,
			runId: args.runId,
			sourceNoteHash,
			decision: 'blocked',
			reason,
			env,
		});
		await writeManifest(runRoot, manifest);
		throw error;
	}
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
	main().catch((error) => {
		console.error(`changedrop run: ${String(error.message ?? error)}`);
		process.exitCode = 1;
	});
}
