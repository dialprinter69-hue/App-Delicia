/**
 * Keep in sync with Android `strings.xml` for WhatsApp, menu URL, and pricing.
 */
const CONFIG = {
  /**
   * Menú: URL absoluta (raw GitHub) o ruta en el mismo sitio, ej. "/menu.json" si en Vercel
   * copias menu.json a public/ (ver scripts/copy-pwa.cjs en repo delicia-menu).
   */
  remoteMenuJsonUrl:
    "https://raw.githubusercontent.com/dialprinter69-hue/delicia-menu/refs/heads/main/menu.json",
  /**
   * Carpeta (URL terminada en /) donde están fotos por nombre de bundledDrawable, p. ej.
   * …/images/menu_tres_leches.webp. Vacío = misma rama que menu.json: …/main/images/
   */
  menuImagesBaseUrl: "",
  restaurantWhatsappE164: "19785027983",
  cashAppTag: "$Aleshkamatos6",
  drinkUnitPrice: 2.0,
  deliveryFee: 4.0,
  freeDrinkItemIds: new Set(["dish-papas-supreme"]),
};

const DRINK_LABELS = ["Coca Cola", "Fanta", "Sprite", "Diet Coke", "Agua"];

/** Defaults para postres si vienen sin `sizes` en menu.json. */
const DEFAULT_DESSERT_SIZES = [
  { id: "individual", label: "Porción individual", desc: "Para 1 persona", price: 5 },
  { id: "bandeja", label: "Bandeja", desc: "Para compartir (8–10 porciones)", price: 25, badge: "Familiar" },
];

/** IDs legados que deben tratarse como postres aunque no tengan `category`. */
const LEGACY_DESSERT_IDS = new Set(["dish-tres-leches"]);

const state = {
  menu: [],          // Solo platos principales (category !== "dessert")
  desserts: [],      // Catálogo de postres desde menu.json
  cart: new Map(),
  dessertOrders: [], // Pedidos de postres: {catalogId, sizeId, sizeLabel, unitPrice, qty, orderDate, notes, nameSnapshot}
  drinks: Object.fromEntries(DRINK_LABELS.map((d) => [d, 0])),
  delivery: false,
  paymentCashApp: false,
  loadError: null,
};
let pendingWhatsappUrlAfterCash = "";
const BOT_API_BASE = "http://10.0.0.22:3000";
const BOT_API_TOKEN = "delicia-change-this-token";
const ORDERS_ADMIN_PARAM = "admin";
const ORDERS_ADMIN_VALUE = "1";

const $ = (sel, root = document) => root.querySelector(sel);

/** Para selectores [data-attr="…"] sin depender de `CSS.escape` (evita ReferenceError en WebViews viejos). */
function escapeAttrSelector(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

const MENU_CARD_IMAGE_EXTS = [".webp", ".png", ".jpg", ".jpeg"];

function directoryOfMenuJsonUrl(menuJsonUrl) {
  const t = String(menuJsonUrl || "").trim();
  if (!t) return "";
  try {
    const u = new URL(t);
    u.pathname = u.pathname.replace(/[^/]+$/, "");
    return u.href;
  } catch {
    return "";
  }
}

function imagesFolderFromMenuJsonUrl(menuJsonUrl) {
  const t = String(menuJsonUrl || "").trim();
  if (!t) return "";
  try {
    const u = new URL(t);
    if (!/menu\.json$/i.test(u.pathname)) return "";
    u.pathname = u.pathname.replace(/menu\.json$/i, "images/");
    return u.href;
  } catch {
    return "";
  }
}

function folderForBundledMenuImages() {
  const manual = String(CONFIG.menuImagesBaseUrl || "").trim();
  if (manual) return manual.replace(/\/?$/, "/");
  return imagesFolderFromMenuJsonUrl(CONFIG.remoteMenuJsonUrl);
}

/** Lista de URLs a probar (orden) para la miniatura del plato. */
function resolveMenuImageCandidates(item) {
  const direct = String(item.imageUrl || "").trim();
  if (direct) return [direct];
  const rel = String(item.imageRelativePath || "").trim();
  const dir = directoryOfMenuJsonUrl(CONFIG.remoteMenuJsonUrl);
  if (rel && dir) return [`${dir}${rel.replace(/^\//, "")}`];
  const bd = String(item.bundledDrawable || "").trim();
  const imgDir = folderForBundledMenuImages();
  if (bd && imgDir) return MENU_CARD_IMAGE_EXTS.map((ext) => `${imgDir}${bd}${ext}`);
  return [];
}

function makeMenuImagePlaceholder(options = {}) {
  const el = document.createElement("div");
  el.className = "menu-card-img menu-card-img-placeholder";
  el.setAttribute("role", "presentation");
  if (options.dessert) {
    el.classList.add("is-dessert-placeholder");
    const emoji = options.emoji || "🍮";
    el.innerHTML = `<span class="placeholder-emoji" aria-hidden="true">${emoji}</span>`;
  } else {
    el.style.background = "linear-gradient(145deg,#1E3D2F,#2D5A45)";
  }
  return el;
}

/** Escoge el emoji adecuado según el nombre del postre. */
function dessertEmojiFor(item) {
  const n = String(item && item.name || "").toLowerCase();
  if (n.includes("tres leche")) return "🥛";
  if (n.includes("flan")) return "🍮";
  if (n.includes("cheesecake") || n.includes("queso")) return "🍰";
  if (n.includes("brownie") || n.includes("chocolate")) return "🍫";
  if (n.includes("helado") || n.includes("nieve")) return "🍨";
  return "🍰";
}

function parsePriceToDouble(raw) {
  const normalized = String(raw)
    .replace(/,/g, ".")
    .replace(/[^0-9.]/g, "");
  return parseFloat(normalized) || 0;
}

function loadState() {
  try {
    const raw = sessionStorage.getItem("delicias_pwa_state");
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data.cart && typeof data.cart === "object") {
      state.cart = new Map(Object.entries(data.cart).map(([k, v]) => [k, Number(v) || 0]));
    }
    if (Array.isArray(data.dessertOrders)) {
      state.dessertOrders = data.dessertOrders.filter((d) => d && typeof d === "object");
    }
    if (data.drinks && typeof data.drinks === "object") {
      for (const d of DRINK_LABELS) {
        if (typeof data.drinks[d] === "number") state.drinks[d] = data.drinks[d];
      }
    }
    if (typeof data.delivery === "boolean") state.delivery = data.delivery;
    if (typeof data.paymentCashApp === "boolean") state.paymentCashApp = data.paymentCashApp;
  } catch {
    /* ignore */
  }
}

