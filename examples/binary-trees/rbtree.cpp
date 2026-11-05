#include <cstdio>
#include <initializer_list>
// Left-leaning red-black tree (insert only).
enum Color { RED, BLACK };
struct Node {
    int key;
    Color color;
    Node* left;
    Node* right;
};
bool is_red(Node* n) { return n && n->color == RED; }
Node* rotate_left(Node* h) {
    Node* x = h->right;
    h->right = x->left;
    x->left = h;
    x->color = h->color;
    h->color = RED;
    return x;
}
Node* rotate_right(Node* h) {
    Node* x = h->left;
    h->left = x->right;
    x->right = h;
    x->color = h->color;
    h->color = RED;
    return x;
}
void flip(Node* h) { h->color = RED; h->left->color = BLACK; h->right->color = BLACK; }
Node* insert(Node* h, int k) {
    if (!h) return new Node{k, RED, nullptr, nullptr};
    if (k < h->key) h->left = insert(h->left, k); else h->right = insert(h->right, k);
    if (is_red(h->right) && !is_red(h->left)) h = rotate_left(h);
    if (is_red(h->left) && is_red(h->left->left)) h = rotate_right(h);
    if (is_red(h->left) && is_red(h->right)) flip(h);
    return h;
}
void inorder(Node* n) { if (!n) return; inorder(n->left); std::printf("%d ", n->key); inorder(n->right); }
int main() {
    Node* root = nullptr;
    for (int k : {1, 2, 3, 4}) { root = insert(root, k); root->color = BLACK; }
    inorder(root);
    std::printf("\n");
    return 0;
}
