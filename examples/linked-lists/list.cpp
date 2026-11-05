struct Node { int val; Node* next; };

Node* push_front(Node* head, int v) {
    Node* n = new Node{v, nullptr};
    n->next = head;
    return n;
}

Node* remove_val(Node* head, int v) {
    Node** pp = &head;
    while (*pp) {
        if ((*pp)->val == v) {
            Node* dead = *pp;
            *pp = dead->next;
            delete dead;
            break;
        }
        pp = &(*pp)->next;
    }
    return head;
}

int main() {
    Node* head = nullptr;
    head = push_front(head, 3);
    head = push_front(head, 2);
    head = push_front(head, 1);
    head = remove_val(head, 2);
    return head ? 0 : 1;
}
