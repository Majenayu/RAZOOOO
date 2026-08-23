import { useMemo, useState, type ReactNode } from "react";

type RegistrationStatus = "Verified" | "Pending" | "Review" | "Refunded";

type Registration = {
  initials: string;
  name: string;
  detail: string;
  category: string;
  amount: string;
  status: RegistrationStatus;
  tone: "teal" | "amber" | "coral" | "slate";
  time: string;
};

const registrations: Registration[] = [
  { initials: "AS", name: "Aarav Sharma", detail: "EP-2048 · Student", category: "Student", amount: "₹499", status: "Verified", tone: "teal", time: "2 min ago" },
  { initials: "MK", name: "Meera Kapoor", detail: "EP-2047 · General", category: "General", amount: "₹799", status: "Pending", tone: "amber", time: "6 min ago" },
  { initials: "RN", name: "Rohan Nair", detail: "EP-2046 · Student", category: "Student", amount: "₹499", status: "Verified", tone: "teal", time: "14 min ago" },
  { initials: "SI", name: "Sana Iqbal", detail: "EP-2045 · Volunteer", category: "Volunteer", amount: "₹0", status: "Review", tone: "coral", time: "21 min ago" },
  { initials: "VK", name: "Vikram Khanna", detail: "EP-2044 · General", category: "General", amount: "₹799", status: "Verified", tone: "teal", time: "32 min ago" },
  { initials: "NP", name: "Nisha Patel", detail: "EP-2043 · Student", category: "Student", amount: "₹499", status: "Refunded", tone: "slate", time: "48 min ago" },
];

const navItems = [
  { id: "overview", label: "Overview", icon: "grid" },
  { id: "registrations", label: "Registrations", icon: "users" },
  { id: "payments", label: "Payments", icon: "card" },
  { id: "entry", label: "Entry desk", icon: "scan" },
];

function Icon({ name, size = 18, stroke = 1.8 }: { name: string; size?: number; stroke?: number }) {
  const paths: Record<string, ReactNode> = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1.4" /><rect x="14" y="3" width="7" height="7" rx="1.4" /><rect x="3" y="14" width="7" height="7" rx="1.4" /><rect x="14" y="14" width="7" height="7" rx="1.4" /></>,
    users: <><path d="M16 20v-1.8a3.8 3.8 0 0 0-3.8-3.8H6.8A3.8 3.8 0 0 0 3 18.2V20" /><circle cx="9.5" cy="7.2" r="3.2" /><path d="M16.5 11.5a3.2 3.2 0 0 0 0-6.1M17.2 14.5h.2a3.6 3.6 0 0 1 3.6 3.6V20" /></>,
    card: <><rect x="2.5" y="5" width="19" height="14" rx="2.2" /><path d="M2.5 9h19M6 14h3" /></>,
    scan: <><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" /><path d="M8 8h8v8H8z" /></>,
    shield: <><path d="M12 3 19 6v5c0 4.3-2.7 8-7 10-4.3-2-7-5.7-7-10V6l7-3Z" /><path d="m8.8 12 2 2 4.5-4.5" /></>,
    bell: <><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4" /></>,
    chevron: <path d="m7 10 5 5 5-5" />,
    arrow: <><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></>,
    search: <><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 5 5" /></>,
    sort: <><path d="M8 6v12M5 9l3-3 3 3M16 18V6M13 15l3 3 3-3" /></>,
    more: <><circle cx="5" cy="12" r="1" fill="currentColor" /><circle cx="12" cy="12" r="1" fill="currentColor" /><circle cx="19" cy="12" r="1" fill="currentColor" /></>,
    close: <><path d="m6 6 12 12M18 6 6 18" /></>,
    clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3.2 2" /></>,
    check: <path d="m5 12 4.2 4L19 7" />,
    trend: <><path d="M4 17 9 12l3 3 7-8" /><path d="M15 7h4v4" /></>,
    help: <><circle cx="12" cy="12" r="9" /><path d="M9.7 9a2.5 2.5 0 1 1 4.2 1.8c-1.2 1-1.9 1.4-1.9 3" /><path d="M12 17h.01" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] ?? paths.grid}</svg>;
}

