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

// ============ CONTEXT ============
const AuthCtx = createContext(null);
const useAuth = () => useContext(AuthCtx);

// ============ APP ============
function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState("landing");

  useEffect(() => {
    if (!getToken()) { setLoading(false); return; }
    api("/api/auth/me").then(d => { setUser(d.user); setPage("events"); }).catch(() => clearToken()).finally(() => setLoading(false));
  }, []);

  const login = async (email, password) => { const d = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }); setToken(d.token); setUser(d.user); setPage("events"); };
  const register = async (name, email, phone, password, role) => { const d = await api("/api/auth/register", { method: "POST", body: JSON.stringify({ name, email, phone, password, role }) }); setToken(d.token); setUser(d.user); setPage("events"); };
  const logout = () => { clearToken(); setUser(null); setPage("landing"); };

  if (loading) return <div className="load-screen"><div className="loader-icon">EP</div><p>EventPay Sentinel</p></div>;

  return <AuthCtx.Provider value={{ user, logout }}>
    {page === "landing" && <Landing onLogin={() => setPage("login")} onRegister={() => setPage("register")} />}
    {page === "login" && <Login onLogin={login} onSwitch={() => setPage("register")} onBack={() => setPage("landing")} />}
    {page === "register" && <Register onRegister={register} onSwitch={() => setPage("login")} onBack={() => setPage("landing")} />}
    {page === "events" && <EventsApp />}
  </AuthCtx.Provider>;
}

// ============ LANDING ============
function Landing({ onLogin, onRegister }) {
  return <div className="landing">
    <header className="l-header"><div className="l-brand"><span className="brand-mark">EP</span> EventPay Sentinel</div><div className="l-nav"><button className="btn-ghost" onClick={onLogin}>Login</button><button className="btn-primary" onClick={onRegister}>Get Started</button></div></header>
    <section className="hero"><h1>Real-time payment truth for mass events</h1><p>Connect registrations, Razorpay payments, fraud detection, and participant entry in one trusted command center. Never trust a screenshot again.</p><button className="btn-primary btn-lg" onClick={onRegister}>Create Your First Event →</button></section>
    <section className="features"><h2>How it works</h2><div className="f-grid">
       <div className="f-card"><span className="feature-icon">IN</span><h3>Registration Intake</h3><p>Google Forms → auto-creates registrations with unique IDs and payment links</p></div>
       <div className="f-card"><span className="feature-icon">₹</span><h3>Razorpay Verification</h3><p>Webhooks verify payments cryptographically. No screenshots needed.</p></div>
       <div className="f-card"><span className="feature-icon">RS</span><h3>Risk Engine</h3><p>Detects duplicate UTRs, amount mismatches, reused payments instantly</p></div>
       <div className="f-card"><span className="feature-icon">CC</span><h3>Command Center</h3><p>Live dashboard: verified, pending, suspicious, held — all in real-time</p></div>
       <div className="f-card"><span className="feature-icon">QR</span><h3>QR Entry Pass</h3><p>Verified participants get QR codes. Volunteers scan at the gate.</p></div>
       <div className="f-card"><span className="feature-icon">AI</span><h3>AI Investigation</h3><p>Ask "Why is this payment pending?" and get evidence-backed answers</p></div>
    </div></section>
    <footer className="l-footer"><p>Built for India's high-volume events · Razorpay-powered · Real-time verification</p></footer>
  </div>;
}

