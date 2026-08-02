# Fonts — how text actually gets drawn, and what the editor absorbs

The product rule this document serves: **the complexity of choosing a custom
font (how `proportional`, the charset and the font interact) belongs to the
tool, not the user.** A user should pick a font; ezHUD does the rest. This is
the record of what "the rest" actually is.

Engine references are to upstream `QW-Group/ezquake-source` master (fonts.c,
r_draw_charset.c, hud_common.c) and to this repo's `engine/engine-integration.diff`
against the pinned revision; line numbers between the two drift slightly.

## Two independent systems

ezQuake draws text through two systems that coexist per *character*, not per
screen or per element:

1. **Charset (bitmap).** `gl_consolefont` (default `povo5`, r_draw_charset.c:38)
   names a 16×16-glyph image loaded from `textures/charsets/<name>.png`
   (r_draw_charset.c:183), or the `conchars` lump from gfx.wad when set to
   `original`. Every non-proportional character is drawn in a fixed cell of
   `8 × scale` pixels (r_draw_charset.c:790, fonts.c:542–558). A high-resolution
   charset changes the pixels, never the layout metrics — it is monospace by
   construction.

2. **Proportional (FreeType).** `font_facepath` names a .ttf/.otf in the OS
   font directory (`Sys_FontsDirectory()`, one directory, fonts.c:245–248);
   `FontCreate` rasterises it into a glyph atlas with per-glyph advances
   (fonts.c:357–390). Requires `EZ_FREETYPE_SUPPORT`.

Which system draws a given character is decided at the draw call: if the
element passed `proportional` **and** the face has that glyph, the FreeType
atlas is used; otherwise the very same call falls back to the charset cell
(fonts.c:534–550). Both systems are always "on" at once — the console, any
element with `proportional 0`, and any glyph missing from the face all render
from the charset even while a proportional font is loaded.

## What `proportional` reaches — and what it never reaches

- Per-element `hud_<element>_proportional` cvars default to **0**
  (hud_common.c:941, 978, …). Loading a font changes nothing visible until the
  user also flips the cvar, element by element.
- Only **text styles** consult it. In the number template
  (`SCR_HUD_DrawNum2`, hud_common.c:229–412): styles 0 and 2 draw `sb_nums`
  wad art, 24px per digit, `proportional` ignored entirely (307–316, 385–410);
  styles 1 and 3 draw text and honour it (339–381).
- Style 3 maps digits to the charset's "golden number" glyphs at offset 18+
  (hud_common.c:362–368). That mapping only makes sense against the charset —
  with a TTF it selects the wrong glyphs.
- Icon elements (iammo, iarmor, gun*, items) always draw images.
- Layout: charset text reserves `8 × scale` per character; proportional text
  `8 × scale × advance` (fonts.c:548). `FontFixedWidth` (fonts.c:399–406)
  means element widths **change when a face loads or unloads**, which can move
  neighbours in `place` chains.

## State matrix

| facepath | loaded | charset | element style | `proportional` | drawn as |
|---|---|---|---|---|---|
| empty | no | stock | text | 0 or 1 | 8px charset cells, monospace |
| empty | no | custom png | text | 0 or 1 | custom charset glyphs, still 8px cells |
| set | **no** (file missing) | any | text | 1 | **silent fallback to 8px charset** — looks identical to "no font"; the cvar lies |
| set | yes | any | text | 0 | charset — the face is ignored for this element |
| set | yes | any | text | 1 | FreeType glyphs, proportional advances; missing glyphs fall back per character |
| any | any | any | image (nums style 0/2, icons, gun/items) | any | wad/textures art, `proportional` ignored |
| set | yes | custom | console/notify | — | charset |

## Engine traps (verified in source)

1. **`set font_facepath` fails silently.** The OnChange callback reads
   `Cmd_Argv(1)` — which during `set` is the *cvar name*, not the new value —
   so `FontCreate` opens the wrong path, fails, and cancels the change
   (fonts.c:408–415). Only the bare form `font_facepath foo` or `fontload foo`
   (fonts.c:419–443) works.
