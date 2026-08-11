#!/usr/bin/env node
// Compose a complete GitHub Pages artifact without dropping the release root,
// the permanent dev build, or an earlier branch preview. The deployed site is
// its own durable state: every publication carries a hash manifest, and the next
// run downloads and verifies those exact bytes before replacing one subtree.
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const PUBLIC_ARTIFACT_PATHS = Object.freeze(`core/bridge.js
core/fte-adapter.js
core/geometry.js
core/log.js
core/model.js
core/quake-palette.js
core/snapping.js
default.fmf
favicon.svg
fte/boot.js
fte/chrome.js
fte/fte.css
fte/import.js
ftewebglcl.js
ftewebglcl.wasm
id1/gpl_maps.pk3
id1/nquake.pk3
id1/pak0.pak
id1/qrp-dm3.pk3
index.html
qw/demos/hudtest_src.mvd
qw/demos/tb4gf_book_vs_s.mvd
qw/fragfile.dat
release-1/img/after-bar.png
release-1/img/after-paused.png
release-1/img/after-resized-window.png
release-1/img/after-state.json
release-1/img/before-resized-window.png
release-1/img/before-state.json
release-1/img/pause-resume-focused-annotated.png
release-1/img/window-follow-focused-annotated.png
release-1/index.html
release-1/release-notes.html
release-2/img/anchor-focused-annotated.png
release-2/img/demo-moments-focused-annotated.png
release-2/img/drag-assist-focused-annotated.png
release-2/img/editor-size-focused-annotated.png
release-2/index.html
release-2/release-notes.html
ui.css
view/app.js
view/debug.js`.split('\n'));

const MANIFEST_NAME = 'pages-manifest.json';
const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertSafeName(name) {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`preview name '${name}' must be 1-40 lowercase letters, digits, or internal hyphens`);
  }
}

function assertSafeRelative(relative) {
  if (!relative || relative.startsWith('/') || relative.includes('\\') ||
      relative.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new Error(`unsafe manifest path: ${relative}`);
  }
}

async function listFiles(root) {
  const result = [];
  async function walk(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = path.posix.join(prefix, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`symbolic links cannot be published: ${relative}`);
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), relative);
      else if (entry.isFile()) result.push(relative);
      else throw new Error(`unsupported filesystem entry: ${relative}`);
    }
  }
  await walk(root);
  return result.sort();
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validateDevMetadata(dev) {
  if (dev === undefined || dev === null) return null;
  if (!dev || typeof dev !== 'object') throw new Error('invalid dev metadata');
  for (const key of ['ref', 'commit', 'publishedAt']) {
    if (typeof dev[key] !== 'string' || dev[key] === '') throw new Error(`dev has no ${key}`);
  }
  return { ref: dev.ref, commit: dev.commit, publishedAt: dev.publishedAt };
}

function validatePreviewMetadata(previews) {
  if (!Array.isArray(previews)) throw new Error('pages manifest previews must be an array');
  const seen = new Set();
  for (const preview of previews) {
    if (!preview || typeof preview !== 'object') throw new Error('invalid preview metadata');
    assertSafeName(preview.name);
    if (seen.has(preview.name)) throw new Error(`duplicate preview metadata: ${preview.name}`);
    seen.add(preview.name);
    for (const key of ['ref', 'commit', 'publishedAt']) {
      if (typeof preview[key] !== 'string' || preview[key] === '') {
        throw new Error(`preview ${preview.name} has no ${key}`);
      }
    }
  }
  return [...previews].sort((a, b) => a.name.localeCompare(b.name));
}

function validateManifest(manifest) {
  if (!manifest || manifest.version !== 1 || typeof manifest.deployment !== 'string' ||
      !Array.isArray(manifest.files)) throw new Error('unsupported or malformed pages manifest');
  manifest.dev = validateDevMetadata(manifest.dev);
  manifest.previews = validatePreviewMetadata(manifest.previews);
  let previous = '';
  for (const file of manifest.files) {
    if (!file || typeof file.path !== 'string' || !Number.isInteger(file.size) || file.size <= 0 ||
        !/^[0-9a-f]{64}$/.test(file.sha256)) throw new Error('malformed file entry in pages manifest');
    assertSafeRelative(file.path);
    if (file.path === MANIFEST_NAME) throw new Error('pages manifest must not list itself');
    if (file.path <= previous) throw new Error('pages manifest file entries must be unique and sorted');
    previous = file.path;
  }
  return manifest;
}

