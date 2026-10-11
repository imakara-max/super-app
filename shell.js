// 画面下のタブ（今日 / 予定 / タスク / 買い物 / メール）の切り替え。各画面は "viewchange" イベントで表示されたことを知る。
(() => {
  "use strict";

  const KEY_VIEW = "superapp.view";
  const views = {
    today: document.getElementById("view-today"),
    calendar: document.getElementById("view-calendar"),
    tasks: document.getElementById("view-tasks"),
    shopping: document.getElementById("view-shopping"),
    mail: document.getElementById("view-mail"),
  };
  const tabbar = document.getElementById("tabbar");

  let current = "today";
  try {
    const saved = localStorage.getItem(KEY_VIEW);
    if (views[saved]) current = saved;
  } catch { /* private mode */ }
  // 通知をタップして開いたときは、その通知に合う画面を出す
  const fromUrl = new URLSearchParams(location.search).get("view");
  if (views[fromUrl]) {
    current = fromUrl;
    history.replaceState(null, "", location.pathname + location.hash);
  }

  function show(name) {
    current = name;
    for (const [key, view] of Object.entries(views)) view.hidden = key !== name;
    for (const tab of tabbar.querySelectorAll("[data-view]")) {
      if (tab.dataset.view === name) tab.setAttribute("aria-current", "page");
      else tab.removeAttribute("aria-current");
    }
    try { localStorage.setItem(KEY_VIEW, name); } catch { /* private mode */ }
  }

  show(current);

  // 別の画面へ切り替えて、その画面に読み込みを促す
  function go(name) {
    if (!views[name] || name === current) return;
    show(name);
    window.scrollTo(0, 0);
    document.dispatchEvent(new CustomEvent("viewchange", { detail: current }));
  }

  tabbar.addEventListener("click", (ev) => {
    const tab = ev.target.closest("[data-view]");
    if (tab) go(tab.dataset.view);
  });

  // アプリを開いたまま通知をタップしたとき (sw.js から届く)
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (ev) => {
      if (ev.data && ev.data.view) go(ev.data.view);
    });
  }

  // ---------- サーバー (Google Apps Script) の呼び出し ----------
  const SERVER_URL = (window.APP_CONFIG && window.APP_CONFIG.MAIL_API_URL) || "";

  class NeedLogin extends Error {}

  // message が "unauthorized" なら別アカウントでのログイン、それ以外はトークン切れ
  async function callServer(action, extra = {}) {
    const token = window.SuperApp.getToken();
    if (!token) throw new NeedLogin("no token");
    // Content-Type を付けない (text/plain) ことで、Apps Script でも通る単純なリクエストにする
    const res = await fetch(SERVER_URL, {
      method: "POST",
      body: JSON.stringify({ action, accessToken: token, ...extra }),
    });
    if (!res.ok) throw new Error(`サーバーエラー (${res.status})`);
    let body;
    try {
      body = await res.json();
    } catch {
      // Apps Script がエラーページ (HTML) を返したとき
      throw new Error("サーバーから正しい応答がありません。Apps Script のデプロイ（新バージョン）を確認してください");
    }
    if (body.error === "unauthorized") throw new NeedLogin("unauthorized");
    if (body.error === "unknown_action") throw new Error("サーバーのコードが古いようです（README の手順で更新してください）");
    if (body.error) throw new Error(body.message || body.error);
    return body;
  }

  // ---------- タスク (今日・予定の画面でも使う) ----------
  // タスク画面 (lists.js) と同じ保存場所を使い、どの画面で読み込んでも最新が共有されるようにする
  const KEY_TASKS = "superapp.list.tasks";

  function cachedTasks() {
    try {
      return JSON.parse(localStorage.getItem(KEY_TASKS));
    } catch {
      return null;
    }
  }

  async function fetchTasks() {
    const { items } = await callServer("notion.list", { list: "tasks" });
    try {
      localStorage.setItem(KEY_TASKS, JSON.stringify(items));
    } catch { /* private mode */ }
    return items;
  }

  // ---------- 画面下に一時表示するお知らせ ----------
  const toast = document.getElementById("toast");
  const toastText = document.getElementById("toast-text");
  const toastAction = document.getElementById("toast-action");
  let toastTimer = 0;

  function hideToast() {
    clearTimeout(toastTimer);
    toast.hidden = true;
    toastAction.onclick = null;
  }

  // undo を渡すと「元に戻す」ボタンを出す
  function showToast(text, undo) {
    clearTimeout(toastTimer);
    toastText.textContent = text;
    toastAction.hidden = !undo;
    toastAction.onclick = undo
      ? () => {
          hideToast();
          undo();
        }
      : null;
    toast.hidden = false;
    toastTimer = setTimeout(hideToast, undo ? 6000 : 3000);
  }

  window.SuperApp = Object.assign(window.SuperApp || {}, {
    currentView: () => current,
    showView: go,
    cachedTasks,
    fetchTasks,
    serverUrl: SERVER_URL,
    callServer,
    NeedLogin,
    showToast,
    hideToast,
  });
})();
