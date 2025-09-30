// src/routes/file-operations.ts
import { Router, Request, Response } from "express";
import multer from "multer";
import { supabase } from "../lib/supabase";
import { authMiddleware } from "../middlewares/auth-middleware";
import { hasFilePermission } from "../utils/permissions";

const router = Router();

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB limit
  },
});

// ------------------------------
// Helpers
// ------------------------------
function getFileExt(name: string): string | null {
  const parts = name.split(".");
  return parts.length > 1 ? parts.pop() || null : null;
}

async function enforceQuotaOnUpload(userId: string, newFileSize: number) {
  // Fetch quota row
  const { data: quota } = await supabase
    .from("user_quotas")
    .select("storage_used, storage_limit, file_count, file_count_limit")
    .eq("user_id", userId)
    .maybeSingle();

  const storageLimit = quota?.storage_limit ?? 5 * 1024 * 1024 * 1024; // 5GB default
  const storageUsed = quota?.storage_used ?? 0;
  const fileCount = quota?.file_count ?? 0;
  const fileCountLimit = quota?.file_count_limit ?? 10000;

  if (storageUsed + newFileSize > storageLimit) {
    return {
      allowed: false,
      reason: `Storage limit exceeded. Used ${(storageUsed / (1024 * 1024)).toFixed(2)}MB / ${(storageLimit / (1024 * 1024)).toFixed(2)}MB. File adds ${(newFileSize / (1024 * 1024)).toFixed(2)}MB.`,
      code: "STORAGE_LIMIT_EXCEEDED",
    } as const;
  }

  if (fileCount + 1 > fileCountLimit) {
    return {
      allowed: false,
      reason: `File count limit exceeded (${fileCountLimit}).` ,
      code: "FILE_COUNT_LIMIT_EXCEEDED",
    } as const;
  }

  return { allowed: true } as const;
}

