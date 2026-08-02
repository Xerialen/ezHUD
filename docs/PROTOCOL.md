# ezQuake HUD bridge — protocol v1

Contract between the engine bridge and the editor UI. Header: `src/hud_web.h`.

## Why this shape

The editor must never reimplement HUD placement. Every rect it draws a handle on is
the engine's own `hud->lx/ly/lw/lh`, computed by `HUD_PrepareDraw` on the last frame
that element was drawn. Every change it makes goes back through the console. The
engine stays the single source of truth for both geometry and rendering.

## Using it

Three steps, and nothing to install beyond ezQuake itself:

1. Start ezQuake and join a server or play a demo — the editor can only place
   elements the engine is actually drawing.
2. `hud_web 1` in the console.
3. Open the URL it prints. The editor is served by the engine.

## Enabling

```
hud_web 1                 // cvar, default 0
hud_web_port 27700        // cvar, default 27700
```

On enable the engine binds `127.0.0.1:<port>`, mints a 32-char hex token and prints:

```
HUD bridge: editor at http://127.0.0.1:27700/?t=<token>
```

`hud_web 0` closes the listener and invalidates the token.

## Transport rules

- **Loopback only.** Bind `127.0.0.1` explicitly, never `INADDR_ANY`.
- **Token on every request that touches the engine**, as `?t=<token>` or `X-HUD-Token`.
  Missing/wrong → `403`. Localhost is not an authorization boundary — any page the user
  has open can reach it.
- **The UI's own files are the one exception.** `/`, `/ui.css`, `/core/*.js`, `/view/*.js`
  are served without a token. They are this project's source, byte-identical for every
  user and carrying nothing about them, so gating them protects nothing — and it would
  not work: the browser does not attach our query token to the module and stylesheet
  requests the page issues for itself, so a gated `/index.html` would load into a page
  whose scripts all 403.
- **Non-blocking.** Listener and clients are non-blocking; `HUD_Web_Frame()` is called
  once per client frame next to `Sys_ReadIPC()` in `cl_main.c` and must never block.
  Follow the existing `Sys_ReadIPC` pattern; do not add threads.
- **Bounded.** Cap concurrent clients (4 is plenty), cap request size (64 KB), drop
  anything that stalls mid-request. One misbehaving client must not stall the frame.
- **HTTP/1.1, `Connection: close`.** No keep-alive, no chunked encoding, no TLS.
- **CORS:** reply `Access-Control-Allow-Origin: *` and handle `OPTIONS`. The token is
  the security boundary, not the origin — this is what lets a dev server iterate the
  UI against a running engine.

## Endpoints

### `GET /state`

Engine-authoritative HUD state.

```json
{
  "protocol": 1,
  "engine": "ezquake 3.7.0-dev",
  "screen": {
    "vid_width": 512, "vid_height": 288,
    "scr_con_current": 0
  },
  "fonts": { "proportional_loaded": false, "facepath": "" },
  "view": { "spectator": true, "tracking": true },
  "physical": [2560, 1440],
  "elements": [
    {
      "name": "health",
      "shown": true,
      "place": "screen",
      "parent": null,
      "align_x": "left", "align_y": "top",
      "pos_x": 0, "pos_y": 0,
      "order": 5,
      "frame": 0,
      "spec_required": false,
      "needs_pov": true,
      "rect":  { "x": 268, "y": 241, "w": 45, "h": 20 },
      "cvars": { "hud_health_scale": "2", "hud_health_style": "0" }
    }
  ]
}
```

`fonts.proportional_loaded` cannot be inferred from `facepath`: `Draw_InitFont` discards
`FontCreate`'s result at startup, so a config naming a font that no longer resolves leaves
the cvar set with no face loaded. With no face, every `proportional 1` silently renders at
8px, so a client that presents `proportional` as live is lying to the user.

- Coordinates are **console pixels**, matching `vid.width`/`vid.height`.
- `physical` is read from `renderer.ScreenshotWidth()`/`Height()` — the *same* source
  `/frame.png` captures from, so the two can never disagree about the size of the same
  picture. Do not switch it to `glwidth`/`glheight`: those are only assigned inside
  `R_BeginRendering` (`cl_screen.c:925`) and read 0 before the first screen update, and
  a client that receives 0 falls back to a scale of 1 and lays every box out in the
  wrong place with no error to explain it.
- `rect` is `null` when the element was not drawn last frame. Report that honestly;
  never substitute a guess. A `null` rect means "no handle to show", not "0,0".
- A non-null `rect` **is** "drawn this frame"
  (`hud->last_draw_sequence == host_screenupdatecount`). There is no separate `drawn`
  field: it was always the same condition, and two ways to ask one question is two
  things that can disagree. Note this means "the engine laid it out", which is not
  quite "you can see it" — `HUD_PrepareDraw` stamps the sequence before its caller
  draws any pixels, and some elements call it before their own visibility test.
- `parent` is the `place` target's name when anchored, else `null`. `place` carries
  the raw cvar string so the UI can distinguish `group1` from `@group1`.

### `POST /cmd`

Body: `{"cmd": "hud_health_pos_x 12"}` or a raw command line.
Passes `HUD_Web_CommandAllowed()`, then `Cbuf_AddText(line + "\n")`.

Response `{"ok": true}`, or `403 {"ok": false, "error": "command not permitted"}`.

**Allowlist** — cvar assignments whose name starts with `hud_`, `vid_`, `scr_`, `cl_hud`,
plus the bare commands `hud_recalculate`, `vid_restart`, `cfg_save`, `move`, `align`,
`place`, `toggleconsole`, `fontload`, `hud_export`, `hud_reset_layout`, plus the
`font_` prefix and `gl_consolefont`. Everything else is refused. No `exec`, no `quit`,
no `rcon`, no aliases, no semicolon chaining.

