/* libhud_place.h — engine-free HUD placement geometry.
 *
 * Extracted from ezquake-source src/hud.c (HUD_CalcFrameExtents, HUD_PrepareDraw).
 * The engine keeps ownership of visibility gating, cvar storage and frame drawing;
 * this unit answers exactly one question, as a pure function:
 *
 *     given an element's placement properties, its parent's resolved geometry,
 *     the screen state and a content size, where does the element go?
 *
 * No engine headers, no SDL, no GL, no globals. Every input is explicit so the
 * same code can back the engine, offline tooling and a WebAssembly build.
 */
#ifndef LIBHUD_PLACE_H
#define LIBHUD_PLACE_H

/* hud.h placement regions */
enum { HUD_PLACE_SCREEN = 1, HUD_PLACE_TOP, HUD_PLACE_VIEW,
       HUD_PLACE_SBAR, HUD_PLACE_IBAR, HUD_PLACE_HBAR,
       HUD_PLACE_SFREE, HUD_PLACE_IFREE, HUD_PLACE_HFREE };

/* hud.h alignment. Horizontal and vertical share 1..5; vertical adds CONSOLE. */
enum { HUD_ALIGN_LEFT = 1, HUD_ALIGN_CENTER, HUD_ALIGN_RIGHT,
       HUD_ALIGN_BEFORE, HUD_ALIGN_AFTER };
#define HUD_ALIGN_TOP     HUD_ALIGN_LEFT
#define HUD_ALIGN_BOTTOM  HUD_ALIGN_RIGHT
#define HUD_ALIGN_CONSOLE 6

/* Must equal HUD_NO_GROW (hud.h:36) or a caller passing engine flags straight in
 * gets the wrong answer. It was 1<<3 here, and the tests passed only because they
 * used this same wrong constant on both sides. */
#define LIBHUD_NO_GROW (1 << 9)

/* Every engine global HUD_PrepareDraw reads. Dimensions are console pixels. */
typedef struct {
	int vid_width, vid_height;
	int sb_lines;
	int scr_con_current;                              /* 0 when console closed */
	int vrect_x, vrect_y, vrect_width, vrect_height;  /* scr_vrect */
} hud_screen_t;

/* An element's placement inputs. */
typedef struct {
	int   place_num;                  /* HUD_PLACE_*; anchored elements pass SCREEN */
	int   align_x_num, align_y_num;   /* HUD_ALIGN_* */
	int   place_outside;              /* 1 = `place parent`, 0 = `place @parent` */
	int   flags;                      /* LIBHUD_NO_GROW */
	float pos_x, pos_y;
	float frame;
} hud_props_t;

/* A parent's already-resolved geometry. valid = 0 for unanchored elements. */
typedef struct {
	int valid;
	int lx, ly, lw, lh;   /* parent content rect */
	int al, ar, at, ab;   /* parent frame extents */
} hud_parent_t;

typedef struct {
	int x, y, w, h;                    /* content rect -> hud->lx/ly/lw/lh */
	int outer_x, outer_y;              /* framed origin, as HUD_DrawFrame expects */
	int outer_w, outer_h;              /* framed size */
	int al, ar, at, ab;                /* this element's frame extents */
} hud_rect_t;

/* hud.c:837 */
void hud_calc_frame_extents(const hud_props_t *props, int width, int height,
                            int *frame_left, int *frame_right,
                            int *frame_top, int *frame_bottom);

/* hud.c:952, geometry only. Pure: no allocation, no globals, no I/O. */
hud_rect_t hud_place(const hud_props_t *props, const hud_parent_t *parent,
                     const hud_screen_t *screen, int width, int height);

#endif /* LIBHUD_PLACE_H */
