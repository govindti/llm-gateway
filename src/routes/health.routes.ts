import { Router } from "express";
import { createHealthController } from "@/controllers/health.controller";

export function createHealthRouter(): Router {
    const router = Router();
    router.get("/", createHealthController());
    return router;
}
