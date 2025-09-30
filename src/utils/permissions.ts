// backend/src/utils/permissions.ts
import { supabase } from "../lib/supabase";

export type PermissionLevel = "view" | "edit" | "owner";

// Fetch current user's email (from profiles)
export async function getCurrentUserEmail(userId: string): Promise<string | null> {
  const { data: user, error } = await supabase
    .from("profiles")
    .select("email")
    .eq("id", userId)
    .single();
  if (error || !user) return null;
  return user.email as string;
}

// Check if the user is the owner of the file
export async function isOwner(userId: string, fileId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("files")
    .select("id")
    .eq("id", fileId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) return false;
  return !!data;
}

// Check whether a user has at least the required permission on a file
export async function hasFilePermission(
  userId: string,
  fileId: string,
  needed: PermissionLevel
): Promise<{ allowed: boolean; level: PermissionLevel | null }> {
  // Owner always allowed
  if (await isOwner(userId, fileId)) {
    return { allowed: true, level: "owner" };
  }

  if (needed === "owner") {
    return { allowed: false, level: null };
  }

  // Otherwise, check share permissions by email
  const email = await getCurrentUserEmail(userId);
  if (!email) return { allowed: false, level: null };

  const { data: share, error } = await supabase
    .from("shares")
    .select("permissions")
    .eq("file_id", fileId)
    .eq("shared_with_email", email)
    .maybeSingle();

  if (error || !share) return { allowed: false, level: null };

  const perm = (share as any).permissions as "view" | "edit" | "admin";
  const level: PermissionLevel = perm === "view" ? "view" : "edit"; // treat admin as edit

  if (needed === "view") {
    return { allowed: true, level };
  }
  if (needed === "edit") {
    return { allowed: level === "edit", level };
  }

  return { allowed: false, level: null };
}