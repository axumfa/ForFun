#include <cstdio>
#include <initializer_list>
#include <memory>
// BST built with std::make_shared: the node lives inside the shared_ptr control block (one allocation).
struct Node { int key; std::shared_ptr<Node> left, right; Node(int k) : key(k) {} };
void insert(std::shared_ptr<Node>& t, int k) {
    if (!t) { t = std::make_shared<Node>(k); return; }
    insert(k < t->key ? t->left : t->right, k);
}
void inorder(const std::shared_ptr<Node>& n) { if (!n) return; inorder(n->left); std::printf("%d ", n->key); inorder(n->right); }
int main() {
    std::shared_ptr<Node> root;
    for (int k : {4, 2, 6, 1, 3, 5}) insert(root, k);
    inorder(root);
    std::printf("\n");
    return 0;
}
