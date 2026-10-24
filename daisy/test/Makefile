# Host test: builds the portable engine + controls with the Mac/Linux compiler,
# runs the checks, then compares the audio against the JS engine.
CXX ?= c++
CXXFLAGS = -std=c++17 -O2 -Wall -Wextra -Wno-unused-parameter

all: run

host_test: host_test.cpp ../pulsar/core.cpp ../pulsar/controls.cpp ../pulsar/core.h ../pulsar/controls.h
	$(CXX) $(CXXFLAGS) host_test.cpp ../pulsar/core.cpp ../pulsar/controls.cpp -o host_test

run: host_test
	./host_test
	node compare.js

clean:
	rm -rf host_test out

.PHONY: all run clean
