/* Binary search tree in plain C. */
#include <stdio.h>
#include <stdlib.h>
typedef struct Node {
    int key;
    struct Node* left;
    struct Node* right;
} Node;
Node* insert(Node* root, int key) {
    if (!root) {
        Node* n = calloc(1, sizeof(Node));
        n->key = key;
        return n;
    }
    if (key < root->key) root->left = insert(root->left, key);
    else root->right = insert(root->right, key);
    return root;
}
void inorder(Node* root) {
    if (!root) return;
    inorder(root->left);
    printf("%d ", root->key);
    inorder(root->right);
}
int main(void) {
    Node* root = NULL;
    int keys[] = {5, 3, 8, 1, 4};
    for (int i = 0; i < 5; i++) root = insert(root, keys[i]);
    inorder(root);
    printf("\n");
    return 0;
}
