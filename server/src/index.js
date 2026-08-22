import "dotenv/config";
import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import Groq from "groq-sdk";
import Razorpay from "razorpay";
import { User, Event, Registration, PaymentEvent, RiskQueue, MessageLog, AuditLog } from "./models.js";

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || "eventpay-sentinel-secret";

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
app.post("/api/auth/register", async (req, res) => {
  try {
    const { name, email, phone, password, role } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: "Name, email, and password required" });
    if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) return res.status(400).json({ error: "Email already registered" });
    const hashed = await bcrypt.hash(password, 10);
    const user = await User.create({ name, email: email.toLowerCase(), phone: phone || "", password: hashed, role: role || "organizer" });
    const token = jwt.sign({ userId: user._id, role: user.role }, JWT_SECRET, { expiresIn: "30d" });
    res.status(201).json({ token, user: { id: user._id, name: user.name, email: user.email, role: user.role } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email and password required" });
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(401).json({ error: "Invalid credentials" });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: "Invalid credentials" });
    const token = jwt.sign({ userId: user._id, role: user.role }, JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user: { id: user._id, name: user.name, email: user.email, role: user.role } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/auth/me", auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select("-password");
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ user: { id: user._id, name: user.name, email: user.email, role: user.role } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ EVENT ROUTES ============
app.post("/api/events", auth, async (req, res) => {
  try {
    const { name, venue, eventDate, ticketTypes, capacity, registrationEnd, paymentExpiryMinutes, entryRules } = req.body;
    if (!name || !eventDate) return res.status(400).json({ error: "Event name and date required" });
    const intakeToken = crypto.randomBytes(16).toString("hex");
    const event = await Event.create({ organizerId: req.userId, name, venue: venue || "", eventDate, ticketTypes: ticketTypes || [], capacity: capacity || 1000, registrationEnd, paymentExpiryMinutes: paymentExpiryMinutes || 60, entryRules: entryRules || "", intakeToken });
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
    if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
      try {
        const razorpay = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
        const link = await razorpay.paymentLink.create({
          amount: expectedAmount * 100, currency: "INR",
          description: `${event.name} - ${ticketType}`,
          customer: { name, contact: phone, email: email || undefined },
          notify: { sms: true, email: Boolean(email) },
          notes: { registrationId, eventId: String(event._id) },
          callback_url: process.env.CLIENT_ORIGIN || "http://localhost:5000",
          expire_by: Math.floor(Date.now() / 1000) + (event.paymentExpiryMinutes || 60) * 60
        });
        reg.paymentLinkId = link.id;
        reg.paymentLinkUrl = link.short_url;
        reg.orderId = link.order_id || "";
        await reg.save();
      } catch (e) { console.error("Payment link creation failed:", e.message); }
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
    const { name, phone, email, college, ticketType, numberOfTickets } = req.body;
    if (!name || !phone || !ticketType) return res.status(400).json({ error: "Name, phone, and ticket type required" });
    const ticket = event.ticketTypes.find(t => t.name === ticketType);
    if (!ticket) return res.status(400).json({ error: "Invalid ticket type" });
    const expectedAmount = ticket.price * (numberOfTickets || 1);
    const count = await Registration.countDocuments({ eventId: event._id });
    const registrationId = `REG-${String(count + 1001).padStart(4, "0")}`;
    const dup = await Registration.findOne({ eventId: event._id, phone });
    if (dup) return res.status(400).json({ error: "Already registered", registrationId: dup.registrationId });
    const entryToken = crypto.randomBytes(20).toString("hex");
    const reg = await Registration.create({ eventId: event._id, registrationId, name, phone, email: email || "", college: college || "", ticketType, expectedAmount, numberOfTickets: numberOfTickets || 1, entryToken });
    res.status(201).json({ registrationId: reg.registrationId, expectedAmount, paymentLinkUrl: reg.paymentLinkUrl });
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
      model: "llama-3.3-70b-versatile", temperature: 0.2,
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

// ============ SEED DEMO DATA ============
app.post("/api/events/:eventId/seed-demo", auth, async (req, res) => {
  try {
    const event = await Event.findById(req.params.eventId);
    if (!event) return res.status(404).json({ error: "Event not found" });

    const demoRegs = [
      { name: "Aarav Sharma", phone: "9876543210", email: "aarav@test.com", ticketType: "Tech Pass", expectedAmount: 799, paymentStatus: "payment_verified", entryStatus: "entry_approved", amountReceived: 799, riskScore: 2 },
      { name: "Riya Verma", phone: "9876543211", email: "riya@test.com", ticketType: "General", expectedAmount: 499, paymentStatus: "suspicious", entryStatus: "entry_held", amountReceived: 0, riskScore: 85, riskReasons: ["Payment not found", "Screenshot submitted but no matching payment"] },
      { name: "Karan Singh", phone: "9876543212", email: "karan@test.com", ticketType: "Tech Pass", expectedAmount: 799, paymentStatus: "amount_mismatch", entryStatus: "not_ready", amountReceived: 499, riskScore: 60, riskReasons: ["Amount mismatch: expected ₹799, received ₹499"] },
      { name: "Priya Patel", phone: "9876543213", email: "priya@test.com", ticketType: "General", expectedAmount: 499, paymentStatus: "duplicate_claim", entryStatus: "entry_held", amountReceived: 499, riskScore: 90, riskReasons: ["Same UTR claimed by REG-1001 and REG-1004"] },
      { name: "Arjun Kumar", phone: "9876543214", email: "arjun@test.com", ticketType: "General", expectedAmount: 499, paymentStatus: "awaiting_payment", entryStatus: "not_ready", amountReceived: 0, riskScore: 0 },
      { name: "Neha Gupta", phone: "9876543215", email: "neha@test.com", ticketType: "VIP", expectedAmount: 1499, paymentStatus: "payment_verified", entryStatus: "entry_approved", amountReceived: 1499, riskScore: 0 }
    ];

    let created = 0;
    for (const d of demoRegs) {
      const exists = await Registration.findOne({ eventId: event._id, phone: d.phone });
      if (exists) continue;
      const count = await Registration.countDocuments({ eventId: event._id });
      const registrationId = `REG-${String(count + 1001).padStart(4, "0")}`;
      const entryToken = crypto.randomBytes(20).toString("hex");
      await Registration.create({ eventId: event._id, registrationId, entryToken, ...d });
      created++;
    }

    // Create risk queue entries
    const suspiciousRegs = await Registration.find({ eventId: event._id, riskScore: { $gte: 50 } });
    for (const r of suspiciousRegs) {
      const exists = await RiskQueue.findOne({ eventId: event._id, registrationId: r.registrationId });
      if (!exists) {
        await RiskQueue.create({ eventId: event._id, registrationId: r.registrationId, type: r.paymentStatus === "duplicate_claim" ? "duplicate_utr" : r.paymentStatus === "amount_mismatch" ? "amount_mismatch" : "payment_not_found", severity: r.riskScore >= 80 ? "critical" : r.riskScore >= 60 ? "high" : "medium", details: { reasons: r.riskReasons, expectedAmount: r.expectedAmount, receivedAmount: r.amountReceived } });
      }
    }

    res.json({ created, message: `${created} demo registrations added` });
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
