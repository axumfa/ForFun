#include <cstdio>
#include <vector>
// Disjoint-set union stored in two arrays (a forest in disguise).
struct DSU {
    std::vector<int> parent, rank_;
    DSU(int n) : parent(n), rank_(n, 0) { for (int i = 0; i < n; i++) parent[i] = i; }
    int find(int x) { while (parent[x] != x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
    void unite(int a, int b) {
        int ra = find(a), rb = find(b);
        if (ra == rb) return;
        if (rank_[ra] < rank_[rb]) { int t = ra; ra = rb; rb = t; }
        parent[rb] = ra;
        if (rank_[ra] == rank_[rb]) rank_[ra]++;
    }
};
int main() {
    DSU d(8);
    d.unite(0, 1);
    d.unite(2, 3);
    d.unite(1, 3);
    d.unite(4, 5);
    for (int i = 0; i < 8; i++) std::printf("%d ", d.find(i));
    std::printf("\n");
    return 0;
}