function saveState() {
  const data = {
    cart: Object.fromEntries(state.cart),
    dessertOrders: state.dessertOrders,
    drinks: { ...state.drinks },
    delivery: state.delivery,
    paymentCashApp: state.paymentCashApp,
  };
  sessionStorage.setItem("delicias_pwa_state", JSON.stringify(data));
}

function defaultMenu() {
  return [
    {
      id: "local-1",
      name: "Arroz con gandules y pernil",
      description: "Sazon casero (sin conexión al menú remoto).",
      price: "$16",
      imageUrl: null,
    },
  ];
}

function isDessertItem(item) {
  if (item && item.category === "dessert") return true;
  if (item && LEGACY_DESSERT_IDS.has(item.id)) return true;
  return false;
}

function normalizeDessertSizes(item) {
  const raw = Array.isArray(item.sizes) ? item.sizes : [];
  if (raw.length === 0) {
    const base = parsePriceToDouble(item.price) || 5;
    return [
      { id: "individual", label: "Porción individual", desc: "Para 1 persona", price: base },
      { id: "bandeja", label: "Bandeja", desc: "Para compartir (8–10 porciones)", price: 25, badge: "Familiar" },
    ];
  }
  return raw.map((s) => ({
    id: s.id || "size",
    label: s.label || "Tamaño",
    desc: s.desc || "",
    price: parsePriceToDouble(s.price),
    badge: s.badge || null,
  }));
}

function splitMenuAndDesserts(list) {
  const mains = [];
  const desserts = [];
  for (const item of list) {
    if (isDessertItem(item)) {
      desserts.push({ ...item, sizes: normalizeDessertSizes(item) });
    } else {
      mains.push(item);
    }
  }
  return { mains, desserts };
}

async function fetchMenu() {
  state.loadError = null;
  const url = CONFIG.remoteMenuJsonUrl.trim();
  if (!url) {
    state.menu = defaultMenu();
    state.desserts = [];
    return;
  }
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const list = await res.json();
    if (!Array.isArray(list) || list.length === 0) throw new Error("Menú vacío");
    const { mains, desserts } = splitMenuAndDesserts(list);
    state.menu = mains.length > 0 ? mains : defaultMenu();
    state.desserts = desserts;
  } catch (e) {
    state.loadError = "No se pudo cargar el menú en línea. Mostrando respaldo o última copia.";
    if (state.menu.length === 0) state.menu = defaultMenu();
  }
}

function itemById(id) {
  return state.menu.find((m) => m.id === id);
}

function calculateCartTotal() {
  let sum = 0;
  for (const [id, qty] of state.cart) {
    const item = itemById(id);
    if (!item || qty <= 0) continue;
    sum += parsePriceToDouble(item.price) * qty;
  }
  return sum;
}

function includedDrinkQty() {
  let n = 0;
  for (const [id, qty] of state.cart) {
    const item = itemById(id);
    if (!item || qty <= 0) continue;
    const byId = CONFIG.freeDrinkItemIds.has(id);
    const byDesc = /incluye bebida/i.test(item.description || "");
    if (byId || byDesc) n += qty;
  }
  return n;
}

function calculateDrinksTotal() {
  const selected = DRINK_LABELS.reduce((s, d) => s + (state.drinks[d] || 0), 0);
  const billable = Math.max(0, selected - includedDrinkQty());
  return CONFIG.drinkUnitPrice * billable;
}

function calculateDeliveryFee() {
  return state.delivery ? CONFIG.deliveryFee : 0;
}

