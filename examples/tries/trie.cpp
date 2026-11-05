#include <cstdio>
struct TrieNode {
    TrieNode* child[3];
    bool end;
    TrieNode() : end(false) { for (int i = 0; i < 3; i++) child[i] = nullptr; }
};
void insert(TrieNode* root, const int* word, int n) {
    TrieNode* cur = root;
    for (int i = 0; i < n; i++) {
        if (!cur->child[word[i]]) cur->child[word[i]] = new TrieNode();
        cur = cur->child[word[i]];
    }
    cur->end = true;
}
int main() {
    TrieNode* root = new TrieNode();
    int w1[] = {0, 1, 2};
    int w2[] = {0, 1};
    int w3[] = {2, 2};
    insert(root, w1, 3);
    insert(root, w2, 2);
    insert(root, w3, 2);
    std::printf("ok\n");
    return 0;
}