Reject any line containing `;`, CR, LF, or **`$`**. The `$` matters as much as the
rest: `Cbuf_ExecuteEx` runs `Cmd_ExpandString` *after* this check has passed
(`cmd.c:1865`), so without it `hud_tracking_format $rcon_password` clears the `hud_`
prefix, expands into the secret, and `/state` hands it straight back.

An allowlisted command must also *exist as a command*. `fontload` is only registered
with `EZ_FREETYPE_SUPPORT` (`fonts.c:526`), and the dispatcher falls through to
aliases (`cmd.c:1948`), so a name the build does not provide would otherwise run
whatever alias sits under it.

`togglehud` is deliberately absent: despite the name it falls back to *any* cvar and
toggles it (`hud.c:498`). `hud_web*` is excluded from the `hud_` prefix for the same
class of reason — those are the bridge's own settings, and a client that can set them
can disable its own rate limit or rebind the port out from under itself.

`toggleconsole` is included because the editor must be able to clear the console off the
view to see the HUD. It toggles rather than sets, so read `screen.scr_con_current` and
only send it when the console is actually down.

### `GET /fonts`

What the user can pick from, and whether the current pick actually loaded.

```json
{
  "protocol": 1,
  "directory": "/usr/local/share/fonts/",
  "facepath": "qw-font3.otf",
  "proportional_loaded": false,
  "consolefont": "6",
  "available": ["bigfont.ttf", "qw-font3.otf"]
}
```

Lists both `.ttf` and `.otf`. The engine's own `fontlist` filters `.ttf` only, so a
valid `.otf` face is invisible there despite loading fine.

### `GET /frame.png`

Current framebuffer as PNG, always at native size; the UI scales for display. Must be
called with a current GL context, i.e. from the frame service.

Unknown query parameters are ignored, so `?n=<nonce>` cache-busting is free. There was
a parsed-and-validated `scale=` that the capture then ignored, reserved so that adding
downsampling later would not change the request shape. It was removed: a knob that
validates its input and then does nothing is worse than no knob, because a client can
send `scale=0.5`, get a native-size frame, and reasonably conclude the engine is
broken. Re-adding the parse when downsampling actually lands is the small part of that
change.

`glReadPixels` and the PNG encode both run synchronously on the render thread, so a
capture costs the engine real frame time — measured at 1.5–3.3 s per capture at
2560×1440 on software GL, and a few milliseconds on a GPU. Encoding goes straight to
a heap block (`Image_EncodePNG`); it used to stage through a fixed file under the OS
temp directory, which was both slower and a symlink target another local user could
aim at any file the player can write.

Because the cost is unbounded and clients are not, the engine serves at most one
capture per `hud_web_frame_interval` milliseconds and returns `503` with a
`Retry-After` header otherwise. Four authorised clients polling at once therefore
cost one capture between them, not four.

### `GET /configs`

Where saving writes, and what is already there, so the editor can warn before an
overwrite rather than after.

```json
{
  "protocol": 1,
  "config_dir": "…/ezquake/configs/",
  "export_dir": "…/ezquake/configs/",
  "main": "config.cfg",
  "backup_enabled": false,
  "available": ["config.cfg", "duel.cfg"],
  "exports": ["hudonly.cfg"]
}
```

Two directories, not one, because the engine uses two: `cfg_save` honours
`cfg_use_home`/`cfg_use_gamedir` via `Cfg_GetConfigPath` (`config_manager.c:1131`)
while `hud_export` hardcodes `<basedir>/ezquake/configs` (`config_manager.c:893`).
Identical in the default setup, different the moment `cfg_use_home` is on. `available`
lists `config_dir`, `exports` lists `export_dir` — separately, because an overwrite
warning has to be about the directory the chosen mode actually writes to.

`backup_enabled` reports `cfg_backup`, which **defaults to `0`** — a plain `cfg_save`
over an existing config destroys it with nothing kept. Set it before overwriting.

### `GET /` and the UI's static files

The editor itself, compiled into the binary. `hud_web_ui/` is baked into
`src/hud_web_assets.c` by `tools/embed_hud_web_ui.py`; the generated file is committed
so no build-time dependency reaches the Windows or Linux builds. Run the script after
editing anything under `hud_web_ui/`, and `--check` in review to prove it is current.

Exact-path lookup only, no directory walking: `/` resolves to `index.html`, anything
not in the table is `404`.

## Errors

JSON `{"ok":false,"error":"..."}` with `400` malformed, `403` auth/command refused,
`404` unknown route, `503` bridge disabled.

## Ownership

| File | Owner | Contents |
|---|---|---|
| `src/hud_web.h` | Claude | the contract above |
| `src/hud_web.c` | **sol** | listener, HTTP parse, token auth, routing, cvars, allowlist, frame service |
| `src/hud_web_state.c` | Claude | `HUD_Web_StateJSON`, `HUD_Web_CapturePNG`, `HUD_Web_FontsJSON`, `HUD_Web_ConfigsJSON` |
| `src/hud_web_assets.c` | generated | the editor UI, baked in — do not edit |
| `CMakeLists.txt`, `cl_main.c` | Claude | build wiring and the `HUD_Web_Frame()` call site |

Separate files so both sides can land independently. Claude owns the shared edits to
avoid conflicts on the branch.

Branch: `feat/hud-web-bridge`, cut from `feat/libhud-placement-core`.
Build+test host: pinnacle, `/home/xerial/projects/ezquake-libhud` (`SKIP_DEPS=1 ./build-linux.sh`).
(Pinnacle ran the above under WSL when this was written; since the 2026
reinstall it is native Ubuntu Desktop, so no WSL indirection applies.)
