/* hud_web_state.c — payload half of the HUD editor bridge.
 *
 * Produces the two things the editor UI needs from the engine:
 *
 *   HUD_Web_StateJSON()   every element's placement inputs AND the engine's own
 *                         resolved rect, so the UI never recomputes geometry
 *   HUD_Web_CapturePNG()  the actual rendered frame, so the UI never guesses at
 *                         appearance either
 *
 * Transport, auth and routing live in hud_web.c.
 */
#include "quakedef.h"
#include "hud.h"
#include "hud_web.h"
#include "image.h"
#include "r_renderer.h"
#include "version.h"
#include "fonts.h"   /* sys.h has no include guard; quakedef.h already pulls it in */
#include "config_manager.h"

extern hud_t   *hud_huds;
extern vrect_t  scr_vrect;
extern int      sb_lines;
extern float    scr_con_current;
extern cvar_t   image_png_compression_level;
extern cvar_t   gl_consolefont;     /* 8px charset */

/* Which HUD is drawn is four independent axes, not one setting. */
extern cvar_t   scr_newHud;         /* "scr_newhud": 0 classic, 1 new, 2 both  */
extern cvar_t   cl_hud;             /* QW262 HUD, stacks on top of either      */
extern cvar_t   cl_sbar;            /* classic bar: standard vs heads-up       */
extern cvar_t   scr_viewsize;       /* cvar is named "viewsize"                */
extern cvar_t   scr_compactHud;     /* classic bar sub-style, 0-4              */

/* ------------------------------------------------------------------------- */
/* growable text buffer                                                       */
/* ------------------------------------------------------------------------- */

typedef struct {
	char  *p;
	size_t len, cap;
	qbool  failed;
} sbuf_t;

static void sb_reserve(sbuf_t *b, size_t extra)
{
	size_t want;

	if (b->failed) {
		return;
	}
	if (b->len + extra + 1 <= b->cap) {
		return;
	}
	want = b->cap ? b->cap : 8192;
	while (want < b->len + extra + 1) {
		want *= 2;
	}
	b->p = Q_realloc(b->p, want);
	if (!b->p) {
		b->failed = true;
		return;
	}
	b->cap = want;
}

static void sb_puts(sbuf_t *b, const char *s)
{
	size_t n;

	if (!s) {
		s = "";
	}
	n = strlen(s);
	sb_reserve(b, n);
	if (b->failed) {
		return;
	}
	memcpy(b->p + b->len, s, n);
	b->len += n;
	b->p[b->len] = '\0';
}

static void sb_printf(sbuf_t *b, const char *fmt, ...)
{
	va_list argptr;
	char scratch[1024];

	va_start(argptr, fmt);
	vsnprintf(scratch, sizeof(scratch), fmt, argptr);
	va_end(argptr);
	sb_puts(b, scratch);
}

/* JSON string literal, including the surrounding quotes. */
/* JSON has no infinity and no NaN, but a cvar can hold both: Q_atof overflows a
 * long enough decimal to inf, and /cmd accepts lines up to 1023 bytes, so a value
 * a client is allowed to set can otherwise emit `"pos_x":inf` and make the whole
 * payload unparseable -- which stops the editor's polling dead. Clamp to something
 * finite and let the raw string in `cvars` carry what the user actually typed. */
static void sb_json_number(sbuf_t *b, const char *key, float v)
{
	if (isnan(v)) {
		v = 0.0f;
	} else if (isinf(v)) {
		v = v > 0 ? FLT_MAX : -FLT_MAX;
	}
	sb_printf(b, ",\"%s\":%g", key, v);
}

static void sb_json_string(sbuf_t *b, const char *s)
{
	sb_puts(b, "\"");
	if (s) {
		for (; *s; s++) {
			unsigned char c = (unsigned char)*s;

			switch (c) {
				case '\"': sb_puts(b, "\\\""); break;
				case '\\': sb_puts(b, "\\\\"); break;
				case '\n': sb_puts(b, "\\n");  break;
				case '\r': sb_puts(b, "\\r");  break;
				case '\t': sb_puts(b, "\\t");  break;
				default:
					/* Quake strings carry 8-bit "brown" characters and control
					 * codes that are not valid JSON; escape anything outside
					 * printable ASCII so the payload is always parseable. */
					if (c < 0x20 || c > 0x7e) {
						sb_printf(b, "\\u%04x", c);
					} else {
						char one[2] = { (char)c, '\0' };
						sb_puts(b, one);
					}
					break;
			}
		}
	}
	sb_puts(b, "\"");
}

