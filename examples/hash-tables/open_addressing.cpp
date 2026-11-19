// Open addressing with linear probing: the table is an array of structs; cells show key and the other fields.
#include <cstdio>
struct Slot { int key; int val; bool used; };
struct HashTable {
    Slot table[8];
    HashTable() { for (int i = 0; i < 8; i++) table[i] = {0, 0, false}; }
    void put(int k, int v) { int i = k % 8; while (table[i].used && table[i].key != k) i = (i + 1) % 8; table[i] = {k, v, true}; }
};
int main() {
    HashTable h;
    h.put(3, 30);
    h.put(11, 110);
    h.put(19, 190);
    h.put(4, 40);
    std::printf("%d\n", h.table[5].val);
}
