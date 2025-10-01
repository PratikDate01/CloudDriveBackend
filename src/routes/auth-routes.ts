import { Router, Request, Response } from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import passport from "passport";
import { Strategy as GoogleStrategy, Profile } from "passport-google-oauth20";
import { supabase } from "../lib/supabase";

// ==============================
// Google OAuth with Passport
// ==============================
passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID || "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
      callbackURL: (process.env.BACKEND_URL || "https://clouddrivebackend.onrender.com") + "/api/auth/google/callback",
    },
    async (
      accessToken: string,
      refreshToken: string,
      profile: Profile,
      done
    ) => {
      try {
        const email = profile.emails?.[0]?.value;
        const firstName = profile.name?.givenName;
        const lastName = profile.name?.familyName;
        const googleId = profile.id;

        if (!email) {
          return done(new Error("No email found in Google profile"), false);
        }

        // Check if user already exists
        let { data: existingUser } = await supabase
          .from("profiles")
          .select("*")
          .eq("email", email)
          .single();

        if (!existingUser) {
          // Create new user
          const { data: newUser, error: insertError } = await supabase
            .from("profiles")
            .insert({
              email,
              first_name: firstName || null,
              last_name: lastName || null,
              google_id: googleId,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .select()
            .single();

          if (insertError) {
            console.error("Google OAuth registration error:", insertError);
            return done(insertError, false);
          }

          existingUser = newUser;
        } else if (!existingUser.google_id) {
          // Update Google ID if not set
          await supabase
            .from("profiles")
            .update({
              google_id: googleId,
              updated_at: new Date().toISOString(),
            })
            .eq("id", existingUser.id);
        }

        return done(null, existingUser);
      } catch (error) {
        console.error("Google OAuth error:", error);
        return done(error as Error, false);
      }
    }
  )
);

passport.serializeUser((user: any, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id: string, done) => {
  try {
    const { data: user, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", id)
      .single();

    if (error || !user) return done(error, null);

    done(null, user);
  } catch (error) {
    done(error as Error, null);
  }
});

// ==============================
// Router Setup
// ==============================
const router = Router();

// Helper: generate JWT
const generateToken = (userId: string, email: string) => {
  return jwt.sign(
    { userId, email },
    process.env.JWT_SECRET || "your-secret-key",
    { expiresIn: "7d" }
  );
};

// ==============================
// Register
// ==============================
router.post("/register", async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password, firstName, lastName } = req.body;
    console.log("[AUTH] /register called", { email, hasPassword: !!password, firstName, lastName });

    if (!email || !password) {
      res.status(400).json({ error: "Email and password are required" });
      return;
    }

    // Check if user already exists
    const { data: existingUser } = await supabase
      .from("profiles")
      .select("*")
      .eq("email", email)
      .single();

    if (existingUser) {
      res.status(400).json({
        error: "User with this email already exists",
        success: false,
      });
      return;
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 12);

    // Create user
    const { data: newUser, error: insertError } = await supabase
      .from("profiles")
      .insert({
        email,
        password_hash: hashedPassword,
        first_name: firstName || null,
        last_name: lastName || null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (insertError) {
      console.error("❌ Registration error:", insertError);
      res.status(400).json({
        error: insertError.message,
        success: false,
      });
      return;
    }

    const token = generateToken(newUser.id, newUser.email);

    res.status(201).json({
      message: "User registered successfully",
      success: true,
      token,
      user: {
        id: newUser.id,
        email: newUser.email,
        first_name: newUser.first_name,
        last_name: newUser.last_name,
      },
    });
  } catch (error: any) {
    console.error("💥 Registration error:", error);
    res.status(500).json({
      error: "Internal server error",
      success: false,
      message: error.message,
    });
  }
});

// ==============================
// Login
// ==============================
router.post("/login", async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: "Email and password are required" });
      return;
    }

    // Find user
    const { data: user } = await supabase
      .from("profiles")
      .select("*")
      .eq("email", email)
      .single();

    if (!user) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, user.password_hash);
    if (!isPasswordValid) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    const token = generateToken(user.id, user.email);

    res.json({
      message: "Login successful",
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
      },
    });
  } catch (error: any) {
    console.error("💥 Login error:", error);
    res.status(500).json({
      error: "Internal server error",
      success: false,
      message: error.message,
    });
  }
});

// ==============================
// Get Current User
// ==============================
router.get("/me", async (req: Request, res: Response): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Access token required" });
      return;
    }

    const token = authHeader.substring(7);
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || "your-secret-key"
    ) as { userId: string };

    if (!decoded.userId) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }

    const { data: user } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", decoded.userId)
      .single();

    if (!user) {
      res.status(401).json({ error: "User not found" });
      return;
    }

    res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
        created_at: user.created_at,
        updated_at: user.updated_at,
      },
    });
  } catch (error: any) {
    console.error("Get user error:", error);
    res.status(500).json({
      error: "Internal server error",
      success: false,
      message: error.message,
    });
  }
});

// ==============================
// Google OAuth Routes
// ==============================
router.get("/google",
  passport.authenticate("google", {
    scope: ["profile", "email"],
    session: false,
  })
);

router.get("/google/callback",
  passport.authenticate("google", { failureRedirect: "/signin", session: false }),
  async (req: Request, res: Response) => {
    try {
      const user = req.user as any;
      const token = generateToken(user.id, user.email);

      const frontendUrl = process.env.CLIENT_URL || "https://cloud-drive-frontend-six.vercel.app";
      res.redirect(`${frontendUrl}/drive?token=${token}&login=success`);
    } catch (error: any) {
      console.error("Google OAuth callback error:", error);
      res.redirect(`${process.env.CLIENT_URL || "https://cloud-drive-frontend-six.vercel.app"}/signin?error=oauth_failed`);
    }
  }
);

// ==============================
// Logout
// ==============================
router.post("/logout", (_req: Request, res: Response) => {
  res.json({
    success: true,
    message: "Logged out successfully",
  });
});

export default router;
