// src/server.ts
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import dotenv from "dotenv";
import authRoutes from "./routes/auth-routes";
import fileRoutes from "./routes/file-operations";
import shareRoutes from "./routes/share-operations";
import userRoutes from "./routes/users-routes";
import { supabase, checkSupabaseConnection } from "./lib/supabase";
import passport from "passport";
import billingRoutes, { stripeWebhookRawHandler } from "./routes/billing-routes";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// ------------------------------
// Middleware
// ------------------------------
app.use(
  cors({
    origin: [
      process.env.CLIENT_URL || "https://cloud-drive-frontend-six.vercel.app",
      "http://localhost:5173"
    ], // allow frontend origin and localhost for testing
    credentials: true,
  })
);

// Stripe webhook must be mounted BEFORE express.json to preserve raw body
app.post(
  "/api/billing/webhook",
  (express as any).raw({ type: "application/json" }),
  async (req: Request, res: Response) => {
    return stripeWebhookRawHandler(req, res);
  }
);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// Initialize passport (no sessions)
app.use(passport.initialize());

// Basic request logger for auth routes (sanitize sensitive fields)
app.use((req: Request, _res: Response, next: NextFunction) => {
  if (req.path.startsWith('/api/auth')) {
    const safeBody: any = req.body ? { ...req.body } : {};
    if (typeof safeBody.password !== 'undefined') safeBody.password = '***';
    if (typeof safeBody.confirmPassword !== 'undefined') safeBody.confirmPassword = '***';
    console.log(`[REQ] ${req.method} ${req.path}`, { query: req.query, body: safeBody });
  }
  next();
});

// ------------------------------
// Routes
// ------------------------------
app.use("/api/auth", authRoutes);
app.use("/api/files", fileRoutes);
app.use("/api/shares", shareRoutes);
app.use("/api/users", userRoutes);
app.use("/api/billing", billingRoutes);

// Health check
app.get("/api/health", (_req: Request, res: Response) => {
  res.json({ status: "OK", message: "CloudDrive Backend is running 🚀" });
});

// Additional Supabase connectivity check (on-demand)
app.get("/api/health/supabase", async (_req: Request, res: Response) => {
  await checkSupabaseConnection();
  res.json({ ok: true, message: "Supabase connectivity check executed. See server logs for details." });
});

// ------------------------------
// Supabase test endpoint
// ------------------------------
app.get("/test-supabase", async (_req: Request, res: Response) => {
  try {
    // Test reading from tables
    const { data: profiles, error: pErr } = await supabase.from("profiles").select("*").limit(5);
    const { data: files, error: fErr } = await supabase.from("files").select("*").limit(5);
    const { data: fileVersions, error: fvErr } = await supabase.from("file_versions").select("*").limit(5);
    const { data: shares, error: sErr } = await supabase.from("shares").select("*").limit(5);

    // Test auth.users table (requires service role key)
    const { data: authUsers, error: auErr } = await supabase.auth.admin.listUsers();

    return res.json({
      ok: true,
      env: {
        url: !!process.env.SUPABASE_URL,
        anon: !!process.env.SUPABASE_ANON_KEY,
        service_role: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      },
      tables: {
        profiles: { count: profiles?.length ?? 0, error: pErr?.message ?? null },
        files: { count: files?.length ?? 0, error: fErr?.message ?? null },
        file_versions: { count: fileVersions?.length ?? 0, error: fvErr?.message ?? null },
        shares: { count: shares?.length ?? 0, error: sErr?.message ?? null },
      },
      auth: {
        users_count: authUsers?.users?.length ?? 0,
        error: auErr?.message ?? null,
      },
    });
  } catch (err: any) {
    console.error("❌ Supabase test error:", err);
    return res.status(500).json({ ok: false, message: err.message });
  }
});

// ------------------------------
// Error handling middleware
// ------------------------------
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error("❌ Server error:", err.stack || err);
  res.status(500).json({ error: "Something went wrong!" });
});

// ------------------------------
// Start server with Socket.IO
// ------------------------------
import http from "http";
import { setupRealtime } from "./realtime/socket";

const httpServer = http.createServer(app);
const io = setupRealtime(httpServer);

// Make io accessible to routes via app instance
app.set("io", io);

httpServer.listen(PORT, () => {
  console.log(`✅ Server is running on http://localhost:${PORT}`);
  // Run a startup connectivity check (non-blocking)
  checkSupabaseConnection();
});

export default app;
