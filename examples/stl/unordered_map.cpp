#include <cstdio>
#include <unordered_map>
int main() {
    std::unordered_map<int, int> u;
    u[10] = 1;
    u[20] = 2;
    u[30] = 3;
    u[10] = 11;
    u.erase(20);
    for (const auto& kv : u) {
        std::printf("%d:%d ", kv.first, kv.second);
    }
    std::printf("\n");
    return 0;
}
