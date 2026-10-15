/*
 * A stub engine for tests: accepts any arguments and exits 3, printing a short
 * message on stderr. It is the control for empty-verify.mjs, proving that the
 * "no output" path did not swallow genuine failures.
 *
 * Build:  gcc -O1 -o fail-engine.exe fail-engine.c     (Windows)
 *         gcc -O1 -o fail-engine fail-engine.c         (POSIX)
 */
#include <stdio.h>

int main(int argc, char **argv) {
  (void)argc;
  (void)argv;
  fputs("simulated engine failure\n", stderr);
  return 3;
}
