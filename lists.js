// タスク・買い物リスト画面。データは Notion にあり、Google Apps Script のサーバー経由で読み書きする。
(() => {
  "use strict";

  const { callServer, NeedLogin, showToast } = window.SuperApp;
  const PRIORITY_RANK = { 高: 0, 中: 1, 低: 2 };
  const SHOPS = ["スーパー", "ドラッグストア", "100円ショップ", "ネット", "その他"];

  const LISTS = {
    tasks: {
      view: "view-tasks",
      fields: [
        { key: "title", label: "タスク", type: "text" },
        { key: "due", label: "期限", type: "date" },
        { key: "priority", label: "優先度", type: "select", options: ["高", "中", "低"] },
        { key: "memo", label: "メモ", type: "textarea" },
        { key: "done", label: "完了", type: "checkbox" },
      ],
      groups(items) {
        const open = items
          .filter((it) => !it.done)
          .sort(
            (a, b) =>
              (a.due || "9999").localeCompare(b.due || "9999") ||
              (PRIORITY_RANK[a.priority] ?? 3) - (PRIORITY_RANK[b.priority] ?? 3) ||
              a.created.localeCompare(b.created)
          );
        return [
          { name: "やること", items: open, empty: "やることはありません 🎉" },
          { name: "完了", items: items.filter((it) => it.done), collapsed: true, clearable: true },
        ];
      },
      meta(it) {
        const out = [];
        if (it.due) out.push(dueLabel(it.due, it.done));
        if (it.priority) out.push({ text: `優先度 ${it.priority}`, cls: `badge badge--p${PRIORITY_RANK[it.priority]}` });
        if (it.memo) out.push({ text: it.memo });
        return out;
      },
    },
    shopping: {
      view: "view-shopping",
      fields: [
        { key: "title", label: "品名", type: "text" },
        { key: "qty", label: "数量", type: "text", placeholder: "例: 2パック" },
        { key: "shop", label: "お店", type: "select", options: SHOPS },
        { key: "memo", label: "メモ", type: "textarea" },
        { key: "done", label: "購入済み", type: "checkbox" },
      ],
      groups(items) {
        const open = items.filter((it) => !it.done).sort((a, b) => a.created.localeCompare(b.created));
        const groups = [...SHOPS, ""].map((shop) => ({
          name: shop || "お店未設定",
          items: open.filter((it) => (it.shop || "") === shop),
        }));
        const shown = groups.filter((g) => g.items.length);
        if (!shown.length) shown.push({ name: "買うもの", items: [], empty: "買うものはありません" });
        shown.push({ name: "購入済み", items: items.filter((it) => it.done), collapsed: true, clearable: true });
        return shown;
      },
      meta(it) {
        const out = [];
        if (it.qty) out.push({ text: it.qty });
        if (it.memo) out.push({ text: it.memo });
        return out;
      },
    },
  };

  // ---------- 日付 ----------
  function localISO(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function dueLabel(due, done) {
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const [y, m, d] = due.split("-").map(Number);
    const date = new Date(y, m - 1, d);
    const md = new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric", weekday: "short" }).format(date);
    if (due === localISO(today)) return { text: "今日まで", cls: done ? "" : "badge badge--today" };
    if (due === localISO(tomorrow)) return { text: "明日まで", cls: "" };
    if (due < localISO(today)) return { text: `期限切れ ${md}`, cls: done ? "" : "badge badge--over" };
    return { text: `${md}まで` };
  }

  // ---------- 1 つのリスト画面 ----------
  function createList(name, conf) {
    const root = document.getElementById(conf.view);
    const q = (sel) => root.querySelector(sel);
    const el = {
      refresh: q("[data-role=refresh]"),
      form: q("[data-role=add]"),
      input: q("[data-role=add] input"),
      login: q("[data-role=login]"),
      loginText: q("[data-role=login] p"),
      status: q("[data-role=status]"),
      sections: q("[data-role=sections]"),
    };
    const cacheKey = `superapp.list.${name}`;
    let items = null;
    let loading = false;
    let tempSeq = 0;
    const openGroups = new Set();

    function setStatus(text, isError = false) {
      el.status.textContent = text;
      el.status.classList.toggle("error", isError);
      el.status.hidden = !text;
    }

    function save() {
      try {
        localStorage.setItem(cacheKey, JSON.stringify(items.filter((it) => !it.pending)));
      } catch { /* private mode */ }
    }

    // 失敗理由に応じて表示を変える。ログインが必要なら true を返す
    function handleError(e, fallback) {
      if (e instanceof NeedLogin) {
        if (e.message === "unauthorized") {
          showLogin("この機能は、サーバーを設定した Google アカウントでログインしたときだけ使えます。");
        } else if (!window.SuperApp.trySilentReauth()) {
          showLogin();
        }
        return true;
      }
      showToast(navigator.onLine ? `${fallback}: ${e.message}` : "オフラインです。接続を確認してください。");
      return false;
    }

    function showLogin(message) {
      el.login.hidden = false;
      el.loginText.textContent = message || "使うには Google でログインしてください。";
      setStatus("");
    }

    async function load() {
      if (loading) return;
      if (!window.SuperApp.serverUrl) {
        setStatus("サーバーの準備がまだ終わっていません（README を参照）。", true);
        return;
      }
      if (!window.SuperApp.getToken()) {
        if (!window.SuperApp.trySilentReauth()) showLogin();
        return;
      }
      el.login.hidden = true;
      loading = true;
      el.refresh.disabled = true;
      if (!items) {
        try {
          items = JSON.parse(localStorage.getItem(cacheKey));
        } catch { /* ignore */ }
        if (items) render();
      }
      if (!items) setStatus("読み込み中…");
      try {
        const res = await callServer("notion.list", { list: name });
        // 読み込み中に追加した項目 (まだ保存中) は残す
        items = [...res.items, ...(items || []).filter((it) => it.pending)];
        save();
        setStatus("");
        render();
      } catch (e) {
        if (!handleError(e, "読み込めませんでした") && !items) setStatus("読み込めませんでした", true);
        else if (items) setStatus("");
      } finally {
        loading = false;
        el.refresh.disabled = false;
      }
    }

    // ---------- 表示 ----------
    function render() {
      const groups = conf.groups(items);
      // 空の「完了」「購入済み」は見出しごと出さない
      el.sections.replaceChildren(...groups.filter((g) => g.items.length || g.empty).map(renderGroup));
    }

    function renderGroup(g) {
      const details = document.createElement("details");
      details.className = "mail-section";
      details.open = g.collapsed ? openGroups.has(g.name) : !openGroups.has("!" + g.name);
      details.addEventListener("toggle", () => {
        const key = g.collapsed ? g.name : "!" + g.name;
        if (details.open === !!g.collapsed) openGroups.add(key);
        else openGroups.delete(key);
      });

      const summary = document.createElement("summary");
      summary.className = "mail-section__head";
      const title = document.createElement("span");
      title.textContent = g.name;
      const count = document.createElement("span");
      count.className = "mail-section__count";
      count.textContent = `${g.items.length}件`;
      summary.append(title, count);
      details.append(summary);

      if (!g.items.length) {
        if (g.empty) {
          const p = document.createElement("p");
          p.className = "card empty";
          p.textContent = g.empty;
          details.append(p);
        }
        return details;
      }

      const list = document.createElement("ul");
      list.className = "mail-list";
      list.append(...g.items.map(renderItem));
      details.append(list);

      if (g.clearable) {
        const clear = document.createElement("button");
        clear.type = "button";
        clear.className = "link-btn list-clear";
        clear.textContent = `${g.name}の ${g.items.length} 件をまとめて削除`;
        clear.addEventListener("click", () => removeMany(g.items));
        details.append(clear);
      }
      return details;
    }

    function renderItem(it) {
      const li = document.createElement("li");
      li.className = "row";
      if (it.done) li.classList.add("row--done");
      if (it.pending) li.classList.add("row--pending");

      const box = document.createElement("input");
      box.type = "checkbox";
      box.className = "row__check";
      box.checked = !!it.done;
      box.disabled = !!it.pending;
      box.setAttribute("aria-label", `${it.title}を${it.done ? "未完了に戻す" : "完了にする"}`);
      box.addEventListener("change", () => update(it, { done: box.checked }));

      const body = document.createElement("button");
      body.type = "button";
      body.className = "row__body";
      body.disabled = !!it.pending;
      const title = document.createElement("span");
      title.className = "row__title";
      title.textContent = it.title;
      body.append(title);
      const meta = conf.meta(it);
      if (meta.length) {
        const line = document.createElement("span");
        line.className = "row__meta";
        for (const m of meta) {
          const span = document.createElement("span");
          span.textContent = m.text;
          if (m.cls) span.className = m.cls;
          line.append(span);
        }
        body.append(line);
      }
      body.addEventListener("click", () => openEditor(it));

      li.append(box, body);
      return li;
    }

    // ---------- 追加・更新・削除 (画面を先に変え、失敗したら元に戻す) ----------
    async function add(title) {
      const temp = { id: `tmp-${++tempSeq}`, title, done: false, created: new Date().toISOString(), pending: true };
      items.push(temp);
      render();
      try {
        const res = await callServer("notion.create", { list: name, item: { title } });
        items[items.indexOf(temp)] = res.item;
        save();
      } catch (e) {
        items.splice(items.indexOf(temp), 1);
        handleError(e, "追加できませんでした");
      }
      render();
    }

    async function update(it, changes) {
      const before = { ...it };
      Object.assign(it, changes);
      render();
      try {
        const res = await callServer("notion.update", { list: name, id: it.id, item: changes });
        Object.assign(it, res.item);
        save();
      } catch (e) {
        Object.assign(it, before);
        handleError(e, "保存できませんでした");
      }
      render();
    }

    async function removeMany(targets) {
      if (!targets.length) return;
      if (targets.length > 1 && !confirm(`${targets.length} 件を削除しますか？（Notion のゴミ箱に移ります）`)) return;
      items = items.filter((it) => !targets.includes(it));
      render();
      const results = await Promise.allSettled(
        targets.map((it) => callServer("notion.delete", { list: name, id: it.id }))
      );
      const failed = targets.filter((_, i) => results[i].status === "rejected");
      const removed = targets.filter((_, i) => results[i].status === "fulfilled");
      if (failed.length) {
        items.push(...failed);
        render();
        handleError(results.find((r) => r.status === "rejected").reason, `${failed.length} 件を削除できませんでした`);
      }
      save();
      if (removed.length && !failed.length) {
        showToast(removed.length === 1 ? "削除しました" : `${removed.length} 件を削除しました`, () => restore(removed));
      }
    }

    async function restore(targets) {
      items.push(...targets);
      render();
      const results = await Promise.allSettled(
        targets.map((it) => callServer("notion.restore", { list: name, id: it.id }))
      );
      const failed = targets.filter((_, i) => results[i].status === "rejected");
      if (failed.length) {
        items = items.filter((it) => !failed.includes(it));
        render();
        showToast("元に戻せませんでした。Notion のゴミ箱から戻してください");
      } else {
        showToast("元に戻しました");
      }
      save();
    }

    // ---------- 編集画面 ----------
    function openEditor(it) {
      editor.open(conf, it, {
        onSave: (changes) => Object.keys(changes).length && update(it, changes),
        onDelete: () => removeMany([it]),
      });
    }

    el.form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const title = el.input.value.trim();
      if (!title || !items) return;
      el.input.value = "";
      add(title);
    });
    el.refresh.addEventListener("click", load);
    q("[data-role=login] button").addEventListener("click", () => window.SuperApp.signIn());

    return { load };
  }

  // ---------- 編集用のダイアログ (タスク・買い物で共用) ----------
  const editor = (() => {
    const dialog = document.getElementById("edit-dialog");
    const fieldsBox = document.getElementById("edit-fields");
    const delBtn = document.getElementById("edit-delete");
    const cancelBtn = document.getElementById("edit-cancel");
    let current = null;

    function open(conf, item, handlers) {
      current = { conf, item, handlers, inputs: {} };
      fieldsBox.replaceChildren(
        ...conf.fields.map((f) => {
          const label = document.createElement("label");
          label.className = `field field--${f.type}`;
          const caption = document.createElement("span");
          caption.textContent = f.label;
          let input;
          if (f.type === "textarea") {
            input = document.createElement("textarea");
            input.rows = 3;
          } else if (f.type === "select") {
            input = document.createElement("select");
            for (const opt of ["", ...f.options]) {
              const o = document.createElement("option");
              o.value = opt;
              o.textContent = opt || "なし";
              input.append(o);
            }
          } else {
            input = document.createElement("input");
            input.type = f.type;
            if (f.placeholder) input.placeholder = f.placeholder;
          }
          if (f.type === "checkbox") input.checked = !!item[f.key];
          else input.value = item[f.key] || "";
          if (f.key === "title") input.required = true;
          current.inputs[f.key] = input;
          if (f.type === "checkbox") label.append(input, caption);
          else label.append(caption, input);
          return label;
        })
      );
      dialog.showModal();
    }

    dialog.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const { conf, item, handlers, inputs } = current;
      const changes = {};
      for (const f of conf.fields) {
        const input = inputs[f.key];
        const value = f.type === "checkbox" ? input.checked : input.value.trim();
        if (value !== (f.type === "checkbox" ? !!item[f.key] : item[f.key] || "")) changes[f.key] = value;
      }
      dialog.close();
      handlers.onSave(changes);
    });
    delBtn.addEventListener("click", () => {
      dialog.close();
      current.handlers.onDelete();
    });
    cancelBtn.addEventListener("click", () => dialog.close());

    return { open };
  })();

  // ---------- 起動 ----------
  const screens = Object.fromEntries(Object.entries(LISTS).map(([name, conf]) => [name, createList(name, conf)]));
  document.addEventListener("viewchange", (ev) => screens[ev.detail] && screens[ev.detail].load());
  document.addEventListener("visibilitychange", () => {
    const view = window.SuperApp.currentView();
    if (document.visibilityState === "visible" && screens[view]) screens[view].load();
  });
  const initial = screens[window.SuperApp.currentView()];
  if (initial) initial.load();
})();
