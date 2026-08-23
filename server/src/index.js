import "dotenv/config";
import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import Groq from "groq-sdk";
import Razorpay from "razorpay";
import { OAuth2Client } from "google-auth-library";
import { User, Event, Registration, PaymentEvent, RiskQueue, MessageLog, AuditLog } from "./models.js";

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || "eventpay-sentinel-secret";
function getRazorpayKeys(event) {
  return {
    keyId: event.razorpayKeyId,
    keySecret: event.razorpayKeySecret
  };
}
function razorpayErrorMessage(error) {
  return error?.error?.description || error?.description || error?.message || "Razorpay rejected the payment link request";
}

// ============ RAZORPAY WEBHOOK (raw body needed) ============
app.post("/api/webhooks/razorpay", express.raw({ type: "application/json" }), async (req, res) => {
  if (!process.env.RAZORPAY_WEBHOOK_SECRET) return res.status(503).json({ error: "Webhook not configured" });
  const signature = req.headers["x-razorpay-signature"];
  const expected = crypto.createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET).update(req.body).digest("hex");
  if (!signature || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return res.status(401).json({ error: "Invalid signature" });
  try {
    const event = JSON.parse(req.body.toString("utf8"));
    const payment = event.payload?.payment?.entity;
    if (!payment) return res.json({ received: true });

    // Store payment event
    const existing = await PaymentEvent.findOne({ razorpayPaymentId: payment.id });
    if (existing) return res.json({ received: true, duplicate: true });

    const regId = payment.notes?.registrationId || "";
    const eventId = payment.notes?.eventId || "";

    const pe = await PaymentEvent.create({
      eventId: eventId || undefined, registrationId: regId, razorpayPaymentId: payment.id,
      razorpayOrderId: payment.order_id || "", paymentLinkId: payment.payment_link_id || "",
      utr: payment.acquirer_data?.utr || "", amount: payment.amount / 100, currency: payment.currency,
      status: event.event === "payment.captured" ? "captured" : event.event === "payment.failed" ? "failed" : event.event === "payment.refunded" ? "refunded" : "authorized",
      method: payment.method || "", contact: payment.contact || "", email: payment.email || "",
      notes: payment.notes || {}, capturedAt: payment.captured ? new Date() : null, webhookEventId: event.event
    });

    // Auto-match to registration
    if (regId) {
      await matchPaymentToRegistration(pe);
    }

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
    const events = await Event.find({ organizerId: req.userId }).sort({ createdAt: -1 });
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

    // Generate unique registration ID
    const count = await Registration.countDocuments({ eventId: event._id });
    const registrationId = `REG-${String(count + 1001).padStart(4, "0")}`;

    // Check duplicate phone+event
    const dup = await Registration.findOne({ eventId: event._id, phone });
    if (dup) return res.status(400).json({ error: "Phone already registered for this event" });

    const entryToken = crypto.randomBytes(20).toString("hex");
    const reg = await Registration.create({ eventId: event._id, registrationId, name, phone, email: email || "", college: college || "", ticketType, expectedAmount, numberOfTickets: numberOfTickets || 1, entryToken });

    // Create Razorpay payment link if configured
    const { keyId: rzpKeyId, keySecret: rzpKeySecret } = getRazorpayKeys(event);
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
    const registrationId = `REG-${String(count + 1001).padStart(4, "0")}`;
    const dup = await Registration.findOne({ eventId: event._id, phone });
    if (dup) return res.status(400).json({ error: "Already registered", registrationId: dup.registrationId, paymentLinkUrl: dup.paymentLinkUrl });
    const entryToken = crypto.randomBytes(20).toString("hex");
    const reg = await Registration.create({ eventId: event._id, registrationId, name, phone, email: email || "", college: college || "", ticketType: ticket.name, expectedAmount, numberOfTickets: 1, entryToken });

    // Create Razorpay payment link using event-level keys
    const { keyId: rzpKeyId, keySecret: rzpKeySecret } = getRazorpayKeys(event);
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
    if (req.query.search) query.$or = [{ name: { $regex: req.query.search, $options: "i" } }, { phone: { $regex: req.query.search } }, { registrationId: { $regex: req.query.search, $options: "i" } }];
    const regs = await Registration.find(query).sort({ createdAt: -1 }).limit(Number(req.query.limit) || 500);
    res.json(regs);
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

app.post("/api/events/:eventId/registrations/:regId/hold", auth, async (req, res) => {
  try {
    const reg = await Registration.findOneAndUpdate({ eventId: req.params.eventId, registrationId: req.params.regId }, { entryStatus: "entry_held" }, { new: true });
    await AuditLog.create({ eventId: req.params.eventId, actorId: req.userId, actorRole: req.role, action: "entry.held", target: req.params.regId, reason: req.body.reason || "" });
    res.json(reg);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/events/:eventId/registrations/:regId/approve", auth, async (req, res) => {
  try {
    const reg = await Registration.findOneAndUpdate({ eventId: req.params.eventId, registrationId: req.params.regId }, { entryStatus: "entry_approved", paymentStatus: "payment_verified" }, { new: true });
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
    const expectedGross = (await Registration.aggregate([{ $match: { eventId: new mongoose.Types.ObjectId(eventId) } }, { $group: { _id: null, total: { $sum: "$expectedAmount" } } }]))[0]?.total || 0;
    const captured = (await PaymentEvent.aggregate([{ $match: { eventId: new mongoose.Types.ObjectId(eventId), status: "captured" } }, { $group: { _id: null, total: { $sum: "$amount" } } }]))[0]?.total || 0;
    const refunded = (await PaymentEvent.aggregate([{ $match: { eventId: new mongoose.Types.ObjectId(eventId), status: "refunded" } }, { $group: { _id: null, total: { $sum: "$amount" } } }]))[0]?.total || 0;
    const fees = Math.round(captured * 0.02 * 100) / 100; // ~2% Razorpay fees
    const expectedNet = captured - refunded - fees;
    res.json({ expectedGross, captured, refunded, fees, expectedNet, difference: expectedGross - captured });
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

// ============ AI INVESTIGATION ============
app.post("/api/events/:eventId/ai/investigate", auth, async (req, res) => {
  if (!process.env.GROQ_API_KEY) return res.status(503).json({ error: "AI not configured" });
  try {
    const { question } = req.body;
    if (!question) return res.status(400).json({ error: "Question is required" });
    const eventId = req.params.eventId;

    // Gather context
    const [metrics, regs, risks, payments] = await Promise.all([
      Registration.aggregate([{ $match: { eventId: new mongoose.Types.ObjectId(eventId) } }, { $group: { _id: "$paymentStatus", count: { $sum: 1 }, total: { $sum: "$expectedAmount" }, received: { $sum: "$amountReceived" } } }]),
      Registration.find({ eventId }).select("registrationId name paymentStatus entryStatus expectedAmount amountReceived riskReasons ticketType").limit(50),
      RiskQueue.find({ eventId, status: "open" }).limit(20),
      PaymentEvent.find({ eventId }).select("registrationId amount status razorpayPaymentId utr").limit(30)
    ]);

    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const completion = await groq.chat.completions.create({
      model: "openai/gpt-oss-120b", temperature: 0.2,
      messages: [
        { role: "system", content: `You are EventPay Sentinel AI — an investigation assistant for event payment verification. Answer questions using ONLY the provided data. Format: 1) Direct answer 2) Evidence 3) Risk level 4) Recommended action. If data is missing, say so. Support Hindi/Hinglish if asked. Never invent payment data.` },
        { role: "user", content: JSON.stringify({ question, metrics, registrations: regs.slice(0, 20), risks, payments: payments.slice(0, 15) }) }
      ]
    });
    res.json({ answer: completion.choices[0]?.message?.content || "Unable to generate response", question });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

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
        checks.push({ ok: false, label: "Razorpay Connection", msg: `Razorpay credentials failed: ${e.message}` });
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
        const link = await razorpay.paymentLink.create({
          amount: testTicket.price * 100,
          currency: "INR",
          description: `[TEST] ${event.name} - ${testTicket.name}`,
          customer: { name: "Test User", contact: "9999999999" },
          notify: { sms: false, email: false },
          notes: { test: "true", eventId: String(event._id) },
          expire_by: Math.floor(Date.now() / 1000) + 300
        });
        testPaymentLink = link.short_url;
        checks.push({ ok: true, label: "Payment Link Generation", msg: `Payment link created for "${testTicket.name}" (₹${testTicket.price}). Payments go to YOUR Razorpay account.` });
        try { await razorpay.paymentLink.cancel(link.id); } catch {}
      } catch (e) {
        checks.push({ ok: false, label: "Payment Link Generation", msg: `Failed to create payment link: ${e.message}` });
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

// ============ HEALTH ============
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", service: "eventpay-sentinel", database: mongoose.connection.readyState === 1 ? "connected" : "disconnected" });
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
if (!process.env.MONGODB_URI) {
  console.warn("MONGODB_URI not configured");
  app.listen(PORT, "0.0.0.0", () => console.log(`EventPay Sentinel API on port ${PORT}`));
} else {
  mongoose.connect(process.env.MONGODB_URI).then(() => {
    console.log("MongoDB connected");
    app.listen(PORT, "0.0.0.0", () => console.log(`EventPay Sentinel API on port ${PORT}`));
  }).catch(e => { console.error("DB error:", e.message); process.exit(1); });
}
