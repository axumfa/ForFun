#include <cstdio>
#include <map>
int main() {
    std::map<int, int> m;
    m[5] = 50;
    m[3] = 30;
    m[8] = 80;
    m[1] = 10;
    m[4] = 40;
    m[3] = 33;
    m.erase(8);
    for (const auto& kv : m) {
        std::printf("%d:%d ", kv.first, kv.second);
    }
    std::printf("\n");
    return 0;
}
