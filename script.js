/* HairRate — онлайн-версия: аккаунты и общий каталог на Supabase.
   Клиент к Supabase написан на fetch, без внешних библиотек. */

const CONFIG = window.HAIRRATE_CONFIG || {};
const SUPABASE_URL = String(CONFIG.supabaseUrl || "").replace(/\/+$/, "");
const SUPABASE_KEY = String(CONFIG.supabaseKey || "");
const BUCKET = "photos";

const SESSION_KEY = "hairrate_session";
const THEME_KEY = "hairrate_theme";

const IMAGE_MAX_SIDE = 1400;
const IMAGE_QUALITY = 0.82;

const DEFAULT_FILE_HINT = "JPG, PNG или WEBP · можно перетащить сюда";
const ANON = "Аноним";
const MAX_TAGS = 6;
const MAX_EXTRA_PHOTOS = 3;
const PRESET_TAGS = ["Короткие", "Средние", "Длинные", "Фейд", "Кудри", "Укладка", "Окрашивание"];
const DAY = 24 * 60 * 60 * 1000;
const PERIODS = { week: 7, month: 30, year: 365, all: null };
const USERNAME_RE = /^[A-Za-zА-Яа-яЁё0-9_.-]{3,24}$/;
const REFRESH_AFTER_MS = 60 * 1000;

// Словесная шкала поверх итогового балла 4–67 (сама формула не меняется).
const VERDICTS = [
  { min: 60, label: "Шедевр", tier: "top" },
  { min: 50, label: "Отлично", tier: "high" },
  { min: 40, label: "Хорошо", tier: "high" },
  { min: 30, label: "Нормально", tier: "mid" },
  { min: 20, label: "Слабо", tier: "low" },
  { min: -Infinity, label: "Провал", tier: "low" }
];

let photos = [];
let profiles = [];
let me = null;                 // { id, username, is_admin }
let session = null;            // { access_token, refresh_token, expires_at, user: { id, email } }
let loadState = "loading";     // "loading" | "ready" | "error"
let lastLoadedAt = 0;
let lastLoadError = null;

let selectedPhotoId = null;
let draftMain = null;          // { src, path? , data? }
let draftExtras = [];
let pendingImages = 0;
let editingPhotoId = null;
let editingReviewId = null;
let detailImageIndex = 0;
let lightboxIndex = 0;
let searchQuery = "";
let sortMode = "new";
let tagFilter = null;
let draftTags = [];
let topPeriod = "all";
let feedTextOnly = false;
let catalogScroll = 0;
let authMode = "login";
let afterLoginHash = "#/";

const catalogView = document.getElementById("catalogView");
const detailView = document.getElementById("detailView");
const createView = document.getElementById("createView");
const reviewView = document.getElementById("reviewView");
const authView = document.getElementById("authView");
const topView = document.getElementById("topView");
const feedView = document.getElementById("feedView");
const usersView = document.getElementById("usersView");
const userView = document.getElementById("userView");
const compareView = document.getElementById("compareView");
const allViews = [catalogView, detailView, createView, reviewView, authView, topView, feedView, usersView, userView, compareView];
const hairGrid = document.getElementById("hairGrid");

const fields = {
  accuracy: document.getElementById("accuracy"),
  beauty: document.getElementById("beauty"),
  appearance: document.getElementById("appearance"),
  personal: document.getElementById("personal")
};

const values = {
  accuracy: document.getElementById("accuracyValue"),
  beauty: document.getElementById("beautyValue"),
  appearance: document.getElementById("appearanceValue"),
  personal: document.getElementById("personalValue")
};

const criteria = [
  { key: "accuracy", label: "Аккуратность", short: "Аккуратность", max: 9 },
  { key: "beauty", label: "Красота", short: "Красота", max: 9 },
  { key: "appearance", label: "Как выглядит на человеке", short: "На человеке", max: 9 },
  { key: "personal", label: "Личное восприятие", short: "Восприятие", max: 10 }
];

/* =====================================================================
   Клиент Supabase: вход (auth), данные (REST), фото (storage)
   ===================================================================== */

