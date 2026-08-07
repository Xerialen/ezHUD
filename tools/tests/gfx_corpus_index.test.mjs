import test from 'node:test';
import assert from 'node:assert/strict';

import {
	classifyZip,
	detectDuplicates,
	categoryName,
	KNOWN_CATEGORIES,
} from '../ci/gfx_corpus_index.mjs';

// --- classifyZip: pure classification ---

test('HUD numbers are identified by num/anum prefix', () => {
	const cat = classifyZip(['num_0.tga', 'num_1.tga', 'anum_0.png']);
	assert.equal(cat, 'hud-numbers');
});

test('HUD status bar is identified by sb/face/inv prefixes', () => {
	assert.equal(classifyZip(['sb_health.tga', 'face1.png']), 'hud-statusbar');
	assert.equal(classifyZip(['inv2_shotgun.png', 'inva1_rocket.png']), 'hud-statusbar');
});

test('Charset is identified by charset prefix', () => {
	assert.equal(classifyZip(['charset_04.png', 'readme.txt']), 'hud-charset');
});

test('Console background is identified by conback prefix', () => {
	assert.equal(classifyZip(['conback1.png']), 'hud-conback');
	assert.equal(classifyZip(['conback.tga']), 'hud-conback');
});

test('Crosshair is identified by crosshair or cr8 prefix', () => {
	assert.equal(classifyZip(['crosshair1.tga']), 'hud-crosshair');
	assert.equal(classifyZip(['cr8_1.png']), 'hud-crosshair');
});

test('HUD misc is identified by #-prefixed or teleport files', () => {
	assert.equal(classifyZip(['#teleport.tga']), 'hud-misc');
	assert.equal(classifyZip(['#health.png', '#armor.png']), 'hud-misc');
});

test('Deurk HUD pack is identified by deurk-hud directory', () => {
	assert.equal(classifyZip(['deurk-hud/conback.png', 'deurk-hud/charset.png']), 'hud-deurk');
});

test('Weapon skins are identified by v_ prefix', () => {
	assert.equal(classifyZip(['v_shot.tga', 'v_rock.mdl']), 'weapon-skins');
	assert.equal(classifyZip(['v_railgun.png']), 'weapon-skins');
});

test('Player skins with player model textures', () => {
	assert.equal(classifyZip(['player/plague_v_rock_0.png']), 'player-skins');
});

test('Models category for mdl/bsp files', () => {
	assert.equal(classifyZip(['candle.mdl', 'candle.bsp']), 'models');
});

test('Sounds category for wav files', () => {
	assert.equal(classifyZip(['turret.wav', 'alarm.wav']), 'sounds');
});

test('WAD category for wad directory', () => {
	assert.equal(classifyZip(['wad/gfx.wad', 'wad/something.wad']), 'wad');
});

test('World textures identified by texture patterns without other signals', () => {
	assert.equal(classifyZip(['metal1_2.tga', 'city5_4.png']), 'world-textures');
});

test('Map textures identified by map-prefix directory', () => {
	assert.equal(classifyZip(['dm2/metal1.tga']), 'map-textures');
	assert.equal(classifyZip(['e1m2/floor1.png']), 'map-textures');
});

test('Specific signals win over generic — charset beats world-textures', () => {
	// First-match: charset fires before world-textures fallback.
	assert.equal(classifyZip([
		'charset_04.png',
		'metal1.tga', 'metal2.tga', 'city5.tga', 'floor1.tga', 'wall1.tga',
	]), 'hud-charset');
});

test('Unknown content falls to other', () => {
	assert.equal(classifyZip(['readme.txt', 'install.cfg']), 'other');
	assert.equal(classifyZip([]), 'other');
});

test('Non-gfx entries (php, git, etc.) are classified as non-gfx', () => {
	assert.equal(classifyZip(['index.php', 'style.css']), 'other');
});

// --- detectDuplicates ---

test('identical zip contents are detected as duplicates', () => {
	const entries = {
		100: [{ name: 'a.tga', size: 100 }, { name: 'b.png', size: 200 }],
		200: [{ name: 'a.tga', size: 100 }, { name: 'b.png', size: 200 }],
	};
	const dups = detectDuplicates(entries);
	assert.equal(dups.length, 1);
	assert.deepEqual(dups[0].ids.sort(), ['100', '200']);
});

test('different filenames are not duplicates', () => {
	const entries = {
		100: [{ name: 'a.tga', size: 100 }],
		200: [{ name: 'b.tga', size: 100 }],
	};
	assert.equal(detectDuplicates(entries).length, 0);
});

test('same names but different sizes are not exact duplicates', () => {
	const entries = {
		100: [{ name: 'a.tga', size: 100 }],
		200: [{ name: 'a.tga', size: 200 }],
	};
	assert.equal(detectDuplicates(entries).length, 0);
});

// --- categoryName ---

test('every known category has a human-readable name', () => {
	for (const cat of KNOWN_CATEGORIES) {
		const name = categoryName(cat);
		assert.equal(typeof name, 'string');
		assert.ok(name.length > 0, `category ${cat} has empty name`);
	}
});
