// Shared UI helpers: theme toggle, tooltip, formatting, data loading.

const THEME_KEY = "odp-theme";

export function initTheme(button) {
  const root = document.documentElement;
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved) root.dataset.theme = saved;
  } catch { /* storage unavailable */ }
  const isDark = () =>
    root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  const paint = () => {
    if (!button) return;
    button.innerHTML = isDark()
      ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>'
      : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
    button.setAttribute("aria-label", isDark() ? "Switch to light theme" : "Switch to dark theme");
  };
  button?.addEventListener("click", () => {
    root.dataset.theme = isDark() ? "light" : "dark";
    try { localStorage.setItem(THEME_KEY, root.dataset.theme); } catch { /* ignore */ }
    paint();
    window.dispatchEvent(new CustomEvent("themechange"));
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    paint();
    window.dispatchEvent(new CustomEvent("themechange"));
  });
  paint();
  return isDark;
}

const SKIN_KEY = "odp-skin";

// Designs. Every standalone page opens in the Open Places "Blue" design (no data-skin on <html>; tokens in
// ./places-tokens.css, chrome in ./theme.css) and offers two more from one Design menu on the skin button:
//   "Grey", data-skin="grey" (Open Places' Fog / Graphite neutrals), and
//   its own themed skin, data-skin="alt" (Flight Strip, Night Run, …; the button's data-skin-name).
// The choice is shared across pages (localStorage "odp-skin": "grey" | "alt" | "classic" = Blue; the retired "blue"
// also reads as Blue), so a reader can browse every themed skin in one go; a reader who never chose gets Blue.
// ?skin=grey|alt|blue|classic|default overrides and is remembered (not when inlaid in Open Places with ?embed=1, where
// the shell's choice wins). The page's pre-paint script applies "alt" before first paint; "grey" is applied here.
// Skin modules check root.dataset.skin === "alt" and listen for "skinchange"; any other value is an Open Places design.
// Two other forms remain: a page with its own single alternate names it on the button (data-skin-id="grey"
// data-skin-name="Grey" data-skin-base="Blue", remembered per page as odp-skin:<page>; the Open Places console), and
// a page reviewing several themed skins lists them (<html data-skins="alt herbarium"> + <button data-skin-names="A|B">).
export function initSkin(button) {
  const root = document.documentElement;
  if (button?.dataset.skinId) return initSkinToggle(button);
  if (root.dataset.skins && button?.dataset.skinNames) return initReviewMenu(button);
  return initDesignMenu(button);
}

const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};
const changed = () => {
  window.dispatchEvent(new CustomEvent("skinchange"));
  window.dispatchEvent(new CustomEvent("themechange"));
};

function initDesignMenu(button) {
  const root = document.documentElement;
  const q = new URLSearchParams(location.search), qs = q.get("skin");
  const embed = q.get("embed") === "1" || root.classList.contains("embed");
  const ids = ["default", "grey", "alt"];
  const names = ["Blue", "Grey", button?.dataset.skinName || "Themed"];
  // apply Grey (the pre-paint scripts only know "alt"); an explicit ?skin= always wins over the saved choice
  if (root.dataset.skin === "blue") delete root.dataset.skin;   // the retired Blue alternate is today's default
  if (!root.dataset.skin && (qs === "grey" || (!qs && !embed && store.get(SKIN_KEY) === "grey"))) root.dataset.skin = "grey";
  if (!embed) {
    const v = qs === "alt" || qs === "grey" ? qs : ["classic", "default", "places", "blue"].includes(qs) ? "classic" : null;
    if (v) store.set(SKIN_KEY, v);
    else if (!qs && store.get(SKIN_KEY) === "blue") store.set(SKIN_KEY, "classic");
  }
  const cur = () => (root.dataset.skin === "alt" || root.dataset.skin === "grey" ? root.dataset.skin : "default");
  const set = (id) => {
    if (id === "default") delete root.dataset.skin; else root.dataset.skin = id;
    if (!embed) store.set(SKIN_KEY, id === "default" ? "classic" : id);
    changed();
  };
  if (button) skinMenu(button, ids, names, cur, set);
  return () => cur() === "alt";
}