/* ------------------------------------------------------------------------- */
/* /state                                                                     */
/* ------------------------------------------------------------------------- */

static void HUD_Web_WriteElement(sbuf_t *b, hud_t *hud)
{
	int i;
	qbool first_param;
	/* "Laid out this frame", which is not quite "you can see it". HUD_PrepareDraw
	 * stamps last_draw_sequence before its caller draws any pixels (hud.c:1180),
	 * and several elements call it before their own condition — tracking before the
	 * spectator check (hud_tracking.c:56), the health and armor bars before their
	 * POV check (hud_health.c:90, hud_armor.c:195). So an element can report a rect
	 * and still put nothing on screen. It is still the right thing to report: the
	 * rect is where the element WOULD be, which is what a placement editor needs.
	 * Anything stronger would need every draw function to signal completion. */
	qbool drawn = (hud->last_draw_sequence == host_screenupdatecount);

	sb_puts(b, "{");
	sb_puts(b, "\"name\":");
	sb_json_string(b, hud->name);

	sb_puts(b, ",\"description\":");
	sb_json_string(b, hud->description);

	sb_printf(b, ",\"shown\":%s", (hud->show && hud->show->value) ? "true" : "false");
	sb_printf(b, ",\"drawn\":%s", drawn ? "true" : "false");

	sb_puts(b, ",\"place\":");
	sb_json_string(b, hud->place ? hud->place->string : "screen");

	sb_puts(b, ",\"parent\":");
	if (hud->place_hud) {
		sb_json_string(b, hud->place_hud->name);
	} else {
		sb_puts(b, "null");
	}
	sb_printf(b, ",\"place_outside\":%s", hud->place_outside ? "true" : "false");

	sb_puts(b, ",\"align_x\":");
	sb_json_string(b, hud->align_x ? hud->align_x->string : "left");
	sb_puts(b, ",\"align_y\":");
	sb_json_string(b, hud->align_y ? hud->align_y->string : "top");

	sb_json_number(b, "pos_x", hud->pos_x ? hud->pos_x->value : 0.0f);
	sb_json_number(b, "pos_y", hud->pos_y ? hud->pos_y->value : 0.0f);
	sb_json_number(b, "order", hud->order ? hud->order->value : 0.0f);
	sb_json_number(b, "frame", hud->frame ? hud->frame->value : 0.0f);
	sb_json_number(b, "opacity", hud->opacity ? hud->opacity->value : 1.0f);

	/* What HUD_Register asked for, so a reset can say what it is about to change
	 * instead of asking the user to trust it. cvar_t keeps defaultvalue from
	 * Cvar_Register (cvar.c:399) before the config-adoption path, so this is the
	 * value compiled into the engine and never the one the user's config set. */
	sb_puts(b, ",\"defaults\":{");
	sb_puts(b, "\"show\":");
	sb_json_string(b, hud->show ? hud->show->defaultvalue : "");
	sb_puts(b, ",\"place\":");
	sb_json_string(b, hud->place ? hud->place->defaultvalue : "");
	sb_puts(b, ",\"align_x\":");
	sb_json_string(b, hud->align_x ? hud->align_x->defaultvalue : "");
	sb_puts(b, ",\"align_y\":");
	sb_json_string(b, hud->align_y ? hud->align_y->defaultvalue : "");
	sb_puts(b, ",\"pos_x\":");
	sb_json_string(b, hud->pos_x ? hud->pos_x->defaultvalue : "");
	sb_puts(b, ",\"pos_y\":");
	sb_json_string(b, hud->pos_y ? hud->pos_y->defaultvalue : "");
	sb_puts(b, "}");

	sb_printf(b, ",\"flags\":%u",  hud->flags);
	/* Named rather than leaving the UI to decode a bitfield it would have to keep
	 * in sync with hud.h by hand. */
	sb_printf(b, ",\"spec_required\":%s", (hud->flags & HUD_SPEC_REQUIRED) ? "true" : "false");
	sb_printf(b, ",\"needs_pov\":%s",     (hud->flags & HUD_NEEDS_POV) ? "true" : "false");

	if (drawn) {
		sb_printf(b, ",\"rect\":{\"x\":%d,\"y\":%d,\"w\":%d,\"h\":%d}",
		          hud->lx, hud->ly, hud->lw, hud->lh);
		sb_printf(b, ",\"frame_extents\":{\"l\":%d,\"r\":%d,\"t\":%d,\"b\":%d}",
		          hud->al, hud->ar, hud->at, hud->ab);
	} else {
		sb_puts(b, ",\"rect\":null,\"frame_extents\":null");
	}

	/* Registered per-element parameters, by their real cvar names, so the UI can
	 * offer them generically without a hardcoded table per element. */
	sb_puts(b, ",\"cvars\":{");
	for (i = 0, first_param = true; i < hud->num_params; i++) {
		cvar_t *v = hud->params ? hud->params[i] : NULL;

		/* Track emission separately from the index: a skipped entry must not
		 * leave a dangling separator, which would make the payload invalid. */
		if (!v || !v->name) {
			continue;
		}
		if (!first_param) {
			sb_puts(b, ",");
		}
		first_param = false;
		sb_json_string(b, v->name);
		sb_puts(b, ":");
		sb_json_string(b, v->string);
	}
	sb_puts(b, "}}");
}

