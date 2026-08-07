#!/usr/bin/env node
// Graphics corpus indexer. Reads the gfx.tar.gz tarball (flat files/<id>.zip +
// files/<id>.jpg + files/<id>_thumb.jpg), classifies every zip by its internal
// filenames, detects exact duplicates, and writes a JSON index.
//
// Usage:
//   node tools/ci/gfx_corpus_index.mjs <path-to-gfx.tar.gz>
//
// The index is written to stdout; redirect to a checked-in JSON file.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { createReadStream } from 'node:fs';

// --- Constants --------------------------------------------------------------

export const KNOWN_CATEGORIES = [
	'hud-numbers',
	'hud-statusbar',
	'hud-charset',
	'hud-conback',
	'hud-crosshair',
	'hud-misc',
	'hud-config',
	'hud-deurk',
	'weapon-skins',
	'player-skins',
	'model-skins',
	'world-textures',
	'map-textures',
	'sounds',
	'models',
	'wad',
	'effects',
	'other',
];

const CATEGORY_NAMES = {
	'hud-numbers':     'HUD number fonts (num_ / anum_)',
	'hud-statusbar':   'HUD status bar (sb_ / face_ / inv_*)',
	'hud-charset':     'Character sets (charset_)',
	'hud-conback':     'Console backgrounds (conback)',
	'hud-crosshair':   'Crosshairs',
	'hud-misc':        'Other HUD elements (#-prefixed, teleport, etc.)',
	'hud-config':      'HUD configuration presets (.cfg)',
	'hud-deurk':       'Deurk HUD pack',
	'weapon-skins':    'Weapon model skins (v_*)',
	'player-skins':    'Player model skins',
	'model-skins':     'Other model skins',
	'world-textures':  'World textures (generic)',
	'map-textures':    'Map-specific textures',
	'sounds':          'Sound files (wav)',
	'models':          '3D models (mdl / bsp)',
	'wad':             'WAD-format texture packs',
	'effects':         'Particle / sprite effects',
	'other':           'Unclassified or mixed content',
};

// --- Classification ---------------------------------------------------------

