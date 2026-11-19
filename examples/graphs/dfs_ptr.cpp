#include <cstdio>
#include <vector>
// Pointer-based graph: each node owns a vector of neighbour pointers; iterative DFS with an explicit stack.
struct GNode { int id; bool seen; std::vector<GNode*> out; };
int main() {
    std::vector<GNode*> g;
    for (int i = 0; i < 5; i++) g.push_back(new GNode{i, false, {}});
    g[0]->out = {g[1], g[2]};
    g[1]->out = {g[3]};
    g[2]->out = {g[3], g[4]};
    g[3]->out = {g[0]};
    std::vector<GNode*> st = {g[0]};
    std::vector<int> order;
    while (!st.empty()) {
        GNode* u = st.back(); st.pop_back();
        if (u->seen) continue;
        u->seen = true;
        order.push_back(u->id);
        for (int k = (int)u->out.size() - 1; k >= 0; k--) st.push_back(u->out[k]);
    }
    for (int x : order) std::printf("%d ", x);
    std::printf("\n");
    for (GNode* n : g) delete n;
    return 0;
}
