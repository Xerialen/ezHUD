import test from 'node:test';
import assert from 'node:assert/strict';

import {
	GUARD_COMMENT_MARKER,
	decideIssueCasesGuard,
} from '../ci/issue_cases_guard.mjs';

// --- Case 1: enhancement without Cases adds label and comment ---

test('enhancement without Cases adds the needs-cases label and one guard comment', () => {
	const actions = decideIssueCasesGuard({
		body: '## What\n\nAdd a control.',
		labels: ['enhancement'],
		hasGuardComment: false,
	});

	assert.equal(actions.addLabel, 'needs-cases');
	assert.match(actions.comment, /## Cases/);
	assert.match(actions.comment, /docs\/TESTING\.md/);
	// Guard marker must be present so idempotence can be detected on re-runs.
	assert.match(actions.comment, new RegExp(
		GUARD_COMMENT_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
	));
});

// --- Case 2: enhancement with Cases removes marker label and guard comment ---

test('enhancement with Cases removes needs-cases label and signals comment removal', () => {
	const actions = decideIssueCasesGuard({
		body: 'Context\n\n## Cases\n\n1. operate → result',
		labels: ['enhancement', 'needs-cases'],
		hasGuardComment: true,
	});

	assert.equal(actions.removeLabel, 'needs-cases');
	assert.equal(actions.removeComment, true);
	assert.equal(actions.comment, undefined);
	assert.equal(actions.addLabel, undefined);
});

test('enhancement with Cases but without needs-cases label does not remove label', () => {
	const actions = decideIssueCasesGuard({
		body: '## Cases\n\n1. x → y',
		labels: ['enhancement'],
		hasGuardComment: false,
	});

	assert.equal(actions.removeLabel, undefined);
	assert.equal(actions.addLabel, undefined);
	assert.equal(actions.comment, undefined);
	assert.equal(actions.removeComment, undefined);
});

// --- Case 3: idea issues are never touched ---

test('idea issues are never touched', () => {
	assert.deepEqual(decideIssueCasesGuard({ labels: ['idea'] }), {});
	assert.deepEqual(decideIssueCasesGuard({
		body: 'Just an idea, no Cases.',
		labels: ['idea'],
		hasGuardComment: false,
	}), {});
});

// --- Case 4: cleanup needs-cases when enhancement is removed ---

test('non-enhancement issues with stale needs-cases label get it cleaned up', () => {
	assert.deepEqual(decideIssueCasesGuard({
		body: 'Still no Cases heading.',
		labels: ['needs-cases'],
		hasGuardComment: true,
	}), { removeLabel: 'needs-cases' });
});

test('unlabelled issues are untouched', () => {
	assert.deepEqual(decideIssueCasesGuard({ labels: [] }), {});
});

// --- Case 5: idempotence ---

test('enhancement without Cases and existing guard comment does not add duplicate label or comment', () => {
	assert.deepEqual(decideIssueCasesGuard({
		body: 'No Cases yet.',
		labels: ['enhancement', 'needs-cases'],
		hasGuardComment: true,
	}), {});
});

test('enhancement without Cases but with existing label does not duplicate the label', () => {
	const actions = decideIssueCasesGuard({
		body: 'No Cases yet.',
		labels: ['enhancement', 'needs-cases'],
		hasGuardComment: false,
	});

	assert.equal(actions.comment != null, true);
	assert.equal(actions.addLabel, undefined, 'should not re-add needs-cases when it already exists');
});

// --- Case 6: re-removal — Cases removed after being fixed ---

test('removing Cases after they were added restores label and comment', () => {
	// Simulates: issue has enhancement, no guard comment (comment was deleted
	// when Cases were previously added), no needs-cases (was removed).
	// Cases have now been removed from the body again.
	const actions = decideIssueCasesGuard({
		body: '## What\n\nNo Cases here.',
		labels: ['enhancement'],
		hasGuardComment: false,
	});

	assert.equal(actions.addLabel, 'needs-cases');
	assert.match(actions.comment, /## Cases/);
});

// --- Edge: comment content is stable ---

test('guard comment references the test-plan convention doc', () => {
	const actions = decideIssueCasesGuard({
		body: 'No plan.',
		labels: ['enhancement'],
		hasGuardComment: false,
	});

	assert.match(actions.comment, /docs\/TESTING\.md/);
	assert.match(actions.comment, /Test-plan convention/);
});