class ApiError extends Error {
  constructor(message, status = 0, code = "", details = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function isConfigured() {
  return /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(SUPABASE_URL) && !/YOUR-PROJECT/i.test(SUPABASE_URL) && SUPABASE_KEY.length > 10
    || /^http:\/\/localhost:\d+$/.test(SUPABASE_URL);
}

async function rawRequest(path, { method = "GET", body, headers = {}, auth = true } = {}) {
  const requestHeaders = { apikey: SUPABASE_KEY, ...headers };

  if (auth && session) {
    await ensureFreshSession();
    if (session) requestHeaders.Authorization = `Bearer ${session.access_token}`;
  }
  // Старый формат ключа (anon, начинается с eyJ) — это JWT, его передают и в Authorization
  if (!requestHeaders.Authorization && SUPABASE_KEY.startsWith("eyJ")) {
    requestHeaders.Authorization = `Bearer ${SUPABASE_KEY}`;
  }

  let payload = body;
  if (body !== undefined && !(body instanceof Blob)) {
    requestHeaders["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(SUPABASE_URL + path, { method, headers: requestHeaders, body: payload });
  } catch {
    throw new ApiError("network", 0, "network");
  }

  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  if (!response.ok) {
    const message = (data && (data.msg || data.message || data.error_description || data.error)) || `HTTP ${response.status}`;
    const code = (data && (data.error_code || data.code)) || "";
    throw new ApiError(String(message), response.status, String(code), data);
  }
  return data;
}

/* ---------- Сессия ---------- */

function normalizeSession(data) {
  if (!data?.access_token) return null;
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at || Math.floor(Date.now() / 1000) + Number(data.expires_in || 3600),
    user: { id: data.user?.id, email: data.user?.email }
  };
}

function storeSession(next) {
  session = next;
  try {
    if (next) localStorage.setItem(SESSION_KEY, JSON.stringify(next));
    else localStorage.removeItem(SESSION_KEY);
  } catch { /* сессия проживёт до закрытия вкладки */ }
}

function loadStoredSession() {
  try {
    const stored = JSON.parse(localStorage.getItem(SESSION_KEY));
    return stored?.access_token && stored?.refresh_token ? stored : null;
  } catch {
    return null;
  }
}

let refreshPromise = null;

async function ensureFreshSession() {
  if (!session) return;
  if (session.expires_at * 1000 - Date.now() > 60 * 1000) return;

  if (!refreshPromise) {
    refreshPromise = (async () => {
      try {
        const data = await rawRequest("/auth/v1/token?grant_type=refresh_token", {
          method: "POST",
          auth: false,
          body: { refresh_token: session.refresh_token }
        });
        storeSession(normalizeSession(data));
      } catch (error) {
        if (error.status >= 400 && error.status < 500) {
          storeSession(null);
          me = null;
          updateAuthUI();
          showToast("Сессия закончилась, войдите заново.");
        }
      } finally {
        refreshPromise = null;
      }
    })();
  }
  await refreshPromise;
}

/* ---------- Вход и регистрация ---------- */

async function apiSignUp(email, password, username) {
  const data = await rawRequest("/auth/v1/signup", {
    method: "POST",
    auth: false,
    body: { email, password, data: { username } }
  });
  const next = normalizeSession(data);
  if (!next) throw new ApiError("confirm_required", 200, "confirm_required");
  storeSession(next);
}

async function apiSignIn(email, password) {
  const data = await rawRequest("/auth/v1/token?grant_type=password", {
    method: "POST",
    auth: false,
    body: { email, password }
  });
  storeSession(normalizeSession(data));
}

async function apiSignOut() {
  try {
    if (session) await rawRequest("/auth/v1/logout", { method: "POST" });
  } catch { /* выходим локально в любом случае */ }
  storeSession(null);
  me = null;
}

/* ---------- Данные ---------- */

// У hairstyles две связи с profiles (owner и wearer), поэтому связь для ника автора указана явно.
const HAIRSTYLE_SELECT = [
  "id", "owner", "wearer", "title", "description", "tags", "images", "created_at",
  "owner_profile:profiles!hairstyles_owner_fkey(username)",
  "reviews(id,author,legacy_author,text,accuracy,beauty,appearance,personal,score,created_at,edited_at,author_profile:profiles(username))"
].join(",");

// Колонки, которых может не быть в базе со старой схемой
const OPTIONAL_COLUMNS = ["wearer", "legacy_author"];

function rest(path, options = {}) {
  return rawRequest(`/rest/v1/${path}`, options);
}

function withoutColumns(select, columns) {
  return columns.reduce((result, column) => result.replace(`${column},`, ""), select);
}

async function apiLoadAll() {
  const people = rest("profiles?select=id,username,is_admin,created_at&order=created_at.asc");
  let missing = [];
  let rows;
  while (!rows) {
    try {
      rows = await rest(`hairstyles?select=${encodeURIComponent(withoutColumns(HAIRSTYLE_SELECT, missing))}&order=created_at.desc`);
    } catch (error) {
      // База со старой схемой (без новых колонок): убираем недостающие и грузим снова
      const left = OPTIONAL_COLUMNS.filter(column => !missing.includes(column));
      const named = left.filter(column => String(error.message || "").includes(column));
      if (left.length && (named.length || error.code === "42703")) {
        missing = missing.concat(named.length ? named : left);
      } else {
        people.catch(() => {});
        throw error;
      }
    }
  }
  return { rows, people: await people };
}

async function apiUsernameTaken(username) {
  const pattern = username.replace(/[\\_%]/g, match => `\\${match}`);
  const rows = await rest(`profiles?select=id&username=ilike.${encodeURIComponent(pattern)}`);
  return rows.length > 0;
}

async function apiInsert(table, row) {
  const rows = await rest(`${table}?select=id`, {
    method: "POST",
    body: row,
    headers: { Prefer: "return=representation" }
  });
  return rows[0];
}

async function apiUpdate(table, id, changes) {
  const rows = await rest(`${table}?id=eq.${encodeURIComponent(id)}&select=id`, {
    method: "PATCH",
    body: changes,
    headers: { Prefer: "return=representation" }
  });
  if (!rows.length) throw new ApiError("forbidden", 403, "no_rows");
}

async function apiDelete(table, id) {
  const rows = await rest(`${table}?id=eq.${encodeURIComponent(id)}&select=id`, {
    method: "DELETE",
    headers: { Prefer: "return=representation" }
  });
  if (!rows.length) throw new ApiError("forbidden", 403, "no_rows");
}

/* ---------- Фото ---------- */

function encodePath(path) {
  return String(path).split("/").map(encodeURIComponent).join("/");
}

function publicUrl(path) {
  return path ? `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${encodePath(path)}` : "";
}

async function apiUploadImage(blob) {
  const random = Math.random().toString(36).slice(2, 10);
  const path = `${session.user.id}/${Date.now()}-${random}.jpg`;
  await rawRequest(`/storage/v1/object/${BUCKET}/${encodePath(path)}`, {
    method: "POST",
    body: blob,
    headers: { "Content-Type": blob.type || "image/jpeg", "x-upsert": "false", "cache-control": "max-age=31536000" }
  });
  return path;
}

async function apiRemoveImages(paths) {
  if (!paths.length) return;
  await rawRequest(`/storage/v1/object/${BUCKET}`, { method: "DELETE", body: { prefixes: paths } });
}

/* ---------- Ошибки понятным языком ---------- */

function humanError(error) {
  const message = String(error?.message || "");
  const code = String(error?.code || "");
  const status = error?.status || 0;

  if (code === "network" || status === 0) return "Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.";
  if (code === "email_provider_disabled" || code === "signup_disabled" || /signups? (are )?(disabled|not allowed)/i.test(message)) {
    return "Регистрация выключена в настройках Supabase. Владельцу сайта: Authentication → Sign In / Providers — включите «Allow new users to sign up» и провайдер Email.";
  }
  if (code === "invalid_credentials" || /invalid login credentials/i.test(message)) return "Неверная почта или пароль.";
  if (code === "user_already_exists" || /already registered/i.test(message)) return "Эта почта уже зарегистрирована. Попробуйте войти.";
  if (code === "weak_password" || /password should be/i.test(message)) return "Пароль слишком простой: нужно не меньше 6 символов.";
  if (/database error saving new user/i.test(message)) return "Этот ник уже занят или содержит недопустимые символы.";
  if (code === "email_not_confirmed" || /email not confirmed/i.test(message)) return "Почта не подтверждена. В настройках Supabase нужно выключить «Confirm email».";
  if (code === "confirm_required") return "Аккаунт создан, но требует подтверждения почты. В настройках Supabase выключите «Confirm email», затем войдите.";
  if (code === "email_address_invalid" || /invalid format|validate email/i.test(message)) return "Проверьте адрес почты.";
  if (status === 429 || /rate limit/i.test(message)) return "Слишком много попыток. Подождите минуту.";
  if (code === "23505") return "Такая запись уже есть.";
  if (code === "PGRST204" || /legacy_author/.test(message)) return "База устарела: выполните в Supabase последнюю версию setup.sql.";
  if (status === 413 || /too large/i.test(message)) return "Фото слишком большое.";
  if (code === "no_rows") return "Эта запись уже удалена или изменена в другом месте. Данные обновлены, попробуйте ещё раз.";
  if (status === 401 || status === 403 || code === "42501") return "Нет прав на это действие. Попробуйте войти заново.";
  return `Что-то пошло не так (${message}). Попробуйте ещё раз.`;
}

/* =====================================================================
   Данные в интерфейсе
   ===================================================================== */

function toTime(value) {
  const time = Date.parse(value);
  return Number.isNaN(time) ? 0 : time;
}

function mapHairstyle(row) {
  const images = (Array.isArray(row.images) ? row.images : []).filter(Boolean);
  return {
    id: row.id,
    owner: row.owner,
    ownerName: row.owner_profile?.username || "удалённый участник",
    wearer: row.wearer || null,
    title: row.title,
    description: row.description || "",
    tags: Array.isArray(row.tags) ? row.tags : [],
    paths: images,
    image: publicUrl(images[0]),
    extra: images.slice(1).map(publicUrl),
    created: toTime(row.created_at),
    reviews: (row.reviews || []).map(review => ({
      id: review.id,
      authorId: review.author,
      author: review.author_profile?.username || review.legacy_author || ANON,
      legacy: Boolean(review.legacy_author),
      text: review.text || "",
      accuracy: review.accuracy,
      beauty: review.beauty,
      appearance: review.appearance,
      personal: review.personal,
      score: review.score,
      created: toTime(review.created_at),
      edited: review.edited_at ? toTime(review.edited_at) : null
    }))
  };
}

async function refreshData() {
  const { rows, people } = await apiLoadAll();
  photos = rows.map(mapHairstyle);
  profiles = people;
  me = session ? profiles.find(profile => profile.id === session.user.id) || null : null;
  loadState = "ready";
  lastLoadedAt = Date.now();
  updateAuthUI();
}

function getPhoto(id) {
  return photos.find(item => item.id === id);
}

function getTags(photo) {
  return Array.isArray(photo?.tags) ? photo.tags : [];
}

function getImages(photo) {
  return [photo.image, ...(photo.extra || [])].filter(Boolean);
}

function authorOf(review) {
  return String(review?.author || "").trim() || ANON;
}

function allReviews() {
  return photos.flatMap(photo => (photo.reviews || []).map(review => ({ review, photo })));
}

function myReview(photo) {
  return me ? (photo.reviews || []).find(review => review.authorId === me.id) : null;
}

// Владелец прически — участник, которому прическу «выдали» в базе (колонка wearer)
function wearerOf(photo) {
  return photo?.wearer ? profiles.find(profile => profile.id === photo.wearer) || null : null;
}

function wornBy(profileId) {
  return photos.filter(photo => photo.wearer && photo.wearer === profileId);
}

function canEditPhoto(photo) {
  return Boolean(me && photo.owner === me.id);
}

function canDeletePhoto(photo) {
  return Boolean(me && (photo.owner === me.id || me.is_admin));
}

function canDeleteReview(review) {
  return Boolean(me && (review.authorId === me.id || me.is_admin));
}

/* ---------- Формула (без изменений; та же стоит в базе) ---------- */

function calculateScore(accuracy, beauty, appearance, personal) {
  const normalized =
    0.2 * (accuracy - 1) / 8 +
    0.2 * (beauty - 1) / 8 +
    0.2 * (appearance - 1) / 8 +
    0.4 * (personal - 1) / 9;

  return Math.round(4 + 63 * normalized);
}

function getAverageScore(photo) {
  if (!photo.reviews || photo.reviews.length === 0) return null;
  const total = photo.reviews.reduce((sum, review) => sum + review.score, 0);
  return Math.round(total / photo.reviews.length);
}

function getVerdict(score) {
  return VERDICTS.find(item => score >= item.min);
}

function criteriaAverages(photo) {
  const reviews = photo.reviews || [];
  if (!reviews.length) return null;
  const result = {};
  criteria.forEach(({ key }) => {
    result[key] = reviews.reduce((sum, review) => sum + Number(review[key] || 0), 0) / reviews.length;
  });
  return result;
}

function byScore(a, b) {
  return (getAverageScore(b) ?? -1) - (getAverageScore(a) ?? -1) ||
    (b.reviews?.length || 0) - (a.reviews?.length || 0) ||
    b.created - a.created;
}

/* ---------- Утилиты ---------- */

function plural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function formatCount(n, one, few, many) {
  return `${n} ${plural(n, one, few, many)}`;
}

function formatDate(timestamp) {
  const date = new Date(timestamp);
  if (!timestamp || Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
}

function formatDecimal(value) {
  return value.toFixed(1).replace(".", ",");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isSafeImage(value) {
  return typeof value === "string" &&
    /^data:image\/(png|jpe?g|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(value);
}

function normalizeTag(value) {
  const tag = String(value || "").trim().replace(/\s+/g, " ").slice(0, 24);
  return tag ? tag[0].toUpperCase() + tag.slice(1) : "";
}

function hairHref(id) {
  return `#/hair/${id}`;
}

function userHref(name) {
  return `#/user/${encodeURIComponent(name)}`;
}

function initial(name) {
  return (Array.from(String(name).trim())[0] || "?").toUpperCase();
}

function cssUrl(url) {
  return `url("${String(url).replace(/["\\\n]/g, "")}")`;
}

function setImageBackgrounds(root) {
  root.querySelectorAll("[data-bg-id]").forEach(element => {
    const photo = getPhoto(Number(element.dataset.bgId));
    if (photo) element.style.setProperty("--image-bg", cssUrl(photo.image));
  });
}

function safeFileName(title) {
  return String(title).replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, "-").slice(0, 40) || "hairrate";
}

function dataUrlToBlob(dataUrl) {
  const [head, base64] = dataUrl.split(",");
  const mime = (head.match(/data:(.*?);/) || [])[1] || "image/jpeg";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mime });
}

function setBusy(button, busy, label) {
  if (busy) {
    button.dataset.idleLabel = button.textContent;
    button.textContent = label;
    button.disabled = true;
  } else {
    if (button.dataset.idleLabel) button.textContent = button.dataset.idleLabel;
    button.disabled = false;
  }
}

// Удаление в два нажатия: первое меняет надпись, второе — удаляет
function confirmClick(button, confirmLabel, action) {
  if (button.dataset.confirming === "1") {
    clearTimeout(Number(button.dataset.confirmTimer));
    button.dataset.confirming = "";
    button.classList.remove("confirming");
    button.textContent = button.dataset.originalLabel;
    action();
    return;
  }
  button.dataset.originalLabel = button.textContent;
  button.dataset.confirming = "1";
  button.classList.add("confirming");
  button.textContent = confirmLabel;
  button.dataset.confirmTimer = String(setTimeout(() => {
    button.dataset.confirming = "";
    button.classList.remove("confirming");
    button.textContent = button.dataset.originalLabel;
  }, 4000));
}

/* ---------- Уведомления ---------- */

let toastTimer;
let toastActionHandler = null;

function showToast(message, { duration = 3200, action = null } = {}) {
  const toast = document.getElementById("toast");
  const actionButton = document.getElementById("toastAction");
  document.getElementById("toastText").textContent = message;

  toastActionHandler = action ? action.onClick : null;
  actionButton.textContent = action ? action.label : "";
  actionButton.classList.toggle("hidden", !action);

  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, duration);
}

function hideToast() {
  document.getElementById("toast").classList.remove("visible");
  toastActionHandler = null;
}

/* ---------- Тема ---------- */

function effectiveTheme() {
  const theme = document.documentElement.dataset.theme;
  if (theme === "light" || theme === "dark") return theme;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function updateThemeButton() {
  const dark = effectiveTheme() === "dark";
  document.getElementById("themeIconMoon").classList.toggle("hidden", dark);
  document.getElementById("themeIconSun").classList.toggle("hidden", !dark);
  document.getElementById("themeButton").setAttribute("aria-label", dark ? "Включить светлую тему" : "Включить тёмную тему");
}

/* ---------- Сохранение файлов ---------- */

async function saveFile(filename, blob) {
  if (blob.type.startsWith("image/") && window.matchMedia?.("(pointer: coarse)").matches && navigator.canShare) {
    try {
      const file = new File([blob], filename, { type: blob.type });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file] });
        return true;
      }
    } catch (error) {
      if (error?.name === "AbortError") return false;
    }
  }

  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  return true;
}

/* ---------- Аккаунт в шапке и подвале ---------- */

function updateAuthUI() {
  const chip = document.getElementById("meChip");
  const loginButton = document.getElementById("loginButton");
  const signedIn = Boolean(me);

  chip.classList.toggle("hidden", !signedIn);
  loginButton.classList.toggle("hidden", signedIn);
  document.getElementById("logoutButton").classList.toggle("hidden", !signedIn);
  document.getElementById("importButton").classList.toggle("hidden", !signedIn);

  if (signedIn) {
    document.getElementById("meAvatar").textContent = initial(me.username);
    document.getElementById("meName").textContent = me.username;
    chip.setAttribute("href", userHref(me.username));
    document.getElementById("footerInfo").textContent =
      `Вы вошли как ${me.username}${me.is_admin ? " · админ" : ""}`;
  } else {
    document.getElementById("footerInfo").textContent = "Общий каталог HairRate. Смотреть можно всем, оценивать — после входа.";
  }
}

function requireAuth(targetHash, reason) {
  if (me) return true;
  afterLoginHash = targetHash;
  showToast(reason);
  navigate("#/login");
  return false;
}

/* ---------- Общие куски разметки ---------- */

function scoreBadge(score, { size = "md", showVerdict = true } = {}) {
  if (score === null || score === undefined) {
    return `<span class="score-badge size-${size} tier-none"><span class="badge-verdict">Нет оценки</span></span>`;
  }
  const verdict = getVerdict(score);
  return `
    <span class="score-badge size-${size} tier-${verdict.tier}">
      <span class="badge-number"><strong>${score}</strong><small>/ 67</small></span>
      ${showVerdict ? `<span class="badge-verdict">${verdict.tier === "top" ? "✦ " : ""}${verdict.label}</span>` : ""}
    </span>
  `;
}

function criteriaBarsHtml(averages) {
  return criteria.map(({ key, label, max }) => {
    const average = averages[key];
    return `
      <div class="criterion">
        <div class="criterion-top">
          <span>${label}</span>
          <strong>${formatDecimal(average)}<small>/${max}</small></strong>
        </div>
        <div class="criterion-bar"><i style="width: ${((average / max) * 100).toFixed(1)}%"></i></div>
      </div>
    `;
  }).join("");
}

function tagsText(photo) {
  return getTags(photo).map(escapeHtml).join(" · ");
}

function reviewCardHtml(review, photo, { withPhoto = false, actions = false } = {}) {
  const hasText = Boolean(review.text);
  const date = formatDate(review.created);
  const author = authorOf(review);
  const verdict = getVerdict(review.score);
  const isMine = me && review.authorId === me.id;

  return `
    <article class="review-card${withPhoto ? " with-photo" : ""}${isMine ? " mine" : ""}">
      ${withPhoto ? `
        <a class="review-photo" href="${hairHref(photo.id)}" aria-label="${escapeHtml(photo.title)}">
          <img src="${escapeHtml(photo.image)}" alt="" loading="lazy">
        </a>` : ""}
      <div class="review-main">
        ${withPhoto ? `<a class="review-hair" href="${hairHref(photo.id)}">${escapeHtml(photo.title)}</a>` : ""}
        <div class="review-card-top">
          <span class="review-byline">
            ${review.legacy
              ? `<span class="review-author legacy" title="Оценка перенесена из старой версии сайта, без аккаунта">
                   <span class="avatar size-xs">${escapeHtml(initial(author))}</span>${escapeHtml(author)} <em>(из старой версии)</em>
                 </span>`
              : `<a class="review-author" href="${userHref(author)}">
                   <span class="avatar size-xs">${escapeHtml(initial(author))}</span>${escapeHtml(author)}${isMine ? " <em>(вы)</em>" : ""}
                 </a>`}
            <span>${hasText ? "Рецензия" : "Оценка"}${date ? ` · ${date}` : ""}${review.edited ? " · изменено" : ""}</span>
          </span>
          <div class="review-card-side">
            <span class="review-score tier-${verdict.tier}"><strong>${review.score}</strong>/67 · ${verdict.label}</span>
            ${actions && isMine ? `<button type="button" class="review-edit" data-edit-review-id="${review.id}" aria-label="Изменить оценку" title="Изменить">✎</button>` : ""}
            ${actions && canDeleteReview(review) ? `<button type="button" class="review-delete" data-review-id="${review.id}" aria-label="Удалить оценку" title="Удалить">✕</button>` : ""}
          </div>
        </div>
        ${hasText ? `<p>${escapeHtml(review.text)}</p>` : ""}
        <div class="review-metrics">
          ${criteria.map(({ key, short, max }) => `<span>${short} <b>${review[key]}/${max}</b></span>`).join("")}
        </div>
      </div>
    </article>
  `;
}

