import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function dragAssistContract(html, host, panelName) {
	const section = html.match(/<div id="drag-assist"[\s\S]*?<\/section>/)?.[0] ?? '';
	assert.ok(section, `${host} has no drag-assistance section`);
	assert.match(html,
		/<p class="drag-assist__live" id="drag-assist-live" role="status" aria-atomic="true" hidden><\/p>/,
		`${host} has no live-stage drag instruction`);
	assert.match(section, new RegExp(`<h3 class="group__title">${panelName}</h3>`),
		`${host} does not name the section what the changedrop narration calls it ("${panelName}")`);
	assert.match(section,
		/<label class="toggle toggle--sm" title="Snap dragged elements to a fixed grid\."><input type="checkbox" id="snap-grid">/,
		`${host} gives Grid no hover explanation`);
	assert.match(section,
		/<label class="toggle toggle--sm" title="Snap dragged elements to nearby HUD and screen edges\."><input type="checkbox" id="snap-magnet">/,
		`${host} gives Magnet no hover explanation`);
	const match = section.match(/<p class="font-state">Hold ([A-Za-z]+) while dragging to bypass both\.<\/p>/);
	assert.ok(match, `${host} has no drag-assistance bypass instruction`);
	return match[1];
}

// The panel heading and the changedrop film narration have drifted apart
// before: #102 renamed the on-screen heading "Drag assistance" -> "Grid &
// snap" and nobody updated (or even could update, since it is spoken audio)
// the recorded narration, which still calls the surface "drag assistance"
// twice in its walkthrough copy. That produced a film where the voice names
// one thing and the screen names another. This test derives the *required*
// heading text from the narration script itself, rather than hardcoding a
// second literal that the heading could drift from again — a one-sided
// rename to either side now fails here instead of shipping to video.
test('the drag-assist panel heading is named what the changedrop narration calls it', async () => {
	const script = JSON.parse(
		await readFile(path.join(repo, 'docs/release-2/changedrop-script.json'), 'utf8'));
	const segment = script.treatments.find((entry) => entry.surface === 'drag-assist');
	assert.ok(segment, 'changedrop script has no drag-assist surface entry');
	const namedMentions = segment.walkthrough
		.map((step) => step.instruction)
		.filter((instruction) => /\bdrag assistance\b/i.test(instruction));
	assert.equal(namedMentions.length, 2,
		'changedrop walkthrough for drag-assist must name "drag assistance" exactly twice; ' +
		'if the script changed on purpose, update this count deliberately rather than letting it drift');
	const phrases = [...new Set(namedMentions.map((instruction) => /drag assistance/i.exec(instruction)[0]))];
	assert.equal(phrases.length, 1,
		'changedrop walkthrough names the drag-assist surface inconsistently across its two mentions');
	const panelName = phrases[0].replace(/^./, (c) => c.toUpperCase());

	const [app, browserHost, fteHost] = await Promise.all([
		readFile(path.join(repo, 'hud_web_ui/view/app.js'), 'utf8'),
		readFile(path.join(repo, 'hud_web_ui/index.html'), 'utf8'),
		readFile(path.join(repo, 'hud_web_ui/index-fte.html'), 'utf8'),
	]);

	const browserModifier = dragAssistContract(browserHost, 'index.html', panelName);
	const fteModifier = dragAssistContract(fteHost, 'index-fte.html', panelName);
	assert.equal(browserModifier, fteModifier,
		'the browser and FTE hosts document different bypass modifiers');
	assert.equal(browserModifier, 'Shift');
	const eventProperty = `${browserModifier.toLowerCase()}Key`;
	assert.match(app, new RegExp(`const bypass = e\\.${eventProperty};`),
		`app.js does not use the ${browserModifier} key named by both host labels`);
	assert.doesNotMatch(app, /\be\.altKey\b/,
		'Alt remains an undocumented drag-assistance bypass');
});
