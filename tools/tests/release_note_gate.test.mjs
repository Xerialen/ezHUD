import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { decideReleaseNoteGate } from '../ci/release_note_gate.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const VALID_PAYLOAD = {
	content: 'Read the notes: <https://example.invalid/notes>',
	embeds: [{
		title: 'A visible improvement',
		description: 'The changed control is now easier to use.',
		image: { url: 'attachment://proof.png' },
	}],
	allowed_mentions: { parse: [] },
	attachments: [{ name: 'proof.png', path: 'img/proof.png' }],
};

const VALID_DECLARATION = {
	schema_version: 'changedrop-value-summary/1',
	decision: 'render',
	skip_reason: null,
	features: [{ surface: 'proof', before: 'The changed control was unreliable.', after: 'The changed control is clear and dependable.', value: 'Players spend less time correcting state.' }],
};

function notes(payload = VALID_PAYLOAD, evidence = 'img/proof.png', declaration = VALID_DECLARATION) {
	let doc = `# Player change\n\nA short player-facing summary.\n\n## Features\n\n### A visible improvement\nPlayers can use the changed control more reliably. The clearer state saves time while editing.\n\nBefore: The changed control was unreliable.\nAfter: The changed control is clear and dependable.\nValue: Players spend less time correcting state.\nEvidence: ${evidence}\n\n`;
	if (declaration !== null) {
		doc += `## Changedrop declaration\n\n\`\`\`json\n${JSON.stringify(declaration, null, 2)}\n\`\`\`\n\n`;
	}
	doc += `## Discord payload\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n`;
	return doc;
}

function fixture({ note = notes(), images = ['img/proof.png'] } = {}) {
	const repoRoot = mkdtempSync(path.join(os.tmpdir(), 'ezhud-release-note-gate-'));
	const noteDir = path.join(repoRoot, 'docs/change');
	mkdirSync(noteDir, { recursive: true });
	if (note !== null) writeFileSync(path.join(noteDir, 'NOTES.md'), note);
	for (const image of images) {
		const target = path.join(noteDir, image);
		mkdirSync(path.dirname(target), { recursive: true });
		writeFileSync(target, 'image bytes');
	}
	return {
		repoRoot,
		cleanup: () => rmSync(repoRoot, { recursive: true, force: true }),
	};
}

function applicableBody(extra = '') {
	return `Closes #57\n\nCanonical document: docs/change/NOTES.md${extra}`;
}

test('case 1: a linked release PR with valid notes, evidence and payload passes', (t) => {
	const repo = fixture();
	t.after(repo.cleanup);
	const result = decideReleaseNoteGate({
		prBody: applicableBody(),
		labels: ['user-visible'],
		repoRoot: repo.repoRoot,
	});
	assert.equal(result.ok, true);
	assert.equal(result.notice, null);
	assert.match(result.reason, /docs\/change\/NOTES\.md/);
});

test('mandatory value triple: all three fields on every feature pass for both apply labels', (t) => {
	const secondFeature = `### A second improvement\nBefore: The second control was hidden.\nAfter: The second control is visible.\nValue: Players find it immediately.\nEvidence: img/proof.png\n\n`;
	const secondDeclaration = { ...VALID_DECLARATION, features: [
		VALID_DECLARATION.features[0],
		{ surface: 'proof', before: 'The second control was hidden.', after: 'The second control is visible.', value: 'Players find it immediately.' },
	] };
	const note = notes(VALID_PAYLOAD, 'img/proof.png', secondDeclaration)
		.replace('## Changedrop declaration', `${secondFeature}## Changedrop declaration`);
	for (const labels of [['user-visible'], ['release']]) {
		const repo = fixture({ note });
		t.after(repo.cleanup);
		const result = decideReleaseNoteGate({ prBody: applicableBody(), labels, repoRoot: repo.repoRoot });
		assert.equal(result.ok, true, result.reason);
	}
	const missingSecond = fixture({ note: note.replace('Value: Players find it immediately.\n', '') });
	t.after(missingSecond.cleanup);
	const result = decideReleaseNoteGate({
		prBody: applicableBody(), labels: ['release'], repoRoot: missingSecond.repoRoot,
	});
	assert.equal(result.ok, false);
	assert.match(result.reason, /A second improvement.*Value:/i);
});