function emptyState(icon, title, text, action = "") {
  return `
    <div class="empty-catalog">
      <span>${icon}</span>
      <strong>${title}</strong>
      <p>${text}</p>
      ${action}
    </div>
  `;
}

/* =====================================================================
   Навигация
   ===================================================================== */

let routeHash = location.hash || "#/";
let historyWorks = true;
const memoryStack = [];

function currentDepth() {
  return historyWorks ? (history.state?.hrDepth ?? 0) : memoryStack.length;
}

function navigate(hash, { replace = false } = {}) {
  if (hash === routeHash && !replace) {
    handleRoute();
    return;
  }

  if (historyWorks) {
    try {
      if (replace) history.replaceState({ hrDepth: currentDepth() }, "", hash);
      else history.pushState({ hrDepth: currentDepth() + 1 }, "", hash);
    } catch {
      historyWorks = false;
    }
  }
  if (!historyWorks && !replace) memoryStack.push(routeHash);

  routeHash = hash;
  handleRoute();
}

function goBack(fallbackHash) {
  if (currentDepth() > 0) {
    if (historyWorks) {
      history.back();
    } else {
      routeHash = memoryStack.pop();
      handleRoute();
    }
  } else {
    navigate(fallbackHash, { replace: true });
  }
}

function findProfileByName(name) {
  const key = String(name).trim().toLowerCase();
  return profiles.find(profile => profile.username.toLowerCase() === key);
}

