// src/routes/billing-routes.ts
import { Router, Request, Response } from "express";
import { authMiddleware } from "../middlewares/auth-middleware";
import Stripe from "stripe";
import dotenv from "dotenv";
import { supabase } from "../lib/supabase";

dotenv.config();

const router = Router();

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:5173";

if (!STRIPE_SECRET_KEY) {
  console.warn("[billing] STRIPE_SECRET_KEY is not set. Billing endpoints will be disabled.");
}

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" }) : (null as any);

// Treat only real Stripe price IDs as valid (avoids placeholders like "price_123...")
const isValidPriceId = (v?: string | null) => !!v && /^price_[A-Za-z0-9]+$/.test(v);

// Plans config: Use env for price IDs and storage limits.
const PLANS = [
  {
    id: "free",
    name: "Free",
    description: "Great to get started",
    priceMonthly: 0,
    currency: "usd",
    priceId: null as string | null,
    storageLimitBytes: Number(process.env.FREE_STORAGE_LIMIT_BYTES || 5 * 1024 * 1024 * 1024), // 5GB
    fileCountLimit: Number(process.env.FREE_FILE_COUNT_LIMIT || 10000),
  },
  {
    id: "pro",
    name: "Pro",
    description: "For power users",
    priceMonthly: Number(process.env.PRO_PRICE_MONTHLY || 9),
    currency: "usd",
    priceId: process.env.STRIPE_PRICE_ID_PRO && isValidPriceId(process.env.STRIPE_PRICE_ID_PRO) ? process.env.STRIPE_PRICE_ID_PRO : null,
    storageLimitBytes: Number(process.env.PRO_STORAGE_LIMIT_BYTES || 200 * 1024 * 1024 * 1024), // 200GB
    fileCountLimit: Number(process.env.PRO_FILE_COUNT_LIMIT || 100000),
  },
  {
    id: "business",
    name: "Business",
    description: "For teams and heavy usage",
    priceMonthly: Number(process.env.BUSINESS_PRICE_MONTHLY || 19),
    currency: "usd",
    priceId: process.env.STRIPE_PRICE_ID_BUSINESS && isValidPriceId(process.env.STRIPE_PRICE_ID_BUSINESS) ? process.env.STRIPE_PRICE_ID_BUSINESS : null,
    storageLimitBytes: Number(process.env.BUSINESS_STORAGE_LIMIT_BYTES || 2 * 1024 * 1024 * 1024 * 1024), // 2TB
    fileCountLimit: Number(process.env.BUSINESS_FILE_COUNT_LIMIT || 1000000),
  },
] as const;

// Public prices endpoint (no auth needed to display tiers)
router.get("/prices", async (_req: Request, res: Response) => {
  try {
    return res.json({ plans: PLANS.map(({ priceId, ...p }) => ({ ...p, hasPrice: isValidPriceId(priceId) })) });
  } catch (error) {
    console.error("[billing] prices error", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Create Checkout Session for subscription upgrades
router.post("/checkout", authMiddleware, async (req: Request, res: Response) => {
  try {
    if (!stripe) return res.status(503).json({ error: "Billing not configured" });

    const userId = (req as any).userId as string;
    const { priceId, planId } = req.body as { priceId?: string; planId?: string };

    const plan = PLANS.find(p => (priceId ? p.priceId === priceId : p.id === planId));
    if (!plan || !isValidPriceId(plan.priceId)) {
      return res.status(400).json({ error: "Plan is not configured. Please try again later." });
    }

    // Fetch user's email for customer record
    const { data: profile } = await supabase
      .from("profiles")
      .select("email")
      .eq("id", userId)
      .maybeSingle();

    const successUrl = `${CLIENT_URL}/profile?billing=success`;
    const cancelUrl = `${CLIENT_URL}/profile?billing=cancel`;

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: plan.priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      customer_email: profile?.email || undefined,
      metadata: { userId, planId: plan.id },
      subscription_data: {
        metadata: { userId, planId: plan.id },
      },
    });

    return res.json({ url: session.url });
  } catch (error: any) {
    console.error("[billing] checkout error", error);
    return res.status(500).json({ error: error?.message || "Internal server error" });
  }
});

// Stripe webhook to finalize upgrades/downgrades
// IMPORTANT: Mount this handler BEFORE express.json() in server.ts
export async function stripeWebhookRawHandler(req: Request, res: Response) {
  try {
    if (!stripe) return res.sendStatus(200);

    const sig = (req.headers["stripe-signature"] as string) || "";
    const whSecret = process.env.STRIPE_WEBHOOK_SECRET || "";

    let event: Stripe.Event;
    if (whSecret) {
      try {
        event = stripe.webhooks.constructEvent(req.body as any, sig, whSecret);
      } catch (err: any) {
        console.error("[billing] webhook signature verify failed", err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
      }
    } else {
      // If no webhook secret provided, accept event blindly (dev only)
      event = req.body as any;
    }

    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId = (session.metadata as any)?.userId as string | undefined;
        const planId = (session.metadata as any)?.planId as string | undefined;
        if (userId && planId) {
          const plan = PLANS.find(p => p.id === planId);
          if (plan) {
            await supabase
              .from("user_quotas")
              .upsert(
                {
                  user_id: userId,
                  plan: plan.id,
                  storage_limit: plan.storageLimitBytes,
                  file_count_limit: plan.fileCountLimit,
                },
                { onConflict: "user_id" }
              );
          }
        }
        break;
      }
      case "customer.subscription.updated":
      case "customer.subscription.created": {
        const sub = event.data.object as Stripe.Subscription;
        const userId = (sub.metadata as any)?.userId as string | undefined;
        const planId = (sub.metadata as any)?.planId as string | undefined;
        if (userId && planId) {
          const plan = PLANS.find(p => p.id === planId);
          if (plan) {
            await supabase
              .from("user_quotas")
              .upsert(
                {
                  user_id: userId,
                  plan: plan.id,
                  storage_limit: plan.storageLimitBytes,
                  file_count_limit: plan.fileCountLimit,
                },
                { onConflict: "user_id" }
              );
          }
        }
        break;
      }
      case "customer.subscription.deleted": {
        // Revert to free on cancellation
        const sub = event.data.object as Stripe.Subscription;
        const userId = (sub.metadata as any)?.userId as string | undefined;
        const plan = PLANS[0]; // free
        if (userId) {
          await supabase
            .from("user_quotas")
            .upsert(
              {
                user_id: userId,
                plan: plan.id,
                storage_limit: plan.storageLimitBytes,
                file_count_limit: plan.fileCountLimit,
              },
              { onConflict: "user_id" }
            );
        }
        break;
      }
      default:
        // ignore others
        break;
    }

    return res.sendStatus(200);
  } catch (error) {
    console.error("[billing] webhook error", error);
    return res.sendStatus(500);
  }
}

export default router;