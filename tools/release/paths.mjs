import path from 'node:path';

const DEFAULT_RELEASE_DIR = 'docs/release-1';

export function resolveReleaseDir(repo, argv = process.argv.slice(2)) {
	let requested = DEFAULT_RELEASE_DIR;
	let seen = false;
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === '--release-dir') {
			if (seen) throw new Error('--release-dir may be specified only once');
			const value = argv[index + 1];
			if (!value || value.startsWith('--')) throw new Error('--release-dir requires a value');
			requested = value;
			seen = true;
			index += 1;
		} else if (argument.startsWith('--release-dir=')) {
			if (seen) throw new Error('--release-dir may be specified only once');
			requested = argument.slice('--release-dir='.length);
			if (!requested) throw new Error('--release-dir requires a value');
			seen = true;
		} else {
			throw new Error(`unknown argument: ${argument}`);
		}
	}
	if (path.isAbsolute(requested)) throw new Error('--release-dir must be repository-relative');
	const docs = path.join(repo, 'docs');
	const resolved = path.resolve(repo, requested);
	const relative = path.relative(docs, resolved);
	if (relative.startsWith('..') || path.isAbsolute(relative)) {
		throw new Error('--release-dir must resolve inside docs/');
	}
	if (!relative || relative.includes(path.sep)) {
		throw new Error('--release-dir must name a direct child of docs/');
	}
	return resolved;
}