function handleRoute() {
  if (!catalogView.classList.contains("hidden")) {
    catalogScroll = window.scrollY;
  }

  const [section, first, second, third] = routeHash.replace(/^#\/?/, "").split("/").filter(Boolean);
  closeLightbox();

  if (section === "login" || section === "signup") {
    if (me) {
      navigate(afterLoginHash || "#/", { replace: true });
      return;
    }
    openAuth(section);
    return;
  }

  if (loadState !== "ready") {
    renderLoading();
    showView(catalogView, { nav: "catalog" });
    return;
  }

  switch (section) {
    case undefined:
      renderCatalog();
      showView(catalogView, { scrollTo: catalogScroll, nav: "catalog" });
      return;

    case "new":
      if (!requireAuth("#/new", "Войдите, чтобы добавить прическу.")) return;
      openCreate();
      return;

    case "me":
      if (!me) {
        afterLoginHash = "#/me";
        navigate("#/login", { replace: true });
        return;
      }
      navigate(userHref(me.username), { replace: true });
      return;

    case "top":
      renderTop();
      showView(topView, { nav: "top" });
      return;

    case "reviews":
      renderFeed();
      showView(feedView, { nav: "reviews" });
      return;

    case "users":
      renderUsers();
      showView(usersView, { nav: "users" });
      return;

    case "user": {
      let name = "";
      try { name = decodeURIComponent(first || ""); } catch { name = ""; }
      const profile = findProfileByName(name);
      if (!profile) {
        navigate("#/users", { replace: true });
        return;
      }
      renderUser(profile);
      showView(userView, { nav: "users" });
      return;
    }

    case "compare":
      openCompare(Number(first) || null, Number(second) || null);
      return;

    case "hair": {
      const id = Number(first);
      const photo = getPhoto(id);
      if (!photo) {
        showToast("Эта прическа больше не существует.");
        navigate("#/", { replace: true });
        return;
      }
      if (second === "edit") {
        if (!requireAuth(routeHash, "Войдите, чтобы изменить прическу.")) return;
        if (!canEditPhoto(photo)) {
          navigate(hairHref(id), { replace: true });
          return;
        }
        openEdit(id);
        return;
      }
      if (second === "rate" || second === "review" || second === "edit-review") {
        if (!requireAuth(routeHash, "Войдите, чтобы поставить оценку.")) return;
        const mine = myReview(photo);
        if (second !== "edit-review" && mine) {
          navigate(`${hairHref(id)}/edit-review/${mine.id}`, { replace: true });
          return;
        }
        openReview(id, second === "edit-review" ? "edit" : second, Number(third));
        return;
      }
      openDetail(id);
      return;
    }

    default:
      navigate("#/", { replace: true });
  }
}

function showView(view, { scrollTo = 0, nav = null } = {}) {
  allViews.forEach(item => item.classList.add("hidden"));
  view.classList.remove("hidden");

  document.querySelectorAll("#mainNav [data-nav]").forEach(link => {
    const active = link.dataset.nav === nav;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });

  window.scrollTo({ top: scrollTo, behavior: "auto" });
}

/* =====================================================================
   Экраны
   ===================================================================== */

function renderLoading() {
  document.getElementById("catalogToolbar").classList.add("hidden");
  document.getElementById("heroBlock").classList.add("hidden");
  document.getElementById("tagFilter").classList.add("hidden");
  document.getElementById("catalogCount").textContent = "";

  if (loadState === "error") {
    if (!isConfigured()) {
      hairGrid.innerHTML = emptyState("!", "Сайт ещё не подключён к базе", "Впишите адрес проекта Supabase и публичный ключ в файл config.js.");
      return;
    }
    const problem = describeLoadError(lastLoadError);
    const detail = lastLoadError
      ? `<small class="error-detail">Подробности: ${escapeHtml(lastLoadError.code === "network"
          ? "запрос не дошёл до сервера (сеть)"
          : [lastLoadError.status, lastLoadError.code, lastLoadError.message].filter(Boolean).join(" · "))}</small>`
      : "";
    hairGrid.innerHTML = emptyState("!", problem.title, problem.text,
      `${detail}<button type="button" class="empty-add-button" id="retryButton">Повторить</button>`);
    document.getElementById("retryButton")?.addEventListener("click", startLoading);
  } else {
    hairGrid.innerHTML = `<div class="loading-state"><span class="spinner" aria-hidden="true"></span>Загружаем каталог…</div>`;
  }
}

// Понятное объяснение, почему каталог не загрузился
function describeLoadError(error) {
  const message = String(error?.message || "");
  const code = String(error?.code || "");
  const status = error?.status || 0;

  if (code === "network" || status === 0) {
    return {
      title: "Нет связи с базой",
      text: "Браузер не смог достучаться до сервера supabase.co. Чаще всего так бывает, когда домен блокирует провайдер, особенно в мобильном интернете. Попробуйте другую сеть, например домашний Wi‑Fi. Если не поможет — нужен обход через свой адрес."
    };
  }
  if (code === "PGRST205" || code === "42P01" || /could not find the table|does not exist/i.test(message)) {
    return { title: "База ещё не настроена", text: "В Supabase нет нужных таблиц. Откройте SQL Editor, вставьте setup.sql целиком и нажмите Run." };
  }
  if (code === "PGRST200" || /relationship/i.test(message)) {
    return { title: "Схема базы устарела", text: "Выполните setup.sql в Supabase ещё раз целиком: повторный запуск безопасен." };
  }
  if (status === 401 || /api key/i.test(message)) {
    return { title: "Неверный ключ доступа", text: "Проверьте publishable key в config.js: он должен совпадать с ключом из Project Settings → API Keys." };
  }
  if (status >= 500) {
    return { title: "База сейчас недоступна", text: "Если сайт долго не открывали, бесплатный проект Supabase засыпает: владельцу нужно нажать «Restore project» в панели Supabase." };
  }
  return { title: "Не удалось загрузить каталог", text: "Попробуйте обновить страницу. Если ошибка повторяется, пришлите разработчику строку «Подробности» ниже." };
}

/* ---------- Каталог ---------- */

function getVisiblePhotos() {
  const query = searchQuery.trim().toLowerCase();
  const byNew = (a, b) => b.created - a.created;

  let list = photos.filter(photo => {
    if (tagFilter && !getTags(photo).includes(tagFilter)) return false;
    if (!query) return true;
    return `${photo.title} ${photo.description || ""} ${getTags(photo).join(" ")}`.toLowerCase().includes(query);
  });

  if (sortMode === "unrated") {
    list = list.filter(photo => !photo.reviews?.length);
  }

  if (sortMode === "top") {
    list.sort(byScore);
  } else if (sortMode === "popular") {
    list.sort((a, b) => (b.reviews?.length || 0) - (a.reviews?.length || 0) || byNew(a, b));
  } else {
    list.sort(byNew);
  }

  return list;
}

function renderHero() {
  const box = document.getElementById("heroBlock");
  const rated = photos.filter(photo => photo.reviews?.length);

  if (photos.length < 2 || !rated.length || searchQuery.trim() || tagFilter) {
    box.classList.add("hidden");
    box.innerHTML = "";
    return;
  }

  const recent = rated.filter(photo => photo.created >= Date.now() - 30 * DAY);
  const pool = recent.length ? recent : rated;
  const best = [...pool].sort(byScore)[0];
  const score = getAverageScore(best);
  const count = best.reviews.length;
  const tags = tagsText(best);

  box.classList.remove("hidden");
  box.innerHTML = `
    <a class="hero" href="${hairHref(best.id)}">
      <div class="hero-photo" data-bg-id="${best.id}">
        <img src="${escapeHtml(best.image)}" alt="${escapeHtml(best.title)}">
      </div>
      <div class="hero-info">
        <span class="eyebrow">✦ ${recent.length ? "ПРИЧЕСКА МЕСЯЦА" : "ЛУЧШАЯ ПРИЧЕСКА"}</span>
        <h2>${escapeHtml(best.title)}</h2>
        ${tags ? `<span class="hero-tags">${tags}</span>` : ""}
        <div class="hero-score">
          ${scoreBadge(score, { size: "lg" })}
          <span class="hero-count">${formatCount(count, "оценка", "оценки", "оценок")}</span>
        </div>
        <div class="hero-criteria">${criteriaBarsHtml(criteriaAverages(best))}</div>
        <span class="hero-cta">Смотреть прическу →</span>
      </div>
    </a>
  `;
  setImageBackgrounds(box);
}

function renderTagFilter() {
  const box = document.getElementById("tagFilter");
  const counts = new Map();
  photos.forEach(photo => getTags(photo).forEach(tag => counts.set(tag, (counts.get(tag) || 0) + 1)));

  if (tagFilter && !counts.has(tagFilter)) tagFilter = null;

  if (!counts.size) {
    box.classList.add("hidden");
    box.innerHTML = "";
    return;
  }

  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ru"));
  box.classList.remove("hidden");
  box.innerHTML = `
    <button type="button" class="tag-chip${tagFilter ? "" : " active"}" data-tag="">Все теги</button>
    ${sorted.map(([tag, count]) => `
      <button type="button" class="tag-chip${tagFilter === tag ? " active" : ""}" data-tag="${escapeHtml(tag)}">
        ${escapeHtml(tag)}<small>${count}</small>
      </button>
    `).join("")}
  `;
}

function renderCatalog() {
  hairGrid.innerHTML = "";
  document.getElementById("catalogCount").textContent =
    formatCount(photos.length, "образ", "образа", "образов");
  document.getElementById("catalogToolbar").classList.toggle("hidden", photos.length === 0);

  renderTagFilter();
  renderHero();

  if (!photos.length) {
    hairGrid.innerHTML = emptyState(
      "✦",
      "Каталог пока пуст",
      me ? "Добавьте первую прическу, чтобы начать собирать оценки." : "Войдите или зарегистрируйтесь, чтобы добавить первую прическу.",
      `<button type="button" class="empty-add-button" id="emptyAddButton">Добавить прическу</button>`
    );
    document.getElementById("emptyAddButton").addEventListener("click", () => navigate("#/new"));
    return;
  }

  const visible = getVisiblePhotos();

  if (!visible.length) {
    const allRated = sortMode === "unrated" && !searchQuery.trim() && !tagFilter;
    hairGrid.innerHTML = allRated
      ? emptyState("✓", "Все прически уже оценены", "Добавьте новый образ или загляните во вкладку «Лучшие».")
      : emptyState("⌕", "Ничего не найдено", "Попробуйте изменить запрос, тег или фильтр.");
    return;
  }

  visible.forEach(photo => {
    const score = getAverageScore(photo);
    const count = photo.reviews?.length || 0;
    const tags = tagsText(photo);
    const photoCount = getImages(photo).length;
    const rated = Boolean(myReview(photo));
    const card = document.createElement("button");
    card.type = "button";
    card.className = "hair-card";
    card.innerHTML = `
      <div class="card-image-wrap">
        <img src="${escapeHtml(photo.image)}" alt="${escapeHtml(photo.title)}" loading="lazy">
        ${photoCount > 1 ? `<span class="card-photo-count">${photoCount} фото</span>` : ""}
        ${score !== null
          ? `<div class="card-score tier-${getVerdict(score).tier}">
               <span class="card-score-number"><strong>${score}</strong><span>/ 67</span></span>
               <span class="card-score-verdict">${getVerdict(score).label}</span>
             </div>`
          : `<div class="card-no-score">Ещё нет оценки</div>`}
      </div>
      <div class="card-body">
        <div>
          <span class="eyebrow">ПРИЧЁСКА</span>
          <h3>${escapeHtml(photo.title)}</h3>
          <span class="card-meta">${count ? formatCount(count, "оценка", "оценки", "оценок") : "Будьте первым, кто оценит"}${rated ? " · вы оценили" : ""}</span>
          ${tags ? `<span class="card-tags">${tags}</span>` : ""}
        </div>
        <span class="card-arrow">→</span>
      </div>
    `;
    card.querySelector(".card-image-wrap").style.setProperty("--image-bg", cssUrl(photo.image));
    card.addEventListener("click", () => navigate(hairHref(photo.id)));
    hairGrid.appendChild(card);
  });
}

/* ---------- Страница прически ---------- */

function openDetail(id) {
  selectedPhotoId = id;
  const photo = getPhoto(id);
  if (!photo) return;

  renderDetail(photo);
  showView(detailView, { nav: "catalog" });
}

function showDetailImage(photo, index) {
  const images = getImages(photo);
  if (!images[index]) index = 0;
  detailImageIndex = index;
  const src = images[index];
  const image = document.getElementById("detailImage");
  image.src = src;
  image.alt = images.length > 1 ? `${photo.title}, фото ${index + 1} из ${images.length}` : photo.title;
  document.querySelector(".detail-photo").style.setProperty("--image-bg", cssUrl(src));
  document.querySelectorAll("#detailGallery .gallery-thumb").forEach(button => {
    const active = Number(button.dataset.index) === index;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function renderDetail(photo) {
  const images = getImages(photo);
  const gallery = document.getElementById("detailGallery");
  gallery.innerHTML = images.length > 1
    ? images.map((src, index) => `
        <button type="button" class="gallery-thumb" data-index="${index}" aria-label="Фото ${index + 1}">
          <img src="${escapeHtml(src)}" alt="">
        </button>
      `).join("")
    : "";
  gallery.classList.toggle("hidden", images.length < 2);
  showDetailImage(photo, 0);

  document.getElementById("detailTitle").textContent = photo.title;
  const wearer = wearerOf(photo);
  document.getElementById("detailOwner").innerHTML =
    `Добавил(а) <a href="${userHref(photo.ownerName)}">${escapeHtml(photo.ownerName)}</a>${photo.created ? ` · ${formatDate(photo.created)}` : ""}` +
    (wearer ? `<span class="detail-wearer"> · Владелец прически <a href="${userHref(wearer.username)}">${escapeHtml(wearer.username)}</a></span>` : "");
  document.getElementById("detailDescription").textContent =
    photo.description || "Описание пока не добавлено.";

  const tags = getTags(photo);
  const tagBox = document.getElementById("detailTags");
  tagBox.innerHTML = tags.map(tag =>
    `<button type="button" class="tag-chip small" data-tag="${escapeHtml(tag)}" title="Показать все прически с этим тегом">${escapeHtml(tag)}</button>`
  ).join("");
  tagBox.classList.toggle("hidden", !tags.length);

  document.getElementById("compareHairButton").disabled = photos.length < 2;
  document.getElementById("editHairButton").classList.toggle("hidden", !canEditPhoto(photo));
  const deleteButton = document.getElementById("deleteHairButton");
  deleteButton.classList.toggle("hidden", !canDeletePhoto(photo));
  deleteButton.classList.remove("confirming");
  deleteButton.dataset.confirming = "";
  deleteButton.textContent = "Удалить";

  const mine = myReview(photo);
  const rateButton = document.getElementById("openRatingButton");
  const reviewButton = document.getElementById("openReviewButton");
  rateButton.textContent = mine ? "Изменить мою оценку" : "Оценить прическу";
  reviewButton.classList.toggle("hidden", Boolean(mine));
  document.getElementById("detailActions").classList.toggle("single", Boolean(mine));

  const score = getAverageScore(photo);
  const detailScore = document.getElementById("detailScore");
  const count = photo.reviews?.length || 0;

  if (score === null) {
    detailScore.innerHTML = `
      <span class="score-empty">Пока без оценки</span>
      <small>Оцените этот образ первым</small>
    `;
  } else {
    const verdict = getVerdict(score);
    detailScore.innerHTML = `
      <strong>${score}</strong>
      <span>/ 67</span>
      <em class="verdict-pill tier-${verdict.tier}">${verdict.tier === "top" ? "✦ " : ""}${verdict.label}</em>
      <small>средняя оценка · ${formatCount(count, "оценка", "оценки", "оценок")}${mine ? ` · ваша ${mine.score}/67` : ""}</small>
    `;
  }

  renderCriteria(photo);
  renderReviews(photo);
}

function renderCriteria(photo) {
  const box = document.getElementById("detailCriteria");
  const averages = criteriaAverages(photo);

  if (!averages) {
    box.classList.add("hidden");
    box.innerHTML = "";
    return;
  }

  box.classList.remove("hidden");
  box.innerHTML = `<span class="eyebrow">СРЕДНЕЕ ПО КРИТЕРИЯМ</span>` + criteriaBarsHtml(averages);
}

function renderReviews(photo) {
  const list = document.getElementById("reviewsList");
  const reviews = [...(photo.reviews || [])].sort((a, b) => b.created - a.created);
  const withText = reviews.filter(review => review.text).length;

  document.getElementById("reviewCount").textContent = reviews.length
    ? `${formatCount(reviews.length, "оценка", "оценки", "оценок")} · ${withText} с текстом`
    : "Пока пусто";

  if (!reviews.length) {
    list.innerHTML = `
      <div class="empty-reviews">
        <span>✦</span>
        <strong>Здесь пока тихо</strong>
        <p>Станьте первым, кто оставит рецензию на эту прическу.</p>
      </div>
    `;
    return;
  }

  list.innerHTML = reviews.map(review => reviewCardHtml(review, photo, { actions: true })).join("");
}

/* ---------- Фото на весь экран ---------- */

function openLightbox(index) {
  const photo = getPhoto(selectedPhotoId);
  if (!photo) return;
  const lightbox = document.getElementById("lightbox");
  lightbox.classList.toggle("single", getImages(photo).length < 2);
  lightbox.classList.remove("hidden");
  document.body.style.overflow = "hidden";
  showLightboxImage(index);
  document.getElementById("lightboxClose").focus();
}

function closeLightbox() {
  const lightbox = document.getElementById("lightbox");
  if (lightbox.classList.contains("hidden")) return;
  lightbox.classList.add("hidden");
  document.body.style.overflow = "";
  const photo = getPhoto(selectedPhotoId);
  if (photo && !detailView.classList.contains("hidden")) showDetailImage(photo, lightboxIndex);
}

function isLightboxOpen() {
  return !document.getElementById("lightbox").classList.contains("hidden");
}

function showLightboxImage(index) {
  const photo = getPhoto(selectedPhotoId);
  if (!photo) return;
  const images = getImages(photo);
  lightboxIndex = (index + images.length) % images.length;
  const image = document.getElementById("lightboxImage");
  image.src = images[lightboxIndex];
  image.alt = images.length > 1 ? `${photo.title}, фото ${lightboxIndex + 1} из ${images.length}` : photo.title;
  document.getElementById("lightboxCounter").textContent = `${lightboxIndex + 1} / ${images.length}`;
}

/* ---------- Карточка-картинка ---------- */

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";   // иначе холст с фото из хранилища нельзя сохранить
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

function roundRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

function fitText(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let result = text;
  while (result.length > 1 && ctx.measureText(`${result}…`).width > maxWidth) result = result.slice(0, -1);
  return `${result.trimEnd()}…`;
}

async function renderShareCard(photo) {
  try { await document.fonts?.ready; } catch { /* шрифт по умолчанию */ }

  const W = 1080;
  const H = 1350;
  const M = 64;
  const font = getComputedStyle(document.documentElement).getPropertyValue("--font") || "sans-serif";
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#f5f5f2";
  ctx.fillRect(0, 0, W, H);

  const image = await loadImage(photo.image);
  const box = { x: M, y: M, w: W - M * 2, h: 760 };
  ctx.save();
  roundRect(ctx, box.x, box.y, box.w, box.h, 36);
  ctx.clip();
  ctx.fillStyle = "#e9e9e5";
  ctx.fillRect(box.x, box.y, box.w, box.h);
  const cover = Math.max(box.w / image.width, box.h / image.height) * 1.15;
  ctx.globalAlpha = 0.28;
  ctx.filter = "blur(36px)";
  ctx.drawImage(image, box.x + (box.w - image.width * cover) / 2, box.y + (box.h - image.height * cover) / 2, image.width * cover, image.height * cover);
  ctx.filter = "none";
  ctx.globalAlpha = 1;
  const contain = Math.min((box.w - 32) / image.width, (box.h - 32) / image.height);
  ctx.drawImage(image, box.x + (box.w - image.width * contain) / 2, box.y + (box.h - image.height * contain) / 2, image.width * contain, image.height * contain);
  ctx.restore();

  const score = getAverageScore(photo);
  const verdict = score === null ? null : getVerdict(score);

  const badge = { w: 270, h: 168, x: W - M - 270, y: box.y + box.h + 44 };
  const tierFill = { top: "#ffffff", high: "#171717", mid: "#4a4a4a", low: "#e8e8e3" };
  const tierText = { top: "#171717", high: "#ffffff", mid: "#ffffff", low: "#171717" };
  if (verdict) {
    ctx.fillStyle = tierFill[verdict.tier];
    roundRect(ctx, badge.x, badge.y, badge.w, badge.h, 28);
    ctx.fill();
    if (verdict.tier === "top") {
      ctx.lineWidth = 4;
      ctx.strokeStyle = "#171717";
      ctx.stroke();
    }
    ctx.fillStyle = tierText[verdict.tier];
    ctx.textBaseline = "alphabetic";
    ctx.font = `700 92px ${font}`;
    const number = String(score);
    ctx.fillText(number, badge.x + 30, badge.y + 100);
    const numberWidth = ctx.measureText(number).width;
    ctx.globalAlpha = 0.55;
    ctx.font = `500 30px ${font}`;
    ctx.fillText("/ 67", badge.x + 40 + numberWidth, badge.y + 100);
    ctx.globalAlpha = 0.85;
    ctx.font = `700 24px ${font}`;
    ctx.fillText(`${verdict.tier === "top" ? "✦ " : ""}${verdict.label.toUpperCase()}`, badge.x + 32, badge.y + 142);
    ctx.globalAlpha = 1;
  }

  const textWidth = (verdict ? badge.x - 30 : W - M) - M;
  ctx.fillStyle = "#777774";
  ctx.font = `700 22px ${font}`;
  ctx.fillText("HAIRRATE · ПРИЧЕСКА", M, badge.y + 30);
  ctx.fillStyle = "#171717";
  ctx.font = `700 64px ${font}`;
  ctx.fillText(fitText(ctx, photo.title, textWidth), M, badge.y + 104);
  const count = photo.reviews?.length || 0;
  const meta = [count ? formatCount(count, "оценка", "оценки", "оценок") : "Пока без оценок", ...getTags(photo)].join(" · ");
  ctx.fillStyle = "#777774";
  ctx.font = `500 26px ${font}`;
  ctx.fillText(fitText(ctx, meta, textWidth), M, badge.y + 150);

  const averages = criteriaAverages(photo);
  const top = badge.y + badge.h + 50;
  if (averages) {
    const colWidth = (W - M * 2 - 60) / 2;
    criteria.forEach(({ key, label, max }, index) => {
      const x = M + (index % 2) * (colWidth + 60);
      const y = top + Math.floor(index / 2) * 82;
      ctx.fillStyle = "#4d4d4b";
      ctx.font = `500 24px ${font}`;
      ctx.fillText(label, x, y);
      ctx.fillStyle = "#171717";
      ctx.font = `700 26px ${font}`;
      const value = `${formatDecimal(averages[key])}/${max}`;
      ctx.fillText(value, x + colWidth - ctx.measureText(value).width, y);
      ctx.fillStyle = "#e5e5e1";
      roundRect(ctx, x, y + 18, colWidth, 8, 4);
      ctx.fill();
      ctx.fillStyle = "#171717";
      roundRect(ctx, x, y + 18, Math.max(8, colWidth * (averages[key] / max)), 8, 4);
      ctx.fill();
    });
  } else {
    ctx.fillStyle = "#777774";
    ctx.font = `500 28px ${font}`;
    ctx.fillText("Оценок пока нет — станьте первым.", M, top + 10);
  }

  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error("toBlob"))), "image/png");
  });
}

