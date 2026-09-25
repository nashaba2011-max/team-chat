/* محادثات الفريق — المرحلة ١ (نص فقط) */
(() => {
  "use strict";

  const C = window.APP_CONFIG;
  const PAGE = 50;
  const TZ = "Asia/Bahrain";

  const db = supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true },
  });

  const $ = (s) => document.querySelector(s);
  const state = {
    me: null,
    employees: new Map(),
    convs: [],
    current: null,
    members: [],
    messages: [],
    groupMode: false,
    selected: new Set(),
    channel: null,
    tmpSeq: 0,
    filter: "all",
  };

  // أيقونات ثابتة (نص ثابت من الكود — ما فيه أي بيانات مستخدم)
  const ICONS = {
    announce: '<svg viewBox="0 0 24 24"><path d="M4 10v4h3l7 4V6L7 10z"/><path d="M17.5 9a4 4 0 0 1 0 6"/></svg>',
    check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  };

  /* ================= أدوات عامة ================= */

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text; // دائماً textContent لأي نص من المستخدم
    return n;
  }

  let toastTimer;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 2800);
  }

  function errMsg(e) {
    const m = (e && (e.message || e.error_description)) || String(e || "");
    if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return "تعذر الاتصال — تأكد من الإنترنت وحاول مرة ثانية";
    if (/JWT|expired|not authenticated/i.test(m)) return "انتهت الجلسة — سجّل دخولك من جديد";
    return m || "صار خطأ غير متوقع";
  }

  function initials(name) {
    const parts = String(name || "؟").trim().split(/\s+/);
    // العربي: حرف واحد أوضح (الحروف ما تتشكل صح منفصلة). اللاتيني: حرفين
    if (/[\u0600-\u06FF]/.test(parts[0])) return parts[0][0];
    return ((parts[0]?.[0] || "") + (parts[1]?.[0] || "")).toUpperCase() || "؟";
  }

  const fmtClock = new Intl.DateTimeFormat("ar-BH-u-nu-latn", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
  const fmtWeekday = new Intl.DateTimeFormat("ar-BH-u-nu-latn", { timeZone: TZ, weekday: "long" });
  const fmtDate = new Intl.DateTimeFormat("ar-BH-u-nu-latn", { timeZone: TZ, day: "numeric", month: "numeric", year: "numeric" });
  const fmtLongDate = new Intl.DateTimeFormat("ar-BH-u-nu-latn", { timeZone: TZ, weekday: "long", day: "numeric", month: "long" });
  const dayKey = (d) => new Date(d).toLocaleDateString("en-CA", { timeZone: TZ });

  function daysAgo(ts) {
    const a = new Date(dayKey(ts)), b = new Date(dayKey(Date.now()));
    return Math.round((b - a) / 86400000);
  }
  function listTime(ts) {
    if (!ts) return "";
    const d = daysAgo(ts);
    if (d === 0) return fmtClock.format(new Date(ts));
    if (d === 1) return "أمس";
    if (d < 7) return fmtWeekday.format(new Date(ts));
    return fmtDate.format(new Date(ts));
  }
  function dayLabel(ts) {
    const d = daysAgo(ts);
    if (d === 0) return "اليوم";
    if (d === 1) return "أمس";
    return fmtLongDate.format(new Date(ts));
  }

  const NO_DEPT = "بدون قسم";
  function isAdmin() {
    return state.me?.role === "admin";
  }

  /* ================= التنقل بين الشاشات ================= */

  function showView(name) {
    document.querySelectorAll(".view").forEach((v) => (v.hidden = v.id !== "view-" + name));
  }

  // زر الرجوع في الجوال (أندرويد) يرجع للقائمة بدل ما يطلع من التطبيق
  function navigate(name, { replace = false } = {}) {
    showView(name);
    if (replace) history.replaceState({ v: name }, "");
    else history.pushState({ v: name }, "");
  }

  window.addEventListener("popstate", (e) => {
    if (!state.me) return;
    const v = e.state?.v || "list";
    if (v !== "chat") state.current = null;
    showView(v);
    if (v === "list") loadConversations();
  });

  document.querySelectorAll("[data-back]").forEach((b) => b.addEventListener("click", () => history.back()));

  /* ================= النافذة السفلية ================= */

  const sheet = $("#sheet");
  function openSheet(nodes) {
    const body = $("#sheet-body");
    body.replaceChildren(...nodes);
    if (!sheet.open) sheet.showModal();
  }
  function closeSheet() {
    if (sheet.open) sheet.close();
  }
  sheet.addEventListener("click", (e) => {
    if (e.target === sheet) closeSheet();
  });

  function setLoading(btn, on) {
    btn.disabled = on;
    btn.classList.toggle("loading", on);
  }

  /* ================= الدخول ================= */

  async function boot() {
    if (!C.SUPABASE_ANON_KEY || C.SUPABASE_ANON_KEY.includes("ضع") || C.SUPABASE_URL.includes("ضع")) {
      showView("login");
      $("#login-error").textContent = "الإعداد ناقص: حط رابط المشروع والـ anon key في ملف config.js";
      return;
    }
    try {
      const { data } = await db.auth.getSession();
      if (data.session) await enterApp(data.session.user);
      else showView("login");
    } catch (e) {
      showView("login");
      $("#login-error").textContent = errMsg(e);
    }
  }

  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const no = $("#login-no").value.trim();
    const pass = $("#login-pass").value;
    const errBox = $("#login-error");
    errBox.textContent = "";
    if (!/^[0-9]{1,10}$/.test(no)) return (errBox.textContent = "اكتب رقمك الوظيفي (أرقام فقط)");
    if (!pass) return (errBox.textContent = "اكتب كلمة السر");

    const btn = e.submitter || $("#login-form button");
    setLoading(btn, true);
    try {
      const { data, error } = await db.auth.signInWithPassword({ email: `${no}@${C.EMAIL_DOMAIN}`, password: pass });
      if (error) {
        if (/banned/i.test(error.message)) throw new Error("حسابك موقوف — راجع الإدارة");
        if (/invalid/i.test(error.message)) throw new Error("الرقم الوظيفي أو كلمة السر غير صحيحة");
        throw error;
      }
      $("#login-pass").value = "";
      await enterApp(data.user);
    } catch (err) {
      errBox.textContent = errMsg(err);
    } finally {
      setLoading(btn, false);
    }
  });

  async function enterApp(user) {
    const { data: me, error } = await db
      .from("employees")
      .select("id, employee_no, full_name, job_title, department, role, is_active")
      .eq("id", user.id)
      .maybeSingle();
    if (error) throw error;
    if (!me || !me.is_active) {
      await db.auth.signOut();
      showView("login");
      $("#login-error").textContent = "حسابك غير مفعّل في التطبيق — راجع الإدارة";
      return;
    }
    state.me = me;
    $("#btn-admin").hidden = !isAdmin();
    await loadDirectory();
    startRealtime();
    history.replaceState({ v: "list" }, "");
    showView("list");
    await loadConversations();
  }

  db.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT" && state.me) location.reload();
  });

  /* ================= دليل الموظفين والفروع ================= */

  async function loadDirectory() {
    const { data, error } = await db
      .from("employees")
      .select("id, employee_no, full_name, job_title, department, role, is_active")
      .order("full_name");
    if (error) throw error;
    state.employees = new Map(data.map((e) => [e.id, e]));
  }

  /* ================= قائمة المحادثات ================= */

  let listBusy = false;
  async function loadConversations() {
    if (listBusy) return;
    listBusy = true;
    const errBox = $("#conv-error");
    try {
      const { data, error } = await db.rpc("chat_my_conversations");
      if (error) throw error;
      state.convs = data || [];
      errBox.hidden = true;
      renderConversations();
    } catch (e) {
      errBox.textContent = errMsg(e);
      errBox.hidden = false;
    } finally {
      listBusy = false;
    }
  }

  let refreshTimer;
  function scheduleListRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(loadConversations, 400);
  }

  function convAvatar(c, size = "") {
    const a = el("span", "avatar " + size);
    if (c.kind === "announcement") {
      a.classList.add("announce");
      a.innerHTML = ICONS.announce;
    } else if (c.kind === "group") {
      a.classList.add("group");
      a.textContent = initials(c.title);
    } else {
      a.textContent = initials(c.title);
    }
    return a;
  }

  function renderConversations() {
    const list = $("#conv-list");
    list.replaceChildren();
    const q = $("#conv-search").value.trim();
    const f = state.filter;
    const shown = state.convs.filter(
      (c) =>
        (f === "all" || (f === "unread" && c.unread > 0) || (f === "groups" && c.kind === "group")) &&
        (!q || (c.title || "").includes(q) || (c.last_body || "").includes(q))
    );
    const empty = $("#conv-empty");
    empty.hidden = shown.length > 0;
    if (!state.convs.length) empty.textContent = 'لا توجد محادثات بعد. اضغط "محادثة جديدة" وابدأ مع زميل.';
    else if (q) empty.textContent = "لا توجد نتائج لهذا البحث.";
    else empty.textContent = "لا توجد محادثات في هذا القسم.";

    for (const c of shown) {
      const li = el("li");
      const btn = el("button", "conv");
      if (c.kind === "announcement") btn.classList.add("pinned");
      if (c.unread > 0) btn.classList.add("unread");

      const body = el("span", "conv-body");
      const top = el("span", "conv-top");
      top.append(el("span", "conv-title", c.title || "محادثة"), el("span", "conv-time", c.last_body ? listTime(c.last_message_at) : ""));

      const bottom = el("span", "conv-bottom");
      let preview = "لا توجد رسائل بعد";
      if (c.last_body) {
        if (c.last_sender === state.me.id) preview = "أنت: " + c.last_body;
        else if (c.kind !== "direct") preview = (c.last_sender_name || "").split(" ")[0] + ": " + c.last_body;
        else preview = c.last_body;
      }
      const last = el("span", "conv-last");
      if (c.kind === "announcement") last.append(el("span", "pin-tag", "مثبّتة"));
      last.append(el("span", null, preview.replace(/\s+/g, " ")));
      bottom.append(last);
      if (c.unread > 0) bottom.append(el("span", "badge", c.unread > 99 ? "99+" : String(c.unread)));

      body.append(top, bottom);
      btn.append(convAvatar(c), body);
      btn.addEventListener("click", () => openChat(c));
      li.append(btn);
      list.append(li);
    }
  }

  document.querySelectorAll(".chip-btn").forEach((b) =>
    b.addEventListener("click", () => {
      state.filter = b.dataset.filter;
      document.querySelectorAll(".chip-btn").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      renderConversations();
    })
  );
  $("#conv-search").addEventListener("input", renderConversations);

  /* ================= شاشة المحادثة ================= */

  async function openChat(conv, { replace = false } = {}) {
    state.current = conv;
    state.messages = [];
    state.members = [];
    $("#msg-list").replaceChildren();
    $("#msg-empty").hidden = true;
    $("#btn-older").hidden = true;
    $("#chat-title").textContent = conv.title || "محادثة";
    $("#chat-sub").textContent = "";
    $("#chat-avatar").replaceWith(Object.assign(convAvatar(conv, "sm"), { id: "chat-avatar" }));

    const locked = conv.kind === "announcement" && !isAdmin();
    $("#composer").hidden = locked;
    $("#composer-locked").hidden = !locked;
    $("#msg-input").value = "";
    autosize();

    navigate("chat", { replace });
    autosize();
    await Promise.all([loadMembers(conv), loadMessages()]);
  }

  async function loadMembers(conv) {
    const { data, error } = await db.rpc("chat_members", { p_conv: conv.id });
    if (error || state.current?.id !== conv.id) return;
    state.members = data || [];
    const sub = $("#chat-sub");
    if (conv.kind === "direct") {
      const other = state.members.find((m) => m.id !== state.me.id);
      const emp = other && state.employees.get(other.id);
      if (other && !conv.title) $("#chat-title").textContent = other.full_name;
      sub.textContent = [emp?.job_title, emp?.department].filter(Boolean).join(" • ");
    } else {
      sub.textContent = `${state.members.length} عضو`;
    }
  }

  const MSG_COLS = "id, conversation_id, sender_id, body, created_at";

  async function loadMessages() {
    const conv = state.current;
    try {
      const { data, error } = await db
        .from("messages")
        .select(MSG_COLS)
        .eq("conversation_id", conv.id)
        .order("id", { ascending: false })
        .limit(PAGE);
      if (error) throw error;
      if (state.current?.id !== conv.id) return;
      state.messages = data.reverse();
      $("#btn-older").hidden = data.length < PAGE;
      renderMessages();
      scrollToBottom();
      markRead();
    } catch (e) {
      $("#msg-empty").textContent = errMsg(e);
      $("#msg-empty").hidden = false;
    }
  }

  $("#btn-older").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const conv = state.current;
    const oldest = state.messages.find((m) => typeof m.id === "number");
    if (!oldest) return;
    setLoading(btn, true);
    try {
      const { data, error } = await db
        .from("messages")
        .select(MSG_COLS)
        .eq("conversation_id", conv.id)
        .lt("id", oldest.id)
        .order("id", { ascending: false })
        .limit(PAGE);
      if (error) throw error;
      const scroller = $("#msg-scroll");
      const fromBottom = scroller.scrollHeight - scroller.scrollTop;
      state.messages = data.reverse().concat(state.messages);
      btn.hidden = data.length < PAGE;
      renderMessages();
      scroller.scrollTop = scroller.scrollHeight - fromBottom; // يحافظ على مكانك
    } catch (err) {
      toast(errMsg(err));
    } finally {
      setLoading(btn, false);
    }
  });

  function renderMessages() {
    const list = $("#msg-list");
    list.replaceChildren();
    $("#msg-empty").hidden = state.messages.length > 0;
    const showNames = state.current && state.current.kind !== "direct";
    let prev = null;

    for (const m of state.messages) {
      const day = dayKey(m.created_at);
      if (!prev || dayKey(prev.created_at) !== day) {
        const sep = el("div", "day-sep");
        sep.append(el("span", null, dayLabel(m.created_at)));
        list.append(sep);
        prev = null;
      }
      const mine = m.sender_id === state.me.id;
      const first =
        !prev || prev.sender_id !== m.sender_id || new Date(m.created_at) - new Date(prev.created_at) > 5 * 60000;

      const row = el("div", "msg " + (mine ? "mine" : "theirs") + (first ? " first" : ""));
      if (m.pending) row.classList.add("pending");
      if (m.failed) row.classList.add("failed");

      const bubble = el("div", "bubble");
      if (showNames && !mine && first) {
        bubble.append(el("span", "sender", state.employees.get(m.sender_id)?.full_name || "موظف"));
      }
      bubble.append(document.createTextNode(m.body));
      const meta = m.failed
        ? "لم تُرسل — اضغط لإعادة المحاولة"
        : m.pending
        ? "جاري الإرسال…"
        : fmtClock.format(new Date(m.created_at));
      const metaEl = el("span", "meta", meta);
      if (mine && !m.pending && !m.failed) metaEl.insertAdjacentHTML("beforeend", ICONS.check);
      bubble.append(metaEl);
      if (m.failed) bubble.addEventListener("click", () => retry(m));

      row.append(bubble);
      list.append(row);
      prev = m;
    }
  }

  function scrollToBottom() {
    const s = $("#msg-scroll");
    s.scrollTop = s.scrollHeight;
  }
  function nearBottom() {
    const s = $("#msg-scroll");
    return s.scrollHeight - s.scrollTop - s.clientHeight < 120;
  }

  async function markRead() {
    const conv = state.current;
    if (!conv || document.visibilityState !== "visible") return;
    await db.rpc("chat_mark_read", { p_conv: conv.id });
  }

  function addIncoming(m) {
    if (state.messages.some((x) => x.id === m.id)) return false;
    const stick = nearBottom();
    state.messages.push(m);
    renderMessages();
    if (stick || m.sender_id === state.me.id) scrollToBottom();
    return true;
  }

  /* ----- الإرسال ----- */

  const input = $("#msg-input");
  function autosize() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 140) + "px";
    $("#btn-send").disabled = !input.value.trim();
  }
  input.addEventListener("input", autosize);
  input.addEventListener("focus", () => setTimeout(scrollToBottom, 300));

  $("#composer").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || !state.current) return;
    if (text.length > 4000) return toast("الرسالة طويلة — الحد ٤٠٠٠ حرف");
    input.value = "";
    autosize();
    input.focus();
    const tmp = {
      id: "tmp-" + ++state.tmpSeq,
      conversation_id: state.current.id,
      sender_id: state.me.id,
      body: text,
      created_at: new Date().toISOString(),
      pending: true,
    };
    state.messages.push(tmp);
    renderMessages();
    scrollToBottom();
    deliver(tmp);
  });

  async function deliver(tmp) {
    try {
      const { data, error } = await db
        .from("messages")
        .insert({ conversation_id: tmp.conversation_id, sender_id: tmp.sender_id, body: tmp.body })
        .select(MSG_COLS)
        .single();
      if (error) throw error;
      const i = state.messages.indexOf(tmp);
      if (i === -1) return;
      // لو وصلت نفس الرسالة من الـ realtime قبل الرد، نشيل المؤقتة بس
      if (state.messages.some((x) => x.id === data.id)) state.messages.splice(i, 1);
      else state.messages[i] = data;
      if (state.current?.id === tmp.conversation_id) renderMessages();
    } catch (e) {
      tmp.pending = false;
      tmp.failed = true;
      if (state.current?.id === tmp.conversation_id) renderMessages();
      toast(errMsg(e));
    }
  }

  function retry(m) {
    m.failed = false;
    m.pending = true;
    renderMessages();
    deliver(m);
  }

  /* ----- معلومات المحادثة ----- */

  $("#chat-head").addEventListener("click", () => {
    const conv = state.current;
    if (!conv) return;
    const nodes = [el("h2", null, conv.title || "محادثة")];
    if (conv.kind === "direct") {
      const other = state.members.find((m) => m.id !== state.me.id);
      const emp = other && state.employees.get(other.id);
      if (emp) {
        nodes.push(el("p", null, [emp.job_title, emp.department].filter(Boolean).join(" • ") || "موظف"));
      }
    } else {
      nodes.push(el("p", "muted small", `${state.members.length} عضو`));
      for (const m of state.members) {
        const row = el("div", "member");
        const av = el("span", "avatar sm", initials(m.full_name));
        const txt = el("span", "emp-body");
        txt.append(el("strong", null, m.full_name + (m.id === state.me.id ? " (أنت)" : "")), el("small", null, m.job_title || ""));
        row.append(av, txt);
        if (m.is_admin) row.append(el("span", "chip admin", "مشرف"));
        nodes.push(row);
      }
    }
    const close = el("button", "btn ghost block", "إغلاق");
    close.addEventListener("click", closeSheet);
    nodes.push(close);
    openSheet(nodes);
  });

  /* ================= الرسائل اللحظية ================= */

  function startRealtime() {
    if (state.channel) db.removeChannel(state.channel);
    // RLS تضمن إن كل موظف يستقبل رسائل محادثاته فقط
    state.channel = db
      .channel("inbox")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, ({ new: m }) => {
        if (state.current && m.conversation_id === state.current.id) {
          if (addIncoming(m) && m.sender_id !== state.me.id) markRead();
        } else if (m.sender_id !== state.me.id && navigator.vibrate) {
          navigator.vibrate(60);
        }
        scheduleListRefresh();
      })
      .subscribe();
  }

  // الجوال يوقف الاتصال لما التطبيق بالخلفية — نلحق اللي فاتنا لما يرجع
  async function catchUp() {
    if (!state.me) return;
    scheduleListRefresh();
    const conv = state.current;
    if (!conv) return;
    const last = [...state.messages].reverse().find((m) => typeof m.id === "number");
    let q = db.from("messages").select(MSG_COLS).eq("conversation_id", conv.id).order("id", { ascending: true }).limit(200);
    if (last) q = q.gt("id", last.id);
    const { data, error } = await q;
    if (error || state.current?.id !== conv.id) return;
    let added = false;
    for (const m of data) if (!state.messages.some((x) => x.id === m.id)) (state.messages.push(m), (added = true));
    if (added) {
      renderMessages();
      scrollToBottom();
    }
    markRead();
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") catchUp();
  });
  const net = () => ($("#net-banner").hidden = navigator.onLine);
  window.addEventListener("online", () => (net(), catchUp()));
  window.addEventListener("offline", net);

  /* ================= محادثة جديدة ================= */

  $("#btn-new").addEventListener("click", () => {
    state.groupMode = false;
    state.selected.clear();
    $("#emp-search").value = "";
    applyGroupMode();
    navigate("new");
    renderDirectory();
  });

  $("#emp-search").addEventListener("input", renderDirectory);

  $("#btn-group-mode").addEventListener("click", () => {
    state.groupMode = true;
    applyGroupMode();
    renderDirectory();
    $("#group-name").focus();
  });

  function applyGroupMode() {
    $("#new-title").textContent = state.groupMode ? "مجموعة جديدة" : "محادثة جديدة";
    $("#group-bar").hidden = !state.groupMode;
    $("#btn-group-mode").hidden = state.groupMode;
    $("#group-name").value = "";
    updateGroupBtn();
  }

  function updateGroupBtn() {
    $("#group-count").textContent = state.selected.size;
    $("#btn-create-group").disabled = state.selected.size === 0 || $("#group-name").value.trim().length < 2;
  }
  $("#group-name").addEventListener("input", updateGroupBtn);

  function renderDirectory() {
    const q = $("#emp-search").value.trim();
    const box = $("#emp-list");
    box.replaceChildren();

    const groups = new Map(); // القسم ← موظفين
    for (const e of state.employees.values()) {
      if (!e.is_active || e.id === state.me.id) continue;
      const bname = e.department || NO_DEPT;
      if (q && !`${e.full_name} ${e.job_title || ""} ${bname}`.includes(q)) continue;
      if (!groups.has(bname)) groups.set(bname, []);
      groups.get(bname).push(e);
    }

    if (!groups.size) {
      box.append(el("p", "empty", q ? "ما فيه نتائج لهذا البحث" : "ما فيه موظفين مضافين للحين"));
      return;
    }

    const names = [...groups.keys()].sort((a, b) => (a === NO_DEPT ? 1 : b === NO_DEPT ? -1 : a.localeCompare(b, "ar")));
    for (const bname of names) {
      box.append(el("h2", "section-h", bname));
      for (const e of groups.get(bname)) {
        const row = el("button", "emp");
        if (state.selected.has(e.id)) row.classList.add("selected");
        const txt = el("span", "emp-body");
        txt.append(el("strong", null, e.full_name), el("small", null, e.job_title || ""));
        row.append(el("span", "avatar sm", initials(e.full_name)), txt);
        if (state.groupMode) row.append(el("span", "check"));
        row.addEventListener("click", () => pickEmployee(e, row));
        box.append(row);
      }
    }
  }

  async function pickEmployee(e, row) {
    if (state.groupMode) {
      if (state.selected.has(e.id)) state.selected.delete(e.id);
      else state.selected.add(e.id);
      row.classList.toggle("selected");
      updateGroupBtn();
      return;
    }
    row.disabled = true;
    try {
      const { data: id, error } = await db.rpc("chat_open_direct", { p_other: e.id });
      if (error) throw error;
      await openChat({ id, kind: "direct", title: e.full_name }, { replace: true });
    } catch (err) {
      toast(errMsg(err));
    } finally {
      row.disabled = false;
    }
  }

  $("#btn-create-group").addEventListener("click", async (ev) => {
    const btn = ev.currentTarget;
    const title = $("#group-name").value.trim();
    setLoading(btn, true);
    try {
      const { data: id, error } = await db.rpc("chat_create_group", { p_title: title, p_members: [...state.selected] });
      if (error) throw error;
      toast("تم إنشاء المجموعة");
      await openChat({ id, kind: "group", title }, { replace: true });
    } catch (err) {
      toast(errMsg(err));
    } finally {
      setLoading(btn, false);
      updateGroupBtn();
    }
  });

  /* ================= حسابي ================= */

  $("#btn-me").addEventListener("click", () => {
    const me = state.me;
    const h = el("h2", null, me.full_name);
    const p = el("p", "muted", [`رقم وظيفي ${me.employee_no}`, me.job_title, me.department].filter(Boolean).join(" • "));
    const out = el("button", "btn danger block", "تسجيل خروج");
    out.addEventListener("click", async () => {
      setLoading(out, true);
      if (state.channel) db.removeChannel(state.channel);
      await db.auth.signOut();
      location.reload();
    });
    const close = el("button", "btn ghost block", "إغلاق");
    close.addEventListener("click", closeSheet);
    openSheet([h, p, out, close]);
  });

  /* ================= إدارة الموظفين (للمدير) ================= */

  async function callAdmin(payload) {
    const { data, error } = await db.functions.invoke(C.ADMIN_FUNCTION || "admin-users", { body: payload });
    if (error) {
      let msg = error.message;
      try {
        const b = await error.context.json();
        msg = b.error || msg;
      } catch (_) {}
      throw new Error(msg);
    }
    if (data?.error) throw new Error(data.error);
    return data;
  }

  $("#btn-admin").addEventListener("click", async () => {
    navigate("admin");
    $("#admin-search").value = "";
    renderAdmin();
    try {
      await loadDirectory();
      renderAdmin();
    } catch (e) {
      toast(errMsg(e));
    }
  });
  $("#admin-search").addEventListener("input", renderAdmin);

  function renderAdmin() {
    const q = $("#admin-search").value.trim();
    const box = $("#admin-list");
    box.replaceChildren();
    const list = [...state.employees.values()].filter(
      (e) => !q || `${e.full_name} ${e.employee_no} ${e.job_title || ""} ${e.department || ""}`.includes(q)
    );
    if (!list.length) return box.append(el("p", "empty", q ? "ما فيه نتائج" : "أضف أول موظف من زر ＋"));

    list.sort((a, b) => Number(b.is_active) - Number(a.is_active) || a.full_name.localeCompare(b.full_name, "ar"));
    for (const e of list) {
      const row = el("button", "emp");
      const txt = el("span", "emp-body");
      txt.append(
        el("strong", null, e.full_name),
        el("small", null, [`#${e.employee_no}`, e.job_title, e.department].filter(Boolean).join(" • "))
      );
      row.append(el("span", "avatar sm", initials(e.full_name)), txt);
      if (e.role === "admin") row.append(el("span", "chip admin", "إدارة"));
      if (!e.is_active) row.append(el("span", "chip off", "موقوف"));
      row.addEventListener("click", () => editEmployeeSheet(e));
      box.append(row);
    }
  }

  // القسم نص حر، مع اقتراح الأقسام الموجودة حتى ما تتكرر بأسماء مختلفة
  function departmentInput(value) {
    const list = document.getElementById("dept-list") || document.body.appendChild(Object.assign(document.createElement("datalist"), { id: "dept-list" }));
    const names = [...new Set([...state.employees.values()].map((e) => e.department).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ar"));
    list.replaceChildren(...names.map((n) => new Option(n)));
    const i = textInput(value || "", { maxLength: 60, placeholder: "مثال: المحاسبة، الموارد البشرية" });
    i.setAttribute("list", "dept-list");
    return i;
  }
  function roleSelect(selected) {
    const s = document.createElement("select");
    s.append(new Option("موظف", "staff", false, selected !== "admin"), new Option("إدارة", "admin", false, selected === "admin"));
    return s;
  }
  function field(labelText, control, id) {
    control.id = id;
    const l = el("label", null, labelText);
    l.htmlFor = id;
    return [l, control];
  }
  function textInput(value = "", attrs = {}) {
    const i = document.createElement("input");
    i.type = "text";
    i.value = value;
    Object.assign(i, attrs);
    return i;
  }
  function randomPass() {
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    return String(100000 + (a[0] % 900000));
  }

  $("#btn-add-emp").addEventListener("click", () => {
    const form = el("form", "form");
    const no = textInput("", { inputMode: "numeric", dir: "ltr", maxLength: 10 });
    const name = textInput("", { maxLength: 80 });
    const job = textInput("", { maxLength: 60, placeholder: "مثال: محاسب، سكرتير، مدير قسم" });
    const br = departmentInput("");
    const role = roleSelect("staff");
    const pass = textInput(randomPass(), { dir: "ltr" });
    const err = el("p", "field-error");
    const save = el("button", "btn primary block", "إضافة الموظف");
    save.type = "submit";

    form.append(
      ...field("الرقم الوظيفي", no, "f-no"),
      ...field("الاسم الكامل", name, "f-name"),
      ...field("الوظيفة", job, "f-job"),
      ...field("القسم (اختياري)", br, "f-dept"),
      ...field("الصلاحية", role, "f-role"),
      ...field("كلمة السر المبدئية", pass, "f-pass"),
      err,
      save
    );

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      err.textContent = "";
      if (!/^[0-9]{1,10}$/.test(no.value.trim())) return (err.textContent = "الرقم الوظيفي أرقام فقط");
      if (name.value.trim().length < 2) return (err.textContent = "اكتب اسم الموظف");
      if (pass.value.length < 6) return (err.textContent = "كلمة السر ٦ خانات على الأقل");
      setLoading(save, true);
      try {
        await callAdmin({
          action: "create",
          employee_no: no.value.trim(),
          full_name: name.value.trim(),
          job_title: job.value.trim(),
          department: br.value.trim(),
          role: role.value,
          password: pass.value,
        });
        await loadDirectory();
        renderAdmin();
        credentialsSheet(name.value.trim(), no.value.trim(), pass.value);
      } catch (ex) {
        err.textContent = errMsg(ex);
      } finally {
        setLoading(save, false);
      }
    });

    openSheet([el("h2", null, "موظف جديد"), form]);
    no.focus();
  });

  function credentialsSheet(name, no, pass) {
    const text = `هلا ${name}\nتطبيق محادثات الفريق: ${location.href.split("#")[0]}\nالرقم الوظيفي: ${no}\nكلمة السر: ${pass}`;
    const pre = el("p", "card", text);
    pre.style.whiteSpace = "pre-wrap";
    const copy = el("button", "btn primary block", "نسخ وإرسال للموظف");
    copy.addEventListener("click", async () => {
      try {
        if (navigator.share) await navigator.share({ text });
        else {
          await navigator.clipboard.writeText(text);
          toast("تم النسخ");
        }
      } catch (_) {}
    });
    const done = el("button", "btn ghost block", "تم");
    done.addEventListener("click", closeSheet);
    openSheet([el("h2", null, "تمت إضافة الموظف ✓"), pre, copy, done]);
  }

  function editEmployeeSheet(emp) {
    const form = el("form", "form");
    const name = textInput(emp.full_name, { maxLength: 80 });
    const job = textInput(emp.job_title || "", { maxLength: 60 });
    const br = departmentInput(emp.department);
    const role = roleSelect(emp.role);
    const err = el("p", "field-error");
    const save = el("button", "btn primary block", "حفظ التعديلات");
    save.type = "submit";
    form.append(...field("الاسم", name, "e-name"), ...field("الوظيفة", job, "e-job"), ...field("القسم", br, "e-dept"), ...field("الصلاحية", role, "e-role"), err, save);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      err.textContent = "";
      setLoading(save, true);
      try {
        await callAdmin({ action: "update", id: emp.id, full_name: name.value, job_title: job.value, department: br.value, role: role.value });
        await loadDirectory();
        renderAdmin();
        closeSheet();
        toast("تم الحفظ ✓");
      } catch (ex) {
        err.textContent = errMsg(ex);
      } finally {
        setLoading(save, false);
      }
    });

    const resetBtn = el("button", "btn ghost block", "تغيير كلمة السر");
    resetBtn.addEventListener("click", async () => {
      const np = randomPass();
      setLoading(resetBtn, true);
      try {
        await callAdmin({ action: "reset_password", id: emp.id, password: np });
        credentialsSheet(emp.full_name, emp.employee_no, np);
      } catch (ex) {
        err.textContent = errMsg(ex);
      } finally {
        setLoading(resetBtn, false);
      }
    });

    const toggle = el("button", emp.is_active ? "btn danger block" : "btn primary block", emp.is_active ? "إيقاف الحساب" : "إعادة تفعيل الحساب");
    toggle.addEventListener("click", async () => {
      if (emp.is_active && !confirm(`إيقاف ${emp.full_name}؟ ما راح يقدر يدخل أو يشوف أي محادثة.`)) return;
      setLoading(toggle, true);
      try {
        await callAdmin({ action: "set_active", id: emp.id, active: !emp.is_active });
        await loadDirectory();
        renderAdmin();
        closeSheet();
        toast(emp.is_active ? "تم إيقاف الحساب" : "تم تفعيل الحساب");
      } catch (ex) {
        err.textContent = errMsg(ex);
      } finally {
        setLoading(toggle, false);
      }
    });

    const sub = el("p", "muted small", `رقم وظيفي ${emp.employee_no}`);
    openSheet([el("h2", null, emp.full_name), sub, form, resetBtn, toggle]);
  }

  /* ================= تشغيل ================= */

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  net();
  boot();
})();