char *HUD_Web_StateJSON(size_t *out_len)
{
	sbuf_t b;
	hud_t *hud;
	qbool first = true;

	memset(&b, 0, sizeof(b));

	sb_printf(&b, "{\"protocol\":%d", HUD_WEB_PROTOCOL);
	sb_puts(&b, ",\"engine\":");
	sb_json_string(&b, VersionString());

	/* Console-pixel canvas: the coordinate system every rect below is in. */
	sb_printf(&b, ",\"screen\":{\"vid_width\":%d,\"vid_height\":%d",
	          (int)vid.width, (int)vid.height);
	sb_printf(&b, ",\"sb_lines\":%d,\"scr_con_current\":%d",
	          sb_lines, (int)scr_con_current);
	sb_printf(&b, ",\"vrect\":[%d,%d,%d,%d]}",
	          scr_vrect.x, scr_vrect.y, scr_vrect.width, scr_vrect.height);

	/* Which HUD systems are drawing, as separate axes rather than one setting,
	 * because that is what the engine actually has:
	 *   scr_newhud 0/1/2   classic only / new only / both (hud.c:1539, sbar.c:2412)
	 *   cl_hud             the QW262 HUD, drawn outside any scr_newhud test
	 *                      (cl_screen.c:807), so it stacks on either
	 *   cl_sbar, viewsize  shape of the classic bar, and coupled: viewsize below
	 *                      100 forces standard mode regardless of cl_sbar
	 *                      (sbar.c:156), and 120 removes the bar entirely by
	 *                      driving sb_lines to 0 (cl_screen.c:324)
	 *   scr_compacthud     classic sub-style 0-4 (sbar.c:2431) */
	sb_printf(&b, ",\"hud_modes\":{\"scr_newhud\":%d,\"cl_hud\":%d",
	          scr_newHud.integer, cl_hud.integer);
	sb_printf(&b, ",\"cl_sbar\":%d,\"viewsize\":%g,\"scr_compacthud\":%d",
	          cl_sbar.integer, scr_viewsize.value, scr_compactHud.integer);
	/* Derived, so the UI does not have to re-implement Sbar_IsStandardBar. */
	sb_printf(&b, ",\"classic_drawn\":%s", scr_newHud.integer != 1 ? "true" : "false");
	sb_printf(&b, ",\"new_drawn\":%s", scr_newHud.integer != 0 ? "true" : "false");
	sb_printf(&b, ",\"standard_bar\":%s",
	          (cl_sbar.value || scr_viewsize.value < 100) ? "true" : "false");
	sb_puts(&b, "}");

	/* Font state. proportional_loaded is the one that matters and cannot be
	 * inferred client-side: font_facepath being non-empty does not mean a face
	 * loaded, because Draw_InitFont discards FontCreate's result at startup. With
	 * no face, every `proportional 1` silently renders at 8px. */
	sb_puts(&b, ",\"fonts\":{\"proportional_loaded\":");
	sb_puts(&b, FontProportionalLoaded() ? "true" : "false");
	sb_puts(&b, ",\"facepath\":");
	sb_json_string(&b, FontFacePath());
	sb_puts(&b, ",\"consolefont\":");
	sb_json_string(&b, gl_consolefont.string);
	sb_puts(&b, "}");

	/* Viewing context. Without this the UI can only say an element has no rect;
	 * with it, it can say why: free-flying spectators get no player POV. */
	sb_printf(&b, ",\"view\":{\"spectator\":%s,\"tracking\":%s,\"demoplayback\":%s}",
	          cl.spectator ? "true" : "false",
	          (cl.autocam == CAM_TRACK) ? "true" : "false",
	          cls.demoplayback ? "true" : "false");

	/* Physical resolution, so the UI can show the real pixel size alongside. */
	sb_printf(&b, ",\"physical\":[%d,%d]", (int)glwidth, (int)glheight);

	sb_puts(&b, ",\"elements\":[");
	for (hud = hud_huds; hud; hud = hud->next) {
		if (!first) {
			sb_puts(&b, ",");
		}
		first = false;
		HUD_Web_WriteElement(&b, hud);
	}
	sb_puts(&b, "]}");

	if (b.failed) {
		Q_free(b.p);
		return NULL;
	}
	if (out_len) {
		*out_len = b.len;
	}
	return b.p;
}

