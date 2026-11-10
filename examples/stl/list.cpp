#include <cstdio>
#include <list>
int main() {
    std::list<int> l;
    l.push_back(2);
    l.push_back(3);
    l.push_front(1);
    l.push_back(4);
    l.pop_front();
    l.insert(++l.begin(), 9);
    for (int x : l) {
        std::printf("%d ", x);
    }
    std::printf("\n");
    return 0;
}