function calculateOrderTotal() {
  return calculateCartTotal() + calculateDrinksTotal() + calculateDeliveryFee() + calculateDessertsTotal();
}

function cartCount() {
  let n = 0;
  for (const q of state.cart.values()) n += q;
  return n;
}

function setQty(id, qty) {
  if (qty <= 0) state.cart.delete(id);
  else state.cart.set(id, qty);
  saveState();
  render();
}

function addToCart(id) {
  const cur = state.cart.get(id) || 0;
  state.cart.set(id, cur + 1);
  saveState();
  render();
}

function animateAddFeedback(addBtn) {
  if (!addBtn) return;
  addBtn.classList.remove("add-feedback");
  // Reinicia la animación si el usuario toca varias veces rápido.
  void addBtn.offsetWidth;
  addBtn.classList.add("add-feedback");

  const bubble = document.createElement("span");
  bubble.className = "add-bubble";
  bubble.textContent = "+1";
  addBtn.appendChild(bubble);
  window.setTimeout(() => bubble.remove(), 650);
}

function renderMenu() {
  const list = $("#menu-list");
  if (!list) return;
  list.innerHTML = "";
  if (state.menu.length === 0) {
    list.innerHTML = '<p class="empty-hint">No hay platos para mostrar.</p>';
    return;
  }
  for (const item of state.menu) {
    const card = document.createElement("article");
    card.className = "menu-card";
    const candidates = resolveMenuImageCandidates(item);
    let img;
    if (candidates.length > 0) {
      const el = document.createElement("img");
      el.className = "menu-card-img";
      el.alt = item.name || "";
      el.loading = "lazy";
      el.decoding = "async";
      el.referrerPolicy = "no-referrer";
      let i = 0;
      el.addEventListener("error", function onImgErr() {
        i += 1;
        if (i < candidates.length) {
          el.src = candidates[i];
        } else {
          el.removeEventListener("error", onImgErr);
          el.replaceWith(makeMenuImagePlaceholder());
        }
      });
      el.src = candidates[0];
      img = el;
    } else {
      img = makeMenuImagePlaceholder();
    }
    const body = document.createElement("div");
    body.className = "menu-card-body";
    body.innerHTML = `
      <h3></h3>
      <p class="desc"></p>
      <div class="menu-card-footer">
        <span class="price"></span>
        <button type="button" class="btn btn-primary btn-add" data-id="">Agregar</button>
      </div>
    `;
    body.querySelector("h3").textContent = item.name;
    body.querySelector(".desc").textContent = item.description || "";
    const priceEl = body.querySelector(".price");
    priceEl.textContent = item.price;
    const addBtn = body.querySelector(".btn-add");
    addBtn.dataset.id = item.id;
    addBtn.addEventListener("click", () => {
      animateAddFeedback(addBtn);
      addToCart(item.id);
    });
    card.append(img, body);
    list.appendChild(card);
  }
}

/* =========================
   POSTRES
========================= */

function renderDesserts() {
  const section = $("#desserts-section");
  const list = $("#desserts-list");
  if (!section || !list) return;

  if (!state.desserts || state.desserts.length === 0) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  list.innerHTML = "";

  for (const item of state.desserts) {
    const card = document.createElement("article");
    card.className = "menu-card is-dessert";
    const emoji = dessertEmojiFor(item);
    const candidates = resolveMenuImageCandidates(item);
    const imgWrap = document.createElement("div");
    imgWrap.className = "menu-card-img-wrap";

    let img;
    if (candidates.length > 0) {
      const el = document.createElement("img");
      el.className = "menu-card-img";
      el.alt = item.name || "";
      el.loading = "lazy";
      el.decoding = "async";
      el.referrerPolicy = "no-referrer";
      let i = 0;
      el.addEventListener("error", function onImgErr() {
        i += 1;
        if (i < candidates.length) {
          el.src = candidates[i];
        } else {
          el.removeEventListener("error", onImgErr);
          el.replaceWith(makeMenuImagePlaceholder({ dessert: true, emoji }));
        }
      });
      el.src = candidates[0];
      img = el;
    } else {
      img = makeMenuImagePlaceholder({ dessert: true, emoji });
    }

    const badge = document.createElement("span");
    badge.className = "menu-badge";
    badge.textContent = "Pre-orden";

    imgWrap.append(img, badge);

    const body = document.createElement("div");
    body.className = "menu-card-body";
    const minPrice = Math.min(...item.sizes.map((s) => s.price));
    body.innerHTML = `
      <h3></h3>
      <p class="desc"></p>
      <div class="menu-card-footer">
        <span class="price"></span>
        <button type="button" class="btn btn-primary btn-add">Pedir</button>
      </div>
    `;
    body.querySelector("h3").textContent = item.name;
    body.querySelector(".desc").textContent = item.description || "";
    body.querySelector(".price").textContent = `desde $${minPrice.toFixed(2).replace(/\.00$/, "")}`;
    body.querySelector(".btn-add").addEventListener("click", () => openDessertModal(item));

    card.append(imgWrap, body);
    list.appendChild(card);
  }
}

