import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function dragAssistContract(html, host) {
	const section = html.match(/<div id="drag-assist"[\s\S]*?<\/section>/)?.[0] ?? '';
	assert.ok(section, `${host} has no drag-assistance section`);
	assert.match(html,
		/<p class="drag-assist__live" id="drag-assist-live" role="status" aria-atomic="true" hidden><\/p>/,
		`${host} has no live-stage drag instruction`);
	assert.match(section, /<h3 class="group__title">Grid &amp; snap<\/h3>/,
		`${host} does not name the section for someone looking for Grid`);
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

test('both host labels name the only modifier that bypasses drag assistance', async () => {
	const [app, browserHost, fteHost] = await Promise.all([
		readFile(path.join(repo, 'hud_web_ui/view/app.js'), 'utf8'),
		readFile(path.join(repo, 'hud_web_ui/index.html'), 'utf8'),
		readFile(path.join(repo, 'hud_web_ui/index-fte.html'), 'utf8'),
	]);

	const browserModifier = dragAssistContract(browserHost, 'index.html');
	const fteModifier = dragAssistContract(fteHost, 'index-fte.html');
	assert.equal(browserModifier, fteModifier,
		'the browser and FTE hosts document different bypass modifiers');
	assert.equal(browserModifier, 'Shift');
	const eventProperty = `${browserModifier.toLowerCase()}Key`;
	assert.match(app, new RegExp(`const bypass = e\\.${eventProperty};`),
		`app.js does not use the ${browserModifier} key named by both host labels`);
	assert.doesNotMatch(app, /\be\.altKey\b/,
		'Alt remains an undocumented drag-assistance bypass');
});
