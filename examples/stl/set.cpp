#include <cstdio>
#include <set>
int main() {
    std::set<int> s;
    s.insert(7);
    s.insert(2);
    s.insert(9);
    s.insert(2);
    s.insert(5);
    s.erase(9);
    for (int x : s) {
        std::printf("%d ", x);
    }
    std::printf("\n");
    return 0;
}
