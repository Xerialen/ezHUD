/* libhud_place.c — engine-free extraction of ezQuake's HUD placement geometry.
 *
 * Source: ezquake-source src/hud.c
 *   - HUD_CalcFrameExtents  (hud.c:837)
 *   - HUD_PrepareDraw       (hud.c:952), geometry only
 *
 * Arithmetic is preserved EXACTLY as upstream, including the integer truncation
 * of centred alignment, of fractional pos_x/pos_y, and of the caller's content
 * size. Those truncations are observable engine behaviour, so reproducing them
 * is the entire point of this unit.
 */
#include "libhud_place.h"

#define SBAR_HEIGHT       24
#define sbar_last_width  320   /* hud.c:50 */

#ifndef max
#define max(a,b) ((a) > (b) ? (a) : (b))
#endif
#ifndef min
#define min(a,b) ((a) < (b) ? (a) : (b))
#endif

/* hud.c:837 */
void hud_calc_frame_extents(const hud_props_t *props, int width, int height,
                            int *frame_left, int *frame_right,
                            int *frame_top, int *frame_bottom)
{
	if ((props->flags & LIBHUD_NO_GROW) && props->frame != 2) {
		*frame_left = *frame_right = *frame_top = *frame_bottom = 0;
		return;
	}

	if (props->frame == 2) {                 /* text box */
		int ax = (width % 16);
		int ay = (height % 8);
		*frame_left   = 8 + ax / 2;
		*frame_top    = 8 + ay / 2;
		*frame_right  = 8 + ax - ax / 2;
		*frame_bottom = 8 + ay - ay / 2;
	} else if (props->frame > 0 && props->frame <= 1) {
		int frame_x = 2, frame_y = 2;
		if (width  > 8) frame_x <<= 1;
		if (height > 8) frame_y <<= 1;
		*frame_left = *frame_right  = frame_x;
		*frame_top  = *frame_bottom = frame_y;
	} else {
		*frame_left = *frame_right = *frame_top = *frame_bottom = 0;
	}
}

/* hud.c:952 */
hud_rect_t hud_place(const hud_props_t *props, const hud_parent_t *parent,
                     const hud_screen_t *s, int width, int height)
{
	hud_rect_t out;
	int x, y;
	int frame_left, frame_right, frame_top, frame_bottom;
	int area_x, area_y, area_width, area_height;
	int bounds_x = 0, bounds_y = 0, bounds_width = 0, bounds_height = 0;

	hud_calc_frame_extents(props, width, height,
	                       &frame_left, &frame_right, &frame_top, &frame_bottom);

	width  += frame_left + frame_right;
	height += frame_top  + frame_bottom;

	switch (props->place_num) {
		default:
		case HUD_PLACE_SCREEN:
			bounds_x = bounds_y = 0;
			bounds_width  = s->vid_width;
			bounds_height = s->vid_height;
			break;
		case HUD_PLACE_TOP:
			bounds_x = bounds_y = 0;
			bounds_width  = s->vid_width;
			bounds_height = s->vid_height - s->sb_lines;
			break;
		case HUD_PLACE_VIEW:
			bounds_x      = s->vrect_x;
			bounds_y      = s->vrect_y;
			bounds_width  = s->vrect_width;
			bounds_height = s->vrect_height;
			break;
		case HUD_PLACE_SBAR:
			bounds_x = 0;
			bounds_y = s->vid_height - s->sb_lines;
			bounds_width  = sbar_last_width;
			bounds_height = s->sb_lines;
			break;
		case HUD_PLACE_IBAR:
			bounds_width  = sbar_last_width;
			bounds_height = max(s->sb_lines - SBAR_HEIGHT, 0);
			bounds_x = 0;
			bounds_y = s->vid_height - s->sb_lines;
			break;
		case HUD_PLACE_HBAR:
			bounds_width  = sbar_last_width;
			bounds_height = min(SBAR_HEIGHT, s->sb_lines);
			bounds_x = 0;
			bounds_y = s->vid_height - bounds_height;
			break;
		case HUD_PLACE_SFREE:
			bounds_x = sbar_last_width;
			bounds_y = s->vid_height - s->sb_lines;
			bounds_width  = s->vid_width - sbar_last_width;
			bounds_height = s->sb_lines;
			break;
		case HUD_PLACE_IFREE:
			bounds_width  = s->vid_width - sbar_last_width;
			bounds_height = max(s->sb_lines - SBAR_HEIGHT, 0);
			bounds_x = sbar_last_width;
			bounds_y = s->vid_height - s->sb_lines;
			break;
		case HUD_PLACE_HFREE:
			bounds_width  = s->vid_width - sbar_last_width;
			bounds_height = min(SBAR_HEIGHT, s->sb_lines);
			bounds_x = sbar_last_width;
			bounds_y = s->vid_height - bounds_height;
			break;
	}

	if (!parent || !parent->valid) {
		area_x = bounds_x; area_y = bounds_y;
		area_width = bounds_width; area_height = bounds_height;
	} else {
		area_x      = parent->lx;
		area_y      = parent->ly;
		area_width  = parent->lw;
		area_height = parent->lh;

		if (props->place_outside) {
			area_x      -= parent->al;
			area_y      -= parent->at;
			area_width  += parent->al + parent->ar;
			area_height += parent->at + parent->ab;
		}
	}

	switch (props->align_x_num) {
		default:
		case HUD_ALIGN_LEFT:   x = area_x; break;
		case HUD_ALIGN_CENTER: x = area_x + (area_width - width) / 2; break;
		case HUD_ALIGN_RIGHT:  x = area_x + area_width - width; break;
		case HUD_ALIGN_BEFORE: x = area_x - width; break;
		case HUD_ALIGN_AFTER:  x = area_x + area_width; break;
	}
	x += props->pos_x;

	switch (props->align_y_num) {
		default:
		case HUD_ALIGN_TOP:     y = area_y; break;
		case HUD_ALIGN_CENTER:  y = area_y + (area_height - height) / 2; break;
		case HUD_ALIGN_BOTTOM:  y = area_y + area_height - height; break;
		case HUD_ALIGN_BEFORE:  y = area_y - height; break;
		case HUD_ALIGN_AFTER:   y = area_y + area_height; break;
		case HUD_ALIGN_CONSOLE: y = max(area_y, s->scr_con_current); break;
	}
	y += props->pos_y;

	out.outer_x = x;
	out.outer_y = y;
	out.outer_w = width;
	out.outer_h = height;
	out.x = x + frame_left;
	out.y = y + frame_top;
	out.w = width  - frame_left - frame_right;
	out.h = height - frame_top  - frame_bottom;
	out.al = frame_left;
	out.ar = frame_right;
	out.at = frame_top;
	out.ab = frame_bottom;
	return out;
}
