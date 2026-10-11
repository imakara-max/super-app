// 画面下のタブ（予定 / メール）の切り替え。各画面は "viewchange" イベントで表示されたことを知る。
(() => {
  "use strict";

  const KEY_VIEW = "superapp.view";
  const views = {
    calendar: document.getElementById("view-calendar"),
    tasks: document.getElementById("view-tasks"),
    shopping: document.getElementById("view-shopping"),
    mail: document.getElementById("view-mail"),
  };
  const tabbar = document.getElementById("tabbar");

  let current = "calendar";
  try {
    const saved = localStorage.getItem(KEY_VIEW);
    if (views[saved]) current = saved;
  } catch { /* private mode */ }

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

  tabbar.addEventListener("click", (ev) => {
    const tab = ev.target.closest("[data-view]");
    if (!tab || tab.dataset.view === current) return;
    show(tab.dataset.view);
    window.scrollTo(0, 0);
    document.dispatchEvent(new CustomEvent("viewchange", { detail: current }));
  });

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
    const body = await res.json();
    if (body.error === "unauthorized") throw new NeedLogin("unauthorized");
    if (body.error === "unknown_action") throw new Error("サーバーのコードが古いようです（README の手順で更新してください）");
    if (body.error) throw new Error(body.message || body.error);
    return body;
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
    serverUrl: SERVER_URL,
    callServer,
    NeedLogin,
    showToast,
    hideToast,
  });
})();