function initSkinToggle(button) {
  const root = document.documentElement;
  const name = button.dataset.skinName || "Alternative";
  const id = button.dataset.skinId, base = button.dataset.skinBase || "Blue";
  const key = "odp-skin:" + (root.dataset.page || location.pathname);
  const on = () => root.dataset.skin === id;
  const paint = () => {
    button.replaceChildren(el("span", { class: "skin-dot", "aria-hidden": "true" }), el("span", {}, on() ? name : base));
    button.title = on() ? `Switch back to the ${base.toLowerCase()} design` : `Switch to the ${name} design`;
    button.setAttribute("aria-pressed", String(on()));
  };
  button.addEventListener("click", () => {
    if (on()) delete root.dataset.skin; else root.dataset.skin = id;
    store.set(key, on() ? id : "default");
    paint();
    changed();
  });
  paint();
  return on;
}

function initReviewMenu(button) {
  const root = document.documentElement;
  const ids = ["classic", ...root.dataset.skins.split(" ")];
  const names = ["Blue", ...button.dataset.skinNames.split("|")];
  const pk = "odp-skin:" + (root.dataset.page || location.pathname);
  const cur = () => (ids.includes(root.dataset.skin) ? root.dataset.skin : "classic");
  const set = (id) => {
    if (id === "classic") delete root.dataset.skin; else root.dataset.skin = id;
    store.set(pk, id);
    if (id === "alt" || id === "classic") store.set(SKIN_KEY, id);
    changed();
  };
  skinMenu(button, ids, names, cur, set);
  return () => cur() !== "classic";
}

// The Design menu: the button shows the current design; the menu lists them (first entry = Open Places Blue).
function skinMenu(button, ids, names, cur, set) {
  const menu = el("div", { class: "skin-menu", role: "menu", hidden: "" });
  const items = ids.map((id, i) => {
    const b = el("button", { type: "button", role: "menuitemradio", "data-id": id },
      el("span", { class: "skin-dot", "aria-hidden": "true" }), el("span", {}, names[i]));
    b.addEventListener("click", () => { set(id); paint(); close(); button.focus(); });
    return b;
  });
  menu.append(el("div", { class: "skin-menu-head" }, "Design"), ...items);
  button.after(menu);
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  function paint() {
    const i = Math.max(0, ids.indexOf(cur()));
    button.dataset.design = ids[i];
    button.replaceChildren(el("span", { class: "skin-dot", "aria-hidden": "true" }), el("span", {}, names[i]), el("span", { class: "skin-caret", "aria-hidden": "true" }, "▾"));
    button.title = `Design: ${names[i]} (choose from ${ids.length})`;
    items.forEach((b) => b.setAttribute("aria-checked", String(b.dataset.id === ids[i])));
  }
  const place = () => {
    const r = button.getBoundingClientRect();
    menu.style.top = `${r.bottom + 6}px`;
    menu.style.right = `${Math.max(8, innerWidth - r.right)}px`;
  };
  function close() { menu.hidden = true; button.setAttribute("aria-expanded", "false"); }
  const open = () => { place(); menu.hidden = false; button.setAttribute("aria-expanded", "true"); items[Math.max(0, ids.indexOf(cur()))].focus(); };
  button.addEventListener("click", (e) => { e.stopPropagation(); menu.hidden ? open() : close(); });
  document.addEventListener("click", (e) => { if (!menu.hidden && !menu.contains(e.target)) close(); });
  menu.addEventListener("keydown", (e) => {
    const i = items.indexOf(document.activeElement);
    if (e.key === "Escape") { close(); button.focus(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    else if (e.key === "Tab") close();
  });
  addEventListener("resize", () => { if (!menu.hidden) place(); });
  paint();
}

export const cssVar = (name, el = document.body) => getComputedStyle(el).getPropertyValue(name).trim();

// ---------- tooltip (one per page)
let tipEl;
export function tooltip() {
  if (!tipEl) {
    tipEl = document.createElement("div");
    tipEl.className = "tooltip";
    tipEl.setAttribute("role", "status");
    document.body.appendChild(tipEl);
  }
  return {
    show(x, y, build) {
      tipEl.replaceChildren();
      build(tipEl);
      tipEl.classList.add("on");
      const r = tipEl.getBoundingClientRect();
      const left = Math.min(window.innerWidth - r.width - 8, x + 14);
      const top = y + r.height + 20 > window.innerHeight ? y - r.height - 12 : y + 14;
      tipEl.style.left = `${Math.max(8, left)}px`;
      tipEl.style.top = `${Math.max(8, top)}px`;
    },
    hide() { tipEl.classList.remove("on"); },
  };
}

// Small DOM builder used for tooltips/legends so labels always go through textContent.
export function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "style" && typeof v === "object") Object.assign(n.style, v);
    else if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return n;
}

