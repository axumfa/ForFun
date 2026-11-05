#include <cstdio>
struct Node {
    int key;
    Node* left;
    Node* right;
};
Node* insert(Node* root, int k) {
    if (!root) return new Node{k, nullptr, nullptr};
    if (k < root->key) root->left = insert(root->left, k);
    else root->right = insert(root->right, k);
    return root;
}
Node* min_node(Node* n) {
    while (n->left) {
        n = n->left;
    }
    return n;
}
Node* remove(Node* root, int k) {
    if (!root) return nullptr;
    if (k < root->key) root->left = remove(root->left, k);
    else if (k > root->key) root->right = remove(root->right, k);
    else {
        if (!root->left) { Node* r = root->right; delete root; return r; }
        if (!root->right) { Node* l = root->left; delete root; return l; }
        Node* m = min_node(root->right);
        root->key = m->key;
        root->right = remove(root->right, m->key);
    }
    return root;
}
void inorder(Node* n) {
    if (!n) return;
    inorder(n->left);
    std::printf("%d ", n->key);
    inorder(n->right);
}
int main() {
    Node* root = nullptr;
    int keys[] = {5, 3, 8, 1, 4, 7};
    for (int k : keys) root = insert(root, k);
    root = remove(root, 5);
    inorder(root);
    std::printf("\n");
    return 0;
}