async function readManifest(siteDir) {
  return validateManifest(JSON.parse(await readFile(path.join(siteDir, MANIFEST_NAME), 'utf8')));
}

async function assertBytesMatchManifest(siteDir, manifest) {
  const actualPaths = (await listFiles(siteDir)).filter(relative => relative !== MANIFEST_NAME);
  const manifestPaths = manifest.files.map(file => file.path);
  if (!arraysEqual(actualPaths, manifestPaths)) {
    throw new Error(`site files differ from ${MANIFEST_NAME}\nexpected: ${manifestPaths.join('\n')}\nactual: ${actualPaths.join('\n')}`);
  }
  for (const file of manifest.files) {
    const bytes = await readFile(path.join(siteDir, file.path));
    if (bytes.length !== file.size || sha256(bytes) !== file.sha256) {
      throw new Error(`site file does not match ${MANIFEST_NAME}: ${file.path}`);
    }
  }
}

function expectedArtifactPaths(prefix = '') {
  return PUBLIC_ARTIFACT_PATHS.map(relative => `${prefix}${relative}`);
}

function poisonPath(relative) {
  return relative.split('/').some(name => name === 'pak1.pak' || name.startsWith('owner-') || name.startsWith('xerial-'));
}

async function guardArtifactAt(directory, basePath) {
  if (!/^\/.*\/$/.test(basePath)) throw new Error(`BASE_PATH must start and end with '/': ${basePath}`);
  for (const relative of PUBLIC_ARTIFACT_PATHS) {
    if (poisonPath(relative)) throw new Error(`non-distributable or personal file present: ${relative}`);
    if ((await stat(path.join(directory, relative))).size === 0) throw new Error(`empty public artifact file: ${relative}`);
  }
  const html = await readFile(path.join(directory, 'index.html'), 'utf8');
  for (const module of ['bridge.js', 'fte-adapter.js']) {
    if (!html.includes(`"${basePath}core/${module}"`)) {
      throw new Error(`index.html has no ${basePath}core/${module} import-map URL`);
    }
  }
  if (html.includes('"/core/bridge.js"')) throw new Error('index.html still has the site-root bridge import-map key');
}

export async function guardArtifact(directory, basePath) {
  const actual = await listFiles(directory);
  if (!arraysEqual(actual, [...PUBLIC_ARTIFACT_PATHS])) {
    throw new Error(`artifact contains files outside the public allowlist\nexpected: ${PUBLIC_ARTIFACT_PATHS.join('\n')}\nactual: ${actual.join('\n')}`);
  }
  await guardArtifactAt(directory, basePath);
}

async function assertPreviewIndexMatches(siteDir, previews) {
  if (!previews.length) return;
  const index = await readFile(path.join(siteDir, 'preview/index.html'), 'utf8');
  const linked = [...index.matchAll(/href="\/ezHUD\/preview\/([^"/]+)\/"/g)]
    .map(match => match[1]).sort();
  const live = previews.map(preview => preview.name).sort();
  if (!arraysEqual(linked, live)) {
    throw new Error(`preview index links do not match live previews (links: ${linked.join(', ') || 'none'}; live: ${live.join(', ')})`);
  }
}

// The downloaded, already-deployed site is validated for integrity and safety
// only: its bytes must match its own manifest (which attested its file set when
// it was published) and it must never carry registered game data or personal
// files. It is NOT compared to today's expectedArtifactPaths(): the fetch step
// runs before any deploy can land, so judging an older site by a grown
// allowlist would deadlock every future deploy.
export async function guardDeployedSite(siteDir) {
  const manifest = await readManifest(siteDir);
  await assertBytesMatchManifest(siteDir, manifest);
  if (manifest.files.some(file => poisonPath(file.path))) {
    throw new Error('site contains registered game data or an owner/xerial personal file');
  }
  return manifest;
}