function BrandMark({ small = false }: { small?: boolean }) {
  return (
    <span className={`flex shrink-0 items-center justify-center rounded-xl bg-[#d4f3e8] text-[#0b6d5a] ${small ? "h-8 w-8" : "h-10 w-10"}`}>
      <Icon name="shield" size={small ? 17 : 20} stroke={2} />
    </span>
  );
}

function StatusPill({ status }: { status: RegistrationStatus }) {
  const styles: Record<RegistrationStatus, string> = {
    Verified: "bg-[#e0f5ed] text-[#147963]",
    Pending: "bg-[#fff1cf] text-[#92630a]",
    Review: "bg-[#ffe4dc] text-[#a84936]",
    Refunded: "bg-[#e9edf2] text-[#6a7586]",
  };
  return <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold ${styles[status]}`}><span className="h-1.5 w-1.5 rounded-full bg-current" />{status}</span>;
}

function MetricCard({ label, value, note, color, icon }: { label: string; value: string; note: string; color: string; icon: string }) {
  return (
    <div className="rounded-2xl border border-[#e4e7e3] bg-[#fbfcfa] p-4 shadow-[0_5px_20px_rgba(25,43,54,0.035)] sm:p-5">
      <div className="mb-4 flex items-center justify-between">
        <span className={`flex h-8 w-8 items-center justify-center rounded-lg ${color}`}><Icon name={icon} size={16} /></span>
        <Icon name="more" size={17} />
      </div>
      <div className="font-['Space_Grotesk'] text-[27px] font-semibold tracking-[-0.06em] text-[#17283b]">{value}</div>
      <div className="mt-1 flex items-center justify-between gap-2">
        <span className="text-[12px] font-semibold text-[#637080]">{label}</span>
        <span className="text-[10px] font-bold text-[#15806c]">{note}</span>
      </div>
    </div>
  );
}

function RiskItem({ name, issue, amount, onReview }: { name: string; issue: string; amount: string; onReview: () => void }) {
  return (
    <div className="flex items-start gap-3 border-b border-[#edf0ec] py-4 last:border-b-0 last:pb-0">
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#ffe4dc] text-[11px] font-bold text-[#a84936]">{name.split(" ").map((part) => part[0]).join("")}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2"><strong className="truncate text-[12px] text-[#25374a]">{name}</strong><span className="font-['Space_Mono'] text-[10px] text-[#7f8995]">{amount}</span></div>
        <p className="mt-1 text-[11px] leading-4 text-[#7b8793]">{issue}</p>
        <button onClick={onReview} className="mt-2 inline-flex min-h-[30px] items-center gap-1 text-[11px] font-bold text-[#b0523b] transition hover:text-[#883b29]">Open review <Icon name="arrow" size={12} /></button>
      </div>
    </div>
  );
}

export function ResponsiveDashboard() {
  const [activeNav, setActiveNav] = useState("overview");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"All" | RegistrationStatus>("All");
  const [sortAsc, setSortAsc] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [event, setEvent] = useState("Mosaic 2025 · Spring Showcase");

  const filteredRegistrations = useMemo(() => {
    const normalized = search.toLowerCase();
    return registrations
      .filter((registration) => status === "All" || registration.status === status)
      .filter((registration) => `${registration.name} ${registration.detail}`.toLowerCase().includes(normalized))
      .sort((a, b) => sortAsc ? a.name.localeCompare(b.name) : registrations.indexOf(a) - registrations.indexOf(b));
  }, [search, status, sortAsc]);

  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  };

  return (
    <div className="min-h-screen overflow-x-hidden bg-[#f3f6f3] font-['Plus_Jakarta_Sans'] text-[#17283b]">
      <div className="flex min-h-screen">
        <aside className="hidden w-[246px] shrink-0 flex-col border-r border-[#273c48] bg-[#172c38] px-4 py-5 text-white md:flex">
          <div className="flex items-center gap-3 px-2">
            <BrandMark />
            <div><div className="text-[14px] font-extrabold tracking-[-0.02em]">EventPay</div><div className="text-[10px] font-semibold tracking-[0.14em] text-[#95b5b0]">SENTINEL</div></div>
          </div>
          <div className="mt-9 rounded-2xl border border-[#3c555c] bg-[#203b46] p-3">
            <div className="mb-1 flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-[0.15em] text-[#9dc3b9]"><span className="h-1.5 w-1.5 rounded-full bg-[#58d7ad]" /> Live event</div>
            <div className="truncate text-[12px] font-bold text-white">Mosaic 2025</div>
            <div className="mt-1 text-[10px] text-[#a5bbb9]">Spring Showcase · 18 Mar</div>
          </div>
          <div className="mt-8 px-3 text-[9px] font-bold uppercase tracking-[0.18em] text-[#79969b]">Workspace</div>
          <nav className="mt-3 space-y-1">
            {navItems.map((item) => <button key={item.id} onClick={() => { setActiveNav(item.id); notify(`${item.label} view selected`); }} className={`flex min-h-[44px] w-full items-center gap-3 rounded-xl px-3 text-left text-[12px] font-semibold transition ${activeNav === item.id ? "bg-[#d4f3e8] text-[#173641]" : "text-[#a5bbb9] hover:bg-[#24414b] hover:text-white"}`}><Icon name={item.icon} size={17} /><span>{item.label}</span>{item.id === "registrations" && <span className="ml-auto rounded-full bg-[#f3c96a] px-1.5 py-0.5 text-[9px] text-[#554016]">6</span>}</button>)}
          </nav>
          <div className="mt-8 px-3 text-[9px] font-bold uppercase tracking-[0.18em] text-[#79969b]">Tools</div>
          <nav className="mt-3 space-y-1">
            <button onClick={() => notify("Reports are ready to export")} className="flex min-h-[44px] w-full items-center gap-3 rounded-xl px-3 text-left text-[12px] font-semibold text-[#a5bbb9] transition hover:bg-[#24414b] hover:text-white"><Icon name="trend" size={17} />Reports</button>
            <button onClick={() => notify("Help centre opened")} className="flex min-h-[44px] w-full items-center gap-3 rounded-xl px-3 text-left text-[12px] font-semibold text-[#a5bbb9] transition hover:bg-[#24414b] hover:text-white"><Icon name="help" size={17} />Help centre</button>
          </nav>
          <div className="mt-auto rounded-2xl border border-[#38505a] bg-[#1d3944] p-3">
            <div className="flex items-center gap-2"><span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#f3c96a] text-[11px] font-extrabold text-[#54421f]">AK</span><div><div className="text-[11px] font-bold">Ananya Kulkarni</div><div className="text-[9px] text-[#9bb4b4]">Event organiser</div></div></div>
            <button onClick={() => notify("Profile menu opened")} className="mt-3 w-full rounded-lg border border-[#43616a] py-2 text-[10px] font-bold text-[#b2c8c3]">Account settings</button>
          </div>
        </aside>

        <main className="min-w-0 flex-1">
          <header className="sticky top-0 z-20 border-b border-[#e1e7e2] bg-[#f3f6f3]/95 px-4 py-3 backdrop-blur-md sm:px-6 lg:px-10">
            <div className="mx-auto flex max-w-[1240px] items-center justify-between gap-4">
              <div className="flex min-w-0 items-center gap-3 md:hidden">
                <BrandMark small />
                <div className="truncate"><div className="text-[13px] font-extrabold">EventPay <span className="font-medium text-[#78908e]">Sentinel</span></div><div className="text-[10px] text-[#79908f]">Mosaic 2025</div></div>
              </div>
              <div className="hidden items-center gap-2 text-[11px] text-[#73817f] md:flex"><span>Workspace</span><span className="text-[#b2bdb9]">/</span><span className="font-bold text-[#2e4b52]">Event overview</span></div>
              <div className="ml-auto flex items-center gap-2">
                <button onClick={() => notify("No new alerts")} aria-label="Notifications" className="relative flex h-10 w-10 items-center justify-center rounded-xl border border-[#dce4df] bg-[#fbfcfa] text-[#617773] transition hover:bg-white"><Icon name="bell" size={17} /><span className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-[#e57d5e]" /></button>
                <button onClick={() => notify("Support is available")} className="hidden min-h-[40px] items-center gap-2 rounded-xl border border-[#dce4df] bg-[#fbfcfa] px-3 text-[11px] font-bold text-[#526b69] sm:flex"><Icon name="help" size={15} />Support</button>
              </div>
            </div>
          </header>

          <div className="mx-auto max-w-[1240px] px-4 pb-24 pt-5 sm:px-6 sm:pt-7 lg:px-10 lg:pb-12">
            <section className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
              <div>
                <p className="mb-2 font-['Space_Mono'] text-[10px] font-bold uppercase tracking-[0.16em] text-[#718784]">Tuesday · 11 March 2025</p>
                <h1 className="text-[26px] font-extrabold tracking-[-0.055em] text-[#172c3b] sm:text-[32px]">Good morning, Ananya.</h1>
                <p className="mt-2 max-w-[560px] text-[13px] leading-6 text-[#6e7d7d]">Here is the payment truth for your event. You have one clear thing to take care of today.</p>
              </div>
              <label className="relative flex min-h-[44px] w-full items-center rounded-xl border border-[#d9e2dc] bg-[#fbfcfa] px-3 sm:w-[250px]">
                <span className="mr-2 text-[#63807b]"><Icon name="grid" size={15} /></span>
                <select value={event} onChange={(e) => { setEvent(e.target.value); notify("Event context updated"); }} className="w-full appearance-none bg-transparent pr-6 text-[11px] font-bold text-[#2a454e] outline-none">
                  <option>Mosaic 2025 · Spring Showcase</option><option>Campus Night Run · April</option><option>Design Society · Open House</option>
                </select>
                <span className="pointer-events-none absolute right-3 text-[#79908f]"><Icon name="chevron" size={14} /></span>
              </label>
            </section>

            <section className="relative mb-5 overflow-hidden rounded-[22px] border border-[#295a59] bg-[#1d4a4d] p-5 text-white shadow-[0_14px_35px_rgba(29,74,77,0.12)] sm:p-7">
              <div className="absolute -right-14 -top-20 h-56 w-56 rounded-full border-[28px] border-[#3a6b67]/30" /><div className="absolute -bottom-24 right-20 h-44 w-44 rounded-full border-[20px] border-[#e7bd5f]/10" />
              <div className="relative flex flex-col gap-7 lg:flex-row lg:items-center lg:justify-between">
                <div className="max-w-[660px]">
                  <div className="mb-3 flex items-center gap-2"><span className="rounded-full bg-[#d4f3e8] px-2.5 py-1 font-['Space_Mono'] text-[9px] font-bold uppercase tracking-[0.13em] text-[#1c695b]">Event health · 86/100</span><span className="text-[10px] font-semibold text-[#a8cac2]">Updated 2 min ago</span></div>
                  <h2 className="text-[22px] font-extrabold tracking-[-0.04em] sm:text-[27px]">Mostly ready. A few payments need your eye.</h2>
                  <p className="mt-2 max-w-[540px] text-[12px] leading-5 text-[#b9d1ca]">238 people are verified and ready to enter. Four registrations are waiting on a human check before the gates open.</p>
                  <div className="mt-5 flex flex-col gap-2 sm:flex-row">
                    <button onClick={() => setReviewOpen((value) => !value)} className="flex min-h-[44px] items-center justify-center gap-2 rounded-xl bg-[#f3c96a] px-4 text-[12px] font-extrabold text-[#3b3c2b] transition hover:bg-[#f6d98f]"><Icon name="shield" size={15} />{reviewOpen ? "Close review queue" : "Review 4 exceptions"}<Icon name="arrow" size={14} /></button>
                    <button onClick={() => notify("Entry view link copied")} className="flex min-h-[44px] items-center justify-center gap-2 rounded-xl border border-[#6d9891] px-4 text-[12px] font-bold text-[#e1efea] transition hover:bg-[#2d5b5e]">Share entry view</button>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-4 rounded-2xl border border-[#477874] bg-[#214f50]/80 px-4 py-3 sm:px-5">
                  <div className="relative flex h-[68px] w-[68px] items-center justify-center">
                    <svg className="absolute inset-0 -rotate-90" viewBox="0 0 80 80"><circle cx="40" cy="40" r="33" fill="none" stroke="#356764" strokeWidth="7" /><circle cx="40" cy="40" r="33" fill="none" stroke="#f3c96a" strokeWidth="7" strokeLinecap="round" strokeDasharray="207" strokeDashoffset="29" /></svg>
                    <span className="font-['Space_Grotesk'] text-[20px] font-semibold">86</span>
                  </div>
                  <div><div className="text-[11px] font-bold text-[#d7e8e1]">Healthy event</div><div className="mt-1 max-w-[130px] text-[10px] leading-4 text-[#9fc2ba]">Strong payment match rate</div></div>
                </div>
              </div>
            </section>

            {reviewOpen && <section className="mb-5 rounded-2xl border border-[#efc6b8] bg-[#fff8f4] p-4 sm:p-5">
              <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center"><div><div className="flex items-center gap-2 text-[13px] font-extrabold text-[#743e32]"><span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#ffe1d5]"><Icon name="shield" size={13} /></span>Exception review queue</div><p className="mt-1 text-[11px] text-[#95665a]">Resolve these before volunteers start scanning at 4:30 PM.</p></div><button onClick={() => { setReviewOpen(false); notify("All visible exceptions marked for follow-up"); }} className="min-h-[38px] rounded-lg border border-[#e9b5a4] px-3 text-[11px] font-bold text-[#974937]">Mark for follow-up</button></div>
            </section>}

            <section className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
              <MetricCard label="Registrations" value="247" note="+18 today" color="bg-[#e4f2ed] text-[#147963]" icon="users" />
              <MetricCard label="Verified payments" value="238" note="96.4%" color="bg-[#e4f2ed] text-[#147963]" icon="shield" />
              <MetricCard label="Needs review" value="4" note="Action needed" color="bg-[#ffe6de] text-[#b0523b]" icon="help" />
              <MetricCard label="Ready to enter" value="238" note="4:30 PM doors" color="bg-[#fff0c9] text-[#916611]" icon="scan" />
            </section>

            <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(280px,0.8fr)]">
              <section className="min-w-0 rounded-2xl border border-[#e1e7e2] bg-[#fbfcfa] shadow-[0_5px_20px_rgba(25,43,54,0.035)]">
                <div className="border-b border-[#e8ede9] p-4 sm:p-5">
                  <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center"><div><h2 className="text-[15px] font-extrabold tracking-[-0.02em] text-[#25394a]">Registration pulse</h2><p className="mt-1 text-[11px] text-[#7b8988]">The latest people and payment states, in one place.</p></div><button onClick={() => notify("Registration list refreshed")} className="min-h-[36px] self-start rounded-lg px-2 text-[11px] font-bold text-[#27766a] hover:bg-[#e8f3ef]">Refresh list</button></div>
                  <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                    <label className="flex min-h-[40px] min-w-0 flex-1 items-center gap-2 rounded-xl border border-[#dce5df] bg-[#f6f9f6] px-3 text-[#7a8b87]"><Icon name="search" size={15} /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name or registration ID" className="min-w-0 flex-1 bg-transparent text-[11px] text-[#2a414d] outline-none placeholder:text-[#9aa7a4]" /></label>
                    <button onClick={() => setSortAsc((value) => !value)} className="flex min-h-[40px] items-center justify-center gap-2 rounded-xl border border-[#dce5df] bg-[#f6f9f6] px-3 text-[11px] font-bold text-[#667a77] transition hover:border-[#9bb9ae]"><Icon name="sort" size={14} />{sortAsc ? "A–Z" : "Recent"}</button>
                  </div>
                  <div className="mt-3 flex gap-1.5 overflow-x-auto pb-0.5">
                    {(["All", "Verified", "Pending", "Review", "Refunded"] as const).map((item) => <button key={item} onClick={() => setStatus(item)} className={`min-h-[32px] shrink-0 rounded-lg px-3 text-[10px] font-bold transition ${status === item ? "bg-[#1d4a4d] text-white" : "bg-[#eff3ef] text-[#71817d] hover:bg-[#e5ece7]"}`}>{item}{item === "Review" && <span className="ml-1.5 rounded bg-[#ffe0d6] px-1 text-[9px] text-[#a84936]">4</span>}</button>)}
                  </div>
                </div>
                <div className="hidden overflow-x-auto md:block">
                  <table className="w-full min-w-[600px] border-collapse text-left">
                    <thead><tr className="border-b border-[#e8ede9] text-[9px] font-bold uppercase tracking-[0.12em] text-[#93a09d]"><th className="px-5 py-3">Participant</th><th className="px-3 py-3">Category</th><th className="px-3 py-3">Amount</th><th className="px-3 py-3">Payment state</th><th className="px-5 py-3 text-right">Added</th></tr></thead>
                    <tbody>{filteredRegistrations.map((registration) => <tr key={registration.detail} onClick={() => notify(`${registration.name}'s registration opened`)} className="cursor-pointer border-b border-[#edf0ec] last:border-b-0 hover:bg-[#f4f8f5]"><td className="px-5 py-3.5"><div className="flex items-center gap-3"><span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[10px] font-extrabold ${registration.tone === "teal" ? "bg-[#d9f0e8] text-[#197663]" : registration.tone === "amber" ? "bg-[#fff0cb] text-[#8f6714]" : registration.tone === "coral" ? "bg-[#ffe1d7] text-[#a44c38]" : "bg-[#e8edf1] text-[#6a7680]"}`}>{registration.initials}</span><div><div className="text-[11px] font-bold text-[#304456]">{registration.name}</div><div className="mt-0.5 font-['Space_Mono'] text-[9px] text-[#899692]">{registration.detail.split(" · ")[0]}</div></div></div></td><td className="px-3 py-3 text-[11px] text-[#657671]">{registration.category}</td><td className="px-3 py-3 font-['Space_Mono'] text-[10px] text-[#455b5a]">{registration.amount}</td><td className="px-3 py-3"><StatusPill status={registration.status} /></td><td className="px-5 py-3 text-right text-[10px] text-[#8a9793]">{registration.time}</td></tr>)}</tbody>
                  </table>
                </div>
                <div className="divide-y divide-[#edf0ec] md:hidden">
                  {filteredRegistrations.map((registration) => <button key={registration.detail} onClick={() => notify(`${registration.name}'s registration opened`)} className="flex min-h-[72px] w-full items-center gap-3 px-4 py-3 text-left hover:bg-[#f4f8f5]"><span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[10px] font-extrabold ${registration.tone === "teal" ? "bg-[#d9f0e8] text-[#197663]" : registration.tone === "amber" ? "bg-[#fff0cb] text-[#8f6714]" : registration.tone === "coral" ? "bg-[#ffe1d7] text-[#a44c38]" : "bg-[#e8edf1] text-[#6a7680]"}`}>{registration.initials}</span><span className="min-w-0 flex-1"><span className="block truncate text-[11px] font-bold text-[#304456]">{registration.name}</span><span className="mt-1 block text-[9px] text-[#899692]">{registration.detail} · {registration.time}</span></span><span className="flex shrink-0 flex-col items-end gap-1.5"><span className="font-['Space_Mono'] text-[9px] text-[#455b5a]">{registration.amount}</span><StatusPill status={registration.status} /></span></button>)}
                </div>
                {filteredRegistrations.length === 0 && <div className="p-8 text-center text-[12px] text-[#7d8d88]">No registrations match that search.</div>}
                <div className="border-t border-[#e8ede9] px-4 py-3 sm:px-5"><button onClick={() => { setActiveNav("registrations"); notify("Full registrations view selected"); }} className="flex min-h-[32px] items-center gap-1 text-[11px] font-extrabold text-[#27766a]">View all 247 registrations <Icon name="arrow" size={13} /></button></div>
              </section>

              <div className="space-y-5">
                <section className="rounded-2xl border border-[#e1e7e2] bg-[#fbfcfa] p-4 shadow-[0_5px_20px_rgba(25,43,54,0.035)] sm:p-5">
                  <div className="flex items-start justify-between"><div><h2 className="text-[15px] font-extrabold tracking-[-0.02em] text-[#25394a]">Needs your eye</h2><p className="mt-1 text-[11px] text-[#7b8988]">Small queue, useful context.</p></div><span className="rounded-full bg-[#ffe6de] px-2 py-1 text-[10px] font-bold text-[#a84936]">4 open</span></div>
                  <div className="mt-2"><RiskItem name="Meera Kapoor" issue="Payment link opened, but confirmation is still missing." amount="₹799" onReview={() => { setReviewOpen(true); notify("Meera Kapoor added to review"); }} /><RiskItem name="Sana Iqbal" issue="Volunteer pass has no payment required. Confirm role." amount="Free" onReview={() => { setReviewOpen(true); notify("Sana Iqbal added to review"); }} /></div>
                  <button onClick={() => { setStatus("Review"); notify("Showing all review items"); }} className="mt-4 flex min-h-[38px] w-full items-center justify-center gap-2 rounded-xl border border-[#dce5df] text-[11px] font-bold text-[#52706c] hover:bg-[#f2f7f4]">See all review items <Icon name="arrow" size={13} /></button>
                </section>
                <section className="rounded-2xl border border-[#e1e7e2] bg-[#fbfcfa] p-4 shadow-[0_5px_20px_rgba(25,43,54,0.035)] sm:p-5">
                  <div className="flex items-center justify-between"><div><h2 className="text-[15px] font-extrabold tracking-[-0.02em] text-[#25394a]">Entry readiness</h2><p className="mt-1 text-[11px] text-[#7b8988]">Can volunteers scan?</p></div><span className="flex h-7 w-7 items-center justify-center rounded-full bg-[#e0f5ed] text-[#197663]"><Icon name="check" size={15} stroke={2.2} /></span></div>
                  <div className="mt-5 flex items-end justify-between"><span className="font-['Space_Grotesk'] text-[30px] font-semibold tracking-[-0.07em] text-[#1a3340]">96.4%</span><span className="mb-1 text-[10px] font-bold text-[#197663]">+3.1% this week</span></div>
                  <div className="mt-3 h-2 overflow-hidden rounded-full bg-[#e8eeea]"><div className="h-full w-[96.4%] rounded-full bg-[#47bd95]" /></div>
                  <div className="mt-3 flex justify-between text-[10px] text-[#7b8988]"><span>238 verified</span><span>4 held for review</span></div>
                  <button onClick={() => { setActiveNav("entry"); notify("Entry desk view selected"); }} className="mt-5 flex min-h-[40px] w-full items-center justify-center gap-2 rounded-xl bg-[#e7f2ed] text-[11px] font-extrabold text-[#267366] hover:bg-[#d8ece4]">Open entry desk <Icon name="arrow" size={13} /></button>
                </section>
              </div>
            </div>

            <section className="mt-5 rounded-2xl border border-[#e1e7e2] bg-[#fbfcfa] p-4 shadow-[0_5px_20px_rgba(25,43,54,0.035)] sm:p-5">
              <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center"><div><h2 className="text-[15px] font-extrabold tracking-[-0.02em] text-[#25394a]">What changed today</h2><p className="mt-1 text-[11px] text-[#7b8988]">A quiet audit trail for your team.</p></div><button onClick={() => notify("Activity log opened")} className="self-start text-[11px] font-bold text-[#27766a]">Open activity log <Icon name="arrow" size={12} /></button></div>
              <div className="mt-4 grid gap-3 md:grid-cols-3">
                {[["10:42 AM", "Payment verified", "Aarav Sharma is ready to enter.", "bg-[#e0f5ed] text-[#197663]"], ["10:18 AM", "Form response received", "Registration EP-2047 needs a payment match.", "bg-[#fff0cb] text-[#916611]"], ["09:56 AM", "Entry desk prepared", "8 volunteer passes are ready for scanning.", "bg-[#e7edf3] text-[#5b7082]"]].map(([time, title, detail, tone]) => <div key={time} className="flex gap-3 rounded-xl bg-[#f5f8f5] p-3"><span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${tone}`}><Icon name={title === "Payment verified" ? "check" : title === "Form response received" ? "clock" : "scan"} size={14} /></span><div><div className="font-['Space_Mono'] text-[9px] text-[#85928f]">{time}</div><div className="mt-1 text-[11px] font-extrabold text-[#36505a]">{title}</div><p className="mt-1 text-[10px] leading-4 text-[#7d8c89]">{detail}</p></div></div>)}
              </div>
            </section>
          </div>
        </main>
      </div>

      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t border-[#dce5df] bg-[#fbfcfa]/95 px-2 pb-[max(8px,env(safe-area-inset-bottom))] pt-2 backdrop-blur-md md:hidden">
        {navItems.map((item) => <button key={item.id} onClick={() => { setActiveNav(item.id); notify(`${item.label} view selected`); }} className={`flex min-h-[48px] flex-col items-center justify-center gap-1 rounded-xl text-[9px] font-bold ${activeNav === item.id ? "bg-[#e1f1eb] text-[#267366]" : "text-[#7d8b89]"}`}><Icon name={item.icon} size={17} /><span>{item.id === "entry" ? "Entry" : item.label}</span></button>)}
      </nav>
      {toast && <div className="fixed bottom-[84px] left-1/2 z-40 -translate-x-1/2 rounded-xl bg-[#173641] px-4 py-3 text-center text-[11px] font-bold text-white shadow-[0_12px_30px_rgba(23,54,65,0.2)] md:bottom-6">{toast}</div>}
    </div>
  );
}