// ============ AUTH ============
function Login({ onLogin, onSwitch, onBack }) {
  const [email, setEmail] = useState(""); const [password, setPassword] = useState("");
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const submit = async e => { e.preventDefault(); setError(""); setBusy(true); try { await onLogin(email, password); } catch (e) { setError(e.message); } setBusy(false); };
  return <div className="auth-page"><div className="auth-card"><button className="back-link" onClick={onBack}>← Back</button><h1>Login</h1><p>Access your event command center</p><form onSubmit={submit}><label>Email<input type="email" value={email} onChange={e=>setEmail(e.target.value)} required autoFocus /></label><label>Password<input type="password" value={password} onChange={e=>setPassword(e.target.value)} required /></label>{error && <div className="err">{error}</div>}<button className="btn-primary btn-full" disabled={busy}>{busy ? "..." : "Login"}</button></form><p className="switch">No account? <button onClick={onSwitch}>Register</button></p></div></div>;
}
function Register({ onRegister, onSwitch, onBack }) {
  const [name, setName] = useState(""); const [email, setEmail] = useState(""); const [phone, setPhone] = useState(""); const [password, setPassword] = useState(""); const [role, setRole] = useState("organizer");
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const submit = async e => { e.preventDefault(); setError(""); setBusy(true); try { await onRegister(name, email, phone, password, role); } catch (e) { setError(e.message); } setBusy(false); };
  return <div className="auth-page"><div className="auth-card"><button className="back-link" onClick={onBack}>← Back</button><h1>Create Account</h1><p>Set up your event payment command center</p><form onSubmit={submit}><label>Full name<input value={name} onChange={e=>setName(e.target.value)} required autoFocus /></label><label>Email<input type="email" value={email} onChange={e=>setEmail(e.target.value)} required /></label><label>Phone<input value={phone} onChange={e=>setPhone(e.target.value)} /></label><label>Role<select value={role} onChange={e=>setRole(e.target.value)}><option value="organizer">Event Organizer</option><option value="volunteer">Volunteer / Gate</option><option value="finance">Finance Reviewer</option></select></label><label>Password<input type="password" value={password} onChange={e=>setPassword(e.target.value)} required minLength={6} /></label>{error && <div className="err">{error}</div>}<button className="btn-primary btn-full" disabled={busy}>{busy ? "..." : "Create Account"}</button></form><p className="switch">Have an account? <button onClick={onSwitch}>Login</button></p></div></div>;
}

// ============ EVENTS APP ============
function EventsApp() {
  const { user, logout } = useAuth();
  const [events, setEvents] = useState([]);
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [view, setView] = useState("dashboard");
  const [toast, setToast] = useState("");
  const notify = m => { setToast(m); setTimeout(() => setToast(""), 3000); };

  useEffect(() => { api("/api/events").then(setEvents).catch(e => notify(e.message)); }, []);

  if (selectedEvent) return <EventDashboard event={selectedEvent} view={view} setView={setView} onBack={() => { setSelectedEvent(null); setView("dashboard"); }} notify={notify} toast={toast} />;

  return <div className="app-shell">
    <header className="app-header"><div className="app-brand"><span className="brand-mark">EP</span> EventPay Sentinel</div><div className="app-user"><span>{user?.name}</span><small>{user?.role}</small><button className="btn-ghost btn-sm" onClick={logout}>Logout</button></div></header>
    <main className="events-page">
      <div className="page-head"><h1>Your Events</h1><CreateEventBtn onCreated={ev => { setEvents(p => [ev, ...p]); notify("Event created!"); }} /></div>
      {events.length ? <div className="events-grid">{events.map(ev => <div key={ev._id} className="event-card" onClick={() => { setSelectedEvent(ev); setView("dashboard"); }}><h3>{ev.name}</h3><p>{ev.venue} · {new Date(ev.eventDate).toLocaleDateString("en-IN")}</p><span className={`badge badge-${ev.status}`}>{ev.status}</span></div>)}</div> : <p className="empty">No events yet. Create your first event to get started.</p>}
    </main>
    {toast && <div className="toast">{toast}</div>}
  </div>;
}