// The composed replacement artifact is validated section by section: the
// subtree being (re)published now must equal today's allowlist exactly, while
// every preserved subtree must be list- and byte-identical to the downloaded
// site (baseline) whose integrity guardDeployedSite already attested.
export async function guardComposedSite(siteDir, { baseline, republishPrefix }) {
  const manifest = await guardDeployedSite(siteDir);
  const inRepublished = republishPrefix === ''
    ? relative => !relative.startsWith('dev/') && !relative.startsWith('preview/')
    : relative => relative.startsWith(republishPrefix);

  const expected = baseline.files.map(file => file.path)
    .filter(relative => !inRepublished(relative) && relative !== 'preview/index.html');
  expected.push(...expectedArtifactPaths(republishPrefix));
  if (manifest.previews.length) expected.push('preview/index.html');
  expected.sort();
  const actual = manifest.files.map(file => file.path);
  if (!arraysEqual(actual, expected)) {
    throw new Error(`composed site does not match the preserved sections plus the current '${republishPrefix || 'release'}' allowlist\nexpected: ${expected.join('\n')}\nactual: ${actual.join('\n')}`);
  }

  const priorByPath = new Map(baseline.files.map(file => [file.path, file]));
  for (const file of manifest.files) {
    if (inRepublished(file.path) || file.path === 'preview/index.html') continue;
    const prior = priorByPath.get(file.path);
    if (prior.size !== file.size || prior.sha256 !== file.sha256) {
      throw new Error(`preserved file differs from the downloaded site: ${file.path}`);
    }
  }

  await guardArtifactAt(path.join(siteDir, republishPrefix), `/ezHUD/${republishPrefix}`);
  await assertPreviewIndexMatches(siteDir, manifest.previews);
  return manifest;
}

export async function guardSite(siteDir) {
  const manifest = await readManifest(siteDir);
  await assertBytesMatchManifest(siteDir, manifest);

  const expected = expectedArtifactPaths();
  if (manifest.dev) expected.push(...expectedArtifactPaths('dev/'));
  if (manifest.previews.length) expected.push('preview/index.html');
  for (const preview of manifest.previews) expected.push(...expectedArtifactPaths(`preview/${preview.name}/`));
  expected.sort();
  const actual = manifest.files.map(file => file.path);
  if (!arraysEqual(actual, expected)) {
    throw new Error(`site contains files outside the release/preview allowlist\nexpected: ${expected.join('\n')}\nactual: ${actual.join('\n')}`);
  }
  if (actual.some(poisonPath)) throw new Error('site contains registered game data or an owner/xerial personal file');

  await guardArtifactAt(siteDir, '/ezHUD/');
  if (manifest.dev) await guardArtifactAt(path.join(siteDir, 'dev'), '/ezHUD/dev/');
  for (const preview of manifest.previews) {
    await guardArtifactAt(path.join(siteDir, 'preview', preview.name), `/ezHUD/preview/${preview.name}/`);
  }
  await assertPreviewIndexMatches(siteDir, manifest.previews);
  return manifest;
}

function escapeHtml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

async function writePreviewIndex(siteDir, previews) {
  if (!previews.length) {
    await rm(path.join(siteDir, 'preview'), { recursive: true, force: true });
    return;
  }
  await mkdir(path.join(siteDir, 'preview'), { recursive: true });
  const rows = previews.map(preview => `      <li><a href="/ezHUD/preview/${escapeHtml(preview.name)}/">${escapeHtml(preview.name)}</a> <small>${escapeHtml(preview.ref)} · ${escapeHtml(preview.commit.slice(0, 12))} · ${escapeHtml(preview.publishedAt)}</small></li>`).join('\n');
  const html = `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ezHUD previews</title><style>body{font:16px system-ui,sans-serif;max-width:50rem;margin:3rem auto;padding:0 1rem;background:#111;color:#eee}a{color:#8cf}li{margin:1rem 0}small{display:block;color:#aaa}</style></head><body>\n  <main><h1>ezHUD previews</h1><p>Public test builds. Each link remains available when another preview is published.</p><ul>\n${rows}\n    </ul></main>\n</body></html>\n`;
  await writeFile(path.join(siteDir, 'preview/index.html'), html);
}

