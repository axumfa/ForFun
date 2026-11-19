#include <cstdio>
#include <memory>
// Doubly linked list: shared_ptr forward links, weak_ptr back links. (Built with `new`, not make_shared: see docs/limitations.md.)
struct Node { int val; std::shared_ptr<Node> next; std::weak_ptr<Node> prev; Node(int v) : val(v) {} };
int main() {
    std::shared_ptr<Node> head = std::shared_ptr<Node>(new Node(1)), tail = head;
    for (int v = 2; v <= 4; v++) {
        auto n = std::shared_ptr<Node>(new Node(v));
        n->prev = tail;
        tail->next = n;
        tail = n;
    }
    for (auto n = head; n; n = n->next) std::printf("%d ", n->val);
    std::printf("\n");
    return 0;
}
