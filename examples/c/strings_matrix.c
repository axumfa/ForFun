/* C strings (char name[16], const char*), an adjacency matrix and an array-backed ring buffer. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#define N 5
typedef struct Person { char name[16]; int age; struct Person* next; } Person;
typedef struct { int buf[4]; int head, tail, count; } Ring;
int adj[N][N];
void edge(int a, int b) { adj[a][b] = adj[b][a] = 1; }
void ring_push(Ring* r, int v) { r->buf[r->tail] = v; r->tail = (r->tail + 1) % 4; r->count++; }
int main(void) {
    edge(0, 1); edge(1, 2); edge(3, 4);
    Ring r = {{0}, 0, 0, 0};
    ring_push(&r, 7); ring_push(&r, 8); ring_push(&r, 9); ring_push(&r, 5); ring_push(&r, 6);
    Person* head = NULL;
    const char* names[] = {"ann", "bob"};
    for (int i = 0; i < 2; i++) { Person* p = malloc(sizeof(Person)); strcpy(p->name, names[i]); p->age = 20 + i; p->next = head; head = p; }
    printf("%d %d %s\n", adj[0][1], r.buf[0], head->name);
    while (head) { Person* n = head->next; free(head); head = n; }
    return 0;
}
