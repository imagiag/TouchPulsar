# Pulsar Touch firmware for the Synthux Simple Touch (Daisy Seed)
TARGET = PulsarTouch

# DEBUG = 1 prints CPU load over USB serial (disables USB MIDI)
# DEBUG = 1

CPP_SOURCES = PulsarTouch.cpp $(wildcard pulsar/*.cpp) $(wildcard ui/*.cpp) $(wildcard touch/*.cpp)
C_INCLUDES = -Icommon/ -Itouch/

# libDaisy: git submodule in lib/libDaisy (Synthux's fork, pinned).
# Clone with --recurse-submodules, or run: git submodule update --init
LIBDAISY_DIR ?= lib/libDaisy
# No DaisySP needed.

SYSTEM_FILES_DIR = $(LIBDAISY_DIR)/core
include $(SYSTEM_FILES_DIR)/Makefile

CPP_STANDARD = -std=gnu++17
# -Os keeps the 128 KB internal flash comfortable; pulsar/core.cpp forces -O3 for the audio path.
OPT = -Os
ifeq ($(DEBUG),1)
C_DEFS += -DDEBUG=1
endif
LDFLAGS += -Wl,--no-warn-rwx-segments

libs:
	cd $(LIBDAISY_DIR) && $(MAKE)