function CreateEventBtn({ onCreated }) {
  const [show, setShow] = useState(false);
  const [form, setForm] = useState({ name: "", venue: "", eventDate: "", capacity: 1000, tickets: [{ name: "General", price: 499, capacity: 500 }] });
  const [busy, setBusy] = useState(false);
  const addTicket = () => setForm(f => ({ ...f, tickets: [...f.tickets, { name: "", price: 0, capacity: 100 }] }));
  const updateTicket = (i, k, v) => setForm(f => ({ ...f, tickets: f.tickets.map((t, idx) => idx === i ? { ...t, [k]: v } : t) }));

  const submit = async e => {
    e.preventDefault(); setBusy(true);
    try {
      const ev = await api("/api/events", { method: "POST", body: JSON.stringify({ name: form.name, venue: form.venue, eventDate: form.eventDate, capacity: Number(form.capacity), ticketTypes: form.tickets.map(t => ({ name: t.name, price: Number(t.price), capacity: Number(t.capacity) })) }) });
      onCreated(ev); setShow(false);
    } catch (e) { alert(e.message); }
    setBusy(false);
  };

  if (!show) return <button className="btn-primary" onClick={() => setShow(true)}>+ Create Event</button>;
  return <Modal title="Create Event" onClose={() => setShow(false)}><form onSubmit={submit} className="m-form">
    <label>Event name *<input value={form.name} onChange={e => setForm({...form, name: e.target.value})} required placeholder="e.g. RazorFest 2026" /></label>
    <label>Venue<input value={form.venue} onChange={e => setForm({...form, venue: e.target.value})} placeholder="e.g. Pune College Ground" /></label>
    <label>Event date *<input type="date" value={form.eventDate} onChange={e => setForm({...form, eventDate: e.target.value})} required /></label>
    <label>Capacity<input type="number" value={form.capacity} onChange={e => setForm({...form, capacity: e.target.value})} /></label>
    <div className="tickets-section"><strong>Ticket Types</strong>{form.tickets.map((t, i) => <div key={i} className="ticket-row"><input placeholder="Name" value={t.name} onChange={e => updateTicket(i, "name", e.target.value)} /><input type="number" placeholder="Price" value={t.price} onChange={e => updateTicket(i, "price", e.target.value)} /><input type="number" placeholder="Capacity" value={t.capacity} onChange={e => updateTicket(i, "capacity", e.target.value)} /></div>)}<button type="button" className="btn-ghost btn-sm" onClick={addTicket}>+ Add ticket type</button></div>
    <div className="m-actions"><button type="button" className="btn-ghost" onClick={() => setShow(false)}>Cancel</button><button className="btn-primary" disabled={busy}>{busy ? "Creating..." : "Create Event"}</button></div>
  </form></Modal>;
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
        api(`/api/events/${event._id}/registrations`),
        api(`/api/events/${event._id}/risk-queue`),
        api(`/api/events/${event._id}/messages`)
      ]);
      setMetrics(m); setRegs(r); setRisks(rk); setMessages(msgs);
    } catch (e) { notify(e.message); }
  }, [event._id]);
  useEffect(() => { loadData(); }, [loadData]);

  const navItems = [
    ["dashboard", "CC", "Command Center"],
    ["registrations", "RG", "Registrations"],
    ["risk", "RQ", "Risk Queue"],
    ["scanner", "IN", "Entry Scanner"],
    ["ai", "AI", "AI Investigate"],
    ["messages", "MS", "Messages"],
    ["reconciliation", "₹", "Reconciliation"],
    ["audit", "AL", "Audit Log"]
  ];

  return <div className={`app-shell dashboard-shell ${mobileOpen ? "menu-open" : ""}`}>
    <div className="mobile-scrim" onClick={() => setMobileOpen(false)} />
    <aside className="sidebar">
      <div className="sb-header"><button className="back-link" onClick={onBack}>← Events</button><h3>{event.name}</h3><small>{event.venue} · {new Date(event.eventDate).toLocaleDateString("en-IN")}</small></div>
       <nav>{navItems.map(([key, icon, label]) => <button key={key} className={view === key ? "active" : ""} onClick={() => { setView(key); setMobileOpen(false); }}><span>{icon}</span>{label}</button>)}</nav>
      <div className="sb-footer"><span>{user?.name}</span><small>{user?.role}</small></div>
    </aside>
    <main className="main-view">
       <div className="mobile-topbar"><button className="menu-toggle" onClick={() => setMobileOpen(true)} aria-label="Open navigation">☰</button><span>{event.name}</span><span className="live-dot">● Live</span></div>
      {view === "dashboard" && <CommandCenter metrics={metrics} regs={regs} risks={risks} event={event} notify={notify} reload={loadData} />}
      {view === "registrations" && <Registrations event={event} regs={regs} notify={notify} reload={loadData} />}
      {view === "risk" && <RiskQueueView event={event} risks={risks} regs={regs} notify={notify} reload={loadData} />}
      {view === "scanner" && <EntryScanner event={event} notify={notify} reload={loadData} />}
      {view === "ai" && <AIInvestigate event={event} notify={notify} />}
      {view === "messages" && <Messages event={event} messages={messages} notify={notify} reload={loadData} />}
      {view === "reconciliation" && <Reconciliation event={event} notify={notify} />}
      {view === "audit" && <AuditLogView event={event} />}
    </main>
    {toast && <div className="toast">{toast}</div>}
  </div>;
}

