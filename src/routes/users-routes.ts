// src/routes/users-routes.ts
import { Router, Request, Response } from "express";
import { supabase } from "../lib/supabase";
import { authMiddleware } from "../middlewares/auth-middleware";

const router = Router();

// Get current user's quota/usage
router.get("/quota", authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId as string;

    const { data: quota, error } = await supabase
      .from("user_quotas")
      .select("plan, storage_used, storage_limit, file_count, file_count_limit")
      .eq("user_id", userId)
      .maybeSingle();

    if (error) throw error;

    return res.json({
      quota: {
        plan: quota?.plan ?? "free",
        storage_used: quota?.storage_used ?? 0,
        storage_limit: quota?.storage_limit ?? 5 * 1024 * 1024 * 1024,
        file_count: quota?.file_count ?? 0,
        file_count_limit: quota?.file_count_limit ?? 10000,
      },
    });
  } catch (error) {
    console.error("Get quota error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;