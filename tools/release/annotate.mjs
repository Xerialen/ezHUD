#!/usr/bin/env node
// Ring changed controls in focused Release 1 captures. The source is embedded
// as data and never written; Playwright screenshots an exact-size SVG overlay
// into the separate output declared by annotations.json.
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const releaseDir = path.join(repo, 'docs/release-1');
const manifest = JSON.parse(await readFile(path.join(releaseDir, 'annotations.json'), 'utf8'));
const RING_PADDING = 6;
const LIGHT = '#fffaf2';
const DARK = '#11100f';

function pngDimensions(bytes, label) {
	const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
	assert(bytes.subarray(0, 8).equals(signature), `${label} is not a PNG`);
	assert.equal(bytes.toString('ascii', 12, 16), 'IHDR', `${label} has no leading IHDR`);
	return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function releasePath(rel, label) {
	assert.equal(typeof rel, 'string', `${label} must be a string`);
	const resolved = path.resolve(releaseDir, rel);
	assert(resolved.startsWith(`${releaseDir}${path.sep}`), `${label} escapes docs/release-1`);
	return resolved;
}

function ringRect(target) {
	return {
		x: target.x - RING_PADDING,
		y: target.y - RING_PADDING,
		w: target.w + 2 * RING_PADDING,
		h: target.h + 2 * RING_PADDING,
	};
}

function calloutSvg(callout, accent) {
	const ring = ringRect(callout.target);
	const rx = Math.min(9, ring.h / 2);
	const common = `x="${ring.x}" y="${ring.y}" width="${ring.w}" height="${ring.h}" rx="${rx}" fill="none"`;
	const badgeX = ring.x >= 18 ? ring.x - 9 : ring.x + ring.w + 9;
	const badgeY = ring.y + ring.h / 2;
	// The 5px light stroke under the 3px accent leaves a visible 1px light
	// hairline on both sides. The only other mark is the optional small badge.
	return `<g aria-label="Callout ${callout.badge}">\n`
		+ `<rect ${common} stroke="${LIGHT}" stroke-width="5"/>\n`
		+ `<rect ${common} stroke="${accent}" stroke-width="3"/>\n`
		+ `<circle cx="${badgeX}" cy="${badgeY}" r="8" fill="${accent}" stroke="${LIGHT}" stroke-width="1"/>\n`
		+ `<text x="${badgeX}" y="${badgeY + 4}" text-anchor="middle" fill="${DARK}" font-family="monospace" font-size="11" font-weight="800">${callout.badge}</text>\n`
		+ '</g>';
}

function documentHtml(asset, sourceBytes, size) {
	const sourceHref = `data:image/png;base64,${sourceBytes.toString('base64')}`;
	const overlays = asset.callouts.map((callout) => calloutSvg(callout, asset.accent));
	return `<!doctype html>
<html><head><meta charset="utf-8"><style>
html, body { margin: 0; width: ${size.width}px; height: ${size.height}px; overflow: hidden; background: #000; }
#frame { position: relative; width: ${size.width}px; height: ${size.height}px; overflow: hidden; }
#source, svg { position: absolute; inset: 0; display: block; width: ${size.width}px; height: ${size.height}px; }
</style></head><body><div id="frame">
<img id="source" src="${sourceHref}" width="${size.width}" height="${size.height}" alt="">
<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="0 0 ${size.width} ${size.height}" role="img">
${overlays.join('\n')}
</svg></div></body></html>`;
}

assert.equal(manifest.version, 1, 'annotation manifest version must be 1');
assert(Array.isArray(manifest.assets) && manifest.assets.length > 0, 'manifest.assets must be non-empty');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
	for (const asset of manifest.assets) {
		assert(Array.isArray(asset.callouts) && asset.callouts.length > 0 && asset.callouts.length <= 2,
			`${asset.id}: expected one or two callouts`);
		for (const callout of asset.callouts) {
			assert.deepEqual(Object.keys(callout).sort(), ['badge', 'target'],
				`${asset.id}: callouts may contain only badge and target`);
		}
		const sourcePath = releasePath(asset.source, `${asset.id}.source`);
		const outputPath = releasePath(asset.output, `${asset.id}.output`);
		assert.notEqual(sourcePath, outputPath, `${asset.id}: output would overwrite source`);
		const sourceBytes = await readFile(sourcePath);
		const size = pngDimensions(sourceBytes, asset.source);
		const context = await browser.newContext({ viewport: size, deviceScaleFactor: 1, colorScheme: 'dark' });
		const page = await context.newPage();
		await page.setContent(documentHtml(asset, sourceBytes, size), { waitUntil: 'load' });
		await page.evaluate(async () => {
			await document.fonts.ready;
			await Promise.all([...document.images].map((image) => image.complete
				? Promise.resolve()
				: new Promise((resolve, reject) => {
					image.addEventListener('load', resolve, { once: true });
					image.addEventListener('error', reject, { once: true });
				})));
		});
		await mkdir(path.dirname(outputPath), { recursive: true });
		await page.locator('#frame').screenshot({ path: outputPath, type: 'png', animations: 'disabled' });
		await context.close();
		const outputSize = pngDimensions(await readFile(outputPath), asset.output);
		assert.deepEqual(outputSize, size, `${asset.id}: generated dimensions differ from source`);
		console.log(`annotate: ${asset.output} (${size.width}x${size.height}, ${asset.callouts.length} callout)`);
	}
} finally {
	await browser.close();
}
