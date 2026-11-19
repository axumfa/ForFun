#include <cstdio>
#include <initializer_list>
#include <memory>
// BST whose links are std::unique_ptr: smart pointers show up as plain structs in the tracer.
struct Node { int key; std::unique_ptr<Node> left, right; Node(int k) : key(k) {} };
void insert(std::unique_ptr<Node>& t, int k) {
    if (!t) { t = std::make_unique<Node>(k); return; }
    insert(k < t->key ? t->left : t->right, k);
}
void inorder(const Node* n) { if (!n) return; inorder(n->left.get()); std::printf("%d ", n->key); inorder(n->right.get()); }
int main() {
    std::unique_ptr<Node> root;
    for (int k : {4, 2, 6, 1, 3, 5}) insert(root, k);
    inorder(root.get());
    std::printf("\n");
    return 0;
}