/* ----- Modal state & helpers ----- */
let pendingDessert = null;
let pendingSizeId = null;

function toISODate(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function formatFriendlyDate(iso) {
  if (!iso) return "";
  const [y, m, d] = String(iso).split("-").map(Number);
  if (!y || !m || !d) return iso;
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long" });
}

function openDessertModal(item, existingEntryIndex = -1) {
  const existing = existingEntryIndex >= 0 ? state.dessertOrders[existingEntryIndex] : null;
  pendingDessert = { item, existingEntryIndex };

  const modal = $("#dessert-modal");
  const dateInput = $("#dessert-date");
  const notesInput = $("#dessert-notes");
  const title = $("#dessert-modal-title");
  const subtitle = $("#dessert-modal-subtitle");
  if (!modal || !dateInput || !notesInput) return;

  const today = new Date();
  const minDate = new Date();
  minDate.setDate(today.getDate() + 1);
  const maxDate = new Date();
  maxDate.setDate(today.getDate() + 30);
  dateInput.min = toISODate(minDate);
  dateInput.max = toISODate(maxDate);

  if (existing) {
    title.textContent = `Editar ${item.name}`;
    subtitle.textContent = `Ajusta tamaño, fecha o notas.`;
    dateInput.value = existing.orderDate || toISODate(minDate);
    notesInput.value = existing.notes || "";
    pendingSizeId = existing.sizeId || item.sizes[0].id;
  } else {
    title.textContent = item.name;
    subtitle.textContent = `Elige tamaño y cuándo lo quieres recibir.`;
    dateInput.value = toISODate(minDate);
    notesInput.value = "";
    pendingSizeId = item.sizes[0].id;
  }

  renderSizeOptions(item);
  renderQuickDates(dateInput.value);

  modal.hidden = false;
  modal.setAttribute("aria-hidden", "false");
  requestAnimationFrame(() => modal.classList.add("show"));
  document.body.style.overflow = "hidden";
}

function closeDessertModal() {
  const modal = $("#dessert-modal");
  if (!modal) return;
  modal.classList.remove("show");
  modal.setAttribute("aria-hidden", "true");
  setTimeout(() => {
    modal.hidden = true;
    document.body.style.overflow = "";
  }, 220);
  pendingDessert = null;
  pendingSizeId = null;
}

function renderSizeOptions(item) {
  const container = $("#dessert-sizes");
  if (!container) return;
  container.innerHTML = "";
  for (const size of item.sizes) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "size-option" + (size.id === pendingSizeId ? " active" : "");
    btn.innerHTML = `
      <div class="size-option-info">
        <span class="size-option-label"></span>
        <span class="size-option-desc"></span>
      </div>
      <span class="size-option-price"></span>
    `;
    const labelEl = btn.querySelector(".size-option-label");
    labelEl.textContent = size.label;
    if (size.badge) {
      const b = document.createElement("span");
      b.className = "size-option-badge";
      b.textContent = size.badge;
      labelEl.appendChild(b);
    }
    btn.querySelector(".size-option-desc").textContent = size.desc || "";
    btn.querySelector(".size-option-price").textContent = `$${size.price.toFixed(2).replace(/\.00$/, "")}`;
    btn.addEventListener("click", () => {
      pendingSizeId = size.id;
      renderSizeOptions(item);
    });
    container.appendChild(btn);
  }
}

function renderQuickDates(selectedIso) {
  const container = $("#dessert-quick-dates");
  if (!container) return;
  container.innerHTML = "";
  const base = new Date();
  const offsets = [1, 2, 3, 7];
  const labels = ["Mañana", "Pasado mañana", "En 3 días", "En 1 semana"];
  offsets.forEach((offset, i) => {
    const d = new Date();
    d.setDate(base.getDate() + offset);
    const iso = toISODate(d);
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "quick-chip" + (iso === selectedIso ? " active" : "");
    chip.textContent = labels[i];
    chip.addEventListener("click", () => {
      const input = $("#dessert-date");
      if (input) input.value = iso;
      renderQuickDates(iso);
    });
    container.appendChild(chip);
  });
}

function confirmDessert() {
  if (!pendingDessert) return;
  const dateInput = $("#dessert-date");
  const notesInput = $("#dessert-notes");
  if (!dateInput || !notesInput) return;
  const orderDate = dateInput.value;
  const notes = notesInput.value.trim();
  if (!orderDate) {
    alert("Por favor elige una fecha.");
    return;
  }

  const { item, existingEntryIndex } = pendingDessert;
  const size = item.sizes.find((s) => s.id === pendingSizeId) || item.sizes[0];

  const entry = {
    catalogId: item.id,
    nameSnapshot: item.name,
    sizeId: size.id,
    sizeLabel: size.label,
    unitPrice: size.price,
    qty: 1,
    orderDate,
    notes,
  };

  if (existingEntryIndex >= 0) {
    entry.qty = state.dessertOrders[existingEntryIndex].qty || 1;
    state.dessertOrders[existingEntryIndex] = entry;
  } else {
    /* Si coincide catalog+size+date+notes, incrementa qty. */
    const dup = state.dessertOrders.findIndex(
      (d) => d.catalogId === entry.catalogId && d.sizeId === entry.sizeId && d.orderDate === entry.orderDate && (d.notes || "") === (entry.notes || "")
    );
    if (dup >= 0) {
      state.dessertOrders[dup].qty = (state.dessertOrders[dup].qty || 1) + 1;
    } else {
      state.dessertOrders.push(entry);
    }
  }

  saveState();
  closeDessertModal();
  render();
}