/* ---------- Топ ---------- */

function renderTop() {
  const days = PERIODS[topPeriod];
  const from = days ? Date.now() - days * DAY : 0;
  const list = photos.filter(photo => photo.reviews?.length && photo.created >= from).sort(byScore);
  const reviewsTotal = list.reduce((sum, photo) => sum + photo.reviews.length, 0);

  document.querySelectorAll("#periodTabs [data-period]").forEach(button => {
    button.classList.toggle("active", button.dataset.period === topPeriod);
  });

  document.getElementById("topStats").textContent = list.length
    ? `${formatCount(list.length, "прическа", "прически", "причесок")} · ${formatCount(reviewsTotal, "оценка", "оценки", "оценок")}`
    : "";

  const box = document.getElementById("topList");

  if (!list.length) {
    box.innerHTML = photos.some(photo => photo.reviews?.length)
      ? emptyState("✦", "За этот период пусто", "Прически, добавленные за выбранный период, ещё не оценивали. Попробуйте период побольше.")
      : emptyState("✦", "Рейтинг пока пуст", "Он появится, когда у причесок будут первые оценки.");
    return;
  }

  box.innerHTML = list.map((photo, index) => {
    const tags = tagsText(photo);
    const count = photo.reviews.length;
    return `
      <a class="top-row${index < 3 ? " podium" : ""}" href="${hairHref(photo.id)}">
        <span class="top-pos">${String(index + 1).padStart(2, "0")}</span>
        <span class="top-thumb"><img src="${escapeHtml(photo.image)}" alt="" loading="lazy"></span>
        <span class="top-info">
          <strong>${escapeHtml(photo.title)}</strong>
          <small>${formatCount(count, "оценка", "оценки", "оценок")}${tags ? ` · ${tags}` : ""}</small>
        </span>
        ${scoreBadge(getAverageScore(photo), { size: "sm" })}
      </a>
    `;
  }).join("");
}

/* ---------- Лента ---------- */

function renderFeed() {
  const items = allReviews()
    .filter(({ review }) => !feedTextOnly || review.text)
    .sort((a, b) => b.review.created - a.review.created);

  document.getElementById("feedTextOnly").checked = feedTextOnly;
  document.getElementById("feedStats").textContent = items.length
    ? formatCount(items.length, feedTextOnly ? "рецензия" : "оценка", feedTextOnly ? "рецензии" : "оценки", feedTextOnly ? "рецензий" : "оценок")
    : "";

  const box = document.getElementById("feedList");

  if (!items.length) {
    box.innerHTML = feedTextOnly && allReviews().length
      ? emptyState("✎", "Текстовых рецензий пока нет", "Пока есть только оценки без текста. Снимите фильтр, чтобы их увидеть.")
      : emptyState("✎", "Лента пока пуста", "Здесь будут появляться все оценки и рецензии, новые сверху.");
    return;
  }

  box.innerHTML = items.map(({ review, photo }) => reviewCardHtml(review, photo, { withPhoto: true })).join("");
}

/* ---------- Участники ---------- */

function getMembers() {
  const items = allReviews();
  return profiles.map(profile => {
    const own = items.filter(({ review }) => review.authorId === profile.id);
    const scores = own.map(({ review }) => review.score);
    return {
      ...profile,
      name: profile.username,
      items: own,
      count: own.length,
      withText: own.filter(({ review }) => review.text).length,
      added: photos.filter(photo => photo.owner === profile.id).length,
      worn: wornBy(profile.id),
      avg: scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null,
      last: own.length ? Math.max(...own.map(({ review }) => review.created)) : toTime(profile.created_at)
    };
  });
}

function globalAverage() {
  const items = allReviews();
  if (!items.length) return null;
  return items.reduce((sum, { review }) => sum + review.score, 0) / items.length;
}

function reviewerCharacter(member) {
  const average = globalAverage();
  if (average === null || member.count < 2) return "Новичок";
  const diff = member.avg - average;
  if (diff <= -4) return "Строгий";
  if (diff >= 4) return "Щедрый";
  return "Объективный";
}

function renderUsers() {
  const members = getMembers().sort((a, b) => b.count - a.count || b.added - a.added || b.last - a.last);
  const box = document.getElementById("usersList");

  document.getElementById("usersStats").textContent = members.length
    ? formatCount(members.length, "участник", "участника", "участников")
    : "";

  if (!members.length) {
    box.innerHTML = emptyState("☺", "Участников пока нет", "Зарегистрируйтесь первым: кнопка «Войти» в шапке сайта.");
    return;
  }

  box.innerHTML = members.map((member, index) => `
    <a class="user-row" href="${userHref(member.name)}">
      <span class="top-pos">${String(index + 1).padStart(2, "0")}</span>
      <span class="avatar">${escapeHtml(initial(member.name))}</span>
      <span class="top-info">
        <strong>${escapeHtml(member.name)}${me && member.id === me.id ? " <em>(вы)</em>" : ""}</strong>
        <small>${formatCount(member.count, "оценка", "оценки", "оценок")} · ${formatCount(member.added, "прическа", "прически", "причесок")}${member.worn.length ? ` · <span class="wearer-mark">владелец прически</span>` : ""}</small>
      </span>
      <span class="user-side">
        <span class="character-pill">${member.is_admin ? "Админ" : reviewerCharacter(member)}</span>
        <small>${member.avg === null ? "ещё не оценивал(а)" : `в среднем ${Math.round(member.avg)}/67`}</small>
      </span>
    </a>
  `).join("");
}

function renderUser(profile) {
  const member = getMembers().find(item => item.id === profile.id);
  const isMe = me && me.id === member.id;
  const favorite = [...member.items].sort((a, b) => b.review.score - a.review.score || b.review.created - a.review.created)[0];
  const avg = member.avg === null ? null : Math.round(member.avg);

  document.getElementById("userProfile").innerHTML = `
    <div class="profile-head">
      <span class="avatar size-lg">${escapeHtml(initial(member.name))}</span>
      <div>
        <span class="eyebrow">${isMe ? "ВАШ ПРОФИЛЬ" : "УЧАСТНИК"}</span>
        <h2>${escapeHtml(member.name)}</h2>
        <div class="profile-meta">
          <span class="character-pill">${member.is_admin ? "Админ" : reviewerCharacter(member)}</span>
          ${member.worn.length ? `<span class="character-pill" id="wearerPill">Владелец прически</span>` : ""}
          <small>на сайте с ${formatDate(toTime(member.created_at))}</small>
          ${isMe ? `<button type="button" class="text-button" id="profileLogoutButton">Выйти из аккаунта</button>` : ""}
        </div>
      </div>
    </div>
    <div class="stat-tiles">
      <div class="stat-tile"><span>Оценок</span><strong>${member.count}</strong></div>
      <div class="stat-tile"><span>Добавил(а) причесок</span><strong>${member.added}</strong></div>
      <div class="stat-tile"><span>Средний балл</span><strong>${avg === null ? "—" : `${avg}<small>/67 · ${getVerdict(avg).label}</small>`}</strong></div>
      ${favorite ? `
        <a class="stat-tile link" href="${hairHref(favorite.photo.id)}">
          <span>Выше всех оценил(а)</span>
          <strong class="stat-title">${escapeHtml(favorite.photo.title)}</strong>
          <small>${favorite.review.score}/67</small>
        </a>` : `<div class="stat-tile"><span>Выше всех оценил(а)</span><strong class="stat-title">—</strong></div>`}
    </div>
    ${member.worn.length ? `
      <div class="section-heading">
        <div>
          <span class="eyebrow">ВЛАДЕЛЕЦ</span>
          <h3>${isMe ? "Ваши прически" : "Прически участника"}</h3>
        </div>
        <span>${formatCount(member.worn.length, "прическа", "прически", "причесок")}</span>
      </div>
      <div class="stat-tiles" id="wornHairs">
        ${member.worn.map(photo => {
          const score = getAverageScore(photo);
          const count = photo.reviews?.length || 0;
          return `
            <a class="stat-tile link" href="${hairHref(photo.id)}">
              <span>${score === null ? "Ещё нет оценки" : `${score}/67 · ${getVerdict(score).label}`}</span>
              <strong class="stat-title">${escapeHtml(photo.title)}</strong>
              <small>${count ? formatCount(count, "оценка", "оценки", "оценок") : "Будьте первым, кто оценит"}</small>
            </a>`;
        }).join("")}
      </div>` : ""}
  `;

  document.getElementById("profileLogoutButton")?.addEventListener("click", logout);

  document.getElementById("userReviewCount").textContent = member.count ? `последняя — ${formatDate(member.last)}` : "";

  document.getElementById("userReviews").innerHTML = member.count
    ? [...member.items]
        .sort((a, b) => b.review.created - a.review.created)
        .map(({ review, photo }) => reviewCardHtml(review, photo, { withPhoto: true }))
        .join("")
    : `<div class="empty-reviews"><span>✦</span><strong>Оценок пока нет</strong><p>${isMe ? "Откройте любую прическу в каталоге и поставьте первую оценку." : "Этот участник ещё ничего не оценивал."}</p></div>`;
}

/* ---------- Сравнение ---------- */

function openCompare(firstId, secondId) {
  const pickers = document.getElementById("comparePickers");
  const result = document.getElementById("compareResult");

  if (photos.length < 2) {
    pickers.classList.add("hidden");
    result.innerHTML = emptyState("⇄", "Сравнивать пока нечего", "В каталоге должно быть хотя бы две прически.");
    showView(compareView, { nav: "compare" });
    return;
  }

  const ranked = [...photos].sort(byScore);
  const a = getPhoto(firstId) || ranked[0];
  const b = (getPhoto(secondId) && secondId !== a.id) ? getPhoto(secondId) : ranked.find(photo => photo.id !== a.id);

  if (firstId !== a.id || secondId !== b.id) {
    navigate(`#/compare/${a.id}/${b.id}`, { replace: true });
    return;
  }

  pickers.classList.remove("hidden");
  fillCompareSelect(document.getElementById("compareA"), a.id, b.id);
  fillCompareSelect(document.getElementById("compareB"), b.id, a.id);
  renderCompare(a, b);
  showView(compareView, { nav: "compare" });
}

function fillCompareSelect(select, selectedId, otherId) {
  select.innerHTML = [...photos].sort((x, y) => x.title.localeCompare(y.title, "ru")).map(photo => `
    <option value="${photo.id}"${photo.id === selectedId ? " selected" : ""}${photo.id === otherId ? " disabled" : ""}>
      ${escapeHtml(photo.title)}
    </option>
  `).join("");
}

function compareCardHtml(photo) {
  const score = getAverageScore(photo);
  const count = photo.reviews?.length || 0;
  return `
    <a class="compare-card" href="${hairHref(photo.id)}">
      <span class="compare-photo" data-bg-id="${photo.id}"><img src="${escapeHtml(photo.image)}" alt="${escapeHtml(photo.title)}"></span>
      <strong>${escapeHtml(photo.title)}</strong>
      <small>${count ? formatCount(count, "оценка", "оценки", "оценок") : "Ещё нет оценок"}</small>
      ${scoreBadge(score, { size: "md" })}
    </a>
  `;
}

