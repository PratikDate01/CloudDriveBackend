// src/routes/share-operations.ts
import { Router, Request, Response } from "express";
import { supabase } from "../lib/supabase";
import { authMiddleware } from "../middlewares/auth-middleware";
import crypto from "crypto";

const router = Router();

/**
 * Share file with another user
 */
router.post("/:fileId/share", authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const fileId = req.params.fileId;
    const { email, permissions = "view" } = req.body;

    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    if (!["view", "edit", "admin"].includes(permissions)) {
      return res.status(400).json({ error: 'Invalid permissions. Must be "view", "edit" or "admin"' });
    }

    // Verify file ownership
    const { data: file, error: fileError } = await supabase
      .from("files")
      .select("*")
      .eq("id", fileId)
      .eq("user_id", userId)
      .single();

    if (fileError || !file) {
      return res.status(404).json({ error: "File not found" });
    }

    // Check if target user exists (using profiles table)
    const { data: targetUser, error: userError } = await supabase
      .from("profiles")
      .select("id")
      .eq("email", email)
      .single();

    if (userError || !targetUser) {
      return res.status(404).json({ error: "User not found" });
    }

    // Check if already shared
    const { data: existingShare } = await supabase
      .from("shares")
      .select("id")
      .eq("file_id", fileId)
      .eq("shared_with_email", email)
      .maybeSingle();

    if (existingShare) {
      return res.status(409).json({ error: "File already shared with this user" });
    }

    // Insert share record (align with DB schema: owner_id)
    const { data: share, error: shareError } = await supabase
      .from("shares")
      .insert([
        {
          file_id: fileId,
          owner_id: userId,
          shared_with_email: email,
          permissions,
        },
      ])
      .select()
      .single();

    if (shareError) throw shareError;

    // Notify owner in real-time
    const io = req.app.get("io");
    io?.to(`user:${userId}`).emit("share:created", {
      id: share.id,
      file_id: share.file_id,
      shared_with_email: share.shared_with_email,
      permissions: share.permissions,
      created_at: share.created_at,
    });

    return res.json({
      message: "File shared successfully",
      share: {
        id: share.id,
        file_id: share.file_id,
        shared_with_email: share.shared_with_email,
        permissions: share.permissions,
        created_at: share.created_at,
      },
    });
  } catch (error) {
    console.error("Share file error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * Get files shared *with* me
 */
router.get("/shared-with-me", authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10));
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "20"), 10)));
    const search = (req.query.search as string | undefined)?.trim();

    // Get current user email
    const { data: user, error: userError } = await supabase
      .from("profiles")
      .select("email")
      .eq("id", userId)
      .single();

    if (userError || !user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Base select with count and joined file fields
    let select = supabase
      .from("shares")
      .select(
        `
        id,
        permissions,
        share_type,
        expires_at,
        created_at,
        files (
          id,
          name,
          size,
          type,
          created_at
        ),
        profiles!shares_owner_id_fkey (
          email
        )
      `,
        { count: "exact" }
      )
      .eq("shared_with_email", user.email)
      .order("created_at", { ascending: false });

    if (search && search.length > 1) {
      // filter by file name
      // @ts-ignore
      select = (select as any).or(`files.name.ilike.%${search}%`);
    }

    const from = (page - 1) * limit;
    const to = from + limit - 1;
    const { data: shares, error: sharesError, count } = await select.range(from, to);

    if (sharesError) throw sharesError;

    return res.json({ shares, page, limit, total: count ?? shares?.length ?? 0 });
  } catch (error) {
    console.error("Get shared-with-me error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * Get files shared *by* me
 */
router.get("/shared-by-me", authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10));
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "20"), 10)));
    const search = (req.query.search as string | undefined)?.trim();

    let select = supabase
      .from("shares")
      .select(
        `
        id,
        shared_with_email,
        permissions,
        share_type,
        expires_at,
        created_at,
        files (
          id,
          name,
          size,
          type,
          created_at
        )
      `,
        { count: "exact" }
      )
      .eq("owner_id", userId)
      .order("created_at", { ascending: false });

    if (search && search.length > 1) {
      // filter by file name or email
      // @ts-ignore
      select = (select as any).or(`files.name.ilike.%${search}%,shared_with_email.ilike.%${search}%`);
    }

    const from = (page - 1) * limit;
    const to = from + limit - 1;
    const { data: shares, error, count } = await select.range(from, to);

    if (error) throw error;

    return res.json({ shares, page, limit, total: count ?? shares?.length ?? 0 });
  } catch (error) {
    console.error("Get shared-by-me error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * Revoke file share
 */
router.delete("/:fileId/shares/:shareId", authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const fileId = req.params.fileId;
    const shareId = req.params.shareId;

    // Verify file ownership
    const { data: file, error: fileError } = await supabase
      .from("files")
      .select("id")
      .eq("id", fileId)
      .eq("user_id", userId)
      .single();

    if (fileError || !file) {
      return res.status(404).json({ error: "File not found" });
    }

    // Delete share
    const { error: deleteError } = await supabase
      .from("shares")
      .delete()
      .eq("id", shareId)
      .eq("file_id", fileId);

    if (deleteError) throw deleteError;

    // Notify owner in real-time
    const io = req.app.get("io");
    io?.to(`user:${userId}`).emit("share:revoked", { id: shareId, file_id: fileId });

    return res.json({ message: "Share revoked successfully" });
  } catch (error) {
    console.error("Revoke share error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ------------------------------
// Public link sharing
// ------------------------------
router.post("/:fileId/public", authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const fileId = req.params.fileId;
    const { expiresAt } = req.body as { expiresAt?: string };

    // Verify ownership
    const { data: file, error: fErr } = await supabase
      .from("files")
      .select("id")
      .eq("id", fileId)
      .eq("user_id", userId)
      .single();
    if (fErr || !file) return res.status(404).json({ error: "File not found" });

    const publicToken = crypto.randomBytes(24).toString("hex");

    const { data: share, error } = await supabase
      .from("shares")
      .insert([
        {
          file_id: fileId,
          owner_id: userId,
          shared_with_email: "",
          permissions: "view",
          share_type: "public",
          public_token: publicToken,
          expires_at: expiresAt || null,
        },
      ])
      .select()
      .single();

    if (error) throw error;

    return res.json({ message: "Public link created", token: share.public_token, share });
  } catch (error) {
    console.error("Create public link error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/public/:token", async (req: Request, res: Response) => {
  try {
    const token = req.params.token;

    const { data: share, error } = await supabase
      .from("shares")
      .select(
        `
        id,
        file_id,
        expires_at,
        files ( id, name, size, type, path )
      `
      )
      .eq("public_token", token)
      .eq("share_type", "public")
      .maybeSingle();
    if (error) throw error;
    if (!share) return res.status(404).json({ error: "Link not found" });
    if (share.expires_at && new Date(share.expires_at) < new Date()) {
      return res.status(410).json({ error: "Link expired" });
    }

    // Generate signed URL for public download (1 hour)
    const { data: signed, error: sErr } = await supabase.storage
      .from("files")
      .createSignedUrl((share.files as any).path, 3600);
    if (sErr) throw sErr;

    return res.json({
      file: {
        id: (share.files as any).id,
        name: (share.files as any).name,
        size: (share.files as any).size,
        type: (share.files as any).type,
      },
      downloadUrl: signed?.signedUrl,
    });
  } catch (error) {
    console.error("Resolve public link error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/public/:token", authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const token = req.params.token;

    const { error } = await supabase
      .from("shares")
      .delete()
      .eq("public_token", token)
      .eq("owner_id", userId);

    if (error) throw error;

    return res.json({ message: "Public link revoked" });
  } catch (error) {
    console.error("Revoke public link error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;