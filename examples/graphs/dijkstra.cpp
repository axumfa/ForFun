// Dijkstra with priority_queue<pair>: heap of pairs, vector<vector<struct>> adjacency, no duplicate scenes from range-for iterators.
#include <cstdio>
#include <queue>
#include <vector>
#include <utility>
struct Edge { int to, w; };
int main() {
    std::vector<std::vector<Edge>> g(4);
    g[0] = {{1, 4}, {2, 1}}; g[2] = {{1, 2}, {3, 7}}; g[1] = {{3, 1}};
    std::vector<int> dist(4, 1 << 30); dist[0] = 0;
    std::priority_queue<std::pair<int,int>, std::vector<std::pair<int,int>>, std::greater<std::pair<int,int>>> pq;
    pq.push({0, 0});
    while (!pq.empty()) {
        auto [d, u] = pq.top(); pq.pop();
        if (d > dist[u]) continue;
        for (Edge e : g[u]) if (dist[u] + e.w < dist[e.to]) { dist[e.to] = dist[u] + e.w; pq.push({dist[e.to], e.to}); }
    }
    for (int x : dist) std::printf("%d ", x);
    std::printf("\n");
}