// ============ COMMAND CENTER ============
function CommandCenter({ metrics, regs, risks, event, notify, reload }) {
  const m = metrics;
  const seedDemo = async () => { try { const d = await api(`/api/events/${event._id}/seed-demo`, { method: "POST" }); notify(d.message); reload(); } catch (e) { notify(e.message); } };

  return <div className="page">
    <div className="page-head"><h1>Command Center</h1><button className="btn-ghost btn-sm" onClick={seedDemo}>Seed demo data</button><button className="btn-ghost btn-sm" onClick={reload}>↻ Refresh</button></div>
    <div className="metrics-grid">
      <div className="m-card"><span className="m-num">{m.totalRegs || 0}</span><span className="m-label">Total registrations</span></div>
      <div className="m-card green"><span className="m-num">{m.verified || 0}</span><span className="m-label">Payments verified</span></div>
      <div className="m-card yellow"><span className="m-num">{m.awaiting || 0}</span><span className="m-label">Awaiting payment</span></div>
      <div className="m-card orange"><span className="m-num">{m.mismatches || 0}</span><span className="m-label">Amount mismatches</span></div>
      <div className="m-card red"><span className="m-num">{m.duplicates || 0}</span><span className="m-label">Duplicate claims</span></div>
      <div className="m-card red"><span className="m-num">{m.suspicious || 0}</span><span className="m-label">Suspicious</span></div>
      <div className="m-card purple"><span className="m-num">{m.riskCount || 0}</span><span className="m-label">Risk queue</span></div>
      <div className="m-card blue"><span className="m-num">{m.checkedIn || 0}</span><span className="m-label">Checked in</span></div>
    </div>
    <div className="finance-row">
      <div className="fin-card"><span>Expected</span><strong>{money(m.expectedTotal)}</strong></div>
      <div className="fin-card green"><span>Verified</span><strong>{money(m.verifiedTotal)}</strong></div>
      <div className="fin-card yellow"><span>Gap</span><strong>{money((m.expectedTotal || 0) - (m.verifiedTotal || 0))}</strong></div>
    </div>
    <div className="dash-grid">
      <div className="card"><h3>Entry Readiness</h3>
        <div className="entry-bar"><div className="eb-fill" style={{width: `${m.totalRegs ? (m.verified||0)/m.totalRegs*100 : 0}%`}} /><span>{m.verified || 0} / {m.totalRegs || 0} can enter</span></div>
        <p className="note">{m.awaiting || 0} need payment · {m.mismatches || 0} need review · {m.held || 0} held</p>
      </div>
      <div className="card"><h3>Recent Risk Alerts</h3>{risks.length ? risks.slice(0, 5).map(r => <div key={r._id} className="risk-item"><span className={`badge badge-${r.severity}`}>{r.severity}</span><strong>{r.registrationId}</strong><small>{r.type.replace(/_/g, " ")}</small></div>) : <p className="empty">No risk alerts</p>}</div>
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
    <div className="page-head"><h1>Registrations ({regs.length})</h1><button className="btn-primary" onClick={() => setShowAdd(true)}>+ Add Registration</button></div>
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
  const resolve = async (id, resolution) => {
    try { /* For now just reload */ notify(`Risk ${resolution}`); reload(); } catch (e) { notify(e.message); }
  };
  return <div className="page">
    <div className="page-head"><h1>Risk Queue ({risks.length})</h1></div>
    {risks.length ? <div className="risk-list">{risks.map(r => {
      const reg = regs.find(x => x.registrationId === r.registrationId);
      return <div key={r._id} className={`risk-card risk-${r.severity}`}>
        <div className="rc-header"><span className={`badge badge-${r.severity}`}>{r.severity.toUpperCase()}</span><strong>{r.registrationId}</strong><small>{r.type.replace(/_/g, " ")}</small></div>
        <div className="rc-body">{reg && <p>{reg.name} · {reg.phone} · Expected: {money(reg.expectedAmount)} · Received: {money(reg.amountReceived)}</p>}{r.details?.reasons?.map((reason, i) => <p key={i} className="reason"><span className="reason-mark">!</span> {reason}</p>)}</div>
        <div className="rc-actions"><button className="btn-primary btn-sm" onClick={() => resolve(r._id, "approved")}>Approve Entry</button><button className="btn-ghost btn-sm" onClick={() => resolve(r._id, "dismissed")}>Dismiss</button></div>
      </div>;
    })}</div> : <p className="empty">No risk alerts. All clear!</p>}
  </div>;
}

