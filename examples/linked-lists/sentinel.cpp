#include <cstdio>
// Circular doubly linked list with a sentinel node (no value): a classic design the heuristics must not mislabel.
struct Node { int val; Node* prev; Node* next; };
struct Deque {
    Node* head;  // sentinel
    Deque() { head = new Node{0, nullptr, nullptr}; head->prev = head; head->next = head; }
    void push_back(int v) { Node* n = new Node{v, head->prev, head}; head->prev->next = n; head->prev = n; }
    void push_front(int v) { Node* n = new Node{v, head, head->next}; head->next->prev = n; head->next = n; }
    void pop_front() { Node* n = head->next; if (n == head) return; head->next = n->next; n->next->prev = head; delete n; }
};
int main() {
    Deque d;
    d.push_back(2);
    d.push_back(3);
    d.push_front(1);
    d.push_back(4);
    d.pop_front();
    for (Node* n = d.head->next; n != d.head; n = n->next) std::printf("%d ", n->val);
    std::printf("\n");
    return 0;
}