2. **Non-empty facepath ≠ loaded font.** At startup `Draw_InitFont` calls
   `FontCreate` and **discards the result** (fonts.c:579–589). A config naming
   a font that no longer resolves keeps the cvar set while everything renders
   at 8px, with no error anywhere.
3. **`fontlist` hides .otf** — it globs `.ttf` only (fonts.c:445+) even though
   `FontCreate` loads .otf fine.
4. **`fontload` takes exactly one unquoted argument** — filenames containing
   spaces, tabs or quotes cannot be passed.
5. **A 200 from `/cmd` does not mean the load succeeded** — the engine rejects
   a failed load by cancelling the cvar change, after the command returned.
6. **Bake-time options** (`font_capitalize`, outline/gradient `font_*` cvars)
   only take effect on the *next* `FontCreate` — setting them alone changes
   nothing until the face is reloaded.
7. **`fontload` only exists with `EZ_FREETYPE_SUPPORT`** (fonts.c:497); on a
   build without it the name would fall through the command dispatcher to
   aliases, which is why the bridge checks `Cmd_FindCommand` before allowing
   it (hud_web.c:726–732).

## What the tool already absorbs

- The bridge always loads via `fontload`, never `set` (core/bridge.js:124–129) — trap 1.
- The engine patch adds `FontProportionalLoaded()`/`FontFacePath()`
  (engine-integration.diff:59–90); `/state` and `/fonts` report
  `proportional_loaded`, which cannot be inferred from `facepath` — trap 2.
- `/fonts` lists .ttf **and** .otf itself (hud_web_state.c:338–378), filters
  directory hits and names `fontload` cannot pass (spaces/quotes) — traps 3, 4.
- `chooseFace` never trusts the command's 200: it waits, re-reads `/fonts`,
  and reports what actually happened (view/app.js) — trap 5. A face named in
  config but missing on disk still appears in the picker as "(not found)".
- `model.inertReason('proportional')` marks the per-element cvar inert with an
  explanation whenever no face is loaded ("renders at 8px"), or notes that
  picture styles ignore it (core/model.js:341–355).
- FTE backend: `/fonts` is stubbed honestly ("FTE renders its own fonts",
  core/fte-adapter.js) rather than offering a picker that does nothing; the
  import pipeline translates `gl_consolefont` → FTE's `gl_font` (same
  `textures/charsets/<name>.png` convention, fte/import.js) and waits for the
  engine to actually draw before applying, or the charset is lost and the
  layout shifts (spikes/fte-web/PARITY.md).

## Gaps — what "pick a font, ezHUD does the rest" still needs

Tracked as **custom-font-wizard** (issue #8):

1. **Per-element follow-through.** Picking a face should offer (or default to)
   setting `hud_*_proportional 1` across text-capable elements — and back to 0
   on "none". Requires the view to know which elements/styles are text.
2. **Style awareness.** Flag elements whose current style draws images as
   unaffected by the font; offer the 0→1 / 2→3 style switch; warn that
   style 3's golden numbers are charset offsets and render wrong with a TTF.
3. **Bake options in the UI** (outline, capitalize, gradients) with an
   automatic re-`fontload` so they take effect — the `font_` prefix is already
   allowlisted (hud_web.c:754); only UI is missing.
4. **Charset picker.** List `textures/charsets/*`, set `gl_consolefont`
   (validated via its cancel semantics), and explain the charset/proportional
   split in one place.
5. **Layout-shift warning.** Loading/unloading a face changes text element
   widths; `place` chains move. Say so at the moment it happens.
6. **Save hygiene.** A set-but-unloaded `font_facepath` should be caught at
   save time and offered for cleanup rather than baked into the config.
7. **Font installation.** The engine scans one OS directory; the tool cannot
   upload a font file. Either grow an upload path or state the directory.
8. **FTE parity.** No `fontload` equivalent exists; proportional fonts on the
   FTE backend would need a `gl_font`-style translation like the charset one.
