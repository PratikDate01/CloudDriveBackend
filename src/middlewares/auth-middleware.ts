import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { supabase } from "../lib/supabase";

// ==============================
// Extend Express Request
// ==============================
declare module "express-serve-static-core" {
  interface Request {
    userId?: string;
    user?: any;
  }
}

// ==============================
// JWT Payload Type
// ==============================
interface JwtPayload {
  userId: string;
  email: string;
  iat?: number;
  exp?: number;
}

// ==============================
// Auth Middleware
// ==============================
export const authMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Access token required" });
      return;
    }

    const token = authHeader.substring(7);

    // Verify JWT
    let decoded: JwtPayload;
    try {
      decoded = jwt.verify(
        token,
        process.env.JWT_SECRET || "your-secret-key"
      ) as JwtPayload;
    } catch (err) {
      console.error("❌ JWT verification failed:", err);
      res.status(401).json({ error: "Invalid or expired token" });
      return;
    }

    if (!decoded.userId) {
      res.status(401).json({ error: "Invalid token payload" });
      return;
    }

    // Check if user still exists
    const { data: user, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", decoded.userId)
      .single();

    if (error || !user) {
      console.error(
        "❌ Auth middleware: User not found in profiles table:",
        error?.message
      );
      res.status(401).json({ error: "User not found" });
      return;
    }

    // Attach user to request
    req.userId = decoded.userId;
    req.user = user;

    next();
  } catch (error) {
    console.error("💥 Auth middleware error:", error);
    res.status(401).json({ error: "Unauthorized" });
  }
};