function changeDessertQty(index, delta) {
  const entry = state.dessertOrders[index];
  if (!entry) return;
  entry.qty = (entry.qty || 1) + delta;
  if (entry.qty <= 0) state.dessertOrders.splice(index, 1);
  saveState();
  renderOrder();
}

function editDessertEntry(index) {
  const entry = state.dessertOrders[index];
  if (!entry) return;
  const catalogItem = state.desserts.find((d) => d.id === entry.catalogId);
  if (!catalogItem) {
    alert("Este postre ya no está disponible en el menú.");
    return;
  }
  openDessertModal(catalogItem, index);
}

function renderDessertOrders() {
  const wrap = $("#dessert-orders-wrap");
  const linesEl = $("#dessert-order-lines");
  if (!wrap || !linesEl) return;
  linesEl.innerHTML = "";

  if (!state.dessertOrders || state.dessertOrders.length === 0) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;

  state.dessertOrders.forEach((entry, index) => {
    const qty = entry.qty || 1;
    const li = document.createElement("li");

    const left = document.createElement("span");
    left.textContent = `${qty}× ${entry.nameSnapshot}`;

    const controls = document.createElement("div");
    controls.className = "qty-controls";

    const minus = document.createElement("button");
    minus.type = "button";
    minus.className = "qty-btn qty-btn-minus";
    minus.setAttribute("aria-label", `Quitar ${entry.nameSnapshot}`);
    minus.textContent = "−";
    minus.addEventListener("click", () => changeDessertQty(index, -1));

    const num = document.createElement("span");
    num.className = "qty-value";
    num.textContent = String(qty);

    const plus = document.createElement("button");
    plus.type = "button";
    plus.className = "qty-btn qty-btn-plus";
    plus.setAttribute("aria-label", `Agregar ${entry.nameSnapshot}`);
    plus.textContent = "+";
    plus.addEventListener("click", () => changeDessertQty(index, +1));

    controls.append(minus, num, plus);

    const meta = document.createElement("div");
    meta.className = "dessert-meta";

    const sizeChip = document.createElement("span");
    sizeChip.className = "dessert-chip dessert-chip-variant";
    sizeChip.textContent = entry.sizeLabel || "";
    meta.appendChild(sizeChip);

    const dateChip = document.createElement("button");
    dateChip.type = "button";
    dateChip.className = "dessert-chip is-clickable";
    dateChip.title = "Editar tamaño o fecha";
    dateChip.innerHTML = `📅 <span></span>`;
    dateChip.querySelector("span").textContent = formatFriendlyDate(entry.orderDate);
    dateChip.addEventListener("click", () => editDessertEntry(index));
    meta.appendChild(dateChip);

    if (entry.notes) {
      const notesChip = document.createElement("span");
      notesChip.className = "dessert-chip";
      notesChip.textContent = `📝 ${entry.notes}`;
      meta.appendChild(notesChip);
    }

    li.append(left, controls, meta);
    linesEl.appendChild(li);
  });
}

function calculateDessertsTotal() {
  let sum = 0;
  for (const entry of state.dessertOrders) {
    sum += (entry.unitPrice || 0) * (entry.qty || 0);
  }
  return sum;
}

function dessertOrdersCount() {
  let n = 0;
  for (const entry of state.dessertOrders) n += entry.qty || 0;
  return n;
}