function renderCompare(a, b) {
  const box = document.getElementById("compareResult");
  const avgA = criteriaAverages(a);
  const avgB = criteriaAverages(b);
  const cards = `<div class="compare-cards">${compareCardHtml(a)}${compareCardHtml(b)}</div>`;

  if (!avgA || !avgB) {
    const missing = !avgA && !avgB ? "Обе прически ещё не оценены" : `«${escapeHtml((!avgA ? a : b).title)}» ещё не оценена`;
    box.innerHTML = cards + `<p class="compare-summary">${missing}. Сравнение по критериям появится после первых оценок.</p>`;
    setImageBackgrounds(box);
    return;
  }

  let winsA = 0;
  let winsB = 0;

  const rows = criteria.map(({ key, label, max }) => {
    const valueA = avgA[key];
    const valueB = avgB[key];
    const diff = Math.round((valueA - valueB) * 10) / 10;
    if (diff > 0) winsA++;
    if (diff < 0) winsB++;
    return `
      <div class="compare-row">
        <span class="cmp-value${diff > 0 ? " win" : ""}">${formatDecimal(valueA)}</span>
        <div class="cmp-middle">
          <span class="cmp-label">${label}</span>
          <div class="cmp-bars">
            <span class="cmp-half left"><i style="width: ${((valueA / max) * 100).toFixed(1)}%"></i></span>
            <span class="cmp-half right"><i style="width: ${((valueB / max) * 100).toFixed(1)}%"></i></span>
          </div>
        </div>
        <span class="cmp-value${diff < 0 ? " win" : ""}">${formatDecimal(valueB)}</span>
      </div>
    `;
  }).join("");

  const scoreA = getAverageScore(a);
  const scoreB = getAverageScore(b);
  const total = `
    <div class="compare-row total">
      <span class="cmp-value${scoreA > scoreB ? " win" : ""}">${scoreA}</span>
      <div class="cmp-middle"><span class="cmp-label">Итоговый балл</span></div>
      <span class="cmp-value${scoreB > scoreA ? " win" : ""}">${scoreB}</span>
    </div>
  `;

  let summary;
  if (scoreA === scoreB && winsA === winsB) {
    summary = "Ничья: прически идут вровень.";
  } else {
    const leader = scoreA > scoreB || (scoreA === scoreB && winsA > winsB) ? a : b;
    const leaderWins = leader === a ? winsA : winsB;
    summary = `Впереди «${escapeHtml(leader.title)}»: сильнее в ${leaderWins} из ${criteria.length} критериев` +
      (scoreA !== scoreB ? `, итог выше на ${Math.abs(scoreA - scoreB)}.` : ", итоговый балл одинаковый.");
  }

  box.innerHTML = cards + `<div class="compare-table">${rows}${total}</div><p class="compare-summary">${summary}</p>`;
  setImageBackgrounds(box);
}

/* ---------- Вход и регистрация ---------- */

function openAuth(mode) {
  authMode = mode;
  const signup = mode === "signup";

  document.querySelectorAll("#authTabs [data-auth]").forEach(button => {
    const active = button.dataset.auth === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  document.getElementById("authHeading").textContent = signup ? "Регистрация" : "С возвращением";
  document.getElementById("authIntro").textContent = signup
    ? "Аккаунт нужен, чтобы добавлять прически и ставить оценки. Почту никто не увидит, другие участники видят только ник."
    : "Войдите, чтобы добавлять прически и ставить оценки.";
  document.getElementById("usernameField").classList.toggle("hidden", !signup);
  document.getElementById("authPassword").setAttribute("autocomplete", signup ? "new-password" : "current-password");
  document.getElementById("authSubmit").textContent = signup ? "Зарегистрироваться" : "Войти";
  setAuthError("");
  showView(authView);
  (signup ? document.getElementById("authUsername") : document.getElementById("authEmail")).focus({ preventScroll: true });
}

function setAuthError(message) {
  const box = document.getElementById("authError");
  box.textContent = message;
  box.classList.toggle("hidden", !message);
}

async function submitAuth() {
  const signup = authMode === "signup";
  const username = document.getElementById("authUsername").value.trim();
  const email = document.getElementById("authEmail").value.trim();
  const password = document.getElementById("authPassword").value;

  if (signup && !USERNAME_RE.test(username)) {
    setAuthError("Ник: от 3 до 24 символов, только буквы, цифры и знаки _ . -");
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    setAuthError("Проверьте адрес почты.");
    return;
  }
  if (password.length < 6) {
    setAuthError("Пароль должен быть не короче 6 символов.");
    return;
  }

  const button = document.getElementById("authSubmit");
  setBusy(button, true, signup ? "Создаём аккаунт…" : "Входим…");
  setAuthError("");

  try {
    if (signup) {
      if (await apiUsernameTaken(username)) {
        setAuthError("Этот ник уже занят. Придумайте другой.");
        return;
      }
      await apiSignUp(email, password, username);
    } else {
      await apiSignIn(email, password);
    }
    await refreshData();
    document.getElementById("authForm").reset();
    showToast(signup ? `Добро пожаловать, ${me?.username || username}!` : `Привет, ${me?.username || ""}!`);
    const target = afterLoginHash || "#/";
    afterLoginHash = "#/";
    navigate(target, { replace: true });
  } catch (error) {
    setAuthError(humanError(error));
  } finally {
    setBusy(button, false);
  }
}

async function logout() {
  await apiSignOut();
  updateAuthUI();
  showToast("Вы вышли из аккаунта.");
  navigate("#/", { replace: true });
}

/* ---------- Добавление и редактирование ---------- */

function resetCreateForm() {
  document.getElementById("createForm").reset();
  document.getElementById("imagePreview").classList.add("hidden");
  document.getElementById("imagePreview").removeAttribute("src");
  document.getElementById("fileName").textContent = DEFAULT_FILE_HINT;
  draftMain = null;
  draftExtras = [];
  pendingImages = 0;
  draftTags = [];
}

function setCreateMode(isEdit) {
  document.getElementById("createEyebrow").textContent = isEdit ? "РЕДАКТИРОВАНИЕ" : "НОВАЯ ПРИЧЕСКА";
  document.getElementById("createHeading").textContent = isEdit ? "Изменить прическу" : "Добавить прическу";
  document.getElementById("createIntro").textContent = isEdit
    ? "Поменяйте название, описание, теги или фотографии. Оценки сохранятся."
    : "Карточка появится в общем каталоге, оценивать её смогут все участники.";
  document.getElementById("createSubmit").textContent = isEdit ? "Сохранить изменения" : "Создать прическу";
}

function renderTagPicker() {
  const existing = photos.flatMap(getTags);
  const options = [];
  [...PRESET_TAGS, ...existing, ...draftTags].forEach(tag => {
    if (!options.some(item => item.toLowerCase() === tag.toLowerCase())) options.push(tag);
  });

  document.getElementById("tagPicker").innerHTML = options.map(tag => `
    <button type="button" class="tag-chip${draftTags.includes(tag) ? " active" : ""}" data-tag="${escapeHtml(tag)}" aria-pressed="${draftTags.includes(tag)}">
      ${escapeHtml(tag)}
    </button>
  `).join("");
}

function toggleDraftTag(tag) {
  if (draftTags.includes(tag)) {
    draftTags = draftTags.filter(item => item !== tag);
  } else if (draftTags.length >= MAX_TAGS) {
    showToast(`Можно выбрать не больше ${MAX_TAGS} тегов.`);
    return;
  } else {
    draftTags.push(tag);
  }
  renderTagPicker();
}

function addCustomTag() {
  const input = document.getElementById("newTagInput");
  const tag = normalizeTag(input.value);
  if (!tag) return;

  const known = [...PRESET_TAGS, ...photos.flatMap(getTags), ...draftTags]
    .find(item => item.toLowerCase() === tag.toLowerCase());
  const finalTag = known || tag;

  input.value = "";
  if (draftTags.includes(finalTag)) return;
  toggleDraftTag(finalTag);
}

function renderExtraPhotos() {
  const box = document.getElementById("extraPhotos");
  const slots = draftExtras.map((item, index) => `
    <div class="extra-slot">
      <img src="${escapeHtml(item.src)}" alt="Дополнительное фото ${index + 1}">
      <button type="button" class="extra-remove" data-extra-index="${index}" aria-label="Убрать фото ${index + 1}">✕</button>
    </div>
  `).join("");

  const free = MAX_EXTRA_PHOTOS - draftExtras.length;
  const addTile = free > 0 ? `
    <label class="extra-add">
      <input id="extraInput" class="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp" multiple>
      <b>+</b><span>${pendingImages ? "Обработка…" : "Добавить"}</span>
    </label>
  ` : "";

  box.innerHTML = slots + addTile;
}

function openCreate() {
  editingPhotoId = null;
  resetCreateForm();
  setCreateMode(false);
  renderTagPicker();
  renderExtraPhotos();
  showView(createView);
}

function openEdit(id) {
  const photo = getPhoto(id);
  if (!photo) return;

  editingPhotoId = id;
  selectedPhotoId = id;
  resetCreateForm();
  setCreateMode(true);

  document.getElementById("newTitle").value = photo.title;
  document.getElementById("newDescription").value = photo.description || "";
  draftMain = { src: photo.image, path: photo.paths[0] };
  draftExtras = photo.paths.slice(1).map(path => ({ src: publicUrl(path), path }));
  draftTags = [...getTags(photo)];
  renderTagPicker();
  renderExtraPhotos();

  const preview = document.getElementById("imagePreview");
  preview.src = photo.image;
  preview.classList.remove("hidden");
  document.getElementById("fileName").textContent = "Текущее фото · нажмите, чтобы заменить";

  showView(createView);
}

function compressImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();

    img.onload = () => {
      const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);

      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", IMAGE_QUALITY));
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Не удалось прочитать изображение"));
    };

    img.src = url;
  });
}

function isAcceptedImage(file) {
  return /^image\/(jpeg|png|webp)$/.test(file?.type || "");
}

async function handleImageFile(file) {
  if (!file) return;

  if (!isAcceptedImage(file)) {
    showToast("Подойдут только JPG, PNG или WEBP.");
    return;
  }

  const fileName = document.getElementById("fileName");
  fileName.textContent = "Обрабатываем фото…";
  pendingImages++;

  try {
    const data = await compressImage(file);
    draftMain = { src: data, data };
    fileName.textContent = file.name;
    const preview = document.getElementById("imagePreview");
    preview.src = data;
    preview.classList.remove("hidden");
  } catch {
    fileName.textContent = DEFAULT_FILE_HINT;
    showToast("Не удалось открыть это изображение. Попробуйте другое.");
  } finally {
    pendingImages--;
  }
}

async function handleExtraFiles(fileList) {
  const files = [...fileList].filter(isAcceptedImage);
  if (!files.length) {
    if (fileList.length) showToast("Подойдут только JPG, PNG или WEBP.");
    return;
  }

  const free = MAX_EXTRA_PHOTOS - draftExtras.length;
  if (files.length > free) showToast(`Можно добавить ещё ${free} фото, лишние пропущены.`);

  const chosen = files.slice(0, free);
  pendingImages += chosen.length;
  renderExtraPhotos();

  for (const file of chosen) {
    try {
      const data = await compressImage(file);
      if (draftExtras.length < MAX_EXTRA_PHOTOS) draftExtras.push({ src: data, data });
    } catch {
      showToast("Одно из фото не открылось, оно пропущено.");
    } finally {
      pendingImages--;
      renderExtraPhotos();
    }
  }
}

// Загружает новые фото в хранилище; уже загруженные просто возвращает
async function uploadDraftImages(items, uploaded) {
  const paths = [];
  for (const item of items) {
    if (item.path) {
      paths.push(item.path);
    } else {
      const path = await apiUploadImage(dataUrlToBlob(item.data));
      uploaded.push(path);
      paths.push(path);
    }
  }
  return paths;
}

