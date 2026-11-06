/* Singly linked list in plain C: malloc/free, typedef'd node. */
#include <stdio.h>
#include <stdlib.h>
typedef struct Node {
    int val;
    struct Node* next;
} Node;
Node* push_front(Node* head, int v) {
    Node* n = malloc(sizeof(Node));
    n->val = v;
    n->next = head;
    return n;
}
Node* push_back(Node* head, int v) {
    Node* n = malloc(sizeof(Node));
    n->val = v;
    n->next = NULL;
    if (!head) return n;
    Node* cur = head;
    while (cur->next) cur = cur->next;
    cur->next = n;
    return head;
}
Node* remove_val(Node* head, int v) {
    Node* prev = NULL;
    Node* cur = head;
    while (cur && cur->val != v) {
        prev = cur;
        cur = cur->next;
    }
    if (!cur) return head;
    if (prev) prev->next = cur->next; else head = cur->next;
    free(cur);
    return head;
}
int main(void) {
    Node* head = NULL;
    head = push_back(head, 2);
    head = push_front(head, 1);
    head = push_back(head, 3);
    head = push_back(head, 4);
    head = remove_val(head, 3);
    for (Node* c = head; c; c = c->next) printf("%d ", c->val);
    printf("\n");
    return 0;
}
