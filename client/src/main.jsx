import React, { useEffect, useState, useCallback, createContext, useContext } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";

// ============ API ============
function getToken() { return localStorage.getItem("ep_token"); }
function setToken(t) { localStorage.setItem("ep_token", t); }
function clearToken() { localStorage.removeItem("ep_token"); }
async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...opts.headers };
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(path, { ...opts, headers });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}
const money = v => `₹${Number(v || 0).toLocaleString("en-IN")}`;

// EventPay Sentinel icon language: original SVG marks for trust, payment, risk and entry.
function SentinelIcon({ type = "sentinel", size = 24 }) {
  const paths = {
    sentinel: <><path d="M12 2.5 19 5v5.2c0 4.5-2.8 8.2-7 10.3-4.2-2.1-7-5.8-7-10.3V5l7-2.5Z" /><path d="m9 12 2 2 4-4" /></>,
    intake: <><rect x="5" y="3.5" width="14" height="17" rx="2" /><path d="M9 3.5v-1h6v1M8 9h8M8 13h5M8 17h3" /></>,
    payment: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 9h18M7 14h3" /><path d="M16 12v4M14 14h4" /></>,
    risk: <><path d="m12 3 9 16H3L12 3Z" /><path d="M12 9v4M12 16h.01" /></>,
    command: <><path d="M4 19V5M4 19h16" /><path d="m7 15 3-4 3 2 5-7" /></>,
    entry: <><path d="M5 4h14v16H5z" /><path d="M8 8h8M8 12h8M8 16h4" /><path d="m16 14 2 2-2 2" /></>,
    ai: <><rect x="5" y="6" width="14" height="13" rx="3" /><path d="M9 11h.01M15 11h.01M9 15c1.5 1 4.5 1 6 0M12 6V3M9 3h6" /></>,
    messages: <><path d="M4 5h16v11H8l-4 4V5Z" /><path d="M8 9h8M8 12h5" /></>,
    reconciliation: <><path d="M12 3v18M16 7.5c0-1.5-1.7-2.5-4-2.5s-4 1-4 2.5 1.7 2.5 4 2.5 4 1 4 2.5-1.7 2.5-4 2.5-4-1-4-2.5" /></>,
    audit: <><path d="M6 3h9l3 3v15H6z" /><path d="M15 3v4h3M9 11h6M9 15h6M9 19h3" /></>
  };
  return <svg className={`sentinel-icon icon-${type}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[type] || paths.sentinel}</svg>;
}

// ============ CONTEXT ============
const AuthCtx = createContext(null);
const useAuth = () => useContext(AuthCtx);

// ============ GOOGLE CLIENT ID ============
const GOOGLE_CLIENT_ID = "538833309030-4gjr4t71dv9h8aififqjdl7umg6spc3g.apps.googleusercontent.com";

// ============ APP ============
function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState("landing");

  useEffect(() => {
    if (!getToken()) { setLoading(false); return; }
    api("/api/auth/me").then(d => { setUser(d.user); setPage("events"); }).catch(() => clearToken()).finally(() => setLoading(false));
  }, []);

  const handleGoogleAuth = async (credential, accessToken) => {
    const d = await api("/api/auth/google", { method: "POST", body: JSON.stringify({ credential, accessToken }) });
    setToken(d.token);
    setUser(d.user);
    setPage("events");
  };
  const logout = () => { clearToken(); setUser(null); setPage("landing"); };

  if (loading) return <div className="load-screen"><div className="loader-icon">⚡</div><p>EventPay Sentinel</p></div>;

  return <AuthCtx.Provider value={{ user, logout }}>
    {page === "landing" && <Landing onSignIn={() => setPage("signin")} />}
    {page === "signin" && <GoogleSignIn onAuth={handleGoogleAuth} onBack={() => setPage("landing")} />}
    {page === "events" && <EventsApp />}
  </AuthCtx.Provider>;
}

// ============ LANDING ============
function Landing({ onSignIn }) {
  return <div className="landing">
    <header className="l-header"><div className="l-brand"><span className="brand-mark"><SentinelIcon size={17} /></span> EventPay Sentinel</div><div className="l-nav"><button className="btn-primary" onClick={onSignIn}>Sign in with Google</button></div></header>
    <section className="hero"><h1>Real-time payment truth for mass events</h1><p>Connect registrations, Razorpay payments, fraud detection, and participant entry in one trusted command center. Never trust a screenshot again.</p><button className="btn-primary btn-lg" onClick={onSignIn}>Get Started with Google →</button></section>
    <section className="features"><h2>How it works</h2><div className="f-grid">
       <div className="f-card"><span className="feature-icon"><SentinelIcon type="intake" /></span><h3>Registration Intake</h3><p>Google Forms → auto-creates registrations with unique IDs and payment links</p></div>
       <div className="f-card"><span className="feature-icon"><SentinelIcon type="payment" /></span><h3>Razorpay Verification</h3><p>Webhooks verify payments cryptographically. No screenshots needed.</p></div>
       <div className="f-card"><span className="feature-icon"><SentinelIcon type="risk" /></span><h3>Risk Engine</h3><p>Detects duplicate UTRs, amount mismatches, reused payments instantly</p></div>
       <div className="f-card"><span className="feature-icon"><SentinelIcon type="command" /></span><h3>Command Center</h3><p>Live dashboard: verified, pending, suspicious, held — all in real-time</p></div>
       <div className="f-card"><span className="feature-icon"><SentinelIcon type="entry" /></span><h3>QR Entry Pass</h3><p>Verified participants get QR codes. Volunteers scan at the gate.</p></div>
       <div className="f-card"><span className="feature-icon"><SentinelIcon type="ai" /></span><h3>AI Investigation</h3><p>Ask "Why is this payment pending?" and get evidence-backed answers</p></div>
    </div></section>
    <section className="differentiator"><h2>Why FormPay is different</h2><div className="diff-box"><p className="diff-main">Razorpay confirms that a payment happened.</p><p className="diff-main accent">FormPay confirms <em>which participant</em> owns that payment and whether they can safely enter the event.</p><div className="diff-flow"><span>Google Form</span><span>→</span><span>Auto Payment Link</span><span>→</span><span>Cryptographic Verification</span><span>→</span><span>Fraud Detection</span><span>→</span><span>Safe Entry</span></div></div></section>
    <footer className="l-footer"><p>Built for India's high-volume events · Razorpay-powered · Real-time verification</p></footer>
  </div>;
}

// ============ GOOGLE SIGN IN ============
function GoogleSignIn({ onAuth, onBack }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingCredential, setPendingCredential] = useState("");
  const btnRef = React.useRef(null);

  useEffect(() => {
    // Wait for Google GSI script to load
    const initGoogle = () => {
      if (!window.google?.accounts?.id) {
        setTimeout(initGoogle, 200);
        return;
      }
      window.google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: async (response) => {
          setBusy(true);
          setError("");
          try {
            // First get the ID token for auth
            const credential = response.credential;
            setPendingCredential(credential);
            // Request the Forms permission while the credential is fresh.
            await requestAccessToken(credential);
          } catch (e) {
            setError(e.message || "Google sign-in failed");
          }
          setBusy(false);
        }
      });
      if (btnRef.current) {
        window.google.accounts.id.renderButton(btnRef.current, {
          theme: "outline",
          size: "large",
          width: 320,
          text: "signin_with",
          shape: "rectangular"
        });
      }
    };
    initGoogle();
  }, []);

  const requestAccessToken = (idCredential) => {
    return new Promise((resolve, reject) => {
      if (!window.google?.accounts?.oauth2) {
        reject(new Error("Google Forms permission is unavailable in this browser. Please enable popups and try again."));
        return;
      }
      const tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope: "https://www.googleapis.com/auth/forms.body.readonly",
        prompt: "consent",
        callback: async (tokenResponse) => {
          if (tokenResponse.error) {
              reject(new Error("Google Forms permission was not granted. Please approve the permission request to import this form."));
              return;
          }
          try {
            await onAuth(idCredential, tokenResponse.access_token);
            resolve();
          } catch (e) { reject(e); }
        },
        error_callback: () => {
          reject(new Error("The Google permission window was blocked. Enable popups for this preview, then click Grant Google Forms access."));
        }
      });
      tokenClient.requestAccessToken();
    });
  };

  return <div className="auth-page"><div className="auth-card">
    <button className="back-link" onClick={onBack}>← Back</button>
    <h1>Sign In</h1>
    <p>Access your event command center</p>
    <div className="google-btn-wrap">
      <div ref={btnRef} />
      {busy && <p className="loading-text">Signing you in...</p>}
    </div>
    {pendingCredential && !busy && <button className="btn-primary btn-full grant-forms-btn" onClick={async () => {
      setBusy(true); setError("");
      try { await requestAccessToken(pendingCredential); } catch (e) { setError(e.message || "Google Forms permission failed"); }
      setBusy(false);
    }}>Grant Google Forms access</button>}
    {error && <div className="err">{error}</div>}
    <p className="auth-note">Sign in with Google and approve Forms access so EventPay can read restricted form structure. No password needed.</p>
  </div></div>;
}

// ============ EVENTS APP ============
function EventsApp() {
  const { user, logout } = useAuth();
  const [events, setEvents] = useState([]);
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [view, setView] = useState("dashboard");
  const [toast, setToast] = useState("");
  const [editingEvent, setEditingEvent] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const notify = m => { setToast(m); setTimeout(() => setToast(""), 3000); };

  useEffect(() => { api("/api/events").then(setEvents).catch(e => notify(e.message)); }, []);

  const deleteEvent = async (id) => {
    try {
      await api(`/api/events/${id}`, { method: "DELETE" });
      setEvents(p => p.filter(e => e._id !== id));
      setDeleteConfirm(null);
      notify("Event deleted");
    } catch (e) { notify(e.message); }
  };

  const updateEvent = async (id, data) => {
    try {
      const updated = await api(`/api/events/${id}`, { method: "PUT", body: JSON.stringify(data) });
      setEvents(p => p.map(e => e._id === id ? updated : e));
      setEditingEvent(null);
      notify("Event updated!");
    } catch (e) { notify(e.message); }
  };

  if (selectedEvent) return <EventDashboard event={selectedEvent} view={view} setView={setView} onBack={() => { setSelectedEvent(null); setView("dashboard"); }} notify={notify} toast={toast} />;

  return <div className="app-shell">
    <header className="app-header"><div className="app-brand"><span className="brand-mark"><SentinelIcon size={17} /></span> EventPay Sentinel</div><div className="app-user"><span>{user?.name}</span><small>{user?.role}</small><button className="btn-ghost btn-sm" onClick={logout}>Logout</button></div></header>
    <main className="events-page">
      <div className="workspace-intro">
        <div>
          <span className="eyebrow">EVENT OPERATIONS</span>
          <h1>Your events</h1>
          <p>Choose an event to see payment health, fraud alerts, and who is ready to enter.</p>
        </div>
        <CreateEventBtn onCreated={ev => { setEvents(p => [ev, ...p]); notify("Event created!"); }} />
      </div>
      {events.length ? <div className="events-grid">{events.map(ev => <div key={ev._id} className="event-card">
        <div className="ec-main" onClick={() => { setSelectedEvent(ev); setView("dashboard"); }}>
          <h3>{ev.name}</h3>
          <p>{new Date(ev.eventDate).toLocaleDateString("en-IN")}</p>
          {ev.organizerId?.name && ev.organizerId._id !== user?.id && <p className="ec-owner">by {ev.organizerId.name}</p>}
          <div className="ec-cats">{ev.ticketTypes?.map((t, i) => <span key={i} className="cat-mini">{t.name} ₹{t.price}</span>)}</div>
          <span className={`badge badge-${ev.status}`}>{ev.status}</span>
        </div>
        <div className="ec-actions">
          {(!ev.organizerId?._id || ev.organizerId._id === user?.id) && <><button className="btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); setEditingEvent(ev); }}>Edit</button>
          <button className="btn-ghost btn-sm btn-danger" onClick={(e) => { e.stopPropagation(); setDeleteConfirm(ev); }}>Delete</button></>}
          {ev.organizerId?._id && ev.organizerId._id !== user?.id && <span className="shared-badge">Shared with you</span>}
        </div>
      </div>)}</div> : <p className="empty">No events yet. Create your first event to get started.</p>}
    </main>
    {toast && <div className="toast">{toast}</div>}

    {/* Edit Event Modal */}
    {editingEvent && <EditEventModal event={editingEvent} onSave={updateEvent} onClose={() => setEditingEvent(null)} />}

    {/* Delete Confirmation */}
    {deleteConfirm && <Modal title="Delete Event" onClose={() => setDeleteConfirm(null)}>
      <div className="delete-confirm">
        <p>Are you sure you want to delete <strong>"{deleteConfirm.name}"</strong>?</p>
        <p className="delete-warning">This will permanently delete all registrations, payments, risk queue items, messages, and audit logs associated with this event. This cannot be undone.</p>
        <div className="m-actions">
          <button className="btn-ghost" onClick={() => setDeleteConfirm(null)}>Cancel</button>
          <button className="btn-danger-fill" onClick={() => deleteEvent(deleteConfirm._id)}>Yes, Delete Event</button>
        </div>
      </div>
    </Modal>}
  </div>;
}

// ============ EDIT EVENT MODAL ============
function EditEventModal({ event, onSave, onClose }) {
  const [form, setForm] = useState({
    name: event.name || "",
    eventDate: event.eventDate ? new Date(event.eventDate).toISOString().split("T")[0] : "",
    categories: event.ticketTypes?.map(t => ({ name: t.name, price: t.price })) || [{ name: "General", price: 500 }]
  });
  const [busy, setBusy] = useState(false);

  const addCategory = () => setForm(f => ({ ...f, categories: [...f.categories, { name: "", price: 0 }] }));
  const updateCategory = (i, k, v) => setForm(f => ({ ...f, categories: f.categories.map((c, idx) => idx === i ? { ...c, [k]: v } : c) }));
  const removeCategory = (i) => { if (form.categories[i].name === "General") return; setForm(f => ({ ...f, categories: f.categories.filter((_, idx) => idx !== i) })); };

  const submit = async (e) => {
    e.preventDefault(); setBusy(true);
    await onSave(event._id, {
      name: form.name,
      eventDate: form.eventDate,
      ticketTypes: form.categories.filter(c => c.name.trim()).map(c => ({ name: c.name.trim(), price: Number(c.price), capacity: 9999 }))
    });
    setBusy(false);
  };

  return <Modal title="Edit Event" onClose={onClose}><form onSubmit={submit} className="m-form">
    <label>Event name *<input value={form.name} onChange={e => setForm({...form, name: e.target.value})} required /></label>
    <label>Event date *<input type="date" value={form.eventDate} onChange={e => setForm({...form, eventDate: e.target.value})} required /></label>
    <div className="tickets-section">
      <strong>Pricing Categories</strong>
      <div className="naming-warning">Changing category names? Make sure your Google Form dropdown options still match exactly.</div>
      {form.categories.map((c, i) => <div key={i} className="ticket-row">
        <input placeholder="Category name" value={c.name} onChange={e => updateCategory(i, "name", e.target.value)} disabled={c.name === "General" && i === 0} />
        <input type="number" placeholder="₹ Price" value={c.price} onChange={e => updateCategory(i, "price", e.target.value)} />
        <button type="button" className="btn-sm btn-ghost" onClick={() => removeCategory(i)} disabled={c.name === "General" && i === 0}>✕</button>
      </div>)}
      <button type="button" className="btn-ghost btn-sm" onClick={addCategory}>+ Add category</button>
    </div>
    <div className="m-actions">
      <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
      <button className="btn-primary" disabled={busy}>{busy ? "Saving..." : "Save Changes"}</button>
    </div>
  </form></Modal>;
}

function CreateEventBtn({ onCreated }) {
  const [show, setShow] = useState(false);
  const [step, setStep] = useState(1); // 1: Event Details, 2: Payment Setup, 3: Google Form, 4: AI Verification
  const [form, setForm] = useState({ name: "", eventDate: "", categories: [{ name: "General", price: 500 }, { name: "Student", price: 500 }, { name: "Member", price: 300 }, { name: "Teacher", price: 1000 }], razorpayKeyId: "", razorpayKeySecret: "" });
  const [busy, setBusy] = useState(false);
  const [createdEvent, setCreatedEvent] = useState(null);
  const [copied, setCopied] = useState("");
  const [aiCheck, setAiCheck] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [formUrl, setFormUrl] = useState("");
  const [formAnalysis, setFormAnalysis] = useState(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState("");

  const addCategory = () => setForm(f => ({ ...f, categories: [...f.categories, { name: "", price: 0 }] }));
  const updateCategory = (i, k, v) => setForm(f => ({ ...f, categories: f.categories.map((c, idx) => idx === i ? { ...c, [k]: v } : c) }));
  const removeCategory = (i) => { if (form.categories[i].name === "General") return; setForm(f => ({ ...f, categories: f.categories.filter((_, idx) => idx !== i) })); };

  const copyText = (text, label) => {
    navigator.clipboard.writeText(text).then(() => { setCopied(label); setTimeout(() => setCopied(""), 2000); }).catch(() => {});
  };

  const submitEvent = async () => {
    if (!form.name || !form.eventDate) return;
    setBusy(true);
    try {
      const ev = await api("/api/events", { method: "POST", body: JSON.stringify({ name: form.name, eventDate: form.eventDate, ticketTypes: form.categories.filter(c => c.name.trim()).map(c => ({ name: c.name.trim(), price: Number(c.price), capacity: 9999 })), razorpayKeyId: form.razorpayKeyId, razorpayKeySecret: form.razorpayKeySecret }) });
      setCreatedEvent(ev);
      setStep(3);
    } catch (e) { alert(e.message); }
    setBusy(false);
  };

  const analyzeForm = async () => {
    if (!formUrl.trim()) { setAnalyzeError("Please paste your Google Form URL"); return; }
    setAnalyzing(true);
    setAnalyzeError("");
    setFormAnalysis(null);
    try {
      const result = await api(`/api/events/${createdEvent._id}/analyze-form`, { method: "POST", body: JSON.stringify({ formUrl: formUrl.trim() }) });
      setFormAnalysis(result);
    } catch (e) {
      setAnalyzeError(e.message);
    }
    setAnalyzing(false);
  };

  const runAiCheck = async () => {
    setAiLoading(true);
    setAiCheck(null);
    try {
      const result = await api(`/api/events/${createdEvent._id}/verify-setup`, { method: "POST" });
      setAiCheck(result);
    } catch (e) {
      setAiCheck({ checks: [{ ok: false, label: "Verification Error", msg: e.message }], passed: 0, total: 1, allGood: false });
    }
    setAiLoading(false);
  };

  const finish = () => {
    if (createdEvent) onCreated(createdEvent);
    setShow(false);
    setStep(1);
    setCreatedEvent(null);
    setAiCheck(null);
    setFormUrl("");
    setFormAnalysis(null);
    setAnalyzeError("");
    setForm({ name: "", eventDate: "", categories: [{ name: "General", price: 500 }, { name: "Student", price: 500 }, { name: "Member", price: 300 }, { name: "Teacher", price: 1000 }], razorpayKeyId: "", razorpayKeySecret: "" });
  };

  if (!show) return <button className="btn-primary" onClick={() => setShow(true)}>+ Create Event</button>;

  return <Modal title={step === 1 ? "Create Event" : step === 2 ? "Payment Setup" : step === 3 ? "Connect Google Form" : "AI Setup Verification"} onClose={() => { setShow(false); setStep(1); setCreatedEvent(null); setAiCheck(null); }}>
    {/* Step indicator */}
    <div className="wizard-steps">
      <div className={`ws ${step >= 1 ? "ws-active" : ""}`}><span>1</span> Event</div>
      <div className="ws-line" />
      <div className={`ws ${step >= 2 ? "ws-active" : ""}`}><span>2</span> Payment</div>
      <div className="ws-line" />
      <div className={`ws ${step >= 3 ? "ws-active" : ""}`}><span>3</span> Google Form</div>
      <div className="ws-line" />
      <div className={`ws ${step >= 4 ? "ws-active" : ""}`}><span>4</span> Verify</div>
    </div>

    {/* STEP 1: Event Details */}
    {step === 1 && <div className="m-form">
      <label>Event name *<input value={form.name} onChange={e => setForm({...form, name: e.target.value})} required placeholder="e.g. College Fest 2026" /></label>
      <label>Event date *<input type="date" value={form.eventDate} onChange={e => setForm({...form, eventDate: e.target.value})} required /></label>
      <div className="tickets-section">
        <strong>Pricing Categories</strong>
        <div className="naming-warning">The category names here must <strong>exactly match</strong> the options in your Google Form's dropdown/radio field. For example, if your form has "Student" as an option, type "Student" here — not "student" or "Students".</div>
        <p className="section-hint">If a participant doesn't select a category, "General" will be used as the default.</p>
        {form.categories.map((c, i) => <div key={i} className="ticket-row">
          <input placeholder="Category name" value={c.name} onChange={e => updateCategory(i, "name", e.target.value)} disabled={c.name === "General" && i === 0} />
          <input type="number" placeholder="₹ Price" value={c.price} onChange={e => updateCategory(i, "price", e.target.value)} />
          <button type="button" className="btn-sm btn-ghost" onClick={() => removeCategory(i)} disabled={c.name === "General" && i === 0} title={c.name === "General" ? "Default category cannot be removed" : "Remove"}>✕</button>
        </div>)}
        <button type="button" className="btn-ghost btn-sm" onClick={addCategory}>+ Add category</button>
      </div>
      <div className="m-actions">
        <button type="button" className="btn-ghost" onClick={() => { setShow(false); setStep(1); }}>Cancel</button>
        <button type="button" className="btn-primary" disabled={!form.name || !form.eventDate} onClick={() => setStep(2)}>Next: Payment Setup →</button>
      </div>
    </div>}

    {/* STEP 2: Payment Setup */}
    {step === 2 && <div className="m-form wizard-form-step">
      <div className="setup-section compact">
        <h3>Connect your Razorpay account</h3>
        <p className="section-hint">Payments from participants will go directly to YOUR Razorpay account. Your keys are stored securely and only used for this event.</p>
        <div className="razorpay-guide">
          <div className="steps-list compact-steps">
            <div className="step"><span className="step-num">1</span><div><strong>Create a Razorpay account</strong><p>Go to <a href="https://dashboard.razorpay.com/signup" target="_blank" rel="noopener noreferrer">dashboard.razorpay.com</a> and sign up (free)</p></div></div>
            <div className="step"><span className="step-num">2</span><div><strong>Select "WhatsApp, SMS, or Email"</strong><p>When asked "Accept Payments on", choose <strong>"WhatsApp, SMS, or Email"</strong> — this is how payment links are sent to participants</p></div></div>
            <div className="step"><span className="step-num">3</span><div><strong>Complete KYC verification</strong><p>Upload your PAN, Aadhaar/business docs as asked. This is required by RBI for accepting payments.</p></div></div>
            <div className="step"><span className="step-num">4</span><div><strong>Generate API Keys</strong><p>After KYC is approved: Dashboard → Account & Settings → API Keys → Generate Key. Copy both the Key ID and Key Secret.</p></div></div>
            <div className="step"><span className="step-num">5</span><div><strong>Paste them below</strong><p>Key ID starts with <code>rzp_test_</code> (test mode) or <code>rzp_live_</code> (real payments)</p></div></div>
          </div>
        </div>
      </div>

      <div className="setup-section compact">
        <label className="key-label">Razorpay Key ID *<input value={form.razorpayKeyId} onChange={e => setForm({...form, razorpayKeyId: e.target.value})} placeholder="rzp_test_xxxxxxxxxxxxxx" /></label>
        <label className="key-label">Razorpay Key Secret *<input type="password" value={form.razorpayKeySecret} onChange={e => setForm({...form, razorpayKeySecret: e.target.value})} placeholder="xxxxxxxxxxxxxxxxxxxxxxxx" /></label>
        <div className="key-safety-note">
          <span>🔒</span>
          <p>Your keys are encrypted and stored securely. They are only used to generate payment links for this event. We never have access to your Razorpay balance or payouts.</p>
        </div>
      </div>

      <div className="m-actions">
        <button type="button" className="btn-ghost" onClick={() => setStep(1)}>← Back</button>
        <button type="button" className="btn-primary" disabled={busy || !form.razorpayKeyId || !form.razorpayKeySecret} onClick={submitEvent}>{busy ? "Creating..." : "Create Event & Continue →"}</button>
      </div>
    </div>}

    {/* STEP 3: Google Form Setup */}
    {step === 3 && <div className="m-form wizard-form-step">
      <div className="setup-section compact">
        <h3>How to share your Google Form</h3>
        <div className="sharing-steps">
          <div className="step"><span className="step-num">1</span><div><strong>Open your Google Form</strong><p>Go to the form you want to connect</p></div></div>
          <div className="step"><span className="step-num">2</span><div><strong>Check Settings</strong><p>Click ⚙️ Settings → uncheck <strong>"Restrict to users in [your organization]"</strong> so the form is publicly accessible</p></div></div>
          <div className="step"><span className="step-num">3</span><div><strong>Copy the link</strong><p>Click <strong>Send</strong> button → click the 🔗 link icon → copy the URL. Or just copy from the browser address bar (both work!)</p></div></div>
        </div>
      </div>

      <div className="setup-section compact">
        <h3>Paste your Google Form link</h3>
        <p className="section-hint">We'll auto-detect your form fields using AI. Both /edit and respondent links work — we handle the conversion.</p>
        <div className="form-url-input">
          <input value={formUrl} onChange={e => setFormUrl(e.target.value)} placeholder="https://docs.google.com/forms/d/..." className="url-input" />
          <button className="btn-primary" onClick={analyzeForm} disabled={analyzing}>{analyzing ? "Analyzing..." : "Analyze Form"}</button>
        </div>
        {analyzeError && <div className="err">{analyzeError}</div>}
      </div>

      {analyzing && <div className="setup-section compact"><div className="ai-loading"><div className="loader-icon small">⚡</div><p>AI is reading your Google Form and mapping fields...</p></div></div>}

      {formAnalysis && <>
        <div className="setup-section compact">
          <h3>AI Field Mapping</h3>
          <p className="section-hint">{formAnalysis.summary}</p>
          <div className="field-mapping-list">
            {formAnalysis.fieldMapping?.fields?.map((f, i) => <div key={i} className={`fm-item ${f.mappedTo !== "other" ? "fm-mapped" : ""}`}>
              <span className="fm-idx">#{f.index}</span>
              <span className="fm-label">{f.label}</span>
              <span className={`fm-badge fm-${f.mappedTo}`}>{f.mappedTo === "other" ? "skipped" : `→ ${f.mappedTo}`}</span>
              <span className={`fm-conf fm-conf-${f.confidence}`}>{f.confidence}</span>
            </div>)}
          </div>
          {formAnalysis.warnings?.length > 0 && <div className="fm-warnings">{formAnalysis.warnings.map((w, i) => <p key={i} className="fm-warn-item">⚠ {w}</p>)}</div>}
        </div>

        <div className="setup-section compact">
          <h3>Setup in 3 clicks:</h3>
          <div className="steps-list compact-steps">
            <div className="step"><span className="step-num">1</span><div><strong>Open Apps Script</strong><p>In your Google Form → ⋮ Menu → Script editor (or Extensions → Apps Script)</p></div></div>
            <div className="step"><span className="step-num">2</span><div><strong>Paste the script below</strong><p>Delete any existing code, paste, and save (Ctrl+S)</p></div></div>
            <div className="step"><span className="step-num">3</span><div><strong>Run setupTrigger once</strong><p>Select <code>setupTrigger</code> from dropdown → click ▶ Run → Authorize when prompted</p></div></div>
          </div>
        </div>

        <div className="setup-section compact">
          <div className="code-block">
            <div className="code-header"><span>Auto-Generated Apps Script</span><button className="btn-primary btn-sm" onClick={() => copyText(formAnalysis.appsScript, "script")}>{copied === "script" ? "Copied!" : "Copy Script"}</button></div>
            <pre>{formAnalysis.appsScript}</pre>
          </div>
        </div>
      </>}

      <div className="m-actions">
        <button type="button" className="btn-ghost" onClick={() => setStep(2)}>← Back</button>
        <button type="button" className="btn-primary" disabled={!formAnalysis} onClick={() => { setStep(4); runAiCheck(); }}>Verify Setup →</button>
      </div>
    </div>}

    {/* STEP 4: AI Verification */}
    {step === 4 && <div className="m-form wizard-form-step">
      <div className="ai-verify-section">
        <h3>Live Setup Verification</h3>
        <p className="section-hint">Testing your entire pipeline: Google Form intake → Razorpay payment link → verification...</p>
        
        {aiLoading && <div className="ai-loading"><div className="loader-icon small">⚡</div><p>Running real tests against your setup...</p></div>}
        
        {aiCheck && <div className="ai-checks">
          <div className="checks-summary">{aiCheck.passed}/{aiCheck.total} checks passed</div>
          {aiCheck.checks.map((c, i) => <div key={i} className={`ai-check-item ${c.ok ? "check-pass" : "check-warn"}`}>
            <span className="check-icon">{c.ok ? "✓" : "⚠"}</span>
            <div className="check-content">
              <strong className="check-label">{c.label}</strong>
              <span>{c.msg}</span>
            </div>
          </div>)}
          {aiCheck.testPaymentLink && <div className="test-link-box">
            <strong>Test Payment Link Generated:</strong>
            <a href={aiCheck.testPaymentLink} target="_blank" rel="noopener noreferrer">{aiCheck.testPaymentLink}</a>
            <small>(This test link was auto-cancelled — no real payment will be taken)</small>
          </div>}
          <div className={`ai-verdict ${aiCheck.allGood ? "verdict-good" : "verdict-warn"}`}>
            {aiCheck.allGood 
              ? "All systems go! Your Google Form → Razorpay payment pipeline is working end-to-end." 
              : "Some issues detected. Review the warnings above — you can still proceed but some features may not work."}
          </div>
          {aiCheck.aiAnalysis && <div className="ai-analysis-section">
            <h4>AI Analysis</h4>
            <pre className="ai-analysis-text">{aiCheck.aiAnalysis}</pre>
          </div>}
        </div>}
      </div>

      <div className="m-actions">
        <button type="button" className="btn-ghost" onClick={() => setStep(3)}>← Back</button>
        {aiCheck && !aiLoading && <button type="button" className="btn-ghost" onClick={runAiCheck}>Re-run checks</button>}
        <button type="button" className="btn-primary" onClick={finish}>Done — Go to Event →</button>
      </div>
    </div>}
  </Modal>;
}

// ============ EVENT DASHBOARD ============
function EventDashboard({ event, view, setView, onBack, notify, toast }) {
  const { user } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [metrics, setMetrics] = useState({});
  const [regs, setRegs] = useState([]);
  const [risks, setRisks] = useState([]);
  const [messages, setMessages] = useState([]);

  const loadData = useCallback(async () => {
    try {
      const [m, r, rk, msgs] = await Promise.all([
        api(`/api/events/${event._id}/metrics`),
        api(`/api/events/${event._id}/registrations?pageSize=100`),
        api(`/api/events/${event._id}/risk-queue`),
        api(`/api/events/${event._id}/messages`)
      ]);
      setMetrics(m); setRegs(r.data || r); setRisks(rk); setMessages(msgs);
    } catch (e) { notify(e.message); }
  }, [event._id]);
  useEffect(() => { loadData(); }, [loadData]);

  const navItems = [
    ["dashboard", "command", "Command Center"],
    ["registrations", "intake", "Registrations"],
    ["risk", "risk", "Risk Queue"],
    ["sharing", "entry", "Share Access"],
    ["ai", "ai", "AI Investigate"],
    ["messages", "messages", "Messages"],
    ["reconciliation", "reconciliation", "Reconciliation"],
    ["audit", "audit", "Audit Log"]
  ];

  return <div className={`app-shell dashboard-shell ${mobileOpen ? "menu-open" : ""}`}>
    <div className="mobile-scrim" onClick={() => setMobileOpen(false)} />
    <aside className="sidebar">
      <div className="sb-header"><button className="back-link" onClick={onBack}>← Events</button><h3>{event.name}</h3><small>{event.venue} · {new Date(event.eventDate).toLocaleDateString("en-IN")}</small></div>
       <nav>{navItems.map(([key, icon, label]) => <button data-nav={key} key={key} className={view === key ? "active" : ""} onClick={() => { setView(key); setMobileOpen(false); }}><span><SentinelIcon type={icon} size={17} /></span>{label}</button>)}</nav>
      <div className="sb-footer"><span>{user?.name}</span><small>{user?.role}</small></div>
    </aside>
    <main className="main-view">
       <div className="mobile-topbar"><button className="menu-toggle" onClick={() => setMobileOpen(true)} aria-label="Open navigation">☰</button><span>{event.name}</span><span className="live-dot">● Live</span></div>
      {view === "dashboard" && <CommandCenter metrics={metrics} regs={regs} risks={risks} event={event} notify={notify} reload={loadData} />}
      {view === "registrations" && <Registrations event={event} regs={regs} notify={notify} reload={loadData} />}
      {view === "risk" && <RiskQueueView event={event} risks={risks} regs={regs} notify={notify} reload={loadData} />}
      {view === "sharing" && <ShareAccess event={event} notify={notify} />}
      {view === "ai" && <AIInvestigate event={event} notify={notify} />}
      {view === "messages" && <Messages event={event} messages={messages} notify={notify} reload={loadData} />}
      {view === "reconciliation" && <Reconciliation event={event} notify={notify} />}
      {view === "audit" && <AuditLogView event={event} />}
    </main>
    <nav className="mobile-bottom-nav" aria-label="Mobile dashboard navigation">
      {[["dashboard", "command", "Home"], ["registrations", "intake", "Registrations"], ["risk", "risk", "Risk"], ["sharing", "entry", "Share"]].map(([key, icon, label]) =>
        <button key={key} className={view === key ? "active" : ""} onClick={() => setView(key)}>
          <SentinelIcon type={icon} size={21} /><span>{label}</span>
        </button>
      )}
      <button className={mobileOpen ? "active" : ""} onClick={() => setMobileOpen(true)}>
        <span className="more-dots"><i /><i /><i /></span><span>More</span>
      </button>
    </nav>
    {toast && <div className="toast">{toast}</div>}
  </div>;
}

// ============ COMMAND CENTER ============
function CommandCenter({ metrics, regs, risks, event, notify, reload }) {
  const m = metrics;
  const [demoLoading, setDemoLoading] = useState(false);
  const [sseStatus, setSseStatus] = useState("disconnected");

  // SSE real-time connection
  useEffect(() => {
    const token = getToken();
    if (!token || !event?._id) return;
    const es = new EventSource(`/api/events/${event._id}/stream?token=${token}`);
    es.onopen = () => setSseStatus("live");
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type !== "connected") reload();
      } catch {}
    };
    es.onerror = () => setSseStatus("reconnecting");
    return () => es.close();
  }, [event?._id]);

  const seedDemo = async () => {
    setDemoLoading(true);
    try {
      const result = await api(`/api/events/${event._id}/demo-seed`, { method: "POST" });
      notify(result.message);
      reload();
    } catch (e) { notify(e.message); }
    setDemoLoading(false);
  };
  const resetDemo = async () => {
    if (!confirm("This will delete ALL registrations, payments, and risk data for this event. Continue?")) return;
    try {
      await api(`/api/events/${event._id}/demo-reset`, { method: "POST" });
      notify("Demo data cleared");
      reload();
    } catch (e) { notify(e.message); }
  };
  const exportReport = () => { window.open(`/api/events/${event._id}/export/report?token=${getToken()}`, "_blank"); };

  return <div className="page">
      <div className="page-head">
      <div>
        <span className="eyebrow">LIVE EVENT PULSE</span>
        <h1>Command Center</h1>
        <p className="page-subtitle">A clear view of payment truth and entry readiness for {event.name}.</p>
      </div>
      <div className="cmd-actions">
        <span className={`live-indicator ${sseStatus}`}>{sseStatus === "live" ? "● Live" : "○ " + sseStatus}</span>
        <button className="btn-ghost btn-sm" onClick={reload}>↻ Refresh</button>
        <button className="btn-ghost btn-sm" onClick={seedDemo} disabled={demoLoading}>{demoLoading ? "Seeding..." : "Demo Data"}</button>
        <button className="btn-ghost btn-sm btn-danger" onClick={resetDemo}>Reset</button>
        <button className="btn-ghost btn-sm" onClick={exportReport}>Export Report</button>
      </div>
    </div>
    <div className="metrics-grid">
      <div className="m-card"><span className="m-icon">◎</span><span className="m-num">{m.totalRegs || 0}</span><span className="m-label">People registered</span><span className="m-help">All event sign-ups</span></div>
      <div className="m-card green"><span className="m-icon">✓</span><span className="m-num">{m.verified || 0}</span><span className="m-label">Ready to enter</span><span className="m-help">Payment confirmed</span></div>
      <div className="m-card yellow"><span className="m-icon">◷</span><span className="m-num">{m.awaiting || 0}</span><span className="m-label">Waiting for payment</span><span className="m-help">Follow up needed</span></div>
      <div className="m-card red"><span className="m-icon">!</span><span className="m-num">{(m.riskCount || 0)}</span><span className="m-label">Need your attention</span><span className="m-help">Open risk cases</span></div>
    </div>
    <div className="command-insight">
      <div className="insight-mark">!</div>
      <div><strong>{m.riskCount ? `${m.riskCount} case${m.riskCount === 1 ? "" : "s"} need review` : "No urgent payment issues"}</strong><p>{m.riskCount ? "Review the evidence before approving entry. Suspicious cases stay safely on hold." : "Your payment records are clear. Keep an eye on the live feed as registrations arrive."}</p></div>
      <button className="btn-ghost btn-sm" onClick={() => document.querySelector('[data-nav="risk"]')?.click()}>Open risk queue →</button>
    </div>
    <div className="finance-row">
      <div className="fin-card"><span>Expected collection</span><strong>{money(m.expectedTotal)}</strong><small>Based on registrations</small></div>
      <div className="fin-card green"><span>Payment value verified</span><strong>{money(m.verifiedTotal)}</strong><small>Safe to count</small></div>
      <div className="fin-card yellow"><span>Still to reconcile</span><strong>{money((m.expectedTotal || 0) - (m.verifiedTotal || 0))}</strong><small>Pending or needs review</small></div>
    </div>
    <div className="dash-grid">
      <div className="card"><div className="card-heading"><div><span className="eyebrow">GATE READINESS</span><h3>Who can enter now?</h3></div><span className="card-status status-good">Live</span></div>
        <div className="entry-bar"><div className="eb-fill" style={{width: `${m.totalRegs ? (m.verified||0)/m.totalRegs*100 : 0}%`}} /><span>{m.verified || 0} / {m.totalRegs || 0} can enter</span></div>
        <p className="note">{m.awaiting || 0} need payment · {m.mismatches || 0} need review · {m.held || 0} held</p>
      </div>
      <div className="card"><div className="card-heading"><div><span className="eyebrow">ACTION REQUIRED</span><h3>Recent risk alerts</h3></div><span className="card-status status-risk">{risks.length} open</span></div>{risks.length ? risks.slice(0, 5).map(r => <div key={r._id} className="risk-item"><span className={`badge badge-${r.severity}`}>{r.severity}</span><strong>{r.registrationId}</strong><small>{r.type.replace(/_/g, " ")}</small></div>) : <p className="empty">No risk alerts. Your queue is clear.</p>}</div>
    </div>
  </div>;
}

// ============ REGISTRATIONS ============
function Registrations({ event, regs, notify, reload }) {
  const [search, setSearch] = useState(""); const [filter, setFilter] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ name: "", phone: "", email: "", college: "", ticketType: event.ticketTypes?.[0]?.name || "", numberOfTickets: 1 });

  const filtered = regs.filter(r => {
    if (filter && r.paymentStatus !== filter) return false;
    if (search) return `${r.name} ${r.phone} ${r.registrationId}`.toLowerCase().includes(search.toLowerCase());
    return true;
  });

  const addReg = async e => {
    e.preventDefault();
    try { await api(`/api/events/${event._id}/registrations`, { method: "POST", body: JSON.stringify(form) }); setShowAdd(false); notify("Registration created!"); reload(); } catch (e) { notify(e.message); }
  };

  const approve = async id => { try { await api(`/api/events/${event._id}/registrations/${id}/approve`, { method: "POST" }); notify("Approved"); reload(); } catch (e) { notify(e.message); } };
  const hold = async id => { try { await api(`/api/events/${event._id}/registrations/${id}/hold`, { method: "POST", body: JSON.stringify({ reason: "Manual hold" }) }); notify("Held"); reload(); } catch (e) { notify(e.message); } };

  return <div className="page">
    <div className="page-head"><div><span className="eyebrow">PEOPLE & PAYMENTS</span><h1>Registrations</h1><p className="page-subtitle">{regs.length} people in this event. Search by name or ID to understand any payment instantly.</p></div><button className="btn-primary" onClick={() => setShowAdd(true)}>+ Add registration</button></div>
    <div className="filters"><input className="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search name, phone, or REG ID..." /><select value={filter} onChange={e => setFilter(e.target.value)}><option value="">All statuses</option><option value="awaiting_payment">Awaiting Payment</option><option value="payment_verified">Verified</option><option value="amount_mismatch">Mismatch</option><option value="duplicate_claim">Duplicate</option><option value="suspicious">Suspicious</option><option value="manual_review">Manual Review</option></select></div>
    <div className="table-wrap"><table><thead><tr><th>REG ID</th><th>Name</th><th>Phone</th><th>Ticket</th><th>Expected</th><th>Received</th><th>Payment</th><th>Entry</th><th>Actions</th></tr></thead><tbody>
      {filtered.map(r => <tr key={r._id} className={r.riskScore >= 60 ? "row-risk" : ""}>
        <td><strong>{r.registrationId}</strong></td><td>{r.name}</td><td>{r.phone}</td><td>{r.ticketType}</td>
        <td>{money(r.expectedAmount)}</td><td>{money(r.amountReceived)}</td>
        <td><span className={`badge badge-${r.paymentStatus === "payment_verified" ? "green" : r.paymentStatus === "awaiting_payment" ? "yellow" : "red"}`}>{r.paymentStatus.replace(/_/g, " ")}</span></td>
        <td><span className={`badge badge-${r.entryStatus === "entry_approved" ? "green" : r.entryStatus === "checked_in" ? "blue" : r.entryStatus === "entry_held" ? "red" : "gray"}`}>{r.entryStatus.replace(/_/g, " ")}</span></td>
        <td className="actions">{r.entryStatus !== "entry_approved" && r.entryStatus !== "checked_in" && <button className="btn-sm btn-primary" onClick={() => approve(r.registrationId)}>✓</button>}{r.entryStatus !== "entry_held" && <button className="btn-sm btn-ghost" onClick={() => hold(r.registrationId)}>Hold</button>}</td>
      </tr>)}
    </tbody></table>{!filtered.length && <p className="empty">No registrations match</p>}</div>
    {showAdd && <Modal title="Add Registration" onClose={() => setShowAdd(false)}><form onSubmit={addReg} className="m-form">
      <label>Name *<input value={form.name} onChange={e => setForm({...form, name: e.target.value})} required /></label>
      <label>Phone *<input value={form.phone} onChange={e => setForm({...form, phone: e.target.value})} required /></label>
      <label>Email<input value={form.email} onChange={e => setForm({...form, email: e.target.value})} /></label>
      <label>College<input value={form.college} onChange={e => setForm({...form, college: e.target.value})} /></label>
      <label>Ticket type<select value={form.ticketType} onChange={e => setForm({...form, ticketType: e.target.value})}>{event.ticketTypes?.map(t => <option key={t.name} value={t.name}>{t.name} — {money(t.price)}</option>)}</select></label>
      <div className="m-actions"><button type="button" className="btn-ghost" onClick={() => setShowAdd(false)}>Cancel</button><button className="btn-primary">Create</button></div>
    </form></Modal>}
  </div>;
}

// ============ RISK QUEUE ============
function RiskQueueView({ event, risks, regs, notify, reload }) {
  const [evidenceData, setEvidenceData] = useState(null);
  const [loadingEvidence, setLoadingEvidence] = useState(false);

  const resolve = async (id, action) => {
    try {
      await api(`/api/events/${event._id}/risk-queue/${id}/resolve`, { method: "POST", body: JSON.stringify({ action, resolution: action }) });
      notify(`Risk ${action === "approve" ? "approved" : "held"}`);
      reload();
    } catch (e) { notify(e.message); }
  };
  const dismiss = async (id) => {
    try {
      await api(`/api/events/${event._id}/risk-queue/${id}/dismiss`, { method: "POST", body: JSON.stringify({ reason: "Dismissed by operator" }) });
      notify("Risk dismissed");
      reload();
    } catch (e) { notify(e.message); }
  };
  const viewEvidence = async (regId) => {
    setLoadingEvidence(true);
    try {
      const data = await api(`/api/events/${event._id}/registrations/${regId}/evidence`);
      setEvidenceData(data);
    } catch (e) { notify(e.message); }
    setLoadingEvidence(false);
  };

  if (evidenceData) return <EvidencePage data={evidenceData} onBack={() => setEvidenceData(null)} />;

  return <div className="page">
    <div className="page-head"><div><span className="eyebrow">PROTECT YOUR EVENT</span><h1>Risk queue</h1><p className="page-subtitle">Review unusual payment activity before it becomes an entry problem.</p></div><span className="queue-count">{risks.length} open {risks.length === 1 ? "case" : "cases"}</span></div>
    {risks.length ? <div className="risk-list">{risks.map(r => {
      const reg = regs.find(x => x.registrationId === r.registrationId);
      return <div key={r._id} className={`risk-card risk-${r.severity}`}>
        <div className="rc-header"><span className={`badge badge-${r.severity}`}>{r.severity.toUpperCase()}</span><strong>{r.registrationId}</strong><small>{r.type.replace(/_/g, " ")}</small></div>
        <div className="rc-body">{reg && <p>{reg.name} · {reg.phone} · Expected: {money(reg.expectedAmount)} · Received: {money(reg.amountReceived)}</p>}{r.details?.reasons?.map((reason, i) => <p key={i} className="reason"><span className="reason-mark">!</span> {reason}</p>)}</div>
        <div className="rc-actions">
          <button className="btn-primary btn-sm" onClick={() => resolve(r._id, "approve")}>Approve Entry</button>
          <button className="btn-ghost btn-sm" onClick={() => resolve(r._id, "hold")}>Hold</button>
          <button className="btn-ghost btn-sm" onClick={() => dismiss(r._id)}>Dismiss</button>
          <button className="btn-ghost btn-sm" onClick={() => viewEvidence(r.registrationId)}>Evidence</button>
        </div>
      </div>;
    })}</div> : <p className="empty">No risk alerts. All clear!</p>}
  </div>;
}

// ============ EVIDENCE PAGE ============
function EvidencePage({ data, onBack }) {
  const { registration: reg, payments, risks, timeline, riskBreakdown, riskBand, duplicateClaims } = data;
  return <div className="page">
    <div className="page-head evidence-head"><div><button className="back-link" onClick={onBack}>← Back to Risk Queue</button><span className="eyebrow">INVESTIGATION CASE</span><h1>{reg.name} <span className="muted-id">{reg.registrationId}</span></h1><p className="page-subtitle">Everything the team needs to make a safe entry decision.</p></div><span className={`case-status case-${riskBand}`}>{riskBand} risk</span></div>

    <div className="evidence-grid">
      <div className="ev-section">
        <h3>Participant</h3>
        <div className="ev-details">
          <p><strong>{reg.name}</strong></p>
          <p>Phone: {reg.phone}</p>
          <p>Email: {reg.email || "—"}</p>
          <p>Ticket: {reg.ticketType}</p>
          <p>College: {reg.college || "—"}</p>
        </div>
      </div>

      <div className="ev-section">
        <h3>Payment Status</h3>
        <div className="ev-details">
          <p>Expected: <strong>{money(reg.expectedAmount)}</strong></p>
          <p>Received: <strong>{money(reg.amountReceived)}</strong></p>
          <p>Status: <span className={`badge badge-${reg.paymentStatus === "payment_verified" ? "green" : "red"}`}>{reg.paymentStatus.replace(/_/g, " ")}</span></p>
          <p>Entry: <span className={`badge badge-${reg.entryStatus === "entry_approved" ? "green" : "yellow"}`}>{reg.entryStatus.replace(/_/g, " ")}</span></p>
          {reg.paymentId && <p>Payment ID: <code>{reg.paymentId}</code></p>}
          {reg.utr && <p>UTR: <code>{reg.utr}</code></p>}
          {reg.paymentLinkId && <p>Link ID: <code>{reg.paymentLinkId}</code></p>}
        </div>
      </div>

      <div className="ev-section">
        <h3>Risk Score: {reg.riskScore || 0} <span className={`badge badge-${riskBand === "critical" ? "red" : riskBand === "high" ? "orange" : riskBand === "medium" ? "yellow" : "green"}`}>{riskBand}</span></h3>
        {riskBreakdown.length > 0 ? <div className="risk-breakdown">{riskBreakdown.map((r, i) => <div key={i} className="rb-item"><span className="rb-score">+{r.score}</span><strong>{r.signal}</strong><small>{r.detail}</small></div>)}</div> : <p className="empty">No risk signals</p>}
      </div>

      {duplicateClaims?.length > 0 && <div className="ev-section ev-warning">
        <h3>Duplicate Claims ({duplicateClaims.length})</h3>
        {duplicateClaims.map((d, i) => <p key={i}><strong>{d.registrationId}</strong> — {d.name} also claimed UTR: {d.utr}</p>)}
      </div>}

      <div className="ev-section ev-full">
        <h3>Timeline</h3>
        <div className="timeline">{timeline.map((t, i) => <div key={i} className="tl-item">
          <span className="tl-time">{new Date(t.time).toLocaleString("en-IN", { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" })}</span>
          <span className="tl-dot" />
          <div className="tl-content"><strong>{t.event}</strong><small>{t.detail}</small></div>
        </div>)}</div>
      </div>

      {payments.length > 0 && <div className="ev-section ev-full">
        <h3>Payment Events ({payments.length})</h3>
        <div className="table-wrap"><table><thead><tr><th>ID</th><th>Amount</th><th>Status</th><th>Method</th><th>UTR</th><th>Time</th></tr></thead><tbody>
          {payments.map(p => <tr key={p._id}><td><code>{p.razorpayPaymentId?.slice(-8)}</code></td><td>{money(p.amount)}</td><td><span className={`badge badge-${p.status === "captured" ? "green" : "red"}`}>{p.status}</span></td><td>{p.method || "—"}</td><td>{p.utr || "—"}</td><td>{new Date(p.createdAt).toLocaleString("en-IN")}</td></tr>)}
        </tbody></table></div>
      </div>}
    </div>
  </div>;
}

// ============ SHARE ACCESS ============
function ShareAccess({ event, notify }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("viewer");
  const [collaborators, setCollaborators] = useState(event.collaborators || []);
  const [busy, setBusy] = useState(false);

  const addCollaborator = async (e) => {
    e.preventDefault();
    if (!email.trim()) return;
    setBusy(true);
    try {
      const result = await api(`/api/events/${event._id}/share`, { method: "POST", body: JSON.stringify({ email: email.trim(), role }) });
      setCollaborators(result.collaborators);
      setEmail("");
      notify("Access shared!");
    } catch (e) { notify(e.message); }
    setBusy(false);
  };

  const removeCollaborator = async (emailToRemove) => {
    try {
      const result = await api(`/api/events/${event._id}/share/${encodeURIComponent(emailToRemove)}`, { method: "DELETE" });
      setCollaborators(result.collaborators);
      notify("Access removed");
    } catch (e) { notify(e.message); }
  };

  return <div className="page">
    <div className="page-head"><div><span className="eyebrow">TEAM WORKSPACE</span><h1>Share access</h1><p className="page-subtitle">Give each teammate only the access they need to run the event safely.</p></div></div>
    <div className="share-section">
      <div className="setup-section compact">
        <h3>Invite people to this event</h3>
        <p className="section-hint">Share access with team members. They'll see this event in their dashboard when they sign in with Google.</p>
        <form onSubmit={addCollaborator} className="share-form">
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="Enter email address..." required />
          <select value={role} onChange={e => setRole(e.target.value)}>
            <option value="viewer">Viewer (read-only)</option>
            <option value="editor">Editor (can manage)</option>
          </select>
          <button className="btn-primary" disabled={busy}>{busy ? "..." : "Share"}</button>
        </form>
      </div>

      <div className="setup-section compact">
        <h3>People with access</h3>
        {collaborators.length > 0 ? <div className="collab-list">
          {collaborators.map((c, i) => <div key={i} className="collab-item">
            <div className="collab-info">
              <strong>{c.email}</strong>
              <span className={`badge badge-${c.role === "editor" ? "blue" : "gray"}`}>{c.role}</span>
            </div>
            <button className="btn-ghost btn-sm btn-danger" onClick={() => removeCollaborator(c.email)}>Remove</button>
          </div>)}
        </div> : <p className="empty">No one else has access yet. Invite your team above.</p>}
      </div>

      <div className="setup-section compact">
        <h3>Access levels</h3>
        <div className="access-info">
          <div className="access-row"><strong>Viewer</strong><span>Can see registrations, payments, metrics, and reports. Cannot edit event or approve entries.</span></div>
          <div className="access-row"><strong>Editor</strong><span>Full access — can manage registrations, approve/hold entries, send messages, and view all data.</span></div>
        </div>
      </div>
    </div>
  </div>;
}

// ============ AI INVESTIGATE ============
function AIInvestigate({ event, notify }) {
  const [question, setQuestion] = useState(""); const [result, setResult] = useState(null); const [busy, setBusy] = useState(false);
  const presets = ["Who can enter right now?", "Show all duplicate UTR claims", "Why is the settlement lower than expected?", "Which registrations have no verified payment?", "Are there any suspicious payments?", "Give me today's event status in Hinglish"];

  const ask = async (q) => {
    const query = q || question; if (!query.trim()) return;
    setBusy(true); setResult(null);
    try { const d = await api(`/api/events/${event._id}/ai/investigate`, { method: "POST", body: JSON.stringify({ question: query }) }); setResult(d); } catch (e) { setResult({ answer: `Error: ${e.message}` }); }
    setBusy(false);
  };

  const s = result?.structured;

  return <div className="page">
    <div className="page-head"><div><span className="eyebrow">EVIDENCE ASSISTANT</span><h1>Ask Sentinel</h1><p className="page-subtitle">Ask a question in plain language. Answers are based on your event's payment records.</p></div></div>
    <div className="ai-box">
      <div className="ai-safety-banner">AI is read-only. AI cannot approve entry, refund payments, or delete records. A human operator makes the final decision.</div>
      <div className="ai-presets">{presets.map(p => <button key={p} className="btn-ghost btn-sm" onClick={() => { setQuestion(p); ask(p); }}>{p}</button>)}</div>
      <form onSubmit={e => { e.preventDefault(); ask(); }} className="ai-form"><input value={question} onChange={e => setQuestion(e.target.value)} placeholder="Ask anything about payments, registrations, or risks..." /><button className="btn-primary" disabled={busy}>{busy ? "Investigating..." : "Investigate"}</button></form>
      
      {result && <div className="ai-result">
        {s ? <div className="ai-structured">
          <div className="ai-verdict-row">
            <span className={`ai-decision ai-${s.decision}`}>{s.decision?.toUpperCase()}</span>
            <span className={`badge badge-${s.riskLevel === "critical" ? "red" : s.riskLevel === "high" ? "orange" : s.riskLevel === "medium" ? "yellow" : "green"}`}>Risk: {s.riskLevel}</span>
            <span className={`ai-confidence conf-${s.confidence}`}>Confidence: {s.confidence}</span>
            {s.source === "rules" && <span className="badge badge-gray">Rule-based</span>}
          </div>
          <div className="ai-summary"><strong>{s.summary}</strong></div>
          <p className="ai-explanation">{s.explanation}</p>
          
          {s.evidence?.length > 0 && <div className="ai-evidence"><h4>Evidence</h4>{s.evidence.map((e, i) => <div key={i} className="ev-cite"><span className="ev-source">{e.source}</span><code>{e.id}</code><span>{e.fact}</span></div>)}</div>}
          
          {s.missingInfo?.length > 0 && <div className="ai-missing"><h4>Missing Information</h4><ul>{s.missingInfo.map((m, i) => <li key={i}>{m}</li>)}</ul></div>}
          
          <div className="ai-actions-row">
            {s.recommendedAction && <div className="ai-recommend"><strong>Recommended:</strong> {s.recommendedAction}</div>}
            {s.forbiddenActions?.length > 0 && <div className="ai-forbidden"><strong>Do NOT:</strong> {s.forbiddenActions.join(", ")}</div>}
          </div>
        </div> : <div className="ai-answer"><pre>{result.answer}</pre></div>}
      </div>}
    </div>
  </div>;
}

// ============ MESSAGES ============
function Messages({ event, messages, notify, reload }) {
  const [regId, setRegId] = useState(""); const [content, setContent] = useState(""); const [type, setType] = useState("custom");
  const send = async e => {
    e.preventDefault(); if (!content.trim()) return;
    try { await api(`/api/events/${event._id}/messages/send`, { method: "POST", body: JSON.stringify({ registrationId: regId, messageType: type, content }) }); setContent(""); notify("Message sent"); reload(); } catch (e) { notify(e.message); }
  };
  return <div className="page">
    <div className="page-head"><div><span className="eyebrow">PARTICIPANT COMMUNICATION</span><h1>Messages</h1><p className="page-subtitle">Keep participants informed about payment status and entry instructions.</p></div><span className="queue-count">{messages.length} sent</span></div>
    <form onSubmit={send} className="msg-form">
      <input value={regId} onChange={e => setRegId(e.target.value)} placeholder="REG ID (optional)" />
      <select value={type} onChange={e => setType(e.target.value)}><option value="payment_verified">Payment Verified</option><option value="payment_pending">Payment Pending</option><option value="amount_mismatch">Amount Mismatch</option><option value="suspicious">Suspicious</option><option value="custom">Custom</option></select>
      <textarea value={content} onChange={e => setContent(e.target.value)} placeholder="Message content..." rows={3} />
      <button className="btn-primary">Send Message</button>
    </form>
    <div className="msg-list">{messages.map(m => <div key={m._id} className="msg-item"><span className={`badge badge-${m.status === "sent" ? "green" : "gray"}`}>{m.messageType}</span><p>{m.content}</p><small>{m.registrationId} · {new Date(m.createdAt).toLocaleString()}</small></div>)}</div>
  </div>;
}

// ============ RECONCILIATION ============
function Reconciliation({ event, notify }) {
  const [data, setData] = useState(null);
  useEffect(() => { api(`/api/events/${event._id}/reconciliation`).then(setData).catch(e => notify(e.message)); }, [event._id]);
  if (!data) return <div className="page"><p>Loading...</p></div>;
  return <div className="page">
    <div className="page-head"><div><span className="eyebrow">MONEY CONTROL</span><h1>Reconciliation</h1><p className="page-subtitle">Understand every rupee between expected registrations and captured payments.</p></div></div>
    <div className="recon-grid">
      <div className="recon-row"><span>Expected gross collection</span><strong>{money(data.expectedGross)}</strong></div>
      <div className="recon-row"><span>Captured through Razorpay</span><strong className="green">{money(data.captured)}</strong></div>
      <div className="recon-row"><span>Refunds</span><strong className="red">-{money(data.refunded)}</strong></div>
      <div className="recon-row"><span>Failed payments ({data.failedCount || 0})</span><strong className="red">{money(data.failedTotal)}</strong></div>
      <div className="recon-row"><span>Estimated Razorpay fees (~2%)</span><strong className="red">-{money(data.estimatedFees)}</strong></div>
      <div className="recon-row total"><span>Estimated net settlement</span><strong>{money(data.estimatedNet)}</strong></div>
      <div className="recon-row"><span>Gap (expected - captured)</span><strong className={data.difference > 0 ? "red" : "green"}>{money(data.difference)}</strong></div>
    </div>
    <div className="recon-grid" style={{marginTop: "16px"}}>
      <div className="recon-row"><span>Registrations without payment</span><strong>{data.regsWithoutPayment || 0}</strong></div>
      <div className="recon-row"><span>Unmatched payments</span><strong>{data.paymentsWithoutReg || 0}</strong></div>
      <div className="recon-row"><span>Amount mismatches</span><strong className="red">{data.mismatches || 0}</strong></div>
      <div className="recon-row"><span>Duplicate claims</span><strong className="red">{data.duplicates || 0}</strong></div>
      <div className="recon-row"><span>Verified payments</span><strong className="green">{data.verified || 0}</strong></div>
    </div>
    {data.feesNote && <p className="recon-note">{data.feesNote}</p>}
  </div>;
}

// ============ AUDIT LOG ============
function AuditLogView({ event }) {
  const [logs, setLogs] = useState([]);
  useEffect(() => { api(`/api/events/${event._id}/audit`).then(setLogs).catch(() => {}); }, [event._id]);
  return <div className="page">
    <div className="page-head"><div><span className="eyebrow">TRUST & ACCOUNTABILITY</span><h1>Audit log</h1><p className="page-subtitle">A clear record of what changed, who changed it, and when.</p></div></div>
    <div className="table-wrap"><table><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th><th>Reason</th></tr></thead><tbody>
      {logs.map(l => <tr key={l._id}><td>{new Date(l.createdAt).toLocaleString()}</td><td>{l.actorId?.name || "System"}</td><td>{l.action}</td><td>{l.target}</td><td>{l.reason || "—"}</td></tr>)}
    </tbody></table>{!logs.length && <p className="empty">No audit entries yet</p>}</div>
  </div>;
}

// ============ MODAL ============
function Modal({ title, onClose, children }) {
  return <div className="modal-bg" onClick={onClose}><div className="modal" onClick={e => e.stopPropagation()}><div className="modal-head"><h2>{title}</h2><button onClick={onClose}>✕</button></div>{children}</div></div>;
}

// ============ RENDER ============
createRoot(document.getElementById("root")).render(<App />);
