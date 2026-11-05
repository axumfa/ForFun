#include <cstdio>
// Fixed-size array with insert/delete by shifting.
struct IntArray {
    int data[8];
    int size;
};
void insert_at(IntArray& a, int idx, int v) {
    for (int i = a.size; i > idx; i--) {
        a.data[i] = a.data[i - 1];
    }
    a.data[idx] = v;
    a.size++;
}
void remove_at(IntArray& a, int idx) {
    for (int i = idx; i < a.size - 1; i++) {
        a.data[i] = a.data[i + 1];
    }
    a.size--;
}
int main() {
    IntArray a = {{0}, 0};
    insert_at(a, 0, 10);
    insert_at(a, 1, 30);
    insert_at(a, 1, 20);
    remove_at(a, 0);
    for (int i = 0; i < a.size; i++) std::printf("%d ", a.data[i]);
    std::printf("\n");
    return 0;
}
