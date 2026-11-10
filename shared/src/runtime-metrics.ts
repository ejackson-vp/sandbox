/**
 * Process, event-loop and build metrics.
 *
 * These are the families that let a p95 investigation separate application
 * latency from a stalled event loop or GC pause, and let a scrape identify the
 * build it is talking to. Everything here is a single bounded sample (or a
 * fixed enum), so none of it grows with traffic.
 */
import { PerformanceObserver, constants, monitorEventLoopDelay } from "node:perf_hooks";
import { metrics, type MetricsRegistry } from "./metrics.js";

export interface RuntimeMetrics {
  /** Refresh gauges/counters. Cheap enough to run once per scrape. */
  collect(): void;
  /** Detach the GC observer and the event-loop histogram. */
  stop(): void;
}

const GC_KINDS = new Map<number, string>([
  [constants.NODE_PERFORMANCE_GC_MINOR, "minor"],
  [constants.NODE_PERFORMANCE_GC_MAJOR, "major"],
  [constants.NODE_PERFORMANCE_GC_INCREMENTAL, "incremental"],
  [constants.NODE_PERFORMANCE_GC_WEAKCB, "weak_callback"],
]);

/** `sandbox_build_info{version,commit} 1`: one sample per build. */
export function registerBuildInfo(
  registry: MetricsRegistry = metrics,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const version = env.BUILD_VERSION ?? env.npm_package_version ?? "0.1.0";
  const commit = env.BUILD_COMMIT ?? env.GIT_COMMIT ?? "unknown";
  registry.gauge("sandbox_build_info", "Build identity (one sample, always 1)").set({ version, commit }, 1);
}

export function registerRuntimeMetrics(registry: MetricsRegistry = metrics): RuntimeMetrics {
  const cpu = registry.counter("process_cpu_seconds_total", "Process CPU time by mode");
  let lastCpu = { user: 0, system: 0 };

  registry.gauge("process_resident_memory_bytes", "Resident memory size");
  registry.gauge("process_heap_bytes", "V8 heap size");
  registry.gauge("nodejs_heap_size_used_bytes", "V8 heap used");
  registry.gauge("nodejs_external_memory_bytes", "V8 external memory");
  registry.gauge("process_uptime_seconds", "Process uptime");
  const lag = {
    mean: registry.gauge("nodejs_eventloop_lag_seconds", "Mean event-loop delay"),
    p50: registry.gauge("nodejs_eventloop_lag_p50_seconds", "Median event-loop delay"),
    p99: registry.gauge("nodejs_eventloop_lag_p99_seconds", "p99 event-loop delay"),
    max: registry.gauge("nodejs_eventloop_lag_max_seconds", "Maximum event-loop delay"),
  };
  registry.counter("nodejs_gc_collections_total", "GC collections by kind");
  registry.counter("nodejs_gc_duration_seconds_total", "Time spent in GC by kind");

  registry.gauge("process_start_time_seconds", "Process start time (unix seconds)").set(
    {},
    Math.round((Date.now() - process.uptime() * 1000) / 1000),
  );

  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();

  let gcObserver: PerformanceObserver | undefined;
  try {
    gcObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const kind =
          GC_KINDS.get(
            (entry as unknown as { kind?: number; detail?: { kind?: number } }).kind ??
              (entry as unknown as { detail?: { kind?: number } }).detail?.kind ??
              0,
          ) ?? "other";
        registry.counter("nodejs_gc_collections_total", "GC collections by kind").inc({ kind });
        registry
          .counter("nodejs_gc_duration_seconds_total", "Time spent in GC by kind")
          .inc({ kind }, entry.duration / 1e3);
      }
    });
    gcObserver.observe({ entryTypes: ["gc"] });
  } catch {
    // `--no-performance-observer` or an unsupported runtime: the rest works.
    gcObserver = undefined;
  }

  return {
    collect(): void {
      const usage = process.cpuUsage();
      cpu.inc({ mode: "user" }, Math.max(0, usage.user - lastCpu.user) / 1e6);
      cpu.inc({ mode: "system" }, Math.max(0, usage.system - lastCpu.system) / 1e6);
      lastCpu = { user: usage.user, system: usage.system };

      const memory = process.memoryUsage();
      registry.gauge("process_resident_memory_bytes", "Resident memory size").set({}, memory.rss);
      registry.gauge("process_heap_bytes", "V8 heap size").set({}, memory.heapTotal);
      registry.gauge("nodejs_heap_size_used_bytes", "V8 heap used").set({}, memory.heapUsed);
      registry.gauge("nodejs_external_memory_bytes", "V8 external memory").set({}, memory.external);
      registry.gauge("process_uptime_seconds", "Process uptime").set({}, process.uptime());

      const mean = histogram.mean;
      lag.mean.set({}, Number.isFinite(mean) ? mean / 1e9 : 0);
      lag.p50.set({}, histogram.percentile(50) / 1e9);
      lag.p99.set({}, histogram.percentile(99) / 1e9);
      lag.max.set({}, histogram.max / 1e9);
      // Percentiles are over the window since the last reset.
      histogram.reset();
    },
    stop(): void {
      histogram.disable();
      gcObserver?.disconnect();
      gcObserver = undefined;
    },
  };
}
