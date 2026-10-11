// 画面下のタブ（予定 / メール）の切り替え。各画面は "viewchange" イベントで表示されたことを知る。
(() => {
  "use strict";

  const KEY_VIEW = "superapp.view";
  const views = {
    calendar: document.getElementById("view-calendar"),
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

  window.SuperApp = Object.assign(window.SuperApp || {}, {
    currentView: () => current,
  });
})();
