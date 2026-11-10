#include <cstdio>
#include <deque>
int main() {
    std::deque<int> d;
    d.push_back(2);
    d.push_back(3);
    d.push_front(1);
    d.push_front(0);
    d.pop_back();
    for (int x : d) {
        std::printf("%d ", x);
    }
    std::printf("\n");
    return 0;
}
