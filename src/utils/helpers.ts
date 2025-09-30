// src/utils/helpers.ts
import { supabase } from "../lib/supabase";

/**
 * Generate a unique filename
 */
export const generateUniqueFileName = (originalName: string): string => {
  const timestamp = Date.now();
  const randomString = Math.random().toString(36).substring(2, 15);
  const fileExtension = originalName.includes(".")
    ? originalName.split(".").pop()
    : "";
  return fileExtension
    ? `${timestamp}-${randomString}.${fileExtension}`
    : `${timestamp}-${randomString}`;
};

/**
 * Get file size in human-readable format
 */
export const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return "0 Bytes";

  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
};

/**
 * Validate file type
 */
export const isValidFileType = (
  mimeType: string,
  allowedTypes: string[]
): boolean => {
  return allowedTypes.includes(mimeType);
};

/**
 * Get signed URL for file access
 */
export const getSignedUrl = async (
  filePath: string,
  expiresIn: number = 3600
): Promise<string | null> => {
  try {
    const { data, error } = await supabase.storage
      .from("files")
      .createSignedUrl(filePath, expiresIn);

    if (error) {
      console.error("Error creating signed URL:", error.message);
      return null;
    }

    return data?.signedUrl ?? null;
  } catch (error) {
    console.error("Error in getSignedUrl:", error);
    return null;
  }
};

/**
 * Check if user has permission to access a file
 */
export const checkFilePermission = async (
  fileId: string,
  userId: string,
  requiredPermission: "view" | "edit" = "view"
): Promise<boolean> => {
  try {
    // Check if user owns the file
    const { data: file, error: fileError } = await supabase
      .from("files")
      .select("user_id")
      .eq("id", fileId)
      .single();

    if (fileError || !file) {
      return false;
    }

    if (file.user_id === userId) {
      return true; // Owner always has full permissions
    }

    // Get user email (profiles table)
    const { data: user, error: userError } = await supabase
      .from("profiles")
      .select("email")
      .eq("id", userId)
      .single();

    if (userError || !user) {
      return false;
    }

    // Check if file is shared with this user
    const { data: share, error: shareError } = await supabase
      .from("shares")
      .select("permissions")
      .eq("file_id", fileId)
      .eq("shared_with_email", user.email)
      .maybeSingle();

    if (shareError || !share) {
      return false;
    }

    if (requiredPermission === "view") {
      return ["view", "edit"].includes(share.permissions); // edit implies view
    }

    if (requiredPermission === "edit") {
      return share.permissions === "edit";
    }

    return false;
  } catch (error) {
    console.error("Error checking file permission:", error);
    return false;
  }
};

/**
 * Clean up expired signed URLs (for scheduled jobs)
 */
export const cleanupExpiredSignedUrls = async (): Promise<void> => {
  // Placeholder for background tasks
  console.log("Cleaning up expired signed URLs...");
};
