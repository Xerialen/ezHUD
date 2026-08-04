#!/usr/bin/env node
// PR Cases gate. Matching is deliberately structural and forgiving:
//
//   issue reference: /(?:^|[^\w])#(\d+)\b/g
//   Cases heading:   /^##[ \t]+Cases[ \t]*$/im
//   case mapping:    /^\s*(?:case\s+\d+\s*:\s*\S.*|(?:[-*+]|\d+[.)])\s+.*\bcase\s+\d+\b.*\b(?:tier|test)\b.*)$/im
//   untested reason: /^\s*(?:[-*+]\s*)?untested\s*:\s*\S.*$/im
//
// The gate checks that the convention's pieces exist; it does not try to
// understand prose, prove that every issue case was mapped, or judge reasons.

import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const ISSUE_REFERENCE_RE = /(?:^|[^\w])#(\d+)\b/g;
export const CASES_HEADING_RE = /^##[ \t]+Cases[ \t]*$/im;
export const CASE_MAPPING_RE = /^\s*(?:case\s+\d+\s*:\s*\S.*|(?:[-*+]|\d+[.)])\s+.*\bcase\s+\d+\b.*\b(?:tier|test)\b.*)$/im;
export const UNTESTED_RE = /^\s*(?:[-*+]\s*)?untested\s*:\s*\S.*$/im;

const CONVENTION = 'Every behaviour issue must contain a "## Cases" section, and the implementing '
	+ 'PR must map a case to a tier/test or say "untested: <reason>" '
	+ '(docs/TESTING.md, "Test-plan convention").';

const MAPPING_TEMPLATE = [
	'case 1: tier 4F case <n> — <test reference>',
	'untested: <reason>',
].join('\n');

export function referencedIssues(body = '') {
	const numbers = [];
	const seen = new Set();
	for (const match of String(body).matchAll(ISSUE_REFERENCE_RE)) {
		const number = Number(match[1]);
		if (!seen.has(number)) {
			seen.add(number);
			numbers.push(number);
		}
	}
	return numbers;
}

function labelNames(labels) {
	return (Array.isArray(labels) ? labels : [])
		.map((label) => typeof label === 'string' ? label : label?.name)
		.filter(Boolean);
}

/**
 * Pure gate decision. `issueBodies` is an object keyed by issue number; main()
 * is solely responsible for filling it from GitHub (or the dry fixture env).
 */
export function decideCasesGate({ prBody = '', labels = [], issueBodies = {} } = {}) {
	if (labelNames(labels).includes('no-cases')) {
		return {
			pass: true,
			message: 'no-cases label present; Cases convention skipped for this docs/refactor/test-only PR.',
		};
	}

	const issueNumbers = referencedIssues(prBody);
	if (issueNumbers.length === 0) {
		return {
			pass: false,
			message: `PR body references no issue (#N or closes syntax). ${CONVENTION}`,
		};
	}

	const issueWithCases = issueNumbers.find((number) =>
		CASES_HEADING_RE.test(String(issueBodies[number] ?? '')));
	if (!issueWithCases) {
		return {
			pass: false,
			message: `None of the referenced issues (${issueNumbers.map((n) => `#${n}`).join(', ')}) `
				+ `contains a "## Cases" heading. ${CONVENTION}`,
		};
	}

	if (!CASE_MAPPING_RE.test(String(prBody)) && !UNTESTED_RE.test(String(prBody))) {
		return {
			pass: false,
			message: `PR body has no case mapping. Add at least one line in this shape:\n\n${MAPPING_TEMPLATE}`,
		};
	}

	return {
		pass: true,
		message: `Cases convention satisfied via issue #${issueWithCases} and a PR case mapping.`,
	};
}

function parseLabels(raw = '[]') {
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return String(raw).split(',').map((label) => label.trim()).filter(Boolean);
	}
}

async function fetchIssueBodies(repo, issueNumbers, token) {
	const bodies = {};
	for (const number of issueNumbers) {
		const response = await fetch(`https://api.github.com/repos/${repo}/issues/${number}`, {
			headers: {
				accept: 'application/vnd.github+json',
				authorization: `Bearer ${token}`,
				'x-github-api-version': '2022-11-28',
			},
		});
		if (!response.ok) {
			throw new Error(`GitHub API returned ${response.status} for referenced issue #${number}`);
		}
		const issue = await response.json();
		bodies[number] = issue.body ?? '';
	}
	return bodies;
}

export async function main(env = process.env) {
	const prBody = env.PR_BODY ?? '';
	const labels = parseLabels(env.PR_LABELS);
	const issueNumbers = referencedIssues(prBody);
	let issueBodies = {};

	if (!labelNames(labels).includes('no-cases') && issueNumbers.length > 0) {
		if (env.CASES_GATE_ISSUE_BODIES != null) {
			issueBodies = JSON.parse(env.CASES_GATE_ISSUE_BODIES);
		} else {
			if (!env.REPO || !env.GITHUB_TOKEN) {
				throw new Error('REPO and GITHUB_TOKEN are required when no dry issue-body fixture is supplied');
			}
			issueBodies = await fetchIssueBodies(env.REPO, issueNumbers, env.GITHUB_TOKEN);
		}
	}

	const decision = decideCasesGate({ prBody, labels, issueBodies });
	const annotation = decision.pass ? 'notice' : 'error';
	console.log(`::${annotation} title=Cases gate::${decision.message.replaceAll('\n', '%0A')}`);
	console.log(decision.message);
	return decision;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
	main().then((decision) => {
		if (!decision.pass) {
			process.exitCode = 1;
		}
	}).catch((error) => {
		console.error(`::error title=Cases gate::${String(error.message ?? error)}`);
		console.error(`Cases gate could not evaluate this PR: ${String(error.message ?? error)}`);
		process.exitCode = 1;
	});
}
