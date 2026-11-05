#include <cstdio>
// Stack on a linked list, queue on a circular array.
struct SNode { int val; SNode* next; };
struct Stack {
    SNode* top = nullptr;
    void push(int v) { top = new SNode{v, top}; }
    int pop() { SNode* t = top; int v = t->val; top = t->next; delete t; return v; }
};
struct Queue {
    int buf[4] = {0, 0, 0, 0};
    int head = 0, count = 0;
    void enqueue(int v) { buf[(head + count) % 4] = v; count++; }
    int dequeue() { int v = buf[head]; head = (head + 1) % 4; count--; return v; }
};
int main() {
    Stack s;
    s.push(1); s.push(2); s.push(3);
    int a = s.pop();
    Queue q;
    q.enqueue(7); q.enqueue(8); q.enqueue(9);
    int b = q.dequeue();
    q.enqueue(10);
    std::printf("%d %d\n", a, b);
    return 0;
}
