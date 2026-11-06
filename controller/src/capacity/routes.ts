/**
 * Admin-only capacity inspection and hold routes. Mounted after the internal
 * token middleware; never exposed through the public API.
 */
import express, { type Request, type Response } from "express";
import { z } from "zod";
import { specSchema } from "../control-api-schemas.js";
import type { CapacityService } from "./service.js";

export function createCapacityRouter(capacity: CapacityService): express.Router {
  const router = express.Router();
  const bodySchema = z.object({
    paymentKey: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    specHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    spec: specSchema,
  });

  router.post("/capacity/preflight", async (req: Request, res: Response) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", issues: parsed.error.issues });
      return;
    }
    res.json(await capacity.preflight(parsed.data.spec));
  });

  router.post("/capacity/holds", async (req: Request, res: Response) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success || !parsed.data.paymentKey || !parsed.data.specHash) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    const admission = await capacity.hold(
      parsed.data.paymentKey,
      parsed.data.specHash,
      parsed.data.spec,
    );
    res.status(admission.admitted ? 200 : 409).json(admission);
  });

  router.delete("/capacity/holds/:paymentKey", (req: Request, res: Response) => {
    capacity.releasePayment(String(req.params.paymentKey ?? ""));
    res.json({ ok: true });
  });

  router.get("/capacity", async (_req: Request, res: Response) => {
    res.json(await capacity.summary());
  });

  return router;
}
