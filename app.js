(() => {
  "use strict";

  const CLIENT_ID = window.APP_CONFIG && window.APP_CONFIG.GOOGLE_CLIENT_ID;
  const SCOPES = [
    "https://www.googleapis.com/auth/calendar.readonly",
    "openid",
    "email",
  ].join(" ");
  // ホーム画面から起動した場合でもリダイレクト後に戻ってこられるよう、同じ URL に戻す
  const REDIRECT_URI = location.origin + location.pathname;

  const KEY_TOKEN = "today.token";
  const KEY_STATE = "today.oauthState";
  const KEY_EMAIL = "today.email";
  const KEY_SILENT = "today.silentTriedAt";
  const KEY_RANGE = "today.range";
  const KEY_HIDDEN_CALS = "today.hiddenCalendars";

  const $ = (id) => document.getElementById(id);
  const el = {
    date: $("date"),
    title: $("title"),
    tabs: $("tabs"),
    settingsBtn: $("settings-btn"),
    settings: $("settings"),
    calendarList: $("calendar-list"),
    selectAll: $("select-all"),
    selectNone: $("select-none"),
    settingsDone: $("settings-done"),
    actions: $("actions"),
    refresh: $("refresh"),
    logout: $("logout"),
    login: $("login"),
    loginBtn: $("login-btn"),
    installHint: $("install-hint"),
    status: $("status"),
    account: $("account"),
    events: $("events"),
  };

  // ---------- storage ----------
  const store = {
    get(key) {
      try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
    },
    del(key) {
      try { localStorage.removeItem(key); } catch { /* private mode */ }
    },
  };

  function validToken() {
    const t = store.get(KEY_TOKEN);
    // 期限の 1 分前には期限切れとして扱う
    return t && t.accessToken && t.expiresAt - 60_000 > Date.now() ? t.accessToken : null;
  }

  // ---------- OAuth (implicit flow / redirect) ----------
  // iOS のホーム画面アプリではポップアップが不安定なため、リダイレクト方式で認可する。
  function startAuth({ silent = false, reconsent = false } = {}) {
    const state = crypto.getRandomValues(new Uint32Array(4)).join("-");
    store.set(KEY_STATE, state);
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: "token",
      scope: SCOPES,
      include_granted_scopes: "true",
      state,
    });
    const email = store.get(KEY_EMAIL);
    if (email) params.set("login_hint", email);
    if (silent) {
      params.set("prompt", "none");
      store.set(KEY_SILENT, Date.now());
    } else {
      params.set("prompt", reconsent ? "consent select_account" : "select_account");
    }
    location.assign("https://accounts.google.com/o/oauth2/v2/auth?" + params);
  }

  // リダイレクトで戻ってきたときの URL フラグメントを処理する。
  // 戻り値: "ok" | "silent_failed" | "error" | null (フラグメントなし)
  function handleRedirect() {
    if (!location.hash || location.hash.length < 2) return null;
    const p = new URLSearchParams(location.hash.slice(1));
    if (!p.has("access_token") && !p.has("error")) return null;

    history.replaceState(null, "", location.pathname + location.search);
    const expected = store.get(KEY_STATE);
    store.del(KEY_STATE);
    if (!expected || p.get("state") !== expected) return "error";
    if (p.has("error")) {
      // prompt=none で再ログインが必要と判定された場合は、通常のログイン画面を出すだけにする
      const silentErrors = ["interaction_required", "login_required", "consent_required"];
      return silentErrors.includes(p.get("error")) ? "silent_failed" : "error";
    }

    store.set(KEY_TOKEN, {
      accessToken: p.get("access_token"),
      expiresAt: Date.now() + Number(p.get("expires_in") || 3600) * 1000,
    });
    store.del(KEY_SILENT);
    return "ok";
  }

  // トークン切れ時、以前ログインしていれば画面操作なしで再取得を試みる（1 分以内の連続試行はしない）
  function trySilentReauth() {
    const email = store.get(KEY_EMAIL);
    const last = store.get(KEY_SILENT) || 0;
    if (email && Date.now() - last > 60_000) {
      startAuth({ silent: true });
      return true;
    }
    return false;
  }

  async function logout() {
    const token = validToken();
    store.del(KEY_TOKEN);
    store.del(KEY_EMAIL);
    store.del(KEY_SILENT);
    store.del("superapp.mailCache"); // メールの要約も端末から消す
    if (token) {
      fetch("https://oauth2.googleapis.com/revoke?token=" + encodeURIComponent(token), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }).catch(() => {});
    }
    showLogin();
  }

  // ---------- Google API ----------
  class AuthError extends Error {}
  class ScopeError extends Error {}

  async function api(url) {
    const token = validToken();
    if (!token) throw new AuthError("no token");
    const res = await fetch(url, { headers: { Authorization: "Bearer " + token } });
    if (res.status === 401) {
      store.del(KEY_TOKEN);
      throw new AuthError("unauthorized");
    }
    if (res.status === 403) {
      const body = await res.json().catch(() => ({}));
      const reasons = ((body.error && body.error.errors) || []).map((e) => e.reason);
      if (reasons.includes("insufficientPermissions") || /scope/i.test((body.error && body.error.message) || "")) {
        throw new ScopeError("insufficient scope");
      }
    }
    if (!res.ok) throw new Error(`API エラー (${res.status})`);
    return res.json();
  }

  // ---------- 表示範囲 ----------
  const RANGES = {
    today: { title: "きょうの予定", empty: "今日の予定はありません 🎉", offset: 0, days: 1 },
    tomorrow: { title: "あしたの予定", empty: "明日の予定はありません", offset: 1, days: 1 },
    week: { title: "今週の予定", empty: "この 7 日間の予定はありません", offset: 0, days: 7 },
  };

  function currentRange() {
    const r = store.get(KEY_RANGE);
    return RANGES[r] ? r : "today";
  }

  function rangeDays(range) {
    const { offset, days } = RANGES[range];
    const first = new Date();
    first.setHours(0, 0, 0, 0);
    first.setDate(first.getDate() + offset);
    return Array.from({ length: days }, (_, i) => {
      const start = new Date(first);
      start.setDate(start.getDate() + i);
      const end = new Date(start);
      end.setDate(end.getDate() + 1);
      return { start, end };
    });
  }

  // ---------- カレンダーの表示設定 ----------
  // 非表示にしたカレンダーの ID を保存する（新しく追加されたカレンダーは自動的に表示される）
  function hiddenCalendarIds() {
    return new Set(store.get(KEY_HIDDEN_CALS) || []);
  }

  let calendars = [];

  async function fetchCalendars() {
    const list = await api(
      "https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader&maxResults=250"
    );
    // 登録済みのカレンダーをすべて候補にする（リストから非表示にしたものは除く）。
    // selected (Web 版の表示チェック) はスマホアプリ中心の使い方だと付かないことがあるため見ない。
    calendars = (list.items || [])
      .filter((c) => !c.hidden && !c.deleted)
      .sort((a, b) => (a.primary ? -1 : b.primary ? 1 : 0));
    return calendars;
  }

  async function fetchEvents(range) {
    const days = rangeDays(range);
    const timeMin = days[0].start;
    const timeMax = days[days.length - 1].end;
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    const hidden = hiddenCalendarIds();
    const targets = (await fetchCalendars()).filter((c) => !hidden.has(c.id));
    let failed = 0;

    const results = await Promise.all(
      targets.map(async (cal) => {
        const params = new URLSearchParams({
          timeMin: timeMin.toISOString(),
          timeMax: timeMax.toISOString(),
          singleEvents: "true",
          orderBy: "startTime",
          maxResults: "250",
          timeZone,
        });
        try {
          const data = await api(
            `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events?${params}`
          );
          return (data.items || []).map((ev) => ({ ev, cal }));
        } catch (e) {
          if (e instanceof AuthError || e instanceof ScopeError) throw e;
          failed++;
          return []; // 1 つのカレンダーが失敗しても他は表示する
        }
      })
    );

    const events = results
      .flat()
      .filter(({ ev, cal }) => ev.status !== "cancelled" && !declinedByMe(ev, cal))
      .map(({ ev, cal }) => normalize(ev, cal));

    // 日ごとに振り分ける（複数日にまたがる予定は該当する日すべてに出す）
    const groups = days.map((day) => ({
      ...day,
      events: events
        .filter((e) => e.start < day.end && e.end > day.start)
        .sort((a, b) => (a.allDay !== b.allDay ? (a.allDay ? -1 : 1) : a.start - b.start)),
    }));
    const count = new Set(groups.flatMap((g) => g.events)).size;
    return { range, groups, count, shown: targets.length, total: calendars.length, failed };
  }

  function declinedByMe(ev, cal) {
    const me = (ev.attendees || []).find((a) => a.self);
    return cal.primary && me && me.responseStatus === "declined";
  }

  function normalize(ev, cal) {
    const allDay = !!(ev.start && ev.start.date);
    const start = allDay ? parseDate(ev.start.date) : new Date(ev.start.dateTime);
    const end = allDay ? parseDate(ev.end.date) : new Date(ev.end.dateTime);
    return {
      title: ev.summary || "(タイトルなし)",
      location: ev.location || "",
      calendar: calendarName(cal),
      color: cal.backgroundColor || "",
      link: ev.htmlLink || "",
      allDay,
      start,
      end,
    };
  }

  function calendarName(cal) {
    return cal.summaryOverride || cal.summary || "";
  }

  // "YYYY-MM-DD" をローカル時刻の 0:00 として解釈する
  function parseDate(s) {
    const [y, m, d] = s.split("-").map(Number);
    return new Date(y, m - 1, d);
  }

  // ---------- rendering ----------
  const timeFmt = new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit" });
  const dayFmt = new Intl.DateTimeFormat("ja-JP", { month: "long", day: "numeric", weekday: "long" });
  const shortDayFmt = new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric", weekday: "short" });

  function renderHeader() {
    const range = currentRange();
    const days = rangeDays(range);
    el.title.textContent = RANGES[range].title;
    el.date.textContent =
      days.length === 1
        ? dayFmt.format(days[0].start)
        : `${shortDayFmt.format(days[0].start)} 〜 ${shortDayFmt.format(days[days.length - 1].start)}`;
    for (const tab of el.tabs.querySelectorAll("[data-range]")) {
      tab.setAttribute("aria-pressed", String(tab.dataset.range === range));
    }
  }

  function setStatus(text, isError = false) {
    el.status.textContent = text;
    el.status.classList.toggle("error", isError);
    el.status.hidden = !text;
  }

  function showLogin(message) {
    el.login.hidden = false;
    el.actions.hidden = true;
    el.tabs.hidden = true;
    el.settings.hidden = true;
    el.account.hidden = true;
    el.events.replaceChildren();
    setStatus(message || "", !!message);
    const standalone = navigator.standalone || matchMedia("(display-mode: standalone)").matches;
    el.installHint.hidden = standalone || !/iPhone|iPad/.test(navigator.userAgent);
  }

  function showMain() {
    el.login.hidden = true;
    el.actions.hidden = false;
    el.tabs.hidden = false;
  }

  // 未完了で、その日が期限のタスク。今日の欄には期限切れのものも出す
  function tasksForDay(tasks, day) {
    const date = localISO(day.start);
    const today = localISO(new Date());
    return (tasks || [])
      .filter((t) => !t.done && t.due && (t.due === date || (date === today && t.due < today)))
      .sort((a, b) => a.due.localeCompare(b.due));
  }

  function localISO(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function renderEvents({ range, groups, count, shown, total, failed }, tasks) {
    showMain();
    setStatus("");

    const dayTasks = groups.map((g) => tasksForDay(tasks, g));
    const taskCount = dayTasks.flat().length;
    const email = store.get(KEY_EMAIL);
    const calText = shown === total ? `${total} カレンダー` : `${shown}/${total} カレンダー`;
    const parts = [email, calText, `${count} 件`].filter(Boolean);
    if (taskCount) parts.push(`期限のタスク ${taskCount} 件`);
    if (failed) parts.push(`${failed} カレンダーは読み込めませんでした`);
    el.account.textContent = parts.join(" ・ ");
    el.account.hidden = false;

    if (count === 0 && !taskCount) {
      const li = document.createElement("li");
      li.className = "card empty";
      li.textContent = shown === 0 ? "表示するカレンダーが選ばれていません（右上の設定ボタンから選べます）" : RANGES[range].empty;
      el.events.replaceChildren(li);
      return;
    }

    const multiDay = groups.length > 1;
    el.events.replaceChildren(
      ...groups.flatMap((g, i) => {
        const items = [...dayTasks[i].map(renderTask), ...g.events.map(renderEvent)];
        if (!multiDay) return items;
        const head = document.createElement("li");
        head.className = "day";
        head.textContent = dayFmt.format(g.start);
        if (!items.length) {
          const none = document.createElement("li");
          none.className = "day__none";
          none.textContent = "予定なし";
          items.push(none);
        }
        return [head, ...items];
      })
    );
  }

  function renderEvent(e) {
    const now = Date.now();
    const li = document.createElement("li");
    const a = document.createElement(e.link ? "a" : "div");
    a.className = "event";
    if (e.link) {
      a.href = e.link;
      a.target = "_blank";
      a.rel = "noopener";
    }
    if (!e.allDay && e.end <= now) a.classList.add("past");
    if (!e.allDay && e.start <= now && now < e.end) a.classList.add("now");

    const bar = document.createElement("span");
    bar.className = "event__bar";
    if (e.color) bar.style.background = e.color;

    const time = document.createElement("div");
    time.className = "event__time";
    if (e.allDay) {
      time.textContent = "終日";
    } else {
      time.textContent = timeFmt.format(e.start);
      const small = document.createElement("small");
      small.textContent = timeFmt.format(e.end);
      time.append(small);
    }

    const body = document.createElement("div");
    body.className = "event__body";
    const title = document.createElement("p");
    title.className = "event__title";
    title.textContent = e.title;
    body.append(title);
    const meta = [e.location, e.calendar].filter(Boolean).join(" ・ ");
    if (meta) {
      const p = document.createElement("p");
      p.className = "event__meta";
      p.textContent = meta;
      body.append(p);
    }

    a.append(bar, time, body);
    li.append(a);
    return li;
  }

  // 期限のあるタスク。タップでタスク画面へ
  function renderTask(t) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "event event--task";
    const over = t.due < localISO(new Date());
    if (over) btn.classList.add("event--over");

    const bar = document.createElement("span");
    bar.className = "event__bar";

    const time = document.createElement("div");
    time.className = "event__time";
    time.textContent = over ? "期限切れ" : "期限";
    if (over) {
      const small = document.createElement("small");
      small.textContent = shortDayFmt.format(parseDate(t.due));
      time.append(small);
    }

    const body = document.createElement("div");
    body.className = "event__body";
    const title = document.createElement("p");
    title.className = "event__title";
    title.textContent = t.title;
    const meta = document.createElement("p");
    meta.className = "event__meta";
    meta.textContent = ["タスク", t.priority && `優先度 ${t.priority}`].filter(Boolean).join(" ・ ");
    body.append(title, meta);

    btn.append(bar, time, body);
    btn.addEventListener("click", () => window.SuperApp.showView("tasks"));
    li.append(btn);
    return li;
  }

  // ---------- 設定画面 ----------
  async function openSettings() {
    el.settings.hidden = false;
    el.events.hidden = true;
    el.account.hidden = true;
    el.tabs.hidden = true;
    setStatus("");
    if (!calendars.length) {
      try {
        await fetchCalendars();
      } catch {
        setStatus("カレンダーの一覧を読み込めませんでした。", true);
      }
    }
    renderCalendarList();
  }

  function renderCalendarList() {
    const hidden = hiddenCalendarIds();
    el.calendarList.replaceChildren(
      ...calendars.map((cal) => {
        const li = document.createElement("li");
        const label = document.createElement("label");
        label.className = "cal-option";
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = !hidden.has(cal.id);
        box.addEventListener("change", () => {
          const h = hiddenCalendarIds();
          if (box.checked) h.delete(cal.id);
          else h.add(cal.id);
          store.set(KEY_HIDDEN_CALS, [...h]);
        });
        const swatch = document.createElement("span");
        swatch.className = "cal-option__swatch";
        if (cal.backgroundColor) swatch.style.background = cal.backgroundColor;
        const name = document.createElement("span");
        name.textContent = calendarName(cal) + (cal.primary ? "（メイン）" : "");
        label.append(box, swatch, name);
        li.append(label);
        return li;
      })
    );
  }

  function setAllCalendars(visible) {
    store.set(KEY_HIDDEN_CALS, visible ? [] : calendars.map((c) => c.id));
    renderCalendarList();
  }

  function closeSettings() {
    el.settings.hidden = true;
    el.events.hidden = false;
    refresh();
  }

  // ---------- main ----------
  let requestSeq = 0;
  let needsReconsent = false;

  async function loadEmail() {
    if (store.get(KEY_EMAIL)) return;
    try {
      const info = await api("https://openidconnect.googleapis.com/v1/userinfo");
      if (info.email) store.set(KEY_EMAIL, info.email);
    } catch (e) {
      if (e instanceof AuthError) throw e;
    }
  }

  async function refresh() {
    if (!el.settings.hidden || window.SuperApp.currentView() !== "calendar") return;
    renderHeader();
    if (!validToken()) {
      if (!trySilentReauth()) showLogin();
      return;
    }
    const seq = ++requestSeq;
    if (!el.events.children.length) setStatus("読み込み中…");
    try {
      await loadEmail();
      const result = await fetchEvents(currentRange());
      // タブを素早く切り替えた場合は、最後に選んだ範囲の結果だけを表示する
      if (seq !== requestSeq) return;
      // タスクは前回の内容ですぐ出し、Notion から届いたら描き直す (読めなくても予定は出す)
      renderEvents(result, window.SuperApp.cachedTasks());
      if (window.SuperApp.serverUrl) {
        window.SuperApp.fetchTasks()
          .then((tasks) => seq === requestSeq && el.settings.hidden && renderEvents(result, tasks))
          .catch(() => {});
      }
    } catch (e) {
      if (seq !== requestSeq) return;
      if (e instanceof ScopeError) {
        needsReconsent = true;
        showLogin("カレンダーへのアクセスが許可されていません。もう一度ログインし、確認画面でカレンダーの項目にチェックを入れてください。");
      } else if (e instanceof AuthError) {
        if (!trySilentReauth()) showLogin("ログインの有効期限が切れました。もう一度ログインしてください。");
      } else {
        setStatus(navigator.onLine ? e.message : "オフラインです。接続を確認してください。", true);
      }
    }
  }

  function init() {
    renderHeader();

    if (!CLIENT_ID || CLIENT_ID.startsWith("YOUR_")) {
      showLogin("config.js に Google OAuth クライアント ID を設定してください。");
      el.loginBtn.disabled = true;
      return;
    }

    el.loginBtn.addEventListener("click", () => startAuth({ reconsent: needsReconsent }));
    el.refresh.addEventListener("click", refresh);
    el.logout.addEventListener("click", logout);
    el.settingsBtn.addEventListener("click", openSettings);
    el.settingsDone.addEventListener("click", closeSettings);
    el.selectAll.addEventListener("click", () => setAllCalendars(true));
    el.selectNone.addEventListener("click", () => setAllCalendars(false));
    el.tabs.addEventListener("click", (ev) => {
      const tab = ev.target.closest("[data-range]");
      if (!tab || tab.dataset.range === currentRange()) return;
      store.set(KEY_RANGE, tab.dataset.range);
      el.events.replaceChildren();
      el.account.hidden = true;
      refresh();
    });
    // ホーム画面アプリに戻ってきたとき（日付が変わった場合も含む）に最新化する
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") refresh();
    });
    document.addEventListener("viewchange", (ev) => {
      if (ev.detail === "calendar") refresh();
    });

    const result = handleRedirect();
    if ((result === "error" || result === "silent_failed") && !validToken()) {
      showLogin(result === "error" ? "ログインできませんでした。もう一度お試しください。" : "");
      return;
    }
    refresh();
  }

  window.SuperApp = Object.assign(window.SuperApp || {}, {
    getToken: validToken,
    // トークンが切れていたら自動での取り直しを試み、できなければ false を返す
    trySilentReauth,
    signIn: () => startAuth({ reconsent: needsReconsent }),
    email: () => store.get(KEY_EMAIL),
    loadEmail: () => loadEmail().catch(() => {}),
    // 今日の画面 (today.js) で使う
    fetchTodayEvents: async () => {
      await loadEmail();
      return (await fetchEvents("today")).groups[0].events;
    },
    renderEvent,
    renderTask,
    isAuthError: (e) => e instanceof AuthError || e instanceof ScopeError,
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  init();
})();
