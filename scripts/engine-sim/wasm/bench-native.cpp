// The same live.cpp, built natively and single-threaded (bench-native.sh),
// for comparing WebAssembly's speed with native code on the same machine:
// per car and quality, after the start, held at 60 % of redline at full
// throttle; simulated seconds per second of CPU.
#include <chrono>
#include <cstdio>
#include <cstdlib>
extern "C" {
int es_load(const char *, double, double); int es_frequency(); double es_redline();
void es_starter(int); void es_ignition(int); void es_control(int, double, double); int es_run(int);
}
int main(int argc, char **argv) {
    const double q = argc > 2 ? std::atof(argv[2]) : 1;
    if (!es_load(argv[1], q, 0.0006)) { std::fprintf(stderr, "no compile\n"); return 1; }
    const int f = es_frequency(), steps = f / 200;
    double t = 0;
    es_ignition(1); es_starter(1); es_control(1, 0, 0);
    while (t < 2.5) { if (t > 1.5) es_starter(0); es_run(steps); t += (double)steps / f; }
    es_starter(0); es_control(0, 0.6 * es_redline(), 1);
    const auto a = std::chrono::steady_clock::now();
    double s = 0;
    while (s < 3) { es_run(steps); s += (double)steps / f; }
    const double w = std::chrono::duration<double>(std::chrono::steady_clock::now() - a).count();
    std::printf("%s q%.2f %d Hz: %.2fx\n", argv[1], q, f, s / w);
}
