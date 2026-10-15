/*
 * A stub engine for tests: accepts any arguments, exits 0, prints nothing on
 * stdout, and writes a complaint on stderr.
 *
 * It pins one boundary in runFetch: silence on both streams means the page had
 * no content and is reported as a successful empty fetch, but a complaint on
 * stderr with no stdout is something the caller still needs to see, so that
 * combination must stay on the failure path.
 *
 * Build:  gcc -O1 -o warn-engine.exe warn-engine.c     (Windows)
 *         gcc -O1 -o warn-engine warn-engine.c         (POSIX)
 */
#include <stdio.h>

int main(int argc, char **argv) {
  (void)argc;
  (void)argv;
  fputs("warning: nothing was extracted for this dump format\n", stderr);
  return 0;
}
