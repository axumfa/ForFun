#include <cstdio>
struct Node {
    int val;
    Node* prev;
    Node* next;
};
struct DList {
    Node* head = nullptr;
    Node* tail = nullptr;
    void push_back(int v) {
        Node* n = new Node{v, tail, nullptr};
        if (tail) tail->next = n; else head = n;
        tail = n;
    }
    void remove(Node* n) {
        if (n->prev) n->prev->next = n->next; else head = n->next;
        if (n->next) n->next->prev = n->prev; else tail = n->prev;
        delete n;
    }
};
int main() {
    DList l;
    l.push_back(1);
    l.push_back(2);
    l.push_back(3);
    l.remove(l.head->next);
    for (Node* c = l.head; c; c = c->next) std::printf("%d ", c->val);
    std::printf("\n");
    return 0;
}
