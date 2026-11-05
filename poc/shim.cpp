// LD_PRELOAD shim: logs operator new/delete to the file in $DSV_ALLOC_LOG. Uses only write(2) (no allocation).
#include <cstdlib>
#include <cstdio>
#include <cstring>
#include <new>
#include <fcntl.h>
#include <unistd.h>
static int fd = -1;
static void init() { if (fd < 0) { const char* p = getenv("DSV_ALLOC_LOG"); fd = p ? open(p, O_WRONLY|O_APPEND|O_CREAT, 0600) : -2; } }
static void logline(char op, void* p, size_t n) {
    init(); if (fd < 0) return;
    char b[64]; int len = snprintf(b, sizeof b, "%c %lx %zu\n", op, (unsigned long)p, n); write(fd, b, len);
}
static void* alloc(size_t n) { void* p = malloc(n ? n : 1); if (!p) throw std::bad_alloc(); logline('A', p, n); return p; }
static void release(void* p) { if (!p) return; logline('F', p, 0); free(p); }
void* operator new(size_t n) { return alloc(n); }
void* operator new[](size_t n) { return alloc(n); }
void operator delete(void* p) noexcept { release(p); }
void operator delete[](void* p) noexcept { release(p); }
void operator delete(void* p, size_t) noexcept { release(p); }
void operator delete[](void* p, size_t) noexcept { release(p); }
