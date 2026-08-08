#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
	chmod,
	lstat,
	readFile,
	rename,
	rm,
	writeFile,
} from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { validateCaptureScript } from './capture.mjs';
import { assertExternalRoot, validateRunManifest } from './run.mjs';
import { validateTimingReceipt } from './voice.mjs';
import { parseReleaseNoteFeatures } from '../ci/release_note_gate.mjs';

const ROOT_VARIABLE = 'EZHUD_CHANGEDROP_ROOT';
const SCHEMA_VERSION = 'changedrop-review-payload/1';
const CHANNEL_ID = '1534452186266734683';
const OUTPUT_BASENAME = 'review-payload.json';
const VIDEO_BASENAME = 'changedrop.mp4';
const URL_RE = /https?:\/\/[^\s<>]+/gi;
const MENTION_RE = /@everyone\b|@here\b|<@(?:!|&)?\d+>/i;
const ISSUE_RE = /#\d+\b/;
const INTERNAL_JARGON_RE = /\b(?:manifest|pipeline|mux|artifact|provenance|sha-?256|ffmpeg|playwright|voice-order|request[_ -]?id|profile[_ -]?revision|run[_ -]?id)\b/i;

export const MAX_CONTENT_CHARACTERS = 1900;
export const REVIEW_CHANNEL_ID = CHANNEL_ID;

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

function positiveNumber(value, at) {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
		throw new Error(`${at} must be positive and finite.`);
	}
}

function hashPattern(value, at) {
	if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`${at} must be a SHA-256 digest.`);
}

function safeKebab(value, at) {
	if (typeof value !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
		throw new Error(`${at} must be lower-kebab-case.`);
	}
}

function stringsIn(value) {
	if (typeof value === 'string') return [value];
	if (Array.isArray(value)) return value.flatMap(stringsIn);
	if (value && typeof value === 'object') return Object.values(value).flatMap(stringsIn);
	return [];
}

function forbiddenPayloadKey(value) {
	if (!value || typeof value !== 'object') return null;
	for (const [key, entry] of Object.entries(value)) {
		if (key === 'path' || key === 'audio.path') return key;
		const nested = forbiddenPayloadKey(entry);
		if (nested) return nested;
	}
	return null;
}

