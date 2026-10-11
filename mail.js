// メール画面。要約・分類は Google Apps Script のサーバー (gas/Code.gs) が行い、ここでは表示と操作だけを行う。
(() => {
  "use strict";

  const KEY_CACHE = "superapp.mailCache";
  const STALE_MS = 60 * 60 * 1000; // これより古ければ開いたときに新着を確認する（夜 22 時〜朝 7 時を除く）
  // 表示順。要返信は分類とは別に先頭へまとめる
  const SECTION_ORDER = ["学校・家族", "仕事", "お金・支払い", "買い物・配送", "お知らせ", "その他", "SNS", "広告"];
  const COLLAPSED = new Set(["SNS", "広告"]);

  const $ = (id) => document.getElementById(id);
  const el = {
    view: $("view-mail"),
    updated: $("mail-updated"),
    refresh: $("mail-refresh"),
    login: $("mail-login"),
    loginText: $("mail-login-text"),
    loginBtn: $("mail-login-btn"),
    digest: $("mail-digest"),
    digestLines: $("mail-digest-lines"),
    status: $("mail-status"),
    sections: $("mail-sections"),
  };

  let data = null; // { updatedAt, digest: string[], items: [...] }
  let busy = false;
  const openSections = new Set(); // 折りたたみ表示の開閉状態を再描画後も保つ

  const { callServer: call, NeedLogin, showToast } = window.SuperApp;

  // ---------- 読み込み ----------
  async function load({ refresh = false } = {}) {
    if (busy) return;
    if (!window.SuperApp.serverUrl) {
      showMessage("メール機能の準備がまだ終わっていません（README の「メール機能のセットアップ」を参照）。");
      return;
    }
    if (!window.SuperApp.getToken()) {
      if (!window.SuperApp.trySilentReauth()) showLogin();
      return;
    }

    busy = true;
    el.login.hidden = true;
    window.SuperApp.loadEmail(); // Gmail を開くリンクで正しいアカウントを選ぶため
    el.refresh.disabled = true;
    try {
      if (!data) {
        data = readCache();
        if (data) render();
      }
      if (!refresh) {
        setStatus(data ? "" : "読み込み中…");
        data = await call("list");
        writeCache();
        render();
      }
      const hour = new Date().getHours();
      const quiet = hour >= 22 || hour < 7;
      const stale = !quiet && (!data.updatedAt || Date.now() - Date.parse(data.updatedAt) > STALE_MS);
      if (refresh || stale || (!quiet && data.items.some((it) => !it.summary))) {
        setStatus("新着を確認して AI が要約しています…");
        data = await call("refresh");
        writeCache();
        render();
      }
      setStatus("");
    } catch (e) {
      if (e instanceof NeedLogin) {
        if (e.message === "unauthorized") {
          showLogin("このメール機能は、サーバーを設定した Google アカウントでログインしたときだけ使えます。");
        } else if (!window.SuperApp.trySilentReauth()) {
          showLogin();
        }
      } else {
        setStatus(navigator.onLine ? `読み込めませんでした: ${e.message}` : "オフラインです。接続を確認してください。", true);
      }
    } finally {
      busy = false;
      el.refresh.disabled = false;
    }
  }

  function readCache() {
    try {
      return JSON.parse(localStorage.getItem(KEY_CACHE));
    } catch {
      return null;
    }
  }

  function writeCache() {
    try {
      localStorage.setItem(KEY_CACHE, JSON.stringify(data));
    } catch { /* private mode */ }
  }

  // ---------- 表示 ----------
  function setStatus(text, isError = false) {
    el.status.textContent = text;
    el.status.classList.toggle("error", isError);
    el.status.hidden = !text;
  }

  function showLogin(message) {
    el.login.hidden = false;
    el.loginText.textContent = message || "メールを見るには Google でログインしてください。";
    setStatus("");
  }

  function showMessage(text) {
    el.login.hidden = true;
    el.digest.hidden = true;
    el.sections.replaceChildren();
    setStatus(text, true);
  }

  const timeFmt = new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit" });
  const dateFmt = new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric" });

  function formatWhen(ms) {
    const d = new Date(ms);
    return d.toDateString() === new Date().toDateString() ? timeFmt.format(d) : dateFmt.format(d);
  }

  function render() {
    el.updated.textContent = data.updatedAt ? `最終更新 ${formatWhen(Date.parse(data.updatedAt))}` : "";

    el.digest.hidden = !data.digest || !data.digest.length;
    el.digestLines.replaceChildren(
      ...(data.digest || []).map((line) => {
        const li = document.createElement("li");
        li.textContent = line;
        return li;
      })
    );

    const groups = new Map([["要返信", []], ...SECTION_ORDER.map((c) => [c, []]), ["未分類", []]]);
    for (const it of data.items) {
      if (it.needsReply) groups.get("要返信").push(it);
      else if (!it.summary) groups.get("未分類").push(it);
      else (groups.get(it.category) || groups.get("その他")).push(it);
    }

    const sections = [...groups].filter(([, items]) => items.length).map(([name, items]) => renderSection(name, items));
    if (!sections.length) {
      const empty = document.createElement("p");
      empty.className = "card empty";
      empty.textContent = "受信トレイに最近のメールはありません";
      sections.push(empty);
    }
    el.sections.replaceChildren(...sections);
  }

  function renderSection(name, items) {
    const details = document.createElement("details");
    details.className = "mail-section";
    details.open = COLLAPSED.has(name) ? openSections.has(name) : !openSections.has("!" + name);
    details.addEventListener("toggle", () => {
      if (COLLAPSED.has(name)) details.open ? openSections.add(name) : openSections.delete(name);
      else details.open ? openSections.delete("!" + name) : openSections.add("!" + name);
    });

    const summary = document.createElement("summary");
    summary.className = "mail-section__head";
    const title = document.createElement("span");
    title.textContent = name;
    const count = document.createElement("span");
    count.className = "mail-section__count";
    const unread = items.filter((it) => it.unread).length;
    count.textContent = unread ? `${items.length}件（未読 ${unread}）` : `${items.length}件`;
    summary.append(title, count);
    if (name === "要返信") summary.classList.add("mail-section__head--reply");

    const list = document.createElement("ul");
    list.className = "mail-list";
    list.append(...items.map(renderItem));
    details.append(summary, list);
    return details;
  }

  function renderItem(it) {
    const li = document.createElement("li");
    li.className = "mail";
    if (it.unread) li.classList.add("mail--unread");

    const link = document.createElement("a");
    link.className = "mail__main";
    link.href = gmailLink(it.id);
    link.target = "_blank";
    link.rel = "noopener";

    const top = document.createElement("div");
    top.className = "mail__top";
    const from = document.createElement("span");
    from.className = "mail__from";
    from.textContent = it.from + (it.count > 1 ? ` (${it.count})` : "");
    const when = document.createElement("span");
    when.className = "mail__when";
    when.textContent = formatWhen(it.date);
    top.append(from, when);

    const subject = document.createElement("p");
    subject.className = "mail__subject";
    subject.textContent = it.subject;

    const summary = document.createElement("p");
    summary.className = "mail__summary";
    if (it.summary) {
      summary.textContent = it.summary;
    } else {
      summary.textContent = it.snippet || "";
      summary.classList.add("mail__summary--raw");
    }
    link.append(top, subject, summary);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "mail__delete";
    del.setAttribute("aria-label", `「${it.subject}」をゴミ箱へ移動`);
    del.innerHTML =
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/></svg>';
    del.addEventListener("click", () => trash(it));

    li.append(link, del);
    return li;
  }

  function gmailLink(threadId) {
    const email = window.SuperApp.email();
    const account = email ? `?authuser=${encodeURIComponent(email)}` : "";
    return `https://mail.google.com/mail/${account}#all/${threadId}`;
  }

  // ---------- ゴミ箱へ移動 / 元に戻す ----------
  async function trash(item) {
    const index = data.items.indexOf(item);
    if (index < 0) return;
    data.items.splice(index, 1);
    render();
    try {
      await call("trash", { id: item.id });
      writeCache();
      showToast("ゴミ箱に移動しました", () => untrash(item, index));
    } catch (e) {
      data.items.splice(index, 0, item);
      render();
      showToast(e instanceof NeedLogin ? "ログインし直してから、もう一度お試しください" : "削除できませんでした");
    }
  }

  async function untrash(item, index) {
    data.items.splice(Math.min(index, data.items.length), 0, item);
    render();
    try {
      await call("untrash", { id: item.id });
      writeCache();
      showToast("元に戻しました");
    } catch {
      data.items.splice(data.items.indexOf(item), 1);
      render();
      showToast("元に戻せませんでした。Gmail のゴミ箱から戻してください");
    }
  }

  // ---------- 起動 ----------
  el.refresh.addEventListener("click", () => load({ refresh: true }));
  el.loginBtn.addEventListener("click", () => window.SuperApp.signIn());
  document.addEventListener("viewchange", (ev) => {
    if (ev.detail === "mail") load();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && window.SuperApp.currentView() === "mail") load();
  });
  if (window.SuperApp.currentView() === "mail") load();
})();
