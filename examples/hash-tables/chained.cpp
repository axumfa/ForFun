#include <cstdio>
// Hash table with separate chaining.
struct Entry { int key; int val; Entry* next; };
struct HashTable {
    Entry* buckets[5] = {nullptr, nullptr, nullptr, nullptr, nullptr};
    void put(int k, int v) {
        int b = k % 5;
        for (Entry* e = buckets[b]; e; e = e->next) {
            if (e->key == k) { e->val = v; return; }
        }
        buckets[b] = new Entry{k, v, buckets[b]};
    }
};
int main() {
    HashTable t;
    t.put(1, 100);
    t.put(6, 600);
    t.put(2, 200);
    t.put(11, 1100);
    t.put(6, 666);
    std::printf("done\n");
    return 0;
}