export const tipRow = (color, value, label) =>
  el("div", { class: "t-row" }, color ? el("i", { class: "t-key", style: { background: color } }) : null, el("b", {}, value), el("span", {}, label));

export async function loadJSON(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

export const fmtInt = new Intl.NumberFormat("en-CA");

// Searchable checklist of tree types for a map side panel.
// items: [{ id, name, count, colour, tier }]; selected: Set of ids (mutated); onChange() after every edit.
// Rows toggle on click; "only" isolates a row; All / None act on the rows the search leaves visible.
export function treeList(host, items, selected, onChange, { placeholder = "Find a tree…" } = {}) {
  const rows = items.map((it) => {
    const box = el("input", { type: "checkbox", tabindex: "-1", "aria-hidden": "true" });
    const only = el("button", { type: "button", class: "tl-only", title: `Show only ${it.name}` }, "only");
    const row = el("li", { class: "tl-item", role: "option" },
      el("label", {}, box, el("i", { class: "tl-sw", style: { background: it.colour } }),
        el("span", { class: "tl-name" }, it.name), it.tier ? el("span", { class: `tl-tier tier-${it.tier}` }, it.tier) : null,
        el("span", { class: "tl-n" }, it.count ? fmtInt.format(it.count) : "0")), only);
    box.addEventListener("change", () => { box.checked ? selected.add(it.id) : selected.delete(it.id); paint(); onChange(); });
    only.addEventListener("click", () => { selected.clear(); selected.add(it.id); paint(); onChange(); });
    if (!it.count) row.classList.add("tl-zero");
    return { it, row, box };
  });
  const search = el("input", { type: "search", class: "tl-search", placeholder, "aria-label": placeholder });
  const visible = () => rows.filter((r) => !r.row.hidden);
  const bulk = (on) => { for (const r of visible()) on ? selected.add(r.it.id) : selected.delete(r.it.id); paint(); onChange(); };
  const summary = el("span", { class: "tl-summary" });
  const list = el("ul", { class: "tl-list", role: "listbox", "aria-multiselectable": "true" }, ...rows.map((r) => r.row));
  search.addEventListener("input", () => {
    const q = search.value.trim().toLowerCase();
    for (const r of rows) r.row.hidden = q !== "" && !r.it.name.toLowerCase().includes(q);
  });
  function paint() {
    for (const r of rows) { r.box.checked = selected.has(r.it.id); r.row.setAttribute("aria-selected", String(r.box.checked)); }
    const on = rows.filter((r) => selected.has(r.it.id));
    summary.textContent = on.length === rows.length ? `All ${rows.length} shown` : `${on.length} of ${rows.length} shown`;
  }
  host.replaceChildren(
    el("div", { class: "tl-head" }, summary,
      el("span", { class: "tl-bulk" }, el("button", { type: "button", onclick: () => bulk(true) }, "All"), el("button", { type: "button", onclick: () => bulk(false) }, "None"))),
    search, list);
  paint();
  return { paint };
}

