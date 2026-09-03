import "dotenv/config";
import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import Groq from "groq-sdk";
import Razorpay from "razorpay";
import { OAuth2Client } from "google-auth-library";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { User, Event, Registration, PaymentEvent, RiskQueue, MessageLog, AuditLog } from "./models.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || "eventpay-sentinel-secret";
const KEEP_ALIVE_URL = process.env.KEEP_ALIVE_URL || process.env.RENDER_EXTERNAL_URL || "";
const KEEP_ALIVE_INTERVAL = 14 * 60 * 1000 + 59 * 1000;

// Render keep-alive: opt-in through the public service URL, no UI surface required.
function startKeepAlive() {
  if (!KEEP_ALIVE_URL || process.env.NODE_ENV !== "production") return;
  const ping = async () => {
    try {
      const healthUrl = new URL("/api/health", KEEP_ALIVE_URL).toString();
      await fetch(healthUrl, { headers: { "x-eventpay-keepalive": "1" } });
    } catch (e) {
      console.warn("Keep-alive ping failed:", e.message);
    }
  };
  const timer = setInterval(ping, KEEP_ALIVE_INTERVAL);
  timer.unref();
}

// ============ HELPERS ============
function razorpayErrorMessage(e) {
  return e?.error?.description || e?.message || JSON.stringify(e);
}

// ============ RATE LIMITING ============
const rateLimits = {};
function rateLimit(key, maxRequests = 30, windowMs = 60000) {
  const now = Date.now();
  if (!rateLimits[key]) rateLimits[key] = [];
  rateLimits[key] = rateLimits[key].filter(t => now - t < windowMs);
  if (rateLimits[key].length >= maxRequests) return false;
  rateLimits[key].push(now);
  return true;
}

// ============ RAZORPAY WEBHOOK (raw body needed) ============
app.post("/api/webhooks/razorpay", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const body = req.body.toString("utf8");
    const webhookEvent = JSON.parse(body);
    const payment = webhookEvent.payload?.payment?.entity;
    if (!payment) return res.json({ received: true });

    const eventId = payment.notes?.eventId || "";
    
    // Look up event to get its webhook secret for verification
    let webhookSecret = "";
    if (eventId) {
      const evt = await Event.findById(eventId);
      if (evt) webhookSecret = evt.razorpayWebhookSecret;
    }

    // Verify signature — MANDATORY if webhook secret is configured
    if (webhookSecret) {
      const signature = req.headers["x-razorpay-signature"];
      const expected = crypto.createHmac("sha256", webhookSecret).update(req.body).digest("hex");
      if (!signature || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
        return res.status(401).json({ error: "Invalid signature — webhook rejected" });
      }
    } else {
      // No webhook secret: accept but mark as unverified (manual review required)
      console.warn("Webhook received without verification — no secret configured for event:", eventId);
    }

    // Store payment event
    const existing = await PaymentEvent.findOne({ razorpayPaymentId: payment.id });
    if (existing) return res.json({ received: true, duplicate: true });

    const regId = payment.notes?.registrationId || "";

    const pe = await PaymentEvent.create({
      eventId: eventId || undefined, registrationId: regId, razorpayPaymentId: payment.id,
      razorpayOrderId: payment.order_id || "", paymentLinkId: payment.payment_link_id || "",
      utr: payment.acquirer_data?.utr || "", amount: payment.amount / 100, currency: payment.currency,
      status: webhookEvent.event === "payment.captured" ? "captured" : webhookEvent.event === "payment.failed" ? "failed" : webhookEvent.event === "payment.refunded" ? "refunded" : "authorized",
      method: payment.method || "", contact: payment.contact || "", email: payment.email || "",
      notes: payment.notes || {}, capturedAt: payment.captured ? new Date() : null, webhookEventId: webhookEvent.event
    });

    // Auto-match to registration
    if (regId) {
      await matchPaymentToRegistration(pe);
    }

    // Broadcast real-time update
    if (eventId) broadcastSSE(eventId, "payment", { registrationId: regId, amount: pe.amount, status: pe.status });

    res.json({ received: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.use(cors({ origin: process.env.CLIENT_ORIGIN || true }));
app.use(express.json({ limit: "10mb" }));

// ============ AUTH MIDDLEWARE ============
function auth(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Authentication required" });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    req.role = decoded.role;
    next();
  } catch { return res.status(401).json({ error: "Invalid token" }); }
}

// Role-based permission middleware
function requireRole(...allowedRoles) {
  return async (req, res, next) => {
    // Check if user is event owner or collaborator with proper role
    const eventId = req.params.eventId || req.params.id;
    if (!eventId) return next(); // No event context, allow
    try {
      const event = await Event.findById(eventId);
      if (!event) return res.status(404).json({ error: "Event not found" });
      // Owner has all access
      if (String(event.organizerId) === String(req.userId)) return next();
      // Check collaborator role
      const user = await User.findById(req.userId);
      const collab = event.collaborators?.find(c => c.email === user?.email);
      if (!collab) return res.status(403).json({ error: "You don't have access to this event" });
      if (allowedRoles.includes(collab.role) || allowedRoles.includes("viewer")) return next();
      return res.status(403).json({ error: `This action requires ${allowedRoles.join(" or ")} access` });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  };
}

// ============ AUTH ROUTES ============
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

app.post("/api/auth/google", async (req, res) => {
  try {
    const { credential, accessToken } = req.body;
    if (!credential) return res.status(400).json({ error: "Google credential required" });

    // Verify the Google ID token
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID
    });
    const payload = ticket.getPayload();
    const { sub: googleId, email, name, picture } = payload;

    if (!email) return res.status(400).json({ error: "Email not available from Google account" });

    // Find existing user or create new one
    let user = await User.findOne({ $or: [{ googleId }, { email: email.toLowerCase() }] });
    if (user) {
      // Update googleId and avatar if not set
      if (!user.googleId) user.googleId = googleId;
      if (!user.avatar) user.avatar = picture || "";
      if (!user.name || user.name === email) user.name = name;
      // Store access token for Google Forms API access
      if (accessToken) user.googleAccessToken = accessToken;
      await user.save();
    } else {
      user = await User.create({
        name: name || email,
        email: email.toLowerCase(),
        googleId,
        avatar: picture || "",
        googleAccessToken: accessToken || "",
        role: "organizer"
      });
    }

    const token = jwt.sign({ userId: user._id, role: user.role }, JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user: { id: user._id, name: user.name, email: user.email, role: user.role, avatar: user.avatar } });
  } catch (e) {
    console.error("Google auth error:", e.message);
    res.status(401).json({ error: "Google authentication failed" });
  }
});