async function submitHairstyle() {
  if (pendingImages > 0) {
    showToast("Подождите секунду: фото ещё обрабатывается.");
    return;
  }
  if (!draftMain) {
    showToast("Пожалуйста, выберите главное фото.");
    return;
  }

  const title = document.getElementById("newTitle").value.trim();
  const description = document.getElementById("newDescription").value.trim();
  if (!title) {
    showToast("Введите название прически.");
    return;
  }

  if (document.getElementById("newTagInput").value.trim()) addCustomTag();
  const tags = [...draftTags];

  const button = document.getElementById("createSubmit");
  setBusy(button, true, "Загружаем фото…");
  const uploaded = [];

  try {
    const paths = await uploadDraftImages([draftMain, ...draftExtras], uploaded);
    button.textContent = "Сохраняем…";

    if (editingPhotoId) {
      const photo = getPhoto(editingPhotoId);
      await apiUpdate("hairstyles", editingPhotoId, { title, description, tags, images: paths });
      const removed = (photo?.paths || []).filter(path => !paths.includes(path));
      apiRemoveImages(removed).catch(() => { /* лишние файлы не мешают */ });
      await refreshData();
      showToast("Изменения сохранены.");
      goBack(hairHref(editingPhotoId));
    } else {
      const row = await apiInsert("hairstyles", { title, description, tags, images: paths });
      await refreshData();
      searchQuery = "";
      tagFilter = null;
      document.getElementById("searchInput").value = "";
      catalogScroll = 0;
      showToast("Прическа добавлена.");
      navigate(hairHref(row.id), { replace: true });
    }
  } catch (error) {
    if (uploaded.length) apiRemoveImages(uploaded).catch(() => {});
    showToast(humanError(error), { duration: 6000 });
    await recoverFromStale(error);
  } finally {
    setBusy(button, false);
  }
}

// Если данные устарели (кто-то другой уже удалил запись) — подтягиваем свежие
async function recoverFromStale(error) {
  if (error?.code !== "no_rows") return;
  try {
    await refreshData();
    handleRoute();
  } catch { /* покажем исходную ошибку */ }
}

async function deleteHair(photo) {
  const button = document.getElementById("deleteHairButton");
  setBusy(button, true, "Удаляем…");
  try {
    await apiDelete("hairstyles", photo.id);
    apiRemoveImages(photo.paths).catch(() => {});
    await refreshData();
    showToast(`«${photo.title}» удалена.`);
    navigate("#/", { replace: true });
  } catch (error) {
    showToast(humanError(error), { duration: 6000 });
    await recoverFromStale(error);
  } finally {
    setBusy(button, false);
  }
}

/* ---------- Оценка и рецензия ---------- */

function openReview(id, mode, reviewId = null) {
  selectedPhotoId = id;
  const photo = getPhoto(id);
  if (!photo) return;

  const editing = mode === "edit" ? (photo.reviews || []).find(review => review.id === reviewId && review.authorId === me?.id) : null;
  if (mode === "edit" && !editing) {
    navigate(hairHref(id), { replace: true });
    return;
  }
  editingReviewId = editing ? editing.id : null;

  const isRate = mode === "rate";
  document.getElementById("reviewTitle").textContent = photo.title;
  document.getElementById("reviewForm").reset();
  document.getElementById("reviewEyebrow").textContent = editing ? "ВАША ОЦЕНКА" : isRate ? "НОВАЯ ОЦЕНКА" : "НОВАЯ РЕЦЕНЗИЯ";
  document.getElementById("reviewIntro").textContent = editing
    ? "Поменяйте баллы или текст. Дата оценки останется прежней, рядом появится пометка «изменено»."
    : isRate
      ? "Выставьте баллы по четырём критериям. Текст рецензии можно добавить по желанию."
      : "Расскажите, что думаете о прическе, и выставьте баллы. Текст можно не писать.";
  document.getElementById("reviewSubmit").textContent = editing ? "Сохранить изменения" : isRate ? "Опубликовать оценку" : "Опубликовать рецензию";
  document.getElementById("reviewAs").innerHTML =
    `<span class="avatar size-xs">${escapeHtml(initial(me.username))}</span>Оценка от имени <b>${escapeHtml(me.username)}</b>`;

  const text = editing ? editing.text || "" : "";
  document.getElementById("reviewText").value = text;
  document.getElementById("reviewTextCount").textContent = String(text.length);

  const hideText = isRate && !editing;
  document.getElementById("reviewTextField").classList.toggle("hidden", hideText);
  document.getElementById("addTextButton").classList.toggle("hidden", !hideText);

  Object.entries(fields).forEach(([key, input]) => {
    input.value = editing ? editing[key] : 5;
  });

  updateLiveScore();
  showView(reviewView, { nav: "catalog" });
}

function updateSliderBackground(input) {
  const min = Number(input.min);
  const max = Number(input.max);
  const value = Number(input.value);
  const percent = ((value - min) / (max - min)) * 100;
  input.style.background =
    `linear-gradient(to right, var(--ink) 0%, var(--ink) ${percent}%, var(--track) ${percent}%, var(--track) 100%)`;
}

function updateLiveScore() {
  Object.entries(fields).forEach(([key, input]) => {
    values[key].textContent = input.value;
    updateSliderBackground(input);
  });

  const score = calculateScore(
    Number(fields.accuracy.value),
    Number(fields.beauty.value),
    Number(fields.appearance.value),
    Number(fields.personal.value)
  );

  document.getElementById("liveScore").textContent = score;
  document.getElementById("liveVerdict").textContent = getVerdict(score).label;
}

async function submitReview() {
  const photo = getPhoto(selectedPhotoId);
  if (!photo || !me) return;

  const changes = {
    text: document.getElementById("reviewText").value.trim(),
    accuracy: Number(fields.accuracy.value),
    beauty: Number(fields.beauty.value),
    appearance: Number(fields.appearance.value),
    personal: Number(fields.personal.value)
  };

  const button = document.getElementById("reviewSubmit");
  setBusy(button, true, "Сохраняем…");

  try {
    if (editingReviewId) {
      await apiUpdate("reviews", editingReviewId, { ...changes, edited_at: new Date().toISOString() });
    } else {
      await apiInsert("reviews", { hairstyle_id: photo.id, ...changes });
    }
    await refreshData();
    showToast(editingReviewId ? "Оценка обновлена." : changes.text ? "Рецензия опубликована." : "Оценка опубликована.");
    editingReviewId = null;
    goBack(hairHref(photo.id));
  } catch (error) {
    if (error.code === "23505") {
      await refreshData().catch(() => {});
      showToast("Вы уже оценили эту прическу: откройте её и измените оценку.", { duration: 5000 });
      navigate(hairHref(photo.id), { replace: true });
    } else {
      showToast(humanError(error), { duration: 6000 });
      if (error.code === "no_rows") {
        editingReviewId = null;
        await refreshData().catch(() => {});
        navigate(hairHref(photo.id), { replace: true });
      }
    }
  } finally {
    setBusy(button, false);
  }
}

async function deleteReview(photo, reviewId) {
  try {
    await apiDelete("reviews", reviewId);
    await refreshData();
    showToast("Оценка удалена.");
    handleRoute();
  } catch (error) {
    showToast(humanError(error), { duration: 6000 });
    await recoverFromStale(error);
  }
}

/* ---------- Перенос причесок из резервной копии старой версии ---------- */
// Прически переносятся от вашего имени. Оценки переносятся только те,
// что были поставлены под вашим ником: чужие оценки не привязаны к аккаунтам.

function sanitizeLegacyPhoto(raw) {
  if (!raw || !isSafeImage(raw.image)) return null;
  const title = String(raw.title || "").trim().slice(0, 60);
  if (!title) return null;

  const tags = [];
  (Array.isArray(raw.tags) ? raw.tags : []).forEach(value => {
    const tag = normalizeTag(value);
    if (tag && tags.length < MAX_TAGS && !tags.includes(tag)) tags.push(tag);
  });

  const pick = (value, max) => {
    const number = Math.round(Number(value));
    return number >= 1 && number <= max ? number : null;
  };

  const isoDate = value => {
    const time = Number(value);
    return Number.isSafeInteger(time) && time > 1e12 && time <= Date.now() ? new Date(time).toISOString() : null;
  };

  return {
    title,
    created: isoDate(raw.id),
    description: String(raw.description || "").trim().slice(0, 240),
    tags,
    images: [raw.image, ...(Array.isArray(raw.extra) ? raw.extra : []).filter(isSafeImage).slice(0, MAX_EXTRA_PHOTOS)],
    reviews: (Array.isArray(raw.reviews) ? raw.reviews : []).map(review => ({
      author: String(review?.author || "").trim().slice(0, 30),
      created: isoDate(review?.id),
      text: String(review?.text || "").trim().slice(0, 800),
      accuracy: pick(review?.accuracy, 9),
      beauty: pick(review?.beauty, 9),
      appearance: pick(review?.appearance, 9),
      personal: pick(review?.personal, 10)
    })).filter(review => review.accuracy && review.beauty && review.appearance && review.personal)
  };
}

async function importBackup(file) {
  if (!file || !me) return;

  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    showToast("Файл не похож на резервную копию HairRate.");
    return;
  }

  const rawPhotos = Array.isArray(data) ? data : data?.photos;
  const items = (Array.isArray(rawPhotos) ? rawPhotos : []).map(sanitizeLegacyPhoto).filter(Boolean);
  if (!items.length) {
    showToast("В файле нет причесок, которые можно перенести.");
    return;
  }

  const isAdmin = Boolean(me.is_admin);
  const myName = me.username.toLowerCase();
  const stats = { created: 0, updated: 0, mine: 0, archive: 0, skippedArchive: 0 };

  try {
    for (const [index, item] of items.entries()) {
      showToast(`Переносим ${index + 1} из ${items.length}…`, { duration: 120000 });

      // Фото из копии часто несжатые: пережимаем до 1400 px перед загрузкой
      const images = [];
      for (const image of item.images) {
        images.push(await compressImage(dataUrlToBlob(image)).catch(() => image));
      }

      const existing = photos.find(photo => photo.owner === me.id && photo.title.toLowerCase() === item.title.toLowerCase());
      const uploaded = [];
      let hairId;

      try {
        const paths = await uploadDraftImages(images.map(image => ({ data: image })), uploaded);
        if (existing) {
          // Уже перенесённая прическа: обновляем фото на сжатые, новую карточку не создаём
          await apiUpdate("hairstyles", existing.id, { images: paths });
          apiRemoveImages(existing.paths.filter(path => !paths.includes(path))).catch(() => {});
          hairId = existing.id;
          stats.updated++;
        } else {
          const row = await apiInsert("hairstyles", {
            title: item.title, description: item.description, tags: item.tags, images: paths,
            ...(item.created ? { created_at: item.created } : {})
          });
          hairId = row.id;
          stats.created++;
        }
      } catch (error) {
        if (uploaded.length) apiRemoveImages(uploaded).catch(() => {});
        throw error;
      }

      const hasMine = Boolean(existing && myReview(existing));
      const hasArchive = Boolean(existing && existing.reviews.some(review => review.legacy));
      let addedMine = false;

      for (const review of item.reviews) {
        const scores = { text: review.text, accuracy: review.accuracy, beauty: review.beauty, appearance: review.appearance, personal: review.personal };
        const created = review.created ? { created_at: review.created } : {};

        if (review.author && review.author.toLowerCase() === myName) {
          if (!hasMine && !addedMine) {
            await apiInsert("reviews", { hairstyle_id: hairId, ...scores, ...created });
            addedMine = true;
            stats.mine++;
          }
          continue;
        }

        if (!isAdmin) {
          stats.skippedArchive++;
          continue;
        }
        if (hasArchive) continue;   // архивные оценки этой прически уже перенесены

        await apiInsert("reviews", { hairstyle_id: hairId, author: null, legacy_author: review.author || ANON, ...scores, ...created });
        stats.archive++;
      }
    }

    const parts = [];
    if (stats.created) parts.push(`новых причесок: ${stats.created}`);
    if (stats.updated) parts.push(`обновлено фото у ${formatCount(stats.updated, "прически", "причесок", "причесок")}`);
    if (stats.mine) parts.push(`ваших оценок: ${stats.mine}`);
    if (stats.archive) parts.push(`оценок из старой версии: ${stats.archive}`);
    let message = `Готово: ${parts.join(", ") || "новых данных нет"}.`;
    if (stats.skippedArchive) message += ` ${formatCount(stats.skippedArchive, "чужая оценка", "чужие оценки", "чужих оценок")} не перенесены: это может сделать только админ.`;
    showToast(message, { duration: 9000 });
  } catch (error) {
    showToast(`Перенос прерван. ${humanError(error)} Запустите его ещё раз: уже перенесённое не задвоится.`, { duration: 9000 });
  }

  await refreshData().catch(() => {});
  navigate("#/", { replace: true });
}

