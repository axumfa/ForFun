#include <cstdio>
#include <map>
// A map whose values point at heap nodes: the map is drawn by the STL adapter, the nodes by the list adapter; cells carry a ref between them.
struct Node { int val; Node* next; Node(int v) : val(v), next(nullptr) {} };
int main() {
    std::map<int, Node*> index;
    Node* head = nullptr;
    for (int k : {3, 1, 2}) {
        Node* n = new Node(k * 10);
        n->next = head;
        head = n;
        index[k] = n;
    }
    for (const auto& kv : index) std::printf("%d:%d ", kv.first, kv.second->val);
    std::printf("\n");
    while (head) { Node* n = head->next; delete head; head = n; }
    return 0;
}
