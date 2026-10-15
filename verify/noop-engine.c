/*
 * A stub engine for tests: accepts any arguments, exits 0, prints nothing.
 *
 * It exists to exercise one specific behaviour deterministically: moli can
 * succeed and still produce no output (a client-rendered page fetched with
 * --disable-js, dumped as markdown). The plugin used to report that as a
 * failure -- "moli exited with status 0 and no output" -- and sent the caller
 * off to moli_probe and waitSelector for a host that was never broken.
 *
 * The real engine's own command line is irrelevant here: the plugin only needs
 * an executable whose exit status is 0 and whose stdout is empty.
 *
 * Build:  gcc -O1 -o noop-engine.exe noop-engine.c        (Windows)
 *         gcc -O1 -o noop-engine noop-engine.c            (POSIX)
 */
#include <stdlib.h>

int main(int argc, char **argv) {
  (void)argc;
  (void)argv;
  return 0;
}
