/* test_place.c — self-contained tests for the HUD placement core.
 *
 * Builds with plain gcc; no engine headers, no SDL, no GL:
 *     make check
 *
 * Every expected value is derived by hand from src/hud.c, not captured from this
 * implementation's output, so the suite pins the engine's semantics rather than
 * its own. Screen is 640x360 with sb_lines 48 throughout.
 */
#include <stdio.h>
#include <string.h>
#include "libhud_place.h"

static int failures = 0, checks = 0;

static const hud_screen_t SCREEN = { 640, 360, 48, 0, 0, 0, 640, 360 };

static hud_props_t mk(int place, int ax, int ay, float px, float py, float frame, int flags)
{
	hud_props_t p;
	memset(&p, 0, sizeof(p));
	p.place_num = place;
	p.align_x_num = ax;
	p.align_y_num = ay;
	p.pos_x = px;
	p.pos_y = py;
	p.frame = frame;
	p.flags = flags;
	return p;
}

static void check(const char *what, hud_rect_t r, int ex, int ey, int ew, int eh)
{
	checks++;
	if (r.x != ex || r.y != ey || r.w != ew || r.h != eh) {
		failures++;
		printf("FAIL %-48s got %d,%d,%d,%d want %d,%d,%d,%d\n",
		       what, r.x, r.y, r.w, r.h, ex, ey, ew, eh);
	}
}

static void expect(const char *what, hud_props_t p, int w, int h,
                   int ex, int ey, int ew, int eh)
{
	check(what, hud_place(&p, NULL, &SCREEN, w, h), ex, ey, ew, eh);
}

