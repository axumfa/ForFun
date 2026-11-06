/* Growable int array in plain C: realloc doubles the capacity (the block may grow in place or move). Anonymous typedef struct. */
#include <stdio.h>
#include <stdlib.h>
typedef struct {
    int* data;
    int len;
    int cap;
} Vec;
void push(Vec* v, int x) {
    if (v->len == v->cap) {
        v->cap = v->cap ? v->cap * 2 : 2;
        v->data = realloc(v->data, v->cap * sizeof(int));
    }
    v->data[v->len++] = x;
}
int main(void) {
    Vec v = {NULL, 0, 0};
    for (int i = 1; i <= 7; i++) push(&v, i * i);
    for (int i = 0; i < v.len; i++) printf("%d ", v.data[i]);
    printf("\n");
    free(v.data);
    return 0;
}