// ============ ENTRY SCANNER ============
function EntryScanner({ event, notify, reload }) {
  const [regId, setRegId] = useState(""); const [result, setResult] = useState(null); const [busy, setBusy] = useState(false);

  const scan = async e => {
    e?.preventDefault(); if (!regId.trim()) return;
    setBusy(true); setResult(null);
    try {
      const reg = await api(`/api/events/${event._id}/registrations/${regId.trim().toUpperCase()}`);
      setResult(reg);
    } catch (e) { setResult({ error: e.message }); }
    setBusy(false);
  };

  const checkIn = async () => {
    try { await api(`/api/events/${event._id}/entry/${result.registrationId}/check-in`, { method: "POST" }); notify("Checked in!"); setResult({ ...result, entryStatus: "checked_in" }); reload(); } catch (e) { notify(e.message); }
  };

  return <div className="page">
    <div className="page-head"><h1>Entry Scanner</h1></div>
    <div className="scanner-box">
      <form onSubmit={scan}><input className="scan-input" value={regId} onChange={e => setRegId(e.target.value)} placeholder="Enter REG ID or scan QR..." autoFocus /><button className="btn-primary" disabled={busy}>{busy ? "..." : "Check"}</button></form>
    </div>
    {result && !result.error && <div className={`scan-result ${result.entryStatus === "entry_approved" || result.entryStatus === "checked_in" ? "sr-green" : result.entryStatus === "entry_held" ? "sr-red" : "sr-yellow"}`}>
       <h2>{result.entryStatus === "entry_approved" ? "ENTRY APPROVED" : result.entryStatus === "checked_in" ? "ALREADY CHECKED IN" : result.entryStatus === "entry_held" ? "ENTRY HELD" : "PAYMENT PENDING"}</h2>
       <div className="sr-details"><p><strong>{result.name}</strong></p><p>{result.ticketType} · {money(result.expectedAmount)}</p><p>Payment: {result.paymentStatus.replace(/_/g, " ")}</p>{result.riskReasons?.length > 0 && <p className="reason"><span className="reason-mark">!</span> {result.riskReasons.join(", ")}</p>}</div>
      {result.entryStatus === "entry_approved" && <button className="btn-primary btn-lg" onClick={checkIn}>Admit →</button>}
      {result.entryStatus === "entry_held" && <p className="action-note">Send to payment help desk</p>}
    </div>}
    {result?.error && <div className="scan-result sr-red"><h2>NOT FOUND</h2><p>{result.error}</p></div>}
  </div>;
}

// ============ AI INVESTIGATE ============
function AIInvestigate({ event, notify }) {
  const [question, setQuestion] = useState(""); const [answer, setAnswer] = useState(""); const [busy, setBusy] = useState(false);
  const presets = ["Who can enter right now?", "Show all duplicate UTR claims", "Why is the settlement lower than expected?", "Which registrations have no verified payment?", "Give me today's event status in Hinglish"];

  const ask = async (q) => {
    const query = q || question; if (!query.trim()) return;
    setBusy(true); setAnswer("");
    try { const d = await api(`/api/events/${event._id}/ai/investigate`, { method: "POST", body: JSON.stringify({ question: query }) }); setAnswer(d.answer); } catch (e) { setAnswer(`Error: ${e.message}`); }
    setBusy(false);
  };

  return <div className="page">
    <div className="page-head"><h1>AI Investigation</h1></div>
    <div className="ai-box">
      <div className="ai-presets">{presets.map(p => <button key={p} className="btn-ghost btn-sm" onClick={() => { setQuestion(p); ask(p); }}>{p}</button>)}</div>
      <form onSubmit={e => { e.preventDefault(); ask(); }} className="ai-form"><input value={question} onChange={e => setQuestion(e.target.value)} placeholder="Ask anything about payments, registrations, or risks..." /><button className="btn-primary" disabled={busy}>{busy ? "Thinking..." : "Ask"}</button></form>
      {answer && <div className="ai-answer"><pre>{answer}</pre></div>}
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
    <div className="page-head"><h1>Messages ({messages.length})</h1></div>
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
    <div className="page-head"><h1>Reconciliation</h1></div>
    <div className="recon-grid">
      <div className="recon-row"><span>Expected gross collection</span><strong>{money(data.expectedGross)}</strong></div>
      <div className="recon-row"><span>Captured through Razorpay</span><strong className="green">{money(data.captured)}</strong></div>
      <div className="recon-row"><span>Refunds</span><strong className="red">-{money(data.refunded)}</strong></div>
      <div className="recon-row"><span>Razorpay fees (~2%)</span><strong className="red">-{money(data.fees)}</strong></div>
      <div className="recon-row total"><span>Expected net settlement</span><strong>{money(data.expectedNet)}</strong></div>
      <div className="recon-row"><span>Gap (expected - captured)</span><strong className={data.difference > 0 ? "red" : "green"}>{money(data.difference)}</strong></div>
    </div>
  </div>;
}

// ============ AUDIT LOG ============
function AuditLogView({ event }) {
  const [logs, setLogs] = useState([]);
  useEffect(() => { api(`/api/events/${event._id}/audit`).then(setLogs).catch(() => {}); }, [event._id]);
  return <div className="page">
    <div className="page-head"><h1>Audit Log</h1></div>
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