// ------------------------------
// Upload file
// ------------------------------
router.post(
  "/upload",
  authMiddleware,
  upload.single("file"),
  async (req: Request, res: Response) => {
    try {
      const file = req.file;
      const userId = (req as any).userId as string;
      const parentId = req.body.parentId; // Get parentId from form data

      if (!file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      // Enforce quota limits
      const quotaCheck = await enforceQuotaOnUpload(userId, file.size);
      if (!quotaCheck.allowed) {
        return res.status(403).json({ error: quotaCheck.reason, code: quotaCheck.code });
      }

      const fileExt = getFileExt(file.originalname) || undefined;
      const fileName = `${Date.now()}-${Math.random().toString(36).substring(2)}${fileExt ? "." + fileExt : ""}`;

      // Upload to Supabase Storage
      const { data: uploadData, error: uploadError } = await supabase.storage
        .from("files")
        .upload(`${userId}/${fileName}`, file.buffer, {
          contentType: file.mimetype,
          upsert: false,
        });

      if (uploadError) throw uploadError;

      // Save file metadata to database (align with DB schema)
      const { data: fileData, error: dbError } = await supabase
        .from("files")
        .insert([
          {
            user_id: userId,
            name: file.originalname, // display name
            original_name: file.originalname,
            size: file.size,
            type: file.mimetype,
            mime_type: file.mimetype,
            extension: fileExt,
            path: uploadData?.path,
            parent_id: parentId || null,
            // storage_bucket defaults to 'files'
          },
        ])
        .select()
        .single();

      if (dbError) throw dbError;

      // Emit real-time event to the user's room
      const io = req.app.get("io");
      io?.to(`user:${userId}`).emit("file:created", {
        id: fileData.id,
        name: fileData.name,
        size: fileData.size,
        type: fileData.type,
        path: fileData.path,
        created_at: fileData.created_at,
      });

      return res.json({
        message: "File uploaded successfully",
        file: fileData,
      });
    } catch (error) {
      console.error("Upload error:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

// ------------------------------
// List files (filters + pagination + search)
// ------------------------------
router.get("/", authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId as string;
    const includeDeleted = String(req.query.deleted ?? "false").toLowerCase() === "true";
    const parentIdRaw = (req.query.parentId as string | undefined) ?? undefined; // 'root' | UUID | undefined
    const starred = String(req.query.starred ?? "false").toLowerCase() === "true";
    const recent = String(req.query.recent ?? "false").toLowerCase() === "true";
    const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10));
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "20"), 10)));
    const search = (req.query.search as string | undefined)?.trim();
    const sortBy = (req.query.sortBy as string | undefined) ?? "created_at"; // name, size, created_at, updated_at
    const sortOrder = (req.query.sortOrder as string | undefined) ?? "desc"; // asc, desc

    // Base query
    let select = supabase.from("files").select("*", { count: "exact" }).eq("user_id", userId);

    // Deleted filter
    select = select.eq("is_deleted", includeDeleted);

    // Parent folder filter
    if (typeof parentIdRaw !== "undefined") {
      if (parentIdRaw === "" || parentIdRaw === "root" || parentIdRaw === "null") {
        // Supabase needs .is for NULL
        // @ts-ignore
        select = (select as any).is("parent_id", null);
      } else {
        select = select.eq("parent_id", parentIdRaw);
      }
    }

    // Starred filter
    if (starred) select = select.eq("is_starred", true);

    // Search: prefer FTS when enabled, fallback to ILIKE
    let useFTS = false;
    if (search && search.length > 1 && String(process.env.USE_FTS || 'false').toLowerCase() === 'true') {
      useFTS = true;
    }

    // Ordering
    const validSortFields = ["name", "size", "created_at", "updated_at"];
    const sortField = validSortFields.includes(sortBy) ? sortBy : "created_at";
    const ascending = sortOrder === "asc";
    select = select.order(sortField, { ascending });

    const from = (page - 1) * limit;
    const to = from + limit - 1;

    if (useFTS) {
      try {
        // Try FTS on a tsvector column named 'search_vector'
        // @ts-ignore
        const ftsSelect = (select as any).textSearch('search_vector', search, { config: 'english' });
        const { data: files, error, count } = await ftsSelect.range(from, to);
        if (!error) {
          return res.json({ files, page, limit, total: count ?? files?.length ?? 0, fts: true });
        }
        // If FTS fails, fall back to ILIKE
        console.warn('FTS failed, falling back to ILIKE:', error?.message);
      } catch (e) {
        console.warn('FTS not available, falling back to ILIKE');
      }
    }

    // Fallback/basic search (ILIKE on name and original_name)
    if (search && search.length > 1) {
      // @ts-ignore - supabase-js or typing
      select = (select as any).or(`name.ilike.%${search}% , original_name.ilike.%${search}%`);
    }

    const { data: files, error, count } = await select.range(from, to);
    if (error) throw error;

    return res.json({ files, page, limit, total: count ?? files?.length ?? 0, fts: false });
  } catch (error) {
    console.error("List files error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ------------------------------
// Create folder
// ------------------------------
router.post("/folders", authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId as string;
    const { name, parentId } = req.body as { name?: string; parentId?: string | null };
    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Folder name is required" });
    }

    const payload: any = {
      user_id: userId,
      name: name.trim(),
      original_name: name.trim(),
      size: 0,
      type: "folder",
      is_folder: true,
      parent_id: parentId || null,
      path: `${userId}/folders/${Date.now()}-${Math.random().toString(36).slice(2)}`,
    };

    const { data: folder, error } = await supabase.from("files").insert([payload]).select().single();
    if (error) throw error;

    const io = req.app.get("io");
    io?.to(`user:${userId}`).emit("folder:created", {
      id: folder.id,
      name: folder.name,
      parent_id: folder.parent_id,
      created_at: folder.created_at,
    });

    return res.json({ message: "Folder created", folder });
  } catch (error) {
    console.error("Create folder error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ------------------------------
// Update file metadata (rename, move, star)
// ------------------------------
router.patch("/:id", authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId as string;
    const fileId = req.params.id;
    const { name, parentId, starred } = req.body as { name?: string; parentId?: string | null; starred?: boolean };

    // Verify ownership
    const { data: exists, error: exErr } = await supabase
      .from("files")
      .select("id, user_id")
      .eq("id", fileId)
      .eq("user_id", userId)
      .single();
    if (exErr || !exists) {
      return res.status(404).json({ error: "File not found" });
    }

    const update: any = {};
    if (typeof name === 'string' && name.trim()) update.name = name.trim(), update.original_name = name.trim();
    if (typeof parentId !== 'undefined') update.parent_id = parentId || null;
    if (typeof starred === 'boolean') update.is_starred = starred;

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: "No changes provided" });
    }

    const { data: updated, error } = await supabase
      .from("files")
      .update(update)
      .eq("id", fileId)
      .select()
      .single();
    if (error) throw error;

    const io = req.app.get("io");
    io?.to(`user:${userId}`).emit("file:updated", {
      id: updated.id,
      name: updated.name,
      parent_id: updated.parent_id,
      is_starred: (updated as any).is_starred,
      updated_at: updated.updated_at,
    });

    return res.json({ message: "File updated", file: updated });
  } catch (error) {
    console.error("Update file error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ------------------------------
// Soft delete file (move to trash)
// ------------------------------
router.delete("/:id", authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId as string;
    const fileId = req.params.id;

    // Verify ownership
    const { data: file, error: fetchError } = await supabase
      .from("files")
      .select("id, user_id, is_deleted")
      .eq("id", fileId)
      .eq("user_id", userId)
      .single();

    if (fetchError || !file) {
      return res.status(404).json({ error: "File not found" });
    }

    if (file.is_deleted === true) {
      return res.status(409).json({ error: "File already in trash" });
    }

    // Soft delete
    const { error: dbError } = await supabase
      .from("files")
      .update({ is_deleted: true, deleted_at: new Date().toISOString() })
      .eq("id", fileId);

    if (dbError) throw dbError;

    // Emit real-time deletion event
    const io = req.app.get("io");
    io?.to(`user:${userId}`).emit("file:deleted", { id: fileId, soft: true });

    return res.json({ message: "File moved to trash" });
  } catch (error) {
    console.error("Soft delete file error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ------------------------------
// Restore file from trash
// ------------------------------
router.post("/:id/restore", authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId as string;
    const fileId = req.params.id;

    // Verify ownership
    const { data: file, error: fetchError } = await supabase
      .from("files")
      .select("id, user_id, is_deleted")
      .eq("id", fileId)
      .eq("user_id", userId)
      .single();

    if (fetchError || !file) {
      return res.status(404).json({ error: "File not found" });
    }

    if (file.is_deleted !== true) {
      return res.status(409).json({ error: "File is not in trash" });
    }

    const { error: dbError } = await supabase
      .from("files")
      .update({ is_deleted: false, deleted_at: null })
      .eq("id", fileId);

    if (dbError) throw dbError;

    const io = req.app.get("io");
    io?.to(`user:${userId}`).emit("file:restored", { id: fileId });

    return res.json({ message: "File restored" });
  } catch (error) {
    console.error("Restore file error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ------------------------------
// Permanently delete file (storage + DB)
// ------------------------------
router.delete("/:id/permanent", authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId as string;
    const fileId = req.params.id;

    // Fetch file
    const { data: file, error: fetchError } = await supabase
      .from("files")
      .select("id, user_id, path, is_deleted")
      .eq("id", fileId)
      .eq("user_id", userId)
      .single();

    if (fetchError || !file) {
      return res.status(404).json({ error: "File not found" });
    }

    // Remove from storage
    if (file.path) {
      const { error: storageError } = await supabase.storage
        .from("files")
        .remove([file.path]);
      if (storageError) {
        console.error("Storage deletion error:", storageError);
      }
    }

    // Delete DB row
    const { error: dbError } = await supabase
      .from("files")
      .delete()
      .eq("id", fileId);

    if (dbError) throw dbError;

    const io = req.app.get("io");
    io?.to(`user:${userId}`).emit("file:deleted", { id: fileId, soft: false });

    return res.json({ message: "File permanently deleted" });
  } catch (error) {
    console.error("Permanent delete file error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ------------------------------
// Download file (signed URL) - owner or shared user with at least view
// ------------------------------
router.get(
  "/:id/download",
  authMiddleware,
  async (req: Request, res: Response) => {
    try {
      const userId = (req as any).userId as string;
      const fileId = req.params.id;

      // Check permissions (owner or shared)
      const perm = await hasFilePermission(userId, fileId, "view");
      if (!perm.allowed) return res.status(403).json({ error: "Access denied" });

      const { data: file, error } = await supabase
        .from("files")
        .select("*")
        .eq("id", fileId)
        .eq("is_deleted", false)
        .single();

      if (error || !file) {
        return res.status(404).json({ error: "File not found" });
      }

      // Get signed URL for secure download
      const { data: signedUrl, error: urlError } = await supabase.storage
        .from("files")
        .createSignedUrl(file.path, 3600); // 1 hour expiry

      if (urlError) throw urlError;

      return res.json({
        downloadUrl: signedUrl?.signedUrl,
        file: {
          id: file.id,
          name: file.name,
          size: file.size,
          type: file.type,
        },
      });
    } catch (error) {
      console.error("Download file error:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

// ------------------------------
// File versioning
// ------------------------------
// Create a new version for an existing file
router.post(
  "/:id/versions",
  authMiddleware,
  upload.single("file"),
  async (req: Request, res: Response) => {
    try {
      const userId = (req as any).userId as string;
      const fileId = req.params.id;
      const fileBlob = req.file;

      if (!fileBlob) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      // Verify file ownership and not deleted
      const { data: file, error: fileErr } = await supabase
        .from("files")
        .select("id, user_id")
        .eq("id", fileId)
        .eq("user_id", userId)
        .eq("is_deleted", false)
        .single();

      if (fileErr || !file) {
        return res.status(404).json({ error: "File not found" });
      }

      // Upload version blob
      const ext = getFileExt(fileBlob.originalname) || undefined;
      const versionName = `${Date.now()}-${Math.random().toString(36).substring(2)}${ext ? "." + ext : ""}`;
      const versionPath = `${userId}/versions/${fileId}/${versionName}`;

      const { error: upErr } = await supabase.storage
        .from("files")
        .upload(versionPath, fileBlob.buffer, {
          contentType: fileBlob.mimetype,
          upsert: false,
        });
      if (upErr) throw upErr;

      // Determine next version number
      const { data: lastVersion, error: lvErr } = await supabase
        .from("file_versions")
        .select("version_number")
        .eq("file_id", fileId)
        .order("version_number", { ascending: false })
        .limit(1)
        .maybeSingle();

      const nextVersion = (lastVersion?.version_number ?? 0) + 1;

      // Insert version record
      const { data: version, error: verErr } = await supabase
        .from("file_versions")
        .insert([
          {
            file_id: fileId,
            version_number: nextVersion,
            size: fileBlob.size,
            path: versionPath,
            change_type: "update",
            created_by: userId,
          },
        ])
        .select()
        .single();
      if (verErr) throw verErr;

      // Optionally update main file metadata to reflect latest version
      const { error: updErr } = await supabase
        .from("files")
        .update({
          size: fileBlob.size,
          type: fileBlob.mimetype,
          mime_type: fileBlob.mimetype,
          extension: ext,
          path: versionPath,
        })
        .eq("id", fileId);
      if (updErr) throw updErr;

      const io = req.app.get("io");
      io?.to(`user:${userId}`).emit("file:updated", { id: fileId, version: version.version_number });

      return res.json({ message: "New version created", version });
    } catch (error) {
      console.error("Create version error:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

// List versions of a file
router.get(
  "/:id/versions",
  authMiddleware,
  async (req: Request, res: Response) => {
    try {
      const userId = (req as any).userId as string;
      const fileId = req.params.id;

      // Verify ownership
      const { data: file, error: fileErr } = await supabase
        .from("files")
        .select("id")
        .eq("id", fileId)
        .eq("user_id", userId)
        .single();

      if (fileErr || !file) {
        return res.status(404).json({ error: "File not found" });
      }

      const { data: versions, error } = await supabase
        .from("file_versions")
        .select("id, version_number, size, path, change_type, created_by, created_at")
        .eq("file_id", fileId)
        .order("version_number", { ascending: false });

      if (error) throw error;

      return res.json({ versions });
    } catch (error) {
      console.error("List versions error:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

// Restore a specific version
router.post(
  "/:id/versions/:versionNumber/restore",
  authMiddleware,
  async (req: Request, res: Response) => {
    try {
      const userId = (req as any).userId as string;
      const fileId = req.params.id;
      const versionNumber = parseInt(req.params.versionNumber, 10);

      if (Number.isNaN(versionNumber)) {
        return res.status(400).json({ error: "Invalid version number" });
      }

      // Verify ownership
      const { data: file, error: fileErr } = await supabase
        .from("files")
        .select("id")
        .eq("id", fileId)
        .eq("user_id", userId)
        .single();
      if (fileErr || !file) {
        return res.status(404).json({ error: "File not found" });
      }

      // Fetch version
      const { data: version, error: vErr } = await supabase
        .from("file_versions")
        .select("version_number, size, path")
        .eq("file_id", fileId)
        .eq("version_number", versionNumber)
        .single();
      if (vErr || !version) {
        return res.status(404).json({ error: "Version not found" });
      }

      // Apply restore to main file
      const { error: updErr } = await supabase
        .from("files")
        .update({ path: version.path, size: version.size })
        .eq("id", fileId);
      if (updErr) throw updErr;

      // Record restore as a new version entry
      const { data: lastVersion, error: lvErr } = await supabase
        .from("file_versions")
        .select("version_number")
        .eq("file_id", fileId)
        .order("version_number", { ascending: false })
        .limit(1)
        .maybeSingle();
      const nextVersion = (lastVersion?.version_number ?? 0) + 1;

      const { error: recErr } = await supabase
        .from("file_versions")
        .insert([
          {
            file_id: fileId,
            version_number: nextVersion,
            size: version.size,
            path: version.path,
            change_type: "restore",
            created_by: userId,
          },
        ]);
      if (recErr) throw recErr;

      const io = req.app.get("io");
      io?.to(`user:${userId}`).emit("file:updated", { id: fileId, restoredFrom: versionNumber });

      return res.json({ message: "File restored to selected version" });
    } catch (error) {
      console.error("Restore version error:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

export default router;