/* ------------------------------------------------------------------------- */
/* /fonts                                                                     */
/* ------------------------------------------------------------------------- */

/* Enumerate what the user could actually pick.
 *
 * Note the engine's own `fontlist` filters on ".ttf" only, so a perfectly valid
 * .otf face never appears there even though FontCreate loads it happily. Listing
 * both is the difference between a picker that works and one that hides the
 * user's font from them. */
static void HUD_Web_ListFaces(sbuf_t *b, const char *dir_path, const char *ext, qbool *first)
{
	dir_t dir = Sys_listdir(dir_path, ext, SORT_BY_NAME);
	int i;

	size_t ext_length = strlen(ext);

	for (i = 0; i < dir.numfiles; i++) {
		size_t name_length;

		if (dir.files[i].isdir) {
			continue;
		}
		/* Sys_listdir treats the extension as an unanchored regex, so "foo.ttf.bak"
		 * matches. Offering a face the engine cannot load is worse than not listing
		 * it, so check the real suffix the same way the config listing does. */
		name_length = strlen(dir.files[i].name);
		if (name_length <= ext_length ||
				strcasecmp(dir.files[i].name + name_length - ext_length, ext)) {
			continue;
		}
		/* `fontload` takes exactly one argument (fonts.c:441) and the bridge sends it
		 * unquoted, so a name containing a space would load nothing and report
		 * nothing. Listing it would be offering something that cannot work. */
		if (strchr(dir.files[i].name, ' ') || strchr(dir.files[i].name, '\t') ||
				strchr(dir.files[i].name, '"')) {
			continue;
		}
		if (!*first) {
			sb_puts(b, ",");
		}
		*first = false;
		sb_json_string(b, dir.files[i].name);
	}
}

static void HUD_Web_ListConfigs(sbuf_t *b, const char *dir_path)
{
	dir_t dir = Sys_listdir(dir_path, ".cfg", SORT_BY_NAME);
	qbool first = true;
	int i;

	for (i = 0; i < dir.numfiles; i++) {
		size_t length = strlen(dir.files[i].name);

		if (dir.files[i].isdir) {
			continue;
		}
		/* Sys_listdir's extension filter matches anywhere in the name, so it also
		 * returns things like ".config.cfg.swp". Those are not configs and must not
		 * appear as something the user could be about to overwrite. */
		if (length < 4 || strcasecmp(dir.files[i].name + length - 4, ".cfg")) {
			continue;
		}
		if (!first) {
			sb_puts(b, ",");
		}
		first = false;
		sb_json_string(b, dir.files[i].name);
	}
}

/* Where saving actually writes, and what is already there.
 *
 * Two directories, not one, and that is an engine quirk rather than a choice
 * here: cfg_save honours cfg_use_home and cfg_use_gamedir via Cfg_GetConfigPath
 * (config_manager.c:1131), while hud_export hardcodes <basedir>/ezquake/configs
 * (config_manager.c:893). They are the same path in the default setup and
 * different the moment cfg_use_home is on, so both are reported and the UI says
 * which one a given save mode uses. */
/* The engine's actual palette, so a palette-index swatch shows the colour the
 * player will really see. gfx/palette.lmp can be replaced by a pak, so this must
 * be read from the engine rather than assumed. */