test('mandatory value triple: each absent field fails with canonical file, feature block, and field named', (t) => {
	for (const field of ['Before', 'After', 'Value']) {
		for (const label of ['user-visible', 'release']) {
			const note = notes().replace(new RegExp(`^${field}:.*\\n`, 'm'), '');
			const repo = fixture({ note });
			t.after(repo.cleanup);
			const result = decideReleaseNoteGate({
				prBody: applicableBody(), labels: [label], repoRoot: repo.repoRoot,
			});
			assert.equal(result.ok, false, `${label} ${field}`);
			assert.match(result.reason, /docs\/change\/NOTES\.md/, field);
			assert.match(result.reason, /A visible improvement/, field);
			assert.match(result.reason, new RegExp(`${field}:?`, 'i'), field);
		}
	}
});

test('mandatory value triple: empty and whitespace-only fields fail identically to absent', (t) => {
	for (const field of ['Before', 'After', 'Value']) {
		const absentRepo = fixture({ note: notes().replace(new RegExp(`^${field}:.*\\n`, 'm'), '') });
		t.after(absentRepo.cleanup);
		const absent = decideReleaseNoteGate({
			prBody: applicableBody(), labels: ['release'], repoRoot: absentRepo.repoRoot,
		});
		for (const replacement of [`${field}:\n`, `${field}:   \t\n`]) {
			const repo = fixture({ note: notes().replace(new RegExp(`^${field}:.*\\n`, 'm'), replacement) });
			t.after(repo.cleanup);
			const result = decideReleaseNoteGate({
				prBody: applicableBody(), labels: ['user-visible'], repoRoot: repo.repoRoot,
			});
			assert.equal(result.ok, false, `${field} ${JSON.stringify(replacement)}`);
			assert.equal(result.reason, absent.reason, `${field} empty must equal absent`);
		}
	}
});

test('case 2: an unnamed or absent canonical notes document fails by name', (t) => {
	const repo = fixture({ note: null, images: [] });
	t.after(repo.cleanup);
	for (const [name, prBody] of [
		['unnamed', 'Closes #57'],
		['absent', applicableBody()],
	]) {
		const result = decideReleaseNoteGate({ prBody, labels: ['release'], repoRoot: repo.repoRoot });
		assert.equal(result.ok, false, name);
		assert.equal(result.notice, null, name);
		assert.match(result.reason, /docs\/.+\/NOTES\.md|canonical document/i, name);
	}
});

