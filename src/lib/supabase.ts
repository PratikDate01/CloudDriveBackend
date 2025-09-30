// src/lib/supabase.ts
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

// Environment variables
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl) {
  throw new Error("❌ Missing SUPABASE_URL in environment variables");
}
if (!supabaseAnonKey) {
  throw new Error("❌ Missing SUPABASE_ANON_KEY in environment variables");
}

// ✅ Backend client (uses service role key for secure server-side operations)
export const supabase = createClient(
  supabaseUrl,
  supabaseServiceRoleKey || supabaseAnonKey,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
);

// ✅ Frontend client (uses anon key - for client-side operations only)
export const supabaseAnon = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
  },
});

// ------------------------------
// Connectivity check helper
// ------------------------------
export async function checkSupabaseConnection() {
  console.log("🔎 Checking Supabase connectivity...");
  try {
    if (!supabaseUrl) {
      console.error("❌ Missing SUPABASE_URL");
    }
    if (!supabaseAnonKey) {
      console.error("❌ Missing SUPABASE_ANON_KEY");
    }
    if (!supabaseServiceRoleKey) {
      console.warn("⚠️ Missing SUPABASE_SERVICE_ROLE_KEY (admin checks will be skipped)");
    }

    // Basic table read (adjust table name if needed)
    const { data: profiles, error: profilesError } = await supabase
      .from("profiles")
      .select("id")
      .limit(1);

    if (profilesError) {
      console.error("❌ Supabase 'profiles' query failed:", {
        message: profilesError.message,
        details: (profilesError as any)?.details,
        hint: (profilesError as any)?.hint,
        code: (profilesError as any)?.code,
      });
    } else {
      console.log(`✅ Supabase 'profiles' query ok (rows: ${profiles?.length ?? 0})`);
    }

    // Admin check (requires service role key)
    if (supabaseServiceRoleKey) {
      const { data: usersData, error: usersErr } = await supabase.auth.admin.listUsers();
      if (usersErr) {
        console.error("❌ Supabase admin listUsers failed:", {
          message: usersErr.message,
          details: (usersErr as any)?.details,
          hint: (usersErr as any)?.hint,
          code: (usersErr as any)?.code,
        });
      } else {
        console.log(`✅ Supabase admin ok (users: ${usersData?.users?.length ?? 0})`);
      }
    }
  } catch (err: any) {
    console.error("❌ Supabase connectivity check threw:", err?.message || err);
  }
}

// ------------------------------
// Database type definitions
// ------------------------------
export interface User {
  id: string;
  email: string;
  created_at: string;
}

export interface FileRecord {
  id: string;
  user_id: string;
  name: string;
  size: number;
  type: string;
  path: string;
  created_at: string;
  updated_at: string;
}

export interface ShareRecord {
  id: string;
  file_id: string;
  user_id: string;
  shared_with_email: string;
  permissions: "view" | "edit";
  created_at: string;
}
