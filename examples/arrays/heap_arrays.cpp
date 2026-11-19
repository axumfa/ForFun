// new[] arrays owned by pointers: named after the owning variable (`a`, `s.data`); index-like locals become markers.
#include <cstdio>
class Stack {
    int* data; int cap, top_;
public:
    Stack(int c) : data(new int[c]), cap(c), top_(0) {}
    ~Stack() { delete[] data; }
    void push(int v) { if (top_ == cap) { int* nd = new int[cap * 2]; for (int i = 0; i < cap; i++) nd[i] = data[i]; delete[] data; data = nd; cap *= 2; } data[top_++] = v; }
    int pop() { return data[--top_]; }
};
void qsort_(int* a, int lo, int hi) {
    if (lo >= hi) return;
    int p = a[hi], i = lo;
    for (int j = lo; j < hi; j++) if (a[j] < p) { int t = a[i]; a[i] = a[j]; a[j] = t; i++; }
    int t = a[i]; a[i] = a[hi]; a[hi] = t;
    qsort_(a, lo, i - 1); qsort_(a, i + 1, hi);
}
class Tree {
    struct N { int k; N *l, *r; N(int k) : k(k), l(nullptr), r(nullptr) {} };
    N* root = nullptr;
    N* ins(N* t, int k) { if (!t) return new N(k); if (k < t->k) t->l = ins(t->l, k); else t->r = ins(t->r, k); return t; }
public:
    void add(int k) { root = ins(root, k); }
};
int main() {
    Stack s(2); s.push(1); s.push(2); s.push(3); s.pop();
    int* a = new int[6]{5, 2, 4, 1, 3, 0};
    qsort_(a, 0, 5);
    Tree t; t.add(4); t.add(2); t.add(6);
    for (int i = 0; i < 6; i++) std::printf("%d ", a[i]);
    std::printf("\n");
    delete[] a;
}
