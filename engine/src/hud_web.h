/* hud_web.h — local HUD editor bridge.
 *
 * Exposes the live HUD to a local editor UI over loopback HTTP so an external
 * interface can read the engine's own geometry and drive it through the console,
 * rather than reimplementing placement and guessing at the result.
 *
 * Design constraints:
 *   - Opt-in. Disabled unless `hud_web 1`.
 *   - Loopback only (127.0.0.1). Never binds a routable address.
 *   - Token-gated. Binding to localhost is not an authorization boundary: any
 *     page the user visits can reach 127.0.0.1, so every request must carry the
 *     token minted when the bridge starts.
 *   - Non-blocking, serviced once per client frame next to Sys_ReadIPC(). The
 *     engine is single threaded; the bridge must never block the render loop.
 *
 * Ownership split:
 *   hud_web.c         transport: listener, HTTP parse, auth, routing, cvars
 *   hud_web_state.c   payload:   /state JSON and /frame.png capture
 *   hud_web_assets.c  the editor UI itself, baked in (generated)
 */
#ifndef __HUD_WEB_H__
#define __HUD_WEB_H__

#include "q_shared.h"

#define HUD_WEB_PROTOCOL 1
#define HUD_WEB_TOKEN_CHARS 32

/* ---- lifecycle (hud_web.c) ------------------------------------------------ */

void HUD_Web_Init(void);    /* register cvars/commands; binds nothing */
void HUD_Web_Shutdown(void);
void HUD_Web_Frame(void);   /* per-frame service; call next to Sys_ReadIPC() */

/* ---- payload (hud_web_state.c) --------------------------------------------
 * Both return heap blocks the caller must Q_free(). NULL on failure.
 * Both are only valid to call from the main loop with a current GL context. */

/* Engine-authoritative HUD state as JSON. Rects are the engine's own
 * hud->lx/ly/lw/lh from the last frame it drew the element, never recomputed. */
char *HUD_Web_StateJSON(size_t *out_len);

/* Current framebuffer as PNG, at native size; the UI scales for display. */
byte *HUD_Web_CapturePNG(size_t *out_len);

/* Fonts the user can pick from, plus whether the current one actually loaded. */
char *HUD_Web_FontsJSON(size_t *out_len);

/* The engine's 256-colour palette as hex strings. A colour cvar holding a single
 * number is a palette index (utils.c:137), and a pak can replace the palette, so
 * the editor asks rather than assumes. */
char *HUD_Web_PaletteJSON(size_t *out_len);

/* Where saving writes and what is already there, so the editor can warn about
 * an overwrite before it happens instead of after. */
char *HUD_Web_ConfigsJSON(size_t *out_len);

/* ---- editor UI (hud_web_assets.c, generated) -------------------------------
 * The editor is compiled into the engine so that running ezQuake is the whole
 * install: no second process, no folder of files to keep next to the binary.
 * Returns a pointer into static storage (never freed), or NULL for an unknown
 * path. "/" resolves to index.html. Regenerate with tools/embed_hud_web_ui.py. */
const unsigned char *HUD_Web_Asset(const char *path, size_t path_length,
	const char **content_type, size_t *length);

/* ---- command gating (hud_web.c, used by both) -----------------------------
 * /cmd feeds Cbuf_AddText, which can do anything the console can. The bridge
 * therefore accepts only what a HUD editor legitimately needs. Returns true if
 * the command line is permitted. */
qbool HUD_Web_CommandAllowed(const char *line);

#endif /* __HUD_WEB_H__ */
