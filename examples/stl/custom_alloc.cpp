#include <cstdio>
#include <cstdlib>
#include <new>
#include <set>
// A non-std allocator: the node walk refuses it (the container is still drawn through the pretty-printer).
template <class T>
struct Mallocator {
    using value_type = T;
    Mallocator() = default;
    template <class U> Mallocator(const Mallocator<U>&) {}
    T* allocate(std::size_t n) { return static_cast<T*>(std::malloc(n * sizeof(T))); }
    void deallocate(T* p, std::size_t) { std::free(p); }
    template <class U> bool operator==(const Mallocator<U>&) const { return true; }
    template <class U> bool operator!=(const Mallocator<U>&) const { return false; }
};
int main() {
    std::set<int, std::less<int>, Mallocator<int>> s;
    s.insert(4);
    s.insert(1);
    s.insert(3);
    for (int x : s) {
        std::printf("%d ", x);
    }
    std::printf("\n");
    return 0;
}
