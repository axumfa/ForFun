#include <cstdio>
#include <algorithm>
struct Node {
    int key;
    int height;
    Node* left;
    Node* right;
};
int h(Node* n) { return n ? n->height : 0; }
void upd(Node* n) { n->height = 1 + std::max(h(n->left), h(n->right)); }
Node* rot_right(Node* y) {
    Node* x = y->left;
    y->left = x->right;
    x->right = y;
    upd(y); upd(x);
    return x;
}
Node* rot_left(Node* x) {
    Node* y = x->right;
    x->right = y->left;
    y->left = x;
    upd(x); upd(y);
    return y;
}
Node* insert(Node* n, int k) {
    if (!n) return new Node{k, 1, nullptr, nullptr};
    if (k < n->key) n->left = insert(n->left, k); else n->right = insert(n->right, k);
    upd(n);
    int bal = h(n->left) - h(n->right);
    if (bal > 1 && k < n->left->key) return rot_right(n);
    if (bal < -1 && k > n->right->key) return rot_left(n);
    if (bal > 1) { n->left = rot_left(n->left); return rot_right(n); }
    if (bal < -1) { n->right = rot_right(n->right); return rot_left(n); }
    return n;
}
void inorder(Node* n) { if (!n) return; inorder(n->left); std::printf("%d ", n->key); inorder(n->right); }
int main() {
    Node* root = nullptr;
    for (int k : {10, 20, 30, 40, 50}) root = insert(root, k);
    inorder(root);
    std::printf("\n");
    return 0;
}