export async function createManifest(siteDir, { dev = null, previews, deployment }) {
  dev = validateDevMetadata(dev);
  previews = validatePreviewMetadata(previews);
  await rm(path.join(siteDir, MANIFEST_NAME), { force: true });
  const files = [];
  for (const relative of await listFiles(siteDir)) {
    assertSafeRelative(relative);
    const bytes = await readFile(path.join(siteDir, relative));
    if (!bytes.length) throw new Error(`refusing to manifest empty file: ${relative}`);
    files.push({ path: relative, size: bytes.length, sha256: sha256(bytes) });
  }
  const manifest = { version: 1, deployment, generatedAt: new Date().toISOString(), dev, previews, files };
  await writeFile(path.join(siteDir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

async function freshCopy(source, destination) {
  await rm(destination, { recursive: true, force: true });
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, force: true, errorOnExist: false });
}

export async function composePreview({ currentDir, previewDir, outputDir, name, ref, commit, publishedAt, deployment }) {
  assertSafeName(name);
  const current = await guardDeployedSite(currentDir);
  await guardArtifact(previewDir, `/ezHUD/preview/${name}/`);
  await freshCopy(currentDir, outputDir);
  const target = path.join(outputDir, 'preview', name);
  await rm(target, { recursive: true, force: true });
  await mkdir(path.dirname(target), { recursive: true });
  await cp(previewDir, target, { recursive: true });
  const previews = current.previews.filter(preview => preview.name !== name);
  previews.push({ name, ref, commit, publishedAt });
  previews.sort((a, b) => a.name.localeCompare(b.name));
  await writePreviewIndex(outputDir, previews);
  await createManifest(outputDir, { dev: current.dev, previews, deployment });
  const composed = await guardComposedSite(outputDir, { baseline: current, republishPrefix: `preview/${name}/` });
  const rootProof = composed.files.find(file => file.path === 'index.html');
  console.log(`pages-site: preserved release index ${rootProof.sha256}.`);
  for (const prior of current.previews.filter(preview => preview.name !== name)) {
    const proof = composed.files.find(file => file.path === `preview/${prior.name}/index.html`);
    console.log(`pages-site: preserved preview ${prior.name} index ${proof.sha256}.`);
  }
}

export async function composeDev({ currentDir, devDir, outputDir, ref, commit, publishedAt, deployment }) {
  const current = await guardDeployedSite(currentDir);
  await guardArtifact(devDir, '/ezHUD/dev/');
  await freshCopy(currentDir, outputDir);
  const target = path.join(outputDir, 'dev');
  await rm(target, { recursive: true, force: true });
  await cp(devDir, target, { recursive: true });
  const dev = validateDevMetadata({ ref, commit, publishedAt });
  await createManifest(outputDir, { dev, previews: current.previews, deployment });
  const composed = await guardComposedSite(outputDir, { baseline: current, republishPrefix: 'dev/' });
  const rootProof = composed.files.find(file => file.path === 'index.html');
  console.log(`pages-site: preserved release index ${rootProof.sha256}.`);
  for (const preview of current.previews) {
    const proof = composed.files.find(file => file.path === `preview/${preview.name}/index.html`);
    console.log(`pages-site: preserved preview ${preview.name} index ${proof.sha256}.`);
  }
}

export async function composeRelease({ currentDir, releaseDir, outputDir, deployment }) {
  const current = await guardDeployedSite(currentDir);
  await guardArtifact(releaseDir, '/ezHUD/');
  await freshCopy(releaseDir, outputDir);
  if (current.dev) await cp(path.join(currentDir, 'dev'), path.join(outputDir, 'dev'), { recursive: true });
  if (current.previews.length) {
    await mkdir(path.join(outputDir, 'preview'), { recursive: true });
    for (const preview of current.previews) {
      await cp(path.join(currentDir, 'preview', preview.name), path.join(outputDir, 'preview', preview.name), { recursive: true });
    }
  }
  await writePreviewIndex(outputDir, current.previews);
  await createManifest(outputDir, { dev: current.dev, previews: current.previews, deployment });
  const composed = await guardComposedSite(outputDir, { baseline: current, republishPrefix: '' });
  for (const prior of current.previews) {
    const proof = composed.files.find(file => file.path === `preview/${prior.name}/index.html`);
    console.log(`pages-site: preserved preview ${prior.name} index ${proof.sha256}.`);
  }
}

function urlFor(baseUrl, relative, cacheKey = '') {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const encoded = relative.split('/').map(encodeURIComponent).join('/');
  const url = new URL(encoded, base);
  if (cacheKey) url.searchParams.set('pages-check', cacheKey);
  return url;
}

async function fetchResponse(url, { allow404 = false } = {}) {
  const response = await fetch(url, { headers: { 'cache-control': 'no-cache' } });
  if (allow404 && response.status === 404) return null;
  if (!response.ok) throw new Error(`GET ${url} returned ${response.status}`);
  return response;
}

export async function fetchCurrentSite({ baseUrl, bootstrapManifest, outputDir, cacheKey = '' }) {
  const response = await fetchResponse(urlFor(baseUrl, MANIFEST_NAME, cacheKey), { allow404: true });
  let manifest;
  let source;
  if (response) {
    manifest = validateManifest(await response.json());
    source = 'deployed manifest';
  } else {
    manifest = validateManifest(JSON.parse(await readFile(bootstrapManifest, 'utf8')));
    source = `bootstrap ${bootstrapManifest}`;
  }
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  for (const file of manifest.files) {
    const fileResponse = await fetchResponse(urlFor(baseUrl, file.path, cacheKey));
    const bytes = Buffer.from(await fileResponse.arrayBuffer());
    if (bytes.length !== file.size || sha256(bytes) !== file.sha256) {
      throw new Error(`deployed file differs from ${source}: ${file.path}`);
    }
    const target = path.join(outputDir, file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  await writeFile(path.join(outputDir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
  await guardDeployedSite(outputDir);
  console.log(`pages-site: preserved ${manifest.files.length} files from ${source} (${manifest.previews.length} previews).`);
  return manifest;
}

export async function createVerificationBundle(siteDir, outputDir) {
  const manifest = await guardDeployedSite(siteDir);
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await cp(path.join(siteDir, MANIFEST_NAME), path.join(outputDir, MANIFEST_NAME));
  const proofPaths = ['index.html'];
  if (manifest.dev) proofPaths.push('dev/index.html');
  proofPaths.push(...manifest.previews.map(preview => `preview/${preview.name}/index.html`));
  for (const relative of proofPaths) {
    const target = path.join(outputDir, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(path.join(siteDir, relative), target);
  }
}

export async function verifyRemote({ baseUrl, expectedDir, expectedManifest, proofDir, attempts = 40, delayMs = 15000, cacheKey = '' }) {
  const expected = expectedDir ? await guardDeployedSite(expectedDir) :
    validateManifest(JSON.parse(await readFile(expectedManifest, 'utf8')));
  const localProofDir = proofDir ?? expectedDir;
  let remote;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetchResponse(urlFor(baseUrl, MANIFEST_NAME, `${cacheKey}-${attempt}`));
      remote = validateManifest(await response.json());
      if (remote.deployment === expected.deployment) break;
    } catch (error) {
      if (attempt === attempts) throw error;
    }
    if (attempt === attempts) throw new Error(`Pages did not expose deployment ${expected.deployment} after ${attempts} attempts`);
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  if (JSON.stringify(remote.files) !== JSON.stringify(expected.files) ||
      JSON.stringify(remote.dev) !== JSON.stringify(expected.dev) ||
      JSON.stringify(remote.previews) !== JSON.stringify(expected.previews)) {
    throw new Error('deployed Pages manifest differs from the uploaded artifact');
  }
  const proofPaths = ['index.html'];
  if (expected.dev) proofPaths.push('dev/index.html');
  proofPaths.push(...expected.previews.map(preview => `preview/${preview.name}/index.html`));
  for (const relative of proofPaths) {
    const entry = expected.files.find(file => file.path === relative);
    const localBytes = await readFile(path.join(localProofDir, relative));
    if (!entry || localBytes.length !== entry.size || sha256(localBytes) !== entry.sha256) {
      throw new Error(`local preservation proof differs from the expected manifest: ${relative}`);
    }
    const response = await fetchResponse(urlFor(baseUrl, relative, `${cacheKey}-proof`));
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== entry.size || sha256(bytes) !== entry.sha256) {
      throw new Error(`live preservation proof failed for ${relative}`);
    }
    console.log(`pages-site: live ${relative} ${entry.sha256}`);
  }
  console.log(`pages-site: deployment ${expected.deployment} is live; release root, ${expected.dev ? 'dev, ' : ''}and ${expected.previews.length} preview index(es) match.`);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!key?.startsWith('--') || argv[index + 1] === undefined) throw new Error(`expected --name value, got '${key ?? ''}'`);
    options[key.slice(2)] = argv[index + 1];
  }
  return options;
}

function required(options, name) {
  if (!options[name]) throw new Error(`missing --${name}`);
  return options[name];
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const options = parseArgs(rest);
  if (command === 'validate-name') {
    assertSafeName(required(options, 'name'));
  } else if (command === 'guard-artifact') {
    await guardArtifact(required(options, 'dir'), required(options, 'base-path'));
  } else if (command === 'guard-site') {
    await guardSite(required(options, 'dir'));
  } else if (command === 'fetch') {
    await fetchCurrentSite({ baseUrl: required(options, 'base-url'), bootstrapManifest: required(options, 'bootstrap'),
      outputDir: required(options, 'output'), cacheKey: options['cache-key'] ?? '' });
  } else if (command === 'compose-preview') {
    await composePreview({ currentDir: required(options, 'current'), previewDir: required(options, 'artifact'),
      outputDir: required(options, 'output'), name: required(options, 'name'), ref: required(options, 'ref'),
      commit: required(options, 'commit'), publishedAt: required(options, 'published-at'), deployment: required(options, 'deployment') });
  } else if (command === 'compose-dev') {
    await composeDev({ currentDir: required(options, 'current'), devDir: required(options, 'artifact'),
      outputDir: required(options, 'output'), ref: required(options, 'ref'), commit: required(options, 'commit'),
      publishedAt: required(options, 'published-at'), deployment: required(options, 'deployment') });
  } else if (command === 'compose-release') {
    await composeRelease({ currentDir: required(options, 'current'), releaseDir: required(options, 'artifact'),
      outputDir: required(options, 'output'), deployment: required(options, 'deployment') });
  } else if (command === 'verification-bundle') {
    await createVerificationBundle(required(options, 'site'), required(options, 'output'));
  } else if (command === 'verify-remote') {
    const expectedDir = options.expected;
    const expectedManifest = options['expected-manifest'];
    if (!expectedDir && !expectedManifest) throw new Error('verify-remote needs --expected or --expected-manifest');
    await verifyRemote({ baseUrl: required(options, 'base-url'), expectedDir, expectedManifest,
      proofDir: options['proof-dir'], cacheKey: options['cache-key'] ?? '',
      attempts: Number(options.attempts ?? 40), delayMs: Number(options['delay-ms'] ?? 15000) });
  } else {
    throw new Error('usage: pages-site.mjs validate-name|guard-artifact|guard-site|fetch|compose-preview|compose-dev|compose-release|verification-bundle|verify-remote ...');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`pages-site: ${error.message}`);
    process.exitCode = 1;
  });
}