/* =====================================================================
   События
   ===================================================================== */

document.addEventListener("click", event => {
  const link = event.target.closest('a[href^="#/"]');
  if (!link || event.defaultPrevented || event.button !== 0 ||
      event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate(link.getAttribute("href"));
});

document.getElementById("toastAction").addEventListener("click", () => {
  const handler = toastActionHandler;
  hideToast();
  handler?.();
});

document.getElementById("themeButton").addEventListener("click", () => {
  const next = effectiveTheme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem(THEME_KEY, next); } catch { /* тема просто не запомнится */ }
  updateThemeButton();
});

window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", updateThemeButton);

document.getElementById("loginButton").addEventListener("click", () => {
  afterLoginHash = routeHash.startsWith("#/login") || routeHash.startsWith("#/signup") ? "#/" : routeHash;
  navigate("#/login");
});
document.getElementById("logoutButton").addEventListener("click", logout);

document.getElementById("authTabs").addEventListener("click", event => {
  const button = event.target.closest("[data-auth]");
  if (button) navigate(`#/${button.dataset.auth}`, { replace: true });
});

document.getElementById("authForm").addEventListener("submit", event => {
  event.preventDefault();
  submitAuth();
});

document.getElementById("authBackButton").addEventListener("click", () => goBack("#/"));

Object.values(fields).forEach(input => input.addEventListener("input", updateLiveScore));

document.getElementById("openCreateButton").addEventListener("click", () => navigate("#/new"));

document.getElementById("cancelCreateButton").addEventListener("click", () => {
  goBack(editingPhotoId ? hairHref(editingPhotoId) : "#/");
});

document.getElementById("backButton").addEventListener("click", () => goBack("#/"));
document.getElementById("userBackButton").addEventListener("click", () => goBack("#/users"));

document.getElementById("openRatingButton").addEventListener("click", () => {
  const photo = getPhoto(selectedPhotoId);
  const mine = photo && myReview(photo);
  navigate(mine ? `${hairHref(selectedPhotoId)}/edit-review/${mine.id}` : `${hairHref(selectedPhotoId)}/rate`);
});

document.getElementById("openReviewButton").addEventListener("click", () => {
  navigate(`${hairHref(selectedPhotoId)}/review`);
});

document.getElementById("editHairButton").addEventListener("click", () => {
  navigate(`${hairHref(selectedPhotoId)}/edit`);
});

document.getElementById("compareHairButton").addEventListener("click", () => {
  navigate(`#/compare/${selectedPhotoId}`);
});

document.getElementById("shareHairButton").addEventListener("click", async event => {
  const photo = getPhoto(selectedPhotoId);
  if (!photo) return;
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const blob = await renderShareCard(photo);
    const saved = await saveFile(`hairrate-${safeFileName(photo.title)}.png`, blob);
    if (saved) showToast("Картинка готова.");
  } catch {
    showToast("Не удалось нарисовать картинку.");
  } finally {
    button.disabled = false;
  }
});

function hairShareUrl(id) {
  return `${location.origin}${location.pathname}${location.search}${hairHref(id)}`;
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* пробуем запасной способ */ }
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.top = "0";
  field.style.left = "0";
  field.style.opacity = "0";
  document.body.appendChild(field);
  field.select();
  let copied = false;
  try { copied = document.execCommand("copy"); } catch { copied = false; }
  field.remove();
  return copied;
}

document.getElementById("copyLinkButton").addEventListener("click", async () => {
  const photo = getPhoto(selectedPhotoId);
  if (!photo) return;
  const url = hairShareUrl(photo.id);
  if (await copyText(url)) {
    showToast("Ссылка скопирована.");
  } else {
    showToast(`Скопируйте ссылку: ${url}`, { duration: 8000 });
  }
});

document.getElementById("deleteHairButton").addEventListener("click", event => {
  const photo = getPhoto(selectedPhotoId);
  if (photo) confirmClick(event.currentTarget, "Точно удалить?", () => deleteHair(photo));
});

document.getElementById("detailGallery").addEventListener("click", event => {
  const button = event.target.closest("[data-index]");
  const photo = getPhoto(selectedPhotoId);
  if (button && photo) showDetailImage(photo, Number(button.dataset.index));
});

document.getElementById("cancelReviewButton").addEventListener("click", () => {
  goBack(hairHref(selectedPhotoId));
});

document.getElementById("addTextButton").addEventListener("click", event => {
  event.currentTarget.classList.add("hidden");
  document.getElementById("reviewTextField").classList.remove("hidden");
  document.getElementById("reviewSubmit").textContent = "Опубликовать рецензию";
  document.getElementById("reviewText").focus();
});

document.getElementById("reviewText").addEventListener("input", event => {
  document.getElementById("reviewTextCount").textContent = event.target.value.length;
});

document.getElementById("reviewsList").addEventListener("click", event => {
  const photo = getPhoto(selectedPhotoId);
  if (!photo) return;
  const editButton = event.target.closest("[data-edit-review-id]");
  if (editButton) {
    navigate(`${hairHref(photo.id)}/edit-review/${editButton.dataset.editReviewId}`);
    return;
  }
  const deleteButton = event.target.closest("[data-review-id]");
  if (deleteButton) {
    confirmClick(deleteButton, "Удалить?", () => deleteReview(photo, Number(deleteButton.dataset.reviewId)));
  }
});

document.getElementById("detailPhoto").addEventListener("click", () => openLightbox(detailImageIndex));
document.getElementById("lightboxClose").addEventListener("click", closeLightbox);
document.getElementById("lightboxPrev").addEventListener("click", () => showLightboxImage(lightboxIndex - 1));
document.getElementById("lightboxNext").addEventListener("click", () => showLightboxImage(lightboxIndex + 1));
document.getElementById("lightbox").addEventListener("click", event => {
  if (event.target.id === "lightbox") closeLightbox();
});

let swipeStartX = null;
document.getElementById("lightbox").addEventListener("touchstart", event => {
  swipeStartX = event.touches.length === 1 ? event.touches[0].clientX : null;
}, { passive: true });
document.getElementById("lightbox").addEventListener("touchend", event => {
  if (swipeStartX === null) return;
  const dx = event.changedTouches[0].clientX - swipeStartX;
  swipeStartX = null;
  if (Math.abs(dx) > 50 && !document.getElementById("lightbox").classList.contains("single")) {
    showLightboxImage(lightboxIndex + (dx < 0 ? 1 : -1));
  }
});

document.getElementById("tagFilter").addEventListener("click", event => {
  const chip = event.target.closest("[data-tag]");
  if (!chip) return;
  tagFilter = chip.dataset.tag || null;
  renderCatalog();
});

document.getElementById("detailTags").addEventListener("click", event => {
  const chip = event.target.closest("[data-tag]");
  if (!chip) return;
  tagFilter = chip.dataset.tag;
  searchQuery = "";
  document.getElementById("searchInput").value = "";
  catalogScroll = 0;
  navigate("#/");
});

document.getElementById("tagPicker").addEventListener("click", event => {
  const chip = event.target.closest("[data-tag]");
  if (chip) toggleDraftTag(chip.dataset.tag);
});

document.getElementById("addTagButton").addEventListener("click", addCustomTag);
document.getElementById("newTagInput").addEventListener("keydown", event => {
  if (event.key === "Enter") {
    event.preventDefault();
    addCustomTag();
  }
});

document.getElementById("newImage").addEventListener("change", event => handleImageFile(event.target.files[0]));

document.getElementById("extraPhotos").addEventListener("change", event => {
  if (event.target.id === "extraInput") handleExtraFiles(event.target.files);
});

document.getElementById("extraPhotos").addEventListener("click", event => {
  const button = event.target.closest("[data-extra-index]");
  if (!button) return;
  draftExtras.splice(Number(button.dataset.extraIndex), 1);
  renderExtraPhotos();
});

const uploadBox = document.getElementById("uploadBox");
uploadBox.addEventListener("dragover", event => {
  event.preventDefault();
  uploadBox.classList.add("dragging");
});
uploadBox.addEventListener("dragleave", () => uploadBox.classList.remove("dragging"));
uploadBox.addEventListener("drop", event => {
  event.preventDefault();
  uploadBox.classList.remove("dragging");
  handleImageFile(event.dataTransfer.files[0]);
});

document.getElementById("createForm").addEventListener("submit", event => {
  event.preventDefault();
  submitHairstyle();
});

document.getElementById("reviewForm").addEventListener("submit", event => {
  event.preventDefault();
  submitReview();
});

document.getElementById("searchInput").addEventListener("input", event => {
  searchQuery = event.target.value;
  renderCatalog();
});

document.getElementById("sortTabs").addEventListener("click", event => {
  const button = event.target.closest("[data-sort]");
  if (!button) return;
  sortMode = button.dataset.sort;
  document.querySelectorAll("#sortTabs [data-sort]").forEach(item => item.classList.toggle("active", item === button));
  renderCatalog();
});

document.getElementById("periodTabs").addEventListener("click", event => {
  const button = event.target.closest("[data-period]");
  if (!button) return;
  topPeriod = button.dataset.period;
  renderTop();
});

document.getElementById("feedTextOnly").addEventListener("change", event => {
  feedTextOnly = event.target.checked;
  renderFeed();
});

["compareA", "compareB"].forEach(id => {
  document.getElementById(id).addEventListener("change", () => {
    const a = document.getElementById("compareA").value;
    const b = document.getElementById("compareB").value;
    navigate(`#/compare/${a}/${b}`, { replace: true });
  });
});

document.getElementById("importButton").addEventListener("click", () => document.getElementById("importInput").click());
document.getElementById("importInput").addEventListener("change", event => {
  importBackup(event.target.files[0]);
  event.target.value = "";
});

document.addEventListener("keydown", event => {
  if (isLightboxOpen()) {
    if (event.key === "Escape") closeLightbox();
    if (event.key === "ArrowLeft") showLightboxImage(lightboxIndex - 1);
    if (event.key === "ArrowRight") showLightboxImage(lightboxIndex + 1);
    return;
  }
  if (event.key === "Escape" && !detailView.classList.contains("hidden")) goBack("#/");
});

document.addEventListener("error", event => {
  const image = event.target;
  if (!(image instanceof HTMLImageElement)) return;
  const holder = image.closest(".card-image-wrap, .detail-photo, .hero-photo, .compare-photo, .top-thumb, .review-photo, .gallery-thumb");
  if (!holder || holder.querySelector(".img-error")) return;
  holder.insertAdjacentHTML("beforeend", `<span class="img-error">Фото не загрузилось</span>`);
}, true);

window.addEventListener("popstate", () => {
  routeHash = location.hash || "#/";
  handleRoute();
});

// Подтягиваем свежие оценки, когда пользователь возвращается на вкладку
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible" || loadState !== "ready") return;
  if (Date.now() - lastLoadedAt < REFRESH_AFTER_MS) return;
  const passive = [catalogView, detailView, topView, feedView, usersView, userView, compareView].some(view => !view.classList.contains("hidden"));
  try {
    await refreshData();
    if (passive) {
      const scroll = window.scrollY;
      handleRoute();
      window.scrollTo({ top: scroll });
    }
  } catch { /* попробуем в следующий раз */ }
});

/* =====================================================================
   Запуск
   ===================================================================== */

async function startLoading() {
  if (!isConfigured()) {
    loadState = "error";
    handleRoute();
    return;
  }
  loadState = "loading";
  handleRoute();
  try {
    await refreshData();
    lastLoadError = null;
  } catch (error) {
    lastLoadError = error;
    loadState = "error";
  }
  handleRoute();
}

function init() {
  updateThemeButton();
  try {
    if ("scrollRestoration" in history) history.scrollRestoration = "manual";
    if (!history.state || history.state.hrDepth === undefined) {
      history.replaceState({ hrDepth: 0 }, "", location.href);
    }
  } catch {
    historyWorks = false;
  }

  session = loadStoredSession();
  updateAuthUI();
  startLoading();
}

init();

console.assert(calculateScore(1, 1, 1, 1) === 4, "Ошибка: минимальная оценка");
console.assert(calculateScore(9, 9, 9, 10) === 67, "Ошибка: максимальная оценка");
console.assert(calculateScore(1, 1, 1, 2) === 7, "Ошибка: 1,1,1,2");
console.assert(calculateScore(5, 5, 5, 5) === 34, "Ошибка: 5,5,5,5");
console.assert(calculateScore(7, 8, 6, 9) === 55, "Ошибка: 7,8,6,9");