function renderOrder() {
  const linesEl = $("#order-lines");
  const summaryEl = $("#order-summary");
  if (!linesEl || !summaryEl) return;

  linesEl.innerHTML = "";
  const qtyById = Object.fromEntries(state.cart);

  for (const item of state.menu) {
    const qty = qtyById[item.id] || 0;
    if (qty <= 0) continue;
    const li = document.createElement("li");
    const left = document.createElement("span");
    left.textContent = `${qty}× ${item.name}`;
    const controls = document.createElement("div");
    controls.className = "qty-controls";
    const minus = document.createElement("button");
    minus.type = "button";
    minus.className = "qty-btn qty-btn-minus";
    minus.setAttribute("aria-label", `Quitar ${item.name}`);
    minus.textContent = "−";
    minus.addEventListener("click", () => setQty(item.id, qty - 1));
    const num = document.createElement("span");
    num.className = "qty-value";
    num.textContent = String(qty);
    const plus = document.createElement("button");
    plus.type = "button";
    plus.className = "qty-btn qty-btn-plus";
    plus.setAttribute("aria-label", `Agregar ${item.name}`);
    plus.textContent = "+";
    plus.addEventListener("click", () => setQty(item.id, qty + 1));
    controls.append(minus, num, plus);
    li.append(left, controls);
    linesEl.appendChild(li);
  }

  renderDessertOrders();

  if (linesEl.children.length === 0 && state.dessertOrders.length === 0) {
    linesEl.innerHTML = '<li class="empty-hint">Agrega platos o postres al pedido desde el menú.</li>';
  } else if (linesEl.children.length === 0) {
    linesEl.innerHTML = '<li class="empty-hint">Sin platos (solo postres).</li>';
  }

  const count = cartCount();
  const dCount = dessertOrdersCount();
  const total = calculateOrderTotal();
  if (count === 0 && dCount === 0) {
    summaryEl.textContent = "Agrega platos o postres al pedido desde el menú.";
  } else {
    const parts = [];
    if (count) parts.push(`${count} plato(s)`);
    if (dCount) parts.push(`${dCount} postre(s)`);
    summaryEl.textContent = `${parts.join(" · ")} · Total: $${total.toFixed(2)}`;
  }

  const submitOrderBtn = $("#submit-order");
  if (submitOrderBtn) submitOrderBtn.disabled = count === 0 && dCount === 0;

  const delSwitch = $("#delivery-switch");
  if (delSwitch) delSwitch.checked = state.delivery;
  const payCash = $("#pay-cash");
  const payCa = $("#pay-cashapp");
  if (payCash) payCash.checked = !state.paymentCashApp;
  if (payCa) payCa.checked = state.paymentCashApp;

  for (const d of DRINK_LABELS) {
    const el = document.querySelector(`[data-drink-qty="${escapeAttrSelector(d)}"]`);
    if (el) el.textContent = String(state.drinks[d] || 0);
  }

  const payHint = $("#pay-cashapp-hint");
  const cashAppPreDisclaimer = $("#cashapp-pre-disclaimer");
  const submitBtn = $("#submit-order");
  const isCa = state.paymentCashApp;
  if (submitBtn) {
    if (payHint) payHint.hidden = !isCa;
    if (cashAppPreDisclaimer) cashAppPreDisclaimer.hidden = !isCa;
    submitBtn.textContent = isCa ? "Pagar por Cash App y enviar su pedido" : "Confirmar su pedido";
    const manual = $("#cash-manual-wrap");
    if (manual && !isCa) manual.hidden = true;
    const waLater = $("#wa-after-cash-wrap");
    if (waLater && !isCa) waLater.hidden = true;
  }
}

function render() {
  const err = $("#load-error");
  if (err) {
    err.hidden = !state.loadError;
    err.textContent = state.loadError || "";
  }
  renderMenu();
  renderDesserts();
  renderOrder();
}

function setupForm() {
  $("#delivery-switch")?.addEventListener("change", (e) => {
    state.delivery = e.target.checked;
    saveState();
    renderOrder();
  });
  $("#pay-cash")?.addEventListener("change", () => {
    state.paymentCashApp = false;
    saveState();
    renderOrder();
  });
  $("#pay-cashapp")?.addEventListener("change", () => {
    state.paymentCashApp = true;
    saveState();
    renderOrder();
  });

  for (const d of DRINK_LABELS) {
    document.querySelector(`[data-drink-plus="${escapeAttrSelector(d)}"]`)?.addEventListener("click", () => {
      state.drinks[d] = (state.drinks[d] || 0) + 1;
      saveState();
      renderOrder();
    });
    document.querySelector(`[data-drink-minus="${escapeAttrSelector(d)}"]`)?.addEventListener("click", () => {
      state.drinks[d] = Math.max(0, (state.drinks[d] || 0) - 1);
      saveState();
      renderOrder();
    });
  }

  $("#btn-refresh-menu")?.addEventListener("click", async () => {
    await fetchMenu();
    render();
  });

  /* Dessert modal wiring */
  $("#dessert-modal-close")?.addEventListener("click", closeDessertModal);
  $("#dessert-modal-cancel")?.addEventListener("click", closeDessertModal);
  $("#dessert-modal-confirm")?.addEventListener("click", confirmDessert);
  $("#dessert-modal")?.addEventListener("click", (e) => {
    if (e.target && e.target.id === "dessert-modal") closeDessertModal();
  });
  $("#dessert-date")?.addEventListener("change", (e) => renderQuickDates(e.target.value));
  document.addEventListener("keydown", (e) => {
    const modal = $("#dessert-modal");
    if (e.key === "Escape" && modal && !modal.hidden) closeDessertModal();
  });

  $("#submit-order")?.addEventListener("click", submitOrder);
  $("#open-wa-after-cash")?.addEventListener("click", () => {
    if (!pendingWhatsappUrlAfterCash) {
      alert("No hay pedido pendiente para WhatsApp.");
      return;
    }
    // En mobile/PWA esta ruta es mas confiable que abrir nueva pestana.
    window.location.href = pendingWhatsappUrlAfterCash;
    resetOrderFormAfterSend();
    alert("Listo: se abrió WhatsApp para confirmar tu pedido.");
  });
}

