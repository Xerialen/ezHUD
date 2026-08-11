import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const uiDir = path.join(repo, 'hud_web_ui');
const embedTool = readFileSync(path.join(repo, 'engine/tools/embed_hud_web_ui.py'), 'utf8');

function importedModules(source) {
	const specifiers = [];
	const staticImports = /\b(?:import|export)\s+(?:[^;]*?\s+from\s+)?["']([^"']+)["']/g;
	const dynamicImports = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
	for (const pattern of [staticImports, dynamicImports]) {
		for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
	}
	return specifiers;
}

function embeddedSources(source) {
	const declaration = source.match(/SOURCES\s*=\s*\[([\s\S]*?)\n\]/);
	assert(declaration, 'embed_hud_web_ui.py SOURCES declaration not found');
	return new Set(
		[...declaration[1].matchAll(/["']([^"']+)["']/g)]
			.map((match) => match[1]),
	);
}

test('every transitive UI module dependency is embedded for the native editor', () => {
	const embedded = embeddedSources(embedTool);
	const visited = new Set();
	const pending = [...embedded].filter((source) => source.endsWith('.js'));
	const missing = new Set();

	while (pending.length) {
		const source = pending.pop();
		if (visited.has(source)) continue;
		visited.add(source);
		const contents = readFileSync(path.join(uiDir, source), 'utf8');
		for (const specifier of importedModules(contents)) {
			if (!specifier.startsWith('.')) continue;
			const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(source), specifier));
			assert(!dependency.startsWith('../'), `${source} imports a file outside hud_web_ui/: ${specifier}`);
			if (!embedded.has(dependency)) missing.add(`${source} -> ${dependency}`);
			pending.push(dependency);
		}
	}

	assert.deepEqual([...missing], [], `module dependencies missing from SOURCES: ${[...missing].join(', ')}`);
});
