// 「今日」画面。今日の予定・期限のタスク・メールのまとめを 1 画面に並べる。通知のオン・オフもここで行う。
(() => {
  "use strict";

  const { callServer, NeedLogin, showToast } = window.SuperApp;
  const KEY_NOTIFY_LATER = "superapp.notifyLater";
  const PUSH_CACHE = "superapp-push"; // sw.js と同じ名前

  const $ = (id) => document.getElementById(id);
  const el = {
    date: $("today-date"),
    refresh: $("today-refresh"),
    login: $("today-login"),
    loginBtn: $("today-login-btn"),
    body: $("today-body"),
    events: $("today-events"),
    eventsStatus: $("today-events-status"),
    tasksBlock: $("today-tasks-block"),
    tasks: $("today-tasks"),
    tasksStatus: $("today-tasks-status"),
    mailBlock: $("today-mail-block"),
    mail: $("today-mail"),
    mailLines: $("today-mail-lines"),
    mailReply: $("today-mail-reply"),
    mailStatus: $("today-mail-status"),
    notify: $("today-notify"),
    notifyText: $("today-notify-text"),
    notifyBtn: $("today-notify-btn"),
    notifyLater: $("today-notify-later"),
    push: $("today-push"),
    pushTest: $("today-push-test"),
    pushOff: $("today-push-off"),
  };

  const dayFmt = new Intl.DateTimeFormat("ja-JP", { month: "long", day: "numeric", weekday: "long" });

  function localISO(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function setText(node, text, isError = false) {
    node.textContent = text;
    node.classList.toggle("error", isError);
    node.hidden = !text;
  }

  // ---------- 読み込み ----------
  let loading = false;

  async function load() {
    if (loading || window.SuperApp.currentView() !== "today") return;
    el.date.textContent = dayFmt.format(new Date());
    if (!window.SuperApp.getToken()) {
      if (!window.SuperApp.trySilentReauth()) showLogin();
      return;
    }
    el.login.hidden = true;
    el.body.hidden = false;
    loading = true;
    el.refresh.disabled = true;
    try {
      await Promise.all([loadEvents(), loadTasks(), loadMail(), updatePushUi()]);
    } finally {
      loading = false;
      el.refresh.disabled = false;
    }
  }

  function showLogin() {
    el.login.hidden = false;
    el.body.hidden = true;
    el.notify.hidden = true;
  }

  function offlineOr(text) {
    return navigator.onLine ? text : "オフラインです。接続を確認してください。";
  }

  // ---------- 予定 ----------
  async function loadEvents() {
    if (!el.events.children.length) setText(el.eventsStatus, "読み込み中…");
    try {
      const events = await window.SuperApp.fetchTodayEvents();
      // 終わった予定は省き、これからの予定だけを出す
      const now = Date.now();
      const upcoming = events.filter((e) => e.allDay || e.end > now);
      const done = events.length - upcoming.length;
      setText(el.eventsStatus, "");
      if (!upcoming.length) {
        const li = document.createElement("li");
        li.className = "card empty";
        li.textContent = events.length ? "今日の予定はすべて終わりました" : "今日の予定はありません 🎉";
        el.events.replaceChildren(li);
      } else {
        el.events.replaceChildren(...upcoming.map(window.SuperApp.renderEvent));
      }
      if (done && upcoming.length) {
        const li = document.createElement("li");
        li.className = "day__none";
        li.textContent = `終わった予定 ${done} 件は予定タブで見られます`;
        el.events.append(li);
      }
    } catch (e) {
      if (window.SuperApp.isAuthError(e)) {
        if (!window.SuperApp.trySilentReauth()) showLogin();
        return;
      }
      setText(el.eventsStatus, offlineOr(`予定を読み込めませんでした: ${e.message}`), true);
    }
  }

  // ---------- 期限のタスク ----------
  let tasks = null;

  async function loadTasks() {
    if (!window.SuperApp.serverUrl) {
      el.tasksBlock.hidden = true;
      return;
    }
    if (!tasks) {
      tasks = window.SuperApp.cachedTasks();
      if (tasks) renderTasks();
      else setText(el.tasksStatus, "読み込み中…");
    }
    try {
      tasks = await window.SuperApp.fetchTasks();
      setText(el.tasksStatus, "");
      renderTasks();
    } catch (e) {
      if (e instanceof NeedLogin && e.message === "unauthorized") {
        el.tasksBlock.hidden = true; // サーバーの持ち主以外のアカウントでは使えない
        return;
      }
      setText(el.tasksStatus, offlineOr(`タスクを読み込めませんでした: ${e.message}`), true);
    }
  }

  function renderTasks() {
    el.tasksBlock.hidden = false;
    const today = localISO(new Date());
    const due = tasks
      .filter((t) => !t.done && t.due && t.due <= today)
      .sort((a, b) => a.due.localeCompare(b.due) || a.created.localeCompare(b.created));
    if (!due.length) {
      const li = document.createElement("li");
      li.className = "empty today-empty";
      li.textContent = "今日が期限のタスクはありません";
      el.tasks.replaceChildren(li);
      return;
    }
    el.tasks.replaceChildren(...due.map((t) => renderTask(t, today)));
  }

  function renderTask(t, today) {
    const li = document.createElement("li");
    li.className = "row";

    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "row__check";
    box.setAttribute("aria-label", `${t.title}を完了にする`);
    box.addEventListener("change", () => complete(t));

    const body = document.createElement("button");
    body.type = "button";
    body.className = "row__body";
    const title = document.createElement("span");
    title.className = "row__title";
    title.textContent = t.title;
    const meta = document.createElement("span");
    meta.className = "row__meta";
    const badge = document.createElement("span");
    if (t.due < today) {
      const [, m, d] = t.due.split("-").map(Number);
      badge.textContent = `期限切れ ${m}/${d}`;
      badge.className = "badge badge--over";
    } else {
      badge.textContent = "今日まで";
      badge.className = "badge badge--today";
    }
    meta.append(badge);
    if (t.priority) {
      const p = document.createElement("span");
      p.textContent = `優先度 ${t.priority}`;
      meta.append(p);
    }
    body.append(title, meta);
    body.addEventListener("click", () => window.SuperApp.showView("tasks"));

    li.append(box, body);
    return li;
  }

  async function complete(t) {
    t.done = true;
    renderTasks();
    try {
      await callServer("notion.update", { list: "tasks", id: t.id, item: { done: true } });
      try {
        localStorage.setItem("superapp.list.tasks", JSON.stringify(tasks));
      } catch { /* private mode */ }
      showToast("完了にしました", () => undoComplete(t));
    } catch (e) {
      t.done = false;
      renderTasks();
      showToast(e instanceof NeedLogin ? "ログインし直してから、もう一度お試しください" : "保存できませんでした");
    }
  }

  async function undoComplete(t) {
    t.done = false;
    renderTasks();
    try {
      await callServer("notion.update", { list: "tasks", id: t.id, item: { done: false } });
    } catch {
      t.done = true;
      renderTasks();
      showToast("元に戻せませんでした");
    }
  }

  // ---------- メール ----------
  async function loadMail() {
    if (!window.SuperApp.serverUrl) {
      el.mailBlock.hidden = true;
      return;
    }
    let data = null;
    try {
      data = JSON.parse(localStorage.getItem("superapp.mailCache"));
    } catch { /* ignore */ }
    if (data) renderMail(data);
    else setText(el.mailStatus, "読み込み中…");
    try {
      // 新着の確認 (AI の要約) はメールタブに任せ、ここでは保存済みのまとめを読むだけにする
      data = await callServer("list");
      try {
        localStorage.setItem("superapp.mailCache", JSON.stringify(data));
      } catch { /* private mode */ }
      setText(el.mailStatus, "");
      renderMail(data);
    } catch (e) {
      if (e instanceof NeedLogin && e.message === "unauthorized") {
        el.mailBlock.hidden = true;
        return;
      }
      if (!data) setText(el.mailStatus, offlineOr(`メールを読み込めませんでした: ${e.message}`), true);
    }
  }

  function renderMail(data) {
    el.mailBlock.hidden = false;
    el.mail.hidden = false;
    const lines = data.digest && data.digest.length ? data.digest : ["まだまとめがありません（メールタブを開くと作られます）"];
    el.mailLines.replaceChildren(
      ...lines.map((line) => {
        const li = document.createElement("li");
        li.textContent = line;
        return li;
      })
    );
    const reply = (data.items || []).filter((it) => it.needsReply).length;
    el.mailReply.hidden = !reply;
    el.mailReply.textContent = `要返信のメール ${reply} 件を見る`;
  }

  // ---------- 通知 (Web Push) ----------
  function pushSupported() {
    return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  }

  function standalone() {
    return navigator.standalone || matchMedia("(display-mode: standalone)").matches;
  }

  async function pushConfig() {
    try {
      const res = await (await caches.open(PUSH_CACHE)).match("push-config");
      return res ? await res.json() : null;
    } catch {
      return null;
    }
  }

  async function currentSubscription() {
    if (!pushSupported()) return null;
    const reg = await navigator.serviceWorker.getRegistration();
    return reg ? reg.pushManager.getSubscription() : null;
  }

  async function updatePushUi() {
    if (!window.SuperApp.serverUrl) return;
    const on = pushSupported() && Notification.permission === "granted" && (await currentSubscription()) && (await pushConfig());
    el.push.hidden = !on;
    let later = 0;
    try {
      later = Number(localStorage.getItem(KEY_NOTIFY_LATER)) || 0;
    } catch { /* private mode */ }
    // 「あとで」を押したら 1 週間は出さない
    el.notify.hidden = !!on || Date.now() - later < 7 * 24 * 3600 * 1000;
    if (el.notify.hidden) return;
    if (!pushSupported() || !standalone()) {
      el.notifyText.textContent =
        "通知は、Safari の共有ボタン →「ホーム画面に追加」で追加したアプリから開いたときに使えます（iOS 16.4 以降）。";
      el.notifyBtn.hidden = true;
    } else if (Notification.permission === "denied") {
      el.notifyText.textContent = "通知が許可されていません。iPhone の「設定」→「通知」からこのアプリの通知をオンにしてください。";
      el.notifyBtn.hidden = true;
    } else {
      el.notifyBtn.hidden = false;
    }
  }

  function keyBytes(b64url) {
    const s = atob(b64url.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  }

  async function enablePush() {
    el.notifyBtn.disabled = true;
    try {
      // 許可を求めるダイアログは、ボタンを押した直後に出す必要がある
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        showToast("通知が許可されませんでした");
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const { key } = await callServer("push.key");
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
      const { secret } = await callServer("push.subscribe", { subscription: sub.toJSON() });
      const cache = await caches.open(PUSH_CACHE);
      await cache.put("push-config", new Response(JSON.stringify({ url: window.SuperApp.serverUrl, secret })));
      showToast("通知をオンにしました");
    } catch (e) {
      showToast(e instanceof NeedLogin ? "ログインし直してから、もう一度お試しください" : `通知をオンにできませんでした: ${e.message}`);
    } finally {
      el.notifyBtn.disabled = false;
      updatePushUi();
    }
  }

  async function disablePush() {
    try {
      const sub = await currentSubscription();
      if (sub) {
        await callServer("push.unsubscribe", { endpoint: sub.endpoint }).catch(() => {});
        await sub.unsubscribe();
      }
      await caches.delete(PUSH_CACHE);
      try {
        localStorage.setItem(KEY_NOTIFY_LATER, String(Date.now()));
      } catch { /* private mode */ }
      showToast("通知をオフにしました");
    } catch (e) {
      showToast(`オフにできませんでした: ${e.message}`);
    }
    updatePushUi();
  }

  async function testPush() {
    el.pushTest.disabled = true;
    try {
      const { sent } = await callServer("push.test");
      showToast(sent ? "テスト通知を送りました" : "送れませんでした。一度オフにして、もう一度オンにしてください");
    } catch (e) {
      showToast(`送れませんでした: ${e.message}`);
    } finally {
      el.pushTest.disabled = false;
    }
  }

  // ---------- 起動 ----------
  el.refresh.addEventListener("click", load);
  el.loginBtn.addEventListener("click", () => window.SuperApp.signIn());
  el.notifyBtn.addEventListener("click", enablePush);
  el.notifyLater.addEventListener("click", () => {
    try {
      localStorage.setItem(KEY_NOTIFY_LATER, String(Date.now()));
    } catch { /* private mode */ }
    el.notify.hidden = true;
  });
  el.pushTest.addEventListener("click", testPush);
  el.pushOff.addEventListener("click", disablePush);
  $("view-today").addEventListener("click", (ev) => {
    const target = ev.target.closest("[data-go]");
    if (target) window.SuperApp.showView(target.dataset.go);
  });
  document.addEventListener("viewchange", (ev) => {
    if (ev.detail === "today") load();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") load();
  });
  load();
})();
