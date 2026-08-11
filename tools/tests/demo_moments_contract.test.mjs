import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const adapter = readFileSync(path.join(repo, 'hud_web_ui/core/fte-adapter.js'), 'utf8');
const nativeBridge = readFileSync(path.join(repo, 'engine/src/hud_web.c'), 'utf8');
const html = readFileSync(path.join(repo, 'hud_web_ui/index-fte.html'), 'utf8');

function quotedNames(block) {
	return [...block.matchAll(/["']([a-z][a-z0-9_]*)["']/g)].map((match) => match[1]);
}

function block(source, pattern, label) {
	const match = pattern.exec(source);
	assert(match, `${label} declaration not found`);
	return match[1];
}

test('the FTE and native bare-command allowlists agree and both admit demo_jump', () => {
	const fte = quotedNames(block(adapter,
		/const BARE_COMMANDS = new Set\(\[([\s\S]*?)\]\);/,
		'FTE BARE_COMMANDS'));
	const native = quotedNames(block(nativeBridge,
		/static const char \*commands\[\] = \{([\s\S]*?)\n\t\};/,
		'native commands'));

	assert(fte.includes('demo_jump'), 'FTE allowlist is missing demo_jump');
	assert(native.includes('demo_jump'), 'native allowlist is missing demo_jump');
	assert.deepEqual([...fte].sort(), [...native].sort(),
		'bare-command allowlists drifted between the two backends');
});

test('the bundled match exposes the three reviewed Jump to points', () => {
	const attribute = (source, name) =>
		new RegExp(`${name}="([^"]+)"`).exec(source)?.[1] ?? null;
	const group = /<div\b([^>]*\bid="fte-moments"[^>]*)>([\s\S]*?)<\/div>/.exec(html);
	assert(group, 'Jump to control group not found');
	assert.equal(attribute(group[1], 'aria-label'), 'Jump to');
	assert.match(group[2], /<span>\s*Jump to\s*<\/span>/);
	const controls = [...group[2].matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
		.filter((match) => attribute(match[1], 'data-demo-jump'))
		.map((match) => ({
			id: attribute(match[1], 'id'),
			demo: attribute(match[1], 'data-demo-path'),
			target: attribute(match[1], 'data-demo-jump'),
			label: match[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
		}));
	assert.deepEqual(controls, [
		{ id: 'fte-moment-prewar', demo: 'qw/demos/tb4gf_book_vs_s.mvd', target: '0:00', label: 'Prewar' },
		{ id: 'fte-moment-ten-minutes', demo: 'qw/demos/tb4gf_book_vs_s.mvd', target: '10:00', label: '10:00' },
		{ id: 'fte-moment-scoreboard', demo: 'qw/demos/tb4gf_book_vs_s.mvd', target: '20:10', label: 'Scoreboard' },
	]);
});
