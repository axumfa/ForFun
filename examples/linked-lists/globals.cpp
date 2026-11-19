// File-scope state: a global list head, a global array and a counter. The tracer reads them as a pseudo-frame "(globals)".
#include <cstdio>
struct Node { int val; Node* next; };
Node* head = nullptr;
int arr[6] = {5, 2, 4, 1, 3, 0};
int count = 0;
void push(int v) { Node* n = new Node{v, head}; head = n; count++; }
void sort_arr() {
    for (int i = 0; i < 6; i++) for (int j = 0; j + 1 < 6 - i; j++) if (arr[j] > arr[j+1]) { int t = arr[j]; arr[j] = arr[j+1]; arr[j+1] = t; }
}
int main() {
    push(1); push(2); push(3);
    sort_arr();
    for (int i = 0; i < 6; i++) std::printf("%d ", arr[i]);
    std::printf("%d\n", count);
}
