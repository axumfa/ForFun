#include <cstdio>
#include <vector>
struct Graph {
    std::vector<std::vector<int>> adj;
    Graph(int n) : adj(n) {}
    void add_edge(int a, int b) { adj[a].push_back(b); adj[b].push_back(a); }
};
int main() {
    Graph g(5);
    g.add_edge(0, 1);
    g.add_edge(0, 2);
    g.add_edge(1, 3);
    g.add_edge(2, 4);
    std::vector<int> dist(5, -1);
    std::vector<int> queue;
    queue.push_back(0);
    dist[0] = 0;
    for (size_t qi = 0; qi < queue.size(); qi++) {
        int u = queue[qi];
        for (int v : g.adj[u]) {
            if (dist[v] < 0) {
                dist[v] = dist[u] + 1;
                queue.push_back(v);
            }
        }
    }
    for (int d : dist) std::printf("%d ", d);
    std::printf("\n");
    return 0;
}
