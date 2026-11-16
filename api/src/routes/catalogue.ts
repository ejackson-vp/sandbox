/**
 * The read-only catalogue: what this deployment sells and what it runs.
 *
 * Both routes are config rendered as JSON, so they live together rather than in
 * the wiring module. They are public and unauthenticated, which is why neither
 * one names a secret: `payTo` is the address a client must pay, and the image
 * digest is the one it is buying.
 */
import express from "express";
import type { ApiConfig } from "../config.js";

/**
 * The guest image the deployment currently runs.
 *
 * One operator-pinned image today; `current` is what establishes the lifecycle
 * noun, so a later list can name a previous image without changing the shape.
 */
function currentImage() {
  return {
    id: "guest",
    digest: process.env.GUEST_IMAGE_DIGEST ?? "sha256:dev-unpinned-image",
    reference: process.env.GUEST_IMAGE ?? "x402-sandbox/guest:dev",
    runtimeClass: process.env.RUNTIME_CLASS ?? "x402-sandbox",
    executionMode: process.env.EXECUTION_MODE ?? "dev",
    current: true,
  };
}

export function createCatalogueRouter(config: ApiConfig): express.Router {
  const router = express.Router();

  router.get("/v1/pricing", (_req, res) => {
    res.json({
      paymentMode: config.paymentMode,
      network: config.network,
      scheme: "exact",
      asset: config.paymentMode === "mock" ? "mock:usdc" : "USDC",
      payTo: config.payTo,
      tiers: Object.fromEntries(
        Object.entries(config.tiers).map(([name, t]) => [
          name,
          {
            durationSeconds: t.durationSeconds,
            priceUsd: t.priceUsd,
            cpuMillis: t.cpuMillis,
            memoryMiB: t.memoryMiB,
            diskMiB: t.diskMiB,
          },
        ]),
      ),
      customSessions: {
        allowed: config.platformLimits.allowCustom,
        maxLeaseSeconds: config.platformLimits.maxLeaseSeconds,
        maxCpuMillis: config.platformLimits.maxCpuMillis,
        maxMemoryMiB: config.platformLimits.maxMemoryMiB,
        maxDiskMiB: config.platformLimits.maxDiskMiB,
        maxCommandSeconds: config.platformLimits.maxCommandSeconds,
        maxFileBytes: config.platformLimits.maxFileBytes,
        maxOutputBytes: config.platformLimits.maxOutputBytes,
      },
    });
  });

  router.get("/v1/images", (_req, res) => {
    res.json({ images: [currentImage()] });
  });

  return router;
}
