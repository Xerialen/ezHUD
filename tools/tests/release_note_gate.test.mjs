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

function notes(payload = VALID_PAYLOAD, evidence = 'img/proof.png') {
	return `# Player change\n\nA short player-facing summary.\n\n## Features\n\n### A visible improvement\nPlayers can use the changed control more reliably. The clearer state saves time while editing.\n\nBefore: The changed control was unreliable.\nAfter: The changed control is clear and dependable.\nValue: Players spend less time correcting state.\nEvidence: ${evidence}\n\n## Discord payload\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n`;
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

const DEFAULT_CHANGEDROP_A = `## Changedrop\nrun: 20260808-001\noutput: walkthrough.mp4\nsha256: ${'a'.repeat(64)}\npublish.state: withheld\ndelivered: Dumpen/Ezhud/release-2/20260808-001/`;

function applicableBody(extra = '', changedrop = DEFAULT_CHANGEDROP_A) {
	let body = `Closes #57\n\nCanonical document: docs/change/NOTES.md${extra}`;
	if (changedrop !== null) body += `\n\n${changedrop}`;
	return body;
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
	const note = notes().replace('## Discord payload', `${secondFeature}## Discord payload`);
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
		['unnamed', `Closes #57\n\n${DEFAULT_CHANGEDROP_A}`],
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

test('#85 case 1: applicable PR without ## Changedrop section is rejected', (t) => {
	const repo = fixture();
	t.after(repo.cleanup);
	const result = decideReleaseNoteGate({
		prBody: applicableBody('', null),
		labels: ['release'],
		repoRoot: repo.repoRoot,
	});
	assert.equal(result.ok, false, result.reason);
	assert.match(result.reason, /[Cc]hangedrop/i);
});

test('#85 case 4: form A passes with all five fields and valid sha256', (t) => {
	const repo = fixture();
	t.after(repo.cleanup);
	for (const labels of [['release'], ['user-visible']]) {
		const result = decideReleaseNoteGate({
			prBody: applicableBody('', `## Changedrop\nrun: 20260808-001\noutput: walkthrough.mp4\nsha256: ${'a'.repeat(64)}\npublish.state: withheld\ndelivered: Dumpen/Ezhud/release-2/20260808-001/`),
			labels,
			repoRoot: repo.repoRoot,
		});
		assert.equal(result.ok, true, `${labels[0]}: ${result.reason}`);
	}
});

test('#85 case 3: form A fails when sha256 is not 64 hex characters', (t) => {
	const repo = fixture();
	t.after(repo.cleanup);
	const base = '## Changedrop\nrun: 20260808-001\noutput: walkthrough.mp4\nsha256: ';
	const trailers = '\npublish.state: withheld\ndelivered: Dumpen/Ezhud/release-2/20260808-001/';
	for (const [name, sha] of [
		['too short', 'a'.repeat(63)],
		['too long', 'a'.repeat(65)],
		['non-hex', `${'g'.repeat(64)}`],
		['mixed non-hex', `${'a'.repeat(63)}g`],
	]) {
		const result = decideReleaseNoteGate({
			prBody: applicableBody('', `${base}${sha}${trailers}`),
			labels: ['release'],
			repoRoot: repo.repoRoot,
		});
		assert.equal(result.ok, false, `${name}: ${result.reason}`);
		assert.match(result.reason, /sha256/i, name);
	}
});

test('#85 case 2: form A fails when any required field is missing', (t) => {
	const repo = fixture();
	t.after(repo.cleanup);
	const fields = new Map([
		['run', 'run: 20260808-001'],
		['output', 'output: walkthrough.mp4'],
		['sha256', `sha256: ${'a'.repeat(64)}`],
		['publish.state', 'publish.state: withheld'],
		['delivered', 'delivered: Dumpen/Ezhud/release-2/20260808-001/'],
	]);
	for (const [name] of fields) {
		const lines = [...fields.entries()].filter(([k]) => k !== name).map(([, v]) => v);
		const result = decideReleaseNoteGate({
			prBody: applicableBody('', `## Changedrop\n${lines.join('\n')}`),
			labels: ['release'],
			repoRoot: repo.repoRoot,
		});
		assert.equal(result.ok, false, `${name}: ${result.reason}`);
		assert.match(result.reason, new RegExp(name.replace('.', '\\.'), 'i'), name);
	}
});

test('#85 case 5: form B passes with decision skip and non-empty Reason', (t) => {
	const repo = fixture();
	t.after(repo.cleanup);
	const skipReason = 'No user-visible changes in this release.';
	for (const labels of [['release'], ['user-visible']]) {
		const result = decideReleaseNoteGate({
			prBody: applicableBody('', `## Changedrop\ndecision: skip\nReason: ${skipReason}`),
			labels,
			repoRoot: repo.repoRoot,
		});
		assert.equal(result.ok, true, `${labels[0]}: ${result.reason}`);
		assert.match(result.notice, new RegExp(skipReason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
	}
});

test('#85 case 6: form B fails when Reason is empty, whitespace, or comment-only', (t) => {
	const repo = fixture();
	t.after(repo.cleanup);
	for (const [name, reason] of [
		['empty', 'Reason:'],
		['whitespace', 'Reason:   '],
		['html comment only', 'Reason: <!-- nothing -->'],
	]) {
		const result = decideReleaseNoteGate({
			prBody: applicableBody('', `## Changedrop\ndecision: skip\n${reason}`),
			labels: ['release'],
			repoRoot: repo.repoRoot,
		});
		assert.equal(result.ok, false, `${name}: ${result.reason}`);
		assert.match(result.reason, /[Rr]eason/i, name);
	}
});

test('#85 case 7: both form A and form B together in the same PR body fail', (t) => {
	const repo = fixture();
	t.after(repo.cleanup);
	const formA = `## Changedrop\nrun: 20260808-001\noutput: walkthrough.mp4\nsha256: ${'a'.repeat(64)}\npublish.state: withheld\ndelivered: Dumpen/Ezhud/release-2/20260808-001/`;
	const formB = '## Changedrop\ndecision: skip\nReason: No changes.';
	const result = decideReleaseNoteGate({
		prBody: applicableBody('', `${formA}\n\n${formB}`),
		labels: ['release'],
		repoRoot: repo.repoRoot,
	});
	assert.equal(result.ok, false, result.reason);
	assert.match(result.reason, /both|[Tt]wo [Cc]hangedrop|multiple/i);
});

test('#85 case 7b: mixed form A/B fields in a single section fail', (t) => {
	const repo = fixture();
	t.after(repo.cleanup);
	// Two variants: run with decision, and form A fields without run alongside decision.
	const variants = [
		['run + decision', 'run: 20260808-001\ndecision: skip\noutput: walkthrough.mp4\nReason: mixed.'],
		['no-run form A + decision', `decision: skip\nReason: analyzer skipped\noutput: release-2.mp4\nsha256: ${'a'.repeat(64)}\npublish.state: withheld\ndelivered: Dumpen/Ezhud/x/`],
	];
	for (const [name, section] of variants) {
		const result = decideReleaseNoteGate({
			prBody: applicableBody('', `## Changedrop\n${section}`),
			labels: ['release'],
			repoRoot: repo.repoRoot,
		});
		assert.equal(result.ok, false, `${name}: ${result.reason}`);
		assert.match(result.reason, /mixe[sd]|form A.*form B|form B.*form A/i, name);
	}
});

test('#85 case 11: changedrop section fails when publish.state is not withheld', (t) => {
	const repo = fixture();
	t.after(repo.cleanup);
	// publish.state must be withheld regardless of form.
	const variants = [
		['form A', `## Changedrop\nrun: 20260808-001\noutput: walkthrough.mp4\nsha256: ${'a'.repeat(64)}\npublish.state: published\ndelivered: Dumpen/Ezhud/release-2/20260808-001/`],
		['form B', '## Changedrop\ndecision: skip\nReason: analyzer skipped\npublish.state: posted'],
	];
	for (const [name, section] of variants) {
		const result = decideReleaseNoteGate({
			prBody: applicableBody('', section),
			labels: ['release'],
			repoRoot: repo.repoRoot,
		});
		assert.equal(result.ok, false, `${name}: ${result.reason}`);
		assert.match(result.reason, /publish\.state|withheld/i, name);
	}
});

test('#85 case 10: changedrop section fails on private paths, hostname, or audio.path', (t) => {
	const repo = fixture();
	t.after(repo.cleanup);
	const privateVariants = [
		['home path', `## Changedrop\nrun: 20260808-001\noutput: walkthrough.mp4\nsha256: ${'a'.repeat(64)}\npublish.state: withheld\ndelivered: /home/user/videos/`],
		['hostname', `## Changedrop\nrun: 20260808-001\noutput: walkthrough.mp4\nsha256: ${'a'.repeat(64)}\npublish.state: withheld\ndelivered: Dumpen/Ezhud/release-2/20260808-001/ ${os.hostname()}`],
		['audio.path', `## Changedrop\nrun: 20260808-001\noutput: walkthrough.mp4\nsha256: ${'a'.repeat(64)}\npublish.state: withheld\naudio.path: /tmp/audio.wav\ndelivered: Dumpen/Ezhud/release-2/20260808-001/`],
	];
	for (const [name, section] of privateVariants) {
		const result = decideReleaseNoteGate({
			prBody: applicableBody('', section),
			labels: ['release'],
			repoRoot: repo.repoRoot,
		});
		assert.equal(result.ok, false, `${name}: ${result.reason}`);
		assert.match(result.reason, /private|hostname|audio\.path/i, name);
	}
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
		prBody: `Closes #57\n\nCanonical document: docs/release-1/NOTES.md\n\n${DEFAULT_CHANGEDROP_A}`,
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
