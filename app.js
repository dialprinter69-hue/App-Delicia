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

const state = {
  menu: [],
  cart: new Map(),
  drinks: Object.fromEntries(DRINK_LABELS.map((d) => [d, 0])),
  delivery: false,
  paymentCashApp: false,
  loadError: null,
};

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

function makeMenuImagePlaceholder() {
  const el = document.createElement("div");
  el.className = "menu-card-img";
  el.setAttribute("role", "presentation");
  el.style.background = "linear-gradient(145deg,#1E3D2F,#2D5A45)";
  return el;
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

async function fetchMenu() {
  state.loadError = null;
  const url = CONFIG.remoteMenuJsonUrl.trim();
  if (!url) {
    state.menu = defaultMenu();
    return;
  }
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const list = await res.json();
    if (!Array.isArray(list) || list.length === 0) throw new Error("Menú vacío");
    state.menu = list;
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
  return calculateCartTotal() + calculateDrinksTotal() + calculateDeliveryFee();
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

  if (linesEl.children.length === 0) {
    linesEl.innerHTML = '<li class="empty-hint">Agrega platos al pedido desde el menú.</li>';
  }

  const count = cartCount();
  const total = calculateOrderTotal();
  if (count === 0) {
    summaryEl.textContent = "Agrega platos al pedido desde el menú.";
  } else {
    summaryEl.textContent = `${count} plato(s) en el pedido · Total: $${total.toFixed(2)}`;
  }

  const submitOrderBtn = $("#submit-order");
  if (submitOrderBtn) submitOrderBtn.disabled = count === 0;

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
  const submitBtn = $("#submit-order");
  if (payHint && submitBtn) {
    const isCa = state.paymentCashApp;
    payHint.hidden = !isCa;
    submitBtn.textContent = isCa ? "Pagar por Cash App y enviar su pedido" : "Confirmar su pedido";
    const manual = $("#cash-manual-wrap");
    if (manual && !isCa) manual.hidden = true;
  }
}

function render() {
  const err = $("#load-error");
  if (err) {
    err.hidden = !state.loadError;
    err.textContent = state.loadError || "";
  }
  renderMenu();
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

  $("#submit-order")?.addEventListener("click", submitOrder);
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
  text += "--- Platos ---\n";
  for (const [id, qty] of linesSnapshot) {
    const item = itemById(id);
    if (!item) continue;
    const unit = parsePriceToDouble(item.price);
    text += `${qty}× ${item.name} @ ${item.price} = $${(unit * qty).toFixed(2)}\n`;
  }
  const drinksTotal = calculateDrinksTotal();
  if (drinks.length) text += `Total bebidas: $${drinksTotal.toFixed(2)}\n`;
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
  for (const d of DRINK_LABELS) state.drinks[d] = 0;
  state.delivery = false;
  state.paymentCashApp = false;
  $("#customer-name") && ($("#customer-name").value = "");
  $("#customer-phone") && ($("#customer-phone").value = "");
  $("#customer-town") && ($("#customer-town").value = "");
  const wrap = $("#cash-manual-wrap");
  if (wrap) wrap.hidden = true;
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
  if (cartCount() === 0) {
    alert("Agrega al menos un plato al pedido.");
    return;
  }

  const payload = buildOrderWhatsappPayload(name, phone, town);
  if ("error" in payload) {
    alert(payload.error);
    return;
  }
  const { wa, total } = payload;
  const shortDisclaimer = "Revisa datos y total antes de enviar.";
  const proceed = window.confirm(shortDisclaimer);
  if (!proceed) return;

  if (!state.paymentCashApp) {
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
  openWhatsappUrl(wa);
  resetOrderFormAfterSend();
  alert("Listo: paga en Cash App y confirma el mensaje de WhatsApp.");
}

async function init() {
  loadState();
  setupForm();
  await fetchMenu();
  render();

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
