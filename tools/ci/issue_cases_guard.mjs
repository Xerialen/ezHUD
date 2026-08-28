#!/usr/bin/env node
// Label-driven issue guard for the test-plan convention.
// Policy stays in the pure decideIssueCasesGuard(); main() is only GitHub
// event/API plumbing.

import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { CASES_HEADING_RE } from './cases_gate.mjs';

export const GUARD_COMMENT_MARKER = '<!-- needs-cases-guard -->';
export function needsCasesComment(repo = 'Xerialen/ezHUD') {
	return [
		GUARD_COMMENT_MARKER,
		'This enhancement needs its test plan at the source. Please add this section to the issue body:',
		'',
		'```markdown',
		'## Cases',
		'',
		'1. <operate the control/feature> → <observable result: engine cvar readback, export line, or pixel change>',
		'```',
		'',
		`See [docs/TESTING.md](https://github.com/${repo}/blob/main/docs/TESTING.md), `
			+ '**Test-plan convention: issue → Cases → PR**.',
	].join('\n');
}

function normalizedLabelNames(labels) {
	return (Array.isArray(labels) ? labels : [])
		.map((label) => typeof label === 'string' ? label : label?.name)
		.filter(Boolean);
}

/**
 * Pure issue-guard decision.
 *
 * Returns an object with zero or more of the following optional keys:
 *   addLabel       — label name to add
 *   removeLabel    — label name to remove
 *   comment        — guard-comment body to post
 *   removeComment  — true when the caller should delete the existing guard
 *                     comment (identified by GUARD_COMMENT_MARKER)
 *
 * Enhancement without Cases: add label + post comment.
 * Enhancement with Cases:    remove label + remove comment (if present).
 * Non-enhancement:           only clean up stale `needs-cases` label.
 * Idempotent:                a second run sees the same actions as the first.
 */
export function decideIssueCasesGuard({ body = '', labels = [], hasGuardComment = false, repo = 'Xerialen/ezHUD' } = {}) {
	const names = normalizedLabelNames(labels);
	const isEnhancement = names.includes('enhancement');
	const isIdea = names.includes('idea');
	const needsCases = names.includes('needs-cases');

	// idea always wins — an idea issue is never subject to Cases enforcement,
	// even when the template auto-assigned enhancement.
	if (!isEnhancement || isIdea) {
		// Non-enhancement / idea: only clean up stale needs-cases label.
		return needsCases ? { removeLabel: 'needs-cases' } : {};
	}

	// Enhancement (without idea): check Cases heading.
	if (CASES_HEADING_RE.test(String(body))) {
		// Cases present — remove marker label and guard comment if they exist.
		const actions = {};
		if (needsCases) actions.removeLabel = 'needs-cases';
		if (hasGuardComment) actions.removeComment = true;
		return actions;
	}

	// Enhancement without Cases — add label and/or comment as needed.
	const actions = {};
	if (!needsCases) actions.addLabel = 'needs-cases';
	if (!hasGuardComment) actions.comment = needsCasesComment(repo);
	return actions;
}

function parseLabels(raw = '[]') {
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return String(raw).split(',').map((label) => label.trim()).filter(Boolean);
	}
}

function githubHeaders(token) {
	return {
		accept: 'application/vnd.github+json',
		authorization: `Bearer ${token}`,
		'x-github-api-version': '2022-11-28',
	};
}

async function githubRequest(url, token, options = {}) {
	const response = await fetch(url, {
		...options,
		headers: {
			...githubHeaders(token),
			...(options.body != null && { 'content-type': 'application/json' }),
		},
	});
	if (!response.ok) {
		throw new Error(`GitHub API ${options.method ?? 'GET'} ${url} returned ${response.status}`);
	}
	return response;
}

function nextPage(linkHeader) {
	if (!linkHeader) return null;
	for (const part of linkHeader.split(',')) {
		const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
		if (match?.[2] === 'next') return match[1];
	}
	return null;
}

async function findGuardComment(repo, issueNumber, token) {
	let url = `https://api.github.com/repos/${repo}/issues/${issueNumber}/comments?per_page=100`;
	while (url) {
		const response = await githubRequest(url, token);
		const comments = await response.json();
		const found = comments.find((comment) =>
			String(comment.body ?? '').includes(GUARD_COMMENT_MARKER));
		if (found) return found;
		url = nextPage(response.headers.get('link'));
	}
	return null;
}

export async function main(env = process.env) {
	const repo = env.REPO;
	const issueNumber = env.ISSUE_NUMBER;
	const token = env.GITHUB_TOKEN;
	if (!repo || !issueNumber || !token) {
		throw new Error('REPO, ISSUE_NUMBER, and GITHUB_TOKEN are required');
	}

	const body = env.ISSUE_BODY ?? '';
	const labels = parseLabels(env.ISSUE_LABELS);

	// Only bother checking for prior guard comment when it might matter:
	// enhancement (without idea) + Cases → we might need to delete it.
	// enhancement (without idea) + no Cases → we might need to avoid posting a duplicate.
	// idea always wins, so skip the comment lookup entirely when idea is present.
	const isEnhancement = labels.includes('enhancement');
	const isIdea = labels.includes('idea');
	let priorComment = null;
	if (isEnhancement && !isIdea) {
		priorComment = await findGuardComment(repo, issueNumber, token);
	}

	const actions = decideIssueCasesGuard({
		body,
		labels,
		hasGuardComment: priorComment != null,
		repo,
	});
	const issueUrl = `https://api.github.com/repos/${repo}/issues/${issueNumber}`;

	if (actions.addLabel) {
		await githubRequest(`${issueUrl}/labels`, token, {
			method: 'POST',
			body: JSON.stringify({ labels: [actions.addLabel] }),
		});
	}
	if (actions.removeLabel) {
		await githubRequest(`${issueUrl}/labels/${encodeURIComponent(actions.removeLabel)}`, token, {
			method: 'DELETE',
		});
	}
	if (actions.removeComment && priorComment) {
		await githubRequest(priorComment.url, token, { method: 'DELETE' });
	}
	if (actions.comment) {
		await githubRequest(`${issueUrl}/comments`, token, {
			method: 'POST',
			body: JSON.stringify({ body: actions.comment }),
		});
	}

	console.log(`Issue #${issueNumber} Cases guard actions: ${JSON.stringify(actions)}`);
	return actions;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
	main().catch((error) => {
		console.error(`::error title=Issue Cases guard::${String(error.message ?? error)}`);
		process.exitCode = 1;
	});
}
