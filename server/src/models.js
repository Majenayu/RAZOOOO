import mongoose from "mongoose";

// ============ USER ============
const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  phone: { type: String, default: "" },
  password: { type: String, default: "" },
  googleId: { type: String, default: "", index: true },
  avatar: { type: String, default: "" },
  googleAccessToken: { type: String, default: "" },
  role: { type: String, enum: ["organizer", "volunteer", "finance"], default: "organizer" }
}, { timestamps: true });

// ============ EVENT ============
const ticketTypeSchema = new mongoose.Schema({
  name: { type: String, required: true },
  price: { type: Number, required: true },
  capacity: { type: Number, default: 0 },
  sold: { type: Number, default: 0 }
}, { _id: true });

const eventSchema = new mongoose.Schema({
  organizerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  name: { type: String, required: true, trim: true },
  venue: { type: String, default: "" },
  eventDate: { type: Date, required: true },
  status: { type: String, enum: ["draft", "live", "closed"], default: "draft" },
  isDemo: { type: Boolean, default: false, index: true },
  ticketTypes: [ticketTypeSchema],
  capacity: { type: Number, default: 1000 },
  registrationStart: { type: Date, default: Date.now },
  registrationEnd: { type: Date, default: null },
  paymentExpiryMinutes: { type: Number, default: 60 },
  entryRules: { type: String, default: "" },
  intakeToken: { type: String, default: "" },
  googleFormUrl: { type: String, default: "" },
  fieldMapping: { type: mongoose.Schema.Types.Mixed, default: null },
  razorpayKeyId: { type: String, default: "" },
  razorpayKeySecret: { type: String, default: "" },
  razorpayWebhookSecret: { type: String, default: "" },
  collaborators: [{ email: { type: String, required: true, lowercase: true, trim: true }, role: { type: String, enum: ["viewer", "editor"], default: "viewer" }, addedAt: { type: Date, default: Date.now } }]
}, { timestamps: true });

// ============ REGISTRATION ============
const registrationSchema = new mongoose.Schema({
  eventId: { type: mongoose.Schema.Types.ObjectId, ref: "Event", required: true },
  registrationId: { type: String, required: true, unique: true },
  name: { type: String, required: true, trim: true },
  phone: { type: String, required: true },
  email: { type: String, default: "" },
  college: { type: String, default: "" },
  ticketType: { type: String, required: true },
  expectedAmount: { type: Number, required: true },
  numberOfTickets: { type: Number, default: 1 },
  paymentStatus: { type: String, enum: ["awaiting_payment", "payment_verified", "amount_mismatch", "duplicate_claim", "suspicious", "manual_review", "refunded", "cancelled"], default: "awaiting_payment" },
  entryStatus: { type: String, enum: ["not_ready", "entry_approved", "entry_held", "checked_in"], default: "not_ready" },
  riskScore: { type: Number, default: 0 },
  riskReasons: [String],
  paymentId: { type: String, default: "" },
  orderId: { type: String, default: "" },
  paymentLinkId: { type: String, default: "" },
  paymentLinkUrl: { type: String, default: "" },
  utr: { type: String, default: "" },
  amountReceived: { type: Number, default: 0 },
  checkedInAt: { type: Date, default: null },
  entryToken: { type: String, default: "" }
}, { timestamps: true });

// ============ PAYMENT EVENT ============
const paymentEventSchema = new mongoose.Schema({
  eventId: { type: mongoose.Schema.Types.ObjectId, ref: "Event", required: true },
  registrationId: { type: String, default: "" },
  razorpayPaymentId: { type: String, default: "" },
  razorpayOrderId: { type: String, default: "" },
  paymentLinkId: { type: String, default: "" },
  utr: { type: String, default: "" },
  amount: { type: Number, required: true },
  currency: { type: String, default: "INR" },
  status: { type: String, enum: ["created", "authorized", "captured", "failed", "refunded", "settled"], default: "created" },
  method: { type: String, default: "" },
  contact: { type: String, default: "" },
  email: { type: String, default: "" },
  notes: { type: mongoose.Schema.Types.Mixed, default: {} },
  capturedAt: { type: Date, default: null },
  settledAt: { type: Date, default: null },
  refundedAt: { type: Date, default: null },
  webhookEventId: { type: String, default: "" },
  matched: { type: Boolean, default: false },
  matchConfidence: { type: Number, default: 0 }
}, { timestamps: true });

// ============ RISK QUEUE ============
const riskQueueSchema = new mongoose.Schema({
  eventId: { type: mongoose.Schema.Types.ObjectId, ref: "Event", required: true },
  registrationId: { type: String, required: true },
  type: { type: String, enum: ["duplicate_utr", "amount_mismatch", "payment_not_found", "reused_payment", "refund_conflict", "timing_anomaly", "repeated_suspicious"], required: true },
  severity: { type: String, enum: ["low", "medium", "high", "critical"], default: "medium" },
  details: { type: mongoose.Schema.Types.Mixed, default: {} },
  status: { type: String, enum: ["open", "reviewing", "resolved", "dismissed"], default: "open" },
  resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  resolution: { type: String, default: "" }
}, { timestamps: true });

// ============ MESSAGE LOG ============
const messageLogSchema = new mongoose.Schema({
  eventId: { type: mongoose.Schema.Types.ObjectId, ref: "Event", required: true },
  registrationId: { type: String, default: "" },
  messageType: { type: String, enum: ["payment_verified", "payment_pending", "amount_mismatch", "suspicious", "entry_approved", "entry_held", "custom"], required: true },
  content: { type: String, required: true },
  channel: { type: String, enum: ["email", "sms", "in_app"], default: "in_app" },
  status: { type: String, enum: ["draft", "sent", "failed"], default: "draft" },
  sentAt: { type: Date, default: null }
}, { timestamps: true });

// ============ AUDIT LOG ============
const auditLogSchema = new mongoose.Schema({
  eventId: { type: mongoose.Schema.Types.ObjectId, ref: "Event" },
  actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  actorRole: { type: String, default: "" },
  action: { type: String, required: true },
  target: { type: String, default: "" },
  before: { type: mongoose.Schema.Types.Mixed, default: null },
  after: { type: mongoose.Schema.Types.Mixed, default: null },
  reason: { type: String, default: "" },
  prevHash: { type: String, default: "" },
  hash: { type: String, default: "" }
}, { timestamps: true });

export const User = mongoose.model("User", userSchema);
export const Event = mongoose.model("Event", eventSchema);
export const Registration = mongoose.model("Registration", registrationSchema);
export const PaymentEvent = mongoose.model("PaymentEvent", paymentEventSchema);
export const RiskQueue = mongoose.model("RiskQueue", riskQueueSchema);
export const MessageLog = mongoose.model("MessageLog", messageLogSchema);
export const AuditLog = mongoose.model("AuditLog", auditLogSchema);
