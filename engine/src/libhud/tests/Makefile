# Standalone: no engine headers, no SDL, no GL.
CFLAGS = -std=c99 -Wall -Wextra -I..
test_place: test_place.c ../libhud_place.c ../libhud_place.h
	$(CC) $(CFLAGS) test_place.c ../libhud_place.c -o $@ -lm
check: test_place
	./test_place
	@# The editor is compiled in, so a UI edit that skips the generator ships a
	@# binary serving the previous version -- silently, and only in release.
	python3 ../../../tools/embed_hud_web_ui.py --check
clean:
	rm -f test_place
.PHONY: check clean