test('case 3: missing, malformed or incomplete Discord payloads name their defect', (t) => {
	const withoutPayload = notes().replace(/\n## Discord payload[\s\S]*$/, '\n');
	const malformed = notes().replace(JSON.stringify(VALID_PAYLOAD, null, 2), '{not json}');
	const variants = [
		['missing payload', withoutPayload, /Discord payload/i],
		['malformed JSON', malformed, /parseable JSON|invalid JSON/i],
		['missing embed title', notes({ ...VALID_PAYLOAD, embeds: [{ ...VALID_PAYLOAD.embeds[0], title: '' }] }), /embed.*title/i],
		['missing embed description', notes({ ...VALID_PAYLOAD, embeds: [{ ...VALID_PAYLOAD.embeds[0], description: '' }] }), /embed.*description/i],
		['missing attachment image', notes({ ...VALID_PAYLOAD, embeds: [{ title: 'Title', description: 'Description' }] }), /embed.*attachment:\/\//i],
	];
	for (const [name, note, reason] of variants) {
		const repo = fixture({ note });
		t.after(repo.cleanup);
		const result = decideReleaseNoteGate({
			prBody: applicableBody(), labels: ['user-visible'], repoRoot: repo.repoRoot,
		});
		assert.equal(result.ok, false, name);
		assert.match(result.reason, reason, name);
	}
});

test('case 4: unresolved feature evidence and Discord attachments fail by path', (t) => {
	const noMapping = { ...VALID_PAYLOAD, attachments: [] };
	const missingAttachment = {
		...VALID_PAYLOAD,
		attachments: [{ name: 'proof.png', path: 'img/missing-upload.png' }],
	};
	const variants = [
		['embed has no attachment mapping', notes(noMapping), /proof\.png.*attachment|attachment.*proof\.png/i],
		['attachment mapping has no file', notes(missingAttachment), /img\/missing-upload\.png/],
		['feature evidence has no file', notes(VALID_PAYLOAD, 'img/missing-evidence.png'), /img\/missing-evidence\.png/],
	];
	for (const [name, note, reason] of variants) {
		const repo = fixture({ note });
		t.after(repo.cleanup);
		const result = decideReleaseNoteGate({
			prBody: applicableBody(), labels: ['release'], repoRoot: repo.repoRoot,
		});
		assert.equal(result.ok, false, name);
		assert.match(result.reason, reason, name);
	}
});

test('case 5: a recorded internal-only exemption passes with a notice and no images', (t) => {
	const repo = fixture({ note: null, images: [] });
	t.after(repo.cleanup);
	const prBody = `Closes #57\n\n## Internal-only exemption\n- [x] This change has no user-visible effect.\nReason: Refactors CI job names only.`;
	const result = decideReleaseNoteGate({
		prBody,
		labels: ['release', { name: 'internal-only' }],
		repoRoot: repo.repoRoot,
	});
	assert.equal(result.ok, true);
	assert.match(result.reason, /internal-only/i);
	assert.match(result.notice, /Refactors CI job names only/);

	const missingReason = decideReleaseNoteGate({
		prBody: 'Closes #57\n\n## Internal-only exemption\n- [x] No user-visible effect.\nReason: <!-- required -->',
		labels: ['release', 'internal-only'],
		repoRoot: repo.repoRoot,
	});
	assert.equal(missingReason.ok, false);
	assert.match(missingReason.reason, /checked exemption box.*Reason/i);
});

test('case 6: an applicable PR without a ticket reference fails', (t) => {
	const repo = fixture();
	t.after(repo.cleanup);
	for (const [name, labels, prBody] of [
		['user-visible', ['user-visible'], 'Canonical document: docs/change/NOTES.md'],
		['internal-only', ['release', 'internal-only'], '## Internal-only exemption\n- [x] No user-visible effect.\nReason: CI only.'],
	]) {
		const result = decideReleaseNoteGate({ prBody, labels, repoRoot: repo.repoRoot });
		assert.equal(result.ok, false, name);
		assert.match(result.reason, /ticket|#N|issue reference/i, name);
	}
});

test('review blocker: notes without a changedrop declaration are rejected', (t) => {
	const repo = fixture({ note: notes(VALID_PAYLOAD, 'img/proof.png', null) });
	t.after(repo.cleanup);
	const result = decideReleaseNoteGate({
		prBody: applicableBody(),
		labels: ['user-visible'],
		repoRoot: repo.repoRoot,
	});
	assert.equal(result.ok, false, result.reason);
	assert.match(result.reason, /[Cc]hangedrop declaration/i);
});

test('ordinary PRs pass untouched, including an internal-only label without an apply label', () => {
	for (const labels of [[], ['docs'], ['internal-only']]) {
		assert.deepEqual(decideReleaseNoteGate({ labels }), {
			ok: true,
			reason: 'Release-note gate does not apply without a user-visible or release label.',
			notice: null,
		});
	}
});

test('payload mention safety, link suppression and document privacy are enforced', (t) => {
	const noAllowedMentions = { ...VALID_PAYLOAD };
	delete noAllowedMentions.allowed_mentions;
	const unsuppressedLink = { ...VALID_PAYLOAD, content: 'Read https://example.invalid/notes' };
	const variants = [
		['allowed mentions', notes(noAllowedMentions), /allowed_mentions.*parse/i],
		['link suppression', notes(unsuppressedLink), /wrap.*<…>|preview/i],
		['private path', `${notes()}\nBuilt from /home/private/repo.\n`, /private|\/home\//i],
		['hostname', `${notes()}\nBuilt on ${os.hostname()}.\n`, /hostname|private/i],
	];
	for (const [name, note, reason] of variants) {
		const repo = fixture({ note });
		t.after(repo.cleanup);
		const result = decideReleaseNoteGate({
			prBody: applicableBody(), labels: ['release'], repoRoot: repo.repoRoot,
		});
		assert.equal(result.ok, false, name);
		assert.match(result.reason, reason, name);
	}
});

test('canonical notes require a title and player summary before structured feature text', (t) => {
	const variants = [
		['title', notes().replace(/^# Player change\n/, ''), /level-one title/i],
		['summary', notes().replace(/\nA short player-facing summary\.\n/, '\n'), /summary/i],
	];
	for (const [name, note, reason] of variants) {
		const repo = fixture({ note });
		t.after(repo.cleanup);
		const result = decideReleaseNoteGate({
			prBody: applicableBody(), labels: ['release'], repoRoot: repo.repoRoot,
		});
		assert.equal(result.ok, false, name);
		assert.match(result.reason, reason, name);
	}
});

test('case 7: docs/release-1 is the canonical first exemplar and old sources are retired', () => {
	const result = decideReleaseNoteGate({
		prBody: 'Closes #57\n\nCanonical document: docs/release-1/NOTES.md',
		labels: ['release'],
		repoRoot: REPO_ROOT,
	});
	assert.equal(result.ok, true, result.reason);
	assert.equal(existsSync(path.join(REPO_ROOT, 'docs/release-1/RELEASE-NOTES.md')), false);
	assert.equal(existsSync(path.join(REPO_ROOT, 'docs/release-1/ANNOUNCEMENT-discord.md')), false);
});

test('case 8: workflow records current-SHA review, owner Go and merge-as-publication', () => {
	const workflow = readFileSync(path.join(REPO_ROOT, 'docs/RELEASE-NOTE-WORKFLOW.md'), 'utf8');
	for (const required of [
		/spec.*RED gate.*Sol implements/is,
		/Opus.*current head SHA/is,
		/never.*reused PASS.*superseded commit/is,
		/green CI.*browser validation.*desktop.*phone/is,
		/private.*one-message.*#outbox/is,
		/owner Go.*merge.*Pages deploy.*live verification/is,
		/merging.*main.*auto-deploys Pages/is,
		/merge is publication/i,
	]) assert.match(workflow, required);
});

test('ticket template and pull-request workflow carry the standardized contract', () => {
	const template = readFileSync(path.join(REPO_ROOT, '.github/ISSUE_TEMPLATE/release-change.md'), 'utf8');
	for (const required of [
		/docs\/<slug>\/NOTES\.md/,
		/notes document written/i,
		/evidence images mapped/i,
		/Discord payload/i,
		/reviewed by the release lead/i,
		/Owner Go received/i,
		/^## Internal-only exemption$/m,
		/- \[ \].*no user-visible effect/i,
		/^Reason:/m,
		/^## Cases$/m,
	]) assert.match(template, required);

	const action = readFileSync(path.join(REPO_ROOT, '.github/workflows/release-note-gate.yml'), 'utf8');
	assert.match(action, /types:\s*\[opened, edited, synchronize, labeled, unlabeled\]/);
	assert.match(action, /node tools\/ci\/release_note_gate\.mjs/);
	assert.match(action, /PR_BODY:/);
	assert.match(action, /PR_LABELS:/);
});