function selectedDrinksList() {
  return DRINK_LABELS.filter((d) => (state.drinks[d] || 0) > 0).map((d) => `${state.drinks[d]}× ${d}`);
}

function cashAppPayUrl(total) {
  const tag = String(CONFIG.cashAppTag || "")
    .trim()
    .replace(/^\$/, "");
  if (!tag) return "";
  const amt = Number(total);
  if (!Number.isFinite(amt) || amt <= 0) return `https://cash.app/$${tag}`;
  return `https://cash.app/$${tag}/${amt.toFixed(2)}`;
}

function buildOrderWhatsappPayload(name, phone, town) {
  const paymentMethod = state.paymentCashApp ? "Cash App" : "Efectivo";
  const drinks = selectedDrinksList();
  const fmt = new Intl.DateTimeFormat("es", { dateStyle: "short", timeStyle: "short" }).format(new Date());
  const linesSnapshot = [...state.cart.entries()].filter(([, q]) => q > 0);

  let text = "";
  text += "===== Pedido Delicia =====\n";
  text += `Fecha: ${fmt}\n`;
  text += `Cliente: ${name}\n`;
  text += `Teléfono: ${phone}\n`;
  text += `Pueblo: ${town}\n`;
  text += `Delivery: ${state.delivery ? "Sí" : "No (recoge en local)"}\n`;
  text += `Pago: ${paymentMethod}\n`;
  if (state.paymentCashApp && CONFIG.cashAppTag.trim()) {
    text += `Cash App: ${CONFIG.cashAppTag}\n`;
  }
  text += `Bebidas: ${drinks.length ? drinks.join(", ") : "Ninguna"}\n`;
  if (linesSnapshot.length > 0) {
    text += "--- Platos ---\n";
    for (const [id, qty] of linesSnapshot) {
      const item = itemById(id);
      if (!item) continue;
      const unit = parsePriceToDouble(item.price);
      text += `${qty}× ${item.name} @ ${item.price} = $${(unit * qty).toFixed(2)}\n`;
    }
  }
  if (state.dessertOrders && state.dessertOrders.length > 0) {
    text += "--- Postres (pre-orden) ---\n";
    for (const entry of state.dessertOrders) {
      const qty = entry.qty || 1;
      const unit = entry.unitPrice || 0;
      text += `${qty}× ${entry.nameSnapshot} (${entry.sizeLabel}) @ $${unit.toFixed(2)} = $${(unit * qty).toFixed(2)}\n`;
      text += `   📅 Para: ${formatFriendlyDate(entry.orderDate)}\n`;
      if (entry.notes) text += `   📝 ${entry.notes}\n`;
    }
  }
  const drinksTotal = calculateDrinksTotal();
  if (drinks.length) text += `Total bebidas: $${drinksTotal.toFixed(2)}\n`;
  const dessertsTotal = calculateDessertsTotal();
  if (dessertsTotal > 0) text += `Total postres: $${dessertsTotal.toFixed(2)}\n`;
  const delFee = calculateDeliveryFee();
  if (delFee > 0) text += `Cargo delivery: $${delFee.toFixed(2)}\n`;
  const total = calculateOrderTotal();
  text += `Total: $${total.toFixed(2)}\n`;
  text += "==========================\n";

  const businessPhone = CONFIG.restaurantWhatsappE164.replace(/\D/g, "");
  if (businessPhone.length < 10) return { error: "Configura el WhatsApp del negocio en app.js (restaurantWhatsappE164)." };
  const wa = `https://wa.me/${businessPhone}?text=${encodeURIComponent(text)}`;
  return { text, total, wa };
}

function resetOrderFormAfterSend() {
  state.cart = new Map();
  state.dessertOrders = [];
  for (const d of DRINK_LABELS) state.drinks[d] = 0;
  state.delivery = false;
  state.paymentCashApp = false;
  $("#customer-name") && ($("#customer-name").value = "");
  $("#customer-phone") && ($("#customer-phone").value = "");
  $("#customer-town") && ($("#customer-town").value = "");
  const wrap = $("#cash-manual-wrap");
  if (wrap) wrap.hidden = true;
  const waAfterCashWrap = $("#wa-after-cash-wrap");
  if (waAfterCashWrap) waAfterCashWrap.hidden = true;
  pendingWhatsappUrlAfterCash = "";
  saveState();
  render();
}

function showCashManualLink(cashUrl) {
  const wrap = $("#cash-manual-wrap");
  const a = $("#manual-cash-link");
  if (wrap && a) {
    a.href = cashUrl;
    wrap.hidden = false;
  }
}

/**
 * Abre Cash App (primera acción en el clic = menos bloqueos). Devuelve si se abrió una pestaña.
 */
function tryOpenCashAppNewTab(cashUrl) {
  const w = window.open(cashUrl, "_blank", "noopener,noreferrer");
  return !!(w && !w.closed);
}

function openWhatsappUrl(waUrl) {
  const w = window.open(waUrl, "_blank", "noopener,noreferrer");
  if (!w || w.closed) {
    window.location.href = waUrl;
  }
}

