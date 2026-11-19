#include <cstdio>
#include <array>
#include <queue>
#include <stack>
// Container adapters and std::array: drawn under the variable's own name (not as `st.c` / `a._M_elems`).
int main() {
    std::stack<int> st;
    st.push(1); st.push(2); st.push(3);
    std::queue<int> q;
    q.push(7); q.push(8); q.push(9);
    q.pop();
    std::priority_queue<int> pq;
    pq.push(5); pq.push(9); pq.push(1);
    std::array<int, 5> a = {5, 4, 3, 2, 1};
    a[0] = 50;
    std::printf("%d %d %d %d\n", st.top(), q.front(), pq.top(), a[0]);
    return 0;
}
