#include <cstdio>
#include <vector>
struct MinHeap {
    std::vector<int> a;
    void push(int v) {
        a.push_back(v);
        int i = a.size() - 1;
        while (i > 0 && a[(i - 1) / 2] > a[i]) {
            int p = (i - 1) / 2;
            int t = a[p]; a[p] = a[i]; a[i] = t;
            i = p;
        }
    }
    int pop() {
        int top = a[0];
        a[0] = a.back();
        a.pop_back();
        int i = 0, n = a.size();
        while (true) {
            int l = 2 * i + 1, r = l + 1, m = i;
            if (l < n && a[l] < a[m]) m = l;
            if (r < n && a[r] < a[m]) m = r;
            if (m == i) break;
            int t = a[m]; a[m] = a[i]; a[i] = t;
            i = m;
        }
        return top;
    }
};
int main() {
    MinHeap h;
    for (int v : {5, 3, 8, 1, 9, 2}) h.push(v);
    int first = h.pop();
    std::printf("%d\n", first);
    for (int v : h.a) std::printf("%d ", v);
    std::printf("\n");
    return 0;
}
