import test from 'node:test';
import assert from 'node:assert/strict';

import {
	decideCasesGate,
	referencedIssues,
} from '../ci/cases_gate.mjs';

const issueCases = { 18: 'Context\n\n## Cases\n\n1. operate → result' };

test('no-cases label bypasses issue and mapping requirements', () => {
	const result = decideCasesGate({ labels: [{ name: 'no-cases' }] });
	assert.equal(result.pass, true);
	assert.match(result.message, /skipped/i);
});

test('a PR without an issue reference fails with the convention', () => {
	const result = decideCasesGate({ prBody: 'case 1: tier 1 test' });
	assert.equal(result.pass, false);
	assert.match(result.message, /references no issue/);
	assert.match(result.message, /docs\/TESTING\.md/);
});

test('referenced issue must contain an exact level-two Cases heading', () => {
	const result = decideCasesGate({
		prBody: 'Closes #18\n\ncase 1: tier 1 model test',
		issueBodies: { 18: '### Cases\n\nAlmost, but wrong level.' },
	});
	assert.equal(result.pass, false);
	assert.match(result.message, /contains a "## Cases" heading/);
});

test('one of several referenced issues having Cases is enough', () => {
	const result = decideCasesGate({
		prBody: 'Related to #17 and closes #18.\n\ncase 1: tier 4F case 36',
		issueBodies: { 17: 'No plan here', ...issueCases },
	});
	assert.deepEqual(result, {
		pass: true,
		message: 'Cases convention satisfied via issue #18 and a PR case mapping.',
	});
});

test('markdown list mapping is accepted when it names a case and tier/test', () => {
	const result = decideCasesGate({
		prBody: 'Fixes #18\n\n- issue case 2 is proven by the tier 3F browser test',
		issueBodies: issueCases,
	});
	assert.equal(result.pass, true);
});

test('an explicit untested reason is accepted', () => {
	const result = decideCasesGate({
		prBody: 'See #18\n\n- untested: needs physical hardware',
		issueBodies: issueCases,
	});
	assert.equal(result.pass, true);
});

test('missing mapping fails with a usable template', () => {
	const result = decideCasesGate({ prBody: 'Closes #18', issueBodies: issueCases });
	assert.equal(result.pass, false);
	assert.match(result.message, /case 1: tier 4F/);
	assert.match(result.message, /untested: <reason>/);
});

test('issue references are deduplicated in first-seen order', () => {
	assert.deepEqual(referencedIssues('Refs #20, closes #18, and repeats #20.'), [20, 18]);
});