function privacyChecked(value, subject, env = process.env) {
	const forbiddenKey = forbiddenPayloadKey(value);
	if (forbiddenKey) throw new Error(`${subject} may not contain ${forbiddenKey}.`);
	const host = hostname();
	const user = env.USER || env.USERNAME || '';
	const privateLocation = /\/home\/|\/Users\/|\$USER\b|\bUSER\b|file:\/\//;
	const absolutePath = /(^|[\s"'(=])\/(?!\/)[^\s"')]+/;
	const windowsAbsolutePath = /(^|[\s"'(=])(?:[a-z]:[\\/]|\\\\)[^\s"')]+/i;
	const unsafe = stringsIn(value).some((entry) => privateLocation.test(entry)
		|| absolutePath.test(entry) || windowsAbsolutePath.test(entry)
		|| (host && entry.includes(host)) || (user && entry.includes(user)));
	if (unsafe) throw new Error(`${subject} contains private path, host, or user data.`);
	return value;
}

function hashBytes(value) {
	return createHash('sha256').update(value).digest('hex');
}

function wrapBareUrls(source) {
	return source.replace(URL_RE, (url, offset, whole) => {
		const wrapped = whole[offset - 1] === '<' && whole[offset + url.length] === '>';
		return wrapped ? url : `<${url}>`;
	});
}

function validateMessageContent(content) {
	nonEmptyString(content, 'Changedrop review message content');
	if (content.length > MAX_CONTENT_CHARACTERS) {
		throw new Error(`Changedrop review message exceeds ${MAX_CONTENT_CHARACTERS} characters.`);
	}
	if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(content)) {
		throw new Error('Changedrop review message contains unsafe control characters.');
	}
	if (MENTION_RE.test(content)) throw new Error('Changedrop review message may not contain mention syntax.');
	for (const match of content.matchAll(URL_RE)) {
		const wrapped = content[match.index - 1] === '<'
			&& content[match.index + match[0].length] === '>';
		if (!wrapped) throw new Error('Changedrop review message URLs must be wrapped in angle brackets.');
	}
	if (ISSUE_RE.test(content)) throw new Error('Changedrop review message must not contain issue numbers.');
	if (INTERNAL_JARGON_RE.test(content)) {
		throw new Error('Changedrop review message must remain player-facing and contain no internal jargon.');
	}
	return content;
}

export function buildReviewMessage({ title, features } = {}) {
	nonEmptyString(title, 'Changedrop release title');
	if (!Array.isArray(features) || features.length === 0) {
		throw new Error('Changedrop review message requires player-facing features.');
	}
	const sections = features.map((feature, index) => {
		if (!feature || typeof feature !== 'object' || Array.isArray(feature)) {
			throw new Error(`Changedrop review feature ${index + 1} must be an object.`);
		}
		nonEmptyString(feature.title, `Changedrop review feature ${index + 1} title`);
		nonEmptyString(feature.after, `Changedrop review feature "${feature.title}" After`);
		nonEmptyString(feature.value, `Changedrop review feature "${feature.title}" Value`);
		return `**${feature.title.trim()}**\nNow: ${feature.after.trim()}\nWhy it matters: ${feature.value.trim()}`;
	});
	return validateMessageContent(wrapBareUrls(`**${title.trim()}**\n\n${sections.join('\n\n')}`));
}

function validateAttachment(attachment, index) {
	if (attachment?.kind === 'video') {
		exactObject(attachment, ['name', 'kind', 'sha256', 'bytes', 'duration_seconds'],
			`Changedrop review attachment ${index + 1}`);
		if (attachment.name !== VIDEO_BASENAME) throw new Error('Changedrop review video name must be changedrop.mp4.');
		positiveNumber(attachment.duration_seconds, 'Changedrop review video duration');
	} else if (attachment?.kind === 'image') {
		exactObject(attachment, ['name', 'kind', 'surface', 'sha256', 'bytes'],
			`Changedrop review attachment ${index + 1}`);
		if (!/^[a-z0-9]+(?:-[a-z0-9]+)*-[1-9][0-9]*\.png$/.test(attachment.name)) {
			throw new Error('Changedrop review image name is invalid.');
		}
		safeKebab(attachment.surface, 'Changedrop review image surface');
	} else {
		throw new Error(`Changedrop review attachment ${index + 1} has an invalid kind.`);
	}
	hashPattern(attachment.sha256, `Changedrop review attachment ${index + 1} hash`);
	if (!Number.isInteger(attachment.bytes) || attachment.bytes <= 0) {
		throw new Error(`Changedrop review attachment ${index + 1} byte length must be positive.`);
	}
}

export function validateReviewPayload(payload, env = process.env) {
	exactObject(payload, ['schema_version', 'release', 'destination', 'message', 'attachments', 'provenance'],
		'Changedrop prepared payload');
	if (payload.schema_version !== SCHEMA_VERSION) throw new Error(`Changedrop prepared payload must use ${SCHEMA_VERSION}.`);
	if (!/^[a-z0-9][a-z0-9._-]*$/.test(payload.release)) throw new Error('Changedrop prepared payload release is invalid.');
	exactObject(payload.destination, ['kind', 'channel_id', 'purpose', 'state', 'posted'],
		'Changedrop review destination');
	if (payload.destination.kind !== 'discord-channel' || payload.destination.channel_id !== CHANNEL_ID
		|| payload.destination.purpose !== 'owner-review' || payload.destination.state !== 'prepared'
		|| payload.destination.posted !== false) {
		throw new Error('Changedrop review destination must remain the prepared owner-review channel.');
	}
	exactObject(payload.message, ['content', 'allowed_mentions', 'suppress_embeds'], 'Changedrop review message');
	validateMessageContent(payload.message.content);
	exactObject(payload.message.allowed_mentions, ['parse'], 'Changedrop review allowed mentions');
	if (!Array.isArray(payload.message.allowed_mentions.parse) || payload.message.allowed_mentions.parse.length !== 0) {
		throw new Error('Changedrop review allowed_mentions.parse must be an empty array.');
	}
	if (payload.message.suppress_embeds !== true) throw new Error('Changedrop review message must suppress embeds.');
	if (!Array.isArray(payload.attachments) || payload.attachments.length < 2) {
		throw new Error('Changedrop prepared payload requires a video and at least one image attachment.');
	}
	const names = new Set();
	let videos = 0;
	let images = 0;
	for (const [index, attachment] of payload.attachments.entries()) {
		validateAttachment(attachment, index);
		if (names.has(attachment.name)) throw new Error(`Changedrop review attachment name "${attachment.name}" is duplicated.`);
		names.add(attachment.name);
		if (attachment.kind === 'video') videos += 1;
		else images += 1;
	}
	if (videos !== 1 || images === 0) throw new Error('Changedrop prepared payload requires exactly one video and at least one image.');
	exactObject(payload.provenance, ['manifest_sha256', 'capture_sha256', 'narration'],
		'Changedrop review provenance');
	hashPattern(payload.provenance.manifest_sha256, 'Changedrop review manifest hash');
	hashPattern(payload.provenance.capture_sha256, 'Changedrop review capture hash');
	if (!Array.isArray(payload.provenance.narration) || payload.provenance.narration.length === 0) {
		throw new Error('Changedrop review provenance requires narration entries.');
	}
	const narrationIds = new Set();
	for (const [index, narration] of payload.provenance.narration.entries()) {
		exactObject(narration, ['id', 'sha256', 'duration_seconds'],
			`Changedrop review narration provenance ${index + 1}`);
		safeKebab(narration.id, `Changedrop review narration provenance ${index + 1} id`);
		if (narrationIds.has(narration.id)) throw new Error(`Changedrop review narration id "${narration.id}" is duplicated.`);
		narrationIds.add(narration.id);
		hashPattern(narration.sha256, `Changedrop review narration provenance for "${narration.id}"`);
		positiveNumber(narration.duration_seconds, `Changedrop review narration duration for "${narration.id}"`);
	}
	return privacyChecked(payload, 'Changedrop prepared payload', env);
}

function surfaceFromEvidence(evidence) {
	return String(evidence)
		.replace(/^.*\//, '')
		.replace(/\.png$/i, '')
		.replace(/-focused(?:-annotated)?$/i, '')
		.replace(/-annotated$/i, '');
}

function assertSurfaceCoverage(features, manifest) {
	const noteSurfaces = features.map((feature) => surfaceFromEvidence(feature.evidence));
	const manifestSurfaces = manifest.segments.filter((segment) => segment.surface !== null)
		.map((segment) => segment.surface);
	if (new Set(noteSurfaces).size !== noteSurfaces.length || new Set(manifestSurfaces).size !== manifestSurfaces.length
		|| JSON.stringify(noteSurfaces) !== JSON.stringify(manifestSurfaces)) {
		throw new Error('Changedrop review note features do not match the rendered manifest surfaces.');
	}
	return manifestSurfaces;
}

export function buildReviewPayload({ manifest, manifestHash, title, features, video, images, env = process.env } = {}) {
	if (!manifest || manifest.decision !== 'render') throw new Error('Changedrop review requires a render manifest.');
	hashPattern(manifestHash, 'Changedrop review manifest hash');
	assertSurfaceCoverage(features, manifest);
	if (!video || !Array.isArray(images) || images.length === 0) {
		throw new Error('Changedrop review requires verified local video and image attachments.');
	}
	const payload = {
		schema_version: SCHEMA_VERSION,
		release: manifest.release,
		destination: {
			kind: 'discord-channel',
			channel_id: CHANNEL_ID,
			purpose: 'owner-review',
			state: 'prepared',
			posted: false,
		},
		message: {
			content: buildReviewMessage({ title, features }),
			allowed_mentions: { parse: [] },
			suppress_embeds: true,
		},
		attachments: [video, ...images],
		provenance: {
			manifest_sha256: manifestHash,
			capture_sha256: manifest.capture.sha256,
			narration: manifest.segments.map((segment) => ({
				id: segment.id,
				sha256: segment.narration.sha256,
				duration_seconds: segment.narration.duration_s,
			})),
		},
	};
	validateReviewPayload(payload, env);
	if (video.sha256 !== manifest.output.sha256 || video.duration_seconds !== manifest.output.duration_s) {
		throw new Error('Changedrop review video attachment differs from the muxed output manifest.');
	}
	return payload;
}

function parseArguments(argv) {
	const values = new Map();
	for (let index = 0; index < argv.length; index += 1) {
		const name = argv[index];
		if (!['--manifest', '--out'].includes(name)) throw new Error(`Unknown changedrop review argument: ${name}`);
		const value = argv[index + 1];
		if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
		if (values.has(name)) throw new Error(`${name} may be supplied only once.`);
		values.set(name, value);
		index += 1;
	}
	for (const name of ['--manifest', '--out']) {
		if (!values.has(name)) throw new Error(`${name} is required.`);
	}
	return { manifest: values.get('--manifest'), out: values.get('--out') };
}

function pathInsideRoot(root, requested) {
	const resolved = path.resolve(root, requested);
	return resolved.startsWith(`${root}${path.sep}`) ? resolved : null;
}

async function requirePrivateDirectory(directory, subject) {
	let metadata;
	try {
		metadata = await lstat(directory);
	} catch {
		throw new Error(`${subject} is missing.`);
	}
	if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
		throw new Error(`${subject} must be an owner-only directory and may not be a symbolic link.`);
	}
}

async function verifiedFile(file, subject, { privateFile = true, expectedBytes = null, expectedHash = null } = {}) {
	let metadata;
	try {
		metadata = await lstat(file);
	} catch {
		throw new Error(`${subject} is missing.`);
	}
	if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0
		|| (privateFile && (metadata.mode & 0o077) !== 0)) {
		throw new Error(`${subject} must be a non-empty ${privateFile ? 'owner-only ' : ''}regular file.`);
	}
	if (expectedBytes !== null && metadata.size !== expectedBytes) throw new Error(`${subject} byte length differs from its receipt.`);
	const bytes = await readFile(file);
	if (bytes.length !== metadata.size) throw new Error(`${subject} changed while it was being verified.`);
	const sha256 = hashBytes(bytes);
	if (expectedHash !== null && sha256 !== expectedHash) throw new Error(`${subject} SHA-256 differs from its manifest.`);
	return { value: bytes, bytes: metadata.size, sha256 };
}

async function readPrivateJson(file, subject) {
	const artifact = await verifiedFile(file, subject);
	try {
		return { artifact, value: JSON.parse(artifact.value.toString('utf8')) };
	} catch {
		throw new Error(`${subject} is malformed.`);
	}
}

function runIdentity(root, manifestFile) {
	const parts = path.relative(root, manifestFile).split(path.sep).filter(Boolean);
	if (parts.length !== 3 || parts[2] !== 'manifest.json'
		|| !/^[a-z0-9][a-z0-9._-]*$/.test(parts[0])
		|| !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(parts[1])) {
		throw new Error('Changedrop review manifest must use the private <release>/<run-id>/manifest.json layout.');
	}
	return { release: parts[0], runId: parts[1], runRoot: path.join(root, parts[0], parts[1]) };
}

function assertManifestTimings(manifest, timings) {
	if (timings.segments.length !== manifest.segments.length) {
		throw new Error('Changedrop fitted timings do not cover every manifest segment.');
	}
	for (const [index, segment] of manifest.segments.entries()) {
		const timing = timings.segments[index];
		if (timing.id !== segment.id || timing.surface !== segment.surface
			|| timing.start_seconds !== segment.measured_start_s
			|| timing.duration_seconds !== segment.measured_duration_s) {
			throw new Error(`Changedrop fitted timing provenance differs for segment "${segment.id}".`);
		}
	}
}

function pngSignature(bytes) {
	return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
}

export async function main({
	env = process.env,
	argv = process.argv.slice(2),
	cwd = process.cwd(),
	stdout = console.log,
} = {}) {
	if (!env[ROOT_VARIABLE]?.trim()) throw new Error(`${ROOT_VARIABLE} is required.`);
	const repositoryRoot = path.resolve(cwd);
	const root = path.resolve(env[ROOT_VARIABLE]);
	assertExternalRoot(repositoryRoot, root);
	await requirePrivateDirectory(root, ROOT_VARIABLE);
	const args = parseArguments(argv);
	const manifestFile = pathInsideRoot(root, args.manifest);
	const outputFile = pathInsideRoot(root, args.out);
	if (!manifestFile) throw new Error('--manifest must resolve inside EZHUD_CHANGEDROP_ROOT.');
	if (!outputFile) throw new Error('--out must resolve inside EZHUD_CHANGEDROP_ROOT.');
	const identity = runIdentity(root, manifestFile);
	if (outputFile !== path.join(identity.runRoot, OUTPUT_BASENAME)) {
		throw new Error('--out must be review-payload.json in the manifest run directory.');
	}
	await requirePrivateDirectory(path.join(root, identity.release), 'Changedrop release directory');
	await requirePrivateDirectory(identity.runRoot, 'Changedrop run directory');

	const { artifact: manifestArtifact, value: manifest } = await readPrivateJson(manifestFile, 'Changedrop manifest');
	validateRunManifest(manifest, {
		release: identity.release,
		runId: identity.runId,
		sourceNoteHash: manifest?.source_note?.sha256,
		env,
	});
	if (manifest.decision !== 'render') throw new Error('Changedrop review requires a render manifest with rendered output.');

	const noteFile = path.resolve(repositoryRoot, manifest.source_note.path);
	if (!noteFile.startsWith(`${repositoryRoot}${path.sep}`)) throw new Error('Changedrop source note path is invalid.');
	const noteArtifact = await verifiedFile(noteFile, 'Changedrop canonical note', { privateFile: false });
	if (noteArtifact.sha256 !== manifest.source_note.sha256) throw new Error('Changedrop canonical note SHA-256 differs from the manifest.');
	const note = noteArtifact.value.toString('utf8');
	const title = note.match(/^#[ \t]+(.+?)[ \t]*$/m)?.[1];
	nonEmptyString(title, 'Changedrop canonical note title');
	const parsed = parseReleaseNoteFeatures(note, { notePath: manifest.source_note.path });
	if (!parsed.ok) throw new Error(parsed.reason);
	assertSurfaceCoverage(parsed.features, manifest);

	const captureDirectory = path.join(identity.runRoot, 'capture-fitted');
	const narrationDirectory = path.join(identity.runRoot, 'narration');
	const muxDirectory = path.join(identity.runRoot, 'mux');
	for (const [directory, subject] of [
		[captureDirectory, 'Changedrop fitted capture directory'],
		[narrationDirectory, 'Changedrop narration directory'],
		[muxDirectory, 'Changedrop mux directory'],
	]) await requirePrivateDirectory(directory, subject);
	const [{ value: script }, { value: timings }] = await Promise.all([
		readPrivateJson(path.join(narrationDirectory, 'script.json'), 'Changedrop fitted script'),
		readPrivateJson(path.join(captureDirectory, 'timings.json'), 'Changedrop fitted timings'),
	]);
	validateCaptureScript(script);
	validateTimingReceipt(script, timings);
	assertManifestTimings(manifest, timings);

	const videoArtifact = await verifiedFile(path.join(muxDirectory, manifest.output.basename),
		'Changedrop video output', { expectedHash: manifest.output.sha256 });
	const video = {
		name: VIDEO_BASENAME,
		kind: 'video',
		sha256: videoArtifact.sha256,
		bytes: videoArtifact.bytes,
		duration_seconds: manifest.output.duration_s,
	};
	const images = [];
	for (const timing of timings.segments.filter((segment) => segment.surface !== null)) {
		if (timing.highlights.length === 0) {
			throw new Error(`Changedrop review surface "${timing.surface}" has no local image attachment.`);
		}
		for (const highlight of timing.highlights) {
			const imageFile = path.resolve(captureDirectory, highlight.basename);
			if (!imageFile.startsWith(`${captureDirectory}${path.sep}`)) throw new Error('Changedrop review image basename is unsafe.');
			await requirePrivateDirectory(path.dirname(imageFile), 'Changedrop review image directory');
			const artifact = await verifiedFile(imageFile, `Changedrop review image for "${timing.surface}"`, {
				expectedBytes: highlight.bytes,
			});
			if (!pngSignature(artifact.value)) throw new Error(`Changedrop review image for "${timing.surface}" is not a PNG.`);
			images.push({
				name: path.basename(imageFile),
				kind: 'image',
				surface: timing.surface,
				sha256: artifact.sha256,
				bytes: artifact.bytes,
			});
		}
	}
	const payload = buildReviewPayload({
		manifest,
		manifestHash: manifestArtifact.sha256,
		title,
		features: parsed.features,
		video,
		images,
		env,
	});
	const staging = path.join(identity.runRoot, `.review-payload-${process.pid}.tmp`);
	await rm(staging, { force: true });
	try {
		await writeFile(staging, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
		await chmod(staging, 0o600);
		await rename(staging, outputFile);
		await chmod(outputFile, 0o600);
	} catch (error) {
		await rm(staging, { force: true });
		throw error;
	}
	stdout(JSON.stringify(payload));
	return payload;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
	main().catch((error) => {
		console.error(`changedrop review: ${String(error.message ?? error)}`);
		process.exitCode = 1;
	});
}
