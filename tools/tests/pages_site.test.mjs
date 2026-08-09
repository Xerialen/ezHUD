import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  PUBLIC_ARTIFACT_PATHS,
  composeDev,
  composePreview,
  composeRelease,
  createManifest,
  guardArtifact,
  guardSite,
} from '../fte-web/pages-site.mjs';

async function artifact(root, label, basePath) {
  for (const relative of PUBLIC_ARTIFACT_PATHS) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    let contents = `${label}:${relative}\n`;
    if (relative === 'index.html') {
      contents = `"${basePath}core/bridge.js"\n"${basePath}core/fte-adapter.js"\n`;
    }
    await writeFile(target, contents);
  }
}

async function snapshot(root) {
  const result = new Map();
  async function walk(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = path.posix.join(prefix, entry.name);
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), relative);
      else result.set(relative, await readFile(path.join(directory, entry.name), 'hex'));
    }
  }
  await walk(root);
  return result;
}

test('publishing dev and preview B preserves the release root, dev and previews byte for byte', async () => {
  const run = await mkdtemp(path.join(os.tmpdir(), 'ezhud-pages-preserve-'));
  try {
    const initial = path.join(run, 'initial');
    const devOne = path.join(run, 'dev-one');
    const devTwo = path.join(run, 'dev-two');
    const previewA = path.join(run, 'preview-a');
    const previewB = path.join(run, 'preview-b');
    const afterDevOne = path.join(run, 'after-dev-one');
    const afterA = path.join(run, 'after-a');
    const afterB = path.join(run, 'after-b');
    const afterDevTwo = path.join(run, 'after-dev-two');
    await artifact(initial, 'release-one', '/ezHUD/');
    await createManifest(initial, { previews: [], deployment: 'release-1' });
    await artifact(devOne, 'dev-one', '/ezHUD/dev/');
    await artifact(devTwo, 'dev-two', '/ezHUD/dev/');
    await artifact(previewA, 'grid', '/ezHUD/preview/grid/');
    await artifact(previewB, 'edges', '/ezHUD/preview/edges/');

    await composeDev({ currentDir: initial, devDir: devOne, outputDir: afterDevOne,
      ref: 'dev', commit: 'd'.repeat(40), publishedAt: '2026-08-09T17:00:00Z', deployment: 'dev-one' });
    await composePreview({ currentDir: afterDevOne, previewDir: previewA, outputDir: afterA,
      name: 'grid', ref: 'feature/grid', commit: 'a'.repeat(40), publishedAt: '2026-08-09T18:00:00Z', deployment: 'run-a' });
    const rootBefore = await readFile(path.join(afterA, 'index.html'));
    const devBefore = await snapshot(path.join(afterA, 'dev'));
    const previewBefore = await snapshot(path.join(afterA, 'preview/grid'));

    await composePreview({ currentDir: afterA, previewDir: previewB, outputDir: afterB,
      name: 'edges', ref: 'feature/edges', commit: 'b'.repeat(40), publishedAt: '2026-08-09T19:00:00Z', deployment: 'run-b' });

    assert.deepEqual(await readFile(path.join(afterB, 'index.html')), rootBefore);
    assert.deepEqual(await snapshot(path.join(afterB, 'dev')), devBefore);
    assert.deepEqual(await snapshot(path.join(afterB, 'preview/grid')), previewBefore);
    assert.match(await readFile(path.join(afterB, 'preview/index.html'), 'utf8'), /preview\/grid\//);
    assert.match(await readFile(path.join(afterB, 'preview/index.html'), 'utf8'), /preview\/edges\//);
    const rootBeforeDev = await snapshot(afterB);

    await composeDev({ currentDir: afterB, devDir: devTwo, outputDir: afterDevTwo,
      ref: 'dev', commit: 'e'.repeat(40), publishedAt: '2026-08-09T20:00:00Z', deployment: 'dev-two' });

    for (const [relative, bytes] of rootBeforeDev) {
      if (relative === 'pages-manifest.json' || relative.startsWith('dev/')) continue;
      assert.equal((await readFile(path.join(afterDevTwo, relative), 'hex')), bytes, relative);
    }
    assert.equal(await readFile(path.join(afterDevTwo, 'dev/index.html'), 'utf8'),
      '"/ezHUD/dev/core/bridge.js"\n"/ezHUD/dev/core/fte-adapter.js"\n');
    assert.equal(await readFile(path.join(afterDevTwo, 'dev/core/geometry.js'), 'utf8'),
      'dev-two:core/geometry.js\n');
    await guardSite(afterDevTwo);
  } finally {
    await rm(run, { recursive: true, force: true });
  }
});

test('a release publication preserves dev and every existing preview', async () => {
  const run = await mkdtemp(path.join(os.tmpdir(), 'ezhud-pages-release-'));
  try {
    const initial = path.join(run, 'initial');
    const dev = path.join(run, 'dev');
    const previewGrid = path.join(run, 'preview-grid');
    const previewEdges = path.join(run, 'preview-edges');
    const afterDev = path.join(run, 'after-dev');
    const afterGrid = path.join(run, 'after-grid');
    const withPreviews = path.join(run, 'with-previews');
    const nextRelease = path.join(run, 'next-release');
    const output = path.join(run, 'output');
    await artifact(initial, 'release-one', '/ezHUD/');
    await createManifest(initial, { previews: [], deployment: 'release-1' });
    await artifact(dev, 'dev-one', '/ezHUD/dev/');
    await artifact(previewGrid, 'grid', '/ezHUD/preview/grid/');
    await artifact(previewEdges, 'edges', '/ezHUD/preview/edges/');
    await composeDev({ currentDir: initial, devDir: dev, outputDir: afterDev,
      ref: 'dev', commit: 'd'.repeat(40), publishedAt: '2026-08-09T17:00:00Z', deployment: 'dev-one' });
    await composePreview({ currentDir: afterDev, previewDir: previewGrid, outputDir: afterGrid,
      name: 'grid', ref: 'feature/grid', commit: 'a'.repeat(40), publishedAt: '2026-08-09T18:00:00Z', deployment: 'run-a' });
    await composePreview({ currentDir: afterGrid, previewDir: previewEdges, outputDir: withPreviews,
      name: 'edges', ref: 'feature/edges', commit: 'b'.repeat(40), publishedAt: '2026-08-09T19:00:00Z', deployment: 'run-b' });
    const devBefore = await snapshot(path.join(withPreviews, 'dev'));
    const gridBefore = await snapshot(path.join(withPreviews, 'preview/grid'));
    const edgesBefore = await snapshot(path.join(withPreviews, 'preview/edges'));
    await artifact(nextRelease, 'release-two', '/ezHUD/');

    await composeRelease({ currentDir: withPreviews, releaseDir: nextRelease, outputDir: output,
      deployment: 'release-run' });

    assert.deepEqual(await snapshot(path.join(output, 'dev')), devBefore);
    assert.deepEqual(await snapshot(path.join(output, 'preview/grid')), gridBefore);
    assert.deepEqual(await snapshot(path.join(output, 'preview/edges')), edgesBefore);
    assert.equal(await readFile(path.join(output, 'index.html'), 'utf8'),
      '"/ezHUD/core/bridge.js"\n"/ezHUD/core/fte-adapter.js"\n');
    await guardSite(output);
  } finally {
    await rm(run, { recursive: true, force: true });
  }
});

test('the preview index cannot list a preview that is not in the preserved site', async () => {
  const run = await mkdtemp(path.join(os.tmpdir(), 'ezhud-pages-index-'));
  try {
    const initial = path.join(run, 'initial');
    const preview = path.join(run, 'preview');
    const site = path.join(run, 'site');
    await artifact(initial, 'release-one', '/ezHUD/');
    await createManifest(initial, { previews: [], deployment: 'release-1' });
    await artifact(preview, 'grid', '/ezHUD/preview/grid/');
    await composePreview({ currentDir: initial, previewDir: preview, outputDir: site,
      name: 'grid', ref: 'feature/grid', commit: 'a'.repeat(40), publishedAt: '2026-08-09T18:00:00Z', deployment: 'run-a' });

    const indexPath = path.join(site, 'preview/index.html');
    const index = await readFile(indexPath, 'utf8');
    await writeFile(indexPath, index.replace('</ul>', '<li><a href="/ezHUD/preview/ghost/">ghost</a></li></ul>'));
    const manifest = JSON.parse(await readFile(path.join(site, 'pages-manifest.json'), 'utf8'));
    await createManifest(site, { previews: manifest.previews, deployment: manifest.deployment });

    await assert.rejects(guardSite(site), /preview index links do not match live previews/);
  } finally {
    await rm(run, { recursive: true, force: true });
  }
});

test('the public allowlist rejects registered game data in a preview', async () => {
  const run = await mkdtemp(path.join(os.tmpdir(), 'ezhud-pages-pak1-'));
  try {
    await artifact(run, 'preview', '/ezHUD/preview/safe/');
    await writeFile(path.join(run, 'id1/pak1.pak'), 'registered data');
    await assert.rejects(guardArtifact(run, '/ezHUD/preview/safe/'), /outside the public allowlist/);
  } finally {
    await rm(run, { recursive: true, force: true });
  }
});

test('the public allowlist rejects owner files in a preview', async () => {
  const run = await mkdtemp(path.join(os.tmpdir(), 'ezhud-pages-owner-'));
  try {
    await artifact(run, 'preview', '/ezHUD/preview/safe/');
    await writeFile(path.join(run, 'owner-config.cfg'), 'personal data');
    await assert.rejects(guardArtifact(run, '/ezHUD/preview/safe/'), /outside the public allowlist/);
  } finally {
    await rm(run, { recursive: true, force: true });
  }
});
