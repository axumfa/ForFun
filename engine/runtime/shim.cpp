// LD_PRELOAD shim: logs the malloc family (operator new/delete go through it) to the file in $DSV_ALLOC_LOG.
// Log lines: "A <hex addr> <size>" (allocation), "F <hex addr>" (free) and "R <hex old> <hex new> <size>" (successful realloc of a live
// block; old is 0 for realloc(NULL, n); old == new when it grew/shrank in place). realloc(p, 0) is logged as "F p".
// Uses only write(2) (one call per line) and the glibc-internal __libc_* entry points: glibc required.
// Only the process that loaded the shim first is logged: forked children (pid != root) and exec'd children (env var removed) are silent.
#include <cerrno>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <fcntl.h>
#include <unistd.h>

extern "C" {
void* __libc_malloc(size_t); void* __libc_calloc(size_t, size_t); void* __libc_realloc(void*, size_t);
void __libc_free(void*); void* __libc_memalign(size_t, size_t);
}

static int fd = -1;        // -1 = not initialised (constructor not run yet), -2 = disabled
static pid_t root_pid = 0;
static volatile int lock_;

__attribute__((constructor(101))) static void dsv_init() {
  const char* p = getenv("DSV_ALLOC_LOG");
  if (!p) { fd = -2; return; }
  fd = open(p, O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0600);
  if (fd < 0) { fd = -2; return; }
  root_pid = getpid();
  unsetenv("DSV_ALLOC_LOG");   // exec'd children must not log into this file
}
static bool tracing() { return fd >= 0 && getpid() == root_pid; }

// The lock keeps "real operation + log line" atomic so log order matches the order memory was handed out/returned across threads.
struct Guard { Guard() { while (__atomic_exchange_n(&lock_, 1, __ATOMIC_ACQUIRE)) {} } ~Guard() { __atomic_store_n(&lock_, 0, __ATOMIC_RELEASE); } };

static size_t put_hex(char* b, uintptr_t v) { char t[20]; int n = 0; do { t[n++] = "0123456789abcdef"[v & 15]; v >>= 4; } while (v); size_t i = 0; while (n) b[i++] = t[--n]; return i; }
static size_t put_dec(char* b, size_t v) { char t[24]; int n = 0; do { t[n++] = char('0' + v % 10); v /= 10; } while (v); size_t i = 0; while (n) b[i++] = t[--n]; return i; }
/** One write() per line (atomic for O_APPEND files of this size). */
static void logA(void* p, size_t n) { char b[64]; size_t i = 0; b[i++] = 'A'; b[i++] = ' '; i += put_hex(b + i, (uintptr_t)p); b[i++] = ' '; i += put_dec(b + i, n); b[i++] = '\n'; ssize_t r = write(fd, b, i); (void)r; }
static void logR(void* o, void* p, size_t n) { char b[96]; size_t i = 0; b[i++] = 'R'; b[i++] = ' '; i += put_hex(b + i, (uintptr_t)o); b[i++] = ' '; i += put_hex(b + i, (uintptr_t)p); b[i++] = ' '; i += put_dec(b + i, n); b[i++] = '\n'; ssize_t r = write(fd, b, i); (void)r; }
static void logF(void* p) { char b[40]; size_t i = 0; b[i++] = 'F'; b[i++] = ' '; i += put_hex(b + i, (uintptr_t)p); b[i++] = '\n'; ssize_t r = write(fd, b, i); (void)r; }

extern "C" {
void* malloc(size_t n) noexcept {
  if (!tracing()) return __libc_malloc(n);
  Guard g; void* p = __libc_malloc(n); if (p) logA(p, n); return p;
}
void* calloc(size_t a, size_t b) noexcept {
  if (!tracing()) return __libc_calloc(a, b);
  Guard g; void* p = __libc_calloc(a, b); if (p) logA(p, a * b); return p;
}
void free(void* p) noexcept {
  if (!p) return;
  if (!tracing()) { __libc_free(p); return; }
  Guard g; logF(p); __libc_free(p);   // log first: once freed, another thread could be handed the same address
}
void free_sized(void* p, size_t) noexcept { free(p); }                 // glibc 2.43+; they bypass free() inside libc
void free_aligned_sized(void* p, size_t, size_t) noexcept { free(p); }

/** realloc: one "R old new size" record on success (old = 0 for realloc(NULL, n)). (p,0) frees: only F. Failure: nothing (p stays valid). */
void* realloc(void* p, size_t n) noexcept {
  if (!tracing()) return __libc_realloc(p, n);
  Guard g; void* q = __libc_realloc(p, n);
  if (p && n == 0) { logF(p); return nullptr; }   // glibc frees p and returns NULL
  if (q) logR(p, q, n);
  return q;
}
void* reallocarray(void* p, size_t a, size_t b) noexcept {
  size_t n; if (__builtin_mul_overflow(a, b, &n)) { errno = ENOMEM; return nullptr; }
  return realloc(p, n);
}

static void* aligned(size_t al, size_t n) {
  if (!tracing()) return __libc_memalign(al, n);
  Guard g; void* p = __libc_memalign(al, n); if (p) logA(p, n); return p;
}
void* memalign(size_t al, size_t n) noexcept { return aligned(al, n); }
void* aligned_alloc(size_t al, size_t n) noexcept { if (al == 0 || (al & (al - 1))) { errno = EINVAL; return nullptr; } return aligned(al, n); }
int posix_memalign(void** out, size_t al, size_t n) noexcept {
  if (al < sizeof(void*) || (al & (al - 1))) return EINVAL;   // does not touch errno, per POSIX
  void* p = aligned(al, n); if (!p) return ENOMEM;
  *out = p; return 0;
}
}
