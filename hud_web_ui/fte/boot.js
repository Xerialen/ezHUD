// fte/boot.js — brings the FTE wasm engine up underneath the editor.
//
// A classic script, not a module, and that is the whole reason it can do this
// job: engine/web/prejs.js reads Module the moment ftewebglcl.js is evaluated,
// so everything here has to be in place first, and a module would be deferred
// past it. It builds Module, shims #frame into something view/app.js can treat
// as an <img>, and injects the engine script itself.
//
// Nothing in this file knows about the editor's panels. The host chrome (demo
// picker, import drop zone, drift report) is fte/chrome.js, which is a module
// and runs after app.js.

(function () {
	'use strict';

	// Shipped with the site by tools/fte-web/assemble.sh. `label` is what the
	// picker shows; `path` is the engine-side name, which is also the key the
	// file arrives under in Module.files.
	var BUNDLED_DEMOS = [
		{ label: 'hudtest (synthetic)', path: 'qw/demos/hudtest_src.mvd' },
		{ label: 'tb4gf: book vs s', path: 'qw/demos/tb4gf_book_vs_s.mvd' }
	];

	var DEMO_KEY = 'ezhud.fte.demo';        // last demo played, replayed on reload
	var IMPORTED_DEMOS_KEY = 'ezhud.fte.demos'; // JSON array of imported .mvd paths

	function readJSON(key, fallback) {
		try {
			var raw = window.localStorage.getItem(key);
			return raw ? JSON.parse(raw) : fallback;
		} catch (e) {
			return fallback;
		}
	}

	function known() {
		var paths = BUNDLED_DEMOS.map(function (d) { return d.path; });
		var imported = readJSON(IMPORTED_DEMOS_KEY, []);
		return paths.concat(Array.isArray(imported) ? imported : []);
	}

	// An imported demo lives in the Cache API, and the engine loads that cache
	// itself at preRun (engine/web/prejs.js, Module['loadcachedfiles']), so the
	// name is enough -- boot does not have to fetch the bytes back.
	var initialDemo = (function () {
		var saved = null;
		try { saved = window.localStorage.getItem(DEMO_KEY); } catch (e) { /* private mode */ }
		return saved && known().indexOf(saved) >= 0 ? saved : BUNDLED_DEMOS[0].path;
	})();

	// A demo has two names. In Module.files and the Cache API it is an absolute
	// FS path ('qw/demos/foo.mvd' — that is where the bytes land); to `playdemo`
	// it is relative to the active gamedir, which the manifest's `basegame qw`
	// makes 'demos/foo.mvd'. Handing playdemo the FS path finds nothing.
	// (Verified live: 'playdemo qw/demos/x.mvd' fails, 'playdemo demos/x.mvd'
	// plays.)
	function demoCmdPath(path) {
		return String(path).replace(/^qw\//, '');
	}

	var canvas = document.getElementById('canvas');
	var statusEl = document.getElementById('fte-status');

	function say(text) {
		if (statusEl) {
			statusEl.textContent = text;
			statusEl.hidden = !text;
		}
	}

	// ---- the #frame shim ---------------------------------------------------
	// app.js believes #frame is the <img> holding the last captured frame: it
	// assigns .src, reads .naturalWidth/.naturalHeight for the render's true
	// size, and listens for 'load'. Here the render is the live canvas behind
	// it, so the natural size is the canvas backing store and there is nothing
	// to load. clientWidth and getBoundingClientRect() are left native and are
	// already correct, because the div is inset:0 over that same canvas.

	(function shimFrame() {
		var frame = document.getElementById('frame');
		if (!frame || !canvas) {
			return;
		}
		Object.defineProperty(frame, 'naturalWidth', { get: function () { return canvas.width; } });
		Object.defineProperty(frame, 'naturalHeight', { get: function () { return canvas.height; } });

		var src = '';
		Object.defineProperty(frame, 'src', {
			get: function () { return src; },
			set: function (value) {
				src = value;
				// Asynchronously: app.js assigns .src from inside its own
				// Image 'load' handler and only then sets frameReady, so a
				// synchronous dispatch would run renderOverlay against a state
				// that has not been updated yet.
				setTimeout(function () {
					frame.dispatchEvent(new Event('load'));
				}, 0);
			}
		});
	})();

	// ---- Module ------------------------------------------------------------

	var Module = {
		canvas: canvas,

		// String values are URLs the engine fetches before any C code runs
		// (prejs.js). Files the user imported are not listed here: they live in
		// the 'user' Cache under /_/<fs-path>, and prejs.js's loadcachedfiles()
		// reads that cache into the engine's own FS layer at preRun. Adding
		// them here as well would download the same bytes twice.
		files: {
			'default.fmf': 'default.fmf',
			'id1/pak0.pak': 'id1/pak0.pak',
			'id1/pak1.pak': 'id1/pak1.pak',
			'qw/demos/hudtest_src.mvd': 'qw/demos/hudtest_src.mvd',
			'qw/demos/tb4gf_book_vs_s.mvd': 'qw/demos/tb4gf_book_vs_s.mvd'
		},

		// Explicit, so prejs.js does not build a command line out of the query
		// string instead. plug_sbar 3 is "always let the hud plugin draw"
		// (engine/common/plugin.c:31); without it the plugin defers to the
		// engine's own sbar and the editor has nothing to place.
		arguments: [
			'-manifest', 'default.fmf',
			'+plug_sbar', '3',
			'+scr_newhud', '1',
			'+playdemo', demoCmdPath(initialDemo)
		],

		// The stock shell's flag. Nothing in the engine reads it -- begin() is
		// the shell's job, so it is ours, and this is what ours honours.
		autostart: true,

		print: function (msg) { console.log(msg); },
		printErr: function (msg) { console.warn(msg); },

		setStatus: function (text) {
			// Emscripten spams this during startup, with a "(n/m)" progress
			// tail we have nowhere useful to put.
			say(String(text || '').replace(/\s*\(\d+(\.\d+)?\/\d+\)\s*$/, ''));
		},

		postRun: [function () {
			if (Module.sched === undefined) {
				say('FTE started but never set up its main loop. Reload, or try a 64-bit browser.');
			}
		}]
	};
	window.Module = Module;

	// ---- start -------------------------------------------------------------

	function begin() {
		if (Module.began) {
			return;
		}
		Module.began = true;
		say('Loading engine…');
		var s = document.createElement('script');
		s.src = 'ftewebglcl.js';
		s.charset = 'utf-8';
		s.addEventListener('error', function () {
			say('Could not download ftewebglcl.js. Run tools/fte-web/assemble.sh and reload.');
		});
		document.head.appendChild(s);
	}

	// ---- readiness, keyboard, and the playdemo fallback --------------------

	function stateJSON() {
		if (!Module._EZHud_StateJSON || !Module.UTF8ToString) {
			return null;
		}
		try {
			return JSON.parse(Module.UTF8ToString(Module._EZHud_StateJSON()));
		} catch (e) {
			return null;
		}
	}

	var keyboardReleased = false;

	function releaseKeyboard() {
		var ftec = window.FTEC;
		if (keyboardReleased || !ftec || !ftec.handleevent) {
			return;
		}
		keyboardReleased = true;
		// ftejslib.js:603-608 registers these on `document` in the capture
		// phase, so without this the engine sees every keystroke before the
		// editor does: Escape opens FTE's menu, ` its console, W walks the
		// camera. Remove exactly those listeners rather than swallowing the
		// events -- a capture-phase guard of our own would stop propagation
		// before app.js's arrow-key nudge, which listens on window and bubbles.
		//
		// Mouse and drop events need no such surgery: they are registered on
		// the canvas (ftejslib.js:600), which #frame covers with
		// pointer-events:none underneath it, so the canvas is never in the
		// event path at all.
		['keypress', 'keydown', 'keyup'].forEach(function (type) {
			document.removeEventListener(type, ftec.handleevent, true);
		});
	}

	var started = Date.now();
	var demoRetried = false;

	function watch() {
		releaseKeyboard();
		var state = stateJSON();
		if (!state) {
			return;
		}
		var drawn = (state.elements || []).some(function (e) { return e.rect; });
		if (drawn) {
			say('');
			clearInterval(watch.timer);
			return;
		}
		// +playdemo on the command line runs before the manifest's gamedirs are
		// mounted in some orderings, and a demo that never started looks exactly
		// like a HUD with nothing to draw. Ask once more through the console,
		// which cannot race the filesystem because the filesystem is up by now.
		if (!demoRetried && Date.now() - started > 8000 && window.FTEC) {
			demoRetried = true;
			say('No HUD drawn yet — asking the engine to play ' + initialDemo + ' again.');
			window.FTEC.cbufadd('playdemo ' + demoCmdPath(initialDemo) + '\n');
		}
	}

	watch.timer = setInterval(watch, 500);

	// ---- what the host chrome needs ---------------------------------------

	window.EZHUD_FTE = {
		bundledDemos: BUNDLED_DEMOS,
		initialDemo: initialDemo,
		demoKey: DEMO_KEY,
		importedDemosKey: IMPORTED_DEMOS_KEY,
		say: say,
		// Host-page chrome talks to the engine directly rather than through the
		// adapter: `playdemo` is deliberately absent from the editor's
		// allowlist (docs/PROTOCOL.md) and belongs to the page, not the editor.
		// `exec` stays forbidden everywhere -- an imported config is parsed by
		// fte/import.js and applied cvar by cvar, never handed to the console.
		play: function (path) {
			if (!window.FTEC || /[;\r\n$"]/.test(path)) {
				return false;
			}
			try { window.localStorage.setItem(DEMO_KEY, path); } catch (e) { /* private mode */ }
			window.FTEC.cbufadd('playdemo ' + demoCmdPath(path) + '\n');
			return true;
		}
	};

	if (Module.autostart) {
		begin();
	}
})();