int main(void)
{
	/* --- the nine placement regions, 40x10 content aligned right/bottom ----
	 * screen 640x360; top = height - sb_lines = 312; the bar regions derive
	 * from sb_lines 48, SBAR_HEIGHT 24 and sbar_last_width 320. */
	expect("place screen", mk(HUD_PLACE_SCREEN, HUD_ALIGN_RIGHT, HUD_ALIGN_BOTTOM, 0,0,0,0), 40,10, 600,350,40,10);
	expect("place top",    mk(HUD_PLACE_TOP,    HUD_ALIGN_RIGHT, HUD_ALIGN_BOTTOM, 0,0,0,0), 40,10, 600,302,40,10);
	expect("place view (vrect = full screen here)",
	                       mk(HUD_PLACE_VIEW,   HUD_ALIGN_RIGHT, HUD_ALIGN_BOTTOM, 0,0,0,0), 40,10, 600,350,40,10);
	expect("place sbar",   mk(HUD_PLACE_SBAR,   HUD_ALIGN_RIGHT, HUD_ALIGN_BOTTOM, 0,0,0,0), 40,10, 280,350,40,10);
	expect("place ibar",   mk(HUD_PLACE_IBAR,   HUD_ALIGN_RIGHT, HUD_ALIGN_BOTTOM, 0,0,0,0), 40,10, 280,326,40,10);
	expect("place hbar",   mk(HUD_PLACE_HBAR,   HUD_ALIGN_RIGHT, HUD_ALIGN_BOTTOM, 0,0,0,0), 40,10, 280,350,40,10);
	expect("place sfree",  mk(HUD_PLACE_SFREE,  HUD_ALIGN_RIGHT, HUD_ALIGN_BOTTOM, 0,0,0,0), 40,10, 600,350,40,10);
	expect("place ifree",  mk(HUD_PLACE_IFREE,  HUD_ALIGN_RIGHT, HUD_ALIGN_BOTTOM, 0,0,0,0), 40,10, 600,326,40,10);
	expect("place hfree",  mk(HUD_PLACE_HFREE,  HUD_ALIGN_RIGHT, HUD_ALIGN_BOTTOM, 0,0,0,0), 40,10, 600,350,40,10);

	/* --- horizontal alignment, 20x10 content, pos_x 3 --------------------- */
	expect("align_x left",   mk(HUD_PLACE_SCREEN, HUD_ALIGN_LEFT,   HUD_ALIGN_TOP, 3,0,0,0), 20,10,   3,0,20,10);
	expect("align_x center", mk(HUD_PLACE_SCREEN, HUD_ALIGN_CENTER, HUD_ALIGN_TOP, 3,0,0,0), 20,10, 313,0,20,10);
	expect("align_x right",  mk(HUD_PLACE_SCREEN, HUD_ALIGN_RIGHT,  HUD_ALIGN_TOP, 3,0,0,0), 20,10, 623,0,20,10);
	expect("align_x before", mk(HUD_PLACE_SCREEN, HUD_ALIGN_BEFORE, HUD_ALIGN_TOP, 3,0,0,0), 20,10, -17,0,20,10);
	expect("align_x after",  mk(HUD_PLACE_SCREEN, HUD_ALIGN_AFTER,  HUD_ALIGN_TOP, 3,0,0,0), 20,10, 643,0,20,10);
	/* odd delta pins integer division: (640-21)/2 == 309, never 310 */
	expect("align_x center, odd width truncates",
	                         mk(HUD_PLACE_SCREEN, HUD_ALIGN_CENTER, HUD_ALIGN_TOP, 0,0,0,0), 21,10, 309,0,21,10);

	/* --- vertical alignment, 20x10 content, pos_y 2 ----------------------- */
	expect("align_y top",    mk(HUD_PLACE_SCREEN, HUD_ALIGN_LEFT, HUD_ALIGN_TOP,     0,2,0,0), 20,10, 0,  2,20,10);
	expect("align_y center", mk(HUD_PLACE_SCREEN, HUD_ALIGN_LEFT, HUD_ALIGN_CENTER,  0,2,0,0), 20,10, 0,177,20,10);
	expect("align_y bottom", mk(HUD_PLACE_SCREEN, HUD_ALIGN_LEFT, HUD_ALIGN_BOTTOM,  0,2,0,0), 20,10, 0,352,20,10);
	expect("align_y before", mk(HUD_PLACE_SCREEN, HUD_ALIGN_LEFT, HUD_ALIGN_BEFORE,  0,2,0,0), 20,10, 0, -8,20,10);
	expect("align_y after",  mk(HUD_PLACE_SCREEN, HUD_ALIGN_LEFT, HUD_ALIGN_AFTER,   0,2,0,0), 20,10, 0,362,20,10);
	expect("align_y console (closed)",
	                         mk(HUD_PLACE_SCREEN, HUD_ALIGN_LEFT, HUD_ALIGN_CONSOLE, 0,2,0,0), 20,10, 0,  2,20,10);
	expect("align_y center, odd height truncates",
	                         mk(HUD_PLACE_SCREEN, HUD_ALIGN_LEFT, HUD_ALIGN_CENTER,  0,0,0,0), 20,11, 0,174,20,11);

	/* --- frame extents ----------------------------------------------------
	 * frame 2, 29x13: ax=29%16=13, ay=13%8=5 -> l=8+6=14 t=8+2=10 r=8+13-6=15 b=8+5-2=11 */
	expect("frame 2 modulo extents",
	       mk(HUD_PLACE_SCREEN, HUD_ALIGN_LEFT, HUD_ALIGN_TOP, 0,0,2,0), 29,13, 14,10,29,13);
	expect("frame 0.5 extents",
	       mk(HUD_PLACE_SCREEN, HUD_ALIGN_LEFT, HUD_ALIGN_TOP, 0,0,0.5f,0), 200,100, 4,4,200,100);
	/* LIBHUD_NO_GROW suppresses the frame unless frame == 2. Groups carry the
	 * flag, so their children anchor to an unpadded rect. */
	expect("frame 0.5 + NO_GROW suppressed",
	       mk(HUD_PLACE_SCREEN, HUD_ALIGN_LEFT, HUD_ALIGN_TOP, 0,0,0.5f,LIBHUD_NO_GROW), 200,100, 0,0,200,100);
	expect("frame 2 survives NO_GROW",
	       mk(HUD_PLACE_SCREEN, HUD_ALIGN_LEFT, HUD_ALIGN_TOP, 0,0,2,LIBHUD_NO_GROW), 29,13, 14,10,29,13);

	/* --- fractional pos truncates, because x/y are ints -------------------- */
	expect("fractional pos truncates toward zero",
	       mk(HUD_PLACE_SCREEN, HUD_ALIGN_LEFT, HUD_ALIGN_TOP, 12.34f,7.65f,0,0), 45,20, 12,7,45,20);

	/* --- parent anchoring -------------------------------------------------
	 * Parent at 100,50 sized 200x100 with a style-1 frame (4 a side). Plain
	 * `place parent` anchors OUTSIDE the frame; `@parent` anchors INSIDE. */
	{
		hud_props_t pp = mk(HUD_PLACE_SCREEN, HUD_ALIGN_LEFT, HUD_ALIGN_TOP, 100,50,1,0);
		hud_rect_t  pr = hud_place(&pp, NULL, &SCREEN, 200, 100);
		hud_parent_t parent;
		hud_props_t child;

		check("anchor parent content rect", pr, 104,54,200,100);

		parent.valid = 1;
		parent.lx = pr.x;  parent.ly = pr.y;  parent.lw = pr.w;  parent.lh = pr.h;
		parent.al = pr.al; parent.ar = pr.ar; parent.at = pr.at; parent.ab = pr.ab;

		/* outside: area = 100,50 208x108 */
		child = mk(HUD_PLACE_SCREEN, HUD_ALIGN_RIGHT, HUD_ALIGN_BOTTOM, 0,0,0,0);
		child.place_outside = 1;
		check("anchor outside parent frame",
		      hud_place(&child, &parent, &SCREEN, 10, 6), 298,152,10,6);

		/* inside: area = 104,54 200x100 */
		child.place_outside = 0;
		check("anchor inside parent content",
		      hud_place(&child, &parent, &SCREEN, 10, 6), 294,148,10,6);
	}

	printf("%d checks, %d failures\n", checks, failures);
	return failures ? 1 : 0;
}
