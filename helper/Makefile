# nanocode-spawn — setuid worker spawner.
#
# Override paths at build time:
#   make NANOCODE_NODE=/usr/local/bin/node NANOCODE_WORKER=/opt/nanocode/worker/index.js

CC ?= cc
CFLAGS ?= -O2 -Wall -Wextra -Wpedantic -fstack-protector-strong
LDFLAGS ?= -Wl,-z,now -Wl,-z,relro

NANOCODE_NODE ?= /usr/bin/node
NANOCODE_WORKER ?= /usr/lib/nanocode/worker/index.js
NANOCODE_MIN_UID ?= 1000

CPPFLAGS = \
	-DNANOCODE_NODE='"$(NANOCODE_NODE)"' \
	-DNANOCODE_WORKER='"$(NANOCODE_WORKER)"' \
	-DNANOCODE_MIN_UID=$(NANOCODE_MIN_UID)

PREFIX ?= /usr/lib/nanocode

.PHONY: all clean install
all: nanocode-spawn

nanocode-spawn: nanocode-spawn.c
	$(CC) $(CFLAGS) $(CPPFLAGS) $(LDFLAGS) -o $@ $<

install: nanocode-spawn
	install -d -m 0750 -o root -g nanocode $(DESTDIR)$(PREFIX)
	install -m 4750 -o root -g nanocode nanocode-spawn $(DESTDIR)$(PREFIX)/nanocode-spawn

clean:
	rm -f nanocode-spawn
