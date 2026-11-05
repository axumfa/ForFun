#include <cstdio>
struct Node {
    int val;
    Node* next;
    Node(int v) : val(v), next(nullptr) {}
};
struct LinkedList {
    Node* head = nullptr;
    void push_front(int v) {
        Node* n = new Node(v);
        n->next = head;
        head = n;
    }
    void push_back(int v) {
        Node* n = new Node(v);
        if (!head) { head = n; return; }
        Node* cur = head;
        while (cur->next) {
            cur = cur->next;
        }
        cur->next = n;
    }
    void remove(int v) {
        Node* prev = nullptr;
        Node* cur = head;
        while (cur && cur->val != v) {
            prev = cur;
            cur = cur->next;
        }
        if (!cur) return;
        if (prev) prev->next = cur->next; else head = cur->next;
        delete cur;
    }
};
int main() {
    LinkedList l;
    l.push_back(2);
    l.push_front(1);
    l.push_back(3);
    l.push_back(4);
    l.remove(3);
    for (Node* c = l.head; c; c = c->next) std::printf("%d ", c->val);
    std::printf("\n");
    return 0;
}