function submitOrder() {
  const name = $("#customer-name")?.value?.trim() || "";
  const phone = $("#customer-phone")?.value?.trim() || "";
  const town = $("#customer-town")?.value?.trim() || "";
  if (!name || !phone || !town) {
    alert("Completa nombre, teléfono y pueblo.");
    return;
  }
  if (cartCount() === 0 && dessertOrdersCount() === 0) {
    alert("Agrega al menos un plato o postre al pedido.");
    return;
  }

  const payload = buildOrderWhatsappPayload(name, phone, town);
  if ("error" in payload) {
    alert(payload.error);
    return;
  }
  const { wa, total } = payload;

  if (!state.paymentCashApp) {
    const proceed = window.confirm("Revisa datos y total antes de enviar.");
    if (!proceed) return;
    openWhatsappUrl(wa);
    resetOrderFormAfterSend();
    alert("Listo. Envía el mensaje que se abrió para confirmar el pedido.");
    return;
  }

  const cashUrl = cashAppPayUrl(total);
  if (!cashUrl) {
    alert("Configura el cashtag de Cash App en app.js (cashAppTag).");
    return;
  }

  const openedCash = tryOpenCashAppNewTab(cashUrl);
  if (!openedCash) {
    showCashManualLink(cashUrl);
    alert("No se pudo abrir Cash App automáticamente. Usa el enlace manual.");
  }
  pendingWhatsappUrlAfterCash = wa;
  const waAfterCashWrap = $("#wa-after-cash-wrap");
  if (waAfterCashWrap) waAfterCashWrap.hidden = false;
  alert("Cash App abierto. Después de pagar, vuelve aquí y toca 'Continuar a WhatsApp'.");
}

async function loadOrders() {
  const root = document.getElementById("orders");
  if (!root) return;
  try {
    const url = `${BOT_API_BASE}/orders?t=${Date.now()}`;
    const res = await fetch(url, {
      cache: "no-store",
      mode: "cors",
      headers: {
        "Cache-Control": "no-cache",
        "X-Admin-Token": BOT_API_TOKEN,
      },
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    console.log("📦 orders:", data);
    if (!Array.isArray(data) || data.length === 0) {
      root.innerHTML = '<p class="empty-hint">No hay pedidos recibidos.</p>';
      return;
    }
    root.innerHTML = data
      .map(
        (o) => `
        <div class="order-bot-item">
          <h3>Orden #${o.id ?? "-"}</h3>
          <p class="order-bot-items">${formatOrderItems(o.items)}</p>
          <p class="order-bot-status"><strong>Estado:</strong> ${o.status ?? "pendiente"}</p>
          ${
            o.status === "listo"
              ? '<span class="order-ready-chip">✅ Lista</span>'
              : `<button type="button" class="btn btn-gold btn-order-done" data-order-id="${o.id}">✅ Marcar lista</button>`
          }
        </div>
      `
      )
      .join("");
  } catch {
    root.innerHTML =
      '<p class="empty-hint">No se pudo leer el bot local. Verifica que esté corriendo en localhost:3000.</p>';
  }
}

function formatOrderItems(items) {
  if (!Array.isArray(items) || items.length === 0) return "Sin items";
  return items.map((it) => `${it.qty || 1}x ${it.name || "item"}`).join(" • ");
}

async function markOrderDone(orderId) {
  if (!orderId) return;
  try {
    const res = await fetch(`${BOT_API_BASE}/done/${encodeURIComponent(orderId)}`, {
      method: "POST",
      mode: "cors",
      headers: {
        "Content-Type": "application/json",
        "X-Admin-Token": BOT_API_TOKEN,
      },
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    await loadOrders();
  } catch {
    alert("No se pudo marcar la orden como lista.");
  }
}

function startOrdersPolling() {
  const ordersPanel = document.getElementById("orders-panel");
  const isAdminView = new URLSearchParams(window.location.search).get(ORDERS_ADMIN_PARAM) === ORDERS_ADMIN_VALUE;
  if (!isAdminView) {
    if (ordersPanel) ordersPanel.hidden = true;
    return;
  }
  if (ordersPanel) ordersPanel.hidden = false;

  // Carga inicial y polling continuo.
  loadOrders();
  window.setInterval(() => {
    loadOrders();
  }, 2000);

  // Al volver a enfocar la pestaña, fuerza refresco inmediato.
  window.addEventListener("focus", () => loadOrders());
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) loadOrders();
  });
  document.getElementById("orders")?.addEventListener("click", (event) => {
    const btn = event.target.closest(".btn-order-done");
    if (!btn) return;
    const orderId = btn.getAttribute("data-order-id");
    markOrderDone(orderId);
  });
}

async function init() {
  loadState();
  setupForm();
  await fetchMenu();
  render();
  startOrdersPolling();

  if ("serviceWorker" in navigator) {
    try {
      const reg = await navigator.serviceWorker.register("./sw.js", { scope: "./" });
      reg.update().catch(() => {});
    } catch {
      /* localhost file:// or blocked */
    }
  }
}

init();
