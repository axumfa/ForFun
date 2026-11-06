// C-style singly linked list: nodes come from malloc/calloc and go back with free (no new/delete anywhere).
#include <cstdio>
#include <cstdlib>
struct Node {
    int val;
    Node* next;
};
Node* make(int v) {
    Node* n = (Node*)malloc(sizeof(Node));
    n->val = v;
    n->next = nullptr;
    return n;
}
int main() {
    Node* head = make(1);
    head->next = make(2);
    head->next->next = make(3);
    Node* tail = (Node*)calloc(1, sizeof(Node));
    tail->val = 4;
    head->next->next->next = tail;
    Node* dead = head->next;
    head->next = dead->next;
    free(dead);
    for (Node* c = head; c; c = c->next) std::printf("%d ", c->val);
    std::printf("\n");
    return 0;
}
