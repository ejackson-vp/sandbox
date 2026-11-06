export interface BenchOptions {
  samples: number;
  levels: number[];
  mode: "idle" | "cpu" | "mixed";
  tier: "short" | "standard" | "extended" | "long" | "custom";
  duration: number;
  cpuMillis: number;
  memoryMiB: number;
  diskMiB: number;
  cold: boolean;
  imageRef?: string;
  concurrency: number;
  max: number;
  rate: number;
  faultEvery: number;
  paceMs: number;
  yes: boolean;
  cleanup: boolean;
  runId?: string;
  json: boolean;
}

export const WORKLOADS_DIR = "benchmarks/workloads";
