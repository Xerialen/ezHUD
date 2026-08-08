#!/usr/bin/env node
// Deterministic release-note decision. GitHub/environment I/O belongs in main();
// the exported decision receives only PR metadata and a checked-out repository.
import { readFileSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const APPLY_LABELS = new Set(['user-visible', 'release']);
const ISSUE_REFERENCE_RE = /(?:^|[^\w])#(\d+)\b/;
const NOTE_PATH_RE = /\bdocs\/[a-z0-9][a-z0-9._-]*\/NOTES\.md\b/i;

function labelNames(labels) {
	return (Array.isArray(labels) ? labels : [])
		.map((label) => typeof label === 'string' ? label : label?.name)
		.filter(Boolean);
}

function decision(ok, reason, notice = null) {
	return { ok, reason, notice };
}

// The release-note gate owns the one internal-only exemption grammar. Other
// stages consume this decision rather than introducing a lookalike checkbox.
export function parseInternalOnlyExemption(body = '') {
	const source = String(body);
	const exemption = source.match(
		/^##[ \t]+Internal-only exemption[ \t]*$\r?\n([\s\S]*?)(?=^##[ \t]+|$(?![\s\S]))/m,
	)?.[1] ?? '';
	const checked = /^\s*[-*+]\s*\[[xX]\]\s+\S.*$/m.test(exemption);
	const rawReason = exemption.match(/^Reason:\s*(.+)$/m)?.[1] ?? '';
	const reason = rawReason.replace(/<!--.*?-->/g, '').trim();
	if (!checked || !reason) {
		return {
			ok: false,
			reason: null,
			error: 'internal-only requires a checked exemption box and a non-empty Reason in the linked ticket record.',
		};
	}
	return { ok: true, reason, error: null };
}

function nonEmptyString(value) {
	return typeof value === 'string' && value.trim().length > 0;
}

// Canonical feature parsing is shared with changedrop stage 1. Keep the note
// grammar in one place: release-note validation and value analysis must never
// disagree about where feature prose or its Evidence mapping begins and ends.
export function parseReleaseNoteFeatures(source, { notePath = 'Canonical NOTES.md' } = {}) {
	const featuresMatch = String(source).match(
		/^##[ \t]+Features[ \t]*$\r?\n([\s\S]*?)(?=^##[ \t]+|$(?![\s\S]))/m,
	);
	if (!featuresMatch) {
		return { ok: false, reason: `${notePath} has no "## Features" section.`, features: [] };
	}
	const featureBody = featuresMatch[1];
	const headings = [...featureBody.matchAll(/^###\s+(.+?)\s*$/gm)];
	if (headings.length === 0) {
		return {
			ok: false,
			reason: `${notePath} "## Features" section has no feature blocks.`,
			features: [],
		};
	}
	const features = [];
	for (const [index, heading] of headings.entries()) {
		const start = heading.index + heading[0].length;
		const end = headings[index + 1]?.index ?? featureBody.length;
		const block = featureBody.slice(start, end);
		const evidence = [...block.matchAll(/^Evidence:\s+(\S+)\s*$/gm)];
		const fields = Object.fromEntries(['Before', 'After', 'Value'].map((label) => {
			const matches = [...block.matchAll(new RegExp(`^${label}:[ \\t]*(.*?)[ \\t]*\\r?$`, 'gm'))];
			const value = matches.length === 1 && matches[0][1].trim() ? matches[0][1].trim() : null;
			return [label, { matches, value }];
		}));
		const prose = block.replace(/^Evidence:\s+\S+\s*$/gm, '').trim();
		const parsedFeature = {
			title: heading[1],
			prose,
			evidence: evidence.length === 1 ? evidence[0][1] : null,
			before: fields.Before.value,
			after: fields.After.value,
			value: fields.Value.value,
		};
		for (const label of ['Before', 'After', 'Value']) {
			const field = fields[label];
			if (field.matches.length === 0 || (field.matches.length === 1 && field.value === null)) {
				return {
					ok: false,
					reason: `${notePath} feature "${heading[1]}" is missing required ${label}: field.`,
					features: [parsedFeature],
				};
			}
			if (field.matches.length !== 1) {
				return {
					ok: false,
					reason: `${notePath} feature "${heading[1]}" needs exactly one ${label}: field.`,
					features: [parsedFeature],
				};
			}
		}
		if (!prose || /^#/m.test(prose)) {
			return {
				ok: false,
				reason: `${notePath} feature "${heading[1]}" needs player-facing prose before its evidence mapping.`,
				features: [parsedFeature],
			};
		}
		if (evidence.length !== 1) {
			return {
				ok: false,
				reason: `${notePath} feature "${heading[1]}" needs exactly one Evidence: img/<file>.png mapping.`,
				features: [parsedFeature],
			};
		}
		features.push(parsedFeature);
	}
	return { ok: true, reason: null, features };
}

function regularFile(file) {
	try { return statSync(file).isFile(); } catch { return false; }
}

function resolveInside(base, relative) {
	if (!nonEmptyString(relative)) return null;
	const resolved = path.resolve(base, relative);
	return resolved.startsWith(`${path.resolve(base)}${path.sep}`) ? resolved : null;
}

export function parseChangedropSection(body = '') {
	const source = String(body);
	// Count ## Changedrop sections — must be exactly one for applicable PRs.
	const sections = [...source.matchAll(/^##[ \t]+Changedrop[ \t]*$/gm)];
	if (sections.length === 0) {
		return { ok: false, reason: 'Applicable PR body has no "## Changedrop" section. Declare the changedrop outcome with run/output/sha256/publish.state/delivered or decision: skip / Reason.' };
	}
	if (sections.length > 1) {
		return { ok: false, reason: 'PR body has multiple "## Changedrop" sections; provide exactly one.' };
	}
	const start = sections[0].index + sections[0][0].length;
	const bodyAfter = source.slice(start);
	const nextHeading = bodyAfter.search(/^##[ \t]+/m);
	const sectionBody = nextHeading >= 0 ? bodyAfter.slice(0, nextHeading).trim() : bodyAfter.trim();

	const lines = sectionBody.split(/\r?\n/).filter((l) => l.trim());
	const fields = new Map();
	for (const line of lines) {
		const m = line.match(/^([a-z][a-z0-9._-]*):\s*(.*?)\s*$/i);
		if (!m) continue;
		const key = m[1].toLowerCase();
		const value = m[2];
		if (fields.has(key)) {
			return { ok: false, reason: `Duplicate field "${key}" in ## Changedrop section.` };
		}
		fields.set(key, value);
	}

	const hasRun = fields.has('run');
	const hasDecision = fields.has('decision');

	// Both forms present → fail (case 7).
	if (hasRun && hasDecision) {
		return { ok: false, reason: '## Changedrop section mixes form A (run/output/sha256/publish.state/delivered) and form B (decision: skip / Reason) fields; use one form.' };
	}

	// Form A: video exists.
	if (hasRun) {
		const requiredA = ['run', 'output', 'sha256', 'publish.state', 'delivered'];
		for (const f of requiredA) {
			if (!fields.has(f)) {
				return { ok: false, reason: `## Changedrop form A is missing required field "${f}".` };
			}
		}
		const sha256 = fields.get('sha256');
		if (!/^[0-9a-fA-F]{64}$/.test(sha256)) {
			return { ok: false, reason: '## Changedrop sha256 must be exactly 64 hex characters.' };
		}
		const publishState = fields.get('publish.state');
		if (publishState !== 'withheld') {
			return { ok: false, reason: '## Changedrop publish.state must be "withheld".' };
		}
		return { ok: true, reason: null, form: 'A', fields };
	}

	// Form B: analyzer skipped.
	if (hasDecision) {
		const decisionVal = fields.get('decision');
		if (decisionVal !== 'skip') {
			return { ok: false, reason: '## Changedrop decision must be "skip" (or use form A with run/output/sha256/publish.state/delivered).' };
		}
		const rawReason = fields.get('reason') ?? '';
		// Strip HTML comments, same semantics as parseInternalOnlyExemption.
		const stripped = rawReason.replace(/<!--.*?-->/g, '').trim();
		if (!stripped) {
			return { ok: false, reason: '## Changedrop form B requires a non-empty Reason (after stripping HTML comments).' };
		}
		return { ok: true, reason: null, form: 'B', fields, skipReason: stripped };
	}

	// Neither form recognized.
	return { ok: false, reason: '## Changedrop section does not match form A (run/output/sha256/publish.state/delivered) or form B (decision: skip / Reason).' };
}

export function decideReleaseNoteGate({ prBody = '', labels = [], repoRoot = '.' } = {}) {
	const names = labelNames(labels);
	if (!names.some((name) => APPLY_LABELS.has(name))) {
		return decision(true, 'Release-note gate does not apply without a user-visible or release label.');
	}
	const body = String(prBody);
	if (!ISSUE_REFERENCE_RE.test(body)) {
		return decision(false, 'Applicable PR body has no linked ticket reference (#N).');
	}
	if (names.includes('internal-only')) {
		const exemption = parseInternalOnlyExemption(body);
		if (!exemption.ok) {
			return decision(false, exemption.error);
		}
		return decision(true, 'Recorded internal-only exemption; release notes and images are not required.',
			`Internal-only reason: ${exemption.reason}`);
	}

	// Validate the ## Changedrop section in the PR body.
	const changedrop = parseChangedropSection(body);
	if (!changedrop.ok) {
		return decision(false, changedrop.reason);
	}

	// Privacy scan on the changedrop section (case 10).
	const cdSectionMatch = body.match(/^##[ \t]+Changedrop[ \t]*$[\s\S]*?(?=^##[ \t]+|$(?![\s\S]))/m);
	if (cdSectionMatch) {
		const privatePatternsCd = [/\/home\//i, /\/Users\//i, /\$USER\b/i, /file:\/\//i, /\baudio\.path\b/i];
		const localHostname = hostname();
		if (localHostname) {
			const escaped = localHostname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			privatePatternsCd.push(new RegExp(`(^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'i'));
		}
		if (privatePatternsCd.some((pattern) => pattern.test(cdSectionMatch[0]))) {
			return decision(false, '## Changedrop section contains a private path, hostname, or audio.path key.');
		}
	}

	const match = body.match(NOTE_PATH_RE);
	const notePath = match?.[0];
	if (!notePath) {
		return decision(false, 'PR body must name its canonical document as docs/<slug>/NOTES.md.');
	}
	const root = path.resolve(repoRoot);
	const noteFile = resolveInside(root, notePath);
	if (!noteFile || !regularFile(noteFile)) {
		return decision(false, `Canonical document ${notePath} is missing from the repository.`);
	}
	const source = readFileSync(noteFile, 'utf8');
	const privatePatterns = [/\/home\//i, /\/Users\//i, /\$USER\b/i, /file:\/\//i];
	const localHostname = hostname();
	if (localHostname) {
		const escaped = localHostname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		privatePatterns.push(new RegExp(`(^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'i'));
	}
	if (privatePatterns.some((pattern) => pattern.test(source))) {
		return decision(false, `${notePath} contains a private path or hostname.`);
	}
	const title = source.match(/^#[ \t]+\S.*$/m);
	if (!title || title.index !== 0) {
		return decision(false, `${notePath} must begin with one level-one title.`);
	}
	const featuresHeading = source.search(/^##[ \t]+Features[ \t]*$/m);
	const summary = featuresHeading < 0 ? '' : source.slice(title[0].length, featuresHeading).trim();
	if (!summary || summary.split(/\r?\n[ \t]*\r?\n/).length !== 1 || /^#/m.test(summary)) {
		return decision(false, `${notePath} needs one player-facing summary paragraph before "## Features".`);
	}
	const noteDir = path.dirname(noteFile);
	const parsedFeatures = parseReleaseNoteFeatures(source, { notePath });
	if (!parsedFeatures.ok) {
		return decision(false, parsedFeatures.reason);
	}
	for (const feature of parsedFeatures.features) {
		const evidencePath = feature.evidence;
		const evidenceFile = /^img\/[^/\s]+\.png$/i.test(evidencePath)
			? resolveInside(noteDir, evidencePath) : null;
		if (!evidenceFile || !regularFile(evidenceFile)) {
			return decision(false, `${notePath} feature evidence ${evidencePath} does not resolve to a file.`);
		}
	}
	const payloadBlock = source.match(/^##[ \t]+Discord payload[ \t]*$[\s\S]*?```json[ \t]*\r?\n([\s\S]*?)\r?\n```/m);
	if (!payloadBlock) {
		return decision(false, `${notePath} has no fenced JSON block under "## Discord payload".`);
	}
	let payload;
	try {
		payload = JSON.parse(payloadBlock[1]);
	} catch (error) {
		return decision(false, `${notePath} Discord payload is not parseable JSON: ${error.message}`);
	}
	if (!nonEmptyString(payload?.content)) {
		return decision(false, `${notePath} Discord payload needs non-empty content.`);
	}
	if (!Array.isArray(payload?.allowed_mentions?.parse) || payload.allowed_mentions.parse.length !== 0) {
		return decision(false, `${notePath} Discord payload allowed_mentions.parse must be an empty array.`);
	}
	for (const match of payload.content.matchAll(/https?:\/\/[^\s<>]+/g)) {
		const isImage = /\.(?:png|jpe?g|gif|webp)(?:[?#].*)?$/i.test(match[0]);
		const wrapped = payload.content[match.index - 1] === '<'
			&& payload.content[match.index + match[0].length] === '>';
		if (!isImage && !wrapped) {
			return decision(false, `${notePath} Discord content must wrap non-image links in <…> to suppress previews.`);
		}
	}
	if (!Array.isArray(payload.embeds) || payload.embeds.length === 0) {
		return decision(false, `${notePath} Discord payload needs at least one embed.`);
	}
	const embeddedNames = [];
	for (const [index, embed] of payload.embeds.entries()) {
		if (!nonEmptyString(embed?.title)) {
			return decision(false, `${notePath} Discord payload embed ${index + 1} needs a title.`);
		}
		if (!nonEmptyString(embed?.description)) {
			return decision(false, `${notePath} Discord payload embed ${index + 1} needs a description.`);
		}
		const imageMatch = String(embed?.image?.url ?? '').match(/^attachment:\/\/([^/\s]+)$/);
		if (!imageMatch) {
			return decision(false, `${notePath} Discord payload embed ${index + 1} needs an attachment:// image.`);
		}
		embeddedNames.push(imageMatch[1]);
	}
	if (!Array.isArray(payload.attachments) || payload.attachments.length === 0) {
		return decision(false, `${notePath} Discord payload has no attachment mapping for ${embeddedNames[0]}.`);
	}
	const attachments = new Map();
	for (const [index, attachment] of payload.attachments.entries()) {
		if (!nonEmptyString(attachment?.name) || /[/\\\s]/.test(attachment.name)) {
			return decision(false, `${notePath} Discord attachment ${index + 1} has an invalid name.`);
		}
		if (attachments.has(attachment.name)) {
			return decision(false, `${notePath} Discord attachment name ${attachment.name} is duplicated.`);
		}
		const attachmentFile = /^img\/[^/\s]+\.png$/i.test(attachment?.path ?? '')
			? resolveInside(noteDir, attachment.path) : null;
		if (!attachmentFile || !regularFile(attachmentFile)) {
			return decision(false, `${notePath} Discord attachment path ${attachment?.path ?? '(missing)'} does not resolve to a file.`);
		}
		attachments.set(attachment.name, attachment.path);
	}
	for (const name of embeddedNames) {
		if (!attachments.has(name)) {
			return decision(false, `${notePath} embed image ${name} has no matching attachment mapping.`);
		}
	}
	const notice = changedrop.form === 'B' ? `Changedrop skip reason: ${changedrop.skipReason}` : null;
	return decision(true, `Release note ${notePath} is complete and ready for review.`, notice);
}

function parseLabels(raw = '[]') {
	try {
		const labels = JSON.parse(raw);
		return Array.isArray(labels) ? labels : [];
	} catch {
		return String(raw).split(',').map((label) => label.trim()).filter(Boolean);
	}
}

export async function main(env = process.env) {
	const result = decideReleaseNoteGate({
		prBody: env.PR_BODY ?? '',
		labels: parseLabels(env.PR_LABELS),
		repoRoot: env.REPO_ROOT ?? process.cwd(),
	});
	if (!result.ok) {
		console.log(`::error title=Release-note gate::${result.reason.replaceAll('\n', '%0A')}`);
	} else if (result.notice) {
		console.log(`::notice title=Release-note gate::${result.notice.replaceAll('\n', '%0A')}`);
	}
	console.log(result.reason);
	return result;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
	main().then((result) => {
		if (!result.ok) process.exitCode = 1;
	}).catch((error) => {
		console.error(`::error title=Release-note gate::${String(error.message ?? error)}`);
		process.exitCode = 1;
	});
}