app.get("/api/auth/me", auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select("-password");
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ user: { id: user._id, name: user.name, email: user.email, role: user.role, avatar: user.avatar } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ EVENT ROUTES ============
app.post("/api/events", auth, async (req, res) => {
  try {
    const { name, venue, eventDate, ticketTypes, capacity, registrationEnd, paymentExpiryMinutes, entryRules, razorpayKeyId, razorpayKeySecret } = req.body;
    if (!name || !eventDate) return res.status(400).json({ error: "Event name and date required" });
    const intakeToken = crypto.randomBytes(16).toString("hex");
    const event = await Event.create({ organizerId: req.userId, name, venue: venue || "", eventDate, ticketTypes: ticketTypes || [], capacity: capacity || 1000, registrationEnd, paymentExpiryMinutes: paymentExpiryMinutes || 60, entryRules: entryRules || "", intakeToken, razorpayKeyId: razorpayKeyId || "", razorpayKeySecret: razorpayKeySecret || "" });
    await AuditLog.create({ eventId: event._id, actorId: req.userId, actorRole: req.role, action: "event.created", target: event._id });
    res.status(201).json(event);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/events", auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    const userEmail = user?.email || "";
    // Get events user owns OR is a collaborator on
    const events = await Event.find({ $or: [{ organizerId: req.userId }, { "collaborators.email": userEmail }] }).populate("organizerId", "name email").sort({ createdAt: -1 });
    res.json(events);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/events/:id", auth, async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event) return res.status(404).json({ error: "Event not found" });
    res.json(event);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/events/:id", auth, async (req, res) => {
  try {
    const event = await Event.findOneAndUpdate({ _id: req.params.id, organizerId: req.userId }, req.body, { new: true });
    if (!event) return res.status(404).json({ error: "Event not found" });
    res.json(event);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/events/:id", auth, async (req, res) => {
  try {
    const event = await Event.findOneAndDelete({ _id: req.params.id, organizerId: req.userId });
    if (!event) return res.status(404).json({ error: "Event not found" });
    // Cleanup associated data
    await Promise.all([
      Registration.deleteMany({ eventId: req.params.id }),
      PaymentEvent.deleteMany({ eventId: req.params.id }),
      RiskQueue.deleteMany({ eventId: req.params.id }),
      MessageLog.deleteMany({ eventId: req.params.id }),
      AuditLog.deleteMany({ eventId: req.params.id })
    ]);
    res.json({ success: true, message: "Event and all associated data deleted" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ SHARE ACCESS ============
app.post("/api/events/:id/share", auth, async (req, res) => {
  try {
    const { email, role } = req.body;
    if (!email) return res.status(400).json({ error: "Email is required" });
    const event = await Event.findOne({ _id: req.params.id, organizerId: req.userId });
    if (!event) return res.status(404).json({ error: "Event not found or you don't own it" });
    // Check if already shared
    const existing = event.collaborators.find(c => c.email === email.toLowerCase().trim());
    if (existing) {
      existing.role = role || "viewer";
      await event.save();
      return res.json({ collaborators: event.collaborators });
    }
    event.collaborators.push({ email: email.toLowerCase().trim(), role: role || "viewer" });
    await event.save();
    res.json({ collaborators: event.collaborators });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/events/:id/share/:email", auth, async (req, res) => {
  try {
    const event = await Event.findOne({ _id: req.params.id, organizerId: req.userId });
    if (!event) return res.status(404).json({ error: "Event not found or you don't own it" });
    event.collaborators = event.collaborators.filter(c => c.email !== decodeURIComponent(req.params.email).toLowerCase().trim());
    await event.save();
    res.json({ collaborators: event.collaborators });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ REGISTRATION ROUTES ============
app.post("/api/events/:eventId/registrations", auth, async (req, res) => {
  try {
    const event = await Event.findById(req.params.eventId);
    if (!event) return res.status(404).json({ error: "Event not found" });
    const { name, phone, email, college, ticketType, numberOfTickets } = req.body;
    if (!name || !phone || !ticketType) return res.status(400).json({ error: "Name, phone, and ticket type required" });
    const ticket = event.ticketTypes.find(t => t.name === ticketType);
    if (!ticket) return res.status(400).json({ error: "Invalid ticket type" });
    const expectedAmount = ticket.price * (numberOfTickets || 1);

    // Generate unique registration ID (collision-safe)
    const count = await Registration.countDocuments({ eventId: event._id });
    const suffix = crypto.randomBytes(3).toString("hex").toUpperCase();
    const registrationId = `REG-${String(count + 1001).padStart(4, "0")}-${suffix}`;

    // Check duplicate phone+event
    const dup = await Registration.findOne({ eventId: event._id, phone });
    if (dup) return res.status(400).json({ error: "Phone already registered for this event" });

    const entryToken = crypto.randomBytes(20).toString("hex");
    const reg = await Registration.create({ eventId: event._id, registrationId, name, phone, email: email || "", college: college || "", ticketType, expectedAmount, numberOfTickets: numberOfTickets || 1, entryToken });

    // Create Razorpay payment link if configured
    const rzpKeyId = event.razorpayKeyId;
    const rzpKeySecret = event.razorpayKeySecret;
    if (!rzpKeyId || !rzpKeySecret) {
      return res.status(503).json({ error: "Razorpay is not configured for this event. Add the test Key ID and test Key Secret in this event's Razorpay setup." });
    }
    if (rzpKeyId && rzpKeySecret) {
      try {
        const razorpay = new Razorpay({ key_id: rzpKeyId, key_secret: rzpKeySecret });
        const link = await razorpay.paymentLink.create({
          amount: expectedAmount * 100, currency: "INR",
          description: `${event.name} - ${ticketType}`,
          customer: { name, contact: phone, email: email || undefined },
          notify: { sms: true, email: Boolean(email) },
          notes: { registrationId, eventId: String(event._id) },
          callback_url: process.env.CLIENT_ORIGIN || "http://localhost:5000",
           callback_method: "get",
          expire_by: Math.floor(Date.now() / 1000) + (event.paymentExpiryMinutes || 60) * 60
        });
        reg.paymentLinkId = link.id;
        reg.paymentLinkUrl = link.short_url;
        reg.orderId = link.order_id || "";
        await reg.save();
      } catch (e) {
        console.error("Payment link creation failed:", razorpayErrorMessage(e));
        return res.status(502).json({ error: `Razorpay payment link failed: ${razorpayErrorMessage(e)}` });
      }
    }

    await AuditLog.create({ eventId: event._id, actorId: req.userId, actorRole: req.role, action: "registration.created", target: registrationId });
    res.status(201).json(reg);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Google Form intake (token-protected, no JWT needed)
app.post("/api/intake/:intakeToken", async (req, res) => {
  try {
    // Rate limiting: max 60 requests per minute per intake token
    if (!rateLimit(`intake_${req.params.intakeToken}`, 60)) {
      return res.status(429).json({ error: "Too many requests. Please slow down." });
    }

    const event = await Event.findOne({ intakeToken: req.params.intakeToken });
    if (!event) return res.status(404).json({ error: "Invalid intake token" });
    const { name, phone, email, college, category, ticketType } = req.body;
    if (!name || !phone) return res.status(400).json({ error: "Name and phone are required" });

    // Support both 'category' (from Google Form) and 'ticketType' (legacy)
    // Default to 'General' if no category is provided
    const categoryName = category || ticketType || "General";

    // Case-insensitive match against event pricing categories
    const ticket = event.ticketTypes.find(t => t.name.toLowerCase().trim() === categoryName.toLowerCase().trim());
    if (!ticket) return res.status(400).json({ error: `Invalid category "${categoryName}". Valid options: ${event.ticketTypes.map(t => t.name).join(", ")}` });

    const expectedAmount = ticket.price;
    const count = await Registration.countDocuments({ eventId: event._id });
    const suffix = crypto.randomBytes(3).toString("hex").toUpperCase();
    const registrationId = `REG-${String(count + 1001).padStart(4, "0")}-${suffix}`;
    const dup = await Registration.findOne({ eventId: event._id, phone });
    if (dup) return res.status(400).json({ error: "Already registered", registrationId: dup.registrationId, paymentLinkUrl: dup.paymentLinkUrl });
    const entryToken = crypto.randomBytes(20).toString("hex");
    const reg = await Registration.create({ eventId: event._id, registrationId, name, phone, email: email || "", college: college || "", ticketType: ticket.name, expectedAmount, numberOfTickets: 1, entryToken });

    // Create Razorpay payment link using event-level keys
    const rzpKeyId = event.razorpayKeyId;
    const rzpKeySecret = event.razorpayKeySecret;
    if (!rzpKeyId || !rzpKeySecret) {
      return res.status(503).json({ error: "Razorpay is not configured for this event. Add the test Key ID and test Key Secret in this event's Razorpay setup." });
    }
    if (rzpKeyId && rzpKeySecret) {
      try {
        const razorpay = new Razorpay({ key_id: rzpKeyId, key_secret: rzpKeySecret });
        const link = await razorpay.paymentLink.create({
          amount: expectedAmount * 100, currency: "INR",
          description: `${event.name} - ${ticket.name}`,
          customer: { name, contact: phone, email: email || undefined },
          notify: { sms: true, email: Boolean(email) },
          notes: { registrationId, eventId: String(event._id) },
          callback_url: process.env.CLIENT_ORIGIN || "http://localhost:5000",
           callback_method: "get",
          expire_by: Math.floor(Date.now() / 1000) + (event.paymentExpiryMinutes || 60) * 60
        });
        reg.paymentLinkId = link.id;
        reg.paymentLinkUrl = link.short_url;
        reg.orderId = link.order_id || "";
        await reg.save();
      } catch (e) {
        console.error("Intake payment link creation failed:", razorpayErrorMessage(e));
        return res.status(502).json({ error: `Razorpay payment link failed: ${razorpayErrorMessage(e)}` });
      }
    }

    res.status(201).json({ registrationId: reg.registrationId, expectedAmount, category: ticket.name, paymentLinkUrl: reg.paymentLinkUrl || "" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/events/:eventId/registrations", auth, async (req, res) => {
  try {
    const query = { eventId: req.params.eventId };
    if (req.query.status) query.paymentStatus = req.query.status;
    if (req.query.entryStatus) query.entryStatus = req.query.entryStatus;
    if (req.query.search) query.$or = [{ name: { $regex: req.query.search, $options: "i" } }, { phone: { $regex: req.query.search } }, { registrationId: { $regex: req.query.search, $options: "i" } }];
    
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 50));
    const sortField = req.query.sort || "createdAt";
    const sortOrder = req.query.order === "asc" ? 1 : -1;

    const [regs, total] = await Promise.all([
      Registration.find(query).sort({ [sortField]: sortOrder }).skip((page - 1) * pageSize).limit(pageSize),
      Registration.countDocuments(query)
    ]);
    res.json({ data: regs, total, page, pageSize, totalPages: Math.ceil(total / pageSize) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/events/:eventId/registrations/:regId", auth, async (req, res) => {
  try {
    const reg = await Registration.findOne({ eventId: req.params.eventId, registrationId: req.params.regId });
    if (!reg) return res.status(404).json({ error: "Registration not found" });
    res.json(reg);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ PAYMENT ROUTES ============
app.get("/api/events/:eventId/payments", auth, async (req, res) => {
  try {
    const payments = await PaymentEvent.find({ eventId: req.params.eventId }).sort({ createdAt: -1 });
    res.json(payments);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ RISK QUEUE ============
app.get("/api/events/:eventId/risk-queue", auth, async (req, res) => {
  try {
    const risks = await RiskQueue.find({ eventId: req.params.eventId, status: { $in: ["open", "reviewing"] } }).sort({ severity: -1, createdAt: -1 });
    res.json(risks);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Resolve a risk queue item
app.post("/api/events/:eventId/risk-queue/:riskId/resolve", auth, async (req, res) => {
  try {
    const { resolution, action } = req.body;
    const risk = await RiskQueue.findOne({ _id: req.params.riskId, eventId: req.params.eventId });
    if (!risk) return res.status(404).json({ error: "Risk case not found" });

    risk.status = "resolved";
    risk.resolvedBy = req.userId;
    risk.resolution = resolution || action || "resolved";
    await risk.save();

    // If action is "approve", approve the registration
    if (action === "approve") {
      await Registration.findOneAndUpdate(
        { eventId: req.params.eventId, registrationId: risk.registrationId },
        { entryStatus: "entry_approved", paymentStatus: "payment_verified" }
      );
    } else if (action === "hold") {
      await Registration.findOneAndUpdate(
        { eventId: req.params.eventId, registrationId: risk.registrationId },
        { entryStatus: "entry_held" }
      );
    }

    await AuditLog.create({ eventId: req.params.eventId, actorId: req.userId, actorRole: req.role, action: `risk.${action || "resolved"}`, target: risk.registrationId, reason: resolution || "" });
    res.json(risk);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Dismiss a risk queue item
app.post("/api/events/:eventId/risk-queue/:riskId/dismiss", auth, async (req, res) => {
  try {
    const risk = await RiskQueue.findOneAndUpdate(
      { _id: req.params.riskId, eventId: req.params.eventId },
      { status: "dismissed", resolvedBy: req.userId, resolution: req.body.reason || "dismissed" },
      { new: true }
    );
    if (!risk) return res.status(404).json({ error: "Risk case not found" });
    await AuditLog.create({ eventId: req.params.eventId, actorId: req.userId, actorRole: req.role, action: "risk.dismissed", target: risk.registrationId, reason: req.body.reason || "" });
    res.json(risk);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/events/:eventId/registrations/:regId/hold", auth, async (req, res) => {
  try {
    const reg = await Registration.findOneAndUpdate({ eventId: req.params.eventId, registrationId: req.params.regId }, { entryStatus: "entry_held" }, { new: true });
    await AuditLog.create({ eventId: req.params.eventId, actorId: req.userId, actorRole: req.role, action: "entry.held", target: req.params.regId, reason: req.body.reason || "" });
    res.json(reg);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/events/:eventId/registrations/:regId/approve", auth, async (req, res) => {
  try {
    const reg = await Registration.findOne({ eventId: req.params.eventId, registrationId: req.params.regId });
    if (!reg) return res.status(404).json({ error: "Registration not found" });

    // Backend safety checks before approval
    if (reg.entryStatus === "checked_in") return res.status(400).json({ error: "Already checked in — cannot change status" });
    if (reg.paymentStatus === "refunded") return res.status(400).json({ error: "Payment was refunded — cannot approve entry" });
    if (reg.paymentStatus === "duplicate_claim") return res.status(400).json({ error: "Duplicate claim detected — resolve risk case first" });

    reg.entryStatus = "entry_approved";
    reg.paymentStatus = "payment_verified";
    await reg.save();

    await AuditLog.create({ eventId: req.params.eventId, actorId: req.userId, actorRole: req.role, action: "entry.approved", target: req.params.regId, reason: req.body.reason || "" });
    res.json(reg);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ ENTRY SCANNING ============
app.get("/api/entry-pass/:token", async (req, res) => {
  try {
    const reg = await Registration.findOne({ entryToken: req.params.token });
    if (!reg) return res.status(404).json({ error: "Invalid pass" });
    res.json({ registrationId: reg.registrationId, name: reg.name, ticketType: reg.ticketType, entryStatus: reg.entryStatus, paymentStatus: reg.paymentStatus, expectedAmount: reg.expectedAmount, amountReceived: reg.amountReceived });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/events/:eventId/entry/:regId/check-in", auth, async (req, res) => {
  try {
    const reg = await Registration.findOne({ eventId: req.params.eventId, registrationId: req.params.regId });
    if (!reg) return res.status(404).json({ error: "Registration not found" });
    if (reg.entryStatus === "checked_in") return res.status(400).json({ error: "Already checked in", checkedInAt: reg.checkedInAt });
    if (reg.entryStatus === "entry_held") return res.status(403).json({ error: "Entry is held. Escalate to organizer.", reason: reg.riskReasons });
    if (reg.paymentStatus !== "payment_verified" && reg.entryStatus !== "entry_approved") return res.status(403).json({ error: "Payment not verified yet" });
    reg.entryStatus = "checked_in";
    reg.checkedInAt = new Date();
    await reg.save();
    await AuditLog.create({ eventId: req.params.eventId, actorId: req.userId, actorRole: req.role, action: "entry.checked_in", target: reg.registrationId });
    res.json(reg);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ EVIDENCE & TIMELINE ============
// Get full evidence for a registration (for investigation)
app.get("/api/events/:eventId/registrations/:regId/evidence", auth, async (req, res) => {
  try {
    const reg = await Registration.findOne({ eventId: req.params.eventId, registrationId: req.params.regId });
    if (!reg) return res.status(404).json({ error: "Registration not found" });
    const payments = await PaymentEvent.find({ $or: [{ registrationId: reg.registrationId }, { eventId: req.params.eventId, contact: { $regex: reg.phone.slice(-10) } }] }).sort({ createdAt: -1 });
    const risks = await RiskQueue.find({ eventId: req.params.eventId, registrationId: reg.registrationId });
    const audits = await AuditLog.find({ eventId: req.params.eventId, target: reg.registrationId }).populate("actorId", "name").sort({ createdAt: -1 });
    const duplicateClaims = reg.utr
      ? await Registration.find({ eventId: req.params.eventId, utr: reg.utr, registrationId: { $ne: reg.registrationId } })
      : [];

    // Build timeline
    const timeline = [];
    timeline.push({ time: reg.createdAt, event: "Registration created", detail: `${reg.name} registered for ${reg.ticketType}` });
    if (reg.paymentLinkUrl) timeline.push({ time: reg.createdAt, event: "Payment link generated", detail: reg.paymentLinkUrl });
    for (const p of payments) {
      timeline.push({ time: p.createdAt, event: `Payment ${p.status}`, detail: `₹${p.amount} via ${p.method || "unknown"} | ID: ${p.razorpayPaymentId}` });
    }
    for (const r of risks) {
      timeline.push({ time: r.createdAt, event: `Risk flagged: ${r.type.replace(/_/g, " ")}`, detail: `Severity: ${r.severity}` });
      if (r.status === "resolved") timeline.push({ time: r.updatedAt, event: "Risk resolved", detail: r.resolution });
    }
    for (const a of audits) {
      timeline.push({ time: a.createdAt, event: a.action, detail: `by ${a.actorId?.name || "System"} ${a.reason ? "— " + a.reason : ""}` });
    }
    if (reg.checkedInAt) timeline.push({ time: reg.checkedInAt, event: "Checked in", detail: "Entry confirmed" });
    timeline.sort((a, b) => new Date(a.time) - new Date(b.time));

    // Risk score breakdown
    const riskBreakdown = [];
    if (reg.utr && duplicateClaims.length > 0) riskBreakdown.push({ signal: "Duplicate UTR", score: 40, detail: `UTR used by ${duplicateClaims.length} other registration(s)` });
    if (reg.paymentStatus === "amount_mismatch") riskBreakdown.push({ signal: "Amount mismatch", score: 25, detail: `Expected ₹${reg.expectedAmount}, received ₹${reg.amountReceived}` });
    if (payments.some(p => p.status === "refunded")) riskBreakdown.push({ signal: "Refunded payment", score: 20, detail: "Payment was refunded after capture" });
    if (reg.riskReasons?.length) riskBreakdown.push({ signal: "Additional risk signals", score: 15, detail: reg.riskReasons.join("; ") });

    res.json({
      registration: reg,
      payments,
      risks,
      audits,
      duplicateClaims,
      timeline,
      riskBreakdown,
      riskBand: reg.riskScore >= 80 ? "critical" : reg.riskScore >= 50 ? "high" : reg.riskScore >= 20 ? "medium" : "low"
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ DASHBOARD / METRICS ============
app.get("/api/events/:eventId/metrics", auth, async (req, res) => {
  try {
    const eventId = req.params.eventId;
    const [totalRegs, verified, awaiting, mismatches, duplicates, suspicious, held, checkedIn, refunded] = await Promise.all([
      Registration.countDocuments({ eventId }),
      Registration.countDocuments({ eventId, paymentStatus: "payment_verified" }),
      Registration.countDocuments({ eventId, paymentStatus: "awaiting_payment" }),
      Registration.countDocuments({ eventId, paymentStatus: "amount_mismatch" }),
      Registration.countDocuments({ eventId, paymentStatus: "duplicate_claim" }),
      Registration.countDocuments({ eventId, paymentStatus: "suspicious" }),
      Registration.countDocuments({ eventId, entryStatus: "entry_held" }),
      Registration.countDocuments({ eventId, entryStatus: "checked_in" }),
      Registration.countDocuments({ eventId, paymentStatus: "refunded" })
    ]);
    const expectedTotal = (await Registration.aggregate([{ $match: { eventId: new mongoose.Types.ObjectId(eventId) } }, { $group: { _id: null, total: { $sum: "$expectedAmount" } } }]))[0]?.total || 0;
    const verifiedTotal = (await Registration.aggregate([{ $match: { eventId: new mongoose.Types.ObjectId(eventId), paymentStatus: "payment_verified" } }, { $group: { _id: null, total: { $sum: "$amountReceived" } } }]))[0]?.total || 0;
    const riskCount = await RiskQueue.countDocuments({ eventId, status: { $in: ["open", "reviewing"] } });
    res.json({ totalRegs, verified, awaiting, mismatches, duplicates, suspicious, held, checkedIn, refunded, expectedTotal, verifiedTotal, riskCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ RECONCILIATION ============
app.get("/api/events/:eventId/reconciliation", auth, async (req, res) => {
  try {
    const eventId = req.params.eventId;
    const oid = new mongoose.Types.ObjectId(eventId);
    const [expectedGross, captured, refunded, failed, regsWithoutPayment, paymentsWithoutReg, mismatches, duplicates, verified] = await Promise.all([
      Registration.aggregate([{ $match: { eventId: oid } }, { $group: { _id: null, total: { $sum: "$expectedAmount" } } }]),
      PaymentEvent.aggregate([{ $match: { eventId: oid, status: "captured" } }, { $group: { _id: null, total: { $sum: "$amount" } } }]),
      PaymentEvent.aggregate([{ $match: { eventId: oid, status: "refunded" } }, { $group: { _id: null, total: { $sum: "$amount" } } }]),
      PaymentEvent.aggregate([{ $match: { eventId: oid, status: "failed" } }, { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } }]),
      Registration.countDocuments({ eventId, paymentStatus: "awaiting_payment" }),
      PaymentEvent.countDocuments({ eventId, matched: false }),
      Registration.countDocuments({ eventId, paymentStatus: "amount_mismatch" }),
      Registration.countDocuments({ eventId, paymentStatus: "duplicate_claim" }),
      Registration.countDocuments({ eventId, paymentStatus: "payment_verified" })
    ]);
    const expGross = expectedGross[0]?.total || 0;
    const cap = captured[0]?.total || 0;
    const ref = refunded[0]?.total || 0;
    const failedTotal = failed[0]?.total || 0;
    const failedCount = failed[0]?.count || 0;
    const estimatedFees = Math.round(cap * 0.02 * 100) / 100;
    const estimatedNet = cap - ref - estimatedFees;
    res.json({
      expectedGross: expGross,
      captured: cap,
      refunded: ref,
      failedTotal,
      failedCount,
      estimatedFees,
      estimatedNet,
      difference: expGross - cap,
      regsWithoutPayment,
      paymentsWithoutReg,
      mismatches,
      duplicates,
      verified,
      feesNote: "Estimated at ~2%. Actual fees may vary based on payment method and Razorpay plan."
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ MESSAGING ============
app.post("/api/events/:eventId/messages/send", auth, async (req, res) => {
  try {
    const { registrationId, messageType, content, channel } = req.body;
    if (!content) return res.status(400).json({ error: "Message content required" });
    const msg = await MessageLog.create({ eventId: req.params.eventId, registrationId: registrationId || "", messageType: messageType || "custom", content, channel: channel || "in_app", status: "sent", sentAt: new Date() });
    res.status(201).json(msg);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/events/:eventId/messages", auth, async (req, res) => {
  try {
    const msgs = await MessageLog.find({ eventId: req.params.eventId }).sort({ createdAt: -1 }).limit(100);
    res.json(msgs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ AI INVESTIGATION (RAG Pattern) ============

// Step 1: Intent detection + focused retrieval
async function retrieveContext(question, eventId) {
  const q = question.toLowerCase();
  const oid = new mongoose.Types.ObjectId(eventId);
  const context = { intent: "general", records: [] };

  // Detect if question is about a specific registration
  const regMatch = question.match(/REG-\d{4,}[A-Z0-9-]*/i);
  if (regMatch) {
    context.intent = "specific_registration";
    const reg = await Registration.findOne({ eventId, registrationId: { $regex: regMatch[0], $options: "i" } });
    if (reg) {
      const payments = await PaymentEvent.find({ $or: [{ registrationId: reg.registrationId }, { eventId, contact: { $regex: reg.phone.slice(-10) } }] });
      const risks = await RiskQueue.find({ eventId, registrationId: reg.registrationId });
      const audits = await AuditLog.find({ eventId, target: reg.registrationId }).sort({ createdAt: -1 }).limit(10);
      const duplicates = reg.utr ? await Registration.find({ eventId, utr: reg.utr, registrationId: { $ne: reg.registrationId } }).select("registrationId name phone") : [];
      context.records = [
        { type: "Registration", data: reg.toObject() },
        ...payments.map(p => ({ type: "Payment", data: p.toObject() })),
        ...risks.map(r => ({ type: "RiskCase", data: r.toObject() })),
        ...audits.map(a => ({ type: "AuditAction", data: { action: a.action, target: a.target, reason: a.reason, time: a.createdAt } })),
        ...duplicates.map(d => ({ type: "DuplicateClaim", data: { registrationId: d.registrationId, name: d.name, phone: d.phone } }))
      ];
    }
    return context;
  }

  // Duplicates/UTR
  if (q.includes("duplicate") || q.includes("utr") || q.includes("reuse")) {
    context.intent = "duplicates";
    const dupes = await Registration.find({ eventId, paymentStatus: "duplicate_claim" }).select("registrationId name phone utr expectedAmount amountReceived riskReasons");
    const riskCases = await RiskQueue.find({ eventId, type: { $in: ["duplicate_utr", "reused_payment"] } });
    context.records = [...dupes.map(r => ({ type: "Registration", data: r.toObject() })), ...riskCases.map(r => ({ type: "RiskCase", data: r.toObject() }))];
    return context;
  }

  // Amount mismatches
  if (q.includes("mismatch") || q.includes("amount") || q.includes("less") || q.includes("short")) {
    context.intent = "amount_issues";
    const mismatches = await Registration.find({ eventId, paymentStatus: "amount_mismatch" }).select("registrationId name phone expectedAmount amountReceived riskReasons");
    const riskCases = await RiskQueue.find({ eventId, type: "amount_mismatch" });
    context.records = [...mismatches.map(r => ({ type: "Registration", data: r.toObject() })), ...riskCases.map(r => ({ type: "RiskCase", data: r.toObject() }))];
    return context;
  }

  // Pending/unpaid
  if (q.includes("pending") || q.includes("awaiting") || q.includes("not paid") || q.includes("nahi")) {
    context.intent = "pending_payments";
    const pending = await Registration.find({ eventId, paymentStatus: "awaiting_payment" }).select("registrationId name phone expectedAmount ticketType createdAt").limit(30);
    context.records = pending.map(r => ({ type: "Registration", data: r.toObject() }));
    return context;
  }

  // Risk/fraud
  if (q.includes("risk") || q.includes("suspicious") || q.includes("fraud") || q.includes("fake") || q.includes("dhokha")) {
    context.intent = "risk_cases";
    const risks = await RiskQueue.find({ eventId, status: { $in: ["open", "reviewing"] } });
    const suspRegs = await Registration.find({ eventId, paymentStatus: { $in: ["suspicious", "duplicate_claim"] } }).select("registrationId name phone riskScore riskReasons paymentStatus");
    context.records = [...risks.map(r => ({ type: "RiskCase", data: r.toObject() })), ...suspRegs.map(r => ({ type: "FlaggedRegistration", data: r.toObject() }))];
    return context;
  }

  // Entry/verified/paid
  if (q.includes("enter") || q.includes("verified") || q.includes("approved") || q.includes("ready") || q.includes("who can")) {
    context.intent = "entry_ready";
    const verified = await Registration.find({ eventId, paymentStatus: "payment_verified" }).select("registrationId name ticketType amountReceived entryStatus").limit(30);
    context.records = verified.map(r => ({ type: "Registration", data: r.toObject() }));
    return context;
  }

  // Financial/money
  if (q.includes("money") || q.includes("total") || q.includes("settlement") || q.includes("paisa") || q.includes("kitna") || q.includes("collection")) {
    context.intent = "financial";
    const metrics = await Registration.aggregate([{ $match: { eventId: oid } }, { $group: { _id: "$paymentStatus", count: { $sum: 1 }, total: { $sum: "$expectedAmount" }, received: { $sum: "$amountReceived" } } }]);
    const paymentTotals = await PaymentEvent.aggregate([{ $match: { eventId: oid } }, { $group: { _id: "$status", count: { $sum: 1 }, total: { $sum: "$amount" } } }]);
    context.records = [{ type: "Metrics", data: { registrationsByStatus: metrics, paymentsByStatus: paymentTotals } }];
    return context;
  }

  // General fallback — balanced summary
  context.intent = "general";
  const [metrics, topRisks, recentPayments] = await Promise.all([
    Registration.aggregate([{ $match: { eventId: oid } }, { $group: { _id: "$paymentStatus", count: { $sum: 1 }, total: { $sum: "$expectedAmount" }, received: { $sum: "$amountReceived" } } }]),
    RiskQueue.find({ eventId, status: "open" }).sort({ severity: -1 }).limit(5),
    PaymentEvent.find({ eventId }).sort({ createdAt: -1 }).limit(5).select("registrationId amount status method createdAt")
  ]);
  context.records = [{ type: "Metrics", data: metrics }, ...topRisks.map(r => ({ type: "RiskCase", data: { registrationId: r.registrationId, type: r.type, severity: r.severity } })), ...recentPayments.map(p => ({ type: "RecentPayment", data: p.toObject() }))];
  return context;
}

app.post("/api/events/:eventId/ai/investigate", auth, async (req, res) => {
  try {
    const { question } = req.body;
    if (!question) return res.status(400).json({ error: "Question is required" });
    const eventId = req.params.eventId;

    // RAG Step 1: Focused retrieval based on question intent
    const context = await retrieveContext(question, eventId);
    const safetyNote = "AI is READ-ONLY. Cannot approve, refund, move money, or delete. Human decides.";

    // RAG Step 2: Pass ONLY relevant records to AI
    const aiProvider = process.env.NVIDIA_API_KEY ? "nvidia" : process.env.GROQ_API_KEY ? "groq" : null;

    if (aiProvider) {
      try {
        const systemPrompt = `You are FormPay AI — a payment fraud investigation assistant for Indian events.

YOU HAVE EXACTLY ${context.records.length} RECORDS. These are the ONLY facts. Do NOT invent IDs, UTRs, amounts, or names not in this data.

RESPOND IN VALID JSON:
{
  "decision": "safe|suspicious|fraud|insufficient_data",
  "riskLevel": "low|medium|high|critical",
  "confidence": "high|medium|low",
  "summary": "one-line conclusion",
  "evidence": [{ "source": "record type from data", "id": "actual ID from data", "fact": "what you found" }],
  "missingInfo": ["what's NOT in the data that would help"],
  "recommendedAction": "what operator should do",
  "allowedActions": ["safe actions"],
  "forbiddenActions": ["risky actions"],
  "explanation": "2-3 sentences citing specific records from the data"
}

Rules:
- ONLY reference records from the provided data
- If asked about something not in the data, say "insufficient_data" with confidence "low"
- Support Hindi/Hinglish
- ${safetyNote}`;

        const userMsg = JSON.stringify({ question, intent: context.intent, totalRecords: context.records.length, data: context.records });

        let aiResponse = "";
        if (aiProvider === "nvidia") {
          aiResponse = await callNvidiaAI([{ role: "system", content: systemPrompt }, { role: "user", content: userMsg }], "meta/llama-4-maverick-17b-128e", { temperature: 0.1, max_tokens: 1500 });
        } else {
          const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
          const c = await groq.chat.completions.create({ model: "openai/gpt-oss-120b", temperature: 0.1, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userMsg }] });
          aiResponse = c.choices[0]?.message?.content || "";
        }

        let structured = null;
        try {
          const jsonMatch = aiResponse.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, aiResponse];
          structured = JSON.parse(jsonMatch[1].trim());
        } catch { try { const s = aiResponse.indexOf("{"); const e = aiResponse.lastIndexOf("}"); if (s !== -1) structured = JSON.parse(aiResponse.substring(s, e + 1)); } catch {} }

        if (structured) {
          structured.safetyBoundary = safetyNote;
          structured.source = aiProvider;
          structured.retrievalIntent = context.intent;
          structured.recordsUsed = context.records.length;
          return res.json({ structured, answer: structured.explanation || structured.summary, question });
        }
        return res.json({ answer: aiResponse, question, structured: null, source: aiProvider, safetyBoundary: safetyNote });
      } catch (e) { console.error("AI error:", e.message); }
    }

    // RAG Step 3: Rule-based fallback using same retrieved context
    const regs = context.records.filter(r => ["Registration", "FlaggedRegistration"].includes(r.type)).map(r => r.data);
    const risks = context.records.filter(r => r.type === "RiskCase").map(r => r.data);
    const payments = context.records.filter(r => ["Payment", "RecentPayment"].includes(r.type)).map(r => r.data);
    const metrics = context.records.filter(r => r.type === "Metrics").map(r => r.data);
    const ruleResult = generateRuleBasedReport(question, regs, risks, payments, metrics);
    ruleResult.retrievalIntent = context.intent;
    ruleResult.recordsUsed = context.records.length;
    res.json({ structured: ruleResult, answer: ruleResult.explanation, question, source: "rules", safetyBoundary: safetyNote });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Rule-based investigation fallback
function generateRuleBasedReport(question, regs, risks, payments, metrics) {
  const q = question.toLowerCase();
  const evidence = [];
  let summary = "";
  let riskLevel = "low";

  // Detect question type and generate appropriate response
  if (q.includes("duplicate") || q.includes("utr")) {
    const dupes = regs.filter(r => r.paymentStatus === "duplicate_claim");
    summary = dupes.length > 0 ? `Found ${dupes.length} duplicate claim(s)` : "No duplicate claims detected";
    dupes.forEach(r => evidence.push({ source: "Registration", id: r.registrationId, fact: `Duplicate claim — ${r.name}, UTR: ${r.utr || "N/A"}` }));
    if (dupes.length > 0) riskLevel = "high";
  } else if (q.includes("mismatch") || q.includes("amount")) {
    const mismatches = regs.filter(r => r.paymentStatus === "amount_mismatch");
    summary = mismatches.length > 0 ? `${mismatches.length} amount mismatch(es) found` : "No amount mismatches";
    mismatches.forEach(r => evidence.push({ source: "Registration", id: r.registrationId, fact: `Expected ₹${r.expectedAmount}, received ₹${r.amountReceived}` }));
    if (mismatches.length > 0) riskLevel = "medium";
  } else if (q.includes("pending") || q.includes("awaiting") || q.includes("not paid")) {
    const pending = regs.filter(r => r.paymentStatus === "awaiting_payment");
    summary = `${pending.length} registration(s) awaiting payment`;
    pending.slice(0, 5).forEach(r => evidence.push({ source: "Registration", id: r.registrationId, fact: `${r.name} — ₹${r.expectedAmount} pending` }));
  } else if (q.includes("risk") || q.includes("suspicious") || q.includes("fraud")) {
    summary = risks.length > 0 ? `${risks.length} open risk case(s)` : "No open risk cases";
    risks.slice(0, 5).forEach(r => evidence.push({ source: "RiskQueue", id: r.registrationId, fact: `${r.type.replace(/_/g, " ")} — severity: ${r.severity}` }));
    if (risks.length > 0) riskLevel = "high";
  } else if (q.includes("verified") || q.includes("paid") || q.includes("who can enter")) {
    const verified = regs.filter(r => r.paymentStatus === "payment_verified");
    summary = `${verified.length} participant(s) have verified payments and can enter`;
    verified.slice(0, 5).forEach(r => evidence.push({ source: "Registration", id: r.registrationId, fact: `${r.name} — ₹${r.amountReceived} verified` }));
  } else {
    // General status
    const totalRegs = regs.length;
    const verified = regs.filter(r => r.paymentStatus === "payment_verified").length;
    const pending = regs.filter(r => r.paymentStatus === "awaiting_payment").length;
    summary = `Event has ${totalRegs} registrations: ${verified} verified, ${pending} pending, ${risks.length} risk cases`;
    evidence.push({ source: "Metrics", id: "summary", fact: summary });
  }

  return {
    decision: riskLevel === "high" ? "suspicious" : riskLevel === "medium" ? "suspicious" : "safe",
    riskLevel,
    confidence: "medium",
    summary,
    evidence,
    missingInfo: ["AI analysis unavailable — using rule-based report"],
    recommendedAction: risks.length > 0 ? "Review open risk cases before approving entries" : "No immediate action required",
    allowedActions: ["View evidence", "Approve/hold registrations", "Resolve risk cases"],
    forbiddenActions: ["Do not approve entries without reviewing payment status"],
    explanation: `Rule-based analysis: ${summary}. ${risks.length > 0 ? "There are open risk cases that need human review." : "No critical issues detected."}`,
    source: "rules"
  };
}

// ============ AUDIT LOG ============
app.get("/api/events/:eventId/audit", auth, async (req, res) => {
  try {
    const logs = await AuditLog.find({ eventId: req.params.eventId }).populate("actorId", "name email").sort({ createdAt: -1 }).limit(100);
    res.json(logs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ ANALYZE GOOGLE FORM ============
app.post("/api/events/:eventId/analyze-form", auth, async (req, res) => {
  try {
    let { formUrl } = req.body;
    if (!formUrl) return res.status(400).json({ error: "Google Form URL is required" });

    // Validate it looks like a Google Form URL
    if (!formUrl.includes("docs.google.com/forms")) {
      return res.status(400).json({ error: "Invalid URL. Please provide a Google Forms link (docs.google.com/forms/...)" });
    }

    // Auto-convert /edit URL to /viewform (public URL)
    // /edit requires login, /viewform is the public respondent view
    if (formUrl.includes("/edit")) {
      // Extract form ID from /edit URL: docs.google.com/forms/d/FORM_ID/edit
      const idMatch = formUrl.match(/\/forms\/d\/([a-zA-Z0-9_-]+)/);
      if (idMatch) {
        formUrl = `https://docs.google.com/forms/d/${idMatch[1]}/viewform`;
      }
    }
    // Also handle /d/e/ published URLs
    if (!formUrl.includes("/viewform") && !formUrl.includes("/formResponse")) {
      formUrl = formUrl.replace(/\/edit.*$/, "/viewform").replace(/\?.*$/, "");
      if (!formUrl.endsWith("/viewform")) formUrl += "/viewform";
    }

    const event = await Event.findById(req.params.eventId);
    if (!event) return res.status(404).json({ error: "Event not found" });

    // Get user's Google access token for Forms API
    const user = await User.findById(req.userId);
    const googleToken = user?.googleAccessToken;

    // Extract form ID from URL
    let formId = "";
    const formIdMatch = formUrl.match(/\/forms\/d\/([a-zA-Z0-9_-]+)/);
    if (formIdMatch) formId = formIdMatch[1];
    // Also handle /d/e/ published URLs
    const publishedMatch = formUrl.match(/\/forms\/d\/e\/([a-zA-Z0-9_-]+)/);

    let fieldLabels = [];
    let formTitle = "";
    let formItems = null; // structured items from API

    // Strategy A: Use Google Forms API with user's access token (works for org-restricted forms)
    if (googleToken && formId) {
      try {
        const apiUrl = `https://forms.googleapis.com/v1/forms/${formId}`;
        const apiRes = await fetch(apiUrl, {
          headers: { "Authorization": `Bearer ${googleToken}` }
        });
        if (apiRes.ok) {
          const formData = await apiRes.json();
          formTitle = formData.info?.title || "";
          formItems = formData.items || [];
          // Extract field labels from API response
          for (const item of formItems) {
            const title = item.title || "";
            if (title) fieldLabels.push(title);
          }
        } else {
          // Token might be expired or insufficient scope — fall through to HTML fetch
          console.log("Forms API failed:", apiRes.status, "— falling back to HTML fetch");
        }
      } catch (e) {
        console.log("Forms API error:", e.message, "— falling back to HTML fetch");
      }
    }

    // Strategy B: Fall back to anonymous HTML fetch if API didn't work
    if (fieldLabels.length === 0) {
      let formHtml = "";
      try {
        const response = await fetch(formUrl, { 
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
          redirect: "follow"
        });
        if (!response.ok) {
          if (!googleToken) {
            return res.status(400).json({ error: `Cannot access form (HTTP ${response.status}). The form appears to be restricted to your organization. Please sign out and sign back in — you'll be asked to grant Google Forms access permission, which lets EventPay read your form structure.` });
          }
          return res.status(400).json({ error: `Cannot access form (HTTP ${response.status}). Your Google Forms access token may have expired. Please sign out and sign back in to refresh permissions.` });
        }
        formHtml = await response.text();
      } catch (e) {
        return res.status(400).json({ error: `Cannot access form: ${e.message}` });
      }

      // Check if we got a login page
      if (formHtml.includes("accounts.google.com/ServiceLogin") || formHtml.includes("identifier-shown")) {
        if (!googleToken) {
          return res.status(400).json({ error: "This form requires sign-in. Please sign out and sign back in — you'll be asked to grant Google Forms access permission." });
        }
        return res.status(400).json({ error: "Form access denied. Your token may have expired. Please sign out and sign back in." });
      }

      // Extract title from HTML
      const titleMatch = formHtml.match(/<title>(.*?)<\/title>/);
      if (titleMatch) formTitle = titleMatch[1].replace(" - Google Forms", "").trim();

      // Extract from FB_PUBLIC_LOAD_DATA_
      const dataMatch = formHtml.match(/FB_PUBLIC_LOAD_DATA_\s*=\s*([\s\S]*?);\s*<\/script>/);
      if (dataMatch) {
        try {
          const rawData = dataMatch[1];
          const questionRegex = /\[\d{9,},\s*"([^"]{2,150})"/g;
          let match;
          while ((match = questionRegex.exec(rawData)) !== null) {
            const label = match[1].trim();
            if (label.length >= 2 && !label.startsWith("http") && !label.includes("google.com")) {
              fieldLabels.push(label);
            }
          }
          if (fieldLabels.length === 0) {
            const allStrings = rawData.match(/"([^"]{3,80})"/g) || [];
            const seen = new Set();
            const skipWords = ["http", "google", "gstatic", "font", "css", "script", "docs.google", "fbzx"];
            for (const s of allStrings) {
              const clean = s.replace(/"/g, "").trim();
              if (clean.length < 3 || clean.length > 80) continue;
              if (skipWords.some(sw => clean.toLowerCase().includes(sw))) continue;
              if (clean.match(/^[0-9.]+$/) || clean.match(/^[a-f0-9]{20,}$/)) continue;
              if (seen.has(clean.toLowerCase())) continue;
              seen.add(clean.toLowerCase());
              fieldLabels.push(clean);
            }
          }
        } catch {}
      }
    }

    // Use Groq AI to analyze the form structure and map fields
    if (!process.env.GROQ_API_KEY) {
      return res.status(503).json({ error: "AI analysis unavailable — GROQ_API_KEY not configured" });
    }

    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const categories = event.ticketTypes?.map(t => t.name) || ["General"];

    // Prepare context for AI — if we got structured items from API, use those
    const formContext = formItems 
      ? JSON.stringify(formItems.map((item, i) => ({ index: i, title: item.title, questionType: item.questionItem?.question?.choiceQuestion ? "multiple_choice" : item.questionItem?.question?.textQuestion ? "text" : "other", options: item.questionItem?.question?.choiceQuestion?.options?.map(o => o.value) || [] })))
      : "";

    const completion = await groq.chat.completions.create({
      model: "openai/gpt-oss-120b", temperature: 0.1,
      messages: [
        { role: "system", content: `You are a Google Form field analyzer. Given extracted text/labels from a Google Form, identify which fields correspond to:
- name: The participant/team leader/person's name field
- phone: Phone number / contact number / mobile field
- email: Email address field
- category: A field that determines pricing tier (could be a role, type, membership, track selection, etc.)

Also identify any other notable fields and what they contain.

RESPOND ONLY IN VALID JSON with this exact format:
{
  "formTitle": "detected form title",
  "fields": [
    { "index": 0, "label": "field label from form", "mappedTo": "name|phone|email|category|other", "confidence": "high|medium|low", "notes": "why this mapping" }
  ],
  "nameFieldIndex": 0,
  "phoneFieldIndex": 1,
  "emailFieldIndex": 2,
  "categoryFieldIndex": null,
  "categoryOptions": [],
  "defaultCategory": "General",
  "warnings": ["any issues or concerns"],
  "summary": "one line summary of what this form collects"
}

If there's no clear category/type field, set categoryFieldIndex to null and defaultCategory to "General".
If the form has a fixed price for everyone, note that in warnings.
Be smart about it — "Team Leader Name" or "Team Name" maps to name, "Contact Number" maps to phone, "Track" or "Membership Type" could map to category.
If you see field labels that hint at names (team, leader, participant), phone (contact, mobile, number), email (email, mail), identify them.
Even if extractedLabels is empty, try to infer from the rawSnippet HTML what the form fields might be.` },
        { role: "user", content: JSON.stringify({
          formTitle,
          extractedLabels: fieldLabels.slice(0, 50),
          totalLabelsFound: fieldLabels.length,
          structuredFormItems: formContext || undefined,
          eventCategories: categories,
          eventName: event.name
        }) }
      ]
    });

    let aiResponse = completion.choices[0]?.message?.content || "";
    
    // Parse AI response
    let fieldMapping = null;
    try {
      // Extract JSON from response (handle markdown code blocks)
      const jsonMatch = aiResponse.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, aiResponse];
      const jsonStr = jsonMatch[1].trim();
      fieldMapping = JSON.parse(jsonStr);
    } catch (e) {
      // If JSON parsing fails, try to extract it differently
      try {
        const startIdx = aiResponse.indexOf("{");
        const endIdx = aiResponse.lastIndexOf("}");
        if (startIdx !== -1 && endIdx !== -1) {
          fieldMapping = JSON.parse(aiResponse.substring(startIdx, endIdx + 1));
        }
      } catch {}
    }

    if (!fieldMapping) {
      return res.status(502).json({ error: "AI could not analyze the form structure. Try again or check the form URL." });
    }

    // Generate custom Apps Script based on the field mapping
    const nameIdx = fieldMapping.nameFieldIndex ?? 0;
    const phoneIdx = fieldMapping.phoneFieldIndex ?? 1;
    const emailIdx = fieldMapping.emailFieldIndex ?? 2;
    const catIdx = fieldMapping.categoryFieldIndex;
    const defaultCat = fieldMapping.defaultCategory || "General";

    const intakeUrl = `${process.env.CLIENT_ORIGIN || "http://localhost:5000"}/api/intake/${event.intakeToken}`;

    const appsScript = `// ==== EventPay Sentinel - Auto Generated ====
// Custom script for: ${formTitle || event.name}
// Generated by AI based on your form structure
// Paste this in your Google Form's Apps Script editor

const INTAKE_URL = "${intakeUrl}";

function onFormSubmit(e) {
  if (!e || !e.response) {
    throw new Error("Do not run onFormSubmit manually. Submit the Google Form to trigger it, or run testIntakeEndpoint() to test the connection.");
  }
  const responses = e.response.getItemResponses();
  
  // Field mapping (auto-detected from your form):
  // Index ${nameIdx}: Name field${fieldMapping.fields?.[nameIdx] ? ` ("${fieldMapping.fields[nameIdx].label}")` : ""}
  // Index ${phoneIdx}: Phone field${fieldMapping.fields?.[phoneIdx] ? ` ("${fieldMapping.fields[phoneIdx].label}")` : ""}
  // Index ${emailIdx}: Email field${fieldMapping.fields?.[emailIdx] ? ` ("${fieldMapping.fields[emailIdx].label}")` : ""}
  ${catIdx !== null ? `// Index ${catIdx}: Category field${fieldMapping.fields?.[catIdx] ? ` ("${fieldMapping.fields[catIdx].label}")` : ""}` : "// No category field detected — using default: " + defaultCat}

  const name = responses[${nameIdx}]?.getResponse() || "";
  const phone = responses[${phoneIdx}]?.getResponse() || "";
  const email = responses[${emailIdx}]?.getResponse() || "";
  ${catIdx !== null ? `const category = responses[${catIdx}]?.getResponse() || "${defaultCat}";` : `const category = "${defaultCat}";`}

  const payload = { name, phone, email, category };

  const options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    const res = UrlFetchApp.fetch(INTAKE_URL, options);
    Logger.log("EventPay Response: " + res.getContentText());
  } catch (err) {
    Logger.log("EventPay Error: " + err.message);
  }
}

// Run this manually to test the EventPay intake connection without a form event.
function testIntakeEndpoint() {
  const payload = {
    name: "Test Participant",
    phone: "9999999999",
    email: "test@example.com",
    category: "General"
  };
  const response = UrlFetchApp.fetch(INTAKE_URL, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  Logger.log("EventPay Test Response: " + response.getContentText());
}

// Run this ONCE to set up the auto-trigger
function setupTrigger() {
  const form = FormApp.getActiveForm();
  ScriptApp.newTrigger("onFormSubmit")
    .forForm(form)
    .onFormSubmit()
    .create();
  Logger.log("Trigger created!");
}`;

    // Save form URL and mapping to event
    event.googleFormUrl = formUrl;
    event.fieldMapping = fieldMapping;
    await event.save();

    res.json({
      formTitle: fieldMapping.formTitle || formTitle,
      fieldMapping,
      appsScript,
      intakeUrl,
      summary: fieldMapping.summary || "Form analyzed successfully",
      warnings: fieldMapping.warnings || []
    });
  } catch (e) {
    console.error("Form analysis error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============ VERIFY SETUP (Real AI Check) ============
app.post("/api/events/:eventId/verify-setup", auth, async (req, res) => {
  try {
    const event = await Event.findById(req.params.eventId);
    if (!event) return res.status(404).json({ error: "Event not found" });

    const checks = [];

    // Check 1: Event has valid data
    if (event.name && event.eventDate) {
      checks.push({ ok: true, label: "Event Configuration", msg: `Event "${event.name}" is configured with date ${new Date(event.eventDate).toLocaleDateString("en-IN")}` });
    } else {
      checks.push({ ok: false, label: "Event Configuration", msg: "Event is missing name or date" });
    }

    // Check 2: Pricing categories exist
    if (event.ticketTypes && event.ticketTypes.length > 0) {
      const cats = event.ticketTypes.map(t => `${t.name} (₹${t.price})`).join(", ");
      checks.push({ ok: true, label: "Pricing Categories", msg: `${event.ticketTypes.length} categories: ${cats}` });
    } else {
      checks.push({ ok: false, label: "Pricing Categories", msg: "No pricing categories configured — payment links cannot be generated" });
    }

    // Check 3: General fallback exists
    const hasGeneral = event.ticketTypes?.some(t => t.name.toLowerCase() === "general");
    if (hasGeneral) {
      checks.push({ ok: true, label: "Default Fallback", msg: "'General' category exists as fallback for unmatched submissions" });
    } else {
      checks.push({ ok: false, label: "Default Fallback", msg: "No 'General' category — submissions without a category match will fail" });
    }

    // Check 4: Intake token is valid
    if (event.intakeToken) {
      checks.push({ ok: true, label: "Intake URL", msg: "Intake token is active and ready to receive Google Form submissions" });
    } else {
      checks.push({ ok: false, label: "Intake URL", msg: "No intake token — Google Form cannot connect to this event" });
    }

    // Check 5: Razorpay credentials (event-level only)
    const rzpKeyId = event.razorpayKeyId;
    const rzpKeySecret = event.razorpayKeySecret;
    let razorpayOk = false;
    if (rzpKeyId && rzpKeySecret) {
      try {
        const razorpay = new Razorpay({ key_id: rzpKeyId, key_secret: rzpKeySecret });
        await razorpay.payments.all({ count: 1 });
        razorpayOk = true;
        checks.push({ ok: true, label: "Razorpay Connection", msg: `Razorpay API credentials are valid (${rzpKeyId.substring(0, 12)}...)` });
      } catch (e) {
        const errMsg = e?.error?.description || e?.message || JSON.stringify(e);
        checks.push({ ok: false, label: "Razorpay Connection", msg: `Razorpay credentials failed: ${errMsg}` });
      }
    } else {
      checks.push({ ok: false, label: "Razorpay Connection", msg: "No Razorpay API keys configured for this event — payment links will NOT be generated" });
    }

    // Check 6: Test payment link creation (real Razorpay test)
    let testPaymentLink = null;
    if (razorpayOk && event.ticketTypes?.length > 0) {
      try {
        const razorpay = new Razorpay({ key_id: rzpKeyId, key_secret: rzpKeySecret });
        const testTicket = event.ticketTypes[0];
        const amount = Number(testTicket.price) * 100;
        if (!amount || amount <= 0) throw new Error(`Invalid price for category "${testTicket.name}": ₹${testTicket.price}`);
        const link = await razorpay.paymentLink.create({
          amount: amount,
          currency: "INR",
          description: `[TEST] ${event.name} - ${testTicket.name}`,
          customer: { name: "Test User", contact: "9999999999" },
          notify: { sms: false, email: false },
          notes: { test: "true", eventId: String(event._id) },
          expire_by: Math.floor(Date.now() / 1000) + 900
        });
        testPaymentLink = link.short_url;
        checks.push({ ok: true, label: "Payment Link Generation", msg: `Payment link created for "${testTicket.name}" (₹${testTicket.price}). Payments go to YOUR Razorpay account.` });
        try { await razorpay.paymentLink.cancel(link.id); } catch {}
      } catch (e) {
        const errMsg = e?.error?.description || e?.message || JSON.stringify(e);
        checks.push({ ok: false, label: "Payment Link Generation", msg: `Failed to create payment link: ${errMsg}` });
      }
    } else if (!razorpayOk) {
      checks.push({ ok: false, label: "Payment Link Generation", msg: "Skipped — Razorpay not connected" });
    }

    // Check 7: Test intake endpoint (simulate a Google Form submission)
    let testRegId = null;
    if (event.intakeToken && event.ticketTypes?.length > 0) {
      const testPhone = `TEST${Date.now()}`;
      const testCategory = event.ticketTypes[0].name;
      try {
        // Simulate what Google Form Apps Script would send
        const existingDup = await Registration.findOne({ eventId: event._id, phone: testPhone });
        if (!existingDup) {
          const count = await Registration.countDocuments({ eventId: event._id });
          const registrationId = `TEST-${String(count + 9001).padStart(4, "0")}`;
          const entryToken = crypto.randomBytes(20).toString("hex");
          const reg = await Registration.create({
            eventId: event._id, registrationId, name: "Test Submission",
            phone: testPhone, email: "", college: "", ticketType: testCategory,
            expectedAmount: event.ticketTypes[0].price, numberOfTickets: 1, entryToken
          });
          testRegId = reg._id;
          checks.push({ ok: true, label: "Intake Pipeline", msg: `Test registration created (${registrationId}) with category "${testCategory}" → ₹${event.ticketTypes[0].price}. Pipeline is working.` });

          // Cleanup test registration
          await Registration.findByIdAndDelete(reg._id);
        }
      } catch (e) {
        checks.push({ ok: false, label: "Intake Pipeline", msg: `Intake simulation failed: ${e.message}` });
      }
    } else {
      checks.push({ ok: false, label: "Intake Pipeline", msg: "Cannot test — missing intake token or categories" });
    }

    // Check 8: Webhook secret
    const webhookSecret = event.razorpayWebhookSecret;
    if (webhookSecret) {
      checks.push({ ok: true, label: "Webhook Verification", msg: "Webhook secret is configured — payments will be auto-verified" });
    } else {
      checks.push({ ok: true, label: "Webhook Verification", msg: "No webhook secret configured yet — you can add this later in event settings for auto-verification. Payments will still work via payment links." });
    }

    // Check 9: MongoDB connection
    if (mongoose.connection.readyState === 1) {
      checks.push({ ok: true, label: "Database", msg: "MongoDB is connected and responsive" });
    } else {
      checks.push({ ok: false, label: "Database", msg: "Database connection is down" });
    }

    // Overall verdict
    const passed = checks.filter(c => c.ok).length;
    const total = checks.length;
    const allGood = checks.every(c => c.ok);

    // AI Analysis (Groq) — second layer of verification
    let aiAnalysis = "";
    if (process.env.GROQ_API_KEY) {
      try {
        const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
        const completion = await groq.chat.completions.create({
          model: "openai/gpt-oss-120b", temperature: 0.3,
          messages: [
            { role: "system", content: `You are EventPay Sentinel's setup verification AI. You review technical check results of an event payment pipeline (Google Form → intake endpoint → Razorpay payment link → webhook verification). Give a concise, actionable summary in 4-6 bullet points. Mention: 1) Is the pipeline ready? 2) Any risks or flaws? 3) What could go wrong during real usage? 4) Specific recommendations. Be direct, practical, and mention exact fixes if something is wrong. Use plain language, no jargon. Keep it under 200 words.` },
            { role: "user", content: JSON.stringify({
              event: { name: event.name, date: event.eventDate, categories: event.ticketTypes?.map(t => ({ name: t.name, price: t.price })), intakeToken: Boolean(event.intakeToken) },
              checkResults: checks.map(c => ({ label: c.label, passed: c.ok, detail: c.msg })),
              summary: { passed, total, allGood },
              razorpayConfigured: Boolean(process.env.RAZORPAY_KEY_ID),
              webhookConfigured: Boolean(process.env.RAZORPAY_WEBHOOK_SECRET)
            }) }
          ]
        });
        aiAnalysis = completion.choices[0]?.message?.content || "";
      } catch (e) {
        aiAnalysis = `AI analysis unavailable: ${e.message}`;
      }
    } else {
      aiAnalysis = "AI analysis skipped — GROQ_API_KEY not configured.";
    }

    res.json({ checks, passed, total, allGood, testPaymentLink, aiAnalysis });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ NVIDIA AI FEATURES ============
const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";

async function callNvidiaAI(messages, model = "meta/llama-4-maverick-17b-128e", options = {}) {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) throw new Error("NVIDIA_API_KEY not configured");
  const res = await fetch(`${NVIDIA_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, temperature: options.temperature || 0.2, max_tokens: options.max_tokens || 2000, stream: false })
  });
  if (!res.ok) { const err = await res.text(); throw new Error(`NVIDIA API error (${res.status}): ${err}`); }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

// Screenshot Verification (Vision AI)
app.post("/api/events/:eventId/verify-screenshot", auth, async (req, res) => {
  try {
    const { imageBase64, registrationId } = req.body;
    if (!imageBase64) return res.status(400).json({ error: "Screenshot image (base64) is required" });
    if (!process.env.NVIDIA_API_KEY) return res.status(503).json({ error: "NVIDIA AI not configured" });

    const event = await Event.findById(req.params.eventId);
    if (!event) return res.status(404).json({ error: "Event not found" });

    // Find the registration to cross-check
    let reg = null;
    if (registrationId) {
      reg = await Registration.findOne({ eventId: req.params.eventId, registrationId });
    }

    // Use NVIDIA vision model to extract payment details from screenshot
    const visionResponse = await callNvidiaAI([
      { role: "system", content: `You are a payment screenshot analyzer for Indian UPI/bank payments. Extract payment details from the screenshot image.

RESPOND ONLY IN VALID JSON:
{
  "detected": true/false,
  "utr": "UTR/transaction reference number if visible",
  "amount": numeric amount if visible (in rupees, no paise),
  "date": "date string if visible",
  "payeeName": "recipient name if visible",
  "payerName": "sender name if visible",
  "upiId": "UPI ID if visible",
  "method": "UPI/NEFT/IMPS/Card/Unknown",
  "status": "Success/Failed/Pending/Unknown",
  "suspicious": true/false,
  "suspiciousReasons": ["list of reasons if suspicious"],
  "confidence": "high/medium/low"
}

Check for signs of fake screenshots:
- Inconsistent fonts or alignment
- Edited/blurred UTR numbers
- Amount doesn't match expected
- Date is in the future or too old
- Missing standard bank UI elements
- Pixelation around numbers (editing artifacts)` },
      { role: "user", content: [
        { type: "text", text: `Analyze this payment screenshot. ${reg ? `Expected payment: ₹${reg.expectedAmount} for registration ${reg.registrationId}.` : "Extract all payment details."}` },
        { type: "image_url", image_url: { url: `data:image/png;base64,${imageBase64}` } }
      ] }
    ], "meta/llama-3.2-90b-vision-instruct", { max_tokens: 1000 });

    // Parse AI response
    let analysis = null;
    try {
      const jsonMatch = visionResponse.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, visionResponse];
      analysis = JSON.parse(jsonMatch[1].trim());
    } catch {
      try {
        const start = visionResponse.indexOf("{");
        const end = visionResponse.lastIndexOf("}");
        if (start !== -1) analysis = JSON.parse(visionResponse.substring(start, end + 1));
      } catch {}
    }

    if (!analysis) return res.status(502).json({ error: "AI could not analyze the screenshot" });

    // Cross-check with database
    let verification = { status: "unverified", matchedPayment: null, issues: [] };

    if (analysis.utr && reg) {
      // Check if this UTR exists in our payment events
      const existingPayment = await PaymentEvent.findOne({ eventId: req.params.eventId, utr: analysis.utr });
      if (existingPayment) {
        if (existingPayment.registrationId === registrationId) {
          verification.status = "verified";
          verification.matchedPayment = existingPayment.razorpayPaymentId;
        } else {
          verification.status = "fraud_detected";
          verification.issues.push(`UTR ${analysis.utr} is already claimed by registration ${existingPayment.registrationId}`);
        }
      } else {
        verification.status = "not_in_system";
        verification.issues.push("This UTR was not received via Razorpay webhook — payment may be fake or to a different account");
      }
    }

    // Check amount match
    if (analysis.amount && reg && analysis.amount !== reg.expectedAmount) {
      verification.issues.push(`Screenshot shows ₹${analysis.amount} but expected ₹${reg.expectedAmount}`);
    }

    // Check for suspicious signs from AI
    if (analysis.suspicious) {
      verification.status = "suspicious";
      verification.issues.push(...(analysis.suspiciousReasons || []));
    }

    // Check if UTR used by other registrations across ALL events
    if (analysis.utr) {
      const crossEventDupes = await PaymentEvent.find({ utr: analysis.utr, eventId: { $ne: req.params.eventId } });
      if (crossEventDupes.length > 0) {
        verification.status = "fraud_detected";
        verification.issues.push(`This UTR has been used at ${crossEventDupes.length} other event(s) — cross-event fraud`);
      }
    }

    await AuditLog.create({ eventId: req.params.eventId, actorId: req.userId, actorRole: req.role, action: "screenshot.verified", target: registrationId || "unknown", reason: `AI verdict: ${verification.status}` });

    res.json({ analysis, verification, registrationId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Cross-Event Fraud Detection
app.get("/api/events/:eventId/cross-event-check/:regId", auth, async (req, res) => {
  try {
    const reg = await Registration.findOne({ eventId: req.params.eventId, registrationId: req.params.regId });
    if (!reg) return res.status(404).json({ error: "Registration not found" });

    // Check this participant across ALL events
    const [phoneMatches, emailMatches, utrMatches] = await Promise.all([
      Registration.find({ phone: reg.phone, eventId: { $ne: req.params.eventId } }).select("registrationId eventId name paymentStatus riskScore createdAt").limit(20),
      reg.email ? Registration.find({ email: reg.email, eventId: { $ne: req.params.eventId } }).select("registrationId eventId name paymentStatus riskScore createdAt").limit(20) : [],
      reg.utr ? PaymentEvent.find({ utr: reg.utr, eventId: { $ne: req.params.eventId } }).select("registrationId eventId amount status createdAt").limit(10) : []
    ]);

    const flags = [];
    if (phoneMatches.length > 3) flags.push({ signal: "Serial registrant", detail: `Phone ${reg.phone} found in ${phoneMatches.length} other events`, severity: "medium" });
    const unpaidInOtherEvents = phoneMatches.filter(r => r.paymentStatus === "awaiting_payment").length;
    if (unpaidInOtherEvents > 2) flags.push({ signal: "Habitual non-payer", detail: `${unpaidInOtherEvents} unpaid registrations at other events`, severity: "high" });
    if (utrMatches.length > 0) flags.push({ signal: "Cross-event UTR reuse", detail: `UTR ${reg.utr} used at ${utrMatches.length} other event(s)`, severity: "critical" });
    const flaggedElsewhere = phoneMatches.filter(r => r.riskScore >= 50).length;
    if (flaggedElsewhere > 0) flags.push({ signal: "Flagged at other events", detail: `Flagged as suspicious at ${flaggedElsewhere} other event(s)`, severity: "high" });

    // AI analysis if flags exist
    let aiInsight = null;
    if (flags.length > 0 && process.env.NVIDIA_API_KEY) {
      try {
        const aiResponse = await callNvidiaAI([
          { role: "system", content: "You are a fraud analyst. Given cross-event data about a participant, provide a 2-3 sentence risk assessment. Be specific and actionable. Respond in plain text, not JSON." },
          { role: "user", content: JSON.stringify({ participant: { name: reg.name, phone: reg.phone, currentEvent: reg.registrationId }, flags, otherEvents: phoneMatches.length, unpaidElsewhere: unpaidInOtherEvents }) }
        ], "meta/llama-4-maverick-17b-128e", { max_tokens: 200 });
        aiInsight = aiResponse;
      } catch {}
    }

    res.json({ registration: reg.registrationId, name: reg.name, flags, phoneMatches: phoneMatches.length, emailMatches: emailMatches?.length || 0, utrMatches: utrMatches.length, riskLevel: flags.some(f => f.severity === "critical") ? "critical" : flags.some(f => f.severity === "high") ? "high" : flags.length > 0 ? "medium" : "low", aiInsight });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Smart Batch Actions via Natural Language
app.post("/api/events/:eventId/ai/batch-action", auth, async (req, res) => {
  try {
    const { command } = req.body;
    if (!command) return res.status(400).json({ error: "Command is required" });
    if (!process.env.NVIDIA_API_KEY) return res.status(503).json({ error: "NVIDIA AI not configured" });

    const event = await Event.findById(req.params.eventId);
    if (!event) return res.status(404).json({ error: "Event not found" });
    if (String(event.organizerId) !== String(req.userId)) return res.status(403).json({ error: "Only the event owner can run batch actions" });

    // Get event context
    const regCount = await Registration.countDocuments({ eventId: req.params.eventId });
    const statuses = await Registration.aggregate([{ $match: { eventId: event._id } }, { $group: { _id: "$paymentStatus", count: { $sum: 1 } } }]);

    // AI interprets the command
    const aiResponse = await callNvidiaAI([
      { role: "system", content: `You are a batch action interpreter for an event payment system. The organizer gives a natural language command. You translate it to a structured action.

Available actions:
- approve_all: approve entry for registrations matching a filter
- hold_all: hold entry for registrations matching a filter
- send_reminder: send payment reminder to pending registrations
- flag_all: flag registrations matching criteria

Available filters:
- paymentStatus: awaiting_payment, payment_verified, amount_mismatch, duplicate_claim, suspicious, manual_review
- entryStatus: not_ready, entry_approved, entry_held, checked_in
- ticketType: category name
- college: college name
- amountComparison: { operator: "lt"|"gt"|"eq", value: number }

RESPOND ONLY IN JSON:
{
  "action": "approve_all|hold_all|send_reminder|flag_all",
  "filter": { "paymentStatus": "...", "college": "...", ... },
  "description": "what this will do in plain English",
  "affectedCount": estimated number based on context,
  "confirmation": "human-readable confirmation message",
  "safe": true/false,
  "safetyNote": "why this might be risky if safe=false"
}

If the command is unclear or dangerous, set safe=false and explain why.
NEVER execute destructive actions (delete, refund). Only approve, hold, remind, flag.` },
      { role: "user", content: JSON.stringify({ command, eventName: event.name, totalRegistrations: regCount, statusBreakdown: statuses }) }
    ], "meta/llama-4-maverick-17b-128e", { max_tokens: 500 });

    let plan = null;
    try {
      const jsonMatch = aiResponse.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, aiResponse];
      plan = JSON.parse(jsonMatch[1].trim());
    } catch {
      try {
        const start = aiResponse.indexOf("{");
        const end = aiResponse.lastIndexOf("}");
        if (start !== -1) plan = JSON.parse(aiResponse.substring(start, end + 1));
      } catch {}
    }

    if (!plan) return res.status(502).json({ error: "AI could not interpret the command. Try rephrasing." });

    // Don't execute yet — return the plan for confirmation
    // Count actual affected registrations
    const query = { eventId: req.params.eventId };
    if (plan.filter?.paymentStatus) query.paymentStatus = plan.filter.paymentStatus;
    if (plan.filter?.entryStatus) query.entryStatus = plan.filter.entryStatus;
    if (plan.filter?.ticketType) query.ticketType = plan.filter.ticketType;
    if (plan.filter?.college) query.college = { $regex: plan.filter.college, $options: "i" };
    const actualCount = await Registration.countDocuments(query);
    plan.affectedCount = actualCount;

    res.json({ plan, command, requiresConfirmation: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Execute confirmed batch action
app.post("/api/events/:eventId/ai/batch-action/execute", auth, async (req, res) => {
  try {
    const { plan } = req.body;
    if (!plan || !plan.action || !plan.filter) return res.status(400).json({ error: "Invalid plan" });
    if (String((await Event.findById(req.params.eventId))?.organizerId) !== String(req.userId)) return res.status(403).json({ error: "Only owner can execute" });

    const query = { eventId: req.params.eventId };
    if (plan.filter.paymentStatus) query.paymentStatus = plan.filter.paymentStatus;
    if (plan.filter.entryStatus) query.entryStatus = plan.filter.entryStatus;
    if (plan.filter.ticketType) query.ticketType = plan.filter.ticketType;
    if (plan.filter.college) query.college = { $regex: plan.filter.college, $options: "i" };

    let result = { affected: 0 };
    if (plan.action === "approve_all") {
      const r = await Registration.updateMany(query, { entryStatus: "entry_approved", paymentStatus: "payment_verified" });
      result.affected = r.modifiedCount;
    } else if (plan.action === "hold_all") {
      const r = await Registration.updateMany(query, { entryStatus: "entry_held" });
      result.affected = r.modifiedCount;
    } else if (plan.action === "flag_all") {
      const r = await Registration.updateMany(query, { $set: { paymentStatus: "suspicious" }, $push: { riskReasons: "Flagged by batch action" } });
      result.affected = r.modifiedCount;
    } else if (plan.action === "send_reminder") {
      const regs = await Registration.find(query).select("registrationId name");
      for (const r of regs) {
        await MessageLog.create({ eventId: req.params.eventId, registrationId: r.registrationId, messageType: "payment_pending", content: `Reminder: Your payment is still pending. Please complete it soon.`, channel: "in_app", status: "sent", sentAt: new Date() });
      }
      result.affected = regs.length;
    }

    await AuditLog.create({ eventId: req.params.eventId, actorId: req.userId, actorRole: "organizer", action: `batch.${plan.action}`, target: `${result.affected} registrations`, reason: plan.description });
    broadcastSSE(req.params.eventId, "batch_action", { action: plan.action, affected: result.affected });

    res.json({ success: true, ...result, action: plan.action });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ AI: AUTO-CATEGORIZE UNMATCHED PAYMENTS ============
app.post("/api/events/:eventId/ai/auto-match", auth, async (req, res) => {
  try {
    const eventId = req.params.eventId;
    // Find unmatched payments
    const unmatchedPayments = await PaymentEvent.find({ eventId, matched: false, status: "captured" });
    if (unmatchedPayments.length === 0) return res.json({ matches: [], message: "No unmatched payments found" });

    // Get all registrations awaiting payment
    const pendingRegs = await Registration.find({ eventId, paymentStatus: "awaiting_payment" }).select("registrationId name phone email expectedAmount ticketType createdAt");

    const matches = [];
    for (const payment of unmatchedPayments) {
      // Fuzzy matching signals
      const candidates = pendingRegs.map(reg => {
        let score = 0;
        const reasons = [];
        // Phone match (last 10 digits)
        if (payment.contact && reg.phone && payment.contact.slice(-10) === reg.phone.slice(-10)) { score += 40; reasons.push("Phone number matches"); }
        // Amount match
        if (payment.amount === reg.expectedAmount) { score += 30; reasons.push("Amount matches exactly"); }
        else if (Math.abs(payment.amount - reg.expectedAmount) <= 10) { score += 15; reasons.push(`Amount close (₹${payment.amount} vs ₹${reg.expectedAmount})`); }
        // Email match
        if (payment.email && reg.email && payment.email.toLowerCase() === reg.email.toLowerCase()) { score += 20; reasons.push("Email matches"); }
        // Timing (registered before payment)
        if (reg.createdAt < payment.createdAt) { score += 5; reasons.push("Registered before payment"); }
        return { registration: reg, score, reasons };
      }).filter(c => c.score >= 30).sort((a, b) => b.score - a.score);

      if (candidates.length > 0) {
        matches.push({ payment: { id: payment.razorpayPaymentId, amount: payment.amount, phone: payment.contact, method: payment.method }, bestMatch: candidates[0], alternates: candidates.slice(1, 3) });
      }
    }

    // Use AI to validate ambiguous matches
    if (matches.length > 0 && process.env.NVIDIA_API_KEY) {
      try {
        const aiResponse = await callNvidiaAI([
          { role: "system", content: "You are a payment matching assistant. Given payment-to-registration match candidates with confidence scores, confirm or reject each match. Respond in JSON: { \"validations\": [{ \"paymentId\": \"...\", \"registrationId\": \"...\", \"valid\": true/false, \"reason\": \"...\" }] }" },
          { role: "user", content: JSON.stringify(matches.slice(0, 10).map(m => ({ paymentId: m.payment.id, paymentAmount: m.payment.amount, paymentPhone: m.payment.phone, bestMatchRegId: m.bestMatch.registration.registrationId, bestMatchName: m.bestMatch.registration.name, bestMatchPhone: m.bestMatch.registration.phone, bestMatchAmount: m.bestMatch.registration.expectedAmount, score: m.bestMatch.score, reasons: m.bestMatch.reasons }))) }
        ], "meta/llama-4-maverick-17b-128e", { max_tokens: 800 });

        try {
          const start = aiResponse.indexOf("{"); const end = aiResponse.lastIndexOf("}");
          if (start !== -1) { const validation = JSON.parse(aiResponse.substring(start, end + 1)); matches.forEach(m => { const v = validation.validations?.find(v => v.paymentId === m.payment.id); if (v) m.aiValidation = v; }); }
        } catch {}
      } catch {}
    }

    res.json({ matches, total: unmatchedPayments.length, matched: matches.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ AI: EVENT RISK SCORE ============
app.get("/api/events/:eventId/ai/event-risk", auth, async (req, res) => {
  try {
    const eventId = req.params.eventId;
    const event = await Event.findById(eventId);
    if (!event) return res.status(404).json({ error: "Event not found" });

    const oid = new mongoose.Types.ObjectId(eventId);
    const [totalRegs, verified, pending, mismatches, duplicates, suspicious, openRisks, lastPayment, lastReg] = await Promise.all([
      Registration.countDocuments({ eventId }),
      Registration.countDocuments({ eventId, paymentStatus: "payment_verified" }),
      Registration.countDocuments({ eventId, paymentStatus: "awaiting_payment" }),
      Registration.countDocuments({ eventId, paymentStatus: "amount_mismatch" }),
      Registration.countDocuments({ eventId, paymentStatus: "duplicate_claim" }),
      Registration.countDocuments({ eventId, paymentStatus: "suspicious" }),
      RiskQueue.countDocuments({ eventId, status: "open" }),
      PaymentEvent.findOne({ eventId }).sort({ createdAt: -1 }),
      Registration.findOne({ eventId }).sort({ createdAt: -1 })
    ]);

    // Calculate risk signals
    const signals = [];
    let riskScore = 0;

    const pendingPct = totalRegs > 0 ? (pending / totalRegs) * 100 : 0;
    if (pendingPct > 50) { signals.push({ signal: "High unpaid rate", score: 25, detail: `${Math.round(pendingPct)}% registrations unpaid` }); riskScore += 25; }
    else if (pendingPct > 30) { signals.push({ signal: "Moderate unpaid rate", score: 15, detail: `${Math.round(pendingPct)}% registrations unpaid` }); riskScore += 15; }

    if (duplicates > 0) { signals.push({ signal: "Duplicate claims exist", score: 20, detail: `${duplicates} duplicate UTR claim(s)` }); riskScore += 20; }
    if (mismatches > 2) { signals.push({ signal: "Multiple amount mismatches", score: 15, detail: `${mismatches} mismatch(es)` }); riskScore += 15; }
    if (suspicious > 0) { signals.push({ signal: "Suspicious registrations", score: 15, detail: `${suspicious} flagged as suspicious` }); riskScore += 15; }
    if (openRisks > 5) { signals.push({ signal: "Many unresolved risks", score: 10, detail: `${openRisks} open risk cases` }); riskScore += 10; }

    // Check data freshness
    if (lastPayment) {
      const minsAgo = (Date.now() - new Date(lastPayment.createdAt)) / 60000;
      if (minsAgo > 360) { signals.push({ signal: "Stale payment data", score: 10, detail: `Last payment ${Math.round(minsAgo / 60)} hours ago` }); riskScore += 10; }
    }

    // Check Razorpay config
    if (!event.razorpayKeyId) { signals.push({ signal: "Razorpay not configured", score: 20, detail: "Payment links cannot be generated" }); riskScore += 20; }

    const riskBand = riskScore >= 70 ? "critical" : riskScore >= 45 ? "high" : riskScore >= 20 ? "medium" : "low";

    // AI commentary
    let aiCommentary = null;
    if (process.env.NVIDIA_API_KEY && signals.length > 0) {
      try {
        aiCommentary = await callNvidiaAI([
          { role: "system", content: "You are an event risk advisor. Given risk signals for an event, write a 2-3 sentence actionable summary. Be specific about what needs attention and what's fine. Plain language." },
          { role: "user", content: JSON.stringify({ eventName: event.name, daysUntilEvent: Math.ceil((new Date(event.eventDate) - Date.now()) / 86400000), totalRegs, verified, pending, signals, riskScore }) }
        ], "meta/llama-4-maverick-17b-128e", { max_tokens: 200 });
      } catch {}
    }

    res.json({ riskScore: Math.min(100, riskScore), riskBand, signals, stats: { totalRegs, verified, pending, mismatches, duplicates, suspicious, openRisks }, aiCommentary });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ AI: CHURN PREDICTION (Who won't pay) ============
app.get("/api/events/:eventId/ai/churn-prediction", auth, async (req, res) => {
  try {
    const eventId = req.params.eventId;
    const pending = await Registration.find({ eventId, paymentStatus: "awaiting_payment" }).select("registrationId name phone email ticketType expectedAmount createdAt");

    if (pending.length === 0) return res.json({ predictions: [], message: "No pending registrations" });

    // Score each pending registration by churn likelihood
    const now = Date.now();
    const predictions = pending.map(reg => {
      let churnScore = 0;
      const reasons = [];

      // Time since registration (older = more likely to churn)
      const hoursSinceReg = (now - new Date(reg.createdAt)) / 3600000;
      if (hoursSinceReg > 48) { churnScore += 40; reasons.push(`Registered ${Math.round(hoursSinceReg)} hours ago — very stale`); }
      else if (hoursSinceReg > 12) { churnScore += 20; reasons.push(`Registered ${Math.round(hoursSinceReg)} hours ago`); }
      else { reasons.push(`Registered ${Math.round(hoursSinceReg)} hours ago — still fresh`); }

      // Higher ticket prices churn more
      if (reg.expectedAmount > 1000) { churnScore += 15; reasons.push(`High ticket price (₹${reg.expectedAmount})`); }

      // No email = harder to reach
      if (!reg.email) { churnScore += 10; reasons.push("No email provided — only SMS possible"); }

      return { registrationId: reg.registrationId, name: reg.name, phone: reg.phone, expectedAmount: reg.expectedAmount, hoursSinceReg: Math.round(hoursSinceReg), churnScore, churnRisk: churnScore >= 40 ? "high" : churnScore >= 20 ? "medium" : "low", reasons };
    }).sort((a, b) => b.churnScore - a.churnScore);

    // AI enhancement: personalized recommendation
    let aiSummary = null;
    if (process.env.NVIDIA_API_KEY && predictions.length > 0) {
      try {
        aiSummary = await callNvidiaAI([
          { role: "system", content: "You are a payment recovery advisor for events. Given churn predictions for pending registrations, suggest a prioritized follow-up strategy in 3-4 bullet points. Be specific — mention groups and actions." },
          { role: "user", content: JSON.stringify({ totalPending: predictions.length, highRisk: predictions.filter(p => p.churnRisk === "high").length, mediumRisk: predictions.filter(p => p.churnRisk === "medium").length, lowRisk: predictions.filter(p => p.churnRisk === "low").length, topChurners: predictions.slice(0, 5) }) }
        ], "meta/llama-4-maverick-17b-128e", { max_tokens: 300 });
      } catch {}
    }

    res.json({ predictions, summary: { total: predictions.length, highRisk: predictions.filter(p => p.churnRisk === "high").length, mediumRisk: predictions.filter(p => p.churnRisk === "medium").length, lowRisk: predictions.filter(p => p.churnRisk === "low").length }, aiSummary });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ AI: AUTO-GENERATE PERSONALIZED MESSAGES ============
app.post("/api/events/:eventId/ai/generate-messages", auth, async (req, res) => {
  try {
    const { type, registrationIds } = req.body;
    const eventId = req.params.eventId;
    const event = await Event.findById(eventId);
    if (!event) return res.status(404).json({ error: "Event not found" });

    let targetRegs;
    if (registrationIds?.length) {
      targetRegs = await Registration.find({ eventId, registrationId: { $in: registrationIds } });
    } else if (type === "pending") {
      targetRegs = await Registration.find({ eventId, paymentStatus: "awaiting_payment" }).limit(20);
    } else if (type === "mismatch") {
      targetRegs = await Registration.find({ eventId, paymentStatus: "amount_mismatch" }).limit(20);
    } else {
      return res.status(400).json({ error: "Specify type ('pending'/'mismatch') or registrationIds" });
    }

    if (targetRegs.length === 0) return res.json({ messages: [], message: "No matching registrations" });

    if (!process.env.NVIDIA_API_KEY) return res.status(503).json({ error: "AI not configured" });

    const aiResponse = await callNvidiaAI([
      { role: "system", content: `You are a message writer for event payment reminders. Generate SHORT, friendly, personalized SMS messages (max 160 chars each) for participants.

Event: ${event.name}
Event Date: ${new Date(event.eventDate).toLocaleDateString("en-IN")}

Rules:
- Keep under 160 characters
- Be friendly and urgent but not pushy
- Include the participant's name
- Mention the amount if relevant
- Include "[Pay Now]" as placeholder for payment link
- Support Hinglish tone for Indian audience

RESPOND IN JSON: { "messages": [{ "registrationId": "...", "message": "..." }] }` },
      { role: "user", content: JSON.stringify(targetRegs.map(r => ({ registrationId: r.registrationId, name: r.name, expectedAmount: r.expectedAmount, paymentStatus: r.paymentStatus, hoursPending: Math.round((Date.now() - new Date(r.createdAt)) / 3600000) }))) }
    ], "meta/llama-4-maverick-17b-128e", { max_tokens: 1500 });

    let messages = [];
    try {
      const start = aiResponse.indexOf("{"); const end = aiResponse.lastIndexOf("}");
      if (start !== -1) { const parsed = JSON.parse(aiResponse.substring(start, end + 1)); messages = parsed.messages || []; }
    } catch {}

    res.json({ messages, count: messages.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ AI: POST-EVENT FINANCIAL REPORT ============
app.get("/api/events/:eventId/ai/financial-report", auth, async (req, res) => {
  try {
    const eventId = req.params.eventId;
    const event = await Event.findById(eventId);
    if (!event) return res.status(404).json({ error: "Event not found" });

    const oid = new mongoose.Types.ObjectId(eventId);
    const [regs, payments, risks] = await Promise.all([
      Registration.find({ eventId }),
      PaymentEvent.find({ eventId }),
      RiskQueue.find({ eventId })
    ]);

    const totalExpected = regs.reduce((s, r) => s + r.expectedAmount, 0);
    const totalCaptured = payments.filter(p => p.status === "captured").reduce((s, p) => s + p.amount, 0);
    const totalRefunded = payments.filter(p => p.status === "refunded").reduce((s, p) => s + p.amount, 0);
    const unpaidRegs = regs.filter(r => r.paymentStatus === "awaiting_payment");
    const mismatchRegs = regs.filter(r => r.paymentStatus === "amount_mismatch");
    const verifiedRegs = regs.filter(r => r.paymentStatus === "payment_verified");

    const gap = totalExpected - totalCaptured;
    const gapBreakdown = { unpaidAmount: unpaidRegs.reduce((s, r) => s + r.expectedAmount, 0), mismatchShortfall: mismatchRegs.reduce((s, r) => s + (r.expectedAmount - r.amountReceived), 0), refunded: totalRefunded };

    if (!process.env.NVIDIA_API_KEY) return res.json({ report: null, data: { totalExpected, totalCaptured, gap, gapBreakdown, regsCount: regs.length, verified: verifiedRegs.length, unpaid: unpaidRegs.length, risksResolved: risks.filter(r => r.status === "resolved").length, risksOpen: risks.filter(r => r.status === "open").length } });

    const report = await callNvidiaAI([
      { role: "system", content: `You are a financial report writer for event payment systems. Write a clear, professional post-event financial summary. Use this structure:

1. **Collection Summary** — total expected, collected, gap percentage
2. **Gap Explanation** — break down exactly where the gap comes from (unpaid, mismatches, refunds)
3. **Risk Cases** — how many were detected, how many resolved, outcomes
4. **Recommendations** — what the organizer should do next (follow up? write off? investigate?)

Keep it under 300 words. Use ₹ for amounts. Be specific with numbers.` },
      { role: "user", content: JSON.stringify({ eventName: event.name, eventDate: event.eventDate, totalRegistrations: regs.length, verified: verifiedRegs.length, unpaid: unpaidRegs.length, mismatches: mismatchRegs.length, totalExpected, totalCaptured, totalRefunded, gap, gapBreakdown, riskCases: { total: risks.length, resolved: risks.filter(r => r.status === "resolved").length, open: risks.filter(r => r.status === "open").length, dismissed: risks.filter(r => r.status === "dismissed").length }, paymentMethods: payments.reduce((acc, p) => { acc[p.method || "unknown"] = (acc[p.method || "unknown"] || 0) + 1; return acc; }, {}) }) }
    ], "meta/llama-4-maverick-17b-128e", { max_tokens: 800 });

    res.json({ report, data: { totalExpected, totalCaptured, gap, gapBreakdown, collectionRate: totalRegs > 0 ? Math.round((totalCaptured / totalExpected) * 100) : 0, regsCount: regs.length, verified: verifiedRegs.length, unpaid: unpaidRegs.length } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ AI: FRAUD PATTERN LEARNING ============
app.get("/api/events/:eventId/ai/fraud-patterns", auth, async (req, res) => {
  try {
    const eventId = req.params.eventId;
    // Get all resolved risk cases to learn from
    const resolvedRisks = await RiskQueue.find({ eventId, status: { $in: ["resolved", "dismissed"] } });
    const flaggedRegs = await Registration.find({ eventId, riskScore: { $gte: 50 } }).select("registrationId name phone email ticketType riskScore riskReasons paymentStatus entryStatus createdAt");

    if (resolvedRisks.length === 0 && flaggedRegs.length === 0) return res.json({ patterns: [], message: "Not enough data to detect patterns. Need resolved risk cases." });

    if (!process.env.NVIDIA_API_KEY) return res.json({ patterns: [{ pattern: "Insufficient AI access", suggestion: "Configure NVIDIA API key for pattern detection" }] });

    const aiResponse = await callNvidiaAI([
      { role: "system", content: `You are a fraud pattern analyst for event payments. Given resolved risk cases and flagged registrations, identify recurring patterns.

RESPOND IN JSON:
{
  "patterns": [
    { "pattern": "short description", "frequency": "how often seen", "indicators": ["signal 1", "signal 2"], "suggestedRule": "auto-hold if X and Y", "confidence": "high|medium|low" }
  ],
  "overallInsight": "one paragraph summary of fraud landscape for this event",
  "suggestedAutoRules": ["rule 1", "rule 2"]
}

Be specific — reference actual data patterns (time of day, amounts, phone prefixes, registration gaps). Don't invent patterns that aren't supported by the data.` },
      { role: "user", content: JSON.stringify({ resolvedRisks: resolvedRisks.map(r => ({ type: r.type, severity: r.severity, resolution: r.resolution, registrationId: r.registrationId })), flaggedRegistrations: flaggedRegs.map(r => ({ registrationId: r.registrationId, riskScore: r.riskScore, riskReasons: r.riskReasons, paymentStatus: r.paymentStatus, ticketType: r.ticketType, createdAt: r.createdAt })), totalResolved: resolvedRisks.length, totalFlagged: flaggedRegs.length }) }
    ], "meta/llama-4-maverick-17b-128e", { max_tokens: 1000 });

    let result = null;
    try {
      const start = aiResponse.indexOf("{"); const end = aiResponse.lastIndexOf("}");
      if (start !== -1) result = JSON.parse(aiResponse.substring(start, end + 1));
    } catch {}

    res.json(result || { patterns: [], overallInsight: aiResponse, suggestedAutoRules: [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ DEMO MODE ============
app.post("/api/events/:eventId/demo-seed", auth, async (req, res) => {
  try {
    const event = await Event.findById(req.params.eventId);
    if (!event) return res.status(404).json({ error: "Event not found" });
    if (String(event.organizerId) !== String(req.userId)) return res.status(403).json({ error: "Only the event owner can seed demo data" });

    const eventId = event._id;
    const ticketType = event.ticketTypes?.[0]?.name || "General";
    const price = event.ticketTypes?.[0]?.price || 500;

    // Realistic Indian names and data
    const demoParticipants = [
      { name: "Aarav Sharma", phone: "9876543210", email: "aarav@example.com", status: "payment_verified", entry: "entry_approved", paid: true },
      { name: "Priya Patel", phone: "9876543211", email: "priya@example.com", status: "payment_verified", entry: "entry_approved", paid: true },
      { name: "Rohit Kumar", phone: "9876543212", email: "rohit@example.com", status: "payment_verified", entry: "checked_in", paid: true },
      { name: "Sneha Reddy", phone: "9876543213", email: "sneha@example.com", status: "awaiting_payment", entry: "not_ready", paid: false },
      { name: "Vikram Singh", phone: "9876543214", email: "vikram@example.com", status: "awaiting_payment", entry: "not_ready", paid: false },
      { name: "Ananya Mishra", phone: "9876543215", email: "ananya@example.com", status: "amount_mismatch", entry: "entry_held", paid: true, amountPaid: price - 100 },
      { name: "Karthik Nair", phone: "9876543216", email: "karthik@example.com", status: "duplicate_claim", entry: "entry_held", paid: true, duplicate: true },
      { name: "Megha Gupta", phone: "9876543217", email: "megha@example.com", status: "payment_verified", entry: "entry_approved", paid: true },
      { name: "Arjun Desai", phone: "9876543218", email: "arjun@example.com", status: "suspicious", entry: "entry_held", paid: true, suspicious: true },
      { name: "Diya Joshi", phone: "9876543219", email: "diya@example.com", status: "payment_verified", entry: "checked_in", paid: true },
      { name: "Raj Malhotra", phone: "9876543220", email: "raj@example.com", status: "manual_review", entry: "not_ready", paid: true },
      { name: "Pooja Iyer", phone: "9876543221", email: "pooja@example.com", status: "payment_verified", entry: "entry_approved", paid: true },
    ];

    const createdRegs = [];
    const sharedUTR = "UTR" + crypto.randomBytes(6).toString("hex").toUpperCase();

    for (let i = 0; i < demoParticipants.length; i++) {
      const p = demoParticipants[i];
      const suffix = crypto.randomBytes(3).toString("hex").toUpperCase();
      const registrationId = `REG-${String(i + 1001).padStart(4, "0")}-${suffix}`;
      const entryToken = crypto.randomBytes(20).toString("hex");
      const utr = p.duplicate ? sharedUTR : (p.paid ? "UTR" + crypto.randomBytes(6).toString("hex").toUpperCase() : "");

      const reg = await Registration.create({
        eventId, isDemo: true, registrationId, name: p.name, phone: p.phone, email: p.email,
        college: "Demo College", ticketType, expectedAmount: price,
        numberOfTickets: 1, entryToken, paymentStatus: p.status, entryStatus: p.entry,
        riskScore: p.suspicious ? 75 : p.duplicate ? 80 : p.amountPaid ? 60 : 0,
        riskReasons: p.duplicate ? ["Duplicate UTR shared with another registration"] : p.amountPaid ? [`Amount mismatch: expected ₹${price}, received ₹${p.amountPaid}`] : p.suspicious ? ["Late payment after event cutoff", "Phone number mismatch"] : [],
        amountReceived: p.amountPaid || (p.paid ? price : 0),
        paymentId: p.paid ? "pay_demo_" + crypto.randomBytes(6).toString("hex") : "",
        utr, checkedInAt: p.entry === "checked_in" ? new Date() : null
      });
      createdRegs.push(reg);

      // Create payment event for paid participants
      if (p.paid) {
        await PaymentEvent.create({
          eventId, isDemo: true, registrationId, razorpayPaymentId: "pay_demo_" + crypto.randomBytes(6).toString("hex"),
          utr, amount: p.amountPaid || price, currency: "INR",
          status: "captured", method: ["upi", "card", "netbanking"][Math.floor(Math.random() * 3)],
          contact: p.phone, email: p.email, matched: true, matchConfidence: p.duplicate ? 40 : p.amountPaid ? 70 : 95,
          notes: { registrationId, eventId: String(eventId) }, capturedAt: new Date()
        });
      }
    }

    // Create risk queue entries
    const mismatchReg = createdRegs.find(r => r.paymentStatus === "amount_mismatch");
    if (mismatchReg) {
       await RiskQueue.create({ eventId, isDemo: true, registrationId: mismatchReg.registrationId, type: "amount_mismatch", severity: "high", details: { expected: price, received: price - 100, confidence: 70 }, status: "open" });
    }
    const dupReg = createdRegs.find(r => r.paymentStatus === "duplicate_claim");
    if (dupReg) {
       await RiskQueue.create({ eventId, isDemo: true, registrationId: dupReg.registrationId, type: "duplicate_utr", severity: "critical", details: { sharedUTR, otherRegistrations: [createdRegs[0].registrationId] }, status: "open" });
    }
    const suspReg = createdRegs.find(r => r.paymentStatus === "suspicious");
    if (suspReg) {
       await RiskQueue.create({ eventId, isDemo: true, registrationId: suspReg.registrationId, type: "timing_anomaly", severity: "medium", details: { reason: "Payment received after event registration cutoff" }, status: "open" });
    }

    // Create audit log entries
    await AuditLog.create({ eventId, isDemo: true, actorId: req.userId, actorRole: "organizer", action: "demo.seeded", target: "event", reason: `Seeded ${demoParticipants.length} demo registrations` });
    for (const r of createdRegs.filter(r => r.entryStatus === "checked_in")) {
      await AuditLog.create({ eventId, isDemo: true, actorId: req.userId, actorRole: "volunteer", action: "entry.checked_in", target: r.registrationId });
    }

    res.json({ success: true, message: `Demo data created: ${createdRegs.length} registrations, 3 risk cases, payment events`, count: createdRegs.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Demo reset
app.post("/api/events/:eventId/demo-reset", auth, async (req, res) => {
  try {
    const event = await Event.findById(req.params.eventId);
    if (!event || String(event.organizerId) !== String(req.userId)) return res.status(403).json({ error: "Not authorized" });
    // Include demo records created before the isDemo marker was introduced.
    // Keep this legacy match exact: generic demo-looking fields can belong to real users.
    const legacyDemoEmails = [
      "aarav@example.com", "priya@example.com", "rohit@example.com", "sneha@example.com",
      "vikram@example.com", "ananya@example.com", "karthik@example.com", "megha@example.com",
      "arjun@example.com", "diya@example.com", "raj@example.com", "pooja@example.com"
    ];
    const legacyDemoPhones = Array.from({ length: 12 }, (_, i) => `987654${String(3210 + i)}`);
    const demoRegs = await Registration.find({
      eventId: req.params.eventId,
      $or: [
        { isDemo: true },
        { paymentId: /^pay_demo_/ },
        { email: { $in: legacyDemoEmails } },
        { phone: { $in: legacyDemoPhones } }
      ]
    }).select("registrationId");
    const demoRegistrationIds = demoRegs.map(r => r.registrationId);
    const demoRecordFilter = { eventId: req.params.eventId, $or: [{ isDemo: true }, { registrationId: { $in: demoRegistrationIds } }] };
    const demoAuditFilter = {
      eventId: req.params.eventId,
      $or: [
        { isDemo: true },
        { action: "demo.seeded" },
        { target: { $in: demoRegistrationIds } }
      ]
    };
    await Promise.all([
      Registration.deleteMany({ eventId: req.params.eventId, _id: { $in: demoRegs.map(r => r._id) } }),
      PaymentEvent.deleteMany({
        eventId: req.params.eventId,
        $or: [{ isDemo: true }, { razorpayPaymentId: /^pay_demo_/ }, { registrationId: { $in: demoRegistrationIds } }]
      }),
      RiskQueue.deleteMany(demoRecordFilter),
      MessageLog.deleteMany(demoRecordFilter),
      AuditLog.deleteMany(demoAuditFilter)
    ]);
    res.json({ success: true, message: "Demo data cleared; your original data was kept" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ REAL-TIME SSE ============
const sseClients = new Map(); // eventId -> Set of response objects

app.get("/api/events/:eventId/stream", (req, res) => {
  // Auth via query param since EventSource can't send headers
  const token = req.query.token || req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Auth required" });
  try { jwt.verify(token, JWT_SECRET); } catch { return res.status(401).json({ error: "Invalid token" }); }

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
  res.write("data: {\"type\":\"connected\"}\n\n");

  const eventId = req.params.eventId;
  if (!sseClients.has(eventId)) sseClients.set(eventId, new Set());
  sseClients.get(eventId).add(res);

  req.on("close", () => { sseClients.get(eventId)?.delete(res); });
});

function broadcastSSE(eventId, type, data) {
  const clients = sseClients.get(String(eventId));
  if (!clients || clients.size === 0) return;
  const msg = `data: ${JSON.stringify({ type, ...data, timestamp: new Date().toISOString() })}\n\n`;
  for (const client of clients) { try { client.write(msg); } catch {} }
}

// ============ AUDIT WITH HASH CHAIN ============
async function createAuditWithHash(data) {
  // Get the last audit entry for this event to build the chain
  const lastAudit = await AuditLog.findOne({ eventId: data.eventId }).sort({ createdAt: -1 });
  const prevHash = lastAudit?.hash || "GENESIS";
  const payload = JSON.stringify({ ...data, prevHash, timestamp: Date.now() });
  const hash = crypto.createHash("sha256").update(payload).digest("hex");
  const entry = await AuditLog.create({ ...data, prevHash, hash });

  // Broadcast via SSE
  broadcastSSE(data.eventId, "audit", { action: data.action, target: data.target });
  return entry;
}

// Verify audit chain integrity
app.get("/api/events/:eventId/audit/verify", auth, async (req, res) => {
  try {
    const logs = await AuditLog.find({ eventId: req.params.eventId }).sort({ createdAt: 1 });
    if (logs.length === 0) return res.json({ valid: true, message: "No audit entries", count: 0 });

    let valid = true;
    let brokenAt = null;
    for (let i = 1; i < logs.length; i++) {
      if (logs[i].prevHash && logs[i - 1].hash && logs[i].prevHash !== logs[i - 1].hash) {
        valid = false;
        brokenAt = i;
        break;
      }
    }

    const hasHashes = logs.some(l => l.hash);
    res.json({
      valid: hasHashes ? valid : true,
      message: valid ? "Audit chain integrity verified — no tampering detected" : `Chain broken at entry ${brokenAt}`,
      count: logs.length,
      hasHashChain: hasHashes,
      firstEntry: logs[0]?.createdAt,
      lastEntry: logs[logs.length - 1]?.createdAt
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ PDF EXPORT ============
app.get("/api/events/:eventId/export/report", (req, res, next) => {
  // Auth via query param for new-window access
  const token = req.query.token || req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Auth required" });
  try { const d = jwt.verify(token, JWT_SECRET); req.userId = d.userId; req.role = d.role; next(); } catch { return res.status(401).json({ error: "Invalid token" }); }
}, async (req, res) => {
  try {
    const event = await Event.findById(req.params.eventId);
    if (!event) return res.status(404).json({ error: "Event not found" });
    const eventId = req.params.eventId;
    const oid = new mongoose.Types.ObjectId(eventId);

    const [regs, payments, risks, audits] = await Promise.all([
      Registration.find({ eventId }).sort({ createdAt: -1 }),
      PaymentEvent.find({ eventId }).sort({ createdAt: -1 }),
      RiskQueue.find({ eventId }),
      AuditLog.find({ eventId }).sort({ createdAt: -1 }).limit(50)
    ]);

    const totalExpected = regs.reduce((s, r) => s + r.expectedAmount, 0);
    const totalReceived = payments.filter(p => p.status === "captured").reduce((s, p) => s + p.amount, 0);
    const verified = regs.filter(r => r.paymentStatus === "payment_verified").length;
    const pending = regs.filter(r => r.paymentStatus === "awaiting_payment").length;
    const mismatches = regs.filter(r => r.paymentStatus === "amount_mismatch").length;
    const duplicates = regs.filter(r => r.paymentStatus === "duplicate_claim").length;

    // Generate HTML report (can be printed as PDF from browser)
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${event.name} - Report</title>
<style>body{font-family:-apple-system,sans-serif;max-width:800px;margin:0 auto;padding:40px;color:#1a1a2e}h1{font-size:24px;border-bottom:2px solid #635bff;padding-bottom:10px}h2{font-size:18px;margin-top:30px;color:#635bff}table{width:100%;border-collapse:collapse;margin:15px 0;font-size:12px}th,td{padding:8px 10px;border:1px solid #e2e8f0;text-align:left}th{background:#f8f9fa;font-weight:600}.metric{display:inline-block;padding:8px 16px;margin:4px;background:#f0f1ff;border-radius:8px;font-size:13px}.metric strong{display:block;font-size:20px;color:#635bff}.risk-high{color:#dc2626}.risk-medium{color:#d97706}.verified{color:#059669}.footer{margin-top:40px;padding-top:15px;border-top:1px solid #e2e8f0;font-size:11px;color:#64748b}</style></head><body>
<h1>${event.name} — Event Report</h1>
<p>Generated: ${new Date().toLocaleString("en-IN")} | Date: ${new Date(event.eventDate).toLocaleDateString("en-IN")}</p>

<h2>Summary</h2>
<div class="metric"><strong>${regs.length}</strong>Total Registrations</div>
<div class="metric"><strong class="verified">${verified}</strong>Verified Payments</div>
<div class="metric"><strong>${pending}</strong>Pending</div>
<div class="metric"><strong class="risk-high">${mismatches + duplicates}</strong>Issues</div>

<h2>Financial Reconciliation</h2>
<table><tr><td>Expected Gross</td><td><strong>₹${totalExpected.toLocaleString("en-IN")}</strong></td></tr>
<tr><td>Captured</td><td><strong class="verified">₹${totalReceived.toLocaleString("en-IN")}</strong></td></tr>
<tr><td>Gap</td><td><strong class="risk-high">₹${(totalExpected - totalReceived).toLocaleString("en-IN")}</strong></td></tr>
<tr><td>Estimated Fees (~2%)</td><td>₹${Math.round(totalReceived * 0.02).toLocaleString("en-IN")}</td></tr>
<tr><td><strong>Estimated Net</strong></td><td><strong>₹${Math.round(totalReceived * 0.98).toLocaleString("en-IN")}</strong></td></tr></table>

<h2>Risk Cases (${risks.length})</h2>
${risks.length ? `<table><tr><th>Registration</th><th>Type</th><th>Severity</th><th>Status</th></tr>${risks.map(r => `<tr><td>${r.registrationId}</td><td>${r.type.replace(/_/g, " ")}</td><td class="risk-${r.severity}">${r.severity}</td><td>${r.status}</td></tr>`).join("")}</table>` : "<p>No risk cases.</p>"}

<h2>All Registrations (${regs.length})</h2>
<table><tr><th>ID</th><th>Name</th><th>Phone</th><th>Expected</th><th>Received</th><th>Payment</th><th>Entry</th></tr>
${regs.map(r => `<tr><td>${r.registrationId}</td><td>${r.name}</td><td>${r.phone}</td><td>₹${r.expectedAmount}</td><td>₹${r.amountReceived}</td><td>${r.paymentStatus.replace(/_/g, " ")}</td><td>${r.entryStatus.replace(/_/g, " ")}</td></tr>`).join("")}</table>

<h2>Recent Audit Log</h2>
<table><tr><th>Time</th><th>Action</th><th>Target</th><th>Reason</th></tr>
${audits.slice(0, 20).map(a => `<tr><td>${new Date(a.createdAt).toLocaleString("en-IN")}</td><td>${a.action}</td><td>${a.target || "—"}</td><td>${a.reason || "—"}</td></tr>`).join("")}</table>

<div class="footer"><p>FormPay Report | Audit chain: ${audits.some(a => a.hash) ? "Hash-verified" : "Standard"} | ${audits.length} audit entries</p></div>
</body></html>`;

    res.setHeader("Content-Type", "text/html");
    res.setHeader("Content-Disposition", `inline; filename="${event.name.replace(/[^a-z0-9]/gi, "_")}_report.html"`);
    res.send(html);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ HEALTH & MONITORING ============
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "formpay",
    version: "1.0.0",
    database: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    checks: {
      mongodb: mongoose.connection.readyState === 1,
      groqAi: Boolean(process.env.GROQ_API_KEY),
      googleAuth: Boolean(process.env.GOOGLE_CLIENT_ID)
    }
  });
});

app.get("/api/events/:eventId/health", auth, async (req, res) => {
  try {
    const event = await Event.findById(req.params.eventId);
    if (!event) return res.status(404).json({ error: "Event not found" });
    const lastPayment = await PaymentEvent.findOne({ eventId: req.params.eventId }).sort({ createdAt: -1 });
    const lastReg = await Registration.findOne({ eventId: req.params.eventId }).sort({ createdAt: -1 });
    const openRisks = await RiskQueue.countDocuments({ eventId: req.params.eventId, status: "open" });
    res.json({
      event: { name: event.name, status: event.status },
      razorpay: Boolean(event.razorpayKeyId && event.razorpayKeySecret),
      webhookSecret: Boolean(event.razorpayWebhookSecret),
      googleForm: Boolean(event.googleFormUrl),
      intakeToken: Boolean(event.intakeToken),
      lastPaymentAt: lastPayment?.createdAt || null,
      lastRegistrationAt: lastReg?.createdAt || null,
      openRiskCases: openRisks,
      dataAge: lastPayment ? `${Math.floor((Date.now() - new Date(lastPayment.createdAt)) / 60000)} min ago` : "No payments yet"
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ SERVE CLIENT IN PRODUCTION ============
const clientDist = path.join(__dirname, "../../client/dist");
app.use(express.static(clientDist));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api")) return next();
  res.sendFile(path.join(clientDist, "index.html"));
});

app.use((_req, res) => res.status(404).json({ error: "Route not found" }));

// ============ PAYMENT MATCHING ENGINE ============
async function matchPaymentToRegistration(paymentEvent) {
  try {
    const reg = await Registration.findOne({ registrationId: paymentEvent.registrationId });
    if (!reg) return;

    let confidence = 0;
    const reasons = [];

    // Match by registration ID in notes
    if (paymentEvent.registrationId) confidence += 40;
    // Match by amount
    if (paymentEvent.amount === reg.expectedAmount) { confidence += 30; }
    else { reasons.push(`Amount mismatch: expected ₹${reg.expectedAmount}, received ₹${paymentEvent.amount}`); }
    // Match by phone
    if (paymentEvent.contact && paymentEvent.contact.includes(reg.phone.slice(-10))) confidence += 20;
    // Match by order ID
    if (paymentEvent.razorpayOrderId && reg.orderId && paymentEvent.razorpayOrderId === reg.orderId) confidence += 10;

    paymentEvent.matched = true;
    paymentEvent.matchConfidence = Math.min(confidence, 100);
    await paymentEvent.save();

    // Update registration
    if (paymentEvent.status === "captured") {
      reg.amountReceived = paymentEvent.amount;
      reg.paymentId = paymentEvent.razorpayPaymentId;
      reg.utr = paymentEvent.utr;

      if (confidence >= 95 && paymentEvent.amount === reg.expectedAmount) {
        reg.paymentStatus = "payment_verified";
        reg.entryStatus = "entry_approved";
        reg.riskScore = Math.max(0, 100 - confidence);
      } else if (paymentEvent.amount < reg.expectedAmount) {
        reg.paymentStatus = "amount_mismatch";
        reg.riskReasons.push(...reasons);
        reg.riskScore = 60;
        await RiskQueue.create({ eventId: reg.eventId, registrationId: reg.registrationId, type: "amount_mismatch", severity: "high", details: { expected: reg.expectedAmount, received: paymentEvent.amount, confidence } });
      } else {
        reg.paymentStatus = "manual_review";
        reg.riskScore = Math.max(0, 100 - confidence);
      }
      await reg.save();
    }
  } catch (e) { console.error("Match error:", e.message); }
}

// ============ START ============
startKeepAlive();
if (!process.env.MONGODB_URI) {
  console.warn("MONGODB_URI not configured");
  app.listen(PORT, "0.0.0.0", () => console.log(`EventPay Sentinel API on port ${PORT}`));
} else {
  mongoose.connect(process.env.MONGODB_URI).then(() => {
    console.log("MongoDB connected");
    app.listen(PORT, "0.0.0.0", () => console.log(`EventPay Sentinel API on port ${PORT}`));
  }).catch(e => { console.error("DB error:", e.message); process.exit(1); });
}
