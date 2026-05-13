/*
 * gnu_stub.c — minimal stubs for glibc symbols that gcompat does not expose.
 *
 * Bun FFI extracts and dlopen()s a native .so at runtime when certain
 * providers (e.g. lmstudio) are used.  That .so was compiled against glibc
 * and references gnu_get_libc_version / gnu_get_libc_release which are NOT
 * part of the musl ABI and are not provided by gcompat-1.x.
 *
 * This stub is compiled into /usr/local/lib/libgnustub.so and injected via
 * LD_PRELOAD so the symbol is available before any dlopen() call.
 */
const char *gnu_get_libc_version(void) { return "2.35"; }
const char *gnu_get_libc_release(void)  { return "stable"; }