char *HUD_Web_PaletteJSON(size_t *out_len)
{
	sbuf_t b;
	int i;

	memset(&b, 0, sizeof(b));
	sb_printf(&b, "{\"protocol\":%d,\"colors\":[", HUD_WEB_PROTOCOL);
	for (i = 0; i < 256; i++) {
		const byte *c = host_basepal + i * 3;
		sb_printf(&b, "%s\"#%02x%02x%02x\"", i ? "," : "", c[0], c[1], c[2]);
	}
	sb_puts(&b, "]}");

	if (b.failed) {
		Q_free(b.p);
		return NULL;
	}
	if (out_len) {
		*out_len = b.len;
	}
	return b.p;
}

char *HUD_Web_ConfigsJSON(size_t *out_len)
{
	extern cvar_t cfg_backup;
	sbuf_t b;
	char config_dir[MAX_OSPATH];
	char export_dir[MAX_OSPATH];

	memset(&b, 0, sizeof(b));
	Cfg_GetConfigPath(config_dir, sizeof(config_dir), "");
	snprintf(export_dir, sizeof(export_dir), "%s/ezquake/configs/", com_basedir);

	sb_printf(&b, "{\"protocol\":%d", HUD_WEB_PROTOCOL);
	sb_puts(&b, ",\"config_dir\":");
	sb_json_string(&b, config_dir);
	sb_puts(&b, ",\"export_dir\":");
	sb_json_string(&b, export_dir);
	sb_puts(&b, ",\"main\":");
	sb_json_string(&b, MAIN_CONFIG_FILENAME);
	/* Defaults to 0: without it, overwriting keeps nothing of the old file. */
	sb_printf(&b, ",\"backup_enabled\":%s", cfg_backup.integer ? "true" : "false");

	sb_puts(&b, ",\"available\":[");
	HUD_Web_ListConfigs(&b, config_dir);
	/* Listed separately rather than merged: an overwrite warning has to be about
	 * the directory the chosen save mode actually writes to. */
	sb_puts(&b, "],\"exports\":[");
	HUD_Web_ListConfigs(&b, export_dir);
	sb_puts(&b, "]}");

	if (b.failed) {
		Q_free(b.p);
		return NULL;
	}
	if (out_len) {
		*out_len = b.len;
	}
	return b.p;
}

char *HUD_Web_FontsJSON(size_t *out_len)
{
	sbuf_t b;
	const char *dir_path = Sys_FontsDirectory();
	qbool first = true;

	memset(&b, 0, sizeof(b));
	sb_printf(&b, "{\"protocol\":%d", HUD_WEB_PROTOCOL);
	sb_puts(&b, ",\"directory\":");
	sb_json_string(&b, dir_path);
	sb_puts(&b, ",\"facepath\":");
	sb_json_string(&b, FontFacePath());
	sb_printf(&b, ",\"proportional_loaded\":%s", FontProportionalLoaded() ? "true" : "false");
	sb_puts(&b, ",\"consolefont\":");
	sb_json_string(&b, gl_consolefont.string);

	sb_puts(&b, ",\"available\":[");
	HUD_Web_ListFaces(&b, dir_path, ".ttf", &first);
	HUD_Web_ListFaces(&b, dir_path, ".otf", &first);
	sb_puts(&b, "]}");

	if (b.failed) {
		Q_free(b.p);
		return NULL;
	}
	if (out_len) {
		*out_len = b.len;
	}
	return b.p;
}

/* ------------------------------------------------------------------------- */
/* /frame.png                                                                 */
/* ------------------------------------------------------------------------- */

byte *HUD_Web_CapturePNG(float scale, size_t *out_len)
{
	size_t width  = renderer.ScreenshotWidth();
	size_t height = renderer.ScreenshotHeight();
	size_t buffer_size = width * height * 3;
	byte *pixels = NULL, *png = NULL;

	/* v0 captures at native size; the UI scales for display. Downsampling here
	 * would only matter over a real network, and this bridge is loopback only. */
	(void)scale;

	if (!width || !height) {
		return NULL;
	}

	pixels = (byte *)Q_malloc(buffer_size);
	if (!pixels) {
		return NULL;
	}
	renderer.Screenshot(pixels, buffer_size);

	/* Encoded straight to memory. This used to stage through a fixed path under
	 * /tmp, which another local user could pre-create as a symlink to any file the
	 * player can write -- opening the editor would then clobber it with PNG data --
	 * and which left a screenshot of the player's game lying around afterwards.
	 * Image_EncodePNG uses the same libpng settings, so the result is byte-identical
	 * to what a normal screenshot would have produced. */
	png = Image_EncodePNG(image_png_compression_level.value, pixels, width, height, out_len);
	Q_free(pixels);
	return png;
}
