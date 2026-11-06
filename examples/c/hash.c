/* Hash table with separate chaining in plain C. Anonymous typedef struct for the table, tagged struct for the entries. */
#include <stdio.h>
#include <stdlib.h>
typedef struct Entry {
    int key;
    int val;
    struct Entry* next;
} Entry;
typedef struct {
    Entry* buckets[5];
} Table;
void put(Table* t, int k, int v) {
    int b = k % 5;
    for (Entry* e = t->buckets[b]; e; e = e->next) {
        if (e->key == k) { e->val = v; return; }
    }
    Entry* n = malloc(sizeof(Entry));
    n->key = k;
    n->val = v;
    n->next = t->buckets[b];
    t->buckets[b] = n;
}
int main(void) {
    Table t = {{NULL, NULL, NULL, NULL, NULL}};
    put(&t, 1, 100);
    put(&t, 6, 600);
    put(&t, 2, 200);
    put(&t, 11, 1100);
    put(&t, 6, 666);
    for (int b = 0; b < 5; b++) {
        printf("%d:", b);
        for (Entry* e = t.buckets[b]; e; e = e->next) printf(" %d=%d", e->key, e->val);
        printf("\n");
    }
    return 0;
}