const CATEGORY_SIGNALS = [
	// Order matters: first match wins. Directory-based signals come first
	// because they are more specific than basename-only patterns.

	// --- Directory-based signals (check full path) ---
	{
		category: 'hud-deurk',
		check: (fullPaths) => fullPaths.some((n) => n.toLowerCase().startsWith('deurk-hud')),
	},
	{
		category: 'player-skins',
		check: (fullPaths) => fullPaths.some((n) => n.toLowerCase().startsWith('player/')),
	},
	{
		category: 'wad',
		check: (fullPaths, basenames) => fullPaths.some((n) => n.startsWith('wad/'))
			|| basenames.some((n) => n.endsWith('.wad')),
	},
	{
		category: 'map-textures',
		check: (fullPaths) => fullPaths.some((n) => {
			const lower = n.toLowerCase();
			return lower.match(/^(dm\d|e\dm\d|aero|ztndm|tremor|ztn|qw|fortress|italy|shifter|niamey)\//);
		}),
	},

	// --- Basename-based signals ---
	{
		category: 'hud-numbers',
		check: (_, basenames) => basenames.some((n) => n.match(/^(anum?[_\d]|num[_\d])/i)),
	},
	{
		category: 'hud-statusbar',
		check: (_, basenames) => basenames.some((n) => n.match(/^(sb_|face\d|inv\w*\d)/i)),
	},
	{
		category: 'hud-charset',
		check: (_, basenames) => basenames.some((n) => /charset/i.test(n)),
	},
	{
		category: 'hud-conback',
		check: (_, basenames) => basenames.some((n) => n.match(/^conback/i)),
	},
	{
		category: 'hud-crosshair',
		check: (_, basenames) => basenames.some((n) => n.match(/^(crosshair|cr8[_\d])/i)),
	},
	{
		category: 'hud-misc',
		check: (_, basenames) => basenames.some((n) => n.startsWith('#')),
	},
	{
		category: 'weapon-skins',
		check: (_, basenames) => basenames.some((n) => n.match(/^v_[a-z]/i)),
	},
	{
		category: 'models',
		check: (_, basenames) => basenames.some((n) => n.match(/\.(mdl|bsp)$/i)),
	},
	{
		category: 'sounds',
		check: (_, basenames) => basenames.some((n) => n.match(/\.wav$/i)),
	},
	{
		category: 'effects',
		check: (_, basenames) => basenames.some((n) => n.match(/\.spr$/i) || n.match(/^(particle|spark|smoke|flame|explo)/i)),
	},
];

/**
 * Classify a zip by its internal filenames. Returns the most specific
 * category that matches. If no signal matches, returns 'world-textures'
 * when image files dominate, otherwise 'other'.
 */
export function classifyZip(names) {
	if (!Array.isArray(names) || names.length === 0) return 'other';

	const fullPaths = names.map((n) => n.replace(/\\/g, '/').toLowerCase());
	const basenames = fullPaths.map((n) => {
		const parts = n.split('/');
		return parts[parts.length - 1];
	});

	// Check each signal. First match wins.
	for (const { category, check } of CATEGORY_SIGNALS) {
		if (check(fullPaths, basenames)) return category;
	}

	// Fallback: skip directory entries (end with /) and check if image files dominate.
	const filePaths = fullPaths.filter((n) => !n.endsWith('/'));
	const imageExts = /\.(png|tga|jpg|jpeg|pcx|bmp|gif)$/i;
	const imageCount = filePaths.filter((n) => imageExts.test(n)).length;
	if (filePaths.length > 0 && imageCount > filePaths.length / 2) return 'world-textures';

	// Config files: .cfg-only zips are HUD presets.
	if (filePaths.length > 0 && filePaths.every((n) => n.endsWith('.cfg'))) return 'hud-config';

	return 'other';
}

// --- Duplicate detection ----------------------------------------------------

/**
 * Group zip IDs that have identical content (same filenames, same sizes).
 * Returns an array of duplicate groups, each with .ids and .fingerprint.
 */
export function detectDuplicates(zipEntries) {
	// zipEntries: { [id]: [{ name, size }, ...] }
	const seen = new Map(); // fingerprint → { ids: [], fingerprint }
	const groups = [];

	for (const [id, entries] of Object.entries(zipEntries)) {
		if (!Array.isArray(entries) || entries.length === 0) continue;
		const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
		const fp = sorted.map((e) => `${e.name}::${e.size}`).join('\n');
		const existing = seen.get(fp);
		if (existing) {
			existing.ids.push(id);
		} else {
			const group = { ids: [id], fingerprint: fp };
			seen.set(fp, group);
			groups.push(group);
		}
	}

	return groups.filter((g) => g.ids.length > 1);
}

// --- Human-readable names ---------------------------------------------------

export function categoryName(cat) {
	return CATEGORY_NAMES[cat] ?? cat;
}

// --- Main: read tarball, produce index --------------------------------------

export async function main(tarballPath) {
	const absPath = path.resolve(tarballPath);
	if (!fs.existsSync(absPath)) {
		throw new Error(`tarball not found: ${absPath}`);
	}

	// List tarball contents.
	const listing = execSync(`tar tzf ${JSON.stringify(absPath)}`, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
	const lines = listing.trim().split('\n').filter(Boolean);

	const zipIds = [];
	const previewFiles = []; // { id, type: 'preview'|'thumb' }
	const nonGfxFiles = [];
	let totalTarballEntries = 0;

	for (const line of lines) {
		totalTarballEntries++;
		const trimmed = line.trim();
		if (!trimmed || trimmed === 'files/' || trimmed === 'files') continue;

		const relative = trimmed.startsWith('files/') ? trimmed.slice(6) : trimmed;
		if (!relative) continue;

		const zipMatch = relative.match(/^(\d+)\.zip$/);
		if (zipMatch) {
			zipIds.push(zipMatch[1]);
			continue;
		}

		const thumbMatch = relative.match(/^(\d+)_thumb\.jpg$/);
		if (thumbMatch) {
			previewFiles.push({ id: thumbMatch[1], type: 'thumb' });
			continue;
		}

		const jpgMatch = relative.match(/^(\d+)\.jpg$/);
		if (jpgMatch) {
			previewFiles.push({ id: jpgMatch[1], type: 'preview' });
			continue;
		}

		// Non-gfx files (php, git metadata, css, etc.)
		nonGfxFiles.push(relative);
	}

	// Extract zip listings.
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gfx-index-'));
	const zipEntries = {};

	try {
		// Extract all zips at once.
		const fileList = zipIds.map((id) => `files/${id}.zip`).join('\n');
		execSync(`tar xzf ${JSON.stringify(absPath)} -C ${JSON.stringify(tmpDir)}`, {
			input: fileList,
			encoding: 'utf-8',
			maxBuffer: 100 * 1024 * 1024,
			timeout: 120000,
		});

		// Read each zip's contents.
		for (const id of zipIds) {
			const zipPath = path.join(tmpDir, 'files', `${id}.zip`);
			if (!fs.existsSync(zipPath)) continue;
			try {
				const listing = execSync(`unzip -l ${JSON.stringify(zipPath)}`, {
					encoding: 'utf-8',
					maxBuffer: 10 * 1024 * 1024,
				});
				// Parse unzip -l output. Lines look like:
				//    Length   Date   Time   Name
				//    ------   ----   ----   ----
				//     12345  01-01-2000 00:00   filename.png
				const parsed = [];
				const entryLines = listing.split('\n');
				let inList = false;
				for (const entryLine of entryLines) {
					if (entryLine.startsWith('---')) { inList = true; continue; }
					if (!inList) continue;
					const match = entryLine.match(/^\s*(\d+)\s+[\d-]+\s+[\d:]+\s+(.+)$/);
					if (match) {
						parsed.push({ name: match[2].trim(), size: Number(match[1]) });
					}
				}
				// Last line is "---  N files" — remove final summary lines
				const summaryIdx = parsed.findIndex((e) => e.name.includes('file'));
				zipEntries[id] = summaryIdx >= 0 ? parsed.slice(0, summaryIdx) : parsed;
			} catch {
				// Corrupt or unreadable zip — record as empty.
				zipEntries[id] = [];
			}
		}
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}

	// Build index.
	const byCategory = {};
	for (const cat of KNOWN_CATEGORIES) {
		byCategory[cat] = { count: 0, ids: [] };
	}

	const unclassified = [];
	const empty = [];

	for (const id of zipIds) {
		const entries = zipEntries[id] ?? [];
		if (!Array.isArray(entries) || entries.length === 0) {
			empty.push(id);
			byCategory.other.count++;
			byCategory.other.ids.push(id);
			continue;
		}
		const names = entries.map((e) => e.name);
		const cat = classifyZip(names);
		byCategory[cat].count++;
		byCategory[cat].ids.push(id);
	}

	const duplicates = detectDuplicates(zipEntries);

	// Build preview map.
	const previews = {};
	for (const pf of previewFiles) {
		if (!previews[pf.id]) previews[pf.id] = {};
		previews[pf.id][pf.type] = true;
	}

	// Format info.
	const formatCounts = {};
	for (const [id, entries] of Object.entries(zipEntries)) {
		for (const entry of entries) {
			const ext = path.extname(entry.name).toLowerCase().slice(1) || '(none)';
			formatCounts[ext] = (formatCounts[ext] ?? 0) + 1;
		}
	}

	// Build output.
	const entriesWithPreviews = Object.keys(previews).length;
	const index = {
		generated: new Date().toISOString(),
		tarball: path.basename(absPath),
		summary: {
			totalTarballEntries: totalTarballEntries,
			totalZips: zipIds.length,
			zipsWithContent: zipIds.length - empty.length,
			emptyZips: empty.length,
			zipsWithPreview: entriesWithPreviews,
			nonGfxTarballFiles: nonGfxFiles.length,
			duplicateGroups: duplicates.length,
			duplicateZipCount: duplicates.reduce((sum, g) => sum + g.ids.length - 1, 0),
		},
		categories: {},
		formats: formatCounts,
		duplicates: duplicates.map((g) => ({
			ids: g.ids.sort((a, b) => Number(a) - Number(b)),
		})),
		nonGfxFiles: nonGfxFiles.slice(0, 100), // cap at 100 for readability
	};

	for (const [cat, info] of Object.entries(byCategory)) {
		index.categories[cat] = {
			name: categoryName(cat),
			count: info.count,
			ids: info.ids.sort((a, b) => Number(a) - Number(b)),
		};
	}

	return index;
}

// --- CLI entry point --------------------------------------------------------

const invokedPath = process.argv[1] ? new URL(import.meta.url).pathname : null;
const realPath = process.argv[1] ? process.argv[1] : null;
if (invokedPath === realPath || (realPath && realPath.endsWith('gfx_corpus_index.mjs'))) {
	const tarballPath = process.argv[2];
	if (!tarballPath) {
		console.error('Usage: node tools/ci/gfx_corpus_index.mjs <path-to-gfx.tar.gz>');
		process.exit(2);
	}
	main(tarballPath).then((index) => {
		console.log(JSON.stringify(index, null, '\t'));
	}).catch((error) => {
		console.error(error.message);
		process.exit(1);
	});
}
