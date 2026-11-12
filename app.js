// نظام إدارة المخازن والإنتاج والحسابات - مصنع العاصمة للصناعات المتخصصة
const STORAGE_KEY = 'al_asimah_factory_clean_v4';
const SESSION_USER_KEY = 'al_asimah_active_user_id';
const THEME_KEY = 'al_asimah_theme';

let state = null;
let currentUser = null;
let activeTab = 'dashboard';
let activeWarehouseSubTab = 'finished';
let activeSettingsSubTab = 'catalog';
let selectedLoginUserId = 'u-1';
let isOnline = navigator.onLine;
let sidebarOpen = false;
let movementDateFilterFrom = '';
let movementDateFilterTo = '';

// filters for finished veneer warehouse
let veneerFilterWood = 'all';
let veneerFilterDimension = 'all'; // 'all' | 'standard' | 'custom' | 'LxW'
let veneerFilterGrade = 'all';
let veneerFilterThickness = 'all';
let veneerFilterStatus = 'in_stock';
let veneerViewMode = 'matrix'; // 'matrix' | 'pallets'
let matrixCompactMode = true; // default to smaller/compact size for veneer quantities & prices tables

// Monotonic timestamp generator so clock skew between devices never causes a stock deduction to be overwritten by an older remote state
function getMonotonicIso(prevIso = '') {
  let maxMs = Date.now();
  if (prevIso) {
    const pMs = new Date(prevIso).getTime() || 0;
    if (pMs >= maxMs) maxMs = pMs + 1000;
  }
  if (state) {
    for (const p of (state.pallets || [])) {
      const t = new Date(p?.updatedAt || 0).getTime() || 0;
      if (t >= maxMs) maxMs = t + 1000;
    }
    for (const o of (state.productionOrders || [])) {
      const t = new Date(o?.updatedAt || 0).getTime() || 0;
      if (t >= maxMs) maxMs = t + 1000;
    }
  }
  return new Date(maxMs).toISOString();
}

// Quick calculator state
let quickCalc = {
  lengthCm: 250,
  widthCm: 125,
  thicknessMm: 1.5,
  sheetsPerPallet: 400,
  palletsCount: 1,
  pricePerM3: 22000
};

// Utility functions
function uid(prefix = 'id') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function fmtNum(n, decimals = 2) {
  const num = Number(n || 0);
  return num.toLocaleString('ar-EG', { minimumFractionDigits: 0, maximumFractionDigits: decimals });
}

function isWarehouseKeeperOnly(user = currentUser) {
  if (!user) return false;
  return Boolean(
    user.roleKey === 'warehouse_keeper' ||
    user.id === 'u-6' ||
    (user.name && user.name.includes('مخزن')) ||
    (user.roleTitle && user.roleTitle.includes('مخزن'))
  );
}

function canSeeFinancialPrices(user = currentUser) {
  return !isWarehouseKeeperOnly(user);
}

// المرتجع يدخل المخزن مرة أخرى بعد موافقة المدير التنفيذي أو مدير المشروعات أو المحاسب فقط
function canApproveSalesReturn(user = currentUser) {
  if (!user) return false;
  return ['ceo', 'projects_manager', 'accountant', 'accounts_manager', 'accounting_manager'].includes(user.roleKey);
}

function sanitizeTextForWarehouseKeeper(str) {
  if (!str || canSeeFinancialPrices()) return str || '';
  return String(str)
    .replace(/\s*[×xX]\s*[0-9.,]+\s*ج(?:\.م)?\s*=\s*[0-9.,]+\s*(?:ج\.م|ج)?/g, '')
    .replace(/\s*(?:بصافي|بقيمة|بسعر|إجمالي|خصم|إلى)\s*[0-9.,]+\s*(?:ج\.م|جنيه|ج)/g, '')
    .replace(/[0-9.,]+\s*(?:ج\.م|جنيه)/g, '');
}

function fmtMoney(n) {
  if (isWarehouseKeeperOnly()) return 'كميات فقط';
  const num = Number(n || 0);
  return `${num.toLocaleString('ar-EG', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} ${state?.factoryInfo?.currency || 'ج.م'}`;
}

function fmtDate(iso) {
  if (!iso) return '-';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('ar-EG', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch (_) {
    return iso;
  }
}

function getCellPriceKey(thkId, gradeId) {
  const safeThk = String(thkId || '').trim().replace(/[.#$/\[\]]/g, '_dot_');
  const safeGrd = String(gradeId || '').trim().replace(/[.#$/\[\]]/g, '_dot_');
  return `${safeThk}__${safeGrd}`;
}

function sanitizeCellPricesMap(rawPrices = {}) {
  const clean = {};
  if (!rawPrices || typeof rawPrices !== 'object') return clean;
  for (const [k, v] of Object.entries(rawPrices)) {
    const safeKey = String(k).replace(/[.#$/\[\]]/g, '_dot_');
    const val = (v && typeof v === 'object') ? Number(v.price || 0) : Number(v || 0);
    if (val > 0 || !(safeKey in clean)) {
      clean[safeKey] = val;
    }
  }
  return clean;
}

function getSortedThicknesses() {
  return [...(state?.catalog?.thicknesses || [])].sort((a, b) => {
    if (Number(a.mm) !== Number(b.mm)) return Number(a.mm) - Number(b.mm);
    return (a.direction || 'qas').localeCompare(b.direction || 'qas');
  });
}

function getCellUnitPrice(thkId, gradeId, thkMm = null, direction = null) {
  if (!state || !state.catalog) return 0;
  state.catalog.cellPrices = sanitizeCellPricesMap(state.catalog.cellPrices || {});

  // 1. Direct lookup by sanitized key (e.g. th-1_dot_5-qas__gr-...)
  const safeKey = getCellPriceKey(thkId, gradeId);
  const directVal = Number(state.catalog.cellPrices[safeKey] || 0);
  if (directVal > 0) return directVal;

  // 2. Lookup by matching thickness row (mm + direction) in catalog.thicknesses
  const thkObj = (state.catalog.thicknesses || []).find(t =>
    t.id === thkId ||
    (thkMm !== null && Number(t.mm) === Number(thkMm) && (t.direction || 'qas') === (direction || 'qas'))
  );
  if (thkObj) {
    const altKey = getCellPriceKey(thkObj.id, gradeId);
    const altVal = Number(state.catalog.cellPrices[altKey] || 0);
    if (altVal > 0) return altVal;

    const canonicalId = `th-${Number(thkObj.mm)}-${thkObj.direction || 'qas'}`;
    const canonKey = getCellPriceKey(canonicalId, gradeId);
    const canonVal = Number(state.catalog.cellPrices[canonKey] || 0);
    if (canonVal > 0) return canonVal;
  }

  // 3. Fallback: check pallets in this cell that have unitSheetPrice > 0
  if (thkObj) {
    const matchingPallet = (state.pallets || []).find(
      p => matchPalletToThicknessRow(p, thkObj) && p.gradeId === gradeId && Number(p.unitSheetPrice || 0) > 0
    );
    if (matchingPallet) return Number(matchingPallet.unitSheetPrice);
  }

  return 0;
}

// Wood Veneer Engineering Calculations (Standard: 125cm x 250cm = 3.125 m², plus full support for custom client dimensions & thicknesses)
function isStandardVeneerDimension(lengthCm = 250, widthCm = 125) {
  const l = Number(lengthCm || 250);
  const w = Number(widthCm || 125);
  return (l === 250 && w === 125) || (l === 125 && w === 250);
}

function formatVeneerDimensions(lengthCm = 250, widthCm = 125, withTag = false) {
  const l = Number(lengthCm || 250);
  const w = Number(widthCm || 125);
  if (isStandardVeneerDimension(l, w)) {
    return withTag ? `125×250 سم (معتمد)` : `125×250 سم`;
  }
  return withTag ? `${w}×${l} سم (مقاس خاص)` : `${w}×${l} سم`;
}

function getVeneerDimensionBadgeHtml(lengthCm = 250, widthCm = 125) {
  const l = Number(lengthCm || 250);
  const w = Number(widthCm || 125);
  if (isStandardVeneerDimension(l, w)) {
    return `<span class="badge" style="background:rgba(15,118,110,0.12);color:var(--primary);font-size:0.68rem;padding:2px 6px;">📏 125×250 سم (معتمد)</span>`;
  }
  return `<span class="badge" style="background:#fef3c7;color:#b45309;border:1px solid #f59e0b;font-size:0.7rem;padding:2px 7px;font-weight:800;">📐 مقاس خاص: ${w}×${l} سم</span>`;
}

function getPresetVeneerDimensions() {
  const defaults = [
    { key: '250x125', lengthCm: 250, widthCm: 125, label: '125 × 250 سم (المقاس المعتمد - 3.125 م²)', isStandard: true },
    { key: '244x122', lengthCm: 244, widthCm: 122, label: '122 × 244 سم (مقاس خاص للشركات - 2.9768 م²)', isStandard: false },
    { key: '220x110', lengthCm: 220, widthCm: 110, label: '110 × 220 سم (مقاس خاص للشركات - 2.42 م²)', isStandard: false },
    { key: '215x100', lengthCm: 215, widthCm: 100, label: '100 × 215 سم (مقاس خاص للشركات - 2.15 م²)', isStandard: false },
    { key: '210x90', lengthCm: 210, widthCm: 90, label: '90 × 210 سم (مقاس أبواب خاص - 1.89 م²)', isStandard: false },
    { key: '200x100', lengthCm: 200, widthCm: 100, label: '100 × 200 سم (مقاس خاص للشركات - 2.00 م²)', isStandard: false },
    { key: '180x90', lengthCm: 180, widthCm: 90, label: '90 × 180 سم (مقاس خاص للشركات - 1.62 م²)', isStandard: false }
  ];
  const map = new Map();
  for (const d of defaults) map.set(d.key, d);

  const customList = state?.catalog?.customDimensions || [];
  for (const cd of customList) {
    const l = Number(cd.lengthCm || 250);
    const w = Number(cd.widthCm || 125);
    const key = isStandardVeneerDimension(l, w) ? '250x125' : `${l}x${w}`;
    if (!map.has(key)) {
      const area = +((l / 100) * (w / 100)).toFixed(4);
      map.set(key, {
        key,
        lengthCm: l,
        widthCm: w,
        label: cd.label || `${w} × ${l} سم (${cd.clientNote || 'مقاس خاص'} - ${area} م²)`,
        isStandard: false
      });
    }
  }

  // Also discover any custom dimensions used on existing pallets or productionOrders
  for (const p of (state?.pallets || [])) {
    const l = Number(p.lengthCm || 250);
    const w = Number(p.widthCm || 125);
    if (!isStandardVeneerDimension(l, w) && l > 0 && w > 0) {
      const key = `${l}x${w}`;
      if (!map.has(key)) {
        const area = +((l / 100) * (w / 100)).toFixed(4);
        map.set(key, { key, lengthCm: l, widthCm: w, label: `${w} × ${l} سم (مقاس خاص مسجل - ${area} م²)`, isStandard: false });
      }
    }
  }
  for (const o of (state?.productionOrders || [])) {
    for (const it of (o.items || [])) {
      const l = Number(it.lengthCm || 250);
      const w = Number(it.widthCm || 125);
      if (!isStandardVeneerDimension(l, w) && l > 0 && w > 0) {
        const key = `${l}x${w}`;
        if (!map.has(key)) {
          const area = +((l / 100) * (w / 100)).toFixed(4);
          map.set(key, { key, lengthCm: l, widthCm: w, label: `${w} × ${l} سم (مقاس خاص بطلبية - ${area} م²)`, isStandard: false });
        }
      }
    }
  }

  return Array.from(map.values());
}

function ensureCustomDimensionInCatalog(lengthCm, widthCm, clientNote = '') {
  const l = Number(lengthCm || 250);
  const w = Number(widthCm || 125);
  if (isStandardVeneerDimension(l, w) || l <= 0 || w <= 0) return;
  if (!state || !state.catalog) return;
  state.catalog.customDimensions = state.catalog.customDimensions || [];
  const exists = state.catalog.customDimensions.some(d => Number(d.lengthCm) === l && Number(d.widthCm) === w);
  if (!exists) {
    const area = +((l / 100) * (w / 100)).toFixed(4);
    state.catalog.customDimensions.push({
      id: `dim-${l}x${w}`,
      lengthCm: l,
      widthCm: w,
      areaM2: area,
      clientNote: clientNote || 'مقاس خاص للشركات',
      label: `${w} × ${l} سم (${clientNote || 'مقاس خاص'} - ${area} م²)`
    });
  }
}

function ensureCatalogThicknessExists(mmVal, direction = 'qas', customUnitPrice = 0, gradeId = '') {
  const mm = Number(mmVal || 1.5);
  const dir = direction === 'sada' ? 'sada' : 'qas';
  const dirLabel = dir === 'sada' ? 'اتجاه سدا' : 'اتجاه قص';
  const rowId = `th-${mm}-${dir}`;
  if (!state || !state.catalog) {
    return { id: rowId, mm, direction: dir, directionLabel: dirLabel, label: `${mm} مم — ${dirLabel}`, standardSheetsPerPallet: 400 };
  }
  state.catalog.thicknesses = state.catalog.thicknesses || [];
  let existing = state.catalog.thicknesses.find(
    t => t.id === rowId || (Number(t.mm) === mm && (t.direction || 'qas') === dir)
  );
  if (!existing) {
    state.deletedIds = (state.deletedIds || []).filter(id => id !== rowId);
    existing = {
      id: rowId,
      mm,
      direction: dir,
      directionLabel: dirLabel,
      label: `${mm} مم — ${dirLabel}`,
      category: dirLabel,
      standardSheetsPerPallet: 400
    };
    state.catalog.thicknesses.push(existing);
    state.catalog.thicknesses.sort((a, b) => {
      if (Number(a.mm) !== Number(b.mm)) return Number(a.mm) - Number(b.mm);
      return (a.direction || 'qas').localeCompare(b.direction || 'qas');
    });
  }
  if (customUnitPrice > 0 && gradeId && canSeeFinancialPrices()) {
    state.catalog.cellPrices = state.catalog.cellPrices || {};
    const cKey = getCellPriceKey(existing.id, gradeId);
    if (!state.catalog.cellPrices[cKey]) {
      state.catalog.cellPrices[cKey] = Number(customUnitPrice);
    }
  }
  return existing;
}

function matchesPalletDimensionFilter(p, filterVal = veneerFilterDimension) {
  if (!filterVal || filterVal === 'all') return true;
  const l = Number(p?.lengthCm || 250);
  const w = Number(p?.widthCm || 125);
  const isStd = isStandardVeneerDimension(l, w);
  if (filterVal === 'standard') return isStd;
  if (filterVal === 'custom') return !isStd;
  return `${l}x${w}` === filterVal || `${w}x${l}` === filterVal;
}

function calculateVeneerMetrics(lengthCm, widthCm, thicknessMm, sheetsCount) {
  const lM = Number(lengthCm || 250) / 100;
  const wM = Number(widthCm || 125) / 100;
  const tM = Number(thicknessMm || 1.5) / 1000;
  const sheets = Number(sheetsCount || 0);
  const sheetAreaM2 = lM * wM; // Standard: 2.5 * 1.25 = 3.125 m2 (or custom L * W)
  const totalAreaM2 = +(sheetAreaM2 * sheets).toFixed(4);
  const totalVolumeM3 = +(totalAreaM2 * tM).toFixed(4);
  return {
    sheetAreaM2: +sheetAreaM2.toFixed(4),
    totalAreaM2,
    totalVolumeM3
  };
}

// ============================================================================
// LONG AUDIO ALERT & PERMISSION-BASED NOTIFICATION ENGINE
// ============================================================================
let audioCtx = null;
let activeAlertTimers = [];
let activeBannerAlert = null;
let soundEnabled = localStorage.getItem('al_asimah_sound_enabled') !== 'false';
let activeChatChannel = 'general'; // 'general' | 'warehouses' | 'production' | 'accounting' | 'dm_u-1' ...
let chatMsgType = 'message'; // 'message' | 'task' | 'urgent'
let chatLinkedTab = '';
let chatAssignedUserId = '';

// Unlock Web Audio API on first user interaction
window.addEventListener('click', () => {
  if (!audioCtx && (window.AudioContext || window.webkitAudioContext)) {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (_) {}
  } else if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
}, { once: false });

function stopLongAlertSound() {
  for (const t of activeAlertTimers) {
    clearTimeout(t);
  }
  activeAlertTimers = [];
}

// Plays a clear, long (4.5 seconds) industrial multi-chime ringtone for authorized users
function playLongAlertSound(isUrgent = false) {
  if (!soundEnabled) return;
  stopLongAlertSound();
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!audioCtx) audioCtx = new Ctx();
    if (audioCtx.state === 'suspended') audioCtx.resume();

    // 10-step long resonant chime pattern lasting ~4.5 seconds
    const pattern = isUrgent
      ? [
          { freq: 880, delay: 0, dur: 0.35 },
          { freq: 1174.66, delay: 380, dur: 0.35 },
          { freq: 880, delay: 760, dur: 0.35 },
          { freq: 1174.66, delay: 1140, dur: 0.35 },
          { freq: 1318.5, delay: 1550, dur: 0.45 },
          { freq: 880, delay: 2100, dur: 0.35 },
          { freq: 1174.66, delay: 2480, dur: 0.35 },
          { freq: 1318.5, delay: 2880, dur: 0.45 },
          { freq: 1046.5, delay: 3400, dur: 0.4 },
          { freq: 1318.5, delay: 3850, dur: 0.65 }
        ]
      : [
          { freq: 587.33, delay: 0, dur: 0.38 },
          { freq: 880, delay: 400, dur: 0.38 },
          { freq: 1174.66, delay: 800, dur: 0.45 },
          { freq: 880, delay: 1300, dur: 0.38 },
          { freq: 1046.5, delay: 1720, dur: 0.45 },
          { freq: 587.33, delay: 2250, dur: 0.38 },
          { freq: 880, delay: 2650, dur: 0.38 },
          { freq: 1174.66, delay: 3050, dur: 0.45 },
          { freq: 1046.5, delay: 3550, dur: 0.42 },
          { freq: 1174.66, delay: 4000, dur: 0.65 }
        ];

    for (const note of pattern) {
      const timerId = setTimeout(() => {
        try {
          const now = audioCtx.currentTime;
          const osc = audioCtx.createOscillator();
          const gain = audioCtx.createGain();
          osc.type = isUrgent ? 'sawtooth' : 'triangle';
          osc.frequency.setValueAtTime(note.freq, now);

          gain.gain.setValueAtTime(0.001, now);
          gain.gain.exponentialRampToValueAtTime(0.32, now + 0.04);
          gain.gain.exponentialRampToValueAtTime(0.001, now + note.dur);

          osc.connect(gain);
          gain.connect(audioCtx.destination);
          osc.start(now);
          osc.stop(now + note.dur + 0.02);
        } catch (_) {}
      }, note.delay);
      activeAlertTimers.push(timerId);
    }
  } catch (_) {}
}

function inferActionScope(actionText = '') {
  const txt = String(actionText);
  const permKeys = [];
  let targetTab = 'dashboard';

  if (txt.includes('مبيعات') || txt.includes('فاتورة') || txt.includes('معاملة مالية') || txt.includes('خزينة') || txt.includes('عميل') || txt.includes('مورد')) {
    permKeys.push('salesAccounting');
    targetTab = 'accounting';
  }
  if (txt.includes('مخزن') || txt.includes('خلية') || txt.includes('بالتة') || txt.includes('تخانة') || txt.includes('جودة') || txt.includes('سعر القطعة') || txt.includes('خام') || txt.includes('هالك') || txt.includes('غيار') || txt.includes('فرخ') || txt.includes('قطعة')) {
    permKeys.push('warehouses');
    if (targetTab === 'dashboard') targetTab = 'warehouses';
  }
  if (txt.includes('أمر تجهيز') || txt.includes('تجهيز طلبية') || txt.includes('طلبية') || txt.includes('تجهيز') || txt.includes('للتجهيز') || txt.includes('بيان للعميل') || txt.includes('بيان الطلبية') || txt.includes('أمر تشغيل') || txt.includes('التشغيل')) {
    permKeys.push('production', 'warehouses');
    targetTab = 'production';
  }
  if (txt.includes('اعتماد') || txt.includes('إذن صرف') || txt.includes('صرف للسيارة') || txt.includes('صرف الطلبية') || txt.includes('تحميل البضاعة') || txt.includes('سيارة')) {
    permKeys.push('approvals', 'warehouses', 'production');
    targetTab = 'approvals';
  }
  if (txt.includes('مرتجع')) {
    permKeys.push('warehouses', 'approvals', 'salesAccounting');
    targetTab = 'warehouses';
  }
  if (txt.includes('صلاحية') || txt.includes('الباسورد')) {
    permKeys.push('settingsUsers');
    targetTab = 'settings';
  }
  if (txt.includes('شات') || txt.includes('رسالة') || txt.includes('مهمة')) {
    permKeys.push('chat');
    targetTab = 'chat';
  }

  if (permKeys.length === 0) permKeys.push('dashboard');
  return { permKeys, targetTab };
}

function canUserSeeNotification(user, logItem) {
  if (!user || !logItem) return false;
  if (isFullAdmin(user)) return true; // المدير التنفيذي ومدير المشروعات يرون كافة الإشعارات والتعديلات
  if (Array.isArray(logItem.hiddenFromRoles) && logItem.hiddenFromRoles.includes(user.roleKey)) {
    return false;
  }
  if (isWarehouseKeeperOnly(user)) {
    const act = String(logItem.action || '');
    if (act.includes('سعر القطعة') || act.includes('معاملة مالية') || act.includes('تحصيل دفعة') || act.includes('سند مالي') || act.includes('مديونية')) {
      return false;
    }
  }
  if (logItem.targetUserId && logItem.targetUserId !== 'all') {
    return logItem.targetUserId === user.id || logItem.actorId === user.id;
  }
  const perms = Array.isArray(logItem.permKeys) && logItem.permKeys.length > 0
    ? logItem.permKeys
    : inferActionScope(logItem.action || '').permKeys;

  if (perms.includes('all') || perms.includes('dashboard') || perms.includes('chat')) return true;
  return perms.some(pk => Boolean(user.permissions && user.permissions[pk]));
}

function getSeenNotifIds() {
  if (!currentUser) return new Set();
  try {
    const raw = localStorage.getItem(`al_asimah_seen_notifs_${currentUser.id}`);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch (_) {
    return new Set();
  }
}

function markNotifIdsSeen(ids) {
  if (!currentUser) return;
  const set = getSeenNotifIds();
  for (const id of ids) set.add(id);
  const arr = Array.from(set).slice(-300);
  localStorage.setItem(`al_asimah_seen_notifs_${currentUser.id}`, JSON.stringify(arr));
}

function showLiveBannerAlert(logItem) {
  activeBannerAlert = logItem;
  renderLiveBannerDOM();
}

function dismissLiveBannerAlert() {
  stopLongAlertSound();
  if (activeBannerAlert) {
    markNotifIdsSeen([activeBannerAlert.id]);
  }
  activeBannerAlert = null;
  renderLiveBannerDOM();
}

function renderLiveBannerDOM() {
  let bannerEl = document.getElementById('live-alert-banner-root');
  if (!bannerEl) {
    bannerEl = document.createElement('div');
    bannerEl.id = 'live-alert-banner-root';
    document.body.appendChild(bannerEl);
  }
  if (!activeBannerAlert || !currentUser) {
    bannerEl.innerHTML = '';
    return;
  }
  const item = activeBannerAlert;
  const targetTab = item.targetTab || inferActionScope(item.action).targetTab || 'dashboard';
  bannerEl.innerHTML = `
    <div class="live-alert-banner">
      <div style="display:flex;align-items:center;gap:12px;">
        <div style="font-size:1.8rem;">🔔</div>
        <div>
          <div style="font-weight:900;color:#fbbf24;font-size:0.95rem;">
            إشعار فوري (${item.userName || 'مستخدم'} — ${item.roleTitle || ''})
          </div>
          <div style="font-weight:700;font-size:0.9rem;margin-top:2px;">
            ${sanitizeTextForWarehouseKeeper(item.action)}
          </div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <button class="btn btn-sm btn-primary" onclick="setTab('${targetTab}'); dismissLiveBannerAlert();">
          👁️ فتح ومراجعة الآن
        </button>
        <button class="btn btn-sm btn-outline" style="color:#fff;border-color:#94a3b8;" onclick="dismissLiveBannerAlert()">
          🔇 إيقاف الصوت وإغلاق
        </button>
      </div>
    </div>
  `;
}

function checkIncomingNotifications(prevLogs = [], newLogs = [], prevChats = [], newChats = [], prevOrders = [], newOrders = [], prevReturns = [], newReturns = []) {
  if (!currentUser) return;
  const seen = getSeenNotifIds();

  // 1) Direct live check for newly arrived or newly approved Preparation Orders & Car Dispatch Orders
  const prevOrderStageMap = new Map((prevOrders || []).map(o => [o.id, o.stage || o.status]));
  const isWarehouseOrAdmin = currentUser.roleKey === 'admin_manager' || currentUser.roleKey === 'warehouse_keeper' || isFullAdmin(currentUser);
  const isAccountantRole = ['accountant', 'accounts_manager', 'accounting_manager'].includes(currentUser.roleKey) || isFullAdmin(currentUser);

  for (const ord of (newOrders || [])) {
    if (!ord || !ord.id) continue;
    const curStage = ord.stage || ord.status;
    const oldStage = prevOrderStageMap.get(ord.id);
    const stageAlertKey = `ord_stage_${ord.id}_${curStage}`;

    if (curStage !== oldStage && !seen.has(stageAlertKey)) {
      if (curStage === 'pending_warehouse_prep' && isWarehouseOrAdmin) {
        playLongAlertSound(true);
        showLiveBannerAlert({
          id: stageAlertKey,
          userName: ord.executiveApprovedBy || ord.requestedBy || 'الإدارة',
          roleTitle: 'أمر تجهيز طلبية فوري',
          action: `📦 أمر تجهيز طلبية جديد (${ord.orderNumber}) لصالح العميل (${ord.clientName}) — إجمالي الكمية: ${fmtNum(ord.totalSheetsCount || 0, 0)} قطعة (${fmtNum(ord.totalVolumeM3 || 0, 4)} م³) جاهز للتجهيز الآن!`,
          targetTab: 'production'
        });
        markNotifIdsSeen([stageAlertKey]);
        return;
      }
      if (curStage === 'ready_for_car_dispatch' && isWarehouseOrAdmin) {
        playLongAlertSound(true);
        showLiveBannerAlert({
          id: stageAlertKey,
          userName: ord.accountantReleaseBy || 'الحسابات',
          roleTitle: 'أمر صرف وتحميل سيارة فوري',
          action: `🚚 أمر فوري بصرف الطلبية (${ord.orderNumber}) للعميل (${ord.clientName}) وعمل إذن صرف للسيارة المحملة (${fmtNum(ord.totalSheetsCount || 0, 0)} قطعة)!`,
          targetTab: 'approvals'
        });
        markNotifIdsSeen([stageAlertKey]);
        return;
      }
      if (curStage === 'pending_executive' && isFullAdmin(currentUser)) {
        playLongAlertSound(true);
        showLiveBannerAlert({
          id: stageAlertKey,
          userName: ord.requestedBy || 'المحاسب',
          roleTitle: 'طلب موافقة على بيان طلبية',
          action: `📋 بيان وأمر تجهيز طلبية جديد (${ord.orderNumber}) للعميل (${ord.clientName}) بانتظار موافقة المدير التنفيذي أو مدير المشروعات ليظهر للمخزن والمدير الإداري`,
          targetTab: 'production'
        });
        markNotifIdsSeen([stageAlertKey]);
        return;
      }
      if (curStage === 'pending_accountant_release' && isAccountantRole) {
        playLongAlertSound(true);
        showLiveBannerAlert({
          id: stageAlertKey,
          userName: ord.warehousePrepApprovedBy || 'المخزن/الإدارة',
          roleTitle: 'تم تجهيز الطلبية بالمخزن',
          action: `✅ تمت موافقة (${ord.warehousePrepApprovedBy || 'المخزن'}) على تجهيز الطلبية (${ord.orderNumber}) للعميل (${ord.clientName}) — بانتظار عمل حسابات العميل واعتماد إذن الصرف`,
          targetTab: 'approvals'
        });
        markNotifIdsSeen([stageAlertKey]);
        return;
      }
    }
  }

  // 2) Direct live check for Sales Returns (مرتجع مبيعات يدخل المخزن بعد موافقة التنفيذي أو المشروعات أو المحاسب فقط)
  const prevReturnStatusMap = new Map((prevReturns || []).map(r => [r.id, r.status]));
  for (const ret of (newReturns || [])) {
    if (!ret || !ret.id) continue;
    const curStatus = ret.status || 'pending_approval';
    const oldStatus = prevReturnStatusMap.get(ret.id);
    const retAlertKey = `ret_status_${ret.id}_${curStatus}`;

    if (curStatus !== oldStatus && !seen.has(retAlertKey)) {
      if (curStatus === 'pending_approval' && canApproveSalesReturn(currentUser)) {
        playLongAlertSound(true);
        showLiveBannerAlert({
          id: retAlertKey,
          userName: ret.requestedBy || 'أمين المخزن',
          roleTitle: 'طلب موافقة على مرتجع مبيعات للمخزن',
          action: `🔄 طلب إدخال مرتجع مبيعات (${ret.returnNumber}) من العميل (${ret.clientName}) بكمية (${fmtNum(ret.sheetsCount || 0, 0)} قطعة — ${ret.thicknessMm}مم ${ret.directionLabel} × ${ret.gradeName}) بانتظار موافقتك ليدخل رصيد المخزن!`,
          targetTab: 'warehouses'
        });
        markNotifIdsSeen([retAlertKey]);
        return;
      }
      if (curStatus === 'approved' && isWarehouseOrAdmin) {
        playLongAlertSound(true);
        showLiveBannerAlert({
          id: retAlertKey,
          userName: ret.approvedBy || 'الإدارة/الحسابات',
          roleTitle: 'تمت الموافقة على دخول المرتجع للمخزن',
          action: `✅ تمت موافقة (${ret.approvedBy || 'الإدارة'}) على مرتجع المبيعات (${ret.returnNumber}) للعميل (${ret.clientName}) — دخلت الكمية (${fmtNum(ret.sheetsCount || 0, 0)} قطعة) إلى رصيد المخزن الآن!`,
          targetTab: 'warehouses'
        });
        markNotifIdsSeen([retAlertKey]);
        return;
      }
    }
  }

  const prevLogIds = new Set((prevLogs || []).map(l => l.id));

  // Find newly arrived logs that currentUser has permission to view
  const freshAuthorizedLogs = (newLogs || []).filter(l =>
    l && l.id && !prevLogIds.has(l.id) && !seen.has(l.id) &&
    l.actorId !== currentUser.id &&
    canUserSeeNotification(currentUser, l)
  );

  const prevChatIds = new Set((prevChats || []).map(c => c.id));
  const freshAuthorizedChats = (newChats || []).filter(c =>
    c && c.id && !prevChatIds.has(c.id) && !seen.has(c.id) &&
    c.senderId !== currentUser.id &&
    canUserSeeChatMessage(currentUser, c)
  );

  if (freshAuthorizedChats.length > 0) {
    const latestChat = freshAuthorizedChats[freshAuthorizedChats.length - 1];
    const isUrgent = latestChat.msgType === 'urgent' || latestChat.msgType === 'task';
    playLongAlertSound(isUrgent);
    showLiveBannerAlert({
      id: latestChat.id,
      userName: latestChat.senderName,
      roleTitle: latestChat.senderRoleTitle,
      action: `${latestChat.msgType === 'task' ? '📌 مهمة عمل جديدة: ' : latestChat.msgType === 'urgent' ? '🚨 تنبيه عاجل: ' : '💬 رسالة جديدة: '}${latestChat.text}`,
      targetTab: 'chat'
    });
    markNotifIdsSeen(freshAuthorizedChats.map(c => c.id));
    return;
  }

  if (freshAuthorizedLogs.length > 0) {
    const latestLog = freshAuthorizedLogs[0];
    playLongAlertSound(false);
    showLiveBannerAlert(latestLog);
    markNotifIdsSeen(freshAuthorizedLogs.map(l => l.id));
  }
}

function addAuditLog(actionText, explicitPermKeys = null, explicitTargetTab = null, targetUserId = 'all', hiddenFromRoles = []) {
  if (!state) return;
  state.auditLogs = state.auditLogs || [];
  const inferred = inferActionScope(actionText);
  const newLog = {
    id: uid('log'),
    timestamp: new Date().toISOString(),
    actorId: currentUser ? currentUser.id : 'system',
    userName: currentUser ? currentUser.name : 'النظام',
    roleTitle: currentUser ? currentUser.roleTitle : '',
    action: actionText,
    permKeys: explicitPermKeys || inferred.permKeys,
    targetTab: explicitTargetTab || inferred.targetTab,
    targetUserId,
    hiddenFromRoles
  };
  state.auditLogs.unshift(newLog);
  if (state.auditLogs.length > 250) {
    state.auditLogs = state.auditLogs.slice(0, 250);
  }
  if (currentUser) {
    markNotifIdsSeen([newLog.id]);
  }
  // Play confirmation long alert if user has sound enabled so everyone on this device or other devices hears it
  playLongAlertSound(false);
}

const FIREBASE_CLOUD_URL = 'https://elite-grand-8a6c3-default-rtdb.firebaseio.com/al_asimah_factory_clean.json';
const PERMANENT_CLOUD_URL = 'https://mmhwahdan-ui.github.io/al-asimah-factory/';
let liveServerUrls = {
  cloudUrl: PERMANENT_CLOUD_URL,
  tunnelUrl: '',
  lanUrl: 'http://192.168.1.3:8090',
  localUrl: 'http://localhost:8090'
};
let deferredInstallPrompt = null;

function mergeCleanStringsClient(existingObj, incomingObj) {
  if (!existingObj || typeof existingObj !== 'object') return incomingObj;
  if (!incomingObj || typeof incomingObj !== 'object') return existingObj;
  const result = { ...existingObj, ...incomingObj };
  for (const key of Object.keys(result)) {
    const exVal = existingObj[key];
    const inVal = incomingObj[key];
    if (typeof inVal === 'string' && inVal.includes('\uFFFD') && typeof exVal === 'string' && !exVal.includes('\uFFFD')) {
      result[key] = exVal;
    } else if (Array.isArray(inVal) && Array.isArray(exVal) && inVal.length === exVal.length) {
      result[key] = inVal.map((item, idx) => (item && typeof item === 'object' && exVal[idx] && typeof exVal[idx] === 'object') ? mergeCleanStringsClient(exVal[idx], item) : item);
    } else if (inVal && typeof inVal === 'object' && !Array.isArray(inVal) && exVal && typeof exVal === 'object' && !Array.isArray(exVal)) {
      result[key] = mergeCleanStringsClient(exVal, inVal);
    }
  }
  return result;
}

function smartMergeListClient(a = [], b = [], deletedSet = new Set()) {
  const map = new Map();
  for (const item of (Array.isArray(a) ? a : [])) {
    if (item && item.id && !deletedSet.has(item.id)) map.set(item.id, item);
  }
  for (const item of (Array.isArray(b) ? b : [])) {
    if (!item || !item.id || deletedSet.has(item.id)) continue;
    const prev = map.get(item.id);
    if (!prev) {
      map.set(item.id, item);
    } else {
      const tA = new Date(prev.updatedAt || prev.timestamp || prev.createdAt || 0).getTime() || 0;
      const tB = new Date(item.updatedAt || item.timestamp || item.createdAt || 0).getTime() || 0;
      map.set(item.id, tB >= tA ? mergeCleanStringsClient(prev, item) : mergeCleanStringsClient(item, prev));
    }
  }
  return Array.from(map.values());
}

function normalizeState(s) {
  const def = getDefaultInitialState();
  if (!s || typeof s !== 'object') return def;
  s.factoryInfo = { ...def.factoryInfo, ...(s.factoryInfo || {}) };
  if (!s.factoryInfo.name || s.factoryInfo.name.includes('\uFFFD')) s.factoryInfo.name = def.factoryInfo.name;
  if (!s.factoryInfo.subtitle || s.factoryInfo.subtitle.includes('\uFFFD')) s.factoryInfo.subtitle = def.factoryInfo.subtitle;
  if (!s.factoryInfo.standardDimensions || s.factoryInfo.standardDimensions.includes('\uFFFD')) s.factoryInfo.standardDimensions = def.factoryInfo.standardDimensions;
  if (!s.factoryInfo.address || s.factoryInfo.address.includes('\uFFFD')) s.factoryInfo.address = def.factoryInfo.address;
  if (!s.factoryInfo.currency || s.factoryInfo.currency.includes('\uFFFD')) s.factoryInfo.currency = def.factoryInfo.currency;

  s.catalog = s.catalog && typeof s.catalog === 'object' ? s.catalog : {};
  s.catalog.woodTypes = Array.isArray(s.catalog.woodTypes) ? s.catalog.woodTypes : [];
  s.catalog.thicknesses = Array.isArray(s.catalog.thicknesses) ? s.catalog.thicknesses : [];
  s.catalog.grades = Array.isArray(s.catalog.grades) ? s.catalog.grades : [];
  s.catalog.dimensions = Array.isArray(s.catalog.dimensions) && s.catalog.dimensions.length > 0 ? s.catalog.dimensions : def.catalog.dimensions;
  s.catalog.cellPrices = sanitizeCellPricesMap(s.catalog.cellPrices && typeof s.catalog.cellPrices === 'object' ? s.catalog.cellPrices : {});

  // Sanitize catalog labels against any encoding corruption
  s.catalog.dimensions.forEach(d => {
    if (!d.label || d.label.includes('\uFFFD')) d.label = '250 × 125 سم (مقاس طبيعي قياسي)';
  });
  s.catalog.woodTypes.forEach(w => {
    if (!w.name || w.name.includes('\uFFFD')) w.name = 'قشرة خشبية (250×125)';
    if (!w.origin || w.origin.includes('\uFFFD')) w.origin = 'مصنع العاصمة';
  });
  s.catalog.grades.forEach(g => {
    if (g.code && g.code.startsWith('P- C')) g.code = 'P- C قطع';
    if (!g.name || g.name.includes('\uFFFD')) g.name = `جودة (${g.code})`;
    if (!g.description || g.description.includes('\uFFFD')) g.description = 'درجة جودة';
  });
  s.catalog.thicknesses.forEach(t => {
    const dir = t.direction === 'sada' ? 'sada' : 'qas';
    t.direction = dir;
    t.directionLabel = dir === 'sada' ? 'اتجاه سدا' : 'اتجاه قص';
    t.category = t.directionLabel;
    t.label = `${t.mm} مم — ${t.directionLabel}`;
  });

  const arrayKeys = [
    'users', 'pallets', 'rawMaterials', 'scrapItems', 'spareParts',
    'productionOrders', 'approvalRequests', 'warehouseMovements', 'salesReturns',
    'partners', 'palletMovements', 'financialTransactions',
    'auditLogs', 'chatMessages', 'deletedIds'
  ];
  for (const k of arrayKeys) {
    if (!Array.isArray(s[k])) {
      s[k] = k === 'users' ? def.users : [];
    }
  }
  if (s.users.length === 0) s.users = def.users;

  // Keep newest records first (index 0) so new orders, movements, and notifications always appear at the top
  const descTimeKeys = ['productionOrders', 'warehouseMovements', 'salesReturns', 'financialTransactions', 'palletMovements', 'auditLogs'];
  for (const tk of descTimeKeys) {
    s[tk].sort((a, b) => {
      const tA = new Date(a?.updatedAt || a?.timestamp || a?.createdAt || a?.date || 0).getTime() || 0;
      const tB = new Date(b?.updatedAt || b?.timestamp || b?.createdAt || b?.date || 0).getTime() || 0;
      return tB - tA;
    });
  }
  s.chatMessages.sort((a, b) => {
    const tA = new Date(a?.createdAt || a?.updatedAt || 0).getTime() || 0;
    const tB = new Date(b?.createdAt || b?.updatedAt || 0).getTime() || 0;
    return tA - tB;
  });

  s.treasuryBalances = {
    cashVault: 0,
    bankAccount: 0,
    checksUnderCollection: 0,
    ...(s.treasuryBalances || {})
  };

  for (const u of s.users) {
    const defUser = def.users.find(du => du.roleKey === u.roleKey || du.id === u.id);
    if (defUser) {
      if (!u.name || u.name.includes('\uFFFD')) u.name = defUser.name;
      if (!u.roleTitle || u.roleTitle.includes('\uFFFD')) u.roleTitle = defUser.roleTitle;
    }
    u.permissions = u.permissions || {};
    u.permissions.dashboard = true;
    u.permissions.warehouses = true;
    u.permissions.production = true;
    u.permissions.approvals = true;
    u.permissions.reports = true;
    if (u.roleKey === 'ceo' || u.roleKey === 'projects_manager') {
      u.permissions = {
        dashboard: true,
        warehouses: true,
        warehouseIssueReceive: true,
        production: true,
        approvals: true,
        approveFinancial: true,
        approveExecutive: true,
        approveWarehouse: true,
        salesAccounting: true,
        clientsSuppliers: true,
        reports: true,
        settingsUsers: true
      };
    } else if (u.roleKey === 'warehouse_keeper') {
      u.permissions.warehouseIssueReceive = true;
      u.permissions.approveWarehouse = true;
      u.permissions.salesAccounting = false;
      u.permissions.clientsSuppliers = false;
      u.permissions.approveFinancial = false;
    } else if (['accountant', 'accounts_manager', 'accounting_manager'].includes(u.roleKey)) {
      u.permissions.salesAccounting = true;
      u.permissions.clientsSuppliers = true;
      u.permissions.approveFinancial = true;
    } else if (u.roleKey === 'admin_manager') {
      u.permissions.approveWarehouse = true;
      u.permissions.clientsSuppliers = true;
    }
  }
  return s;
}

function smartMergeClientState(current, incoming) {
  if (!current || !current.users) return normalizeState(incoming);
  if (!incoming || !incoming.users) return normalizeState(current);
  const deletedIds = Array.from(new Set([...(current.deletedIds || []), ...(incoming.deletedIds || [])]));
  const delSet = new Set(deletedIds);
  const listKeys = [
    'users', 'pallets', 'rawMaterials', 'scrapItems', 'spareParts',
    'productionOrders', 'approvalRequests', 'warehouseMovements', 'salesReturns',
    'partners', 'palletMovements', 'financialTransactions', 'auditLogs', 'chatMessages'
  ];
  const merged = {
    ...current,
    ...incoming,
    factoryInfo: { ...(current.factoryInfo || {}), ...(incoming.factoryInfo || {}) },
    treasuryBalances: { ...(current.treasuryBalances || {}), ...(incoming.treasuryBalances || {}) },
    catalog: {
      woodTypes: smartMergeListClient(current.catalog?.woodTypes, incoming.catalog?.woodTypes, delSet),
      thicknesses: smartMergeListClient(current.catalog?.thicknesses, incoming.catalog?.thicknesses, delSet),
      grades: smartMergeListClient(current.catalog?.grades, incoming.catalog?.grades, delSet),
      dimensions: smartMergeListClient(current.catalog?.dimensions, incoming.catalog?.dimensions, delSet),
      cellPrices: sanitizeCellPricesMap({ ...(current.catalog?.cellPrices || {}), ...(incoming.catalog?.cellPrices || {}) })
    },
    deletedIds
  };
  for (const key of listKeys) {
    merged[key] = smartMergeListClient(current[key], incoming[key], delSet);
  }
  return normalizeState(merged);
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  render();
});

async function refreshServerUrls() {
  try {
    const res = await fetch('/api/urls', { cache: 'no-store' });
    if (res.ok) {
      liveServerUrls = await res.json();
    }
  } catch (_) {}
}

function getDefaultInitialState() {
  const fullPerms = {
    dashboard: true, warehouses: true, warehouseIssueReceive: true, production: true,
    approvals: true, approveFinancial: true, approveExecutive: true, approveWarehouse: true,
    salesAccounting: true, clientsSuppliers: true, reports: true, settingsUsers: true
  };
  return {
    factoryInfo: {
      name: 'مصنع العاصمة للصناعات المتخصصة',
      subtitle: 'نظام إدارة المخازن والإنتاج والحسابات المتكامل - إنتاج القشرة الخشبية',
      standardDimensions: '250 سم × 125 سم',
      standardSheetAreaM2: 3.125,
      currency: 'ج.م'
    },
    catalog: { woodTypes: [], thicknesses: [], grades: [], dimensions: [{ id: 'dim-std', lengthCm: 250, widthCm: 125, label: '250 × 125 سم (المقاس الطبيعي القياسي)', isDefault: true }], cellPrices: {} },
    users: [
      { id: 'u-1', code: 'USR-01', name: 'المدير التنفيذي', roleKey: 'ceo', roleTitle: 'المدير التنفيذي (CEO) - كامل الصلاحيات', pin: '1111', avatarColor: '#d97706', active: true, permissions: { ...fullPerms } },
      { id: 'u-2', code: 'USR-02', name: 'مدير المشروعات', roleKey: 'projects_manager', roleTitle: 'مدير المشروعات - كامل الصلاحيات', pin: '2222', avatarColor: '#2563eb', active: true, permissions: { ...fullPerms } },
      { id: 'u-3', code: 'USR-03', name: 'مدير الحسابات', roleKey: 'accounts_manager', roleTitle: 'مدير الحسابات والمالية', pin: '3333', avatarColor: '#059669', active: true, permissions: { dashboard: true, warehouses: true, warehouseIssueReceive: false, production: true, approvals: true, approveFinancial: true, approveExecutive: false, approveWarehouse: false, salesAccounting: true, clientsSuppliers: true, reports: true, settingsUsers: false } },
      { id: 'u-4', code: 'USR-04', name: 'المحاسب', roleKey: 'accountant', roleTitle: 'محاسب المبيعات والخزينة', pin: '4444', avatarColor: '#10b981', active: true, permissions: { dashboard: true, warehouses: true, warehouseIssueReceive: false, production: true, approvals: true, approveFinancial: true, approveExecutive: false, approveWarehouse: false, salesAccounting: true, clientsSuppliers: true, reports: true, settingsUsers: false } },
      { id: 'u-5', code: 'USR-05', name: 'المدير الإداري', roleKey: 'admin_manager', roleTitle: 'المدير الإداري وشؤون التشغيل', pin: '5555', avatarColor: '#7c3aed', active: true, permissions: { dashboard: true, warehouses: true, warehouseIssueReceive: false, production: true, approvals: true, approveFinancial: false, approveExecutive: false, approveWarehouse: true, salesAccounting: false, clientsSuppliers: true, reports: true, settingsUsers: false } },
      { id: 'u-6', code: 'USR-06', name: 'أمين المخزن', roleKey: 'warehouse_keeper', roleTitle: 'أمين المخازن والرصيد والاستلام', pin: '6666', avatarColor: '#ea580c', active: true, permissions: { dashboard: true, warehouses: true, warehouseIssueReceive: true, production: true, approvals: true, approveFinancial: false, approveExecutive: false, approveWarehouse: true, salesAccounting: false, clientsSuppliers: false, reports: true, settingsUsers: false } },
      { id: 'u-7', code: 'USR-07', name: 'مدير التشغيل', roleKey: 'operations_manager', roleTitle: 'مدير التشغيل وخطوط تقشير القشرة', pin: '7777', avatarColor: '#0284c7', active: true, permissions: { dashboard: true, warehouses: true, warehouseIssueReceive: true, production: true, approvals: true, approveFinancial: false, approveExecutive: false, approveWarehouse: false, salesAccounting: false, clientsSuppliers: false, reports: true, settingsUsers: false } },
      { id: 'u-8', code: 'USR-08', name: 'مستخدم احتياطي', roleKey: 'reserve_user', roleTitle: 'حساب احتياطي / طوارئ وجرد', pin: '8888', avatarColor: '#64748b', active: true, permissions: { dashboard: true, warehouses: true, warehouseIssueReceive: true, production: true, approvals: true, approveFinancial: false, approveExecutive: false, approveWarehouse: false, salesAccounting: false, clientsSuppliers: false, reports: true, settingsUsers: false } }
    ],
    pallets: [], rawMaterials: [], scrapItems: [], spareParts: [], productionOrders: [],
    approvalRequests: [], warehouseMovements: [], salesReturns: [], partners: [], palletMovements: [], financialTransactions: [],
    treasuryBalances: { cashVault: 0, bankAccount: 0, checksUnderCollection: 0 },
    auditLogs: [], chatMessages: [], deletedIds: []
  };
}

// Persistence & Real-time Cloud Sync across all 8 users (Works via Server, Tunnel, Firebase Cloud, or Offline!)
async function fetchRemoteState() {
  let localData = null;
  let fbData = null;
  const isLocalHost = location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.hostname.startsWith('192.168.');

  if (isLocalHost) {
    try {
      const res = await fetch('/api/data', { cache: 'no-store' });
      if (res.ok) localData = await res.json();
    } catch (_) {}
  }

  try {
    const fbRes = await fetch(FIREBASE_CLOUD_URL, { cache: 'no-store' });
    if (fbRes.ok) {
      const parsed = await fbRes.json();
      if (parsed && parsed.users) fbData = parsed;
    }
  } catch (_) {}

  if (localData && fbData) {
    return smartMergeClientState(localData, fbData);
  }
  if (fbData) return normalizeState(fbData);
  if (localData) return normalizeState(localData);
  throw new Error('Offline');
}

async function loadData() {
  refreshServerUrls();
  const cached = localStorage.getItem(STORAGE_KEY);
  if (cached) {
    try {
      state = normalizeState(JSON.parse(cached));
    } catch (_) {}
  }

  try {
    const remote = await fetchRemoteState();
    if (remote && remote.users) {
      state = state && state.users ? smartMergeClientState(state, remote) : normalizeState(remote);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      isOnline = true;
    }
  } catch (_) {
    isOnline = false;
  }

  state = normalizeState(state);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));

  if (state && state.users) {
    // Ensure CEO and Projects Manager always have full permissions, and Warehouse Keeper never sees financial accounting
    for (const u of state.users) {
      if (u.roleKey === 'ceo' || u.roleKey === 'projects_manager') {
        u.permissions = {
          dashboard: true,
          warehouses: true,
          warehouseIssueReceive: true,
          production: true,
          approvals: true,
          approveFinancial: true,
          approveExecutive: true,
          approveWarehouse: true,
          salesAccounting: true,
          clientsSuppliers: true,
          reports: true,
          settingsUsers: true
        };
      } else if (u.roleKey === 'warehouse_keeper') {
        u.permissions = u.permissions || {};
        u.permissions.production = true;
        u.permissions.approvals = true;
        u.permissions.salesAccounting = false;
        u.permissions.approveFinancial = false;
      } else if (['accountant', 'accounts_manager', 'accounting_manager', 'admin_manager'].includes(u.roleKey)) {
        u.permissions = u.permissions || {};
        u.permissions.production = true;
        u.permissions.approvals = true;
      }
    }
    const savedUserId = localStorage.getItem(SESSION_USER_KEY);
    if (savedUserId) {
      currentUser = state.users.find(u => u.id === savedUserId) || null;
    }
    if (currentUser) {
      markNotifIdsSeen([
        ...(state.auditLogs || []).map(l => l.id),
        ...(state.chatMessages || []).map(c => c.id),
        ...(state.productionOrders || []).map(o => `ord_stage_${o.id}_${o.stage || o.status}`),
        ...(state.salesReturns || []).map(r => `ret_status_${r.id}_${r.status || 'pending_approval'}`)
      ]);
    }
  }
  render();
}

// Track user touch/pointer/keyboard interactions so background polling NEVER destroys a DOM button mid-tap on mobile!
window._lastUserInteractionAt = 0;
window._isSavingState = false;
window._pendingPollRenderTimer = null;

function markUserInteraction() {
  window._lastUserInteractionAt = Date.now();
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  ['touchstart', 'touchend', 'pointerdown', 'mousedown', 'keydown', 'input'].forEach(evtName => {
    window.addEventListener(evtName, markUserInteraction, { passive: true });
  });
}

function isSafeToAutoRenderFromPoll() {
  if (window._isPrintingActive || window._isSavingState) return false;
  const modalOpen = (document.getElementById('modal-root')?.innerHTML || '').trim() !== '';
  if (modalOpen || sidebarOpen) return false;
  const activeTag = document.activeElement?.tagName;
  if (activeTag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'SELECT') return false;
  if (Date.now() - (window._lastUserInteractionAt || 0) < 3500) return false;
  return true;
}

// Live Polling (every 2.5s) so any order preparation, approval, warehouse update, or chat triggers immediate long sound alert for authorized users
setInterval(async () => {
  if (window._isSavingState || window._isPrintingActive) return;
  try {
    const fresh = await fetchRemoteState();
    if (window._isSavingState) return;
    if (fresh && fresh.users) {
      const mergedFresh = state && state.users ? smartMergeClientState(state, fresh) : fresh;
      const oldJson = JSON.stringify(state);
      const newJson = JSON.stringify(mergedFresh);
      if (oldJson !== newJson) {
        const prevLogs = state?.auditLogs || [];
        const prevChats = state?.chatMessages || [];
        const prevOrders = state?.productionOrders || [];
        const prevReturns = state?.salesReturns || [];
        state = mergedFresh;
        localStorage.setItem(STORAGE_KEY, newJson);
        if (currentUser) {
          currentUser = state.users.find(u => u.id === currentUser.id) || currentUser;
          checkIncomingNotifications(prevLogs, state.auditLogs || [], prevChats, state.chatMessages || [], prevOrders, state.productionOrders || [], prevReturns, state.salesReturns || []);
        }
        if (isSafeToAutoRenderFromPoll()) {
          render();
        } else if (!window._isPrintingActive) {
          renderLiveBannerDOM();
          if (window._pendingPollRenderTimer) clearTimeout(window._pendingPollRenderTimer);
          window._pendingPollRenderTimer = setTimeout(() => {
            if (isSafeToAutoRenderFromPoll()) render();
          }, 3600);
        }
      }
      isOnline = true;
      updateSyncIndicator();
    }
  } catch (_) {
    isOnline = false;
    updateSyncIndicator();
  }
}, 2500);

async function saveState(logMessage = '', hiddenFromRoles = []) {
  if (!state) return;
  window._isSavingState = true;
  try {
    if (logMessage) addAuditLog(logMessage, null, null, 'all', hiddenFromRoles);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    if (currentUser) {
      currentUser = state.users.find(u => u.id === currentUser.id) || currentUser;
    }
    render();
    let synced = false;
    const isLocalHost = location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.hostname.startsWith('192.168.');

    if (isLocalHost) {
      try {
        const res = await fetch('/api/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(state)
        });
        if (res.ok) {
          const merged = await res.json();
          state = merged;
          localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
          synced = true;
        }
      } catch (_) {}
    }

    try {
      // Also sync directly with Firebase Cloud Database so Factory & Administration devices anywhere stay 100% in sync
      try {
        const curFbRes = await fetch(FIREBASE_CLOUD_URL, { cache: 'no-store' });
        if (curFbRes.ok) {
          const curFb = await curFbRes.json();
          if (curFb && curFb.users) {
            state = smartMergeClientState(curFb, state);
            localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
          }
        }
      } catch (_) {}

      const fbRes = await fetch(FIREBASE_CLOUD_URL, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state)
      });
      if (fbRes.ok) synced = true;
    } catch (_) {}

    isOnline = synced;
    updateSyncIndicator();
  } finally {
    window._isSavingState = false;
  }
}

function updateSyncIndicator() {
  const pill = document.getElementById('sync-status-pill');
  if (!pill) return;
  if (isOnline) {
    pill.className = 'sync-pill';
    pill.innerHTML = '● متصل ومتزامن لحظياً مع جميع المستخدمين';
  } else {
    pill.className = 'sync-pill offline';
    pill.innerHTML = '● وضع أوفلاين (حفظ محلي تلقائي)';
  }
}

window.addEventListener('online', () => { isOnline = true; saveState(); });
window.addEventListener('offline', () => { isOnline = false; updateSyncIndicator(); });

// 1-Click Install & Mobile QR Code Modal
async function triggerOneClickInstall() {
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    const choice = await deferredInstallPrompt.userChoice;
    if (choice.outcome === 'accepted') {
      deferredInstallPrompt = null;
      render();
    }
  } else {
    openMobileInstallModal();
  }
}

function copyLinkToClipboard(urlText) {
  navigator.clipboard?.writeText(urlText);
  alert(`✅ تم نسخ الرابط بنجاح:\n${urlText}\nيمكنك إرساله الآن على واتساب لأي مستخدم!`);
}

async function openMobileInstallModal() {
  await refreshServerUrls();
  const modalRoot = document.getElementById('modal-root');
  const shareUrl = PERMANENT_CLOUD_URL;
  const lanUrl = liveServerUrls.lanUrl || 'http://192.168.1.3:8090';
  const qrImgUrl = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(shareUrl)}`;
  const whatsappUrl = `https://wa.me/?text=${encodeURIComponent('🏭 الرابط الرسمي الدائم لنظام مصنع العاصمة للصناعات المتخصصة (يعمل من أي مكان في المصنع أو الإدارة على أي موبايل أو كمبيوتر 24 ساعة):\n' + shareUrl)}`;

  modalRoot.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal-box" style="max-width:560px;text-align:center;">
        <div class="card-header">
          <div class="card-title">📲 أسهل طريقة لفتح وتثبيت التطبيق على الموبايلات</div>
          <button class="btn btn-sm btn-outline" onclick="closeModal()">✕</button>
        </div>

        <div style="background:var(--bg-elevated);padding:16px;border-radius:14px;margin-bottom:14px;">
          <div style="font-weight:800;font-size:1rem;color:var(--primary);margin-bottom:8px;">
            1️⃣ افتح كاميرا الموبايل ووجّهها على الكود (QR Code) هيفتح التطبيق فوراً:
          </div>
          <div style="background:#fff;padding:12px;border-radius:12px;display:inline-block;border:2px solid var(--primary);">
            <img src="${qrImgUrl}" alt="QR Code" style="width:190px;height:190px;display:block;" onerror="this.style.display='none'" />
          </div>
          <div style="margin-top:10px;font-size:0.86rem;">
            <div style="margin-bottom:4px;"><strong>🌍 الرابط السحابي المباشر (من أي مكان 4G/5G أو Wi-Fi):</strong></div>
            <a href="${shareUrl}" target="_blank" style="direction:ltr;display:inline-block;font-weight:800;color:var(--accent);word-break:break-all;">${shareUrl}</a>
            <div style="margin-top:6px;"><strong>📶 رابط شبكة الواي فاي الداخلية (بدون إنترنت):</strong></div>
            <a href="${lanUrl}" target="_blank" style="direction:ltr;display:inline-block;font-weight:800;color:var(--primary);">${lanUrl}</a>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px;">
          <a href="${whatsappUrl}" target="_blank" class="btn btn-success" style="justify-content:center;text-decoration:none;padding:12px;">
            💬 إرسال الرابط على واتساب
          </a>
          <button type="button" class="btn btn-primary" style="justify-content:center;padding:12px;" onclick="copyLinkToClipboard('${shareUrl}')">
            📋 نسخ الرابط المباشر
          </button>
        </div>

        ${deferredInstallPrompt ? `
          <button type="button" class="btn btn-accent" style="width:100%;justify-content:center;padding:13px;font-size:1rem;margin-bottom:12px;" onclick="triggerOneClickInstall()">
            📲 تثبيت التطبيق الآن على هذا الجهاز بضغطة واحدة
          </button>
        ` : ''}

        <div style="text-align:right;font-size:0.84rem;background:rgba(16,185,129,0.08);border:1px solid rgba(16,185,129,0.3);padding:12px;border-radius:10px;line-height:1.7;">
          <strong>✨ كيف يتثبت بأيقونة على الموبايل في ثانية واحدة؟</strong><br/>
          • بعد فتح الرابط على الموبايل، ستظهر لك رسالة تلقائية <strong>"تثبيت تطبيق مصنع العاصمة"</strong> اضغط <strong>تثبيت (Install)</strong>.<br/>
          • أو على آيفون (Safari): اضغط زر <strong>مشاركة ⬆️</strong> ثم <strong>إضافة للشاشة الرئيسية</strong>.
        </div>
      </div>
    </div>
  `;
}

// Theme Management
function initTheme() {
  const savedTheme = localStorage.getItem(THEME_KEY) || 'light';
  document.documentElement.setAttribute('data-theme', savedTheme);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'light';
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem(THEME_KEY, next);
  render();
}

// Permission Check: CEO and Projects Manager have FULL permissions; no other user can edit permissions
function isFullAdmin(user) {
  return Boolean(user && (user.roleKey === 'ceo' || user.roleKey === 'projects_manager'));
}

function hasPerm(permKey) {
  if (!currentUser) return false;
  if (isFullAdmin(currentUser)) return true;
  if (permKey === 'settingsUsers') return false;
  return Boolean(currentUser.permissions && currentUser.permissions[permKey]);
}

// Login & Logout
function selectLoginUser(userId) {
  selectedLoginUserId = userId;
  render();
  const pinInput = document.getElementById('login-pin-input');
  if (pinInput) {
    pinInput.value = '';
    pinInput.focus();
  }
}

function handleLoginSubmit(e) {
  if (e) e.preventDefault();
  const pinInput = document.getElementById('login-pin-input');
  const pinVal = pinInput ? pinInput.value.trim() : '';
  const user = state.users.find(u => u.id === selectedLoginUserId);
  if (!user) return;
  if (pinVal !== user.pin) {
    alert('⛔ الباسورد / كود الدخول (PIN) غير صحيح لهذا المستخدم!');
    return;
  }
  currentUser = user;
  localStorage.setItem(SESSION_USER_KEY, user.id);
  activeTab = 'dashboard';
  addAuditLog(`تسجيل دخول إلى النظام بواسطة: ${user.name}`);
  saveState();
}

function quickSwitchUser(userId) {
  const user = state.users.find(u => u.id === userId);
  if (!user) return;
  if (currentUser && user.id === currentUser.id) return;
  if (isFullAdmin(currentUser)) {
    currentUser = user;
    sidebarOpen = false;
    localStorage.setItem(SESSION_USER_KEY, user.id);
    render();
    return;
  }
  openQuickSwitchUserModal(user.id);
  render();
}

function openQuickSwitchUserModal(targetUserId) {
  const user = (state?.users || []).find(u => u.id === targetUserId);
  if (!user) return;
  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot) return;
  modalRoot.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal-box" style="max-width:440px;text-align:center;">
        <div class="card-header">
          <div class="card-title">🔒 تبديل الحساب إلى (${user.name})</div>
          <button type="button" class="btn btn-sm btn-outline" onclick="closeModal()">✕</button>
        </div>
        <form onsubmit="submitQuickSwitchUserModal(event, '${user.id}')">
          <div class="form-group" style="margin-bottom:14px;">
            <label style="font-size:0.86rem;font-weight:800;margin-bottom:6px;">أدخل الباسورد / كود الدخول (PIN) الخاص بحساب (${user.name}):</label>
            <input id="quick-switch-pin-input" type="password" inputmode="numeric" class="form-control" style="text-align:center;font-size:1.15rem;letter-spacing:3px;font-weight:800;padding:12px;" placeholder="••••" required autofocus />
          </div>
          <div style="display:flex;justify-content:center;gap:10px;">
            <button type="button" class="btn btn-outline" onclick="closeModal()">إلغاء</button>
            <button type="submit" class="btn btn-primary" style="padding:10px 22px;">✅ دخول كـ (${user.name})</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function submitQuickSwitchUserModal(e, targetUserId) {
  e.preventDefault();
  const user = (state?.users || []).find(u => u.id === targetUserId);
  if (!user) return;
  const enteredPin = (document.getElementById('quick-switch-pin-input')?.value || '').trim();
  if (enteredPin !== String(user.pin || '').trim()) {
    alert('⛔ الباسورد غير صحيح!');
    return;
  }
  currentUser = user;
  sidebarOpen = false;
  localStorage.setItem(SESSION_USER_KEY, user.id);
  closeModal();
  render();
}

function logout() {
  localStorage.removeItem(SESSION_USER_KEY);
  currentUser = null;
  sidebarOpen = false;
  render();
}

// Navigation
function setTab(tabName) {
  activeTab = tabName;
  sidebarOpen = false;
  render();
  try {
    if (typeof window !== 'undefined' && typeof window.scrollTo === 'function') {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  } catch (_) {}
}

const DEFAULT_FACTORY_LOGO_DATA_URL = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAgMDAwMDBAcFBAQEBAkGBwUHCgkLCwoJCgoMDREODAwQDAoKDhQPEBESExMTCw4UFhQSFhESExL/2wBDAQMDAwQEBAgFBQgSDAoMEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhL/wAARCAEEAMUDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD9U6KKKACiiigAoorlPiV8UvC3wh8Lz+IPiJrFpo2lwceZM2WlftHGgy0jnsqgmk3bcaV9EdXSV+a3xW/4Kj+JfEWqSaT+z/4WWzidisOoarAbu7nGeGS2Q7UH+8W9wK8kvPiN+1J40lN1feL/ABRp/mHcI11KHTVB9BHHtIH1FebiM2wtD45pHo4fKcVW+GJ+wlFfjJqniv8AaZ0yEvN4y+IF3EoyxsvELTn/AL5V935CuCl/aK+L32k2958TPHdvKj7JBca1cRmI553jOQB9KmlnGHqq9N39Gi6mUYim7T09bn7sfnRX4zQ/8NB39lHd2fxG129trhBJFLB4wldZVPRlIPNV7W1+POqJJ5fj/Xi0Z/eRt4tuFZT7jNcz4iwK3mvvR0Lh7GtXUX9zP2hor8WrzQfjxaxGW58ceICi/eZfFly233OD0qaHw38dbiFZIPHusvGwyrr4vuSD+tT/AKy4H+dfeg/1dx38r+5n7QUV+LE2ifHCzlWK58e65D5h+V28XXQQnvznFbGmX/7SPgcm58O+OPEt1tYN5MXiL7WHI/6Zz5DfTFOPEeBbtzr70EuHsalfkf3M/Y6lr8y/hf8A8FOPG/gnV49I/aD8NLqtsjbZryztvsN/EM8sYTiOUAf3dmfU1+gvwu+LXhT4zeFYPEPw51i21fTZflcplZLeTHMcsZw0bj+6wHr05r2KOIp1leDPJrYepRdpo6+iiitzAKKKKACiiigAooooAKKKKACiiigDgfjh8Z9A+Avw71Lxd4ykb7NZgJbWsZHm31w2fLgjB/iYjr0ABY8A1+S+ta346/bK+IN14p8f30llolpKYoY4smCwj6/ZrVDwXxjc5+rZ4Wu+/bW+KF9+0l+0lF4H8N3LDw74QuZNPt2X5kM6/wDH5dEdDt2mNfZP9o1062tr4N0Gw0nw3bKgjUW9jb9ST1Z29Tklie5NfE8TZ7LDr2NL4n/V/wDI+y4cyWNb99V2X9f8OU9D0fQvh3ax6Z4R0xVupV/1MPzTzH+9NKeenrx6AVfW01a8+e+vhYq3IgsowSPq7Zz+FEUVt4ZsXnuGae6nYGR+rzyHoq98f/rqE2N5qR361cPArci0t5CoUejN1J/SvziU5TlzSd2+rP0GEIwjyxVkT/2PeMCbTWr9ZO3mhJR+IwDXGfELwfZeLrYw+PLKOO4xttNe09P3sJ7Bh/Gvqh/DB5rpJPDumqwUeZazE/K63BVs+wJ5qe2mls5hpfiAi5guQVhuJF+9/sN7+/0rWlUnRkpwev3E1acKsXCaujwHwH4u1T4IeMH8N+LpRJoN46szxnfEgf7l3Cf7hx8w9jn5lr6K1bSPtm24sHEF9EMxzKeJB2BPcEd/6V5F8cPBIuvDNy8a+ZNoam6s3I+Zrcn99H+H3/qh/vGun/Z/8WP4m+HsEF3IJLvQpTZOznJaMAGIn1+U7f8AgFermMY4nDRxsNJbS/zPLwTlhsQ8LJ3jvH07HcaPqg1G3ImUw3cHyzQ9Np9QPSq93C2gyNeWIJs3Obu3Xouf41Hb3H+RHrSjTNStNThBVXcQ3OP4gehP4A/kK3JMNuWQK4wQwPfP9K8FtKz6M9gikiiv7XDBJredQ3PQjsRWPbvJod+lncsZLC5OLeRusbf3D7f59an0HdZXF7pkhLLaNvgJ6lG5x/n1NWtY09dS06aEnLFS0ZP8LDpj+X40XtK3QZneMNB0vxFpf2TxRYRX9h0bfxJb/wC3G33lI7kfrXjui694z/Y5+JFn4p+Hd9LeaJeuEkimb9xqMQ5NtcqOA4GSsg+o/iWvbtHul1LSYmn/AHhZTHNnqSODn+f41kyaHaeJdE1XwxrwMlsV8vf1ZFPKOvoysAQa9fKc1rYKpv7vVfqjyszyuljKbTXvd/8AM/Rn4O/FnQ/jd8PdJ8X+Dpi9jqcfzwuR5lrMvEkMgHR0bIPrwRwRXa1+YH/BNX4nah8O/jX4g+FXiKY/ZNe854Iyflj1C2B3MvoJIVJ9/LSv0+XpX7Hhq6rU1NdT8lxNF0ajgxaKKK3MAooooAKKKKACiiigArivjT48X4Y/CXxf4qYgPoWj3F1DnoZVQ+WPxcqPxrta+aP+CiustpH7J/iqNGZTqdzZWZwOoa5jJH5KaipLlg2XTjzTSPzy/Zf0N7iTX/El+fNu5HWzWZuSzt+9mfPuSn617PYr9v1q9u3XK2mLWAdgerkfyrjf2dLNLX4W2EmBuury5mbHf95tH6IK7Pwr82lBhjM1xI75781+J5xWdTGVZPo7fdofsWVUlTwkF3V/vIbcHVPEVzcSENDpY8qAY4Eh+8317flXmPx2+LN34TaLw/4Vcw6teRiS4ulG5raNjhFQY/1jYznsMY5PHp3hNTJps75+aS6kJI9eK+dfEMf2/wDaWuIrz5lGqqse7/ZgBjH5gVvk9CnUxEpTV1BXsRmtapClGEHZyaV+xkwfBvxBrMbXmsahbQ3svzmO7d5pM/7b84P54rd+Gfi7WtJ19vBPiqSWZTIUtPOk3va3Cgsqq5+9G6g4HYlSO9emX9xZ6UyHWNQsbESbjGbq4WPcF+9jJGcZGceteZeH4R8QPjYdW8Oo8uk6PLFLLdlSquIowqn6u44HXbz2r16eLniqNRV4rkSbTts+ljz6uEp4SrTdBvnbSavuutz33U4V1rQ/9IXJnt3WT0IeMhv6mvG/2TrgpdeJbckshtbSXGf4g0i5/I16p4y1yPwv4E1e/d1RrWwdIwf4pXXYgHvuYV53+ynozWek6/qcn+ruJ4bSJj/F5almI/GRa8zDrlyvEN7NpL1udmK97MaKW6T+49h8V4/sC5LZJUoVx2O4VqQ5aGIsfmMabsnvgdayPETG7+yaegJkupgW/wBlF6n/AD6VrblUDoAv8WeAK8Fr3UeuZQA/4S2Xy+P9DG/B6cjH9K2VxuBIOMjv/SsTQy19cXmosMC5fZEG/uL0P06flV7VL5dPsZ5ckMq4jGPvMen+P4USWqQGf4XH+h3QXhPtcgHPAHFOjXy/Fj4/5a2Q3DtkEf4Va0OzNhpcEZGHYb2HU7jyRVbT8XWvX90vMUCrbxn1I5OPyqm9WM8vs7p/CH7bHgLUtPG2S51rSpHGcZ81vIcfiufzr9j6/HXwvYv8Qv24vBemaaDKNO1yxSVo+dq2o8+Y+ny7WH4V+xNfsfDqksDDm7L8j8jz9xeNny93+YtFFFe6eKFFFFABRRRQAUUUUAFfK/8AwUstZLn9lXVniBIttX0+WT2XzgufzYV9UV4T+3J4fPiT9lP4h28cfmS2umrex+xglSUn/vlDWVZXpyXkaUXapF+Z8IfABhL8KND6YRp0bPbE75/nXU+F2CWMkTDJtrqRSM8gZyK89/Zn1IXXw5mtSQWsNSlUj0DhXH/oRrvrRv7P8RXdvgBL5RPH3+buP5/lX4hmUXHF1o+d/wCvvP2XL5c2FptdkL4f/wBFuNRsj96G4Lgf7Lf/AKh+deF/tHeGLrw/4q07xno+FSdoknZefJuYseWx9mUAfVSO4r3LV86XqVvqUYPksPKusc8Ho3v6fgKk8VaXFrugzwPDFdxSIS0LrvWVCORjvxgj6CngMW8NiFV3T0Y8bhfrNFwvZ7r1POPDPjLw18StKiS/g0yS5XDT6ZfKjtHJ3ZA33h6Mv48101xq2jeEdL/0iTTNF0+H5ljVUgTOOoUdT9ASa8m1r9n2w1SMXXhPVPsS5+e0vkMoib0WRfmx3GQT71xV78FfENrdCLfpc7/wN9qKhvYFlHNe1HCYGtL3a7Uf5X/X+Z5rxWOox96hzS7o3PHXja/+Mmv2PhvwXbzNYrNuiEgKm4ccGeQfwRqCcZ6ZJPJAH0N4P8PW/gfwvY6NppMyWUZ3yYAM0jHLv7bmJ/DA7V8y6X8PvHvh5pToc/8AZ73ACy/ZdTWIyAcgEg5xmr66P8UVYIdb1ENJ3bXCM/r+ldGNwtGtTjRpVoxgvxfdnNhK9enUlWq0ZSnLy2XkfT1hautxJdXXzXUwA+XkRoOiD+p71FfCXVGNpZ5jgY/6RN7d0X1Pr2r5tj8P/Fbaf+J7qAUdjrx6/nUUei/E+R2iXX9QEifwNrjAjHoM15n9j09/rET0P7Srf8+JH1MsS28IihjKRoNqrjoB0qkLKW+vEnv1KxQHMEJ/V2Hr7V81/wDCL/FNjg6/ej66+/8AjUXw70H4k/Ez4lQeA9B8TXtt4huGnjij1DWpYI3kiUuyBxnLFVYgY5xWtDh/20rUqyb8jCtnTox5qtFpeZ9Q3v2plENjExlkGPMKnbGP73ufYVw/xD+JWm/CnRWtbV47rXXjP2OzLZKsf+W0wH3VB555bgDuRqr/AME//wBpCY4n8Raaqnru8VXB/klevfA3/gl1p2i6pBrXx71uLxLNHIJf7F0/etrI/X9/M2HlHqoCg98jivXwfB1RVE6rul/Wp5OK4sp+zapKzMv/AIJjfs/6gt1qPxh8aRSq+pQyWvh7z1+eZZGzcXf0YjYp7jeehGf0LrLu9R0fwjpcX2+503RdNtYxHH50qW0MSKAAoyQoAGAB2rM8GfE7wn8RZNSTwH4i0nxB/ZEqxXzaddLOsDsCVVmUkZIBPWv0OjSjSgoI+CrVZVZuTOnooorUyCiiigAooooAKKKKACsnxZ4fg8W+FtY0O+x9n1jT57ObIz8ssZQ/o1a1JQwPxR/Z/vLjwT4o8WeFdaRormzkxLG3VZbaUwy/owP/AAGvdtcs3uYI7mz/AOPqzbzI8fxjuPf6f41yP7bHgs/Aj9rpfFcUJ/sHxgRqrKv8RceVex/XJ8z/ALaCuq0u8FrMunzyhwVDWNx2niPK4PrjFfkfFGDdDGc66/p/wLH6rw3ilWwnL1X6/wDBuXLa6tta04sqiWGZSsiH+E9wf6fhWRY3cvh27Gnaq/8Aoz82t0emP7p9P6fSrGoafPpV09/pKh42P+lWo6N/tL/n9KuxyWXiDT8YSaFvvKeGQ/0NfNaLbZn0Bh69octncPf6Km7eM3Fr2ceq/wA/5VzUyw6tG2wbj/HG3DIf8966/wAm/wDDq4j36hpy87f44R/h+n0qO50fT/EUf2myby5x/wAtIxhlP+0P8/Wt6dTl3+8DgZBeaTxIr3Vt1Bx86fU96tIIdQt/lPmRsRtKnlT/AENbzQz6fcLb6yoAbiK6UfK/sfQ/596qaj4XktpDc6SAko5eLHEo+nrXR7VMVjEjvJLOYW18wZZOIZ+zex96s3VgLxR8xSZD+7kXgr/9arq2cGs2J+U7W4YfxRtVezmTT4Lpdamjgj09PMluJW2qI/7xJ/D65FVzX23BtRV3sR6bdNcb4Lpdt1Bw3+0Oxrzrxlq03w0+NXhXxjo7qt7p91a38kasNweCQbgwHI3R4HPXmqvir4pXviPWIrD4b210srkwpdRxkz3Of7i4+Qe55x/droPCX7NdxeYvPH2oSQyTHfJaWrB5Se4klOefpn619HgMN9QksTiJ8t/s7tn5xxPxfgY03h6fvPv/AJd/wR9U/Ef/AIKvaVbNJa/CXwXealIWxHfa5cC3jPuIY9zt+LLXh+v/ALWf7SnxcDjR7298P2En3V0XT109R/22kzJ+TV03h34feHPCoX+wdHs4JR/y3aPzJT7l2ya3orhLqNZYZFmjf7rq24HtwfwrtxPF05fwoaef/A/zPyqrnc38ET5f+Inw28ZR6De+JfiVrzanNE8Y8u61CW9lkZ2C/ebgYJz36V96/wDBKfwz/ZvwS8S6yybTrXiR0Tj7yQQxrn6bmf8AI18lftN60tn4P0/TtyhtQvPNcdxHEuc/Tcy1+kf7GXgdvh/+zL4D024j8q6udNGoXI7+ZcsZjn3AkA/Cve4fxNbFUfbVd3e39feenldWpWhzzPaqKKK+iPVCiiigAooooAKKKKACiiigD5o/b8+BMnxo+Bt3daHbG48SeDWbVNNVFy88YXFxAB3LxjIHdkSvg/4D+Krbxx4K/sLVJCdQ0BVEEgPztbn/AFbjPPyn5D/wD1r9h6/J/wDbL+Buofsv/Gi38ffD+02+EfEl08sMSjEVrcvkz2b46RuNzp6cgfcFfOcRZX9cw94/Etv6/A+h4fzP6pXSlszfj1W40iRLbXAWj6R3i85/3/f9fr1qW60ch/t2hyLBcMu7aMeXMD69v6fzpvh3xFpvjbw/bajpJFxYXy/NHJyY2H3o39GU8H8COCKrSRzeGpPOsy0+m7syRHrF7j2/yfWvyRxlGTi1aSP1OMoyipR1TNHTNYF4/kXEb217FkvC3fHce3tUOpaO8cxvtE/dXiffjH3Jh3BHTP8An3p+oWcOtWsc9pIEnQBre4Xj8Pp/LmpNH1Jr23dLtTFd2zbJoz3Pr9DUecRkFvJb+ItOZZE+V/kljzzG3+eQap6XvhuJdMvm3y2wDROf+WkZ6H8P89Ksagv9k6vDer8ttesIbnHQMT8r/X/D3o8SR/ZBa6jGvz2ku2T3jbgg/wCe9Un06MDG1j7N4bv5NSupY7fTZo2a7dvuxFeS3/1vc14JrOraz8c/F66b4btzb6fEd0ccnAjjB5mnI6t6DtnA5ya6X9oLxdPrmvWng3QSZ/Lmja5WPrNcPjy4h7KGDH3Yf3a9b+G/gO1+HvhuKwgEb3suJL64UczS/X+6vQD8e9fU4SMcvwscTUV6s/hXZd/6/wAz8l454olGTwlB6Lfzf+S/MTwD8N9I+Hth5Wkx+deyri5v5VHmTew/ur/sj8c101xcRWdvJPdyxwQQqXklkYKqKOpJPQVm+JvFOmeD9KfUPEFytvbrwi9Xlb+6i9WavFY5fEn7QmrFG8zRvBlpN+8VW5lx2J/jk/8AHV+vXmo4ari3KvWlaC3k/wAl3Z+UwpTrN1Juy6s7GHxVd/FzV7jTPC5mtPCdk+zU9T5SS+/6Ywnqqnu3XHpkZ9MggjtYY4baNIoYUCRxouFRQMAAegFVtH0ey8P6Zb6do1ulrZ2q7Y4k7epJ7knknvWT4/8AGEPgbwre6rMUM6Lss4mP+tnb7ij+Z9gawqy9vUjSoxtHZL9X5/kZy/eSUKa06Hlet6BJ8ef2k/DPgbTWaS2e+h0+Zk+YLHnzLt/+AorDP+zX7N2lrFY2sNvZxrFBBGscUa9EVRgAe2AK/PD/AIJc/Bee+1LxB8WPEkTPnzNM0WSQf6yRjuu5x+O2MH/roK/RWv1fLcMsPh4010PtcHRVGiooKKKK7zqCiiigAooooAKKKKACkzXzP+1v+294b/ZogGkafBH4j8cXcPmQaSk22OzQj5ZblxyoPUIPmYeg+avy9+LH7XXxX+Ml1M3izxfqdvYStldL0qVrK0Qf3diEFx7uWPvXBicxpUXy7s+tyPg3MM0gqqtCm+r6+i/4ZH7e6r488NaFIY9c8RaFp0g6rdajFER+DMK47x5N8MPjf4N1Pwh4k8Q+GNZ0vWIfKkit9YgaRG6pJGQxKyKwDKexAr8EH/eSF5Pndjks3JP40nlr/dX8q895zf7GnqfXx8Mopf7y7/4f+CfUnj7wL4x/Yp+J0uma0r6t4W1hzJZ3afLDq0A6Oh6R3CKQCv8ANSDXr3h7xHpvjDR49Q0C5S7s5wQT0ZTjlHXqrDPIP6ivnT4F/tF23hPRbrwB8aNNn8Y/C3W5A1zYNJm60iboLuycnKOvUqCA3PTJz2PjD4MeJvghZJ8RvgXryeOvhlqPK61Yp5giQH/UahAOY3XIG/Awf7h4r5/NMmpZhF1qGk1/Wv8Amck4YzIaqoYn3qb2ktv+A/L7j1KxU6Pqcljz9lucy22f4T3X/Pp707VFGm6taahGCI5m8i4HqD0P+fSvPvD/AMbNC8bWdql00ei65byK6W9xKDHOe/lSdDn+62D9eteka9EbjRZwwYN5YkXPXjkV8NiMPWoVOWrGzPeoYilXjzU5XRZ1i1+2aVdRYxmNivsV5B/SsjX9chtfAd9qt9zFDp5mfd0LAdPqWAH41r2U5uLGF2HEkIz+I5rxz4060dP+EtlYIxD6pqIhP/XOMmQ/hkJV5fhniMTCl3a+7r+BhmWK+q4OpW/lX49PxOf/AGe/Dk3iTxdf+KtZPmtYsxVm533UuSW/4CpP/fQr1b4kfFTTPh3Z7ZgL3VZVzBYxvg47PIf4V/U9q8p0f4jw/C/4XaXp+h+VdeItY33cg+8tqshIRm9X2quF/E++z8MfgpcahdjxJ8TA9zc3L+fHY3B3M7HnfP8A0T8/SvrsbRpyryxGKdqcdIrq7fofzXirVK0q9d6dO7Mjwn4B174y6wPEfxAnnh0nP7mMZQzLn/VxL/BH/tdT2z1r6B0/T7XSbGGz0y3itbW3UJFDEuFQe1WB0AAAAGAAOgrA8XePNE8D2pm8Q3qRSEZjtY/nml/3UHP4nA968XE4utjZqEI6LaKPPq1qleSilp0SNm8vbfTrSa61CaO3trdC8ssjYVFHUk14VoegeIf2wPjNpnhPwUktvpMLFmuXT5bG1BAlu5R/eI4Ve5Kr3NJoem+Pv2vPG0Xhj4d6bLFpcMivcF2ItrJP+e13KBjOOVQZJPCgnmv1K/Zs/Zt8Ofs2+Cf7H8OZvdUvisusaxNGBLfTAccfwxrkhUBwBnqSSfsMgyF0P31b4vy/4J72WZa6b9pU3O+8BeB9J+G3g3R/C/hO3+y6Todmlrax9TtUcsx7sxyxPckmt+sLxV400XwZDZy+Jb+KxS/uVtoC/wDE7fToB3PQd621YMoIII9a+ujOHM4J6o9xSjey3Q6ikrF8VeM9E8F6eLzxRqVtp8DEhPMb5pCOyqOWP0FOc4wjzSdkhykoq72NuivFpv2svBMcxSOPXJkBx5i2YAPuAWB/Su18BfFvw38SJJ4vC93PJcWsYkmgmt3jZFJwCcjHX0NcdHM8HWnyU6ib7XMKeLoVJcsZps7Siiiu46Ary39pb43Wf7P/AMHdd8Y3iJPd2kYg0u1fOLm8k+WFDjnbn5m/2VavUT0r8y/+Ct/xGkuPEvgnwHazj7NZWkms3sSnrLIxihz9FSX/AL7rmxlb2NGU1ue3w5lizHMqWHl8Ld36LV/fsfBPifxLqnjLxFqOu+KL2fUdW1a5e5vLqZstLIxyT7DsB0AAA4FZlFFfHN3d2f0nCEYRUYqyQUVoaH4f1PxNqcOneG9Ov9W1C4OIbSxt3nlkx1wigk/lWh4u+H3ijwBcw2/jrw7rnh6a4UtCmp2ElsZQOu3eBu69qfLK17aEOvSU1TclzPpfX7jn69G+Cvx/8afAPX21L4f6mYre6+XUNLul82y1BMYKzRHg8cbhhh2Nec0U4TlCV4uzJxGGo4im6VaKlF9Gfb/g/wAEfBr9uDUpbLwHaz/CH4pSW0lzLpMcP2nR9S2AF2iUY2HnJVdpABO18E1zHjD9n39ob9nqOeFtJv8AXvD8Sti40tTqtpsHGdmPNiGP9la8F+AXjqb4Z/GvwT4ltZDENL1u2acjvAzhJl+hjZx+NfvV4n12Hwt4a1bWrwbrfSLGe8lAOMpEhcjP0Wvaw2HpZhTcasbv+uh+KcV4J5DjIvCyahJXWu1t1fsfjPo/7TElhD9i8R+HlE0K7P8ARbkxOD/tRyDI6+tcd8TviFZ+NrDQrbS4Ly3j0tJ2nW424MkhXldpORhe9e2R/wDBQy/8UR4+L3wo+G/jUOSfOuLHyZwp6DcwcZAOMgChv2nv2fbz97qP7NGmC4flxb6wEjz7AIAPyr16fhxiMLiFWpU9V2f/AAT4bF8dU8ZhJUJ1LX7rs/Q8L+G/irwx4MvDqniLS9Q1bUopAbNVMYit8fx/Mcl/0H1rv779qkOSmkeH08w8L9pvs8/7qrk/nXbf8Nb/AAW00L/wj/7M3hQMhypvb5JMEfWE11um/tY/EZvDra38H/2b/C+i6QiF11ay8Lz3KKOpYPGiAjPOeRxWtbgGtWqe0xEFfzlp+Z8lOvl1WXM5OT8kzyrQY/j18aHWH4f+FNbjtZiB59npptoVB9bmbAA+jCusl/ZR8IfCDGt/th/Ee0s7t/3i+FPDtwb3VLs9dryHlfqBj/bFecePv23PjT8RIpINW8a3umWcgKta6LGtguPQtGA5H1avD7ieS6uJJ7qSSaeVi0ksjFncnuzHkn619PlfAFGhZ1Gku0f8zjqZ3h6Kthqevdn1npX7fVz4B8aeG7b4O+FNO8E/C7QL3ddeH7aNZLjVYW+WSS4mPLS7SWXBOGC5Zq/WTRdas/EWj2OqaPOtzYalbR3NrMnSSKRQyMPYgg1/PLX7B/8ABOD4gSeNv2ZdLsr6cS3fhK+n0lstlvKUiSHPoBHIqj/drt4jyihh8PTqUY2S0Z1ZDmVWtWnTqyvfVHM/tS+JJ9Y+JkmmSMfsmh2yRRJ23yKHdvqcqP8AgNehfsu/Fi51hG8Ia/K009nAZdNnc5ZolwGiJ7lcgj2yO1cd+1Z4LuNK8aReI4kZrDWokjkkA4jnjXG0ntuUAj6GsH9mu3K/E6LU55BBY6JYXF1eTscJHHsK5Y+mW/Q1+ERr4nD59K/2pWf+H/gIcalanmT83+H/AAx9W/En4gWHw38L3GraofMcfu7W2DYa5mP3UHt3J7AE18MeLvF+q+Odcn1bxHcG4uZThVH3IE7Ig7KP16nmuj+MvxOn+J3ix7qNpE0ixLRabA3GEzzIR/ebAPsMCuD/ADJPAA71ycQZxLGVvZ03+7jt5vv/AJHPmePeIqcsX7q/HzLui6PeeItWtNM0aBri+vpRFBGvdj3PoAMknsAa+7PhZ8NrH4ZeF4dOsQkt3JiS/utvzXEuOT/ujoB2H1NcF+zj8G28G6b/AMJB4kg265qMeIYXHNnAecH0duCfQYHrXtw4r6bhvJvq1P29Ve/LbyX+bPYynAexh7Sa95/ghaKKK+qPZEr8Vf8Agoprsmt/tceMkkIKaXHZWUWOyrbRsf8Ax52r9qjX4XftqStN+1Z8TGfqNbZfwWNAP0FeTnD/AHKXmfoXhvTUs0qSfSD/ADR4nRRRXzR+3H6d/wDBI/wLYw+CfG3jGa3ifU7vVU0uG4ZQWjgiiSRlU9QGeUE+uxfSvoP9u/wLp/jj9lvxyupW8cs+h6edVsZSuWgmgIfcp7ZUOp9mNeTf8Emv+Te/EH/Y23H/AKTW9fQf7V3/ACbR8T/+xVv/AP0S1fV4eK+pJeR+AZxiKn+tEp31VSP4NH4L0UUV8ofv4MxQblOGXkH0NfuZ+0prk2n/ALH/AI2v97CaXwc6Fh1zLCEP/odfhlJ9w/Sv3J/aN0iXXP2N/GNpaqzSf8IYZVC9T5cKyH9ENfS8NW+sa7Xj+Z+ReLH+70bb2n+SPxMHGPalpOvI6Glr+gz+UTsvgvoGn+KvjB4H0XxEqvpeq+IrG1vUY4DxPOispPoQcfjX74W1rDZ20VvZxRwQQII4oolCpGqjAVQOAAABgV/PFZ3c+n3cF3YytBdWsqzQSr1jkQhlYe4IB/Cv3B/Zb/aC0z9on4Vafr9nJFHrdoi2uvWCsN1rdhfmOP7j43oe4OOoOPieL6FR+zqr4Vp6M+t4ZrU1z038T1Py4/bz8K6d4P8A2qvGtnoFtHZ2l01rfNDGu1RLPAjyEAdMuWb6k14BX6PftefsK/Ev43/HjWvF/gqTw0ukaha2cUQvtQeKXdFCqNlRGwAyOOa8a/4defGf/nt4M/8ABtJ/8Zr1suzfBxwlONSquZJX+483HZXipYmo4U3Zt2Pkav0b/wCCR+sM2m/EvSWPyRXOn3aj0LpMjf8Aotfyrx3/AIdefGf/AJ7eDP8AwbSf/Ga+pv2Df2U/Hv7N/iLxhc/EJ9Dez16ztY7f+zrxpm8yJ5CdwKLgYfrXLnuZYOvgJwhUTlpb70dOT4DFUcZGc4NLX8j3D9ozXk0Dwpp5vbKHUtNvtQFvf2UvAniKMTtbqjggMrDoQK8Y/wCEL/trwU2kfBW/tL+21Sfz9YjvrtLbUH2n91bshwpjQc5B+ZjmvUP2sv8AkRtK/wCwqv8A6Levlb+IHuOh7iv554hxvsswlCcbppeTV97Pz6/8Fn7plfBWCzzKI1JNwqJyXMu19mdmP2fvG8ZzqWn2OmQD71xe6lDHGo9SQxP6VveB9P8ADHgnxjodvb3Ft4t1+51CGFrlYyLHTwXAJjzzLJ1wx+UdeteYSM0v+uZ5Mf32J/nW/wDDv/koHhr/ALC1v/6MFeHh8TQjWh7GnZ3Wrd+vRWS/M3wXhZl2AjOvWqOo4ptK1le34n3svfinUg70tfr5+dhRRRQAjdK/Cr9s/wD5Oq+Jv/Yek/8AQFr91W6V+FX7Z/8AydV8Tf8AsPSf+gLXkZz/AAY+p+jeGv8AyMav+D9UeL0UUV82ftR+sv8AwSa/5N78Qf8AY2XH/pNb19B/tXf8m0fE/wD7FW//APRLV8+f8Emv+Te/EH/Y2XH/AKTW9fWPxQ8DxfEz4d+JPCV5dy2EHiPTJ7CS6iQO8KyoVLAHgkZ6V9bhU5YOKXY/nfPqkafEVWctlNP8Ufz00V+nQ/4JCeGf+ij+IP8AwVw//FUf8OhPDP8A0UfxB/4K4f8A4qvD/svE9vxP1b/X3I/+fj/8Bf8AkfmJJ9w/Sv6GtL0i31/4d2emakpez1LRY7a4UHBaOSEKw/Imvh9v+CQnhnBH/Cx/EHP/AFC4f/iq++tJsRpel2dkrmRbO3SEOwwWCKFyR+FerlmFq0HJz0vY+B45z/AZrGisNJvl5r3TW9u/ofgL8SPAl98MPH3iDwnrSMl54f1CW0bd/Gqt8jj1DIVYH0YVzlfpD/wU4/Zrm1W3i+Lng+1aWewhS18TQxKSzQLxFdYH9z7j/wCztPRTX5vV+45Vj44zCxqLfr6n855lg5YXESg9unoFegfA/wCOHij9n/x1beJ/AdyFlUCK+sZifI1CDOTFKo7dww5U8j38/oruq0oVYOE1dM5KdSVOSnB2aP3Y/Z//AGhPC/7RPgiLX/Bk/lzxbY9U0uZh9o06cjlHHdTglXHDDkc5A9PBr8D/AIO/GPxP8DPG9p4o8AXv2a8g+S4t5MmC+hzloZl/iU/mpwQQRX7Kfs4ftJ+GP2kPBi6v4Xk+yapaBU1fRpnBmsJSO/8AejOCVccEehBA/NM6ySeBlzw1pv8ADyf+Z97lWbQxceSek1+Poeu0UlLXgHtHh/7WX/IjaV/2FV/9FvXyvX1R+1l/yI2lf9hVf/Rb18r1+XcV/wDIyfoj9u4E/wCRPH/FIK6D4d/8lA8Nf9ha3/8ARgrn66D4d/8AJQPDX/YWt/8A0YK8LC/7xT9V+Z9Rjv8Adan+F/kfe470tIO9LX7cfzSFFFFACN0r8Kv2z/8Ak6r4m/8AYek/9AWv3VbpX4Vftn/8nVfE3/sPSf8AoC15Gc/wY+p+jeGv/Ixq/wCD9UeL0UUV82ftR+sv/BJr/k3vxB/2Nlx/6TW9fbNfE3/BJr/k3vxB/wBjZcf+k1vX2wWxX2GB/wB3h6H83cU/8jnEf4mFFGaMius8AKWkzQDmgCK6tYL61mtr2GK4t7iNo5oZUDpIjDDKyngggkEGvyX/AG3P2KLr4G6lceMPhzbTXXw/vpt00Kgs+hyMeEbuYCThX/h4VuxP63VW1LTbTWdPubDVraC8sryJobi3njDxzRsMMrKeCCCQQa9HLMyq4Gtzw1T3Xc4cfgKeMp8st+jP54KK+uP22f2Jrv4F6hP4u+HNvPefD+8lzLEMvJokjHhHPUwEnCuenCt2LfI9fqWDxtHF0VVpO6f4H53isLUw1R06i1Cuu+FPxW8SfBfxvYeKvAV81nqdk2GViTFdREjdDMo+9G2OR1HBGCAa5Git6lONSLhNXTMYTlCSlF2aP3S/Zx/aE8P/ALRnw8t/EXhoi2vISIdW0uSQNLp9zjJRvVD1VujD0IIHq1fhf+zL8fdU/Z1+Kdh4k09pZtInK22vWCk4u7Mt82B/z0T76H1GOjGv3C0XWrLxFo9jqmizpdWGpW8dzazxnKyxOoZGHsQQa/L87yp4Gt7vwS2/yP0LKcxWMo+98S3/AMzx39rL/kRtK/7Cq/8Aot6+V6+qP2sv+RG0r/sKr/6LevlevxTiv/kZP0R/QnAn/Inj/ikFdB8O/wDkoHhr/sLW/wD6MFc/XQfDv/koHhr/ALC1v/6MFeFhf94p+q/M+ox3+61P8L/I+9x3paQd6Wv24/mkKKKKAEbpX4Vftn/8nVfE3/sPSf8AoC1+6rdK/Cr9s/8A5Oq+Jv8A2HpP/QFryM5/gx9T9G8Nf+RjV/wfqjxeiiivmz9qP1l/4JNf8m9+IP8AsbLj/wBJrevpH9pDXdR8L/AL4g6v4dvJ9P1TTfDt5cWd1A2HglWJirqexBGa+bv+CTX/ACb34g/7Gy4/9JrevoP9q7/k2j4n/wDYq3//AKJavrcM/wDY16H8850lLiSont7Rfmj8ev8Ahsb43/8ART/Fn/gWP8KP+Gxvjf8A9FP8Wf8AgWP8K8cor5j6xW/mf3n7p/Y+X/8APiH/AICv8j2KT9sf43iN/wDi5/iz7p/5fB/hX7cfDe+uNS+Hvhe81CZ7i6u9FtJp5n5aSRoULMfckk1/PHJ/q3/3T/Kv2x+OGqXui/sI6pfaPd3Vhe23gizaC5tZmiliby4eVdSCD7g172Rc9eq4OW7S+8/L/EvDYbB0aM6NNR+K9kleyR9HZozX4D/8Lk+IH/Q9+NP/AAf3X/xdH/C5PiB/0PnjT/wf3X/xdfpH+p9X/n6vuPwj/Win/wA+395+92paba6zp9zYatbQXlleQtDcW88YeOaNhhkZTwQQSCDX5K/tufsXXHwF1KTxZ8P4Zrr4fajOA0eS76LKx4ic9TCx4Rz04VudpbxHwh8X/Hs3i7QY5vHPjKSOTVbVXR9euSGUzICCC/IIr90fEXh3TfFmg6hoviOzg1DStUt3try1mXKTROMMpH0Nc8qeIyHEQfPzKW69P1N4yo5zRkuXlcdmfz00V6J+0H8I7n4GfGDxJ4NuS8lvpl1v0+Z+s9pIN8Dk+uwgH/aVq87r9ApVY1acakNnqfFVacqc3CW6Cv1n/wCCY/xTl8bfAefw1qUry3vga/NnGXOT9klBkgH0U+Yg9kFfkxX3T/wSZ1uS3+KXjrSPMIhvtBhuvL7M0M4UH8BMfzrxOJaEamXyfWNn/XyPWyGs6eNiuj0Ps/8Aay/5EbSv+wqv/ot6+V6+qP2sv+RG0r/sKr/6Levlev5g4r/5GT9Ef1fwJ/yJ4/4pBXQfDv8A5KB4a/7C1v8A+jBXP10Hw7/5KB4a/wCwtb/+jBXhYX/eKfqvzPqMd/utT/C/yPvcd6WkHelr9uP5pCiiigBDX4Vftof8nVfE3/sPSf8AoC1+6pr8Nf24tPk039rL4kxTDBk1VZl+kkEbj9GryM5/gx9T9F8NX/wpVV/c/VHhlFFFfNn7WfrL/wAEmv8Ak3vxB/2Nlx/6TW9fQf7V3/JtHxP/AOxVv/8A0S1fMH/BI/xRa3Pwr8a+H/Nj+26dr63rRZ+byp4ERWx6boXFe/ftweL7Pwj+yv8AEK41CZIm1HSm022VjzJNcERKqjucMT9FJ7V9Xh5L6kn5H8/ZzSn/AKzyjbV1I/i0fhxRRRXyh/QI2T/Vv/un+VftR+0F/wAmB61/2I1n/wCi4a/FiT/Vt/umv3C+Mugy6h+xH4h03Zumi+H4JX/aitFb+aV9Lw07YlPzj+Z+R+LC/wBloryn+SPxUopFOQD60tf0GfygbHgz/kc/D3/YXtP/AEclf0IV/PFo+o/2Pq9hqG0v9gu4rjaP4vLcNj9K/oN8P67aeJtB07WNIlWex1S0iuraRTkPHIoZTx7EV8NxjF81GXTX9D7DheS5ai66H5l/8FYvDsNj8VvBeswwqkuq6DLbzyD/AJaGCbK59wJsflXw3X3h/wAFaNctrr4heANJhkja60/R7q4nVXyUWaVAmR2z5LEV8H19Bw+5f2bSv5/mzxM6t9eqW/rQK+xv+CWCu37RmqlA2xfCtzvx0H7+3xn8a+Oa+5f+CTOmNN8WvHGoeWxS08OxQb8cKZbhWAz6kRH8qvPZcuX1fT9ScnV8dT9T7T/ay/5EfSv+wqv/AKLevlevqj9rL/kRtK/7Cq/+i3r5Xr+V+K/+Rk/RH9bcCf8AInj/AIpBXQfDv/koHhr/ALC1v/6MFc/XQfDv/koHhr/sLW//AKMFeFhf94p+q/M+ox3+61P8L/I+9x3paQd6Wv24/mkKKKKAENfkZ/wVO+H0nhn9oS08SRoBZ+MdHilDhcAz2/7mQH1OwQn/AIFX65188ftxfs6yftDfBe5stBiV/FPh6U6joeeDM6qRJb57eYmQO24ITwK48fQdag0t1qfScJ5pHLs1p1Zu0X7r9H1+Tsz8SaKlubeazuJYLyKWCeCRo5YpVKvG6nDKwPIIIIIqKvkT+i07q6Ot+GfxW8WfBzxMniD4a61daHqqxmJpYQrLNGSCUkRgVdSQDhgeQD1FdD8ZP2lPiN8fDZr8UfEc2p2unsXtbOKCO2t43IwX8uMAF8ZG45IBIGM15jRVqrNR5E9OxyywGFliFiJU06i+1ZX+8KKKWszrOl+GPhCb4gfEfwv4ZtEMkmvaxa2WAM4WSVVY/QKST7Cv6Ade8PW2u+F9R0KT91aahYS2LbRnbG8ZTgewNfmR/wAEt/2fbjxJ46uvil4gtWXR/DQktdFMkfFzfOu2SRc9RGhIz/ekGOVNfqavSvpsopSp0+fZs/DvETMoYrMI4eDuqas/V7/hY/nl1zQ7nwzrWo6PqSsl3pF5NZ3CsMEPE5Rsj6qapV9hf8FKPgPc/D74vN450q2I8O+OW8yaRF+W31BVAlRvTzABIPU+Z6V8e1+74DFxxWHhVj1X49T+b8bh5YevKnLoFezfDH9sL4t/B/wynh7wL4skt9Ghz9mtLuyhu1tckkiIyKSq5JO3OOeleM0VrWw9GtHlqxUl5mVKtUpS5qcmn5G14y8a698QvEl5r/jfVbvWdZ1Bg1xeXT7nfAwoGOFUAABQAAOgrFoorWMYxioxVkiJSlJ3erCv0/8A+CUPgaXSfhj4u8V3SBR4i1eO1tj3aK1Q5P08yVx/wE1+afhnw3qfjLxFpmg+GbWS91bWLqO1sreMcySu2FHsO5PYAntX7u/BP4Y2nwb+Ffhrwdpe149DsUimlUY8+c/NNL/wKRnb8a+V4rxahhlQW8n+C/4J9Fw5hXKu6r2j+bOH/ay/5EbSv+wqv/ot6+V6+qP2sv8AkR9K/wCwqv8A6Levlev5s4r/AORk/RH9S8Cf8ieP+KQV0Hw7/wCSgeGv+wtb/wDowVz9dB8O/wDkoHhr/sLW/wD6MFeFhf8AeKfqvzPqMd/utT/C/wAj73HelpB3pa/bj+aQooooAKQ0teSfHT9qz4W/s3x2v/C3vFdpo93frvtdPjhkubqZM43iGJWYJnI3EBcgjPFAHg/7ZX/BPuy+NV5c+MvhS9no3jaVS9/aTfJa6wQOGJH+rm4xvxhv4sH5q/Lv4gfDLxX8Ktak0n4jeH9U8P36MQI72AosnvG/3XX3UkV+3/wN/al+F37SFtcv8IvFdlrNzZLvurBo3trqBc43NDIqvtzgbgCvIGaxvFH7SXwT1n4vL8FPGGs6RqfjC5mSA6HfaW9xC0rxeasZkaMw7yhHBbOSB1OK8zFZZTrPmjoz7jIeOcZl1NUKsfaU1td6r0fbyZ+GVFfr1+0b8O/2RPgUmk33xw8KaD4eXxDLMli1lp92BK0QUyfLa8LgOvUDrXLfBLT/ANhr4y+KY9A+F9h4Z1TXnVmg0/UEv4ZLgKMt5a3JAkIAJIXJwCcYFef/AGNV/mR9gvEvAcutGd/l/mflpZWdxqV3Fa6bbz3d1M22KC3jMjyH0VVBJNfYv7NX/BNvxr8TNQstX+MEF14L8KBhI9tMNuo3y9diRn/Ug92cZHZT1H2J4b/ao/Za+FuheJNS8H3GheHLDwhq0OjaxNp3haeB4LuXzgkZKQ7nz9mm+YZHydeRk/4ej/s1f9FBk/8ABDf/APxmuuhlEIu9R3Pn818RcVXg6eEp+zv1bu/l0X4n0v4R8I6R4D8N6d4f8I2Fvpej6TbrBZ2kC4WJB+pJOSSeSSSck1sV4/8AGf8Aa2+FX7PtxoUHxa8Ux6JN4khafTo/sc9wZIlKguwjRti5YctjPPocdj8Svix4W+Efw+vvG/jzVFsPDGnRxSXF9HC9wAsrqkZCxhmYFnUcA9c166VtEfnMpSlJyk7tk3xL+Gnh/wCLngzUvC3jywTUdH1OPbLGTh42HKyRt1V1OCGHQivyh/aE/wCCf/xC+Dl9c33hGzuvG3hNSzRXunwl7q3T0ngX5sgfxoCp6/L0r9Z/APjzRPid4N0jxV4KvDf6Frtqt1YXJheIyxN0ba4DDp0IBrR12a4tNE1CfTWtku4bWV7drltsQkCEqXPZcgZPpmvVy3N8RgZfu9YvdPY8zH5ZRxkff0a6n888itDM8MytHNGcPG6lWU+hB5BpK/TnQ/EmrfFHxN8O7P47P+yt4gj1CW8g8aC31K2uLwOXdbNbImUsWP7oMOTknFe7Xf7CvwIvJC8nw50hGbk+TcXEQ/JZAK+pp8X0WvfptPys/wDI+dnwxWv7k18z8UK6PwF8OfFHxR1qPSfh5oOp+IL+RgPLsoC6x+8j/dRfdiBX7L6R+xP8DdDnWay+G3h55FOR9qWS5H5Ssw/SvXND8N6T4YsFsfDWmafpNkn3bextkgjX6KgAqK/F8OX9zTd/P/gF0eGJc372enkfLH7Fv7Dtv8AceLfiBJa6n47uYDHCsB3waRGw+ZI2P35GHDP6ZVeCS31zSdK8p/aG/aW8Ifsy+H9F1n4krq7Wevaqml2n9m2onfz2RnG4FlwuEPPP0r43FYutiqrq1Xds+pw2Gp4emqdNWSMb9rL/AJEfSv8AsKr/AOi3r5Xr798VeDdG8bWMVp4osUvreCXzY42dlCvgjPykdia5j/hQPgD/AKFy3/7/AEv/AMVXwudcO4nHYt1qcklZb3/yP0rhvi/B5ZgVh6sJNpt6Wtr8z4proPh3/wAlA8Nf9ha3/wDRgr6L+K3g34U/Bv4d67408XeG3bRvDtqbq8Fm0kkuwED5VLgE5I7ivMPC/wAcvgFceMPhJY6H4d1uHVvipbDUvC8jWrbYwjuAZj5p2HdG3ADDpXnUOEcZCrGbnHRp9f8AI9jE8f5fVozgqc7tNdOq9T67XvS0gGKWv0M/JAooooASvyn+Fdh4Q8af8FVfi1b/ALTKabe6haSXEfhKy8QbWtnZGiFsqpJ8jMLX5kU8HLMBuwa/Vmvnz9pL9hX4U/tS6hbar8RNMvrPxBawiBdZ0e5FtcvEOiSZVkkAzxuUkdAQKAMyPUP2e/2e7r4t+P8A4eWvguy8S+HdHS58WW+iSxiWJFVmhh8tDtiMrgAhQNzbS2SBX42al8Q/DOr+EL74qXPiu7j/AGg5/iINdit1tZ/Kjsh84Ikx5YcTkMBnhEA71+tmlf8ABLb4I6L8OtT8I6bb+JoI9clhbVNXXVF+3XkUTb0gZzHsWHzAjlVRctGhJO0V7TF+y/8ADGL4Zr4EXwdoZ0QaL/Y+82ERuTB5PlbjNt3ebjnf13fN1oA/On/gpp8XdN+MvwW/Zm+IOj24urTXri7vZLKP5yJQtqJrfvkrIrx/UVd0fw14l/aq/bC+EPi74a/APWPg34d8A6hBea9ql7pY05bxIp1l2NiONXbahjUKGY+a2cKOPqpv+CZ3wmk8B+GPCFxf+N5tG8H6zc6vpKSawheCacReYmfK/wBWTArbQBhmc5+avrL+dAH5mf8ABMbwpofjT4mftOaf4w0XStc0/wD4S23mFpqVnHdRBxcahtbY4I3AE4OM8ms79gf4b+EPEX7ZH7Tum+IvCvhrU9M0nWp1sLO90qCaGzUX9woESMpVBtAGFA4A9K+4vgP+yr4L/Z18QeNdZ+H7609349vUvNW/tC8WZRIryuPLARdozO/XPb0rI8H/ALGPgXwH4h+KOueF77xTZ6p8XI7lNduF1Fd0HnvI7tbHy/3bAyvgndjj0oA/KP8AaK+Mfw1/aV/aC+Mmv/FDxHPpml6J4el0b4ZxW9pNNHNc27/uXJjBCxOyzMd2B/pA/u17rF8ef+F1f8EffGFhqlx53iDwENO0PUNzZdoY722NrIfYw7Uz3aJ6+9/gn+x78LfgP4L/AOEa8J+G7PUrU3cl093rlvDe3Mkj4BzIUHACqAAABj1JNcN/w7n+E8Nn8SrDTX8U6bpXxWeN9d02z1JI7dGjuxdRmBPL/d7ZAQByAjsvQ8AG9+wfq1gv7IvwktmvbMXJ8OQL5Pnrvzk8YznPtXB/8FXL7X7D9jPxKfCr3UcU+o2UOsPbkgiyaXDgkc7S/lKexDEHgmk+G/8AwSx+C/wr8feH/GHhifxo2reGtQiv7IXOrRvEZY2DLvURAlcjkZFfW+q6TZa9pt1p2t2drqGn3sTQ3VrdQrLFPGwwyOjAhlIOCCMUAfiv8bLr9njw/wCIP2Wl/Z3m8Prd2up2F54s1CCQ+ciiW0wb12PyyBlnYqcbeeAMV+jn7ZH7Xx/Z38HeHP8AhXemaf4x8Z+N9Xj0vQLA3Y8gyNjMkhRskZZFCgjJccgA1o+OP2A/gT448D3HhZ/h9ouh2M94t4LnQ4VsrqOZQVDLKoyRtZhsbK89OBjwbxZ/wRx+GUekfaPhL4o8Y+FvFllNHc6Zql3dpeRwSowZS0aojdQCCrAggHnoQDtfgn+178SdP/aKT4LftZ+F/C3h3xJqujnVdF1TQLtjazoA7FHEjtziOUBgw5jIwcg1wX7b37dfjT9nn9pbwP4f+Gk+n+JND1HQTNfeHYY4ZJLy+lknit1M2C8YLiE7VIJCn+9mrcf/AAS5vPjB4svPFf7ZHxR1nx/rz2kVnY/2Lbx6alvDGSRk7CD1Y4VFGWYksTWt/wAOc/gJnP2jx7kf9RqL/wCM0AcN49+E/wC0/D8Nda+KOvftHx6X440mxk1YeC9HEa6bCkSGRrXIfY7hVI5jcEjBZgd1eY/tjfH6X9oj9hL4EePfECW9pqdz45jg1gRjbEtzbxXMcrqP4VbYHA7Bsdq+h/8Ahzj8A/8An48e/wDg6i/+M163D+wT8Jv+GfYfg5qNhq2peErXUX1K0kur7/TLW6YsTJHKqrg4ZlxjBDEEHNAGx+1FdeNvG3wP1K2/Zi8aeHtH8XXZiktL+TUIlWW3zmRYpSGVXZcbX4x/eXrX5K6F8RPHCXNpoHg/4kfHX/hpI+IjplxpM/iWK60eXax3yGUvtKgAjDFl4Jztr73X/gjl8AgwJm8eEen9tR4/9E10mqf8Eov2eNS8LWWjQ+G9X0+WzkaT+1bXWJftk5bGRIz7kYcDA2ADnGMnIBY/a01i/wBJ/wCCfPjSy+KHijQtZ8XHwrHBqd5ZNHDFdXjOgIjjB7scDAGcZwM4Hx38OVK/GX9goMCD/wAIq55HYzXGK+nbP/gjx8ALa6jlm/4Te7SNgzQTa2oSQDsSkStj6EH3r3jW/wBkf4f6z8SPhz40jtdQ0y/+Fdktl4bsdPuFis4YFBCo0ZUlgAccMOgoA9pooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigD/2Q==';

function getFactoryLogoSrc() {
  const custom = state && state.factoryInfo && state.factoryInfo.logoDataUrl;
  if (custom && typeof custom === 'string' && custom.startsWith('data:image/')) {
    return custom;
  }
  return DEFAULT_FACTORY_LOGO_DATA_URL;
}

function getPrintTopLeftLogoHtml(metaHtml = '') {
  const logoSrc = getFactoryLogoSrc();
  return `
    <div style="display:flex;align-items:center;gap:12px;direction:rtl;text-align:left;">
      ${metaHtml ? `<div style="text-align:left;font-size:11.5px;line-height:1.45;">${metaHtml}</div>` : ''}
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;border:1.5px solid #0f172a;border-radius:8px;padding:4px 8px;background:#ffffff;min-width:64px;">
        <img src="${logoSrc}" alt="لوجو الشركة" style="height:64px;max-width:140px;object-fit:contain;display:block;" />
      </div>
    </div>
  `;
}

function openFactoryLogoModal() {
  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot) return;
  const currentLogo = getFactoryLogoSrc();
  const hasCustom = Boolean(state?.factoryInfo?.logoDataUrl);

  modalRoot.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal-box" style="max-width:520px;text-align:center;">
        <div class="card-header">
          <div class="card-title">🖼️ لوجو الشركة (في واجهة النظام وأعلى يسار جميع التقارير)</div>
          <button class="btn btn-sm btn-outline" onclick="closeModal()">✕</button>
        </div>

        <div style="background:var(--bg-elevated);border:2px dashed var(--border-color);border-radius:14px;padding:18px;margin-bottom:16px;">
          <div style="font-size:0.82rem;color:var(--text-muted);margin-bottom:8px;">معاينة اللوجو الحالي:</div>
          <div style="display:inline-flex;align-items:center;justify-content:center;background:#ffffff;border:1px solid #cbd5e1;border-radius:12px;padding:10px 18px;min-height:84px;">
            <img id="logo-modal-preview-img" src="${currentLogo}" alt="لوجو الشركة" style="max-height:76px;max-width:220px;object-fit:contain;" />
          </div>
          <div style="margin-top:8px;font-size:0.78rem;color:var(--accent);font-weight:700;">
            ✅ يظهر هذا اللوجو في واجهة النظام ويُطبع تلقائياً في أعلى يسار الصفحة في كل التقارير والأذونات
          </div>
        </div>

        <div style="margin-bottom:16px;">
          <label for="factory-logo-file-input" class="btn btn-primary" style="width:100%;justify-content:center;padding:12px;font-size:0.92rem;cursor:pointer;">
            📤 اختر صورة لوجو الشركة من جهازك أو الموبايل (PNG / JPG / SVG)
          </label>
          <input id="factory-logo-file-input" type="file" accept="image/*" style="display:none;" onchange="handleFactoryLogoFileChange(event)" />
        </div>

        <div style="display:flex;justify-content:space-between;gap:10px;">
          ${hasCustom ? `
            <button type="button" class="btn btn-danger" onclick="resetFactoryLogoToDefault()">🔄 استعادة اللوجو الافتراضي</button>
          ` : '<span></span>'}
          <button type="button" class="btn btn-outline" onclick="closeModal()">إغلاق</button>
        </div>
      </div>
    </div>
  `;
}

function handleFactoryLogoFileChange(event) {
  const file = event?.target?.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    const rawDataUrl = e.target?.result;
    if (!rawDataUrl || typeof rawDataUrl !== 'string') return;

    // Compress/resize via canvas if raster image so it syncs fast across Firebase & all devices
    const img = new Image();
    img.onload = function() {
      try {
        const maxW = 320;
        const maxH = 160;
        let w = img.width || 160;
        let h = img.height || 160;
        const ratio = Math.min(maxW / w, maxH / h, 1);
        w = Math.max(1, Math.round(w * ratio));
        h = Math.max(1, Math.round(h * ratio));

        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        const finalDataUrl = canvas.toDataURL('image/png');

        state.factoryInfo = state.factoryInfo || {};
        state.factoryInfo.logoDataUrl = finalDataUrl;
        state.factoryInfo.updatedAt = new Date().toISOString();
        saveState(`🖼️ تحديث لوجو الشركة الرسمي بواسطة ${currentUser ? currentUser.name : 'الإدارة'}`);
        openFactoryLogoModal();
        alert('✅ تم حفظ لوجو الشركة بنجاح! سيظهر الآن في واجهة النظام وفي أعلى يسار جميع التقارير والأذونات المطبوعة.');
      } catch (_) {
        state.factoryInfo = state.factoryInfo || {};
        state.factoryInfo.logoDataUrl = rawDataUrl;
        state.factoryInfo.updatedAt = new Date().toISOString();
        saveState(`🖼️ تحديث لوجو الشركة الرسمي بواسطة ${currentUser ? currentUser.name : 'الإدارة'}`);
        openFactoryLogoModal();
      }
    };
    img.src = rawDataUrl;
  };
  reader.readAsDataURL(file);
}

function resetFactoryLogoToDefault() {
  if (!confirm('هل تريد استعادة اللوجو الافتراضي للمصنع؟')) return;
  if (state && state.factoryInfo) {
    delete state.factoryInfo.logoDataUrl;
    state.factoryInfo.updatedAt = new Date().toISOString();
  }
  saveState(`🔄 استعادة اللوجو الافتراضي للمصنع بواسطة ${currentUser ? currentUser.name : 'الإدارة'}`);
  openFactoryLogoModal();
}

// Main Render Entry
function render() {
  if (window._isPrintingActive) return;
  const appEl = document.getElementById('app');
  if (!state) {
    appEl.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100vh;font-weight:700;font-size:1.2rem;">جاري تحميل نظام مصنع العاصمة للصناعات المتخصصة...</div>`;
    return;
  }
  state = normalizeState(state);

  if (!currentUser) {
    appEl.innerHTML = renderLoginScreen();
    return;
  }

  // Preserve active input focus & cursor position across re-renders
  const activeEl = document.activeElement;
  const focusedId = (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA') && activeEl.id) ? activeEl.id : null;
  const focusedVal = focusedId ? activeEl.value : null;
  let focusedSelStart = null;
  let focusedSelEnd = null;
  if (focusedId) {
    try {
      focusedSelStart = activeEl.selectionStart;
      focusedSelEnd = activeEl.selectionEnd;
    } catch (_) {}
  }

  const isExecRole = isFullAdmin(currentUser);
  const isWarehouseOrAdmin = currentUser.roleKey === 'admin_manager' || currentUser.roleKey === 'warehouse_keeper';
  const isAccountantRole = currentUser.roleKey === 'accountant' || currentUser.roleKey === 'accounts_manager' || currentUser.roleKey === 'accounting_manager';

  const pendingPrepOrdersCount = (state.productionOrders || []).filter(o => {
    const st = o.stage || o.status;
    if (st === 'pending_executive') return isExecRole || isAccountantRole;
    if (st === 'pending_warehouse_prep') return isWarehouseOrAdmin || isExecRole || isAccountantRole;
    return false;
  }).length;

  const pendingReturnsCount = (state.salesReturns || []).filter(r => (r.status || 'pending_approval') === 'pending_approval').length;

  const pendingApprovalsCount =
    (state.productionOrders || []).filter(o => {
      const st = o.stage || o.status;
      if (st === 'pending_warehouse_prep' && isWarehouseOrAdmin) return true;
      return st === 'pending_accountant_release' || st === 'ready_for_car_dispatch';
    }).length +
    (state.approvalRequests || []).filter(r => r.stage === 'pending_financial' || r.stage === 'pending_warehouse').length +
    (canApproveSalesReturn(currentUser) ? pendingReturnsCount : 0);
  const openTasksForMeCount = (state.chatMessages || []).filter(c =>
    c.msgType === 'task' && c.taskStatus !== 'completed' &&
    canUserSeeChatMessage(currentUser, c) &&
    (!c.assignedToUserId || c.assignedToUserId === 'all' || c.assignedToUserId === currentUser.id || isFullAdmin(currentUser))
  ).length;
  const authorizedLogsCount = (state.auditLogs || []).filter(l => canUserSeeNotification(currentUser, l)).length;
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';

  appEl.innerHTML = `
    <div class="app-layout">
      ${sidebarOpen ? `<div class="sidebar-backdrop" onclick="sidebarOpen=false; render();"></div>` : ''}
      <!-- Sidebar -->
      <aside class="sidebar ${sidebarOpen ? 'open' : ''}">
        <div class="sidebar-brand" style="cursor:pointer;" onclick="openFactoryLogoModal()" title="اضغط لرفع أو تغيير لوجو الشركة">
          <img src="${getFactoryLogoSrc()}" alt="شعار المصنع" style="width:46px;height:46px;object-fit:contain;background:#fff;border-radius:10px;padding:2px;" />
          <div>
            <h2>مصنع العاصمة</h2>
            <small>للصناعات المتخصصة - القشرة الخشبية</small>
          </div>
        </div>

        <div class="sidebar-user">
          <div style="display:flex;align-items:center;gap:10px;">
            <div class="user-avatar" style="width:36px;height:36px;font-size:0.95rem;background:${currentUser.avatarColor || '#0f766e'}">
              ${currentUser.name.charAt(0)}
            </div>
            <div>
              <div style="font-weight:700;font-size:0.88rem;color:#fff;">${currentUser.name}</div>
              <div style="font-size:0.72rem;color:#94a3b8;">${currentUser.roleTitle}</div>
            </div>
          </div>
          <button class="btn btn-sm btn-outline" style="color:#fca5a5;border-color:rgba(252,165,165,0.3);" onclick="logout()" title="تسجيل الخروج">خروج</button>
        </div>

        <nav class="sidebar-nav">
          <button class="nav-item ${activeTab === 'dashboard' ? 'active' : ''}" onclick="setTab('dashboard')">
            <span>${canSeeFinancialPrices() ? '📊 لوحة القيادة والمؤشرات' : '📊 لوحة متابعة كميات المخازن'}</span>
          </button>

          ${hasPerm('warehouses') ? `
          <button class="nav-item ${activeTab === 'warehouses' ? 'active' : ''}" onclick="setTab('warehouses')">
            <span>${canSeeFinancialPrices() ? '🏭 المخازن الأربعة والرصيد' : '🏭 أرصدة كميات المخازن'}</span>
            ${pendingReturnsCount > 0 ? `<span class="nav-badge" style="background:#7c3aed;">${pendingReturnsCount}</span>` : ''}
          </button>
          ` : ''}

          ${hasPerm('production') ? `
          <button class="nav-item ${activeTab === 'production' ? 'active' : ''}" onclick="setTab('production')">
            <span>📋 أوامر تجهيز طلبية للعميل</span>
            ${pendingPrepOrdersCount > 0 ? `<span class="nav-badge" style="background:#d97706;">${pendingPrepOrdersCount}</span>` : ''}
          </button>
          ` : ''}

          ${hasPerm('approvals') ? `
          <button class="nav-item ${activeTab === 'approvals' ? 'active' : ''}" onclick="setTab('approvals')">
            <span>${canSeeFinancialPrices() ? '✅ اعتماد أذون الصرف والسيارات' : '✅ أذون تحميل وصرف السيارات'}</span>
            ${pendingApprovalsCount > 0 ? `<span class="nav-badge">${pendingApprovalsCount}</span>` : ''}
          </button>
          ` : ''}

          ${canSeeFinancialPrices() && (hasPerm('salesAccounting') || hasPerm('clientsSuppliers')) ? `
          <button class="nav-item ${activeTab === 'accounting' ? 'active' : ''}" onclick="setTab('accounting')">
            <span>💰 حسابات ومبيعات العملاء</span>
          </button>
          ` : ''}

          <button class="nav-item ${activeTab === 'chat' ? 'active' : ''}" onclick="setTab('chat')">
            <span>💬 الشات والمهام بين الحسابات</span>
            ${openTasksForMeCount > 0 ? `<span class="nav-badge" style="background:#2563eb;">${openTasksForMeCount}</span>` : ''}
          </button>

          ${hasPerm('reports') ? `
          <button class="nav-item ${activeTab === 'reports' ? 'active' : ''}" onclick="setTab('reports')">
            <span>${canSeeFinancialPrices() ? '📈 التقارير الشاملة والربحية' : '📈 تقارير جرد كميات المخازن'}</span>
          </button>
          ` : ''}

          ${canSeeFinancialPrices() ? `
          <button class="nav-item ${activeTab === 'settings' ? 'active' : ''}" onclick="setTab('settings')">
            <span>🔧 الأصناف والـ 8 مستخدمين</span>
          </button>
          ` : ''}

          <button class="nav-item" onclick="openPasswordsManagerModal()">
            <span>🔑 تغيير الباسوردات</span>
          </button>
        </nav>

        <div class="sidebar-footer">
          <div style="font-size:0.74rem;color:#94a3b8;margin-bottom:2px;">تبديل الحساب:</div>
          <select class="form-control" style="background:#1e293b;color:#fff;border-color:#334155;font-size:0.8rem;padding:6px 8px;" onchange="quickSwitchUser(this.value)">
            ${state.users.map(u => `<option value="${u.id}" ${u.id === currentUser.id ? 'selected' : ''}>👤 ${u.name}</option>`).join('')}
          </select>
        </div>
      </aside>

      <!-- Main Area -->
      <div class="main-area">
        <header class="topbar">
          <div class="topbar-left">
            <button class="mobile-menu-btn" onclick="sidebarOpen = !sidebarOpen; render();">☰</button>
            <img src="${getFactoryLogoSrc()}" alt="لوجو الشركة" onclick="openFactoryLogoModal()" title="اضغط لرفع أو تغيير لوجو الشركة" style="height:40px;max-width:95px;object-fit:contain;background:#fff;border:1px solid var(--border-color);border-radius:8px;padding:2px 5px;cursor:pointer;" />
            <div>
              <div style="font-weight:800;font-size:1.05rem;">${state.factoryInfo.name}</div>
              <div style="font-size:0.76rem;color:var(--text-muted);">المقاس القياسي للقشرة: <strong>${state.factoryInfo.standardDimensions}</strong> (مساحة الفرخ: 3.125 م²)</div>
            </div>
          </div>

          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <button class="btn btn-sm btn-outline" onclick="openFactoryLogoModal()" title="رفع أو تغيير لوجو الشركة ليظهر في النظام وفي أعلى يسار جميع التقارير">
              🖼️ لوجو الشركة
            </button>
            <button class="btn btn-sm ${activeTab === 'chat' ? 'btn-primary' : 'btn-outline'}" onclick="setTab('chat')" title="فتح غرفة الشات وتكليف المهام بين الـ 8 حسابات">
              💬 الشات والمهام ${openTasksForMeCount > 0 ? `<span class="badge badge-danger" style="margin-right:4px;">${openTasksForMeCount} مهمة</span>` : ''}
            </button>
            <button class="btn btn-sm btn-outline" style="border-color:var(--primary);color:var(--primary);" onclick="openNotificationsCenterModal()" title="سجل الإشعارات المسموح لك برؤيتها وتجربة الصوت الطويل">
              🔔 الإشعارات والصوت (${authorizedLogsCount})
            </button>
            <button class="btn btn-sm btn-accent" onclick="openPasswordsManagerModal()" title="تغيير الباسورد الخاص بك وباسوردات الموبايلات">
              🔑 تغيير الباسوردات
            </button>
            <button class="btn btn-sm btn-primary" onclick="openMobileInstallModal()" title="افتح بالكاميرا QR أو أرسل الرابط على واتساب أو ثبته بضغطة واحدة">
              📲 الموبايل (QR)
            </button>
            <span id="sync-status-pill" class="sync-pill ${isOnline ? '' : 'offline'}">
              ${isOnline ? '● متصل ومتزامن سحابياً' : '● وضع أوفلاين (حفظ محلي تلقائي)'}
            </span>
            <button class="btn btn-sm btn-outline" onclick="toggleTheme()">
              ${isDark ? '☀️' : '🌙'}
            </button>
          </div>
        </header>

        <main class="content-container">
          ${renderActiveTabContent()}
        </main>
      </div>
    </div>

    ${activeTab !== 'chat' ? `
      <button class="floating-chat-fab" onclick="setTab('chat')" title="فتح الشات والمهام بين الحسابات">
        <span>💬 الشات والمهام</span>
        ${openTasksForMeCount > 0 ? `<span class="badge" style="background:#ef4444;color:#fff;">${openTasksForMeCount}</span>` : ''}
      </button>
    ` : ''}
  `;
  renderLiveBannerDOM();

  if (focusedId) {
    const restoredEl = document.getElementById(focusedId);
    if (restoredEl) {
      if (focusedVal !== null && restoredEl.value !== focusedVal) {
        restoredEl.value = focusedVal;
      }
      restoredEl.focus();
      try {
        const len = restoredEl.value.length;
        restoredEl.setSelectionRange(focusedSelStart ?? len, focusedSelEnd ?? len);
      } catch (_) {}
    }
  }
}

function renderLoginScreen() {
  const selectedUser = state.users.find(u => u.id === selectedLoginUserId) || state.users[0];
  return `
    <div class="login-screen">
      <div class="login-card">
        <div class="login-header">
          <img src="${getFactoryLogoSrc()}" alt="مصنع العاصمة" class="login-logo" style="width:90px;height:110px;object-fit:contain;background:#fff;border-radius:16px;padding:6px;box-shadow:0 8px 20px rgba(0,0,0,0.3);" />
          <h1>${state.factoryInfo.name}</h1>
          <p>${state.factoryInfo.subtitle} — مقاس قياسي (${state.factoryInfo.standardDimensions})</p>
          <div style="margin-top:10px;display:flex;justify-content:center;gap:8px;flex-wrap:wrap;">
            <button type="button" class="btn btn-sm btn-accent" onclick="openMobileInstallModal()">
              📲 تثبيت التطبيق على الموبايل / إرسال واتساب (QR)
            </button>
          </div>
        </div>

        <div style="margin-bottom:14px;font-size:0.9rem;color:#fbbf24;font-weight:700;text-align:center;">
          اختر حسابك من المستخدمين الـ 8 ثم أدخل الباسورد للدخول:
        </div>

        <div class="users-grid">
          ${state.users.map((u, idx) => `
            <div class="user-role-card ${u.id === selectedLoginUserId ? 'selected' : ''}" onclick="selectLoginUser('${u.id}')">
              <div class="user-avatar" style="background:${u.avatarColor || '#0f766e'}">${idx + 1}</div>
              <h3>${u.name}</h3>
              <span>${u.roleTitle}</span>
              <small style="color:#94a3b8;font-size:0.74rem;">🔒 محمي بباسورد</small>
            </div>
          `).join('')}
        </div>

        <form onsubmit="handleLoginSubmit(event)" class="login-pin-box">
          <input id="login-pin-input" type="password" value="" placeholder="أدخل الباسورد لحساب (${selectedUser ? selectedUser.name : ''})" required autofocus />
          <button type="submit" class="btn btn-primary" style="padding:13px 26px;font-size:1rem;">
            دخول كـ (${selectedUser ? selectedUser.name : ''}) ⬅
          </button>
        </form>
      </div>
    </div>
  `;
}

function renderActiveTabContent() {
  if (!canSeeFinancialPrices() && (activeTab === 'accounting' || activeTab === 'settings')) {
    activeTab = 'warehouses';
  }
  switch (activeTab) {
    case 'dashboard': return renderDashboard();
    case 'warehouses': return renderWarehouses();
    case 'production': return renderProduction();
    case 'approvals': return renderApprovals();
    case 'accounting': return renderAccounting();
    case 'chat': return renderChatAndTasksTab();
    case 'reports': return renderReports();
    case 'settings': return renderSettings();
    default: return renderDashboard();
  }
}

// ============================================================================
// NOTIFICATIONS CENTER MODAL & PROFESSIONAL CHAT / TASKS SYSTEM
// ============================================================================
function toggleSoundPreference() {
  soundEnabled = !soundEnabled;
  localStorage.setItem('al_asimah_sound_enabled', soundEnabled ? 'true' : 'false');
  if (soundEnabled) playLongAlertSound(false);
  else stopLongAlertSound();
  openNotificationsCenterModal();
}

function openNotificationsCenterModal() {
  const modalRoot = document.getElementById('modal-root');
  const authorizedLogs = (state.auditLogs || []).filter(l => canUserSeeNotification(currentUser, l));

  modalRoot.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal-box" style="max-width:740px;">
        <div class="card-header">
          <div>
            <div class="card-title">🔔 مركز الإشعارات الفورية والتنبيه الصوتي الطويل (حسب صلاحيات حسابك)</div>
            <small style="color:var(--text-muted);">
              يظهر لك هنا وينبهك بصوت طويل فقط التعديلات والإضافات التي يمتلك حسابك (<strong>${currentUser.name}</strong>) صلاحية رؤيتها
            </small>
          </div>
          <button class="btn btn-sm btn-outline" onclick="closeModal()">✕</button>
        </div>

        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;background:var(--bg-elevated);padding:12px 16px;border-radius:12px;margin-bottom:14px;">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <button type="button" class="btn btn-sm ${soundEnabled ? 'btn-success' : 'btn-danger'}" onclick="toggleSoundPreference()">
              ${soundEnabled ? '🔊 الإشعار الصوتي الطويل: مفعّل' : '🔇 الإشعار الصوتي الطويل: مكتوم'}
            </button>
            <button type="button" class="btn btn-sm btn-primary" onclick="playLongAlertSound(false)">
              🎵 تجربة صوت الإشعار الطويل (4.5 ثانية)
            </button>
            <button type="button" class="btn btn-sm btn-accent" onclick="playLongAlertSound(true)">
              🚨 تجربة صوت التنبيه العاجل
            </button>
          </div>
          <button type="button" class="btn btn-sm btn-outline" onclick="stopLongAlertSound()">⏹️ إيقاف الصوت</button>
        </div>

        <div class="table-responsive" style="max-height:55vh;overflow-y:auto;">
          <table>
            <thead>
              <tr>
                <th>الوقت والتاريخ</th>
                <th>المستخدم المنفذ</th>
                <th>تفاصيل الإضافة أو التعديل</th>
                <th>انتقال سريع</th>
              </tr>
            </thead>
            <tbody>
              ${authorizedLogs.length === 0 ? `
                <tr><td colspan="4" style="text-align:center;padding:24px;color:var(--text-muted);">لا توجد إشعارات أو تعديلات مسجلة حتى الآن.</td></tr>
              ` : authorizedLogs.slice(0, 60).map(l => {
                const tTab = l.targetTab || inferActionScope(l.action).targetTab || 'dashboard';
                return `
                  <tr>
                    <td style="white-space:nowrap;font-size:0.78rem;">${fmtDate(l.timestamp)}<br/><strong>${new Date(l.timestamp).toLocaleTimeString('ar-EG')}</strong></td>
                    <td><strong>${l.userName}</strong><br/><small style="color:var(--text-muted);">${l.roleTitle || ''}</small></td>
                    <td style="font-weight:700;">${sanitizeTextForWarehouseKeeper(l.action)}</td>
                    <td>
                      <button class="btn btn-sm btn-outline" onclick="closeModal(); setTab('${tTab}');">👁️ عرض</button>
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

function getChatChannelsList() {
  return [
    { id: 'general', name: '📢 القناة العامة للمصنع', desc: 'تواصل ومهام جميع الحسابات الـ 8', permKey: 'all' },
    { id: 'warehouses', name: '🏭 غرفة المخازن والرصيد', desc: 'أذون الدخول والخروج والفرز والجرد', permKey: 'warehouses' },
    { id: 'production', name: '📋 غرفة أوامر تجهيز طلبية للعميل', desc: 'تجهيز الطلبيات وبيان العميل والاعتماد', permKey: 'production' },
    { id: 'accounting', name: '💰 غرفة حسابات ومبيعات العملاء', desc: 'الفواتير، أذون الصرف، والمديونيات والبالتات', permKey: 'salesAccounting' }
  ];
}

function canUserSeeChatMessage(user, msg) {
  if (!user || !msg) return false;
  if (isFullAdmin(user)) return true; // المدير التنفيذي ومدير المشروعات يرون كافة المحادثات والمهام
  if (msg.senderId === user.id || msg.assignedToUserId === user.id) return true;

  if (msg.channel && msg.channel.startsWith('dm_')) {
    const targetId = msg.channel.replace('dm_', '');
    return targetId === user.id || msg.recipientUserId === user.id || msg.senderId === user.id;
  }
  if (msg.channel === 'warehouses') return Boolean(user.permissions?.warehouses);
  if (msg.channel === 'production') return Boolean(user.permissions?.production);
  if (msg.channel === 'accounting') return Boolean(user.permissions?.salesAccounting || user.permissions?.approvals);
  return true; // general channel
}

function selectChatChannel(chId) {
  activeChatChannel = chId;
  if (chId.startsWith('dm_')) {
    chatAssignedUserId = chId.replace('dm_', '');
  }
  render();
  setTimeout(() => {
    const box = document.getElementById('chat-messages-scroll');
    if (box) box.scrollTop = box.scrollHeight;
  }, 50);
}

function insertQuickChatTemplate(text, msgType = 'task', linkedTab = '') {
  chatMsgType = msgType;
  if (linkedTab) chatLinkedTab = linkedTab;
  render();
  const input = document.getElementById('chat-text-input');
  if (input) {
    input.value = text;
    input.focus();
  }
}

function sendChatMessage(e) {
  e.preventDefault();
  if (!currentUser) return;
  const inputEl = document.getElementById('chat-text-input');
  const text = (inputEl?.value || '').trim();
  if (!text) return;

  const msgType = document.getElementById('chat-msg-type')?.value || chatMsgType || 'message';
  const assignedToId = document.getElementById('chat-assigned-user')?.value || '';
  const linkedTab = document.getElementById('chat-linked-tab')?.value || '';
  const assignedUser = state.users.find(u => u.id === assignedToId);

  let recipientUserId = '';
  let channelLabel = 'القناة العامة';
  if (activeChatChannel.startsWith('dm_')) {
    recipientUserId = activeChatChannel.replace('dm_', '');
    const recUser = state.users.find(u => u.id === recipientUserId);
    channelLabel = `محادثة مباشرة مع ${recUser ? recUser.name : 'مستخدم'}`;
  } else {
    const chObj = getChatChannelsList().find(c => c.id === activeChatChannel);
    if (chObj) channelLabel = chObj.name;
  }

  const now = new Date().toISOString();
  const newMsg = {
    id: uid('chat'),
    channel: activeChatChannel,
    channelLabel,
    senderId: currentUser.id,
    senderName: currentUser.name,
    senderRoleTitle: currentUser.roleTitle,
    senderColor: currentUser.avatarColor || '#0f766e',
    recipientUserId,
    msgType, // 'message' | 'task' | 'urgent'
    text,
    assignedToUserId: assignedToId || recipientUserId || '',
    assignedToUserName: assignedUser ? assignedUser.name : '',
    taskStatus: msgType === 'task' ? 'pending' : '',
    completedBy: '',
    completedAt: '',
    linkedTab,
    createdAt: now,
    updatedAt: now
  };

  state.chatMessages = state.chatMessages || [];
  state.chatMessages.push(newMsg);
  markNotifIdsSeen([newMsg.id]);

  const logTargetUser = recipientUserId || assignedToId || 'all';
  const logPrefix = msgType === 'task' ? '📌 تكليف مهمة عمل جديدة' : msgType === 'urgent' ? '🚨 تنبيه عاجل' : '💬 رسالة عمل';
  saveState(`${logPrefix} في (${channelLabel})${assignedUser ? ' موجهة إلى ' + assignedUser.name : ''}: ${text}`);

  setTimeout(() => {
    const box = document.getElementById('chat-messages-scroll');
    if (box) box.scrollTop = box.scrollHeight;
  }, 60);
}

function completeChatTask(msgId) {
  const msg = (state.chatMessages || []).find(m => m.id === msgId);
  if (!msg) return;
  const now = new Date().toISOString();
  msg.taskStatus = 'completed';
  msg.completedBy = currentUser.name;
  msg.completedAt = now;
  msg.updatedAt = now;
  saveState(`✅ إتمام وتنفيذ المهمة (${msg.text}) بواسطة ${currentUser.name}`);
}

function renderChatAndTasksTab() {
  const channels = getChatChannelsList().filter(ch => {
    if (isFullAdmin(currentUser) || ch.permKey === 'all') return true;
    return hasPerm(ch.permKey);
  });

  const allMsgs = state.chatMessages || [];
  const filteredMsgs = allMsgs.filter(m => {
    if (!canUserSeeChatMessage(currentUser, m)) return false;
    if (activeChatChannel.startsWith('dm_')) {
      const otherUserId = activeChatChannel.replace('dm_', '');
      return (
        (m.channel === `dm_${otherUserId}` && m.senderId === currentUser.id) ||
        (m.channel === `dm_${currentUser.id}` && m.senderId === otherUserId) ||
        (m.senderId === currentUser.id && m.recipientUserId === otherUserId) ||
        (m.senderId === otherUserId && m.recipientUserId === currentUser.id)
      );
    }
    return m.channel === activeChatChannel;
  });

  const pendingTasksCount = allMsgs.filter(m => m.msgType === 'task' && m.taskStatus !== 'completed' && canUserSeeChatMessage(currentUser, m)).length;
  const completedTasksCount = allMsgs.filter(m => m.msgType === 'task' && m.taskStatus === 'completed' && canUserSeeChatMessage(currentUser, m)).length;

  let activeHeaderTitle = '📢 القناة العامة للمصنع';
  if (activeChatChannel.startsWith('dm_')) {
    const uObj = state.users.find(u => u.id === activeChatChannel.replace('dm_', ''));
    if (uObj) activeHeaderTitle = `👤 محادثة ومهام مباشرة مع: ${uObj.name} (${uObj.roleTitle})`;
  } else {
    const chObj = channels.find(c => c.id === activeChatChannel);
    if (chObj) activeHeaderTitle = `${chObj.name} — ${chObj.desc}`;
  }

  const tabLabels = {
    warehouses: '🏭 المخازن والرصيد',
    production: '📋 أوامر تجهيز طلبية للعميل',
    approvals: '✅ اعتماد أذون الصرف والسيارات',
    accounting: '💰 حسابات ومبيعات العملاء',
    reports: '📈 التقارير الشاملة'
  };

  return `
    <div class="chat-layout">
      <!-- Right Panel: Channels & Direct 8 Users Accounts -->
      <div class="chat-channels-panel">
        <div style="padding:14px;background:var(--bg-elevated);border-bottom:1px solid var(--border-color);">
          <div style="font-weight:900;font-size:0.95rem;color:var(--primary);">📂 غرف العمل والأقسام</div>
          <small style="color:var(--text-muted);font-size:0.75rem;">مهام معلقة: <strong>${pendingTasksCount}</strong> | مكتملة: <strong>${completedTasksCount}</strong></small>
        </div>

        <div style="overflow-y:auto;flex:1;">
          ${channels.map(ch => {
            const count = allMsgs.filter(m => m.channel === ch.id && m.msgType === 'task' && m.taskStatus !== 'completed').length;
            return `
              <button class="chat-channel-btn ${activeChatChannel === ch.id ? 'active' : ''}" onclick="selectChatChannel('${ch.id}')">
                <div>
                  <div>${ch.name}</div>
                  <small style="color:var(--text-muted);font-weight:500;font-size:0.72rem;">${ch.desc}</small>
                </div>
                ${count > 0 ? `<span class="badge badge-danger">${count}</span>` : ''}
              </button>
            `;
          }).join('')}

          <div style="padding:10px 14px;background:var(--bg-elevated);font-weight:800;font-size:0.82rem;color:var(--text-muted);border-bottom:1px solid var(--border-color);">
            👥 محادثة ومهام مباشرة مع الحسابات الـ 8:
          </div>

          ${state.users.filter(u => u.id !== currentUser.id).map(u => {
            const dmKey = `dm_${u.id}`;
            const dmTasks = allMsgs.filter(m =>
              m.msgType === 'task' && m.taskStatus !== 'completed' &&
              ((m.senderId === u.id && m.recipientUserId === currentUser.id) || (m.senderId === currentUser.id && m.recipientUserId === u.id))
            ).length;
            return `
              <button class="chat-channel-btn ${activeChatChannel === dmKey ? 'active' : ''}" onclick="selectChatChannel('${dmKey}')">
                <div style="display:flex;align-items:center;gap:8px;">
                  <div class="user-avatar" style="width:28px;height:28px;font-size:0.78rem;background:${u.avatarColor || '#0f766e'};">${u.name.charAt(0)}</div>
                  <div>
                    <div style="font-size:0.84rem;">${u.name}</div>
                    <small style="color:var(--text-muted);font-size:0.7rem;font-weight:500;">${u.roleTitle}</small>
                  </div>
                </div>
                ${dmTasks > 0 ? `<span class="badge badge-warning">${dmTasks} مهمة</span>` : ''}
              </button>
            `;
          }).join('')}
        </div>
      </div>

      <!-- Left Panel: Messages Stream, Quick Templates & Task Composer -->
      <div class="chat-main-panel">
        <div style="padding:12px 16px;background:var(--bg-elevated);border-bottom:1px solid var(--border-color);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
          <div>
            <div style="font-weight:900;font-size:1rem;">${activeHeaderTitle}</div>
            <small style="color:var(--text-muted);">أي رسالة أو مهمة ترسلها تصل فوراً بصوت تنبيه طويل للمستخدمين المصرح لهم</small>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;">
            <button class="btn btn-sm btn-outline" onclick="insertQuickChatTemplate('📦 يرجى مراجعة وتحديث رصيد التخانة في جدول المخزن', 'task', 'warehouses')">+ مهمة جرد مخزن</button>
            <button class="btn btn-sm btn-outline" onclick="insertQuickChatTemplate('📋 يرجى تجهيز طلبية العميل بالتخانات والجودات المطلوبة ومراجعة البيان', 'task', 'production')">+ مهمة تجهيز طلبية عميل</button>
            <button class="btn btn-sm btn-outline" onclick="insertQuickChatTemplate('📤 تم تجهيز طلبية العميل ويرجى اعتماد إذن الصرف وتحميل السيارة', 'task', 'approvals')">+ طلب اعتماد إذن صرف</button>
            <button class="btn btn-sm btn-outline" onclick="insertQuickChatTemplate('💰 يرجى مراجعة حسابات العميل والمديونية ورصيد البالتات', 'task', 'accounting')">+ مراجعة حسابات عميل</button>
          </div>
        </div>

        <div id="chat-messages-scroll" class="chat-messages-list">
          ${filteredMsgs.length === 0 ? `
            <div style="margin:auto;text-align:center;color:var(--text-muted);padding:30px;">
              <div style="font-size:2.4rem;margin-bottom:8px;">💬</div>
              <div style="font-weight:800;font-size:1rem;color:var(--text-main);">لا توجد رسائل أو مهام في هذه الغرفة بعد</div>
              <small>اكتب رسالة عمل أو كلف أحد الحسابات بمهمة من الأسفل، وسيصل إشعار بصوت طويل فوراً</small>
            </div>
          ` : filteredMsgs.map(m => {
            const isMine = m.senderId === currentUser.id;
            const isTask = m.msgType === 'task';
            const isUrgent = m.msgType === 'urgent';
            const isCompleted = m.taskStatus === 'completed';

            return `
              <div class="chat-bubble ${isMine ? 'mine' : 'others'} ${isTask ? 'type-task' : ''} ${isUrgent ? 'type-urgent' : ''}">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:6px;">
                  <div style="display:flex;align-items:center;gap:6px;">
                    <span class="user-avatar" style="width:24px;height:24px;font-size:0.72rem;background:${m.senderColor || '#0f766e'};">${(m.senderName || 'م').charAt(0)}</span>
                    <strong style="font-size:0.86rem;">${m.senderName}</strong>
                    <small style="color:var(--text-muted);font-size:0.72rem;">(${m.senderRoleTitle || ''})</small>
                    ${isTask ? `<span class="badge badge-info">📌 مهمة عمل</span>` : ''}
                    ${isUrgent ? `<span class="badge badge-danger">🚨 عاجل</span>` : ''}
                  </div>
                  <small style="color:var(--text-muted);font-size:0.72rem;">
                    ${fmtDate(m.createdAt)} — ${new Date(m.createdAt).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}
                  </small>
                </div>

                <div style="font-size:0.95rem;font-weight:700;line-height:1.6;margin-bottom:8px;white-space:pre-wrap;">${m.text}</div>

                <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
                  <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                    ${m.assignedToUserName ? `
                      <span class="badge badge-warning">👤 موجهة إلى: ${m.assignedToUserName}</span>
                    ` : ''}
                    ${m.linkedTab && tabLabels[m.linkedTab] ? `
                      <button class="btn btn-sm btn-outline" style="padding:3px 10px;font-size:0.76rem;" onclick="setTab('${m.linkedTab}')">
                        🔗 فتح قسم: ${tabLabels[m.linkedTab]}
                      </button>
                    ` : ''}
                  </div>

                  ${isTask ? `
                    <div>
                      ${isCompleted ? `
                        <span class="badge badge-success" style="padding:5px 12px;">
                          ✅ تم التنفيذ بواسطة (${m.completedBy}) — ${new Date(m.completedAt).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      ` : `
                        <button class="btn btn-sm btn-success" onclick="completeChatTask('${m.id}')">
                          ✅ تأكيد إنجاز وتنفيذ المهمة
                        </button>
                      `}
                    </div>
                  ` : ''}
                </div>
              </div>
            `;
          }).join('')}
        </div>

        <!-- Composer Bar -->
        <form class="chat-input-area" onsubmit="sendChatMessage(event)">
          <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(160px, 1fr));gap:8px;margin-bottom:8px;">
            <select id="chat-msg-type" class="form-control" style="padding:6px 10px;font-size:0.82rem;font-weight:700;" onchange="chatMsgType=this.value">
              <option value="message" ${chatMsgType === 'message' ? 'selected' : ''}>💬 رسالة عمل عادية</option>
              <option value="task" ${chatMsgType === 'task' ? 'selected' : ''}>📌 تكليف مهمة عمل (تتطلب علامة إنجاز ✅)</option>
              <option value="urgent" ${chatMsgType === 'urgent' ? 'selected' : ''}>🚨 تنبيه عاجل (أولوية قصوى + صوت طويل)</option>
            </select>

            <select id="chat-assigned-user" class="form-control" style="padding:6px 10px;font-size:0.82rem;" onchange="chatAssignedUserId=this.value">
              <option value="">👥 توجيه للجميع في الغرفة أو اختر مسؤولاً...</option>
              ${state.users.map(u => `<option value="${u.id}" ${chatAssignedUserId === u.id ? 'selected' : ''}>👤 تكليف / توجيه إلى: ${u.name}</option>`).join('')}
            </select>

            <select id="chat-linked-tab" class="form-control" style="padding:6px 10px;font-size:0.82rem;" onchange="chatLinkedTab=this.value">
              <option value="">🔗 ربط بقسم في النظام (اختياري)...</option>
              <option value="warehouses" ${chatLinkedTab === 'warehouses' ? 'selected' : ''}>🏭 ربط بجدول المخازن والرصيد</option>
              <option value="production" ${chatLinkedTab === 'production' ? 'selected' : ''}>📋 ربط بأوامر تجهيز طلبية للعميل</option>
              <option value="approvals" ${chatLinkedTab === 'approvals' ? 'selected' : ''}>✅ ربط باعتماد أذون الصرف والسيارات</option>
              <option value="accounting" ${chatLinkedTab === 'accounting' ? 'selected' : ''}>💰 ربط بحسابات ومبيعات العملاء</option>
              <option value="reports" ${chatLinkedTab === 'reports' ? 'selected' : ''}>📈 ربط بالتقارير الشاملة</option>
            </select>
          </div>

          <div style="display:flex;gap:8px;">
            <input id="chat-text-input" class="form-control" style="flex:1;font-weight:700;" placeholder="اكتب رسالتك أو تفاصيل المهمة هنا واضغط إرسال..." required />
            <button type="submit" class="btn btn-primary" style="padding:10px 24px;">
              📤 إرسال وتنبيه صوتي
            </button>
          </div>
        </form>
      </div>
    </div>
  `;
}

// ============================================================================
// 1. DASHBOARD & QUICK VENEER CALCULATOR
// ============================================================================
function renderDashboard() {
  const inStockPallets = (state.pallets || []).filter(p => p.status === 'in_stock');
  const totalPallets = inStockPallets.length;
  const totalSheets = inStockPallets.reduce((s, p) => s + Number(p.sheetsCount || 0), 0);
  const totalAreaM2 = inStockPallets.reduce((s, p) => s + Number(p.areaM2 || 0), 0);
  const totalVolumeM3 = inStockPallets.reduce((s, p) => s + Number(p.volumeM3 || 0), 0);
  const totalVeneerValue = inStockPallets.reduce((s, p) => s + Number(p.totalValue || 0), 0);

  const rawLogsM3 = (state.rawMaterials || [])
    .filter(r => r.unit === 'م³')
    .reduce((s, r) => s + Number(r.quantity || 0), 0);

  const lowStockRaw = (state.rawMaterials || []).filter(r => Number(r.quantity) <= Number(r.minThreshold));
  const lowStockParts = (state.spareParts || []).filter(sp => Number(sp.quantity) <= Number(sp.minThreshold));
  const totalAlerts = lowStockRaw.length + lowStockParts.length;

  const completedOrders = (state.productionOrders || []).filter(o => o.status === 'completed' || o.stage === 'completed');
  const avgYield = completedOrders.length
    ? (completedOrders.reduce((s, o) => s + Number(o.yieldPercentage || 0), 0) / completedOrders.length).toFixed(1)
    : 0;

  const isExec = isFullAdmin(currentUser);
  const isWarehouseOrAdmin = currentUser.roleKey === 'admin_manager' || currentUser.roleKey === 'warehouse_keeper' || isExec;
  const isAccountantRole = ['accountant', 'accounts_manager', 'accounting_manager'].includes(currentUser.roleKey) || isExec;

  const prepOrdersForWarehouse = (state.productionOrders || []).filter(o => (o.stage || o.status) === 'pending_warehouse_prep');
  const carDispatchOrdersForWarehouse = (state.productionOrders || []).filter(o => (o.stage || o.status) === 'ready_for_car_dispatch');
  const execPendingOrders = (state.productionOrders || []).filter(o => (o.stage || o.status) === 'pending_executive');
  const accountantPendingOrders = (state.productionOrders || []).filter(o => (o.stage || o.status) === 'pending_accountant_release');

  const activeVisibleOrders = (state.productionOrders || []).filter(o => {
    const st = o.stage || o.status;
    if (st === 'completed') return false;
    return canUserSeeOrderInPrep(currentUser, o);
  });

  const pendingReqs = (state.approvalRequests || []).filter(r => r.stage === 'pending_financial' || r.stage === 'pending_warehouse');
  const pendingSalesReturns = (state.salesReturns || []).filter(r => r.status === 'pending_approval');
  const totalActionableOrders = activeVisibleOrders.length + pendingReqs.length + pendingSalesReturns.length;

  // Quick calculator computation
  const qcMetrics = calculateVeneerMetrics(
    quickCalc.lengthCm,
    quickCalc.widthCm,
    quickCalc.thicknessMm,
    Number(quickCalc.sheetsPerPallet) * Number(quickCalc.palletsCount)
  );
  const qcTotalSheets = Number(quickCalc.sheetsPerPallet) * Number(quickCalc.palletsCount);
  const qcTotalValue = qcMetrics.totalVolumeM3 * Number(quickCalc.pricePerM3 || 0);

  return `
    ${pendingSalesReturns.length > 0 && canApproveSalesReturn(currentUser) ? `
      <div class="card" style="background:rgba(124,58,237,0.12);border:2px solid #7c3aed;padding:16px 20px;margin-bottom:18px;">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;">
          <div>
            <div style="font-weight:900;font-size:1.06rem;color:#6d28d9;">
              🔄 بانتظار موافقة (المدير التنفيذي أو مدير المشروعات أو المحاسب فقط): يوجد (${pendingSalesReturns.length}) طلب مرتجع مبيعات ليدخل رصيد المخزن مرة أخرى!
            </div>
            <div style="font-size:0.88rem;margin-top:6px;display:flex;flex-direction:column;gap:4px;">
              ${pendingSalesReturns.map(sr => `
                <div>
                  • <strong>${sr.returnNumber}</strong> — العميل: <strong>${sr.clientName || 'عميل'}</strong> — الكمية: <strong>${fmtNum(sr.sheetsCount || 0, 0)} قطعة</strong> (${sr.thkMm} مم ${sr.directionLabel || ''} × ${sr.gradeName || ''}) — مسجل بواسطة: ${sr.requestedBy || ''}
                  <button class="btn btn-sm btn-success" style="margin-right:8px;padding:3px 10px;" onclick="approveSalesReturn('${sr.id}')">✅ موافقة وإدخال الكمية للمخزن الآن</button>
                </div>
              `).join('')}
            </div>
          </div>
          <button class="btn btn-primary" style="background:#7c3aed;" onclick="activeWarehouseSubTab='finished'; setTab('warehouses');">
            🔄 عرض سجل مرتجعات المبيعات
          </button>
        </div>
      </div>
    ` : ''}

    ${pendingSalesReturns.length > 0 && !canApproveSalesReturn(currentUser) && isWarehouseOrAdmin ? `
      <div class="card" style="background:rgba(245,158,11,0.12);border:2px solid #f59e0b;padding:14px 18px;margin-bottom:18px;">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;">
          <div>
            <div style="font-weight:900;font-size:1rem;color:#b45309;">
              ⏳ يوجد (${pendingSalesReturns.length}) مرتجع مبيعات مسجل وبانتظار موافقة (المدير التنفيذي أو مدير المشروعات أو المحاسب فقط) ليدخل رصيد المخزن مرة أخرى.
            </div>
            <div style="font-size:0.85rem;margin-top:4px;">
              ${pendingSalesReturns.map(sr => `<strong>${sr.returnNumber}</strong> (${fmtNum(sr.sheetsCount || 0, 0)} قطعة — ${sr.thkMm} مم ${sr.directionLabel || ''} × ${sr.gradeName || ''})`).join(' — ')}
            </div>
          </div>
          <button class="btn btn-sm btn-outline" onclick="activeWarehouseSubTab='finished'; setTab('warehouses');">عرض حالة المرتجع</button>
        </div>
      </div>
    ` : ''}

    ${isWarehouseOrAdmin && prepOrdersForWarehouse.length > 0 ? `
      <div class="card" style="background:rgba(217,119,6,0.12);border:2px solid #d97706;padding:16px 20px;margin-bottom:18px;">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;">
          <div>
            <div style="font-weight:900;font-size:1.08rem;color:#b45309;">
              📦 تنبيه فوري للمدير الإداري وأمين المخزن: يوجد (${prepOrdersForWarehouse.length}) أمر تجهيز طلبية معتمد وجاهز للتجهيز الآن!
            </div>
            <div style="font-size:0.9rem;margin-top:6px;display:flex;flex-direction:column;gap:6px;">
              ${prepOrdersForWarehouse.map(o => `
                <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                  <span>• <strong>${o.orderNumber}</strong> للعميل <strong>${o.clientName}</strong> (${fmtNum(o.totalSheetsCount || 0, 0)} قطعة)</span>
                  <button type="button" class="btn btn-sm btn-outline" onclick="openClientOrderStatementModal('${o.id}')">📄 عرض الكميات</button>
                  <button type="button" class="btn btn-sm btn-success" onclick="approveOrderWarehousePrep('${o.id}')">✅ موافقة التجهيز والخروج الآن</button>
                </div>
              `).join('')}
            </div>
          </div>
          <button type="button" class="btn btn-primary" onclick="setTab('production')">
            📋 فتح جميع أوامر تجهيز الطلبيات
          </button>
        </div>
      </div>
    ` : ''}

    ${isWarehouseOrAdmin && carDispatchOrdersForWarehouse.length > 0 ? `
      <div class="card" style="background:rgba(220,38,38,0.1);border:2px solid var(--danger);padding:16px 20px;margin-bottom:18px;">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;">
          <div>
            <div style="font-weight:900;font-size:1.08rem;color:var(--danger);">
              🚚 أمر فوري بصرف الطلبية وتحميل السيارة: يوجد (${carDispatchOrdersForWarehouse.length}) طلبية معتمدة من الحسابات وجاهزة للتحميل!
            </div>
            <div style="font-size:0.9rem;margin-top:6px;display:flex;flex-direction:column;gap:6px;">
              ${carDispatchOrdersForWarehouse.map(o => `
                <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                  <span>• <strong>${o.orderNumber}</strong> للعميل <strong>${o.clientName}</strong> (${fmtNum(o.totalSheetsCount || 0, 0)} قطعة)</span>
                  <button type="button" class="btn btn-sm btn-danger" onclick="openVehicleDispatchVoucherModal('${o.id}')">🚚 عمل إذن صرف السيارة الآن</button>
                </div>
              `).join('')}
            </div>
          </div>
          <button type="button" class="btn btn-danger" onclick="setTab('approvals')">
            🚚 فتح أذون تحميل وصرف السيارات
          </button>
        </div>
      </div>
    ` : ''}

    ${isExec && execPendingOrders.length > 0 ? `
      <div class="card" style="background:rgba(37,99,235,0.1);border:2px solid #2563eb;padding:16px 20px;margin-bottom:18px;">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;">
          <div>
            <div style="font-weight:900;font-size:1.05rem;color:#1d4ed8;">
              📋 بانتظار موافقة المدير التنفيذي / مدير المشروعات: يوجد (${execPendingOrders.length}) بيان طلبية جديد ليظهر للمدير الإداري وأمين المخزن!
            </div>
          </div>
          <button class="btn btn-primary" onclick="setTab('production')">
            ✅ مراجعة وموافقة الآن
          </button>
        </div>
      </div>
    ` : ''}

    ${isAccountantRole && accountantPendingOrders.length > 0 ? `
      <div class="card" style="background:rgba(124,58,237,0.1);border:2px solid #7c3aed;padding:16px 20px;margin-bottom:18px;">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;">
          <div>
            <div style="font-weight:900;font-size:1.05rem;color:#7c3aed;">
              💳 تنبيه للحسابات: يوجد (${accountantPendingOrders.length}) طلبية تم تجهيزها بالمخزن وبانتظار عمل حسابات العميل واعتماد إذن الصرف!
            </div>
          </div>
          <button class="btn btn-primary" style="background:#7c3aed;" onclick="setTab('approvals')">
            💳 فتح اعتماد أذون الصرف الآن
          </button>
        </div>
      </div>
    ` : ''}

    <!-- Top Stats -->
    <div class="stats-grid">
      <div class="stat-card">
        <span class="stat-title">رصيد كميات مخزن القشرة التامة (250×125)</span>
        <div class="stat-value">${fmtNum(totalSheets, 0)} فرخ</div>
        <div class="stat-sub"><strong>${fmtNum(totalVolumeM3, 3)}</strong> م³ | <strong>${totalPallets}</strong> بالتة | <strong>${fmtNum(totalAreaM2, 1)}</strong> م²</div>
      </div>

      <div class="stat-card accent">
        <span class="stat-title">${canSeeFinancialPrices() ? 'قيمة مخزون القشرة الجاهزة' : 'إجمالي المساحة والحجم للقشرة بالمخزن'}</span>
        <div class="stat-value">${canSeeFinancialPrices() ? fmtMoney(totalVeneerValue) : fmtNum(totalAreaM2, 2) + ' م²'}</div>
        <div class="stat-sub">مصنفة حسب التخانة (قص / سدا) ودرجة الجودة (A, B, C)</div>
      </div>

      <div class="stat-card info">
        <span class="stat-title">رصيد الخشب الخام (الجذوع)</span>
        <div class="stat-value">${fmtNum(rawLogsM3, 2)} م³</div>
        <div class="stat-sub">متوسط نسبة التصافي في التشغيل: <strong>${avgYield}%</strong></div>
      </div>

      <div class="stat-card ${totalActionableOrders > 0 ? 'danger' : 'success'}" style="cursor:pointer;" onclick="setTab('production')">
        <span class="stat-title">أوامر التجهيز والمرتجعات الجارية</span>
        <div class="stat-value">${totalActionableOrders} طلب جاري</div>
        <div class="stat-sub">مرتجعات بانتظار الموافقة: <strong>${pendingSalesReturns.length}</strong> | نواقص الخامات: <strong>${totalAlerts}</strong></div>
      </div>
    </div>

    <!-- Quick Action Buttons -->
    <div class="card" style="padding:16px 20px;">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;">
        <div style="font-weight:800;font-size:0.98rem;">⚡ حركات المخازن والإجراءات السريعة (${currentUser.name}):</div>
        <div style="display:flex;flex-wrap:wrap;gap:8px;">
          ${hasPerm('warehouseIssueReceive') ? `
            <button class="btn btn-primary" onclick="openWarehouseOpShortcut('in')">📥 إضافة كميات إنتاج للمخزن</button>
            <button class="btn" style="background:#7c3aed;color:#fff;font-weight:800;" onclick="openWarehouseOpShortcut('sales_return')">🔄 إضافة مرتجع مبيعات (يدخل المخزن بعد الموافقة)</button>
            <button class="btn btn-success" onclick="openWarehouseOpShortcut('out')">📤 خروج الكميات حسب المبيعات</button>
            <button class="btn btn-accent" onclick="openWarehouseOpShortcut('rework')">♻️ خروج الكميات لإعادة التشغيل</button>
            <button class="btn btn-outline" onclick="openAddPalletModal()">➕ إضافة بالتة بالباركود</button>
          ` : ''}
          ${hasPerm('production') && !isWarehouseKeeperOnly(currentUser) ? `
            <button class="btn btn-accent" onclick="openNewClientOrderPrepModal()">📋 أمر تجهيز طلبية جديدة للعميل</button>
          ` : ''}
          ${hasPerm('approvals') ? `
            <button class="btn btn-outline" onclick="setTab('approvals')">✅ أذون الصرف وتحميل السيارات</button>
          ` : ''}
          <button class="btn btn-outline" onclick="setTab('warehouses')">🔍 أرصدة كميات المخازن الأربعة</button>
        </div>
      </div>
    </div>

    <!-- Interactive Wood Veneer Calculator -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">📐 حاسبة القشرة الخشبية الفورية (تحويل البالتة والأفرخ إلى م² و م³)</div>
        <span class="badge badge-info">المقاس المعتمد: 125 سم × 250 سم = 3.125 م² للفرخ (أو مقاس خاص)</span>
      </div>
      <div class="form-grid">
        <div class="form-group">
          <label>طول الفرخ (سم)</label>
          <input id="qc-len-input" type="number" step="0.5" class="form-control" value="${quickCalc.lengthCm}" oninput="quickCalc.lengthCm=this.value; updateQuickCalcPreview();" />
        </div>
        <div class="form-group">
          <label>عرض الفرخ (سم)</label>
          <input id="qc-wid-input" type="number" step="0.5" class="form-control" value="${quickCalc.widthCm}" oninput="quickCalc.widthCm=this.value; updateQuickCalcPreview();" />
        </div>
        <div class="form-group">
          <label>التخانة (مم)</label>
          <input id="qc-thk-input" type="number" step="0.05" class="form-control" value="${quickCalc.thicknessMm}" oninput="quickCalc.thicknessMm=this.value; updateQuickCalcPreview();" />
        </div>
        <div class="form-group">
          <label>عدد الأفرخ في البالتة</label>
          <input id="qc-sheets-input" type="number" class="form-control" value="${quickCalc.sheetsPerPallet}" oninput="quickCalc.sheetsPerPallet=this.value; updateQuickCalcPreview();" />
        </div>
        <div class="form-group">
          <label>عدد البالتات</label>
          <input id="qc-pallets-input" type="number" class="form-control" value="${quickCalc.palletsCount}" oninput="quickCalc.palletsCount=this.value; updateQuickCalcPreview();" />
        </div>
        ${canSeeFinancialPrices() ? `
        <div class="form-group">
          <label>سعر المتر المكعب (م³)</label>
          <input id="qc-price-input" type="number" class="form-control" value="${quickCalc.pricePerM3}" oninput="quickCalc.pricePerM3=this.value; updateQuickCalcPreview();" />
        </div>
        ` : ''}
      </div>

      <div id="qc-live-preview-box" class="calc-preview-box">
        <div class="calc-preview-item">
          <span>مساحة الفرخ الواحد</span>
          <strong>${fmtNum(qcMetrics.sheetAreaM2, 4)} م²</strong>
        </div>
        <div class="calc-preview-item">
          <span>إجمالي عدد الأفرخ</span>
          <strong>${fmtNum(qcTotalSheets, 0)} فرخ</strong>
        </div>
        <div class="calc-preview-item">
          <span>إجمالي المساحة (م²)</span>
          <strong>${fmtNum(qcMetrics.totalAreaM2, 2)} م²</strong>
        </div>
        <div class="calc-preview-item">
          <span>إجمالي الحجم الفعلي (م³)</span>
          <strong>${fmtNum(qcMetrics.totalVolumeM3, 4)} م³</strong>
        </div>
        ${canSeeFinancialPrices() ? `
        <div class="calc-preview-item">
          <span>القيمة الإجمالية التقديرية</span>
          <strong>${fmtMoney(qcTotalValue)}</strong>
        </div>
        ` : ''}
      </div>
    </div>

    <!-- Two Columns: Active Client Preparation Orders & Warehouse Summary by Grade/Thickness -->
    <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(320px, 1fr));gap:16px;">
      <div class="card">
        <div class="card-header">
          <div class="card-title">⏳ أوامر تجهيز الطلبيات وأذون الصرف الجارية</div>
          <button type="button" class="btn btn-sm btn-primary" onclick="setTab('production')">عرض أوامر التجهيز (${activeVisibleOrders.length})</button>
        </div>
        ${activeVisibleOrders.length === 0 ? `<p style="color:var(--text-muted);font-size:0.9rem;">لا توجد أوامر تجهيز طلبيات معلقة حالياً.</p>` : `
          <div class="table-responsive">
            <table>
              <thead>
                <tr>
                  <th>رقم الطلبية</th>
                  <th>العميل</th>
                  <th>إجمالي الكمية</th>
                  <th>المرحلة الحالية</th>
                  <th>إجراء سريع</th>
                </tr>
              </thead>
              <tbody>
                ${activeVisibleOrders.map(o => {
                  const st = o.stage || o.status || 'pending_executive';
                  return `
                  <tr>
                    <td><strong>${o.orderNumber}</strong><br/><small>${o.date || ''}</small></td>
                    <td><strong>${o.clientName}</strong></td>
                    <td><strong>${fmtNum(o.totalSheetsCount || 0, 0)} قطعة</strong> (${fmtNum(o.totalVolumeM3 || 0, 3)} م³)</td>
                    <td>${getOrderStageBadge(o)}</td>
                    <td>
                      <div style="display:flex;gap:4px;flex-wrap:wrap;">
                        <button type="button" class="btn btn-sm btn-outline" onclick="openClientOrderStatementModal('${o.id}')">📄 البيان</button>
                        ${st === 'pending_warehouse_prep' && isWarehouseOrAdmin ? `
                          <button type="button" class="btn btn-sm btn-success" onclick="approveOrderWarehousePrep('${o.id}')">✅ موافقة التجهيز</button>
                        ` : ''}
                        ${st === 'ready_for_car_dispatch' && isWarehouseOrAdmin ? `
                          <button type="button" class="btn btn-sm btn-danger" onclick="openVehicleDispatchVoucherModal('${o.id}')">🚚 إذن السيارة</button>
                        ` : ''}
                        ${st === 'pending_executive' && isExec ? `
                          <button type="button" class="btn btn-sm btn-primary" onclick="approveOrderExecutive('${o.id}')">✅ موافقة</button>
                        ` : ''}
                        ${st === 'pending_accountant_release' && isAccountantRole ? `
                          <button type="button" class="btn btn-sm btn-accent" onclick="openAccountantReleaseModal('${o.id}')">💳 اعتماد الصرف</button>
                        ` : ''}
                      </div>
                    </td>
                  </tr>
                `;
                }).join('')}
              </tbody>
            </table>
          </div>
        `}
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title">🌲 ملخص أرصدة القشرة المتاحة حسب الجودة والتخانة</div>
          <button class="btn btn-sm btn-outline" onclick="setTab('warehouses')">تفاصيل البالتات</button>
        </div>
        <div class="table-responsive">
          <table>
            <thead>
              <tr>
                <th>نوع الخشب</th>
                <th>التخانة</th>
                <th>درجة الجودة</th>
                <th>عدد البالتات</th>
                <th>عدد الأفرخ</th>
                <th>الحجم (م³)</th>
              </tr>
            </thead>
            <tbody>
              ${inStockPallets.map(p => `
                <tr>
                  <td><strong>${p.woodTypeName}</strong></td>
                  <td><span class="badge badge-info">${p.thicknessMm} مم</span></td>
                  <td>${p.gradeName}</td>
                  <td>1 بالتة (${p.palletCode})</td>
                  <td>${fmtNum(p.sheetsCount, 0)} فرخ</td>
                  <td><strong>${fmtNum(p.volumeM3, 4)} م³</strong></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

function updateQuickCalcPreview() {
  const qcTotalSheets = Number(quickCalc.sheetsPerPallet || 0) * Number(quickCalc.palletsCount || 0);
  const qcMetrics = calculateVeneerMetrics(
    quickCalc.lengthCm,
    quickCalc.widthCm,
    quickCalc.thicknessMm,
    qcTotalSheets
  );
  const qcTotalValue = qcMetrics.totalVolumeM3 * Number(quickCalc.pricePerM3 || 0);
  const box = document.getElementById('qc-live-preview-box');
  if (box) {
    box.innerHTML = `
      <div class="calc-preview-item">
        <span>مساحة الفرخ الواحد</span>
        <strong>${fmtNum(qcMetrics.sheetAreaM2, 4)} م²</strong>
      </div>
      <div class="calc-preview-item">
        <span>إجمالي عدد الأفرخ</span>
        <strong>${fmtNum(qcTotalSheets, 0)} فرخ</strong>
      </div>
      <div class="calc-preview-item">
        <span>إجمالي المساحة (م²)</span>
        <strong>${fmtNum(qcMetrics.totalAreaM2, 2)} م²</strong>
      </div>
      <div class="calc-preview-item">
        <span>إجمالي الحجم الفعلي (م³)</span>
        <strong>${fmtNum(qcMetrics.totalVolumeM3, 4)} م³</strong>
      </div>
      ${canSeeFinancialPrices() ? `
      <div class="calc-preview-item">
        <span>القيمة الإجمالية التقديرية</span>
        <strong>${fmtMoney(qcTotalValue)}</strong>
      </div>
      ` : ''}
    `;
  }
}

// ============================================================================
// 2. THE 4 SPECIALIZED WAREHOUSES
// ============================================================================
function renderWarehouses() {
  return `
    <div class="tabs-bar">
      <button class="tab-btn ${activeWarehouseSubTab === 'finished' ? 'active' : ''}" onclick="activeWarehouseSubTab='finished'; render();">
        1️⃣ مخزن المنتج التام (القشرة 250×125)
      </button>
      <button class="tab-btn ${activeWarehouseSubTab === 'raw' ? 'active' : ''}" onclick="activeWarehouseSubTab='raw'; render();">
        2️⃣ مخزن الخامات (الجذوع والمستلزمات)
      </button>
      <button class="tab-btn ${activeWarehouseSubTab === 'scrap' ? 'active' : ''}" onclick="activeWarehouseSubTab='scrap'; render();">
        3️⃣ مخزن الهالك والدرجة الثانية والقصاقيص
      </button>
      <button class="tab-btn ${activeWarehouseSubTab === 'spare' ? 'active' : ''}" onclick="activeWarehouseSubTab='spare'; render();">
        4️⃣ مخزن قطع الغيار والمهمات
      </button>
      <button class="tab-btn ${activeWarehouseSubTab === 'movements' ? 'active' : ''}" onclick="activeWarehouseSubTab='movements'; render();">
        📋 سجل حركات المخازن والأذون
      </button>
    </div>

    ${activeWarehouseSubTab === 'finished' ? renderFinishedVeneerWarehouse() : ''}
    ${activeWarehouseSubTab === 'raw' ? renderRawMaterialsWarehouse() : ''}
    ${activeWarehouseSubTab === 'scrap' ? renderScrapWarehouse() : ''}
    ${activeWarehouseSubTab === 'spare' ? renderSparePartsWarehouse() : ''}
    ${activeWarehouseSubTab === 'movements' ? renderWarehouseMovements() : ''}
  `;
}

function matchPalletToThicknessRow(p, t) {
  if (!p || !t) return false;
  if (p.thicknessId && t.id && p.thicknessId === t.id) return true;
  const pDir = p.direction || 'qas';
  const tDir = t.direction || 'qas';
  return Number(p.thicknessMm) === Number(t.mm) && pDir === tDir;
}

function matchPalletToGrade(p, gradeId, gradeName = '') {
  if (!p) return false;
  if (gradeId && p.gradeId === gradeId) return true;
  const gObj = (state?.catalog?.grades || []).find(g => g.id === gradeId || (gradeName && (g.code === gradeName || g.name === gradeName)));
  if (gObj) {
    if (p.gradeId === gObj.id) return true;
    if (p.gradeCode && p.gradeCode === gObj.code) return true;
    if (p.gradeName && (p.gradeName === gObj.code || p.gradeName === gObj.name)) return true;
  }
  if (gradeName && (p.gradeCode === gradeName || p.gradeName === gradeName)) return true;
  return false;
}

function renderFinishedVeneerWarehouse() {
  const thicknesses = [...(state.catalog.thicknesses || [])].sort((a, b) => {
    if (Number(a.mm) !== Number(b.mm)) return Number(a.mm) - Number(b.mm);
    return (a.direction || 'qas').localeCompare(b.direction || 'qas');
  });
  const grades = state.catalog.grades || [];
  const presetDims = getPresetVeneerDimensions();
  const inStockPallets = (state.pallets || []).filter(p => {
    if (p.status !== 'in_stock') return false;
    if (Number(p.sheetsCount || 0) <= 0) return false;
    if (veneerFilterWood !== 'all' && p.woodTypeId !== veneerFilterWood) return false;
    if (!matchesPalletDimensionFilter(p, veneerFilterDimension)) return false;
    return true;
  });

  // Helper to get stock & sales metrics for a cell (thicknessRow t x gradeId)
  function getCellData(t, gradeId) {
    const cellPallets = inStockPallets.filter(
      p => matchPalletToThicknessRow(p, t) && matchPalletToGrade(p, gradeId)
    );
    const sheets = cellPallets.reduce((s, p) => s + Number(p.sheetsCount || 0), 0);
    const areaM2 = cellPallets.reduce((s, p) => s + Number(p.areaM2 || 0), 0);
    const volumeM3 = cellPallets.reduce((s, p) => s + Number(p.volumeM3 || 0), 0);
    const unitPiecePrice = getCellUnitPrice(t.id, gradeId, t.mm, t.direction);
    const stockValueByPiece = +(sheets * unitPiecePrice).toFixed(2);

    // Track custom dimensions inside this cell
    const customDimBreakdown = [];
    const customMap = new Map();
    for (const p of cellPallets) {
      if (!isStandardVeneerDimension(p.lengthCm, p.widthCm)) {
        const lbl = `${Number(p.widthCm || 125)}×${Number(p.lengthCm || 250)}`;
        customMap.set(lbl, (customMap.get(lbl) || 0) + Number(p.sheetsCount || 0));
      }
    }
    for (const [dimLbl, dimSheets] of customMap.entries()) {
      customDimBreakdown.push(`${dimLbl}: ${fmtNum(dimSheets, 0)} ق`);
    }

    // Calculate sold pieces & revenue from movements for this cell (supporting both . and _dot_ keys)
    const targetSafeKey = getCellPriceKey(t.id, gradeId);
    const soldMovements = (state.warehouseMovements || []).filter(m => {
      if (m.direction !== 'out' || m.movementCategory !== 'sales_exit') return false;
      const mSafeKey = String(m.cellKey || '').trim().replace(/[.#$/\[\]]/g, '_dot_');
      return mSafeKey === targetSafeKey;
    });
    const soldSheets = soldMovements.reduce((s, m) => s + Number(m.sheetsCount || 0), 0);
    const soldRevenue = soldMovements.reduce((s, m) => s + Number(m.totalSaleAmount || 0), 0);

    return {
      palletsCount: cellPallets.length,
      sheets,
      areaM2: +areaM2.toFixed(2),
      volumeM3: +volumeM3.toFixed(4),
      unitPiecePrice,
      stockValueByPiece,
      soldSheets,
      soldRevenue: +soldRevenue.toFixed(2),
      customDimBreakdown
    };
  }

  // Check total stock across ALL wood types before allowing deletion of a thickness row or grade
  function getTotalSheetsForThicknessRowAllWoods(t) {
    return (state.pallets || [])
      .filter(p => p.status === 'in_stock' && matchPalletToThicknessRow(p, t))
      .reduce((s, p) => s + Number(p.sheetsCount || 0), 0);
  }

  function getTotalSheetsForGradeAllWoods(gradeId) {
    return (state.pallets || [])
      .filter(p => p.status === 'in_stock' && matchPalletToGrade(p, gradeId))
      .reduce((s, p) => s + Number(p.sheetsCount || 0), 0);
  }

  const grandSheets = inStockPallets.reduce((s, p) => s + Number(p.sheetsCount || 0), 0);
  const grandM2 = inStockPallets.reduce((s, p) => s + Number(p.areaM2 || 0), 0);
  const grandM3 = inStockPallets.reduce((s, p) => s + Number(p.volumeM3 || 0), 0);

  let grandStockValueByPiece = 0;
  let grandSoldRevenue = 0;
  let grandSoldSheets = 0;
  for (const t of thicknesses) {
    for (const g of grades) {
      const cd = getCellData(t, g.id);
      grandStockValueByPiece += cd.stockValueByPiece;
      grandSoldRevenue += cd.soldRevenue;
      grandSoldSheets += cd.soldSheets;
    }
  }

  const tableClass = matrixCompactMode ? 'matrix-table' : 'matrix-table matrix-normal';

  return `
    <!-- Quick Warehouse Operations Bar (إضافة كميات إنتاج | إضافة مرتجع مبيعات | خروج حسب المبيعات | خروج لإعادة التشغيل) -->
    <div class="card" style="background:linear-gradient(135deg, rgba(15,118,110,0.08), rgba(124,58,237,0.08));border:2px solid var(--primary);padding:12px 16px;margin-bottom:14px;">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;">
        <div>
          <div style="font-weight:900;font-size:0.96rem;color:var(--primary);">
            ⚙️ حركات كميات المخزن المعتمدة (إنتاج / مرتجع مبيعات / خروج مبيعات / إعادة تشغيل):
          </div>
          <small style="color:var(--text-muted);font-size:0.78rem;">
            ⚠️ <strong>ملاحظة هامة:</strong> مرتجع المبيعات لا يدخل رصيد المخزن مرة أخرى إلا بعد موافقة <strong>(المدير التنفيذي أو مدير المشروعات أو المحاسب فقط)</strong>.
          </small>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <button class="btn btn-sm btn-primary" onclick="openWarehouseOpShortcut('in')">📥 إضافة كميات إنتاج</button>
          <button class="btn btn-sm" style="background:#7c3aed;color:#fff;font-weight:800;" onclick="openWarehouseOpShortcut('sales_return')">🔄 إضافة مرتجع مبيعات</button>
          <button class="btn btn-sm btn-success" onclick="openWarehouseOpShortcut('out')">📤 خروج الكميات حسب المبيعات</button>
          <button class="btn btn-sm btn-accent" onclick="openWarehouseOpShortcut('rework')">♻️ خروج الكميات لإعادة التشغيل</button>
        </div>
      </div>
    </div>

    ${renderSalesReturnsSection()}

    <div class="card" style="padding:14px 16px;">
      <div class="card-header" style="margin-bottom:10px;">
        <div>
          <div class="card-title" style="font-size:1rem;">🪵 جدول مصفوفة مخزن القشرة الخشبية (التخانة [قص / سدا] × الجودة) — مقاس 250×125 سم</div>
          <small style="color:var(--text-muted);font-size:0.76rem;">
            اضغط على أي خلية لتسجيل (📥 إضافة كميات إنتاج / 🔄 مرتجع مبيعات / 📤 خروج حسب المبيعات / ♻️ خروج لإعادة التشغيل)
          </small>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <button class="btn btn-sm btn-outline" onclick="matrixCompactMode=!matrixCompactMode; render();" title="تبديل حجم الجداول">
            ${matrixCompactMode ? '🔍 الحجم: مصغر ✓ (اضغط للتكبير)' : '🔍 الحجم: عادي (اضغط للتصغير)'}
          </button>
          <button class="btn btn-sm btn-primary" onclick="printVeneerQuantitiesMatrixPdf()">
            🖨️ طباعة جدول الكميات PDF
          </button>
          ${canSeeFinancialPrices() ? `
            <button class="btn btn-sm btn-accent" onclick="printVeneerPricesMatrixPdf()">
              🖨️ طباعة جدول الأسعار PDF
            </button>
            <button class="btn btn-sm btn-success" onclick="printBothMatricesPdf()">
              🖨️ طباعة الكميات + الأسعار PDF
            </button>
          ` : ''}
          <button class="btn btn-sm ${veneerViewMode === 'matrix' ? 'btn-primary' : 'btn-outline'}" onclick="veneerViewMode='matrix'; render();">
            📊 عرض الجداول
          </button>
          <button class="btn btn-sm ${veneerViewMode === 'pallets' ? 'btn-primary' : 'btn-outline'}" onclick="veneerViewMode='pallets'; render();">
            🏷️ البالتات (${inStockPallets.length})
          </button>
        </div>
      </div>

      <!-- Top Bar: Wood Filter + Dimension Filter + Quick Add Thickness (Cut/Warp) / Custom Dimension / Grade -->
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:12px;background:var(--bg-elevated);padding:8px 12px;border-radius:10px;">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <label style="font-weight:700;font-size:0.8rem;">نوع الخشب:</label>
          <select class="form-control" style="min-width:175px;padding:4px 10px;font-size:0.82rem;" onchange="veneerFilterWood=this.value; render();">
            <option value="all" ${veneerFilterWood === 'all' ? 'selected' : ''}>🌳 جميع الأخشاب بالمخزن</option>
            ${state.catalog.woodTypes.map(w => `<option value="${w.id}" ${veneerFilterWood === w.id ? 'selected' : ''}>${w.name}</option>`).join('')}
          </select>

          <label style="font-weight:700;font-size:0.8rem;">المقاس:</label>
          <select class="form-control" style="min-width:210px;padding:4px 10px;font-size:0.82rem;border-color:var(--primary);font-weight:700;" onchange="veneerFilterDimension=this.value; render();">
            <option value="all" ${veneerFilterDimension === 'all' ? 'selected' : ''}>📐 كل المقاسات (المعتمد 125×250 + الخاصة)</option>
            <option value="standard" ${veneerFilterDimension === 'standard' ? 'selected' : ''}>📏 المقاس المعتمد فقط (125×250 سم)</option>
            <option value="custom" ${veneerFilterDimension === 'custom' ? 'selected' : ''}>✨ المقاسات الخاصة فقط (مقاسات الشركات)</option>
            ${presetDims.filter(d => !d.isStandard).map(d => `<option value="${d.key}" ${veneerFilterDimension === d.key ? 'selected' : ''}>📐 مقاس خاص: ${d.label}</option>`).join('')}
          </select>
        </div>

        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <button class="btn btn-sm btn-primary" onclick="openAddThicknessModal()">➕ تخانة محددة (قص/سدا)</button>
          <button class="btn btn-sm" style="background:#d97706;color:#fff;font-weight:800;" onclick="openCustomDimensionsModal()">📐 إضافة مقاس خاص للشركات</button>
          <button class="btn btn-sm btn-accent" onclick="addGradePrompt()">➕ جودة جديدة</button>
          <button class="btn btn-sm btn-outline" onclick="openAddPalletModal()">📦 بالتة بالباركود</button>
        </div>
      </div>

      ${veneerViewMode === 'matrix' ? `
        <!-- TABLE 1: 2D WAREHOUSE STOCK MATRIX (THICKNESS [QAS/SADA] x GRADE) -->
        <div style="margin-bottom:6px;font-weight:800;font-size:0.9rem;color:var(--primary);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px;">
          <span>1️⃣ جدول أرصدة كميات القشرة بالقطعة (الفرخ) والمتر المكعب (م³) — يدعم المقاس المعتمد (125×250 سم) والمقاسات الخاصة</span>
          <div style="display:flex;align-items:center;gap:6px;">
            <button class="btn btn-sm btn-outline" style="padding:3px 9px;font-size:0.74rem;border-color:var(--primary);color:var(--primary);" onclick="printVeneerQuantitiesMatrixPdf()">
              🖨️ طباعة / تصدير جدول الكميات PDF
            </button>
          </div>
        </div>
        <div class="matrix-wrapper" style="margin-bottom:18px;">
          <table class="${tableClass}">
            <thead>
              <tr>
                <th class="matrix-corner-th">
                  <div style="display:flex;flex-direction:column;gap:3px;align-items:flex-start;">
                    <span>⬇️ التخانة \\ الجودة ⬅️</span>
                    <button class="btn btn-sm" style="background:#fbbf24;color:#0f172a;padding:2px 6px;font-size:0.66rem;" onclick="openAddThicknessModal()">
                      + تخانة (قص/سدا)
                    </button>
                  </div>
                </th>

                ${grades.map(g => {
                  const totalGradeSheetsAll = getTotalSheetsForGradeAllWoods(g.id);
                  const canDeleteGrade = totalGradeSheetsAll === 0;
                  return `
                    <th class="matrix-grade-th" style="border-top:3px solid ${g.color || '#3b82f6'};">
                      <div style="display:flex;align-items:center;justify-content:space-between;gap:4px;">
                        <span class="badge" style="background:${g.color || '#3b82f6'};color:#fff;font-size:0.7rem;padding:2px 7px;">${g.code}</span>
                        <button class="del-icon-btn" style="padding:1px 4px;font-size:0.7rem;"
                          title="${canDeleteGrade ? 'إلغاء هذه الجودة (الرصيد صفر)' : 'لا يمكن إلغاء جودة لها رصيد بالمخزن (' + totalGradeSheetsAll + ' قطعة)'}"
                          onclick="deleteGradeFromMatrix('${g.id}')">
                          🗑️
                        </button>
                      </div>
                      <div style="margin-top:2px;font-size:0.76rem;font-weight:800;">${g.name}</div>
                    </th>
                  `;
                }).join('')}

                <th class="matrix-grade-th" style="min-width:100px;background:rgba(180,83,9,0.08);">
                  <button class="btn btn-sm btn-primary" onclick="addGradePrompt()" style="width:100%;margin-bottom:3px;padding:2px 6px;font-size:0.66rem;">+ جودة</button>
                  <div style="font-size:0.75rem;font-weight:800;color:var(--primary);">إجمالي الصف</div>
                </th>
              </tr>
            </thead>

            <tbody>
              ${thicknesses.length === 0 ? `
                <tr>
                  <td colspan="${grades.length + 2}" style="padding:18px;text-align:center;color:var(--text-muted);">
                    <div style="font-size:0.9rem;font-weight:800;margin-bottom:6px;color:var(--text-main);">
                      الجدول فارغ حالياً وجاهز لإدخال التخانات (قص / سدا) والدرجات الخاصة بكم
                    </div>
                  </td>
                </tr>
              ` : thicknesses.map(t => {
                const totalThkSheetsAll = getTotalSheetsForThicknessRowAllWoods(t);
                const canDeleteThk = totalThkSheetsAll === 0;
                const isSada = t.direction === 'sada';
                const dirBadgeBg = isSada ? '#0284c7' : '#d97706';
                const dirBadgeText = isSada ? '📏 سدا' : '✂️ قص';
                let rowSheets = 0;
                let rowM3 = 0;
                let rowPallets = 0;

                const cellsHtml = grades.map(g => {
                  const cell = getCellData(t, g.id);
                  rowSheets += cell.sheets;
                  rowM3 += cell.volumeM3;
                  rowPallets += cell.palletsCount;
                  const hasStock = cell.sheets > 0;

                  return `
                    <td class="matrix-cell ${hasStock ? 'has-stock' : 'empty-stock'}"
                        onclick="openMatrixCellModal('${t.id}', '${g.id}')">
                      ${hasStock ? `
                        <div class="cell-main-qty" style="color:var(--primary);">${fmtNum(cell.sheets, 0)} قطعة</div>
                        <div class="cell-sub-metrics">
                          <strong style="color:var(--text-main);">${fmtNum(cell.volumeM3, 3)} م³</strong>
                          <span>(${fmtNum(cell.areaM2, 0)} م²)</span>
                          ${canSeeFinancialPrices() && cell.unitPiecePrice > 0 ? `<span style="color:var(--success);font-weight:700;">${fmtNum(cell.unitPiecePrice, 1)} ج</span>` : ''}
                        </div>
                        ${cell.customDimBreakdown && cell.customDimBreakdown.length > 0 ? `
                          <div style="margin-top:2px;font-size:0.62rem;background:#fef3c7;color:#b45309;border:1px solid #f59e0b;border-radius:4px;padding:1px 4px;font-weight:800;">
                            📐 خاص: ${cell.customDimBreakdown.join(' | ')}
                          </div>
                        ` : ''}
                      ` : `
                        <div style="color:var(--text-muted);font-size:0.74rem;font-weight:600;">0</div>
                      `}
                      <div class="cell-action-hint">
                        <button type="button" class="cell-mini-btn" title="إضافة كميات إنتاج" onclick="event.stopPropagation(); openMatrixCellModal('${t.id}', '${g.id}', 'in')">+إنتاج</button>
                        <button type="button" class="cell-mini-btn" style="background:rgba(124,58,237,0.14);color:#6d28d9;border-color:#8b5cf6;" title="إضافة مرتجع مبيعات" onclick="event.stopPropagation(); openMatrixCellModal('${t.id}', '${g.id}', 'sales_return')">مرتجع</button>
                        ${hasStock ? `
                          <button type="button" class="cell-mini-btn" style="background:rgba(16,185,129,0.15);color:#059669;border-color:#10b981;" title="خروج الكميات حسب المبيعات" onclick="event.stopPropagation(); openMatrixCellModal('${t.id}', '${g.id}', 'out')">بيع</button>
                          <button type="button" class="cell-mini-btn" title="خروج الكميات لإعادة التشغيل" onclick="event.stopPropagation(); openMatrixCellModal('${t.id}', '${g.id}', 'rework')">تشغيل</button>
                        ` : ''}
                      </div>
                    </td>
                  `;
                }).join('');

                return `
                  <tr>
                    <!-- First Column on Right: Thickness + Direction (Qas / Sada) -->
                    <td class="matrix-thickness-td">
                      <div style="display:flex;align-items:center;justify-content:space-between;gap:4px;">
                        <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;">
                          <span class="badge badge-info" style="font-size:0.76rem;padding:2px 7px;">${t.mm} مم</span>
                          <span class="badge" style="background:${dirBadgeBg};color:#fff;font-size:0.68rem;padding:2px 6px;">${dirBadgeText}</span>
                        </div>
                        <button class="del-icon-btn" style="padding:1px 4px;font-size:0.7rem;"
                          title="${canDeleteThk ? 'إلغاء هذه التخانة (الرصيد صفر)' : 'لا يمكن إلغاء تخانة لها رصيد بالمخزن (' + totalThkSheetsAll + ' قطعة)'}"
                          onclick="deleteThicknessFromMatrix('${t.id}')">
                          🗑️
                        </button>
                      </div>
                    </td>

                    ${cellsHtml}

                    <!-- Row Total -->
                    <td class="matrix-total-cell">
                      <div style="color:var(--primary);font-size:0.82rem;font-weight:800;">${fmtNum(rowSheets, 0)} ق</div>
                      <div style="font-size:0.7rem;color:var(--text-muted);">${fmtNum(rowM3, 3)} م³</div>
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>

            <tfoot>
              <tr>
                <td class="matrix-thickness-td" style="background:rgba(15,23,42,0.08);">
                  <strong style="font-size:0.76rem;">إجمالي الجودة ⬅️</strong>
                </td>
                ${grades.map(g => {
                  const colPallets = inStockPallets.filter(p => matchPalletToGrade(p, g.id));
                  const colSheets = colPallets.reduce((s, p) => s + Number(p.sheetsCount || 0), 0);
                  const colM3 = colPallets.reduce((s, p) => s + Number(p.volumeM3 || 0), 0);
                  return `
                    <td class="matrix-total-cell">
                      <div style="color:var(--accent);font-size:0.84rem;font-weight:800;">${fmtNum(colSheets, 0)} ق</div>
                      <div style="font-size:0.7rem;">${fmtNum(colM3, 3)} م³</div>
                    </td>
                  `;
                }).join('')}
                <td class="matrix-total-cell" style="background:var(--primary-light) !important;">
                  <div style="color:var(--primary);font-size:0.9rem;font-weight:900;">${fmtNum(grandSheets, 0)} ق</div>
                  <div style="font-size:0.74rem;">${fmtNum(grandM3, 3)} م³</div>
                  <small style="color:var(--text-muted);font-size:0.66rem;">${fmtNum(grandM2, 0)} م²</small>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        <!-- TABLE 2: AUTOMATIC MIRROR TABLE FOR SINGLE PIECE PRICE & LIVE STOCK/SALES VALUATION -->
        ${canSeeFinancialPrices() ? `
        <div style="margin-bottom:6px;font-weight:800;font-size:0.9rem;color:var(--accent);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px;">
          <span>2️⃣ جدول الأسعار: تسعير القطعة الواحدة (الفرخ) وقيمة الأرصدة والمبيعات اللحظية</span>
          <div style="display:flex;align-items:center;gap:6px;">
            <button class="btn btn-sm btn-outline" style="padding:3px 9px;font-size:0.74rem;border-color:var(--accent);color:var(--accent);" onclick="printVeneerPricesMatrixPdf()">
              🖨️ طباعة / تصدير جدول الأسعار PDF
            </button>
          </div>
        </div>
        <div class="matrix-wrapper">
          <table class="${tableClass}">
            <thead>
              <tr>
                <th class="matrix-corner-th" style="background:linear-gradient(135deg, #0f766e 0%, #115e59 100%) !important;">
                  <span>💰 التخانة \\ سعر القطعة ⬅️</span>
                </th>
                ${grades.map(g => `
                  <th class="matrix-grade-th" style="border-top:3px solid ${g.color || '#10b981'};">
                    <span class="badge" style="background:${g.color || '#10b981'};color:#fff;font-size:0.7rem;padding:2px 7px;">${g.code}</span>
                    <div style="margin-top:2px;font-size:0.75rem;font-weight:800;">${g.name}</div>
                  </th>
                `).join('')}
                <th class="matrix-grade-th" style="min-width:110px;background:rgba(15,118,110,0.08);">
                  <div style="font-size:0.76rem;font-weight:800;color:var(--accent);">إجمالي الصف</div>
                </th>
              </tr>
            </thead>

            <tbody>
              ${thicknesses.length === 0 ? `
                <tr>
                  <td colspan="${grades.length + 2}" style="padding:14px;text-align:center;color:var(--text-muted);">
                    يتكون هذا الجدول أوتوماتيكياً بمجرد إضافة التخانات (قص / سدا) ودرجات الجودة في الجدول العلوي.
                  </td>
                </tr>
              ` : thicknesses.map(t => {
                const isSada = t.direction === 'sada';
                const dirBadgeBg = isSada ? '#0284c7' : '#d97706';
                const dirBadgeText = isSada ? '📏 سدا' : '✂️ قص';
                let rowStockValue = 0;
                let rowSalesValue = 0;

                const priceCellsHtml = grades.map(g => {
                  const cell = getCellData(t, g.id);
                  rowStockValue += cell.stockValueByPiece;
                  rowSalesValue += cell.soldRevenue;

                  return `
                    <td class="matrix-cell" style="background:var(--bg-card);cursor:default;">
                      <div style="display:flex;align-items:center;justify-content:center;gap:4px;margin-bottom:3px;">
                        <input type="number" step="0.5" min="0"
                          class="form-control"
                          style="width:68px;padding:2px 4px;text-align:center;font-weight:800;font-size:0.78rem;border-color:var(--accent);height:25px;"
                          value="${cell.unitPiecePrice || ''}"
                          placeholder="0"
                          title="سعر القطعة الواحدة بالجنيه"
                          onchange="updateCellUnitPrice('${t.id}', '${g.id}', this.value)" />
                        <span style="font-size:0.68rem;font-weight:700;color:var(--text-muted);">ج</span>
                      </div>

                      <div style="font-size:0.68rem;padding:2px 4px;border-radius:4px;background:var(--bg-elevated);line-height:1.25;">
                        <span style="color:var(--text-muted);">رصيد (${cell.sheets}):</span>
                        <strong style="color:var(--primary);">${fmtMoney(cell.stockValueByPiece)}</strong>
                      </div>

                      ${cell.soldSheets > 0 ? `
                        <div style="font-size:0.65rem;color:var(--success);font-weight:700;margin-top:2px;">
                          مبيعات (${cell.soldSheets}): ${fmtMoney(cell.soldRevenue)}
                        </div>
                      ` : ''}
                    </td>
                  `;
                }).join('');

                return `
                  <tr>
                    <td class="matrix-thickness-td">
                      <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;">
                        <span class="badge badge-info" style="font-size:0.76rem;padding:2px 7px;">${t.mm} مم</span>
                        <span class="badge" style="background:${dirBadgeBg};color:#fff;font-size:0.68rem;padding:2px 6px;">${dirBadgeText}</span>
                      </div>
                    </td>
                    ${priceCellsHtml}
                    <td class="matrix-total-cell">
                      <div style="color:var(--primary);font-size:0.78rem;font-weight:800;">${fmtMoney(rowStockValue)}</div>
                      ${rowSalesValue > 0 ? `<div style="font-size:0.66rem;color:var(--success);">بيع: ${fmtMoney(rowSalesValue)}</div>` : ''}
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>

            <tfoot>
              <tr>
                <td class="matrix-thickness-td" style="background:rgba(15,118,110,0.08);">
                  <strong style="font-size:0.75rem;">إجمالي القيمة ⬅️</strong>
                </td>
                ${grades.map(g => {
                  let colStockVal = 0;
                  let colSalesVal = 0;
                  for (const t of thicknesses) {
                    const cd = getCellData(t, g.id);
                    colStockVal += cd.stockValueByPiece;
                    colSalesVal += cd.soldRevenue;
                  }
                  return `
                    <td class="matrix-total-cell">
                      <div style="color:var(--primary);font-size:0.8rem;font-weight:800;">${fmtMoney(colStockVal)}</div>
                      ${colSalesVal > 0 ? `<div style="font-size:0.66rem;color:var(--success);">بيع: ${fmtMoney(colSalesVal)}</div>` : ''}
                    </td>
                  `;
                }).join('')}
                <td class="matrix-total-cell" style="background:var(--accent-light) !important;">
                  <div style="color:var(--primary);font-size:0.88rem;font-weight:900;">${fmtMoney(grandStockValueByPiece)}</div>
                  <div style="font-size:0.68rem;color:var(--success);font-weight:800;">
                    مبيعات (${grandSoldSheets} ق): ${fmtMoney(grandSoldRevenue)}
                  </div>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
        ` : ''}
      ` : `
        <!-- Detailed Pallets List View -->
        <div style="display:flex;justify-content:flex-end;margin-bottom:8px;">
          <button class="btn btn-sm btn-primary" onclick="printPalletsInventoryPdf()">🖨️ طباعة سجل البالتات PDF</button>
        </div>
        <div class="table-responsive">
          <table>
            <thead>
              <tr>
                <th>كود البالتة</th>
                <th>التاريخ</th>
                <th>نوع الخشب</th>
                <th>المقاس (سم)</th>
                <th>التخانة والاتجاه</th>
                <th>الجودة / الفرز</th>
                <th>عدد القطع (الأفرخ)</th>
                ${canSeeFinancialPrices() ? '<th>سعر القطعة</th><th>إجمالي القيمة</th>' : ''}
                <th>الحجم (م³)</th>
                <th>إجراءات وطباعة</th>
              </tr>
            </thead>
            <tbody>
              ${inStockPallets.map(p => `
                <tr>
                  <td><strong>${p.palletCode}</strong><br/><small style="color:var(--text-muted);">${p.batchNumber || ''}</small></td>
                  <td>${fmtDate(p.operationDate || p.createdAt)}</td>
                  <td>${p.woodTypeName}</td>
                  <td>${getVeneerDimensionBadgeHtml(p.lengthCm, p.widthCm)}</td>
                  <td>
                    <span class="badge badge-info">${p.thicknessMm} مم</span>
                    <span class="badge" style="background:${p.direction === 'sada' ? '#0284c7' : '#d97706'};color:#fff;">
                      ${p.direction === 'sada' ? '📏 سدا' : '✂️ قص'}
                    </span>
                  </td>
                  <td><strong>${p.gradeName}</strong></td>
                  <td>${fmtNum(p.sheetsCount, 0)} قطعة</td>
                  ${canSeeFinancialPrices() ? `<td>${fmtMoney(p.unitSheetPrice || 0)}</td><td><strong>${fmtMoney(p.totalValue || 0)}</strong></td>` : ''}
                  <td><strong>${fmtNum(p.volumeM3, 4)} م³</strong></td>
                  <td>
                    <div style="display:flex;gap:6px;flex-wrap:wrap;">
                      <button class="btn btn-sm btn-outline" onclick="printPalletTag('${p.id}')">🖨️ كارت البالتة</button>
                      <button class="btn btn-sm btn-primary" onclick="openMatrixCellModal('${p.thicknessId || ('th-' + p.thicknessMm + '-' + (p.direction || 'qas'))}', '${p.gradeId}', 'out')">📤 بيع/خروج</button>
                      ${isFullAdmin(currentUser) ? `
                        <button class="btn btn-sm btn-accent" onclick="openEditPalletModal('${p.id}')">✏️ تعديل</button>
                        <button class="btn btn-sm btn-danger" onclick="deletePalletRecord('${p.id}')">🗑️ حذف وإرجاع الرصيد</button>
                      ` : ''}
                    </div>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `}
    </div>
  `;
}

function renderSalesReturnsSection() {
  const returnsList = state.salesReturns || [];
  const pendingCount = returnsList.filter(r => r.status === 'pending_approval').length;
  const canApprove = canApproveSalesReturn(currentUser);
  const showPrices = canSeeFinancialPrices();

  return `
    <div class="card" style="border:2px solid ${pendingCount > 0 ? '#7c3aed' : 'var(--border)'};background:${pendingCount > 0 ? 'rgba(124,58,237,0.04)' : 'var(--bg-surface)'};margin-bottom:18px;">
      <div class="card-header">
        <div>
          <div class="card-title" style="color:#6d28d9;">
            🔄 سجل مرتجع المبيعات واعتماد دخوله للمخزن مرة أخرى (${returnsList.length} سجل ${pendingCount > 0 ? `— ⏳ ${pendingCount} بانتظار الموافقة` : ''})
          </div>
          <small style="color:var(--text-muted);">
            🔒 <strong>قاعدة النظام الإلزامية:</strong> عند تسجيل مرتجع مبيعات، <strong>لا تضاف الكمية لرصيد المخزن فوراً</strong>، بل تدخل المخزن مرة أخرى فقط بعد موافقة <strong>(المدير التنفيذي أو مدير المشروعات أو المحاسب فقط)</strong>.
          </small>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn btn-sm btn-outline" onclick="printSalesReturnsReportPdf()">
            🖨️ طباعة سجل المرتجعات PDF
          </button>
          <button class="btn btn-sm" style="background:#7c3aed;color:#fff;font-weight:800;" onclick="openWarehouseOpShortcut('sales_return')">
            ➕ تسجيل مرتجع مبيعات جديد
          </button>
        </div>
      </div>

      ${returnsList.length === 0 ? `
        <div style="padding:14px 16px;font-size:0.88rem;color:var(--text-muted);background:var(--bg-elevated);border-radius:10px;">
          لا توجد مرتجعات مبيعات مسجلة حالياً. لتسجيل مرتجع مبيعات اضغط على <strong>"🔄 إضافة مرتجع مبيعات"</strong> أعلى الصفحة أو داخل أي خلية، وسيتم إرساله لاعتماد (المدير التنفيذي أو مدير المشروعات أو المحاسب) ليدخل المخزن.
        </div>
      ` : `
        <div class="table-responsive">
          <table>
            <thead>
              <tr>
                <th>رقم المرتجع والتاريخ</th>
                <th>العميل</th>
                <th>الصنف والمقاس والتخانة والجودة</th>
                <th>الكمية المرتجعة</th>
                ${showPrices ? '<th>قيمة المرتجع</th>' : ''}
                <th>مسجل بواسطة / السبب</th>
                <th>حالة دخول المخزن</th>
                <th>اعتماد (التنفيذي / المشروعات / المحاسب فقط)</th>
              </tr>
            </thead>
            <tbody>
              ${returnsList.map(r => {
                const isPending = r.status === 'pending_approval';
                const isApproved = r.status === 'approved';
                return `
                  <tr style="${isPending ? 'background:rgba(124,58,237,0.08);' : ''}">
                    <td>
                      <strong>${r.returnNumber || 'RET'}</strong><br/>
                      <small style="color:var(--text-muted);">📅 ${r.date || fmtDate(r.createdAt)}</small>
                    </td>
                    <td><strong>${r.clientName || 'عميل مبيعات'}</strong></td>
                    <td>
                      <strong>${r.woodTypeName || 'قشرة خشبية'}</strong><br/>
                      ${getVeneerDimensionBadgeHtml(r.lengthCm, r.widthCm)}
                      <span class="badge badge-info">${r.thkMm} مم (${r.direction === 'sada' ? 'اتجاه سدا' : 'اتجاه قص'})</span>
                      <span class="badge" style="background:#0f766e;color:#fff;">${r.gradeName || ''}</span>
                    </td>
                    <td>
                      <strong style="font-size:0.98rem;color:var(--primary);">${fmtNum(r.sheetsCount || 0, 0)} قطعة (فرخ)</strong><br/>
                      <small style="color:var(--text-muted);">${fmtNum(r.volumeM3 || 0, 4)} م³ | ${fmtNum(r.areaM2 || 0, 2)} م²</small>
                    </td>
                    ${showPrices ? `
                      <td>
                        <strong>${fmtMoney(r.totalReturnAmount || 0)}</strong><br/>
                        <small style="color:var(--text-muted);">سعر القطعة: ${fmtNum(r.unitPrice || 0, 2)} ج</small>
                      </td>
                    ` : ''}
                    <td>
                      <strong>${r.requestedBy || '-'}</strong><br/>
                      <small style="color:var(--text-muted);">${r.notes || 'مرتجع مبيعات من عميل'}</small>
                    </td>
                    <td>
                      ${isPending ? `
                        <span class="badge badge-warning" style="font-size:0.82rem;">
                          ⏳ معلق — بانتظار موافقة (التنفيذي / المشروعات / المحاسب) ليدخل المخزن
                        </span>
                      ` : isApproved ? `
                        <span class="badge badge-success" style="font-size:0.82rem;">
                          ✅ تمت الموافقة (${r.approvedBy || ''}) ودخلت الكمية رصيد المخزن
                        </span>
                      ` : `
                        <span class="badge badge-danger" style="font-size:0.82rem;">
                          ❌ مرفوض (${r.rejectedBy || ''}) — لم يدخل المخزن
                        </span>
                      `}
                    </td>
                    <td>
                      <div style="display:flex;gap:6px;flex-wrap:wrap;">
                        ${isPending && canApprove ? `
                          <button class="btn btn-sm btn-success" onclick="approveSalesReturn('${r.id}')">
                            ✅ موافقة وإدخال الكمية للمخزن
                          </button>
                          <button class="btn btn-sm btn-danger" onclick="rejectSalesReturn('${r.id}')">
                            ❌ رفض
                          </button>
                        ` : isPending ? `
                          <span style="font-size:0.78rem;color:var(--text-muted);font-weight:700;">
                            🔒 يعتمد فقط من التنفيذي أو مدير المشروعات أو المحاسب
                          </span>
                        ` : ''}
                        ${isFullAdmin(currentUser) ? `
                          <button class="btn btn-sm btn-outline" style="color:var(--danger);border-color:var(--danger);" onclick="deleteSalesReturnRecord('${r.id}')">
                            🗑️ حذف
                          </button>
                        ` : ''}
                      </div>
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      `}
    </div>
  `;
}

function renderRawMaterialsWarehouse() {
  return `
    <div class="card">
      <div class="card-header">
        <div>
          <div class="card-title">🌲 مخزن الخامات (كتل وجذوع الخشب قبل التقشير ومستلزمات الإنتاج)</div>
          <small style="color:var(--text-muted);">متابعة أرصدة الأخشاب الخام بالمتر المكعب ومستلزمات التغليف والتجميع</small>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn btn-sm btn-outline" onclick="printRawMaterialsReportPdf()">🖨️ طباعة تقرير الخامات PDF</button>
          ${hasPerm('warehouseIssueReceive') ? `
            <button class="btn btn-sm btn-primary" onclick="openAddRawMaterialModal()">➕ إضافة / توريد خامات للمخزن</button>
          ` : ''}
        </div>
      </div>

      <div class="table-responsive">
        <table>
          <thead>
            <tr>
              <th>الكود</th>
              <th>اسم الصنف الخام</th>
              <th>الفئة</th>
              <th>الرصيد الحالي</th>
              <th>الحد الأدنى للتنبيه</th>
              ${canSeeFinancialPrices() ? '<th>تكلفة الوحدة</th><th>إجمالي القيمة</th>' : ''}
              <th>المورد / الموقع</th>
              <th>إجراءات</th>
            </tr>
          </thead>
          <tbody>
            ${(state.rawMaterials || []).map(rm => {
              const isLow = Number(rm.quantity) <= Number(rm.minThreshold);
              return `
                <tr>
                  <td><strong>${rm.code}</strong></td>
                  <td>${rm.name}</td>
                  <td>${rm.category}</td>
                  <td>
                    <strong style="color:${isLow ? 'var(--danger)' : 'var(--success)'};font-size:1rem;">
                      ${fmtNum(rm.quantity, 2)} ${rm.unit}
                    </strong>
                    ${isLow ? `<span class="badge badge-danger">نقص رصيد!</span>` : ''}
                  </td>
                  <td>${rm.minThreshold} ${rm.unit}</td>
                  ${canSeeFinancialPrices() ? `<td>${fmtMoney(rm.costPerUnit)}</td><td><strong>${fmtMoney(Number(rm.quantity) * Number(rm.costPerUnit))}</strong></td>` : ''}
                  <td>${rm.supplierName || ''}<br/><small style="color:var(--text-muted);">${rm.location || ''}</small></td>
                  <td>
                    <div style="display:flex;gap:5px;flex-wrap:wrap;">
                      ${hasPerm('warehouseIssueReceive') ? `
                        <button class="btn btn-sm btn-outline" onclick="adjustRawMaterialStock('${rm.id}', 'in')">➕ توريد</button>
                        <button class="btn btn-sm btn-outline" onclick="adjustRawMaterialStock('${rm.id}', 'out')">➖ صرف للتشغيل</button>
                      ` : ''}
                      ${isFullAdmin(currentUser) ? `
                        <button class="btn btn-sm btn-accent" onclick="openEditRawMaterialModal('${rm.id}')">✏️ تعديل</button>
                        <button class="btn btn-sm btn-danger" onclick="deleteRawMaterialRecord('${rm.id}')">🗑️ حذف</button>
                      ` : ''}
                    </div>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderScrapWarehouse() {
  return `
    <div class="card">
      <div class="card-header">
        <div>
          <div class="card-title">♻️ مخزن الهالك والدرجة الثانية والقصاقيص</div>
          <small style="color:var(--text-muted);">إدارة القصاقيص وقلب الجذوع (الكوز/الدرافيل) وكسر القشرة المستخدم كوقود لغلاية المجفف</small>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn btn-sm btn-outline" onclick="printScrapReportPdf()">🖨️ طباعة تقرير الهالك PDF</button>
          ${hasPerm('warehouseIssueReceive') ? `
            <button class="btn btn-sm btn-primary" onclick="openAddScrapModal()">➕ تسجيل إضافة هالك / قصاقيص</button>
          ` : ''}
        </div>
      </div>

      <div class="table-responsive">
        <table>
          <thead>
            <tr>
              <th>الكود</th>
              <th>بيان الصنف / القصاقيص</th>
              <th>نوع الخشب</th>
              <th>التصنيف</th>
              <th>الكمية المتاحة</th>
              ${canSeeFinancialPrices() ? '<th>السعر التقديري للوحدة</th><th>القيمة التقديرية</th>' : ''}
              <th>ملاحظات</th>
              <th>إجراءات</th>
            </tr>
          </thead>
          <tbody>
            ${(state.scrapItems || []).map(sc => `
              <tr>
                <td><strong>${sc.code}</strong></td>
                <td>${sc.name}</td>
                <td>${sc.woodTypeName}</td>
                <td><span class="badge badge-warning">${sc.category}</span></td>
                <td><strong>${fmtNum(sc.quantity, 2)} ${sc.unit}</strong></td>
                ${canSeeFinancialPrices() ? `<td>${fmtMoney(sc.estimatedPricePerUnit)}</td><td>${fmtMoney(Number(sc.quantity) * Number(sc.estimatedPricePerUnit))}</td>` : ''}
                <td>${sc.notes || '-'}</td>
                <td>
                  <div style="display:flex;gap:5px;flex-wrap:wrap;">
                    ${hasPerm('warehouseIssueReceive') ? `
                      <button class="btn btn-sm btn-outline" onclick="dispatchScrapItem('${sc.id}')">صرف / بيع هالك</button>
                    ` : ''}
                    ${isFullAdmin(currentUser) ? `
                      <button class="btn btn-sm btn-accent" onclick="openEditScrapModal('${sc.id}')">✏️ تعديل</button>
                      <button class="btn btn-sm btn-danger" onclick="deleteScrapRecord('${sc.id}')">🗑️ حذف</button>
                    ` : ''}
                  </div>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderSparePartsWarehouse() {
  return `
    <div class="card">
      <div class="card-header">
        <div>
          <div class="card-title">🔧 مخزن قطع الغيار والمهمات الخاصة بالماكينات</div>
          <small style="color:var(--text-muted);">سكاكين المقشرة والمقصلة، سيور المجفف الحرارية، الزيوت الهيدروليكية ومهمات الصيانة</small>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn btn-sm btn-outline" onclick="printSparePartsReportPdf()">🖨️ طباعة قطع الغيار PDF</button>
          ${hasPerm('warehouseIssueReceive') ? `
            <button class="btn btn-sm btn-primary" onclick="openAddSparePartModal()">➕ إضافة صنف قطع غيار / مهمات</button>
          ` : ''}
        </div>
      </div>

      <div class="table-responsive">
        <table>
          <thead>
            <tr>
              <th>كود القطعة</th>
              <th>اسم قطعة الغيار / المهمات</th>
              <th>الماكينة / الخط</th>
              <th>الرصيد المتاح</th>
              <th>حد الطلب</th>
              ${canSeeFinancialPrices() ? '<th>تكلفة الوحدة</th>' : ''}
              <th>الموقع المخزني</th>
              <th>إجراءات</th>
            </tr>
          </thead>
          <tbody>
            ${(state.spareParts || []).map(sp => {
              const isLow = Number(sp.quantity) <= Number(sp.minThreshold);
              return `
                <tr>
                  <td><strong>${sp.code}</strong></td>
                  <td>${sp.name}</td>
                  <td>${sp.machineName}</td>
                  <td>
                    <strong style="color:${isLow ? 'var(--danger)' : 'var(--text-main)'}">${sp.quantity} ${sp.unit}</strong>
                    ${isLow ? `<span class="badge badge-danger">يحتاج شراء</span>` : ''}
                  </td>
                  <td>${sp.minThreshold} ${sp.unit}</td>
                  ${canSeeFinancialPrices() ? `<td>${fmtMoney(sp.costPerUnit)}</td>` : ''}
                  <td>${sp.location || '-'}</td>
                  <td>
                    <div style="display:flex;gap:5px;flex-wrap:wrap;">
                      ${hasPerm('warehouseIssueReceive') ? `
                        <button class="btn btn-sm btn-outline" onclick="adjustSparePartStock('${sp.id}', 'in')">➕ توريد</button>
                        <button class="btn btn-sm btn-outline" onclick="adjustSparePartStock('${sp.id}', 'out')">➖ صرف للصيانة</button>
                      ` : ''}
                      ${isFullAdmin(currentUser) ? `
                        <button class="btn btn-sm btn-accent" onclick="openEditSparePartModal('${sp.id}')">✏️ تعديل</button>
                        <button class="btn btn-sm btn-danger" onclick="deleteSparePartRecord('${sp.id}')">🗑️ حذف</button>
                      ` : ''}
                    </div>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderWarehouseMovements() {
  const movements = (state.warehouseMovements || []).filter(m => {
    const dStr = (m.operationDate || m.date || '').slice(0, 10);
    if (movementDateFilterFrom && dStr < movementDateFilterFrom) return false;
    if (movementDateFilterTo && dStr > movementDateFilterTo) return false;
    return true;
  });

  return `
    <div class="card">
      <div class="card-header">
        <div>
          <div class="card-title">📋 سجل حركات المخازن وأذون الدخول والخروج والأعمال السابقة</div>
          <small style="color:var(--text-muted);">يعرض جميع حركات الدخول والخروج والمبيعات مرتبة بالتاريخ المختار (الحالي أو السابق)</small>
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <label style="font-size:0.8rem;font-weight:700;">من تاريخ:</label>
          <input type="date" class="form-control" style="padding:5px 10px;" value="${movementDateFilterFrom}" onchange="movementDateFilterFrom=this.value; render();" />
          <label style="font-size:0.8rem;font-weight:700;">إلى تاريخ:</label>
          <input type="date" class="form-control" style="padding:5px 10px;" value="${movementDateFilterTo}" onchange="movementDateFilterTo=this.value; render();" />
          ${(movementDateFilterFrom || movementDateFilterTo) ? `
            <button class="btn btn-sm btn-outline" onclick="movementDateFilterFrom=''; movementDateFilterTo=''; render();">إلغاء الفلتر</button>
          ` : ''}
          <button class="btn btn-sm btn-primary" onclick="printWarehouseMovementsReportPdf()">🖨️ طباعة سجل الحركات PDF</button>
        </div>
      </div>
      <div class="table-responsive">
        <table>
          <thead>
            <tr>
              <th>رقم الإذن</th>
              <th>تاريخ الحركة</th>
              <th>المخزن</th>
              <th>نوع الحركة</th>
              <th>البيان والتفاصيل</th>
              <th>${canSeeFinancialPrices() ? 'الكمية والقيمة' : 'الكمية فقط'}</th>
              <th>بواسطة</th>
              <th>طباعة الإذن</th>
            </tr>
          </thead>
          <tbody>
            ${movements.map(m => `
              <tr>
                <td><strong>${m.voucherNumber}</strong></td>
                <td><strong>${fmtDate(m.operationDate || m.date)}</strong></td>
                <td>${m.warehouseLabel}</td>
                <td>
                  <span class="badge ${m.direction === 'in' ? 'badge-success' : 'badge-warning'}">
                    ${m.directionLabel}
                  </span>
                </td>
                <td>${sanitizeTextForWarehouseKeeper(m.itemSummary)}<br/><small style="color:var(--text-muted);">مرجع: ${m.referenceCode || '-'}</small></td>
                <td>
                  <strong>${sanitizeTextForWarehouseKeeper(m.quantitySummary)}</strong>
                  ${canSeeFinancialPrices() && m.totalSaleAmount ? `<br/><span style="color:var(--success);font-weight:700;">قيمة البيع: ${fmtMoney(m.totalSaleAmount)}</span>` : ''}
                </td>
                <td>${m.performedBy}</td>
                <td>
                  <div style="display:flex;gap:5px;flex-wrap:wrap;">
                    <button class="btn btn-sm btn-outline" onclick="printWarehouseVoucher('${m.id}')">🖨️ طباعة إذن</button>
                    ${isFullAdmin(currentUser) ? `
                      <button class="btn btn-sm btn-accent" onclick="openEditWarehouseMovementModal('${m.id}')">✏️ تعديل البيان والرصيد</button>
                      <button class="btn btn-sm btn-danger" onclick="deleteWarehouseMovementWithRestore('${m.id}')">🗑️ حذف وإرجاع الرصيد</button>
                    ` : ''}
                  </div>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

// ============================================================================
// HELPER: CLIENT METRICS (ORDERS, DEBTS/RECEIVABLES, AND WOODEN PALLETS LEDGER)
// ============================================================================
let clientSearchQuery = '';
let ordersSearchQuery = '';

function matchesClientSearchQuery(code, name, phone, city, extraText, rawQuery) {
  if (!rawQuery || !rawQuery.trim()) return true;
  const q = rawQuery.trim().toLowerCase();
  const qNorm = q.replace(/[\s\-_]/g, '');
  const fields = [code || '', name || '', phone || '', city || '', extraText || ''];
  return fields.some(f => {
    const low = String(f).toLowerCase();
    const norm = low.replace(/[\s\-_]/g, '');
    return low.includes(q) || (qNorm.length > 0 && norm.includes(qNorm));
  });
}

function handleClientSearchInput(val) {
  clientSearchQuery = val;
  const tbody = document.getElementById('clients-directory-tbody');
  if (!tbody) return;
  const rows = tbody.querySelectorAll('tr[data-client-search]');
  const emptyRow = document.getElementById('clients-empty-search-row');
  let visibleCount = 0;
  rows.forEach(tr => {
    const code = tr.getAttribute('data-code') || '';
    const name = tr.getAttribute('data-name') || '';
    const phone = tr.getAttribute('data-phone') || '';
    const city = tr.getAttribute('data-city') || '';
    const matched = matchesClientSearchQuery(code, name, phone, city, '', val);
    tr.style.display = matched ? '' : 'none';
    if (matched) visibleCount++;
  });
  if (emptyRow) {
    emptyRow.style.display = visibleCount === 0 ? '' : 'none';
  }
  const clearBtn = document.getElementById('client-search-clear-btn');
  if (clearBtn) {
    clearBtn.style.display = val.trim() ? 'inline-flex' : 'none';
  }
}

function handleOrdersSearchInput(val) {
  ordersSearchQuery = val;
  const tbody = document.getElementById('orders-table-tbody');
  if (!tbody) return;
  const rows = tbody.querySelectorAll('tr[data-order-search]');
  rows.forEach(tr => {
    const code = tr.getAttribute('data-code') || '';
    const name = tr.getAttribute('data-name') || '';
    const ordNum = tr.getAttribute('data-ordnum') || '';
    const matched = matchesClientSearchQuery(code, name, '', '', ordNum, val);
    tr.style.display = matched ? '' : 'none';
  });
  const clearBtn = document.getElementById('orders-search-clear-btn');
  if (clearBtn) {
    clearBtn.style.display = val.trim() ? 'inline-flex' : 'none';
  }
}

function handleOrderModalClientSearch(val) {
  const sel = document.getElementById('ord-client');
  const statusEl = document.getElementById('ord-client-search-status');
  if (!sel) return;
  const clients = (state.partners || []).filter(pt => pt.type !== 'supplier');
  const q = (val || '').trim();
  if (!q) {
    Array.from(sel.options).forEach(opt => { opt.hidden = false; });
    if (statusEl) statusEl.innerHTML = '';
    return;
  }
  // Find best match (exact code match first, then partial match)
  const qNorm = q.toLowerCase().replace(/[\s\-_]/g, '');
  let exactMatch = null;
  const matchedClients = clients.filter(c => {
    const cCodeNorm = String(c.code || '').toLowerCase().replace(/[\s\-_]/g, '');
    if (cCodeNorm === qNorm || cCodeNorm === `cl${qNorm}`) exactMatch = c;
    return matchesClientSearchQuery(c.code, c.name, c.phone, c.city, '', q);
  });

  const chosen = exactMatch || matchedClients[0] || null;
  if (chosen) {
    sel.value = chosen.id;
    if (statusEl) {
      statusEl.innerHTML = `<span class="badge badge-success">✅ تم اختيار العميل: [${chosen.code || 'CL'}] ${chosen.name} (${matchedClients.length} مطابق)</span>`;
    }
  } else if (statusEl) {
    statusEl.innerHTML = `<span class="badge badge-danger">⚠️ لا يوجد عميل مطابق للكود/الاسم "${q}"</span>`;
  }
}

function computeClientMetrics(pt) {
  if (!pt) return { orders: [], txs: [], palletMoves: [], totalInvoiced: 0, totalPaid: 0, netDebt: 0, palletsDelivered: 0, palletsReceived: 0, netPalletsAtClient: 0 };

  const orders = (state.productionOrders || []).filter(
    o => (o.clientId && o.clientId === pt.id) || (o.clientName && o.clientName.trim() === pt.name.trim())
  );

  const txs = (state.financialTransactions || []).filter(
    tx => (tx.partnerId && tx.partnerId === pt.id) || (tx.partnerName && tx.partnerName.trim() === pt.name.trim())
  );

  const palletMoves = (state.palletMovements || []).filter(
    pm => (pm.clientId && pm.clientId === pt.id) || (pm.clientName && pm.clientName.trim() === pt.name.trim())
  );

  const openingDebit = Number(pt.openingDebit ?? (Number(pt.balance || 0) > 0 ? Number(pt.balance) : 0));
  const openingCredit = Number(pt.openingCredit ?? (Number(pt.balance || 0) < 0 ? Math.abs(Number(pt.balance)) : 0));

  let invoicesTotal = 0;
  let paymentsTotal = 0;

  for (const tx of txs) {
    if (tx.type === 'sales_invoice') {
      invoicesTotal += Number(tx.totalAmount || 0);
      paymentsTotal += Number(tx.paidAmount || 0);
    } else if (tx.type === 'client_payment' || tx.type === 'receipt') {
      paymentsTotal += Number(tx.paidAmount || tx.totalAmount || 0);
    } else if (tx.type === 'client_credit') {
      paymentsTotal += Number(tx.totalAmount || 0);
    }
  }

  const totalDebit = +(openingDebit + invoicesTotal).toFixed(2);
  const totalCredit = +(openingCredit + paymentsTotal).toFixed(2);
  // netDebt > 0 means client owes the factory (مديونية على العميل)
  // netDebt < 0 means client has credit/receivables with the factory (مستحقات للعميل)
  const netDebt = +(totalDebit - totalCredit).toFixed(2);

  const palletsDelivered = Number(pt.openingPalletsDelivered || 0) + palletMoves.reduce((s, pm) => s + Number(pm.deliveredCount || 0), 0);
  const palletsReceived = Number(pt.openingPalletsReceived || 0) + palletMoves.reduce((s, pm) => s + Number(pm.receivedCount || 0), 0);
  const netPalletsAtClient = palletsDelivered - palletsReceived;

  return {
    orders,
    txs,
    palletMoves,
    openingDebit,
    openingCredit,
    totalInvoiced: +invoicesTotal.toFixed(2),
    totalPaid: +paymentsTotal.toFixed(2),
    totalDebit,
    totalCredit,
    netDebt,
    palletsDelivered,
    palletsReceived,
    netPalletsAtClient
  };
}

function canUserSeeOrderInPrep(user, order) {
  if (!user || !order) return false;
  const st = order.stage || order.status || 'pending_executive';
  // RULE: If order is in 'pending_executive', ONLY CEO, Projects Manager, Accountant, and Accounts Manager can see it.
  // Admin Manager (المدير الإداري) and Warehouse Keeper (أمين المخزن) CANNOT see it until CEO or Projects Manager approves it!
  if (st === 'pending_executive') {
    if (user.roleKey === 'admin_manager' || user.roleKey === 'warehouse_keeper' || user.roleKey === 'operations_manager') {
      return false;
    }
  }
  return true;
}

function getOrderStageBadge(order) {
  const st = order.stage || order.status || 'pending_executive';
  if (st === 'pending_executive') {
    return `<span class="badge badge-warning">1️⃣ قيد موافقة التنفيذي/المشروعات</span>`;
  }
  if (st === 'pending_warehouse_prep') {
    return `<span class="badge badge-info">2️⃣ قيد التجهيز بالمخزن (${order.executiveApprovedBy || 'معتمد'})</span>`;
  }
  if (st === 'pending_accountant_release') {
    return `<span class="badge" style="background:#7c3aed;color:#fff;">3️⃣ جاهز (${order.warehousePrepApprovedBy || 'المخزن'}) ⬅ بانتظار المحاسب</span>`;
  }
  if (st === 'ready_for_car_dispatch') {
    return `<span class="badge badge-danger">4️⃣ معتمد للصرف (${order.accountantReleaseBy || 'المحاسب'}) ⬅ 🚚 تحميل السيارة</span>`;
  }
  if (st === 'completed') {
    return `<span class="badge badge-success">✅ تم الصرف (${order.carDispatchVoucher?.carPlateNumber || 'مكتمل'})</span>`;
  }
  return `<span class="badge badge-info">${st}</span>`;
}

// ============================================================================
// 3. CLIENT ORDER PREPARATION (أوامر تجهيز طلبية للعميل — متعدد التخانات والجودات)
// ============================================================================
function renderProduction() {
  const allOrders = state.productionOrders || [];
  const visibleOrders = allOrders.filter(o => canUserSeeOrderInPrep(currentUser, o));
  const hiddenForWarehouseCount = allOrders.length - visibleOrders.length;

  const isExec = isFullAdmin(currentUser);
  const isWarehouseOrAdmin = currentUser.roleKey === 'admin_manager' || currentUser.roleKey === 'warehouse_keeper' || isExec;
  const isAccountantOrExec = ['accountant', 'accounts_manager', 'accounting_manager', 'ceo', 'projects_manager'].includes(currentUser.roleKey);

  return `
    <!-- Workflow Stepper Banner -->
    <div class="card" style="background:linear-gradient(135deg, rgba(15,118,110,0.08), rgba(217,119,6,0.08));border:1px solid rgba(15,118,110,0.25);padding:16px 20px;">
      <div style="font-weight:900;font-size:1rem;color:var(--primary);margin-bottom:8px;">
        🔄 مسار عمل (أوامر تجهيز طلبية للعميل) والاعتمادات المتسلسلة:
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(210px, 1fr));gap:10px;font-size:0.83rem;">
        <div style="background:var(--bg-surface);padding:10px 12px;border-radius:10px;border-right:4px solid #d97706;">
          <strong>1️⃣ المحاسب يطلب التجهيز والبيان</strong><br/>
          <span style="color:var(--text-muted);">${canSeeFinancialPrices() ? 'يحدد العميل + عدة تخانات (قص/سدا) وجودات + تعديل الأسعار والخصم في بيان العميل.' : 'يحدد العميل + عدة تخانات (قص/سدا) وجودات والكميات المطلوبة بالقطعة والمتر المكعب.'}</span>
        </div>
        <div style="background:var(--bg-surface);padding:10px 12px;border-radius:10px;border-right:4px solid #2563eb;">
          <strong>2️⃣ موافقة التنفيذي / مدير المشروعات</strong><br/>
          <span style="color:var(--text-muted);">لا يظهر البيان للمدير الإداري وأمين المخزن إلا بعد موافقة المدير التنفيذي أو مدير المشروعات.</span>
        </div>
        <div style="background:var(--bg-surface);padding:10px 12px;border-radius:10px;border-right:4px solid #0284c7;">
          <strong>3️⃣ موافقة المدير الإداري / أمين المخزن</strong><br/>
          <span style="color:var(--text-muted);">بعد تجهيز الطلبية يوافق المدير الإداري أو أمين المخزن فتتحول للمحاسب في (اعتماد أذون الصرف).</span>
        </div>
        <div style="background:var(--bg-surface);padding:10px 12px;border-radius:10px;border-right:4px solid #16a34a;">
          <strong>4️⃣ اعتماد الصرف وإذن تحميل السيارة</strong><br/>
          <span style="color:var(--text-muted);">المحاسب يعمل حسابات العميل ويعتمد الصرف ⬅ يظهر أمر لأمين المخزن والمدير الإداري بصرف الطلبية وعمل إذن صرف للسيارة.</span>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <div>
          <div class="card-title">${canSeeFinancialPrices() ? '📋 أوامر تجهيز طلبية للعميل (متعدد التخانات والجودات + بيان العميل وتعديل الأسعار والخصم)' : '📋 أوامر تجهيز طلبية للعميل (كميات التخانات والجودات المطلوب تجهيزها بالمخزن)'}</div>
          <small style="color:var(--text-muted);">
            حسابك الحالي: <strong>${currentUser.name} (${currentUser.roleTitle})</strong>
            ${hiddenForWarehouseCount > 0 ? ` | 🔒 يوجد (${hiddenForWarehouseCount}) طلبية قيد مراجعة المدير التنفيذي/مدير المشروعات ستظهر لك فور موافقتهما` : ''}
          </small>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          ${isAccountantOrExec ? `
            <button class="btn btn-primary" onclick="openNewClientOrderPrepModal()">➕ إنشاء أمر تجهيز طلبية للعميل (بيان جديد)</button>
          ` : ''}
          <button class="btn btn-outline" onclick="printAllProductionOrdersReportPdf()">🖨️ طباعة سجل أوامر التجهيز PDF</button>
          <button class="btn btn-outline" onclick="setTab('approvals')">✅ الانتقال لاعتماد أذون الصرف والسيارات</button>
        </div>
      </div>

      ${visibleOrders.length === 0 ? `
        <div style="text-align:center;padding:36px 20px;color:var(--text-muted);">
          <div style="font-size:2.5rem;margin-bottom:8px;">📋</div>
          <div style="font-weight:800;font-size:1.05rem;color:var(--text-main);">لا توجد أوامر تجهيز طلبيات معروضة حالياً</div>
          <small>يمكن للمحاسب أو الإدارة الضغط على "إنشاء أمر تجهيز طلبية للعميل" لإضافة طلبية بتخانات وجودات متعددة وإصدار بيان للعميل.</small>
        </div>
      ` : `
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px;background:var(--bg-elevated);padding:8px 12px;border-radius:10px;">
          <span style="font-size:0.78rem;font-weight:700;">🔍 بحث بكود العميل أو اسم العميل أو رقم الطلبية:</span>
          <input id="orders-search-input" class="form-control" style="max-width:300px;" placeholder="اكتب كود العميل كامل (مثل CL-101) أو الاسم..." value="${ordersSearchQuery}" oninput="handleOrdersSearchInput(this.value)" />
          <button id="orders-search-clear-btn" type="button" class="btn btn-sm btn-outline" style="display:${ordersSearchQuery.trim() ? 'inline-flex' : 'none'};" onclick="document.getElementById('orders-search-input').value=''; handleOrdersSearchInput('');">إلغاء البحث</button>
        </div>
        <div class="table-responsive">
          <table>
            <thead>
              <tr>
                <th>رقم الطلبية والتاريخ</th>
                <th>العميل</th>
                <th>بنود الطلبية (تخانة × جودة × كمية)</th>
                ${canSeeFinancialPrices() ? '<th>الصافي المالي</th>' : ''}
                <th>المرحلة والحالة</th>
                <th>البيان والإجراءات</th>
              </tr>
            </thead>
            <tbody id="orders-table-tbody">
              ${visibleOrders.map(ord => {
                const st = ord.stage || ord.status || 'pending_executive';
                const items = Array.isArray(ord.items) && ord.items.length > 0 ? ord.items : [{
                  woodTypeName: ord.woodTypeName || 'قشرة خشبية',
                  lengthCm: ord.lengthCm || 250,
                  widthCm: ord.widthCm || 125,
                  thicknessMm: ord.targetThicknessMm || 1.5,
                  direction: ord.targetDirection || 'qas',
                  gradeName: ord.gradeName || 'عام',
                  sheetsCount: ord.totalSheetsProduced || ord.sheetsCount || 0,
                  unitPrice: ord.unitPrice || 0,
                  totalItemAmount: ord.netTotalAmount || 0
                }];
                const subtotal = Number(ord.subtotalAmount ?? ord.netTotalAmount ?? 0);
                const discountAmt = Number(ord.discountAmount || 0);
                const netTotal = Number(ord.netTotalAmount ?? subtotal);
                const isMatched = matchesClientSearchQuery(ord.clientCode, ord.clientName, '', '', ord.orderNumber, ordersSearchQuery);

                return `
                  <tr data-order-search="1" data-code="${ord.clientCode || ''}" data-name="${ord.clientName || ''}" data-ordnum="${ord.orderNumber || ''}" style="${!isMatched ? 'display:none;' : ''}${st === 'ready_for_car_dispatch' ? 'background:rgba(220,38,38,0.06);' : ''}">
                    <td>
                      <strong>${ord.orderNumber}</strong><br/>
                      <small style="color:var(--text-muted);font-size:0.7rem;">📅 ${ord.date || fmtDate(ord.createdAt)}</small><br/>
                      <small style="color:var(--text-muted);font-size:0.68rem;">بواسطة: ${ord.requestedBy || ord.supervisor || 'المحاسب'}</small>
                    </td>
                    <td>
                      <span class="badge badge-info" style="margin-bottom:2px;">${ord.clientCode || 'CL-GEN'}</span><br/>
                      <strong style="font-size:0.82rem;">${ord.clientName || 'عميل عام'}</strong>
                      ${ord.clientPhone ? `<br/><small style="color:var(--text-muted);font-size:0.68rem;">📞 ${ord.clientPhone}</small>` : ''}
                    </td>
                    <td>
                      <div style="display:flex;flex-direction:column;gap:3px;">
                        ${items.map((it, idx) => `
                          <div style="font-size:0.74rem;background:var(--bg-elevated);padding:3px 6px;border-radius:5px;border-right:3px solid ${it.direction === 'sada' ? '#0284c7' : '#d97706'};">
                            <strong>${idx + 1}.</strong> <strong>${it.thicknessMm} مم (${it.direction === 'sada' ? 'سدا' : 'قص'})</strong> × <strong>${it.gradeName}</strong>
                            ${getVeneerDimensionBadgeHtml(it.lengthCm, it.widthCm)}
                            — <strong>${fmtNum(it.sheetsCount, 0)} ق</strong>
                            ${canSeeFinancialPrices() ? `× ${fmtNum(it.unitPrice, 2)} ج = <strong>${fmtMoney(it.totalItemAmount)}</strong>` : `(${fmtNum(it.volumeM3 || 0, 3)} م³)`}
                          </div>
                        `).join('')}
                      </div>
                      <small style="color:var(--text-muted);display:block;margin-top:2px;font-size:0.7rem;">
                        الإجمالي: <strong>${fmtNum(ord.totalSheetsCount || items.reduce((s, i) => s + Number(i.sheetsCount || 0), 0), 0)} قطعة</strong> (${fmtNum(ord.totalVolumeM3 || 0, 3)} م³)
                      </small>
                    </td>
                    ${canSeeFinancialPrices() ? `
                    <td>
                      <div style="font-size:0.72rem;color:var(--text-muted);">إجمالي: ${fmtMoney(subtotal)}</div>
                      ${discountAmt > 0 ? `<div style="font-size:0.72rem;color:var(--danger);font-weight:700;">خصم: -${fmtMoney(discountAmt)}</div>` : ''}
                      <div style="font-size:0.86rem;font-weight:900;color:var(--primary);">الصافي: ${fmtMoney(netTotal)}</div>
                    </td>
                    ` : ''}
                    <td>
                      ${getOrderStageBadge(ord)}
                      ${ord.notes ? `<div style="font-size:0.7rem;color:var(--text-muted);margin-top:2px;">📝 ${ord.notes}</div>` : ''}
                    </td>
                    <td>
                      <div style="display:flex;flex-direction:column;gap:4px;">
                        <button class="btn btn-sm btn-outline" style="border-color:var(--primary);color:var(--primary);font-weight:800;" onclick="openClientOrderStatementModal('${ord.id}')">
                          ${canSeeFinancialPrices() ? '📄 بيان العميل / تعديل وطباعة' : '📄 بيان الكميات للتجهيز'}
                        </button>

                        ${st === 'pending_executive' && isExec ? `
                          <button class="btn btn-sm btn-primary" onclick="approveOrderExecutive('${ord.id}')">
                            ✅ موافقة الإدارة (إرسال للمخزن)
                          </button>
                        ` : ''}

                        ${st === 'pending_warehouse_prep' && isWarehouseOrAdmin ? `
                          <button class="btn btn-sm btn-success" onclick="approveOrderWarehousePrep('${ord.id}')">
                            ✅ موافقة التجهيز والخروج بالمخزن
                          </button>
                        ` : ''}

                        ${st === 'pending_accountant_release' && isAccountantOrExec ? `
                          <button class="btn btn-sm btn-accent" onclick="openAccountantReleaseModal('${ord.id}')">
                            💳 حسابات العميل واعتماد الصرف
                          </button>
                        ` : ''}

                        ${st === 'ready_for_car_dispatch' && isWarehouseOrAdmin ? `
                          <button class="btn btn-sm btn-danger" onclick="openVehicleDispatchVoucherModal('${ord.id}')">
                            🚚 صرف الطلبية وإذن السيارة
                          </button>
                        ` : ''}

                        ${st === 'completed' && ord.carDispatchVoucher ? `
                          <button class="btn btn-sm btn-success" onclick="printVehicleDispatchVoucher('${ord.id}')">
                            🖨️ طباعة إذن السيارة (${ord.carDispatchVoucher.carPlateNumber})
                          </button>
                        ` : ''}

                        ${isExec ? `
                          <div style="display:flex;gap:3px;">
                            <button class="btn btn-sm btn-outline" style="flex:1;padding:2px 5px;font-size:0.68rem;" onclick="openClientOrderStatementModal('${ord.id}')">✏️ تعديل</button>
                            <button class="btn btn-sm btn-danger" style="flex:1;padding:2px 5px;font-size:0.68rem;" onclick="deleteOrderWithStockRestore('${ord.id}')">🗑️ حذف</button>
                          </div>
                        ` : ''}
                      </div>
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      `}
    </div>
  `;
}

// ============================================================================
// 4. MULTI-STAGE APPROVAL WORKFLOW & VEHICLE DISPATCH VOUCHERS (اعتماد أذون الصرف وصرف السيارات)
// ============================================================================
function renderApprovals() {
  const isExec = isFullAdmin(currentUser);
  const isWarehouseOrAdmin = currentUser.roleKey === 'admin_manager' || currentUser.roleKey === 'warehouse_keeper' || isExec;
  const isAccountantOrExec = ['accountant', 'accounts_manager', 'accounting_manager', 'ceo', 'projects_manager'].includes(currentUser.roleKey);

  // Orders that reached Stage 2 (pending_warehouse_prep for warehouse/admin), Stage 3 (pending_accountant_release), Stage 4 (ready_for_car_dispatch), or Completed
  const releaseOrders = (state.productionOrders || []).filter(o => {
    const st = o.stage || o.status;
    if (st === 'pending_warehouse_prep' && isWarehouseOrAdmin) return true;
    return st === 'pending_accountant_release' || st === 'ready_for_car_dispatch' || st === 'completed';
  });

  const pendingPrepOrders = releaseOrders.filter(o => (o.stage || o.status) === 'pending_warehouse_prep');
  const readyForCarOrders = releaseOrders.filter(o => (o.stage || o.status) === 'ready_for_car_dispatch');
  const waitingAccountantOrders = releaseOrders.filter(o => (o.stage || o.status) === 'pending_accountant_release');

  return `
    ${renderSalesReturnsSection()}

    ${pendingPrepOrders.length > 0 && isWarehouseOrAdmin ? `
      <div class="card" style="background:rgba(217,119,6,0.12);border:2px solid #d97706;padding:16px 20px;">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;">
          <div>
            <div style="font-weight:900;font-size:1.05rem;color:#b45309;">
              📦 بانتظار موافقة التجهيز والخروج من المخزن: يوجد (${pendingPrepOrders.length}) طلبية جاهزة لموافقة أمين المخزن أو المدير الإداري!
            </div>
            <small style="color:var(--text-main);">
              بمجرد الضغط على موافقة التجهيز سيتم خصم الكميات من جدول كميات القشرة فوراً وتحويل الطلبية للمحاسب لاعتماد إذن الصرف.
            </small>
          </div>
          <button type="button" class="btn btn-success" onclick="approveOrderWarehousePrep('${pendingPrepOrders[0].id}')">
            ✅ موافقة التجهيز والخروج بالمخزن الآن (${pendingPrepOrders[0].orderNumber})
          </button>
        </div>
      </div>
    ` : ''}

    ${readyForCarOrders.length > 0 && isWarehouseOrAdmin ? `
      <div class="card" style="background:rgba(220,38,38,0.08);border:2px solid var(--danger);padding:16px 20px;">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;">
          <div>
            <div style="font-weight:900;font-size:1.05rem;color:var(--danger);">
              🚨 أمر فوري لأمين المخزن والمدير الإداري: يوجد (${readyForCarOrders.length}) طلبية معتمدة مالياً وجاهزة للصرف وتحميل السيارة!
            </div>
            <small style="color:var(--text-main);">
              تم عمل حسابات العميل والموافقة على إذن الصرف من المحاسب — يرجى صرف الطلبية وعمل إذن صرف للسيارة التي ستقوم بتحميل البضاعة.
            </small>
          </div>
          <button class="btn btn-danger" onclick="openVehicleDispatchVoucherModal('${readyForCarOrders[0].id}')">
            🚚 فتح إذن صرف السيارة الآن (${readyForCarOrders[0].orderNumber})
          </button>
        </div>
      </div>
    ` : ''}

    ${waitingAccountantOrders.length > 0 && isAccountantOrExec ? `
      <div class="card" style="background:rgba(124,58,237,0.08);border:2px solid #7c3aed;padding:16px 20px;">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;">
          <div>
            <div style="font-weight:900;font-size:1.05rem;color:#7c3aed;">
              💳 تنبيه للمحاسب: يوجد (${waitingAccountantOrders.length}) طلبية تم تجهيزها وموافقة المخزن/المدير الإداري عليها وبانتظار عمل حسابات العميل واعتماد إذن الصرف!
            </div>
            <small style="color:var(--text-main);">
              بمجرد موافقتك على إذن الصرف بعد عمل حسابات العميل سيظهر أمر فوري لأمين المخزن والمدير الإداري بصرف الطلبية وعمل إذن صرف للسيارة.
            </small>
          </div>
          <button class="btn btn-primary" style="background:#7c3aed;" onclick="openAccountantReleaseModal('${waitingAccountantOrders[0].id}')">
            💳 عمل حسابات العميل واعتماد الصرف (${waitingAccountantOrders[0].orderNumber})
          </button>
        </div>
      </div>
    ` : ''}

    <div class="card">
      <div class="card-header">
        <div>
          <div class="card-title">✅ اعتماد أذون الصرف وأوامر تحميل وصرف السيارات</div>
          <small style="color:var(--text-muted);">
            هنا تتحول الطلبيات بعد موافقة المدير الإداري أو أمين المخزن إلى المحاسب لاعتماد إذن الصرف بعد عمل حسابات العميل، ثم إصدار إذن صرف للسيارة المحملة بالبضاعة
          </small>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn btn-outline" onclick="printAllApprovalsDispatchReportPdf()">🖨️ طباعة سجل أذون الصرف والسيارات PDF</button>
          <button class="btn btn-primary" onclick="setTab('production')">📋 عرض جميع أوامر تجهيز الطلبيات</button>
        </div>
      </div>

      ${releaseOrders.length === 0 ? `
        <div style="text-align:center;padding:32px;color:var(--text-muted);">
          <div style="font-size:2.2rem;margin-bottom:8px;">✅</div>
          <div style="font-weight:800;color:var(--text-main);">لا توجد أذون صرف في مرحلة الاعتماد المالي أو تحميل السيارات حالياً</div>
          <small>تصل الطلبيات إلى هنا تلقائياً فور موافقة المدير الإداري أو أمين المخزن على تجهيزها في قسم "أوامر تجهيز طلبية للعميل".</small>
        </div>
      ` : `
        <div class="table-responsive">
          <table>
            <thead>
              <tr>
                <th>رقم الطلبية</th>
                <th>العميل</th>
                <th>الأصناف والكميات</th>
                ${canSeeFinancialPrices() ? '<th>الحساب المالي</th>' : ''}
                <th>السيارة والبالتات</th>
                <th>الحالة</th>
                <th>الإجراء</th>
              </tr>
            </thead>
            <tbody>
              ${releaseOrders.map(ord => {
                const st = ord.stage || ord.status;
                const items = Array.isArray(ord.items) ? ord.items : [];
                const car = ord.carDispatchVoucher || null;

                return `
                  <tr style="${st === 'ready_for_car_dispatch' ? 'background:rgba(220,38,38,0.06);' : st === 'pending_accountant_release' ? 'background:rgba(124,58,237,0.05);' : ''}">
                    <td>
                      <strong>${ord.orderNumber}</strong><br/>
                      <small style="color:var(--text-muted);font-size:0.68rem;">📅 ${ord.date}</small>
                    </td>
                    <td>
                      <span class="badge badge-info">${ord.clientCode || 'CL'}</span><br/>
                      <strong style="font-size:0.8rem;">${ord.clientName}</strong>
                    </td>
                    <td>
                      <strong>${items.length} بنود</strong> (${fmtNum(ord.totalSheetsCount || 0, 0)} ق | ${fmtNum(ord.totalVolumeM3 || 0, 3)} م³)<br/>
                      <small style="color:var(--text-muted);font-size:0.7rem;">
                        ${items.map(i => `${i.thicknessMm}مم (${i.direction === 'sada' ? 'سدا' : 'قص'}) ${i.gradeName} [${formatVeneerDimensions(i.lengthCm, i.widthCm, false)}]: ${i.sheetsCount} ق`).join(' + ')}
                      </small>
                    </td>
                    ${canSeeFinancialPrices() ? `
                    <td>
                      <div>الصافي: <strong style="color:var(--primary);">${fmtMoney(ord.netTotalAmount || 0)}</strong></div>
                      ${ord.financialSettlement ? `
                        <small style="color:var(--success);font-weight:700;font-size:0.7rem;">مدفوع: ${fmtMoney(ord.financialSettlement.paidAmount)}</small><br/>
                        <small style="color:var(--danger);font-weight:700;font-size:0.7rem;">متبقي: ${fmtMoney(ord.financialSettlement.remainingDebt)}</small>
                      ` : '<small style="color:var(--text-muted);font-size:0.7rem;">بانتظار حسابات العميل</small>'}
                    </td>
                    ` : ''}
                    <td>
                      ${car ? `
                        <div><strong>🚚 ${car.carPlateNumber}</strong></div>
                        <small style="font-size:0.7rem;">${car.driverName}</small><br/>
                        <span class="badge badge-warning">🪵 مسلم: ${car.palletsDeliveredCount}</span>
                        ${car.palletsReceivedCount > 0 ? `<span class="badge badge-success">مستلم: ${car.palletsReceivedCount}</span>` : ''}
                      ` : '<span style="color:var(--text-muted);font-size:0.72rem;">لم تحمل بعد</span>'}
                    </td>
                    <td>${getOrderStageBadge(ord)}</td>
                    <td>
                      <div style="display:flex;flex-direction:column;gap:4px;">
                        <button type="button" class="btn btn-sm btn-outline" onclick="openClientOrderStatementModal('${ord.id}')">${canSeeFinancialPrices() ? '📄 بيان العميل' : '📄 بيان الكميات'}</button>

                        ${st === 'pending_warehouse_prep' && isWarehouseOrAdmin ? `
                          <button type="button" class="btn btn-sm btn-success" onclick="approveOrderWarehousePrep('${ord.id}')">
                            ✅ موافقة التجهيز والخروج بالمخزن
                          </button>
                        ` : ''}

                        ${st === 'pending_accountant_release' && isAccountantOrExec ? `
                          <button type="button" class="btn btn-sm btn-primary" style="background:#7c3aed;" onclick="openAccountantReleaseModal('${ord.id}')">
                            💳 اعتماد الصرف
                          </button>
                        ` : ''}

                        ${st === 'ready_for_car_dispatch' && isWarehouseOrAdmin ? `
                          <button type="button" class="btn btn-sm btn-danger" onclick="openVehicleDispatchVoucherModal('${ord.id}')">
                            🚚 إذن صرف السيارة
                          </button>
                        ` : ''}

                        ${car ? `
                          <button type="button" class="btn btn-sm btn-success" onclick="printVehicleDispatchVoucher('${ord.id}')">
                            🖨️ طباعة إذن السيارة
                          </button>
                        ` : ''}

                        ${isExec ? `
                          <div style="display:flex;gap:3px;">
                            <button class="btn btn-sm btn-outline" style="flex:1;padding:2px 5px;font-size:0.68rem;" onclick="openClientOrderStatementModal('${ord.id}')">✏️ تعديل</button>
                            <button class="btn btn-sm btn-danger" style="flex:1;padding:2px 5px;font-size:0.68rem;" onclick="deleteOrderWithStockRestore('${ord.id}')">🗑️ حذف</button>
                          </div>
                        ` : ''}
                      </div>
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      `}
    </div>
  `;
}

// ============================================================================
// 5. CLIENTS & SALES ACCOUNTING (الأكواد، الطلبيات الفائتة، المديونيات والمستحقات، وحساب البالتات)
// ============================================================================
function renderAccounting() {
  const tb = state.treasuryBalances || { cashVault: 0, bankAccount: 0, checksUnderCollection: 0 };
  const allClients = (state.partners || []).filter(p => p.type !== 'supplier');

  // Compute metrics for all clients
  const enrichedClients = allClients.map(c => ({
    partner: c,
    metrics: computeClientMetrics(c)
  }));

  const filteredClients = enrichedClients.filter(({ partner }) => {
    if (!clientSearchQuery.trim()) return true;
    const q = clientSearchQuery.trim().toLowerCase();
    return (
      (partner.code || '').toLowerCase().includes(q) ||
      (partner.name || '').toLowerCase().includes(q) ||
      (partner.phone || '').toLowerCase().includes(q) ||
      (partner.city || '').toLowerCase().includes(q)
    );
  });

  // Totals across all clients
  const totalDebtsOnClients = enrichedClients.reduce((s, x) => s + (x.metrics.netDebt > 0 ? x.metrics.netDebt : 0), 0);
  const totalCreditsForClients = enrichedClients.reduce((s, x) => s + (x.metrics.netDebt < 0 ? Math.abs(x.metrics.netDebt) : 0), 0);
  const totalPalletsDeliveredAll = enrichedClients.reduce((s, x) => s + x.metrics.palletsDelivered, 0);
  const totalPalletsReceivedAll = enrichedClients.reduce((s, x) => s + x.metrics.palletsReceived, 0);
  const totalNetPalletsOut = totalPalletsDeliveredAll - totalPalletsReceivedAll;

  return `
    <!-- Top Financial & Pallets Summary Cards -->
    <div class="stats-grid">
      <div class="stat-card danger">
        <span class="stat-title">إجمالي مديونيات المصنع على العملاء (لنا)</span>
        <div class="stat-value">${fmtMoney(totalDebtsOnClients)}</div>
        <div class="stat-sub">مستحقات واجبة التحصيل من العملاء</div>
      </div>

      <div class="stat-card info">
        <span class="stat-title">إجمالي المستحقات الدائنة للعملاء (لهم)</span>
        <div class="stat-value">${fmtMoney(totalCreditsForClients)}</div>
        <div class="stat-sub">دفعات مقدمة أو أرصدة دائنة لصالح العملاء</div>
      </div>

      <div class="stat-card accent">
        <span class="stat-title">حساب البالتات الخشبية طرف العملاء</span>
        <div class="stat-value">${fmtNum(totalNetPalletsOut, 0)} بالتة بالخارج</div>
        <div class="stat-sub">مسلم للعملاء: <strong>${totalPalletsDeliveredAll}</strong> | مستلم منهم: <strong>${totalPalletsReceivedAll}</strong></div>
      </div>

      <div class="stat-card success">
        <span class="stat-title">رصيد خزينة المصنع والبنك</span>
        <div class="stat-value">${fmtMoney(Number(tb.cashVault || 0) + Number(tb.bankAccount || 0))}</div>
        <div class="stat-sub">نقدي بالخزينة: ${fmtMoney(tb.cashVault)}</div>
      </div>
    </div>

    <!-- Main Clients Directory: Codes, Past Orders, Debts/Receivables & Pallets Ledger -->
    <div class="card">
      <div class="card-header">
        <div>
          <div class="card-title">🤝 حسابات ومبيعات العملاء (الأكواد، الطلبيات الفائتة، بيان المديونيات والمستحقات، وحسابات البالتات)</div>
          <small style="color:var(--text-muted);">
            اضغط على <strong>"📂 كشف حساب والطلبيات الفائتة"</strong> لأي عميل لمراجعة كافة طلبياته السابقة، وحركة المديونية، وحركة البالتات المسلمة له والمستلمة منه
          </small>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn btn-primary" onclick="openNewPartnerModal()">➕ إضافة عميل جديد بالكود</button>
          <button class="btn btn-accent" onclick="openNewClientOrderPrepModal()">📋 إنشاء أمر تجهيز طلبية لعميل</button>
          <button class="btn btn-outline" onclick="openNewFinancialTxModal()">💵 تسجيل سند مالي عام بالخزينة</button>
          <button class="btn btn-outline" onclick="printAllClientsAccountingReportPdf()">🖨️ طباعة كشف حسابات جميع العملاء PDF</button>
        </div>
      </div>

      <!-- Search Filter by Client Code or Name -->
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:12px;background:var(--bg-elevated);padding:10px 14px;border-radius:10px;">
        <div style="display:flex;align-items:center;gap:8px;flex:1;min-width:260px;">
          <span>🔍 بحث بكود العميل أو الاسم أو التليفون:</span>
          <input id="client-search-input" class="form-control" style="max-width:340px;" placeholder="اكتب الكود كامل (مثل CL-101) أو اسم العميل..." value="${clientSearchQuery}" oninput="handleClientSearchInput(this.value)" />
          <button id="client-search-clear-btn" type="button" class="btn btn-sm btn-outline" style="display:${clientSearchQuery.trim() ? 'inline-flex' : 'none'};" onclick="document.getElementById('client-search-input').value=''; handleClientSearchInput('');">إلغاء البحث</button>
        </div>
        <div style="font-size:0.8rem;font-weight:700;color:var(--text-muted);">
          إجمالي العملاء المسجلين: <strong>${allClients.length} عميل</strong>
        </div>
      </div>

      <div class="table-responsive">
        <table>
          <thead>
            <tr>
              <th>الكود</th>
              <th>العميل</th>
              <th>الطلبيات</th>
              <th>المسحوبات</th>
              <th>المدفوعات</th>
              <th>صافي المديونية</th>
              <th>البالتات</th>
              <th>إجراءات العميل</th>
            </tr>
          </thead>
          <tbody id="clients-directory-tbody">
            <tr id="clients-empty-search-row" style="display:${filteredClients.length === 0 ? '' : 'none'};">
              <td colspan="8" style="text-align:center;padding:20px;color:var(--text-muted);">
                لا يوجد عملاء مطابقون لهذا البحث. اضغط على <strong>"➕ إضافة عميل جديد بالكود"</strong> لإضافة عميل.
              </td>
            </tr>
            ${enrichedClients.map(({ partner: pt, metrics: m }) => {
              const isDebtor = m.netDebt > 0;
              const isCreditor = m.netDebt < 0;
              const isVisible = matchesClientSearchQuery(pt.code, pt.name, pt.phone, pt.city, '', clientSearchQuery);

              return `
                <tr data-client-search="1" data-code="${pt.code || ''}" data-name="${pt.name || ''}" data-phone="${pt.phone || ''}" data-city="${pt.city || ''}" style="${isVisible ? '' : 'display:none;'}">
                  <td>
                    <span class="badge badge-info">${pt.code || 'CL-001'}</span>
                  </td>
                  <td>
                    <strong style="font-size:0.82rem;">${pt.name}</strong><br/>
                    <small style="color:var(--text-muted);font-size:0.68rem;">${pt.phone || '-'} | ${pt.city || '-'}</small>
                  </td>
                  <td>
                    <strong>${m.orders.length} طلبية</strong><br/>
                    <button class="btn btn-sm btn-outline" style="padding:1px 6px;font-size:0.68rem;margin-top:2px;" onclick="openClientFullHistoryModal('${pt.id}', 'orders')">
                      👁️ فحص (${m.orders.length})
                    </button>
                  </td>
                  <td><strong>${fmtMoney(m.totalDebit)}</strong></td>
                  <td style="color:var(--success);font-weight:700;">${fmtMoney(m.totalCredit)}</td>
                  <td>
                    ${isDebtor ? `
                      <span class="badge badge-danger">
                        عليه: ${fmtMoney(m.netDebt)}
                      </span>
                    ` : isCreditor ? `
                      <span class="badge badge-success">
                        له: ${fmtMoney(Math.abs(m.netDebt))}
                      </span>
                    ` : `
                      <span class="badge" style="background:#64748b;color:#fff;">خالص (0)</span>
                    `}
                  </td>
                  <td>
                    <div style="font-size:0.72rem;line-height:1.4;">
                      <span>مسلم: <strong>${m.palletsDelivered}</strong></span> |
                      <span>مستلم: <strong style="color:var(--success);">${m.palletsReceived}</strong></span><br/>
                      <span class="badge ${m.netPalletsAtClient > 0 ? 'badge-warning' : 'badge-success'}">
                        🪵 طرفه: ${m.netPalletsAtClient}
                      </span>
                    </div>
                  </td>
                  <td>
                    <div style="display:flex;flex-wrap:wrap;gap:3px;">
                      <button class="btn btn-sm btn-primary" onclick="openClientFullHistoryModal('${pt.id}', 'all')">
                        📂 كشف الحساب
                      </button>
                      <button class="btn btn-sm btn-success" onclick="openClientPaymentModal('${pt.id}')">
                        💵 تحصيل
                      </button>
                      <button class="btn btn-sm btn-accent" onclick="openClientPalletMovementModal('${pt.id}')">
                        🪵 بالتات
                      </button>
                      <button class="btn btn-sm btn-outline" onclick="printClientFullStatement('${pt.id}')">
                        🖨️ طباعة
                      </button>
                      ${isFullAdmin(currentUser) ? `
                        <button class="btn btn-sm btn-outline" onclick="openEditPartnerModal('${pt.id}')" title="تعديل">✏️</button>
                        <button class="btn btn-sm btn-danger" onclick="deletePartnerRecord('${pt.id}')" title="حذف">🗑️</button>
                      ` : ''}
                    </div>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Recent Financial Transactions & Pallet Movements -->
    <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(440px, 1fr));gap:20px;">
      <div class="card">
        <div class="card-header">
          <div class="card-title">💰 آخر الفواتير والتحصيلات المالية للعملاء</div>
          <button class="btn btn-sm btn-outline" onclick="printAllFinancialTransactionsReportPdf()">🖨️ طباعة سجل الفواتير PDF</button>
        </div>
        <div class="table-responsive">
          <table>
            <thead>
              <tr>
                <th>رقم المستند</th>
                <th>التاريخ</th>
                <th>العميل</th>
                <th>البيان</th>
                <th>الإجمالي</th>
                <th>المدفوع</th>
                <th>المتبقي</th>
                <th>إجراءات</th>
              </tr>
            </thead>
            <tbody>
              ${(state.financialTransactions || []).slice(0, 25).map(tx => `
                <tr>
                  <td><strong>${tx.voucherNo}</strong></td>
                  <td>${tx.date}</td>
                  <td><strong>${tx.partnerName || '-'}</strong></td>
                  <td>${tx.description}</td>
                  <td><strong>${fmtMoney(tx.totalAmount)}</strong></td>
                  <td style="color:var(--success);font-weight:700;">${fmtMoney(tx.paidAmount)}</td>
                  <td style="color:${Number(tx.remainingAmount) > 0 ? 'var(--danger)' : 'var(--success)'};font-weight:700;">
                    ${fmtMoney(tx.remainingAmount)}
                  </td>
                  <td>
                    <div style="display:flex;gap:4px;">
                      <button class="btn btn-sm btn-outline" style="padding:3px 7px;" onclick="printFinancialInvoice('${tx.id}')" title="طباعة">🖨️</button>
                      ${isFullAdmin(currentUser) ? `
                        <button class="btn btn-sm btn-outline" style="padding:3px 7px;" onclick="openEditFinancialTxModal('${tx.id}')" title="تعديل السند المالي">✏️</button>
                        <button class="btn btn-sm btn-danger" style="padding:3px 7px;" onclick="deleteFinancialTxRecord('${tx.id}')" title="حذف السند المالي">🗑️</button>
                      ` : ''}
                    </div>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title">🪵 سجل حركة البالتات المسلمة للعملاء والمستلمة منهم</div>
          <button class="btn btn-sm btn-outline" onclick="printAllPalletMovementsReportPdf()">🖨️ طباعة سجل البالتات PDF</button>
        </div>
        <div class="table-responsive">
          <table>
            <thead>
              <tr>
                <th>التاريخ</th>
                <th>العميل وكوده</th>
                <th>مسلم للعميل</th>
                <th>مستلم من العميل</th>
                <th>السيارة / البيان</th>
                ${isFullAdmin(currentUser) ? '<th>تعديل / حذف</th>' : ''}
              </tr>
            </thead>
            <tbody>
              ${(state.palletMovements || []).length === 0 ? `
                <tr><td colspan="${isFullAdmin(currentUser) ? 6 : 5}" style="text-align:center;padding:20px;color:var(--text-muted);">لا توجد حركات بالتات مسجلة بعد.</td></tr>
              ` : (state.palletMovements || []).slice(0, 25).map(pm => `
                <tr>
                  <td>${pm.date}</td>
                  <td><strong>${pm.clientName}</strong> <small style="color:var(--text-muted);">(${pm.clientCode || ''})</small></td>
                  <td><span class="badge badge-warning">+${pm.deliveredCount || 0} بالتة مسلمة</span></td>
                  <td><span class="badge badge-success">-${pm.receivedCount || 0} بالتة مستلمة</span></td>
                  <td>${pm.notes || pm.carPlateNumber || '-'}</td>
                  ${isFullAdmin(currentUser) ? `
                    <td>
                      <div style="display:flex;gap:4px;">
                        <button class="btn btn-sm btn-outline" style="padding:3px 7px;" onclick="openEditPalletMovementModal('${pm.id}')" title="تعديل حركة البالتات">✏️</button>
                        <button class="btn btn-sm btn-danger" style="padding:3px 7px;" onclick="deletePalletMovementRecord('${pm.id}')" title="حذف حركة البالتات">🗑️</button>
                      </div>
                    </td>
                  ` : ''}
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

// ============================================================================
// 6. REPORTS & AUDIT LOG
// ============================================================================
function renderReports() {
  // Summarize inventory by wood type
  const woodSummary = state.catalog.woodTypes.map(wt => {
    const pallets = (state.pallets || []).filter(p => p.woodTypeId === wt.id && p.status === 'in_stock');
    const sheets = pallets.reduce((s, p) => s + Number(p.sheetsCount || 0), 0);
    const m3 = pallets.reduce((s, p) => s + Number(p.volumeM3 || 0), 0);
    const val = pallets.reduce((s, p) => s + Number(p.totalValue || 0), 0);
    return { name: wt.name, palletsCount: pallets.length, sheets, m3, val };
  });

  return `
    <!-- Central PDF Print Hub for All Factory Reports -->
    <div class="card" style="border:2px solid var(--primary);background:linear-gradient(135deg, rgba(15,118,110,0.06), rgba(217,119,6,0.06));">
      <div class="card-header">
        <div>
          <div class="card-title">🖨️ مركز طباعة وتصدير جميع التقارير والجداول بصيغة PDF</div>
          <small style="color:var(--text-muted);">اضغط على أي تقرير لفتحه في وضع الطباعة الرسمي أو حفظه كملف PDF مباشرة</small>
        </div>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;">
        <button class="btn btn-primary" onclick="printVeneerQuantitiesMatrixPdf()">🖨️ جدول كميات القشرة PDF</button>
        ${canSeeFinancialPrices() ? `
          <button class="btn btn-accent" onclick="printVeneerPricesMatrixPdf()">🖨️ جدول الأسعار PDF</button>
          <button class="btn btn-outline" style="border-color:var(--primary);color:var(--primary);font-weight:800;" onclick="printBothMatricesPdf()">🖨️ جدول الكميات + الأسعار معاً PDF</button>
        ` : ''}
        <button class="btn btn-outline" onclick="printPalletsInventoryPdf()">🖨️ سجل البالتات بالمخزن PDF</button>
        <button class="btn btn-outline" onclick="printSalesReturnsReportPdf()">🖨️ سجل مرتجعات المبيعات PDF</button>
        <button class="btn btn-outline" onclick="printRawMaterialsReportPdf()">🖨️ جرد مخزن الخامات PDF</button>
        <button class="btn btn-outline" onclick="printScrapReportPdf()">🖨️ جرد مخزن الهالك PDF</button>
        <button class="btn btn-outline" onclick="printSparePartsReportPdf()">🖨️ جرد قطع الغيار PDF</button>
        <button class="btn btn-outline" onclick="printWarehouseMovementsReportPdf()">🖨️ سجل حركات المخازن PDF</button>
        <button class="btn btn-outline" onclick="printAllProductionOrdersReportPdf()">🖨️ سجل أوامر التجهيز PDF</button>
        <button class="btn btn-outline" onclick="printAllApprovalsDispatchReportPdf()">🖨️ سجل أذون الصرف والسيارات PDF</button>
        ${canSeeFinancialPrices() ? `
          <button class="btn btn-outline" onclick="printAllClientsAccountingReportPdf()">🖨️ كشف حسابات جميع العملاء PDF</button>
          <button class="btn btn-outline" onclick="printAllFinancialTransactionsReportPdf()">🖨️ سجل الفواتير والتحصيلات PDF</button>
          <button class="btn btn-outline" onclick="printAllPalletMovementsReportPdf()">🖨️ سجل حركة البالتات مع العملاء PDF</button>
        ` : ''}
        <button class="btn btn-outline" onclick="printGeneralInventoryAndAuditReportPdf()">🖨️ تقرير الجرد العام والرقابة PDF</button>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <div class="card-title">📈 ${canSeeFinancialPrices() ? 'تقرير جرد وتقييم القشرة الخشبية حسب نوع الخشب' : 'تقرير جرد أرصدة كميات القشرة الخشبية بالمخازن (كميات فقط)'}</div>
        <button class="btn btn-outline" onclick="printGeneralInventoryAndAuditReportPdf()">🖨️ طباعة التقرير PDF</button>
      </div>
      <div class="table-responsive">
        <table>
          <thead>
            <tr>
              <th>نوع الخشب</th>
              <th>عدد البالتات المتاحة</th>
              <th>إجمالي عدد الأفرخ (250×125)</th>
              <th>إجمالي الحجم بالمتر المكعب (م³)</th>
              ${canSeeFinancialPrices() ? '<th>القيمة السوقية التقديرية</th>' : ''}
            </tr>
          </thead>
          <tbody>
            ${woodSummary.map(ws => `
              <tr>
                <td><strong>${ws.name}</strong></td>
                <td>${ws.palletsCount} بالتة</td>
                <td>${fmtNum(ws.sheets, 0)} فرخ</td>
                <td><strong>${fmtNum(ws.m3, 4)} م³</strong></td>
                ${canSeeFinancialPrices() ? `<td><strong>${fmtMoney(ws.val)}</strong></td>` : ''}
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <div class="card-title">🛡️ سجل الرقابة والحركات الإدارية (Audit Log)</div>
        <button class="btn btn-sm btn-outline" onclick="printAuditLogReportPdf()">🖨️ طباعة سجل الرقابة PDF</button>
      </div>
      <div class="table-responsive">
        <table>
          <thead>
            <tr>
              <th>التوقيت</th>
              <th>المستخدم</th>
              <th>الوظيفة</th>
              <th>العملية المنفذة</th>
            </tr>
          </thead>
          <tbody>
            ${(state.auditLogs || []).filter(l => canUserSeeNotification(currentUser, l)).slice(0, 30).map(l => `
              <tr>
                <td>${new Date(l.timestamp).toLocaleString('ar-EG')}</td>
                <td><strong>${l.userName}</strong></td>
                <td>${l.roleTitle}</td>
                <td>${sanitizeTextForWarehouseKeeper(l.action)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

// ============================================================================
// 7. DYNAMIC CATALOG & 8 USERS PERMISSIONS SETTINGS
// ============================================================================
function renderSettings() {
  return `
    <div class="tabs-bar">
      <button class="tab-btn ${activeSettingsSubTab === 'catalog' ? 'active' : ''}" onclick="activeSettingsSubTab='catalog'; render();">
        🪵 إعدادات أنواع الخشب والتخانات والجودة
      </button>
      <button class="tab-btn ${activeSettingsSubTab === 'users' ? 'active' : ''}" onclick="activeSettingsSubTab='users'; render();">
        👥 إدارة الـ 8 مستخدمين ومصفوفة الصلاحيات
      </button>
      <button class="tab-btn ${activeSettingsSubTab === 'backup' ? 'active' : ''}" onclick="activeSettingsSubTab='backup'; render();">
        💾 النسخ الاحتياطي وبيانات المصنع
      </button>
    </div>

    ${activeSettingsSubTab === 'catalog' ? renderCatalogSettings() : ''}
    ${activeSettingsSubTab === 'users' ? renderUsersPermissionsSettings() : ''}
    ${activeSettingsSubTab === 'backup' ? renderBackupSettings() : ''}
  `;
}

function renderCatalogSettings() {
  return `
    <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(400px, 1fr));gap:20px;">
      <!-- Wood Types -->
      <div class="card">
        <div class="card-header">
          <div class="card-title">🌳 أنواع الأخشاب المعتمدة بالمصنع</div>
          <button class="btn btn-sm btn-primary" onclick="addWoodTypePrompt()">➕ إضافة نوع خشب</button>
        </div>
        <table>
          <thead>
            <tr><th>الكود</th><th>اسم الخشب</th>${canSeeFinancialPrices() ? '<th>متوسط سعر المتر الخام</th>' : ''}</tr>
          </thead>
          <tbody>
            ${state.catalog.woodTypes.map(w => `
              <tr>
                <td><strong>${w.code}</strong></td>
                <td>${w.name}</td>
                ${canSeeFinancialPrices() ? `<td>${fmtMoney(w.defaultLogPricePerM3)}</td>` : ''}
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      <!-- Thicknesses -->
      <div class="card">
        <div class="card-header">
          <div class="card-title">📏 تخانات القشرة الخشبية واتجاهها (قص / سدا)</div>
          <button class="btn btn-sm btn-primary" onclick="openAddThicknessModal()">➕ إضافة تخانة (قص / سدا)</button>
        </div>
        <table>
          <thead>
            <tr><th>التخانة (مم)</th><th>الاتجاه</th><th>الوصف</th><th>عدد القطع بالبالتة</th></tr>
          </thead>
          <tbody>
            ${state.catalog.thicknesses.map(t => `
              <tr>
                <td><strong>${t.mm} مم</strong></td>
                <td>
                  <span class="badge" style="background:${t.direction === 'sada' ? '#0284c7' : '#d97706'};color:#fff;">
                    ${t.direction === 'sada' ? '📏 اتجاه سدا' : '✂️ اتجاه قص'}
                  </span>
                </td>
                <td>${t.label || ''}</td>
                <td>${t.standardSheetsPerPallet} قطعة</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      <!-- Grades -->
      <div class="card">
        <div class="card-header">
          <div class="card-title">⭐ درجات جودة وفرز القشرة</div>
          <button class="btn btn-sm btn-primary" onclick="addGradePrompt()">➕ إضافة درجة جودة</button>
        </div>
        <table>
          <thead>
            <tr><th>الدرجة</th><th>المسمى</th>${canSeeFinancialPrices() ? '<th>السعر الاسترشادي للمتر المكعب</th>' : ''}</tr>
          </thead>
          <tbody>
            ${state.catalog.grades.map(g => `
              <tr>
                <td><span class="badge badge-info">${g.code}</span></td>
                <td><strong>${g.name}</strong><br/><small style="color:var(--text-muted);">${g.description || ''}</small></td>
                ${canSeeFinancialPrices() ? `<td><strong>${fmtMoney(g.defaultPricePerM3)}</strong></td>` : ''}
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      <!-- Approved & Custom Company Dimensions -->
      <div class="card">
        <div class="card-header">
          <div class="card-title">📐 مقاسات القشرة (المقاس المعتمد 125×250 سم + مقاسات الشركات الخاصة)</div>
          <button class="btn btn-sm btn-primary" onclick="openCustomDimensionsModal()">➕ إدارة وإضافة مقاس خاص</button>
        </div>
        <table>
          <thead>
            <tr><th>المقاس (العرض × الطول)</th><th>مساحة الفرخ (م²)</th><th>النوع / الشركات</th></tr>
          </thead>
          <tbody>
            ${getPresetVeneerDimensions().map(d => {
              const area = +((Number(d.lengthCm) / 100) * (Number(d.widthCm) / 100)).toFixed(4);
              return `
                <tr>
                  <td><strong>${d.widthCm} × ${d.lengthCm} سم</strong></td>
                  <td>${area} م²</td>
                  <td>
                    ${d.isStandard
                      ? `<span class="badge badge-success">المقاس المعتمد الأساسي</span>`
                      : `<span class="badge" style="background:#7c3aed;color:#fff;">مقاس خاص للشركات</span> <small style="color:var(--text-muted);">${d.clientNote || ''}</small>`}
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderUsersPermissionsSettings() {
  const permKeys = [
    { key: 'warehouses', label: 'عرض المخازن' },
    { key: 'warehouseIssueReceive', label: 'استلام وصرف مخزني' },
    { key: 'production', label: 'أوامر تجهيز طلبية للعميل' },
    { key: 'approveFinancial', label: 'اعتماد مالي (حسابات)' },
    { key: 'approveWarehouse', label: 'تنفيذ صرف (أمين مخزن)' },
    { key: 'approveExecutive', label: 'اعتماد تنفيذي شامل' },
    { key: 'salesAccounting', label: 'حسابات ومبيعات العملاء' },
    { key: 'reports', label: 'التقارير' }
  ];

  const canManagePerms = isFullAdmin(currentUser);

  return `
    <div class="card">
      <div class="card-header">
        <div>
          <div class="card-title">👥 إدارة الـ 8 مستخدمين وتخصيص الصلاحيات والباسوردات (PIN)</div>
          <small style="color:var(--text-muted);">
            🔒 <strong>المدير التنفيذي</strong> و<strong>مدير المشروعات</strong> لهما كامل الصلاحيات الدائمة وحق منح الصلاحيات وتغيير باسوردات جميع المستخدمين والموبايلات، <strong>ولا يحق لأي مستخدم تعديل صلاحياته</strong>.
          </small>
        </div>
        <button class="btn btn-primary" onclick="openPasswordsManagerModal()">
          🔑 تغيير الباسوردات (الخاص بي والموبايلات)
        </button>
      </div>

      <div class="table-responsive">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>الاسم والمنصب</th>
              <th>الباسورد (PIN)</th>
              ${permKeys.map(pk => `<th>${pk.label}</th>`).join('')}
              <th>تعديل الباسورد / الاسم</th>
            </tr>
          </thead>
          <tbody>
            ${state.users.map((u, idx) => {
              const targetIsFullAdmin = isFullAdmin(u);
              const isSelf = currentUser && u.id === currentUser.id;
              const disableCheckbox = !canManagePerms || targetIsFullAdmin || isSelf;
              return `
                <tr>
                  <td><strong>${idx + 1}</strong></td>
                  <td>
                    <strong>${u.name}</strong>
                    ${targetIsFullAdmin ? `<span class="badge badge-success" style="margin-right:4px;">كامل الصلاحيات</span>` : ''}
                    <br/>
                    <small style="color:var(--text-muted);">${u.roleTitle}</small>
                  </td>
                  <td><code>${canManagePerms || isSelf ? u.pin : '****'}</code></td>
                  ${permKeys.map(pk => `
                    <td style="text-align:center;">
                      <input type="checkbox" ${targetIsFullAdmin || (u.permissions && u.permissions[pk.key]) ? 'checked' : ''}
                        ${disableCheckbox ? 'disabled' : ''}
                        title="${targetIsFullAdmin ? 'صلاحية كاملة دائمة' : isSelf ? 'لا يحق لأي مستخدم تعديل صلاحياته' : ''}"
                        onchange="toggleUserPerm('${u.id}', '${pk.key}', this.checked)" />
                    </td>
                  `).join('')}
                  <td>
                    ${canManagePerms || isSelf ? `
                      <button class="btn btn-sm btn-primary" onclick="openPasswordsManagerModal('${u.id}')">🔑 تغيير الباسورد</button>
                    ` : '-'}
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderBackupSettings() {
  return `
    <div class="card">
      <div class="card-header">
        <div class="card-title">🖼️ لوجو الشركة الرسمي (في واجهة النظام وأعلى يسار جميع التقارير والأذونات)</div>
      </div>
      <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;">
        <div style="background:#fff;border:1px solid var(--border-color);border-radius:10px;padding:8px 14px;">
          <img src="${getFactoryLogoSrc()}" alt="لوجو الشركة" style="height:56px;max-width:160px;object-fit:contain;display:block;" />
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          <button class="btn btn-primary" onclick="openFactoryLogoModal()">📤 رفع / تغيير لوجو الشركة</button>
          ${state?.factoryInfo?.logoDataUrl ? `<button class="btn btn-outline" onclick="resetFactoryLogoToDefault()">🔄 استعادة اللوجو الافتراضي</button>` : ''}
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <div class="card-title">💾 النسخ الاحتياطي الكامل وإعدادات مصنع العاصمة</div>
      </div>
      <div style="display:flex;gap:12px;flex-wrap:wrap;">
        <button class="btn btn-primary" onclick="downloadBackupJson()">⬇️ تحميل نسخة احتياطية كاملة (JSON)</button>
        <button class="btn btn-accent" onclick="exportPalletsCsv()">📊 تصدير جرد القشرة لملف إكسيل (CSV)</button>
        <button class="btn btn-danger" onclick="resetAllFactoryData()">🗑️ تصفير وتفريغ النظام بالكامل (بدء من الصفر)</button>
      </div>
    </div>
  `;
}

async function resetAllFactoryData() {
  if (!confirm('هل أنت متأكد من تصفير وتفريغ جميع الخامات والطلبات والتخانات والبدء بنظام فارغ تماماً؟')) return;
  try {
    const res = await fetch('/api/reset', { method: 'POST' });
    if (res.ok) {
      state = await res.json();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      render();
      alert('تم تصفير وتفريغ النظام بالكامل بنجاح!');
    }
  } catch (e) {
    alert('حدث خطأ أثناء التصفير: ' + e.message);
  }
}

// ============================================================================
// MODALS & INTERACTIVE OPERATIONS
// ============================================================================
function closeModal() {
  document.getElementById('modal-root').innerHTML = '';
}

// 1. Add Finished Veneer Pallet Modal
function openAddPalletModal() {
  const modalRoot = document.getElementById('modal-root');
  const nextNum = (state.pallets?.length || 0) + 1;
  const defaultCode = `PLT-2026-00${nextNum}`;
  const presetDims = getPresetVeneerDimensions();

  modalRoot.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal-box" style="max-width:720px;">
        <div class="card-header">
          <div>
            <div class="card-title">➕ إضافة بالتة قشرة خشبية جديدة (المقاس المعتمد 125×250 سم أو مقاس خاص للشركات وتخانة محددة)</div>
            <small style="color:var(--text-muted);">يمكنك اختيار المقاس المعتمد (125×250 سم) أو إدخال أي مقاس خاص وتخانة محددة مطلوبة للشركات</small>
          </div>
          <button class="btn btn-sm btn-outline" onclick="closeModal()">✕</button>
        </div>

        <form onsubmit="submitAddPallet(event)">
          <div class="form-grid">
            <div class="form-group">
              <label>تاريخ الإضافة / الدخول للمخزن (يسمح بأي تاريخ سابق)</label>
              <input id="plt-date" type="date" class="form-control" value="${todayStr()}" required />
            </div>
            <div class="form-group">
              <label>كود البالتة (الباركود)</label>
              <input id="plt-code" class="form-control" value="${defaultCode}" required />
            </div>
            <div class="form-group">
              <label>نوع الخشب</label>
              <select id="plt-wood" class="form-control" required>
                ${state.catalog.woodTypes.length === 0 ? `<option value="wt-general">قشرة خشبية عامة (125×250)</option>` : ''}
                ${state.catalog.woodTypes.map(w => `<option value="${w.id}">${w.name}</option>`).join('')}
              </select>
            </div>
            <div class="form-group">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:3px;">
                <label style="margin:0;">التخانة والاتجاه (قص / سدا أو تخانة محددة)</label>
                <button type="button" class="btn btn-sm btn-outline" style="padding:1px 6px;font-size:0.68rem;" onclick="const box=document.getElementById('plt-custom-thk-box'); box.style.display=box.style.display==='none'?'flex':'none';">
                  ➕ تخانة محددة جديدة
                </button>
              </div>
              ${state.catalog.thicknesses.length > 0 ? `
                <select id="plt-thk-id" class="form-control" onchange="recalcModalPallet()">
                  ${getSortedThicknesses().map(t => `<option value="${t.id}" data-mm="${t.mm}" data-dir="${t.direction || 'qas'}" data-sheets="${t.standardSheetsPerPallet}">${t.mm} مم — ${t.direction === 'sada' ? 'اتجاه سدا' : 'اتجاه قص'} (${t.label || ''})</option>`).join('')}
                </select>
              ` : ''}
              <div id="plt-custom-thk-box" style="display:${state.catalog.thicknesses.length === 0 ? 'flex' : 'none'};gap:6px;margin-top:5px;background:rgba(124,58,237,0.08);padding:6px;border-radius:8px;border:1px dashed #7c3aed;">
                <input id="plt-thk-mm" type="number" step="0.05" min="0.1" class="form-control" placeholder="اكتب التخانة بالـ مم (مثل 0.9 أو 1.8)" oninput="recalcModalPallet()" />
                <select id="plt-thk-dir" class="form-control" style="max-width:130px;" onchange="recalcModalPallet()">
                  <option value="qas">✂️ اتجاه قص</option>
                  <option value="sada">📏 اتجاه سدا</option>
                </select>
              </div>
            </div>
            <div class="form-group">
              <label>درجة الجودة والفرز</label>
              <select id="plt-grade" class="form-control" onchange="recalcModalPallet()">
                ${state.catalog.grades.length === 0 ? `<option value="gr-general" data-price="50">جودة عامة</option>` : ''}
                ${state.catalog.grades.map(g => `<option value="${g.id}" data-price="${g.defaultPricePerM3}">${g.name} (${g.code})</option>`).join('')}
              </select>
            </div>
            <div class="form-group">
              <label>عدد القطع (الأفرخ) في البالتة</label>
              <input id="plt-sheets" type="number" class="form-control" value="400" oninput="recalcModalPallet()" required />
            </div>
            ${canSeeFinancialPrices() ? `
            <div class="form-group">
              <label>سعر القطعة الواحدة (الفرخ) بالجنيه</label>
              <input id="plt-piece-price" type="number" step="0.5" class="form-control" value="50" oninput="recalcModalPallet()" required />
            </div>
            ` : `<input id="plt-piece-price" type="hidden" value="0" />`}
            <div class="form-group" style="grid-column: span 2;background:rgba(15,118,110,0.06);padding:10px 12px;border-radius:10px;border:1px solid rgba(15,118,110,0.25);">
              <label style="color:var(--primary);font-weight:800;">📐 مقاس القشرة (المقاس المعتمد 125 سم × 250 سم أو مقاس خاص للشركات)</label>
              <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:4px;">
                <select id="plt-dim-preset" class="form-control" style="max-width:280px;font-weight:800;" onchange="if(this.value!=='custom'){const [l,w]=this.value.split('x').map(Number);document.getElementById('plt-wid').value=w;document.getElementById('plt-len').value=l;recalcModalPallet();}">
                  ${presetDims.map(d => `<option value="${d.lengthCm}x${d.widthCm}" ${d.isStandard ? 'selected' : ''}>${d.label}</option>`).join('')}
                  <option value="custom">✏️ كتابة مقاس خاص آخر (العرض × الطول سم)...</option>
                </select>
                <div style="display:flex;align-items:center;gap:4px;">
                  <span style="font-size:0.76rem;font-weight:700;">العرض (سم):</span>
                  <input id="plt-wid" type="number" step="0.5" min="10" class="form-control" style="width:82px;font-weight:800;" value="125" oninput="document.getElementById('plt-dim-preset').value='custom'; recalcModalPallet();" required />
                </div>
                <span style="font-weight:900;">×</span>
                <div style="display:flex;align-items:center;gap:4px;">
                  <span style="font-size:0.76rem;font-weight:700;">الطول (سم):</span>
                  <input id="plt-len" type="number" step="0.5" min="10" class="form-control" style="width:82px;font-weight:800;" value="250" oninput="document.getElementById('plt-dim-preset').value='custom'; recalcModalPallet();" required />
                </div>
              </div>
            </div>
            <div class="form-group">
              <label>موقع التخزين بالمصنع</label>
              <input id="plt-loc" class="form-control" value="عنبر أ - صف 1" />
            </div>
            <div class="form-group">
              <label>رقم التشغيلة / الباتش / اسم الشركة صاحبة المقاس</label>
              <input id="plt-batch" class="form-control" value="BATCH-26-01" />
            </div>
          </div>

          <div id="plt-calc-preview" class="calc-preview-box"></div>

          <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px;">
            <button type="button" class="btn btn-outline" onclick="closeModal()">إلغاء</button>
            <button type="submit" class="btn btn-primary">💾 حفظ البالتة وإصدار إذن إضافة مخزني</button>
          </div>
        </form>
      </div>
    </div>
  `;
  recalcModalPallet();
}

function recalcModalPallet() {
  const len = Number(document.getElementById('plt-len')?.value || 250);
  const wid = Number(document.getElementById('plt-wid')?.value || 125);
  const customMmVal = Number(document.getElementById('plt-thk-mm')?.value || 0);
  const customBox = document.getElementById('plt-custom-thk-box');
  const useCustomThk = customBox && customBox.style.display !== 'none' && customMmVal > 0;
  const thkSel = document.getElementById('plt-thk-id');
  const thk = useCustomThk
    ? customMmVal
    : (thkSel ? Number(thkSel.selectedOptions[0]?.dataset?.mm || 1.5) : (customMmVal || 1.5));
  const sheets = Number(document.getElementById('plt-sheets')?.value || 400);
  const piecePrice = Number(document.getElementById('plt-piece-price')?.value || 0);
  const m = calculateVeneerMetrics(len, wid, thk, sheets);
  const totalVal = +(sheets * piecePrice).toFixed(2);
  const box = document.getElementById('plt-calc-preview');
  if (box) {
    box.innerHTML = `
      <div class="calc-preview-item"><span>المقاس والتخانة</span><strong>${formatVeneerDimensions(len, wid, true)} | ${thk} مم</strong></div>
      <div class="calc-preview-item"><span>المساحة الإجمالية</span><strong>${fmtNum(m.totalAreaM2, 2)} م² (${fmtNum(m.sheetAreaM2, 4)} م²/فرخ)</strong></div>
      <div class="calc-preview-item"><span>الحجم الفعلي للبالتة</span><strong>${fmtNum(m.totalVolumeM3, 4)} م³</strong></div>
      ${canSeeFinancialPrices() ? `<div class="calc-preview-item"><span>القيمة بسعر القطعة (${fmtNum(piecePrice, 2)} ج)</span><strong>${fmtMoney(totalVal)}</strong></div>` : ''}
    `;
  }
}

function submitAddPallet(e) {
  e.preventDefault();
  const opDate = document.getElementById('plt-date')?.value || todayStr();
  const code = document.getElementById('plt-code').value.trim();
  const woodId = document.getElementById('plt-wood').value;
  const woodObj = state.catalog.woodTypes.find(w => w.id === woodId);
  const len = Number(document.getElementById('plt-len').value || 250);
  const wid = Number(document.getElementById('plt-wid').value || 125);
  const gradeId = document.getElementById('plt-grade').value;
  const gradeObj = state.catalog.grades.find(g => g.id === gradeId);
  const sheets = Number(document.getElementById('plt-sheets').value);
  const piecePrice = Number(document.getElementById('plt-piece-price').value || 0);
  const loc = document.getElementById('plt-loc').value.trim();
  const batch = document.getElementById('plt-batch').value.trim();

  const customMmVal = Number(document.getElementById('plt-thk-mm')?.value || 0);
  const customBox = document.getElementById('plt-custom-thk-box');
  const useCustomThk = customBox && customBox.style.display !== 'none' && customMmVal > 0;
  const thkSel = document.getElementById('plt-thk-id');
  let thkObj = null;
  let thkMm = 1.5;
  let direction = 'qas';
  let thkId = '';

  if (useCustomThk || !thkSel) {
    thkMm = customMmVal || 1.5;
    direction = document.getElementById('plt-thk-dir')?.value || 'qas';
    thkObj = ensureCatalogThicknessExists(thkMm, direction, piecePrice, gradeId);
    thkId = thkObj ? thkObj.id : `th-${thkMm}-${direction}`;
  } else {
    thkId = thkSel.value;
    thkObj = state.catalog.thicknesses.find(t => t.id === thkId);
    thkMm = thkObj ? Number(thkObj.mm) : 1.5;
    direction = thkObj ? (thkObj.direction || 'qas') : 'qas';
  }

  if (!isStandardVeneerDimension(len, wid)) {
    ensureCustomDimensionInCatalog(len, wid, batch);
  }

  const metrics = calculateVeneerMetrics(len, wid, thkMm, sheets);
  const now = new Date().toISOString();
  const dirLabel = direction === 'sada' ? 'اتجاه سدا' : 'اتجاه قص';

  if (piecePrice > 0) {
    state.catalog.cellPrices = state.catalog.cellPrices || {};
    state.catalog.cellPrices[getCellPriceKey(thkId, gradeId)] = piecePrice;
  }

  const newPallet = {
    id: uid('plt'),
    palletCode: code,
    woodTypeId: woodId,
    woodTypeName: woodObj ? woodObj.name : 'قشرة خشبية',
    lengthCm: len,
    widthCm: wid,
    thicknessId: thkId,
    thicknessMm: thkMm,
    direction,
    directionLabel: dirLabel,
    gradeId,
    gradeCode: gradeObj ? gradeObj.code : 'A',
    gradeName: gradeObj ? gradeObj.name : 'عام',
    sheetsCount: sheets,
    areaM2: metrics.totalAreaM2,
    volumeM3: metrics.totalVolumeM3,
    unitSheetPrice: piecePrice,
    unitPricePerM3: metrics.totalVolumeM3 > 0 ? +((sheets * piecePrice) / metrics.totalVolumeM3).toFixed(2) : 0,
    totalValue: +(sheets * piecePrice).toFixed(2),
    batchNumber: batch,
    status: 'in_stock',
    location: loc,
    entryDate: opDate,
    createdBy: currentUser.name,
    createdAt: opDate,
    updatedAt: now
  };

  state.pallets.unshift(newPallet);
  state.warehouseMovements.unshift({
    id: uid('mov'),
    voucherNumber: `RCV-${Date.now().toString().slice(-5)}`,
    date: opDate,
    warehouseType: 'finished_veneers',
    warehouseLabel: 'مخزن المنتج التام (القشرة)',
    direction: 'in',
    directionLabel: 'إذن دخول منتج تام',
    cellKey: getCellPriceKey(thkId, gradeId),
    lengthCm: len,
    widthCm: wid,
    sheetsCount: sheets,
    unitSheetPrice: piecePrice,
    totalSaleAmount: +(sheets * piecePrice).toFixed(2),
    itemSummary: `بالتة ${newPallet.woodTypeName} مقاس (${formatVeneerDimensions(len, wid, true)}) - تخانة ${thkMm} مم (${dirLabel}) - ${newPallet.gradeName}`,
    referenceCode: code,
    quantitySummary: `1 بالتة | ${sheets} قطعة (${formatVeneerDimensions(len, wid, false)}) | ${metrics.totalVolumeM3} م³`,
    performedBy: currentUser.name,
    approvedBy: currentUser.name,
    updatedAt: now
  });

  closeModal();
  saveState(`إضافة بالتة قشرة جديدة كود ${code} مقاس (${formatVeneerDimensions(len, wid, true)}) وتخانة ${thkMm} مم (${dirLabel}) بتاريخ ${opDate} (${sheets} قطعة)`);
}

// ============================================================================
// 2. MULTI-ITEM CLIENT ORDER PREPARATION & 4-STAGE APPROVAL WORKFLOW
// ============================================================================
let draftOrderItems = [];
let draftOrderDiscountType = 'amount'; // 'amount' | 'percent'
let draftOrderDiscountValue = 0;

function getAvailableSheetsInCell(thkId, thkMm, direction, gradeId, lengthCm = 0, widthCm = 0) {
  const thkObj = state.catalog.thicknesses.find(t => t.id === thkId) || { id: thkId, mm: Number(thkMm || 1.5), direction: direction || 'qas' };
  return (state.pallets || [])
    .filter(p => {
      if (p.status !== 'in_stock' || !matchPalletToThicknessRow(p, thkObj)) return false;
      if (gradeId && p.gradeId !== gradeId) return false;
      if (lengthCm > 0 && widthCm > 0 && !isStandardVeneerDimension(lengthCm, widthCm)) {
        const pLen = Number(p.lengthCm || 250);
        const pWid = Number(p.widthCm || 125);
        return (pLen === Number(lengthCm) && pWid === Number(widthCm)) || (pLen === Number(widthCm) && pWid === Number(lengthCm));
      }
      return true;
    })
    .reduce((s, p) => s + Number(p.sheetsCount || 0), 0);
}

function createDefaultDraftOrderItem() {
  const firstWood = state.catalog.woodTypes?.[0] || { id: 'wt-general', name: 'قشرة خشبية (250×125)' };
  const sortedThk = getSortedThicknesses();
  const grades = state.catalog.grades || [];

  let chosenThk = sortedThk[0] || { id: 'th-1.5-qas', mm: 1.5, direction: 'qas', directionLabel: 'اتجاه قص' };
  let chosenGrade = grades[0] || { id: 'gr-general', code: 'A', name: 'جودة A' };

  // Prefer selecting a (thickness, grade) cell that has a price in the price table (and isn't already used in draftOrderItems if possible)
  const usedKeys = new Set((draftOrderItems || []).map(i => getCellPriceKey(i.thicknessId, i.gradeId)));
  let foundUnusedPriced = false;
  for (const t of sortedThk) {
    for (const g of grades) {
      const p = getCellUnitPrice(t.id, g.id, t.mm, t.direction);
      const avail = getAvailableSheetsInCell(t.id, t.mm, t.direction, g.id);
      if ((p > 0 || avail > 0) && !usedKeys.has(getCellPriceKey(t.id, g.id))) {
        chosenThk = t;
        chosenGrade = g;
        foundUnusedPriced = true;
        break;
      }
    }
    if (foundUnusedPriced) break;
  }

  if (!foundUnusedPriced) {
    for (const t of sortedThk) {
      for (const g of grades) {
        if (getCellUnitPrice(t.id, g.id, t.mm, t.direction) > 0) {
          chosenThk = t;
          chosenGrade = g;
          foundUnusedPriced = true;
          break;
        }
      }
      if (foundUnusedPriced) break;
    }
  }

  const autoTablePrice = getCellUnitPrice(chosenThk.id, chosenGrade.id, chosenThk.mm, chosenThk.direction);

  return {
    id: uid('itm'),
    woodTypeId: firstWood.id,
    woodTypeName: firstWood.name,
    lengthCm: 250,
    widthCm: 125,
    customThkMode: false,
    thicknessId: chosenThk.id,
    thicknessMm: Number(chosenThk.mm || 1.5),
    direction: chosenThk.direction || 'qas',
    directionLabel: chosenThk.direction === 'sada' ? 'اتجاه سدا' : 'اتجاه قص',
    gradeId: chosenGrade.id,
    gradeCode: chosenGrade.code || 'A',
    gradeName: chosenGrade.name || 'جودة A',
    sheetsCount: 200,
    unitPrice: autoTablePrice
  };
}

function openNewProductionOrderModal() {
  openNewClientOrderPrepModal();
}

function openNewDispatchRequestModal() {
  openNewClientOrderPrepModal();
}

function openNewClientOrderPrepModal(preselectedClientId = '') {
  const modalRoot = document.getElementById('modal-root');
  const nextNo = `ORD-2026-${101 + (state.productionOrders?.length || 0)}`;
  const clients = (state.partners || []).filter(pt => pt.type !== 'supplier');

  draftOrderItems = [createDefaultDraftOrderItem()];
  draftOrderDiscountType = 'amount';
  draftOrderDiscountValue = 0;

  modalRoot.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal-box" style="max-width:980px;">
        <div class="card-header">
          <div>
            <div class="card-title">📋 أمر تجهيز طلبية للعميل + إصدار بيان للعميل (المقاس المعتمد 125×250 سم أو مقاسات وتخانات خاصة للشركات)</div>
            <small style="color:var(--text-muted);">
              المقاس المعتمد افتراضياً هو <strong>125 سم × 250 سم</strong>، ويمكنك لأي بند اختيار أو كتابة <strong>مقاس مختلف للشركات (العرض × الطول سم)</strong> أو كتابة <strong>تخانة محددة (مم)</strong> مع السعر التلقائي من الجدول
            </small>
          </div>
          <button class="btn btn-sm btn-outline" onclick="closeModal()">✕</button>
        </div>

        <form onsubmit="submitNewClientOrderPrep(event)">
          <div class="form-grid" style="margin-bottom:14px;">
            <div class="form-group">
              <label>تاريخ الطلبية والبيان (حالي أو سابق)</label>
              <input id="ord-date" type="date" class="form-control" value="${todayStr()}" required />
            </div>
            <div class="form-group">
              <label>رقم أمر تجهيز الطلبية</label>
              <input id="ord-num" class="form-control" value="${nextNo}" required />
            </div>
            <div class="form-group" style="grid-column: span 2;">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;flex-wrap:wrap;gap:6px;">
                <label style="margin:0;">العميل المطلوب تجهيز الطلبية لصالحه (بالكود والاسم)</label>
                <button type="button" class="btn btn-sm btn-outline" style="padding:2px 8px;font-size:0.73rem;" onclick="openNewPartnerModal(true)">
                  ➕ إضافة عميل جديد بالكود
                </button>
              </div>
              <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:5px;align-items:center;">
                <input id="ord-client-code-search" type="text" class="form-control" style="max-width:240px;" placeholder="🔍 ابحث بكود العميل كامل (مثل CL-101)..." oninput="handleOrderModalClientSearch(this.value)" />
                <div id="ord-client-search-status"></div>
              </div>
              <select id="ord-client" class="form-control" required style="font-weight:800;border-color:var(--primary);">
                ${clients.length === 0 ? `<option value="cl-new-inline">عميل جديد (سيتم تسجيله تلقائياً بكود CL-101)</option>` : ''}
                ${clients.map(c => `<option value="${c.id}" ${c.id === preselectedClientId ? 'selected' : ''}>[${c.code || 'CL'}] ${c.name} ${c.phone ? '— ' + c.phone : ''}</option>`).join('')}
              </select>
              ${clients.length === 0 ? `
                <input id="ord-new-client-name" class="form-control" style="margin-top:6px;" placeholder="اكتب اسم العميل الجديد هنا..." required />
              ` : ''}
            </div>
          </div>

          <!-- Multi-Item Builder Section -->
          <div style="background:var(--bg-elevated);padding:14px;border-radius:12px;border:1px solid var(--border-color);margin-bottom:14px;">
            <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:10px;">
              <div>
                <strong style="color:var(--primary);font-size:0.92rem;">🪵 بنود الطلبية (المقاس المعتمد 125×250 سم أو مقاس خاص للشركات + تخانات محددة [قص/سدا] وجودات):</strong>
              </div>
              <button type="button" class="btn btn-sm btn-primary" onclick="addDraftOrderItemRow()">
                ➕ إضافة بند (تخانة / مقاس / جودة أخرى) للطلبية
              </button>
            </div>

            <div id="draft-order-items-container" class="table-responsive"></div>
          </div>

          <!-- Discount & Statement Pricing Controls -->
          <div class="form-grid" style="background:rgba(217,119,6,0.06);padding:14px;border-radius:12px;border:1px solid rgba(217,119,6,0.25);margin-bottom:14px;">
            <div class="form-group">
              <label>نوع الخصم للعميل في البيان</label>
              <select id="ord-discount-type" class="form-control" onchange="draftOrderDiscountType=this.value; recalcDraftOrderTotals();">
                <option value="amount">💵 خصم مبلغ نقدي مباشر (بالجنيه)</option>
                <option value="percent">📉 خصم نسبة مئوية (%)</option>
              </select>
            </div>
            <div class="form-group">
              <label>قيمة الخصم (مبلغ أو نسبة %)</label>
              <input id="ord-discount-val" type="number" step="0.5" min="0" class="form-control" value="0" oninput="draftOrderDiscountValue=Number(this.value||0); recalcDraftOrderTotals();" />
            </div>
            <div class="form-group" style="grid-column: span 2;">
              <label>ملاحظات البيان والتجهيز لأمين المخزن</label>
              <input id="ord-notes" class="form-control" placeholder="مثال: تجهيز بالمقاس والتخانة المحددة على بالتات سليمة ومراجعة الفرز..." />
            </div>
          </div>

          <div id="ord-totals-preview" class="calc-preview-box"></div>

          <div style="background:rgba(37,99,235,0.08);border:1px solid rgba(37,99,235,0.25);padding:10px 14px;border-radius:10px;margin-top:12px;font-size:0.84rem;">
            🔒 <strong>مسار الاعتماد التلقائي:</strong> فور حفظ الطلبية والبيان، سيتم إرساله إلى <strong>المدير التنفيذي أو مدير المشروعات</strong> للموافقة عليه أولاً، ولن يظهر للمدير الإداري وأمين المخزن إلا بعد موافقة المدير التنفيذي أو مدير المشروعات.
          </div>

          <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px;">
            <button type="button" class="btn btn-outline" onclick="closeModal()">إلغاء</button>
            <button type="submit" class="btn btn-primary">📋 حفظ أمر تجهيز الطلبية وإصدار بيان العميل للاعتماد</button>
          </div>
        </form>
      </div>
    </div>
  `;

  renderDraftOrderItemsTable();
}

function addDraftOrderItemRow() {
  draftOrderItems.push(createDefaultDraftOrderItem());
  renderDraftOrderItemsTable();
}

function removeDraftOrderItemRow(idx) {
  if (draftOrderItems.length <= 1) {
    alert('يجب أن تحتوي الطلبية على بند واحد على الأقل!');
    return;
  }
  draftOrderItems.splice(idx, 1);
  renderDraftOrderItemsTable();
}

function onDraftItemThicknessSelect(idx, thkId) {
  const item = draftOrderItems[idx];
  if (!item) return;
  if (thkId === '__custom__') {
    item.customThkMode = true;
    renderDraftOrderItemsTable();
    return;
  }
  item.customThkMode = false;
  const thkObj = (state.catalog.thicknesses || []).find(t => t.id === thkId);
  if (thkObj) {
    item.thicknessId = thkObj.id;
    item.thicknessMm = Number(thkObj.mm);
    item.direction = thkObj.direction || 'qas';
    item.directionLabel = thkObj.direction === 'sada' ? 'اتجاه سدا' : 'اتجاه قص';
    // Automatically set unitPrice from the price table (جدول الأسعار) while keeping it editable
    item.unitPrice = getCellUnitPrice(item.thicknessId, item.gradeId, item.thicknessMm, item.direction);
  }
  renderDraftOrderItemsTable();
}

function toggleDraftItemCustomThk(idx) {
  const item = draftOrderItems[idx];
  if (!item) return;
  item.customThkMode = !item.customThkMode;
  renderDraftOrderItemsTable();
}

function onDraftItemDimensionPresetSelect(idx, presetVal) {
  const item = draftOrderItems[idx];
  if (!item) return;
  if (presetVal === 'custom') {
    item.customDimMode = true;
    renderDraftOrderItemsTable();
    return;
  }
  const [l, w] = String(presetVal).split('x').map(Number);
  if (l > 0 && w > 0) {
    item.lengthCm = l;
    item.widthCm = w;
    item.customDimMode = !isStandardVeneerDimension(l, w);
  }
  renderDraftOrderItemsTable();
}

function onDraftItemGradeSelect(idx, gradeId) {
  const item = draftOrderItems[idx];
  if (!item) return;
  const gradeObj = (state.catalog.grades || []).find(g => g.id === gradeId);
  if (gradeObj) {
    item.gradeId = gradeObj.id;
    item.gradeCode = gradeObj.code;
    item.gradeName = gradeObj.name;
    // Automatically set unitPrice from the price table (جدول الأسعار) while keeping it editable
    item.unitPrice = getCellUnitPrice(item.thicknessId, item.gradeId, item.thicknessMm, item.direction);
  }
  renderDraftOrderItemsTable();
}

function resetDraftItemToTablePrice(idx) {
  const item = draftOrderItems[idx];
  if (!item) return;
  item.unitPrice = getCellUnitPrice(item.thicknessId, item.gradeId, item.thicknessMm, item.direction);
  renderDraftOrderItemsTable();
}

function updateDraftItemNumeric(idx, field, val) {
  const item = draftOrderItems[idx];
  if (!item) return;
  if (field === 'thicknessMm') {
    const mmNum = Math.max(0.1, Number(val || 1.5));
    item.thicknessMm = mmNum;
    item.thicknessId = `th-${mmNum}-${item.direction || 'qas'}`;
    const tblP = getCellUnitPrice(item.thicknessId, item.gradeId, item.thicknessMm, item.direction);
    if (tblP > 0) item.unitPrice = tblP;
    recalcDraftOrderTotals();
    return;
  } else if (field === 'direction') {
    item.direction = val;
    item.directionLabel = val === 'sada' ? 'اتجاه سدا' : 'اتجاه قص';
    item.thicknessId = `th-${item.thicknessMm}-${val}`;
    const tblP = getCellUnitPrice(item.thicknessId, item.gradeId, item.thicknessMm, item.direction);
    if (tblP > 0) item.unitPrice = tblP;
    renderDraftOrderItemsTable();
    return;
  } else if (field === 'widthCm') {
    item.widthCm = Math.max(10, Number(val || 125));
    recalcDraftOrderTotals();
    return;
  } else if (field === 'lengthCm') {
    item.lengthCm = Math.max(10, Number(val || 250));
    recalcDraftOrderTotals();
    return;
  } else if (field === 'gradeName') {
    item.gradeName = val;
  } else if (field === 'sheetsCount') {
    item.sheetsCount = Math.max(1, Number(val || 0));
  } else if (field === 'unitPrice') {
    item.unitPrice = Math.max(0, Number(val || 0));
  }
  recalcDraftOrderTotals();
}

function renderDraftOrderItemsTable() {
  const container = document.getElementById('draft-order-items-container');
  if (!container) return;

  const sortedThk = getSortedThicknesses();
  const hasCatalogThk = sortedThk.length > 0;
  const hasCatalogGrades = (state.catalog.grades || []).length > 0;
  const presetDims = getPresetVeneerDimensions();

  container.innerHTML = `
    <table>
      <thead>
        <tr>
          <th style="width:24px;">#</th>
          <th>التخانة والاتجاه (أو تخانة محددة)</th>
          <th>📐 المقاس (العرض × الطول سم)</th>
          <th>درجة الجودة</th>
          <th>المتاح</th>
          <th>الكمية (قطعة)</th>
          <th>💰 سعر القطعة (ج.م)</th>
          <th>إجمالي البند</th>
          <th style="width:32px;">حذف</th>
        </tr>
      </thead>
      <tbody>
        ${draftOrderItems.map((it, idx) => {
          const len = Number(it.lengthCm || 250);
          const wid = Number(it.widthCm || 125);
          const avail = getAvailableSheetsInCell(it.thicknessId, it.thicknessMm, it.direction, it.gradeId, len, wid);
          const tablePrice = getCellUnitPrice(it.thicknessId, it.gradeId, it.thicknessMm, it.direction);
          const itemTotal = +(Number(it.sheetsCount || 0) * Number(it.unitPrice || 0)).toFixed(2);
          const dimKey = `${len}x${wid}`;
          const matchedPreset = presetDims.some(d => `${d.lengthCm}x${d.widthCm}` === dimKey);
          return `
            <tr>
              <td><strong>${idx + 1}</strong></td>
              <td>
                ${hasCatalogThk && !it.customThkMode ? `
                  <div style="display:flex;flex-direction:column;gap:3px;">
                    <select class="form-control" onchange="onDraftItemThicknessSelect(${idx}, this.value)" style="font-weight:700;padding:3px 6px;font-size:0.75rem;">
                      ${sortedThk.map(t => {
                        const pForGrade = getCellUnitPrice(t.id, it.gradeId, t.mm, t.direction);
                        return `
                          <option value="${t.id}" ${t.id === it.thicknessId ? 'selected' : ''}>
                            ${t.mm} مم (${t.direction === 'sada' ? 'سدا' : 'قص'})${pForGrade > 0 ? ' — ' + pForGrade + ' ج' : ''}
                          </option>
                        `;
                      }).join('')}
                      <option value="__custom__">➕ كتابة تخانة محددة أخرى (مم)...</option>
                    </select>
                  </div>
                ` : `
                  <div style="display:flex;flex-direction:column;gap:3px;">
                    <div style="display:flex;gap:3px;align-items:center;">
                      <input type="number" step="0.05" min="0.1" class="form-control" style="width:64px;padding:3px 5px;font-weight:800;border-color:#7c3aed;" value="${it.thicknessMm}" oninput="updateDraftItemNumeric(${idx}, 'thicknessMm', this.value)" placeholder="مم" title="التخانة المحددة بالمليمتر" />
                      <select class="form-control" style="padding:3px 5px;font-size:0.74rem;font-weight:700;" onchange="updateDraftItemNumeric(${idx}, 'direction', this.value)">
                        <option value="qas" ${it.direction === 'qas' ? 'selected' : ''}>قص</option>
                        <option value="sada" ${it.direction === 'sada' ? 'selected' : ''}>سدا</option>
                      </select>
                      ${hasCatalogThk ? `<button type="button" class="btn btn-sm btn-outline" style="padding:1px 5px;font-size:0.65rem;" onclick="toggleDraftItemCustomThk(${idx})" title="العودة لقائمة التخانات">📋</button>` : ''}
                    </div>
                    <small style="font-size:0.64rem;color:#7c3aed;font-weight:700;">تخانة محددة (تضاف للجدول تلقائياً)</small>
                  </div>
                `}
              </td>
              <td>
                <div style="display:flex;flex-direction:column;gap:3px;min-width:145px;">
                  <select class="form-control" style="padding:3px 5px;font-size:0.73rem;font-weight:700;border-color:${isStandardVeneerDimension(len, wid) ? 'var(--border-color)' : '#7c3aed'};" onchange="onDraftItemDimensionPresetSelect(${idx}, this.value)">
                    ${presetDims.map(d => `<option value="${d.lengthCm}x${d.widthCm}" ${!it.customDimMode && `${d.lengthCm}x${d.widthCm}` === dimKey ? 'selected' : ''}>${d.widthCm}×${d.lengthCm} سم ${d.isStandard ? '(معتمد)' : '(خاص)'}</option>`).join('')}
                    <option value="custom" ${it.customDimMode || !matchedPreset ? 'selected' : ''}>📐 مقاس خاص للشركة (عرض×طول)...</option>
                  </select>
                  <div style="display:flex;align-items:center;gap:3px;">
                    <input type="number" step="0.5" min="10" class="form-control" style="width:58px;padding:2px 4px;font-size:0.73rem;font-weight:800;text-align:center;" value="${wid}" oninput="updateDraftItemNumeric(${idx}, 'widthCm', this.value)" title="العرض بالسم" placeholder="العرض" />
                    <span style="font-size:0.72rem;font-weight:800;">×</span>
                    <input type="number" step="0.5" min="10" class="form-control" style="width:58px;padding:2px 4px;font-size:0.73rem;font-weight:800;text-align:center;" value="${len}" oninput="updateDraftItemNumeric(${idx}, 'lengthCm', this.value)" title="الطول بالسم" placeholder="الطول" />
                    <small style="font-size:0.65rem;color:var(--text-muted);">سم</small>
                  </div>
                </div>
              </td>
              <td>
                ${hasCatalogGrades ? `
                  <select class="form-control" onchange="onDraftItemGradeSelect(${idx}, this.value)" style="font-weight:700;padding:4px 6px;font-size:0.76rem;">
                    ${state.catalog.grades.map(g => {
                      const pForCell = getCellUnitPrice(it.thicknessId, g.id, it.thicknessMm, it.direction);
                      return `
                        <option value="${g.id}" ${g.id === it.gradeId ? 'selected' : ''}>
                          ${g.code}${pForCell > 0 ? ' (' + pForCell + ' ج)' : ''}
                        </option>
                      `;
                    }).join('')}
                  </select>
                ` : `
                  <input class="form-control" value="${it.gradeName}" oninput="updateDraftItemNumeric(${idx}, 'gradeName', this.value)" placeholder="الجودة" />
                `}
              </td>
              <td>
                <span class="badge ${avail >= it.sheetsCount ? 'badge-success' : 'badge-warning'}">
                  ${fmtNum(avail, 0)} ق
                </span>
              </td>
              <td>
                <input type="number" min="1" class="form-control" style="width:76px;padding:4px 6px;font-weight:800;" value="${it.sheetsCount}" oninput="updateDraftItemNumeric(${idx}, 'sheetsCount', this.value)" required />
              </td>
              <td>
                <div style="display:flex;flex-direction:column;gap:2px;">
                  <input type="number" step="0.5" min="0" class="form-control" style="width:86px;padding:4px 6px;font-weight:800;border-color:var(--accent);" value="${it.unitPrice}" oninput="updateDraftItemNumeric(${idx}, 'unitPrice', this.value)" required />
                  <small style="font-size:0.66rem;color:var(--text-muted);">
                    الجدول: <strong style="color:var(--primary);">${fmtNum(tablePrice, 2)} ج</strong>
                    ${Number(it.unitPrice) !== Number(tablePrice) && tablePrice > 0 ? `
                      <button type="button" class="btn btn-sm btn-outline" style="padding:0px 4px;font-size:0.62rem;" onclick="resetDraftItemToTablePrice(${idx})">🔄</button>
                    ` : ''}
                  </small>
                </div>
              </td>
              <td>
                <strong id="draft-item-total-${idx}" style="color:var(--primary);font-size:0.78rem;">${fmtMoney(itemTotal)}</strong>
                <div id="draft-item-vol-${idx}" style="font-size:0.66rem;color:var(--text-muted);"></div>
              </td>
              <td>
                <button type="button" class="btn btn-sm btn-danger" style="padding:2px 6px;" onclick="removeDraftOrderItemRow(${idx})">✕</button>
              </td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;

  recalcDraftOrderTotals();
}

function recalcDraftOrderTotals() {
  let subtotal = 0;
  let totalSheets = 0;
  let totalAreaM2 = 0;
  let totalVolumeM3 = 0;

  draftOrderItems.forEach((it, idx) => {
    const len = Number(it.lengthCm || 250);
    const wid = Number(it.widthCm || 125);
    const m = calculateVeneerMetrics(len, wid, it.thicknessMm, it.sheetsCount);
    const rowAmt = +(Number(it.sheetsCount || 0) * Number(it.unitPrice || 0)).toFixed(2);
    it.lengthCm = len;
    it.widthCm = wid;
    it.areaM2 = m.totalAreaM2;
    it.volumeM3 = m.totalVolumeM3;
    it.totalItemAmount = rowAmt;

    subtotal += rowAmt;
    totalSheets += Number(it.sheetsCount || 0);
    totalAreaM2 += m.totalAreaM2;
    totalVolumeM3 += m.totalVolumeM3;

    const rowTotalEl = document.getElementById(`draft-item-total-${idx}`);
    if (rowTotalEl) rowTotalEl.textContent = fmtMoney(rowAmt);
    const rowVolEl = document.getElementById(`draft-item-vol-${idx}`);
    if (rowVolEl) rowVolEl.textContent = `${fmtNum(m.totalVolumeM3, 3)} م³ (${wid}×${len} سم)`;
  });

  subtotal = +subtotal.toFixed(2);
  let discountAmount = 0;
  if (draftOrderDiscountType === 'percent') {
    discountAmount = +((subtotal * Math.min(100, Math.max(0, draftOrderDiscountValue))) / 100).toFixed(2);
  } else {
    discountAmount = Math.min(subtotal, Math.max(0, +Number(draftOrderDiscountValue || 0).toFixed(2)));
  }
  const netTotal = Math.max(0, +(subtotal - discountAmount).toFixed(2));

  const previewEl = document.getElementById('ord-totals-preview');
  if (previewEl) {
    previewEl.innerHTML = `
      <div class="calc-preview-item">
        <span>إجمالي عدد الأصناف / البنود</span>
        <strong>${draftOrderItems.length} بنود (${fmtNum(totalSheets, 0)} قطعة)</strong>
      </div>
      <div class="calc-preview-item">
        <span>إجمالي المساحة والحجم (حسب مقاس وتخانة كل بند)</span>
        <strong>${fmtNum(totalAreaM2, 2)} م² | ${fmtNum(totalVolumeM3, 4)} م³</strong>
      </div>
      <div class="calc-preview-item">
        <span>الإجمالي قبل الخصم</span>
        <strong>${fmtMoney(subtotal)}</strong>
      </div>
      <div class="calc-preview-item">
        <span>قيمة الخصم للعميل</span>
        <strong style="color:var(--danger);">-${fmtMoney(discountAmount)}</strong>
      </div>
      <div class="calc-preview-item">
        <span>صافي بيان الطلبية للعميل</span>
        <strong style="color:var(--success);font-size:1.15rem;">${fmtMoney(netTotal)}</strong>
      </div>
    `;
  }
}

function submitNewClientOrderPrep(e) {
  e.preventDefault();
  const opDate = document.getElementById('ord-date')?.value || todayStr();
  const orderNumber = (document.getElementById('ord-num')?.value || '').trim();
  const clientSelectVal = document.getElementById('ord-client')?.value || '';
  const notes = (document.getElementById('ord-notes')?.value || '').trim();
  const now = new Date().toISOString();

  let clientObj = state.partners.find(c => c.id === clientSelectVal);
  if (!clientObj) {
    const newClientName = (document.getElementById('ord-new-client-name')?.value || 'عميل مصنع العاصمة').trim();
    const nextCode = `CL-${101 + (state.partners?.length || 0)}`;
    clientObj = {
      id: uid('pt'),
      code: nextCode,
      type: 'client',
      name: newClientName,
      contactPerson: 'إدارة المشتريات',
      phone: '',
      city: '',
      openingDebit: 0,
      openingCredit: 0,
      openingPalletsDelivered: 0,
      openingPalletsReceived: 0,
      balance: 0,
      creditLimit: 500000,
      notes: 'تمت الإضافة تلقائياً مع الطلبية',
      updatedAt: now
    };
    state.partners.push(clientObj);
  }

  // Ensure any custom thickness or custom company dimension entered in the order is saved to catalog
  draftOrderItems.forEach(it => {
    const tObj = ensureCatalogThicknessExists(it.thicknessMm, it.direction || 'qas', it.unitPrice, it.gradeId);
    if (tObj) {
      it.thicknessId = tObj.id;
      it.thicknessMm = Number(tObj.mm);
      it.direction = tObj.direction || 'qas';
      it.directionLabel = tObj.directionLabel;
    }
    it.lengthCm = Number(it.lengthCm || 250);
    it.widthCm = Number(it.widthCm || 125);
    if (!isStandardVeneerDimension(it.lengthCm, it.widthCm)) {
      ensureCustomDimensionInCatalog(it.lengthCm, it.widthCm, clientObj.name);
    }
  });

  recalcDraftOrderTotals();
  const subtotalAmount = +draftOrderItems.reduce((s, i) => s + Number(i.totalItemAmount || 0), 0).toFixed(2);
  const discountAmount = draftOrderDiscountType === 'percent'
    ? +((subtotalAmount * Math.min(100, Math.max(0, draftOrderDiscountValue))) / 100).toFixed(2)
    : Math.min(subtotalAmount, Math.max(0, +Number(draftOrderDiscountValue || 0).toFixed(2)));
  const netTotalAmount = Math.max(0, +(subtotalAmount - discountAmount).toFixed(2));
  const totalSheetsCount = draftOrderItems.reduce((s, i) => s + Number(i.sheetsCount || 0), 0);
  const totalAreaM2 = +draftOrderItems.reduce((s, i) => s + Number(i.areaM2 || 0), 0).toFixed(4);
  const totalVolumeM3 = +draftOrderItems.reduce((s, i) => s + Number(i.volumeM3 || 0), 0).toFixed(4);

  const createdByExec = isFullAdmin(currentUser);
  const initialStage = createdByExec ? 'pending_warehouse_prep' : 'pending_executive';

  const newOrder = {
    id: uid('ord'),
    orderNumber,
    date: opDate,
    clientId: clientObj.id,
    clientCode: clientObj.code || 'CL-101',
    clientName: clientObj.name,
    clientPhone: clientObj.phone || '',
    requestedBy: currentUser.name,
    requestedByRole: currentUser.roleKey,
    items: JSON.parse(JSON.stringify(draftOrderItems)),
    totalSheetsCount,
    totalAreaM2,
    totalVolumeM3,
    subtotalAmount,
    discountType: draftOrderDiscountType,
    discountValue: draftOrderDiscountValue,
    discountAmount,
    netTotalAmount,
    stage: initialStage,
    status: 'in_progress',
    executiveApprovedBy: createdByExec ? currentUser.name : '',
    executiveApprovedAt: createdByExec ? now : '',
    warehousePrepApprovedBy: '',
    warehousePrepApprovedAt: '',
    accountantReleaseBy: '',
    accountantReleaseAt: '',
    financialSettlement: null,
    carDispatchVoucher: null,
    notes,
    createdAt: opDate,
    updatedAt: now
  };

  state.productionOrders.unshift(newOrder);
  if (currentUser) {
    markNotifIdsSeen([`ord_stage_${newOrder.id}_${initialStage}`]);
  }
  closeModal();
  activeTab = 'production';

  if (createdByExec) {
    // Created directly by CEO or Projects Manager -> immediately visible & alerted to Admin Manager and Warehouse Keeper!
    saveState(
      `📦 أمر تجهيز طلبية جديد (${orderNumber}) للعميل (${clientObj.name} - ${clientObj.code || ''}) معتمد من ${currentUser.name} — جاهز الآن للمدير الإداري وأمين المخزن لتجهيز الطلبية (${totalSheetsCount} قطعة)`
    );
  } else {
    // Created by Accountant -> hidden from admin_manager & warehouse_keeper until CEO or Projects Manager approves it
    saveState(
      `📋 إنشاء أمر تجهيز طلبية وبيان للعميل (${clientObj.name} - ${clientObj.code || ''}) رقم ${orderNumber} بصافي ${fmtMoney(netTotalAmount)} — بانتظار موافقة المدير التنفيذي أو مدير المشروعات`,
      ['admin_manager', 'warehouse_keeper', 'operations_manager']
    );
  }
}

// ============================================================================
// CLIENT ORDER STATEMENT MODAL (بيان للعميل بالطلبية مع تعديل الأسعار وعمل خصم)
// ============================================================================
function openClientOrderStatementModal(orderId) {
  const ord = (state.productionOrders || []).find(o => o.id === orderId);
  if (!ord) return;
  const modalRoot = document.getElementById('modal-root');
  const items = Array.isArray(ord.items) ? ord.items : [];
  const isExec = isFullAdmin(currentUser);
  const isWarehouseOrAdmin = isExec || ['admin_manager', 'warehouse_keeper'].includes(currentUser?.role);
  const canEditQuantities = isExec || canSeeFinancialPrices() || (isWarehouseOrAdmin && ord.stage === 'pending_warehouse_prep');
  const thicknesses = getSortedThicknesses();
  const grades = state.catalog?.grades || [];

  modalRoot.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal-box" style="max-width:960px;">
        <div class="card-header">
          <div>
            <div class="card-title">${canSeeFinancialPrices() ? `📄 بيان للعميل بالطلبية (${ord.orderNumber}) — تعديل البيان والمقاسات والتخانات والأسعار والخصم` : `📄 بيان كميات ومقاسات الطلبية للتجهيز بالمخزن (${ord.orderNumber}) — كميات فقط`}</div>
            <small style="color:var(--text-muted);">
              العميل: <strong>${ord.clientName} (${ord.clientCode || 'CL'})</strong> | التاريخ: <strong>${ord.date}</strong> | الحالة: ${getOrderStageBadge(ord)}
            </small>
          </div>
          <button type="button" class="btn btn-sm btn-outline" onclick="closeModal()">✕</button>
        </div>

        ${ord.stage === 'completed' && isExec ? `
          <div style="background:rgba(2,132,199,0.1);border:2px solid #0284c7;padding:10px 14px;border-radius:10px;margin-bottom:12px;font-size:0.85rem;">
            🔄 <strong>صلاحية المدير التنفيذي / مدير المشروعات (تعديل مع إرجاع أرصدة المخازن تلقائياً):</strong><br/>
            هذه الطلبية تم صرفها بالفعل من المخزن. عند تعديل أي كمية أو مقاس أو تخانة أو جودة وحفظ التعديل، سيقوم النظام <strong>بإرجاع الأرصدة القديمة للمخزن تلقائياً وخصم الأرصدة الجديدة</strong> وتحديث فاتورة العميل وإذن الصرف فوراً!
          </div>
        ` : ''}

        ${ord.stage === 'pending_warehouse_prep' && isWarehouseOrAdmin ? `
          <div style="background:rgba(124,58,237,0.12);border:2px solid #7c3aed;padding:10px 14px;border-radius:10px;margin-bottom:12px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
            <div style="font-size:0.84rem;">
              📦 <strong>أمر تجهيز بالمخزن:</strong> يمكنك مراجعة الكميات والمقاسات أدناه والضغط مباشرة على زر <strong>موافقة التجهيز والخروج</strong> ليتم خصم الكمية من المخزن وتحويلها للمحاسب.
            </div>
            <button type="button" class="btn btn-sm btn-success" style="font-weight:800;" onclick="saveClientOrderStatementChanges(null, '${ord.id}', false, true)">
              ✅ موافقة التجهيز والخروج من المخزن الآن
            </button>
          </div>
        ` : ''}

        ${ord.stage === 'ready_for_car_dispatch' && isWarehouseOrAdmin ? `
          <div style="background:rgba(22,163,74,0.12);border:2px solid #16a34a;padding:10px 14px;border-radius:10px;margin-bottom:12px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
            <div style="font-size:0.84rem;">
              🚚 <strong>جاهز للتحميل وصرف السيارة:</strong> تمت مراجعة الحسابات — اضغط لفتح إذن صرف وتحميل السيارة الآن.
            </div>
            <button type="button" class="btn btn-sm btn-primary" style="font-weight:800;" onclick="closeModal(); openVehicleDispatchVoucherModal('${ord.id}')">
              🚚 فتح إذن صرف وتحميل السيارة الآن
            </button>
          </div>
        ` : ''}

        <form onsubmit="saveClientOrderStatementChanges(event, '${ord.id}')">
          ${isExec ? `
            <div class="form-grid" style="margin-bottom:12px;background:var(--bg-elevated);padding:10px 14px;border-radius:10px;">
              <div class="form-group">
                <label>تاريخ البيان / الطلبية</label>
                <input id="stmt-ord-date" type="date" class="form-control" value="${ord.date || todayStr()}" required />
              </div>
              <div class="form-group">
                <label>رقم الطلبية</label>
                <input id="stmt-ord-num" class="form-control" value="${ord.orderNumber || ''}" required />
              </div>
            </div>
          ` : ''}

          <div class="table-responsive" style="margin-bottom:10px;">
            <table>
              <thead>
                <tr>
                  <th style="width:28px;">#</th>
                  <th>التخانة والاتجاه</th>
                  <th>📐 المقاس (العرض × الطول سم)</th>
                  <th>الجودة</th>
                  <th>الكمية (قطعة)</th>
                  <th>الحجم (م³)</th>
                  ${canSeeFinancialPrices() ? '<th>💰 سعر القطعة</th><th>الإجمالي</th>' : ''}
                </tr>
              </thead>
              <tbody>
                ${items.map((it, idx) => {
                  const curThkId = it.thicknessId || `th-${it.thicknessMm}-${it.direction || 'qas'}`;
                  const len = Number(it.lengthCm || 250);
                  const wid = Number(it.widthCm || 125);
                  return `
                  <tr>
                    <td><strong>${idx + 1}</strong></td>
                    <td>
                      ${isExec || canSeeFinancialPrices() ? `
                        <div style="display:flex;gap:3px;align-items:center;">
                          <input id="stmt-thk-mm-${idx}" type="number" step="0.05" min="0.1" class="form-control" style="width:62px;padding:3px 5px;font-weight:800;" value="${it.thicknessMm}" oninput="recalcStatementModalLive('${ord.id}', ${idx})" title="التخانة بالـ مم" />
                          <select id="stmt-thk-dir-${idx}" class="form-control" style="padding:3px 5px;font-size:0.74rem;font-weight:700;" onchange="recalcStatementModalLive('${ord.id}', ${idx})">
                            <option value="qas" ${it.direction !== 'sada' ? 'selected' : ''}>قص</option>
                            <option value="sada" ${it.direction === 'sada' ? 'selected' : ''}>سدا</option>
                          </select>
                        </div>
                      ` : `
                        <strong>${it.thicknessMm} مم</strong>
                        <span class="badge" style="background:${it.direction === 'sada' ? '#0284c7' : '#d97706'};color:#fff;margin-right:3px;">
                          ${it.direction === 'sada' ? 'سدا' : 'قص'}
                        </span>
                      `}
                    </td>
                    <td>
                      ${isExec || canSeeFinancialPrices() ? `
                        <div style="display:flex;align-items:center;gap:3px;">
                          <input id="stmt-wid-${idx}" type="number" step="0.5" min="10" class="form-control" style="width:58px;padding:3px 4px;font-weight:800;text-align:center;" value="${wid}" oninput="recalcStatementModalLive('${ord.id}')" title="العرض (سم)" />
                          <span>×</span>
                          <input id="stmt-len-${idx}" type="number" step="0.5" min="10" class="form-control" style="width:58px;padding:3px 4px;font-weight:800;text-align:center;" value="${len}" oninput="recalcStatementModalLive('${ord.id}')" title="الطول (سم)" />
                          <small style="font-size:0.66rem;color:var(--text-muted);">سم</small>
                        </div>
                      ` : getVeneerDimensionBadgeHtml(len, wid)}
                    </td>
                    <td>
                      ${isExec ? `
                        <select id="stmt-grd-${idx}" class="form-control" style="min-width:90px;padding:4px 6px;font-size:0.76rem;font-weight:700;" onchange="recalcStatementModalLive('${ord.id}', ${idx})">
                          ${grades.map(g => `<option value="${g.id}" ${g.id === it.gradeId ? 'selected' : ''}>${g.code}</option>`).join('')}
                        </select>
                      ` : `<strong>${it.gradeName}</strong>`}
                    </td>
                    <td>
                      <input id="stmt-sheets-${idx}" type="number" min="0" class="form-control" style="width:82px;padding:4px 6px;font-weight:800;" value="${it.sheetsCount}" oninput="recalcStatementModalLive('${ord.id}')" ${canEditQuantities ? '' : 'readonly'} required />
                    </td>
                    <td id="stmt-vol-${idx}" style="font-size:0.75rem;">${fmtNum(it.volumeM3, 3)} م³</td>
                    ${canSeeFinancialPrices() ? `
                    <td>
                      <div style="display:flex;flex-direction:column;gap:2px;">
                        <input id="stmt-price-${idx}" type="number" step="0.5" min="0" class="form-control" style="width:92px;padding:4px 6px;font-weight:800;border-color:var(--primary);" value="${it.unitPrice}" oninput="recalcStatementModalLive('${ord.id}')" required />
                        <small id="stmt-tbl-price-hint-${idx}" style="font-size:0.68rem;color:var(--text-muted);">
                          الجدول: <strong>${fmtNum(getCellUnitPrice(curThkId, it.gradeId, it.thicknessMm, it.direction), 2)} ج</strong>
                        </small>
                      </div>
                    </td>
                    <td>
                      <strong id="stmt-rowtotal-${idx}" style="color:var(--primary);font-size:0.8rem;">${fmtMoney(it.totalItemAmount)}</strong>
                    </td>
                    ` : `<input id="stmt-price-${idx}" type="hidden" value="${it.unitPrice}" />`}
                  </tr>
                `;}).join('')}
              </tbody>
            </table>
          </div>

          ${canSeeFinancialPrices() ? `
          <div class="form-grid" style="background:var(--bg-elevated);padding:14px;border-radius:12px;margin-bottom:14px;">
            <div class="form-group">
              <label>نوع الخصم في بيان العميل</label>
              <select id="stmt-disc-type" class="form-control" onchange="recalcStatementModalLive('${ord.id}')">
                <option value="amount" ${ord.discountType !== 'percent' ? 'selected' : ''}>💵 خصم مبلغ نقدي (ج.م)</option>
                <option value="percent" ${ord.discountType === 'percent' ? 'selected' : ''}>📉 خصم نسبة مئوية (%)</option>
              </select>
            </div>
            <div class="form-group">
              <label>قيمة الخصم</label>
              <input id="stmt-disc-val" type="number" step="0.5" min="0" class="form-control" value="${ord.discountValue || 0}" oninput="recalcStatementModalLive('${ord.id}')" />
            </div>
            <div class="form-group" style="grid-column: span 2;">
              <label>ملاحظات البيان للعميل</label>
              <input id="stmt-notes" class="form-control" value="${ord.notes || ''}" placeholder="شروط التسليم أو ملاحظات البيان..." />
            </div>
          </div>
          ` : `
          <input id="stmt-disc-type" type="hidden" value="${ord.discountType || 'amount'}" />
          <input id="stmt-disc-val" type="hidden" value="${ord.discountValue || 0}" />
          `}

          <div id="stmt-live-summary" class="calc-preview-box"></div>

          <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-top:16px;">
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              <button type="button" class="btn btn-accent" onclick="printClientOrderStatement('${ord.id}')">
                🖨️ طباعة بيان الطلبية للعميل (رسمي)
              </button>
              ${isExec ? `
                <button type="button" class="btn btn-danger" onclick="deleteOrderWithStockRestore('${ord.id}')">
                  🗑️ حذف البيان بالكامل وإرجاع أرصدة المخازن
                </button>
              ` : ''}
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              <button type="button" class="btn btn-outline" onclick="closeModal()">إغلاق</button>
              ${canEditQuantities ? `
                <button type="submit" class="btn btn-primary">💾 حفظ التعديل وتحديث الأرصدة</button>
              ` : ''}
              ${ord.stage === 'pending_executive' && isFullAdmin(currentUser) ? `
                <button type="button" class="btn btn-success" onclick="saveClientOrderStatementChanges(null, '${ord.id}', true)">
                  ✅ حفظ وموافقة المدير التنفيذي/المشروعات (إرسال للمخزن والمدير الإداري)
                </button>
              ` : ''}
              ${ord.stage === 'pending_warehouse_prep' && isWarehouseOrAdmin ? `
                <button type="button" class="btn btn-success" onclick="saveClientOrderStatementChanges(null, '${ord.id}', false, true)">
                  ✅ موافقة التجهيز والخروج من المخزن الآن (خصم من جدول الكميات وتحويل للمحاسب)
                </button>
              ` : ''}
              ${ord.stage === 'ready_for_car_dispatch' && isWarehouseOrAdmin ? `
                <button type="button" class="btn btn-primary" onclick="closeModal(); openVehicleDispatchVoucherModal('${ord.id}')">
                  🚚 عمل إذن صرف للسيارة الآن
                </button>
              ` : ''}
            </div>
          </div>
        </form>
      </div>
    </div>
  `;

  recalcStatementModalLive(ord.id);
}

function recalcStatementModalLive(orderId, changedRowIdx = null) {
  const ord = (state.productionOrders || []).find(o => o.id === orderId);
  if (!ord) return;
  const items = Array.isArray(ord.items) ? ord.items : [];
  let subtotal = 0;
  let totalSheets = 0;
  let totalVol = 0;

  items.forEach((it, idx) => {
    const thkMmInput = document.getElementById(`stmt-thk-mm-${idx}`);
    const thkDirInput = document.getElementById(`stmt-thk-dir-${idx}`);
    const grdSel = document.getElementById(`stmt-grd-${idx}`);
    const thkMm = thkMmInput ? Math.max(0.1, Number(thkMmInput.value || it.thicknessMm || 1.5)) : Number(it.thicknessMm || 1.5);
    const thkDir = thkDirInput ? (thkDirInput.value || 'qas') : (it.direction || 'qas');
    const curThkId = `th-${thkMm}-${thkDir}`;
    const curGrdId = grdSel ? grdSel.value : it.gradeId;

    const autoPrice = getCellUnitPrice(curThkId, curGrdId, thkMm, thkDir);
    if (changedRowIdx === idx && autoPrice > 0) {
      const prInput = document.getElementById(`stmt-price-${idx}`);
      if (prInput) prInput.value = autoPrice;
    }
    const hintEl = document.getElementById(`stmt-tbl-price-hint-${idx}`);
    if (hintEl) {
      hintEl.innerHTML = `سعر الجدول: <strong>${fmtNum(autoPrice, 2)} ج.م</strong>`;
    }

    const len = Number(document.getElementById(`stmt-len-${idx}`)?.value ?? it.lengthCm ?? 250);
    const wid = Number(document.getElementById(`stmt-wid-${idx}`)?.value ?? it.widthCm ?? 125);
    const sh = Number(document.getElementById(`stmt-sheets-${idx}`)?.value ?? it.sheetsCount ?? 0);
    const pr = Number(document.getElementById(`stmt-price-${idx}`)?.value ?? it.unitPrice ?? 0);
    const m = calculateVeneerMetrics(len, wid, thkMm, sh);
    const rowAmt = +(sh * pr).toFixed(2);
    subtotal += rowAmt;
    totalSheets += sh;
    totalVol += m.totalVolumeM3;

    const volEl = document.getElementById(`stmt-vol-${idx}`);
    if (volEl) volEl.textContent = `${fmtNum(m.totalVolumeM3, 4)} م³`;
    const totEl = document.getElementById(`stmt-rowtotal-${idx}`);
    if (totEl) totEl.textContent = fmtMoney(rowAmt);
  });

  const discType = document.getElementById('stmt-disc-type')?.value || 'amount';
  const discVal = Number(document.getElementById('stmt-disc-val')?.value || 0);
  const discAmt = discType === 'percent'
    ? +((subtotal * Math.min(100, Math.max(0, discVal))) / 100).toFixed(2)
    : Math.min(subtotal, Math.max(0, +discVal.toFixed(2)));
  const net = Math.max(0, +(subtotal - discAmt).toFixed(2));

  const sumBox = document.getElementById('stmt-live-summary');
  if (sumBox) {
    sumBox.innerHTML = `
      <div class="calc-preview-item"><span>إجمالي القطع</span><strong>${fmtNum(totalSheets, 0)} قطعة (${fmtNum(totalVol, 4)} م³)</strong></div>
      ${canSeeFinancialPrices() ? `
        <div class="calc-preview-item"><span>الإجمالي قبل الخصم</span><strong>${fmtMoney(subtotal)}</strong></div>
        <div class="calc-preview-item"><span>قيمة الخصم</span><strong style="color:var(--danger);">-${fmtMoney(discAmt)}</strong></div>
        <div class="calc-preview-item"><span>صافي البيان النهائي للعميل</span><strong style="color:var(--success);font-size:1.15rem;">${fmtMoney(net)}</strong></div>
      ` : ''}
    `;
  }
}

function saveClientOrderStatementChanges(e, orderId, alsoApproveExecutive = false, alsoApproveWarehousePrep = false) {
  if (e) e.preventDefault();
  const ord = (state.productionOrders || []).find(o => o.id === orderId);
  if (!ord) return;

  const isExec = isFullAdmin(currentUser);
  const oldOrderNumber = ord.orderNumber;
  if (isExec) {
    const newDate = document.getElementById('stmt-ord-date')?.value;
    const newOrdNum = (document.getElementById('stmt-ord-num')?.value || '').trim();
    if (newDate) ord.date = newDate;
    if (newOrdNum) ord.orderNumber = newOrdNum;
  }

  // 1) If order stock was ALREADY DEDUCTED from warehouse, RESTORE old items to warehouse first!
  let stockRestoredAndUpdated = false;
  if (ord.stockDeducted || ord.stage === 'completed' || ord.status === 'completed') {
    for (const oldIt of (ord.items || [])) {
      const oldSh = Number(oldIt.sheetsCount || 0);
      if (oldSh > 0) {
        const oldThkId = oldIt.thicknessId || `th-${oldIt.thicknessMm}-${oldIt.direction || 'qas'}`;
        addSheetsToCellPallets(
          oldThkId,
          oldIt.gradeId,
          oldIt.woodTypeId || 'wt-general',
          oldSh,
          `إرجاع رصيد لتعديل بيان الطلبية ${oldOrderNumber}`,
          ord.date || todayStr(),
          Number(oldIt.unitPrice || 0),
          Number(oldIt.lengthCm || 250),
          Number(oldIt.widthCm || 125)
        );
      }
    }
    stockRestoredAndUpdated = true;
  }

  let subtotal = 0;
  let totalSheets = 0;
  let totalArea = 0;
  let totalVol = 0;
  const updatedItems = [];

  (ord.items || []).forEach((it, idx) => {
    const thkMmInput = document.getElementById(`stmt-thk-mm-${idx}`);
    const thkDirInput = document.getElementById(`stmt-thk-dir-${idx}`);
    const grdSel = document.getElementById(`stmt-grd-${idx}`);
    const lenInput = document.getElementById(`stmt-len-${idx}`);
    const widInput = document.getElementById(`stmt-wid-${idx}`);

    const sh = Math.max(0, Number(document.getElementById(`stmt-sheets-${idx}`)?.value ?? it.sheetsCount ?? 0));
    const pr = Math.max(0, Number(document.getElementById(`stmt-price-${idx}`)?.value ?? it.unitPrice ?? 0));

    if (grdSel) {
      const gObj = (state.catalog?.grades || []).find(g => g.id === grdSel.value);
      if (gObj) {
        it.gradeId = gObj.id;
        it.gradeName = gObj.code;
      }
    }

    if (thkMmInput) {
      const newMm = Math.max(0.1, Number(thkMmInput.value || it.thicknessMm || 1.5));
      const newDir = thkDirInput ? (thkDirInput.value || 'qas') : (it.direction || 'qas');
      const tObj = ensureCatalogThicknessExists(newMm, newDir, pr, it.gradeId);
      it.thicknessMm = newMm;
      it.direction = newDir;
      it.directionLabel = newDir === 'sada' ? 'اتجاه سدا' : 'اتجاه قص';
      it.thicknessId = tObj ? tObj.id : `th-${newMm}-${newDir}`;
    }

    const len = lenInput ? Math.max(10, Number(lenInput.value || 250)) : Number(it.lengthCm || 250);
    const wid = widInput ? Math.max(10, Number(widInput.value || 125)) : Number(it.widthCm || 125);
    it.lengthCm = len;
    it.widthCm = wid;
    if (!isStandardVeneerDimension(len, wid)) {
      ensureCustomDimensionInCatalog(len, wid, ord.clientName);
    }

    const m = calculateVeneerMetrics(len, wid, it.thicknessMm, sh);
    it.sheetsCount = sh;
    it.unitPrice = pr;
    it.areaM2 = m.totalAreaM2;
    it.volumeM3 = m.totalVolumeM3;
    it.totalItemAmount = +(sh * pr).toFixed(2);
    if (sh > 0) {
      updatedItems.push(it);
      subtotal += it.totalItemAmount;
      totalSheets += sh;
      totalArea += m.totalAreaM2;
      totalVol += m.totalVolumeM3;
    }
  });

  ord.items = updatedItems;

  const discType = document.getElementById('stmt-disc-type')?.value || 'amount';
  const discVal = Number(document.getElementById('stmt-disc-val')?.value || 0);
  const discAmt = discType === 'percent'
    ? +((subtotal * Math.min(100, Math.max(0, discVal))) / 100).toFixed(2)
    : Math.min(subtotal, Math.max(0, +discVal.toFixed(2)));
  const net = Math.max(0, +(subtotal - discAmt).toFixed(2));

  ord.totalSheetsCount = totalSheets;
  ord.totalAreaM2 = +totalArea.toFixed(4);
  ord.totalVolumeM3 = +totalVol.toFixed(4);
  ord.subtotalAmount = +subtotal.toFixed(2);
  ord.discountType = discType;
  ord.discountValue = discVal;
  ord.discountAmount = discAmt;
  ord.netTotalAmount = net;
  ord.notes = (document.getElementById('stmt-notes')?.value || ord.notes || '').trim();
  const now = new Date().toISOString();
  ord.updatedAt = now;

  // 2) If order was ALREADY COMPLETED, deduct the NEW edited quantities from warehouse cells & sync warehouseMovements!
  if (stockRestoredAndUpdated) {
    const carVoucherNo = ord.carDispatchVoucher?.voucherNo || `CAR-${oldOrderNumber}`;
    // Remove old warehouse movements for this car dispatch and push their IDs to deletedIds
    state.deletedIds = state.deletedIds || [];
    const oldMovs = (state.warehouseMovements || []).filter(m => m.voucherNumber === carVoucherNo || m.voucherNumber === `CAR-${ord.orderNumber}`);
    oldMovs.forEach(m => {
      if (!state.deletedIds.includes(m.id)) state.deletedIds.push(m.id);
    });
    state.warehouseMovements = (state.warehouseMovements || []).filter(m => m.voucherNumber !== carVoucherNo && m.voucherNumber !== `CAR-${ord.orderNumber}`);

    const carPlate = ord.carDispatchVoucher?.carPlateNumber || '-';
    const driverName = ord.carDispatchVoucher?.driverName || '-';
    const dispatchDate = ord.carDispatchVoucher?.dispatchDate || ord.date || todayStr();

    for (const it of ord.items) {
      const thkId = it.thicknessId || `th-${it.thicknessMm}-${it.direction || 'qas'}`;
      deductSheetsFromCellPallets(thkId, it.gradeId, it.woodTypeId || 'wt-general', Number(it.sheetsCount || 0), Number(it.unitPrice || 0), Number(it.lengthCm || 250), Number(it.widthCm || 125));

      state.warehouseMovements.unshift({
        id: uid('mov'),
        voucherNumber: `CAR-${ord.orderNumber}`,
        date: dispatchDate,
        warehouseType: 'finished_veneers',
        warehouseLabel: 'إذن صرف وتحميل سيارة مبيعات (معدل)',
        direction: 'out',
        directionLabel: 'صرف طلبية للسيارة',
        movementCategory: 'sales_exit',
        cellKey: getCellPriceKey(thkId, it.gradeId),
        lengthCm: Number(it.lengthCm || 250),
        widthCm: Number(it.widthCm || 125),
        sheetsCount: Number(it.sheetsCount || 0),
        unitSheetPrice: Number(it.unitPrice || 0),
        totalSaleAmount: Number(it.totalItemAmount || 0),
        itemSummary: `صرف طلبية (${ord.orderNumber}) للعميل ${ord.clientName} — مقاس (${formatVeneerDimensions(it.lengthCm, it.widthCm, true)}) تخانة ${it.thicknessMm} مم (${it.direction === 'sada' ? 'سدا' : 'قص'}) × ${it.gradeName} — سيارة رقم (${carPlate}) سائق (${driverName})`,
        referenceCode: carPlate,
        quantitySummary: `${it.sheetsCount} قطعة (${formatVeneerDimensions(it.lengthCm, it.widthCm, false)}) | ${it.volumeM3} م³`,
        performedBy: currentUser.name,
        approvedBy: currentUser.name,
        updatedAt: now
      });
    }
  }

  // 3) Sync linked financial invoice if order already passed accountant release
  const linkedTx = (state.financialTransactions || []).find(tx => tx.orderId === ord.id || tx.voucherNo === `INV-${oldOrderNumber}` || tx.voucherNo === `INV-${ord.orderNumber}`);
  if (linkedTx) {
    const itemsSummary = (ord.items || []).map(i => `${i.sheetsCount} قطعة (${i.thicknessMm}مم ${i.direction === 'sada' ? 'سدا' : 'قص'} - ${i.gradeName} [${formatVeneerDimensions(i.lengthCm, i.widthCm, false)}])`).join(' + ');
    linkedTx.voucherNo = `INV-${ord.orderNumber}`;
    linkedTx.totalAmount = net;
    linkedTx.remainingAmount = Math.max(0, +(net - Number(linkedTx.paidAmount || 0)).toFixed(2));
    linkedTx.description = `فاتورة الطلبية (${ord.orderNumber}): ${itemsSummary}${ord.discountAmount > 0 ? ' (شامل خصم ' + fmtMoney(ord.discountAmount) + ')' : ''}`;
    linkedTx.updatedAt = now;
    if (ord.financialSettlement) {
      ord.financialSettlement.netTotal = net;
      ord.financialSettlement.remainingDebt = +(net - Number(ord.financialSettlement.paidAmount || 0)).toFixed(2);
    }
  }

  if (alsoApproveExecutive && isFullAdmin(currentUser)) {
    ord.stage = 'pending_warehouse_prep';
    ord.executiveApprovedBy = currentUser.name;
    ord.executiveApprovedAt = ord.updatedAt;
    if (currentUser) markNotifIdsSeen([`ord_stage_${ord.id}_pending_warehouse_prep`]);
    closeModal();
    saveState(`✅ موافقة ${currentUser.name} على بيان الطلبية ${ord.orderNumber} للعميل (${ord.clientName}) بصافي ${fmtMoney(net)} — أصبحت ظاهرة الآن للمدير الإداري وأمين المخزن لتجهيزها`);
    return;
  }

  if (alsoApproveWarehousePrep && (isFullAdmin(currentUser) || ['admin_manager', 'warehouse_keeper'].includes(currentUser?.role))) {
    closeModal();
    approveOrderWarehousePrep(ord.id);
    return;
  }

  closeModal();
  const hiddenRoles = ord.stage === 'pending_executive' ? ['admin_manager', 'warehouse_keeper', 'operations_manager'] : [];
  saveState(
    `📄 تعديل بيان الطلبية ${ord.orderNumber} للعميل (${ord.clientName}) بواسطة ${currentUser.name}${stockRestoredAndUpdated ? ' (مع إرجاع وتحديث أرصدة المخازن تلقائياً)' : ''} — الصافي الجديد: ${fmtMoney(net)}`,
    hiddenRoles
  );
}

// STAGE 1 -> STAGE 2: CEO or Projects Manager approves Statement so Admin Manager & Warehouse Keeper can see it
function approveOrderExecutive(orderId) {
  if (!isFullAdmin(currentUser)) {
    alert('⛔ الموافقة على هذه المرحلة مسموحة فقط للمدير التنفيذي أو مدير المشروعات!');
    return;
  }
  const ord = (state.productionOrders || []).find(o => o.id === orderId);
  if (!ord) return;
  const now = new Date().toISOString();
  ord.stage = 'pending_warehouse_prep';
  ord.executiveApprovedBy = currentUser.name;
  ord.executiveApprovedAt = now;
  ord.updatedAt = now;
  if (currentUser) markNotifIdsSeen([`ord_stage_${ord.id}_pending_warehouse_prep`]);

  saveState(`✅ موافقة ${currentUser.name} على بيان الطلبية (${ord.orderNumber}) للعميل ${ord.clientName} — ظهرت الآن للمدير الإداري وأمين المخزن للتجهيز والموافقة`);
}

// Helper: Immediately deduct order items from the Veneer Quantities Matrix upon warehouse exit/approval (idempotent via ord.stockDeducted)
function ensureOrderStockDeducted(ord, performedBy = '', opDate = '') {
  if (!ord || ord.stockDeducted) return false;
  const now = getMonotonicIso(ord.updatedAt);
  const dispatchDate = opDate || ord.date || todayStr();
  const actor = performedBy || currentUser?.name || 'المخزن';
  const carVoucherNo = ord.carDispatchVoucher?.voucherNo || `CAR-${ord.orderNumber}`;
  const carPlate = ord.carDispatchVoucher?.carPlateNumber || 'خروج من المخزن';
  const driverName = ord.carDispatchVoucher?.driverName || '-';

  for (const it of (ord.items || [])) {
    const sh = Number(it.sheetsCount || 0);
    if (sh <= 0) continue;
    const thkId = it.thicknessId || `th-${it.thicknessMm}-${it.direction || 'qas'}`;
    const len = Number(it.lengthCm || 250);
    const wid = Number(it.widthCm || 125);
    deductSheetsFromCellPallets(thkId, it.gradeId, it.woodTypeId || 'wt-general', sh, Number(it.unitPrice || 0), len, wid);

    state.warehouseMovements = state.warehouseMovements || [];
    state.warehouseMovements.unshift({
      id: uid('mov'),
      voucherNumber: carVoucherNo,
      date: dispatchDate,
      warehouseType: 'finished_veneers',
      warehouseLabel: 'مخزن القشرة التامة (خروج طلبية من المخزن)',
      direction: 'out',
      directionLabel: 'خروج طلبية من المخزن',
      movementCategory: 'sales_exit',
      cellKey: getCellPriceKey(thkId, it.gradeId),
      lengthCm: len,
      widthCm: wid,
      sheetsCount: sh,
      unitSheetPrice: Number(it.unitPrice || 0),
      totalSaleAmount: Number(it.totalItemAmount || 0),
      itemSummary: `خروج وصرف طلبية (${ord.orderNumber}) للعميل ${ord.clientName} — مقاس (${formatVeneerDimensions(len, wid, true)}) تخانة ${it.thicknessMm} مم (${it.direction === 'sada' ? 'سدا' : 'قص'}) × ${it.gradeName}${driverName !== '-' ? ' — سيارة رقم (' + carPlate + ') سائق (' + driverName + ')' : ''}`,
      referenceCode: carPlate,
      quantitySummary: `${sh} قطعة (${formatVeneerDimensions(len, wid, false)}) | ${it.volumeM3} م³`,
      performedBy: actor,
      approvedBy: ord.executiveApprovedBy || actor,
      updatedAt: now
    });
  }

  ord.stockDeducted = true;
  ord.stockDeductedAt = now;
  ord.updatedAt = now;
  return true;
}

// STAGE 2 -> STAGE 3: Admin Manager or Warehouse Keeper approves preparation/exit from warehouse -> Immediately deducts from Quantities Table & transfers to Accountant
function approveOrderWarehousePrep(orderId) {
  const ord = (state.productionOrders || []).find(o => o.id === orderId);
  if (!ord) return;
  const now = getMonotonicIso(ord.updatedAt);
  ord.stage = 'pending_accountant_release';
  ord.warehousePrepApprovedBy = currentUser.name;
  ord.warehousePrepApprovedAt = now;
  ord.updatedAt = now;

  // Immediately exit quantities from the Veneer Quantities Matrix upon warehouse exit approval
  ensureOrderStockDeducted(ord, currentUser.name, ord.date || todayStr());

  if (currentUser) markNotifIdsSeen([`ord_stage_${ord.id}_pending_accountant_release`]);

  saveState(`📦 موافقة (${currentUser.name}) على تجهيز وخروج الطلبية (${ord.orderNumber}) للعميل ${ord.clientName} — تم خصم الكميات من جدول كميات القشرة فوراً وتحويلها إلى المحاسب في (اعتماد أذون الصرف)`);
}

// STAGE 3 -> STAGE 4: Accountant completes Client Accounting & Approves Dispatch Voucher -> Alerts Warehouse Keeper & Admin Manager to dispatch Car
function openAccountantReleaseModal(orderId) {
  const ord = (state.productionOrders || []).find(o => o.id === orderId);
  if (!ord) return;
  const clientObj = state.partners.find(p => p.id === ord.clientId || p.name === ord.clientName);
  const clientMetrics = clientObj ? computeClientMetrics(clientObj) : { netDebt: 0, palletsDelivered: 0, palletsReceived: 0, netPalletsAtClient: 0 };

  const modalRoot = document.getElementById('modal-root');
  modalRoot.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal-box" style="max-width:680px;">
        <div class="card-header">
          <div>
            <div class="card-title">💳 عمل حسابات العميل والموافقة على إذن الصرف (${ord.orderNumber})</div>
            <small style="color:var(--text-muted);">
              العميل: <strong>${ord.clientName} (${ord.clientCode || 'CL'})</strong> | تمت موافقة التجهيز بواسطة: <strong>${ord.warehousePrepApprovedBy || 'المخزن/الإدارة'}</strong>
            </small>
          </div>
          <button class="btn btn-sm btn-outline" onclick="closeModal()">✕</button>
        </div>

        <div style="background:var(--bg-elevated);padding:12px 16px;border-radius:12px;margin-bottom:14px;display:grid;grid-template-columns:repeat(auto-fit, minmax(180px, 1fr));gap:10px;">
          <div>
            <small style="color:var(--text-muted);">مديونية العميل السابقة قبل الطلبية:</small><br/>
            <strong style="color:${clientMetrics.netDebt > 0 ? 'var(--danger)' : 'var(--success)'};">
              ${clientMetrics.netDebt > 0 ? 'عليه: ' + fmtMoney(clientMetrics.netDebt) : clientMetrics.netDebt < 0 ? 'له: ' + fmtMoney(Math.abs(clientMetrics.netDebt)) : 'خالص (0 ج.م)'}
            </strong>
          </div>
          <div>
            <small style="color:var(--text-muted);">صافي قيمة هذه الطلبية (بعد الخصم):</small><br/>
            <strong style="font-size:1.1rem;color:var(--primary);">${fmtMoney(ord.netTotalAmount || 0)}</strong>
          </div>
          <div>
            <small style="color:var(--text-muted);">رصيد البالتات الحالي طرف العميل:</small><br/>
            <strong>🪵 ${clientMetrics.netPalletsAtClient} بالتة</strong>
          </div>
        </div>

        <form onsubmit="submitAccountantRelease(event, '${ord.id}')">
          <div class="form-grid">
            <div class="form-group">
              <label>تاريخ اعتماد إذن الصرف والفاتورة</label>
              <input id="rel-date" type="date" class="form-control" value="${ord.date || todayStr()}" required />
            </div>
            <div class="form-group">
              <label>المبلغ المدفوع / المسدد من العميل الآن (ج.م)</label>
              <input id="rel-paid" type="number" step="0.5" min="0" class="form-control" value="${ord.netTotalAmount || 0}" oninput="updateAccountantReleasePreview(${ord.netTotalAmount || 0}, ${clientMetrics.netDebt || 0})" required style="font-weight:800;border-color:var(--success);" />
            </div>
            <div class="form-group">
              <label>طريقة الدفع / التسوية</label>
              <select id="rel-method" class="form-control">
                <option value="نقدي بالخزينة">💵 نقدي بالخزينة</option>
                <option value="تحويل بنكي">🏦 تحويل بنكي</option>
                <option value="شيك بنكي">📝 شيك بنكي تحت التحصيل</option>
                <option value="آجل على حساب مديونية العميل">📒 آجل على حساب مديونية العميل</option>
              </select>
            </div>
            <div class="form-group">
              <label>ملاحظات الحسابات على إذن الصرف</label>
              <input id="rel-notes" class="form-control" placeholder="مثال: تم مراجعة حساب العميل ويسمح بتحميل السيارة..." />
            </div>
          </div>

          <div id="rel-live-preview" class="calc-preview-box"></div>

          <div style="background:rgba(22,163,74,0.08);border:1px solid rgba(22,163,74,0.3);padding:10px 14px;border-radius:10px;margin-top:12px;font-size:0.84rem;">
            🚚 <strong>تنبيه:</strong> بمجرد الضغط على زر الموافقة أدناه، سيتم إثبات الفاتورة في حسابات العميل ويظهر <strong>أمر فوري لأمين المخزن والمدير الإداري</strong> بصرف الطلبية وعمل إذن صرف للسيارة التي ستقوم بتحميل البضاعة.
          </div>

          <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px;">
            <button type="button" class="btn btn-outline" onclick="closeModal()">إلغاء</button>
            <button type="submit" class="btn btn-success">✅ اعتماد إذن الصرف وإصدار أمر تحميل وصرف السيارة للمخزن والمدير الإداري</button>
          </div>
        </form>
      </div>
    </div>
  `;

  updateAccountantReleasePreview(ord.netTotalAmount || 0, clientMetrics.netDebt || 0);
}

function updateAccountantReleasePreview(orderNet, prevDebt) {
  const paid = Number(document.getElementById('rel-paid')?.value || 0);
  const remainingOnOrder = +(Number(orderNet) - paid).toFixed(2);
  const newClientNetDebt = +(Number(prevDebt) + remainingOnOrder).toFixed(2);
  const box = document.getElementById('rel-live-preview');
  if (box) {
    box.innerHTML = `
      <div class="calc-preview-item"><span>صافي الطلبية</span><strong>${fmtMoney(orderNet)}</strong></div>
      <div class="calc-preview-item"><span>المسدد الآن</span><strong style="color:var(--success);">${fmtMoney(paid)}</strong></div>
      <div class="calc-preview-item"><span>المتبقي من هذه الطلبية</span><strong style="color:${remainingOnOrder > 0 ? 'var(--danger)' : 'var(--success)'};">${fmtMoney(remainingOnOrder)}</strong></div>
      <div class="calc-preview-item"><span>إجمالي مديونية العميل بعد الطلبية</span><strong style="color:${newClientNetDebt > 0 ? 'var(--danger)' : 'var(--success)'};">${newClientNetDebt >= 0 ? 'عليه: ' + fmtMoney(newClientNetDebt) : 'له: ' + fmtMoney(Math.abs(newClientNetDebt))}</strong></div>
    `;
  }
}

function submitAccountantRelease(e, orderId) {
  e.preventDefault();
  const ord = (state.productionOrders || []).find(o => o.id === orderId);
  if (!ord) return;

  const relDate = document.getElementById('rel-date')?.value || todayStr();
  const paidAmount = Math.max(0, Number(document.getElementById('rel-paid')?.value || 0));
  const paymentMethod = document.getElementById('rel-method')?.value || 'نقدي بالخزينة';
  const relNotes = (document.getElementById('rel-notes')?.value || '').trim();
  const netTotal = Number(ord.netTotalAmount || 0);
  const remainingDebt = +(netTotal - paidAmount).toFixed(2);
  const now = new Date().toISOString();

  ord.stage = 'ready_for_car_dispatch';
  ord.accountantReleaseBy = currentUser.name;
  ord.accountantReleaseAt = now;
  ord.financialSettlement = {
    date: relDate,
    netTotal,
    paidAmount,
    remainingDebt,
    paymentMethod,
    notes: relNotes,
    approvedBy: currentUser.name
  };
  ord.updatedAt = now;

  // Ensure stock is deducted from the Veneer Quantities Matrix if not already deducted at warehouse prep stage
  ensureOrderStockDeducted(ord, currentUser.name, relDate);

  // Record the official sales invoice in client's financial transactions
  const itemsSummary = (ord.items || []).map(i => `${i.sheetsCount} قطعة (${i.thicknessMm}مم ${i.direction === 'sada' ? 'سدا' : 'قص'} - ${i.gradeName} [${formatVeneerDimensions(i.lengthCm, i.widthCm, false)}])`).join(' + ');
  state.financialTransactions.unshift({
    id: uid('fin'),
    voucherNo: `INV-${ord.orderNumber}`,
    orderId: ord.id,
    date: relDate,
    type: 'sales_invoice',
    typeLabel: 'فاتورة مبيعات طلبية قشرة',
    partnerId: ord.clientId,
    partnerName: ord.clientName,
    description: `فاتورة الطلبية (${ord.orderNumber}): ${itemsSummary}${ord.discountAmount > 0 ? ' (شامل خصم ' + fmtMoney(ord.discountAmount) + ')' : ''}`,
    totalAmount: netTotal,
    paidAmount,
    remainingAmount: Math.max(0, remainingDebt),
    paymentMethod,
    createdBy: currentUser.name,
    approvedBy: currentUser.name,
    updatedAt: now
  });

  if (paidAmount > 0) {
    if (paymentMethod.includes('بنك')) {
      state.treasuryBalances.bankAccount = Number(state.treasuryBalances.bankAccount || 0) + paidAmount;
    } else if (paymentMethod.includes('شيك')) {
      state.treasuryBalances.checksUnderCollection = Number(state.treasuryBalances.checksUnderCollection || 0) + paidAmount;
    } else {
      state.treasuryBalances.cashVault = Number(state.treasuryBalances.cashVault || 0) + paidAmount;
    }
  }

  closeModal();
  saveState(`💳 اعتماد المحاسب (${currentUser.name}) لإذن صرف الطلبية (${ord.orderNumber}) للعميل ${ord.clientName} بعد عمل حساباته — 🚚 صدر أمر فوري لأمين المخزن والمدير الإداري بصرف الطلبية وعمل إذن صرف للسيارة`);
}

// STAGE 4 -> COMPLETED: Warehouse Keeper / Admin Manager issues Vehicle Dispatch Voucher & Deducts Stock & Records Pallets
function openVehicleDispatchVoucherModal(orderId) {
  const ord = (state.productionOrders || []).find(o => o.id === orderId);
  if (!ord) return;
  const modalRoot = document.getElementById('modal-root');
  const defaultPallets = Math.max(1, Math.ceil(Number(ord.totalSheetsCount || 400) / 400));

  modalRoot.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal-box" style="max-width:720px;">
        <div class="card-header">
          <div>
            <div class="card-title">🚚 صرف الطلبية وعمل إذن صرف للسيارة المحملة بالبضاعة (${ord.orderNumber})</div>
            <small style="color:var(--text-muted);">
              العميل: <strong>${ord.clientName} (${ord.clientCode || 'CL'})</strong> | اعتماد الحسابات: <strong>${ord.accountantReleaseBy || 'المحاسب'}</strong>
            </small>
          </div>
          <button class="btn btn-sm btn-outline" onclick="closeModal()">✕</button>
        </div>

        <div style="background:var(--bg-elevated);padding:12px 14px;border-radius:10px;margin-bottom:14px;">
          <div style="font-weight:800;margin-bottom:6px;color:var(--primary);">📦 البضاعة المطلوب تحميلها على السيارة وخصمها من المخزن:</div>
          ${(ord.items || []).map((it, idx) => `
            <div style="font-size:0.86rem;padding:4px 0;border-bottom:1px dashed var(--border-color);">
              <strong>${idx + 1}.</strong> تخانة <strong>${it.thicknessMm} مم (${it.direction === 'sada' ? 'اتجاه سدا' : 'اتجاه قص'})</strong> × جودة <strong>${it.gradeName}</strong>
              ${getVeneerDimensionBadgeHtml(it.lengthCm, it.widthCm)}
              ⬅ الكمية: <strong>${fmtNum(it.sheetsCount, 0)} قطعة</strong> (${fmtNum(it.volumeM3, 4)} م³)
            </div>
          `).join('')}
        </div>

        <form onsubmit="submitVehicleDispatchVoucher(event, '${ord.id}')">
          <div class="form-grid">
            <div class="form-group">
              <label>تاريخ التحميل وإذن صرف السيارة</label>
              <input id="car-date" type="date" class="form-control" value="${todayStr()}" required />
            </div>
            <div class="form-group">
              <label>🚚 رقم السيارة / اللوحة المعدنية</label>
              <input id="car-plate" class="form-control" placeholder="مثال: ط د أ - 4582" required autofocus style="font-weight:800;border-color:var(--primary);" />
            </div>
            <div class="form-group">
              <label>👤 اسم سائق السيارة المستلم</label>
              <input id="car-driver" class="form-control" placeholder="اسم السائق ثلاثي..." required />
            </div>
            <div class="form-group">
              <label>📞 رقم تليفون السائق</label>
              <input id="car-phone" class="form-control" placeholder="010xxxxxxxx" />
            </div>
            <div class="form-group">
              <label style="color:var(--accent);font-weight:800;">🪵 عدد البالتات الخشبية المسلمة للعميل مع البضاعة</label>
              <input id="car-pallets-out" type="number" min="0" class="form-control" value="${defaultPallets}" required style="font-weight:800;border-color:var(--accent);" />
            </div>
            <div class="form-group">
              <label style="color:var(--success);font-weight:800;">🪵 عدد البالتات الخشبية المستلمة/المرتجعة من العميل مع السيارة (إن وجد)</label>
              <input id="car-pallets-in" type="number" min="0" class="form-control" value="0" required />
            </div>
            <div class="form-group" style="grid-column: 1 / -1;">
              <label>ملاحظات التحميل وأمن البوابة</label>
              <input id="car-notes" class="form-control" placeholder="مثال: تم التحميل والتأمين بحزام شداد بحضور أمين المخزن..." />
            </div>
          </div>

          <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px;">
            <button type="button" class="btn btn-outline" onclick="closeModal()">إلغاء</button>
            <button type="submit" class="btn btn-danger">🚚 تأكيد صرف الطلبية وخصم المخزن وطباعة إذن صرف السيارة</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function submitVehicleDispatchVoucher(e, orderId) {
  e.preventDefault();
  const ord = (state.productionOrders || []).find(o => o.id === orderId);
  if (!ord) return;

  const dispatchDate = document.getElementById('car-date')?.value || todayStr();
  const carPlateNumber = (document.getElementById('car-plate')?.value || '').trim();
  const driverName = (document.getElementById('car-driver')?.value || '').trim();
  const driverPhone = (document.getElementById('car-phone')?.value || '').trim();
  const palletsDeliveredCount = Math.max(0, Number(document.getElementById('car-pallets-out')?.value || 0));
  const palletsReceivedCount = Math.max(0, Number(document.getElementById('car-pallets-in')?.value || 0));
  const carNotes = (document.getElementById('car-notes')?.value || '').trim();
  const now = getMonotonicIso(ord.updatedAt);
  const carVoucherNo = `CAR-${ord.orderNumber}`;

  // If stock was not yet deducted in earlier stage, deduct it now; otherwise update existing CAR movement details with vehicle & driver info
  if (!ord.stockDeducted) {
    for (const it of (ord.items || [])) {
      const thkId = it.thicknessId || `th-${it.thicknessMm}-${it.direction || 'qas'}`;
      const len = Number(it.lengthCm || 250);
      const wid = Number(it.widthCm || 125);
      deductSheetsFromCellPallets(thkId, it.gradeId, it.woodTypeId, Number(it.sheetsCount || 0), Number(it.unitPrice || 0), len, wid);

      state.warehouseMovements.unshift({
        id: uid('mov'),
        voucherNumber: carVoucherNo,
        date: dispatchDate,
        warehouseType: 'finished_veneers',
        warehouseLabel: 'إذن صرف وتحميل سيارة مبيعات',
        direction: 'out',
        directionLabel: 'صرف طلبية للسيارة',
        movementCategory: 'sales_exit',
        cellKey: getCellPriceKey(thkId, it.gradeId),
        lengthCm: len,
        widthCm: wid,
        sheetsCount: Number(it.sheetsCount || 0),
        unitSheetPrice: Number(it.unitPrice || 0),
        totalSaleAmount: Number(it.totalItemAmount || 0),
        itemSummary: `صرف طلبية (${ord.orderNumber}) للعميل ${ord.clientName} — مقاس (${formatVeneerDimensions(len, wid, true)}) تخانة ${it.thicknessMm} مم (${it.direction === 'sada' ? 'سدا' : 'قص'}) × ${it.gradeName} — سيارة رقم (${carPlateNumber}) سائق (${driverName})`,
        referenceCode: carPlateNumber,
        quantitySummary: `${it.sheetsCount} قطعة (${formatVeneerDimensions(len, wid, false)}) | ${it.volumeM3} م³`,
        performedBy: currentUser.name,
        approvedBy: ord.accountantReleaseBy || currentUser.name,
        updatedAt: now
      });
    }
    ord.stockDeducted = true;
    ord.stockDeductedAt = now;
  } else {
    // Stock was already deducted upon warehouse exit approval; enrich the existing movement records with car plate & driver details
    (state.warehouseMovements || []).forEach(m => {
      if (m.voucherNumber === carVoucherNo) {
        m.date = dispatchDate;
        m.warehouseLabel = 'إذن صرف وتحميل سيارة مبيعات';
        m.directionLabel = 'صرف طلبية للسيارة';
        m.referenceCode = carPlateNumber;
        if (!m.itemSummary.includes(carPlateNumber)) {
          m.itemSummary += ` — سيارة رقم (${carPlateNumber}) سائق (${driverName})`;
        }
        m.performedBy = currentUser.name;
        m.approvedBy = ord.accountantReleaseBy || currentUser.name;
        m.updatedAt = getMonotonicIso(m.updatedAt);
      }
    });
  }

  // Record Wooden Pallets Delivered / Received in Client's Pallet Ledger
  if (palletsDeliveredCount > 0 || palletsReceivedCount > 0) {
    state.palletMovements = state.palletMovements || [];
    state.palletMovements.unshift({
      id: uid('plm'),
      voucherNo: carVoucherNo,
      date: dispatchDate,
      clientId: ord.clientId,
      clientCode: ord.clientCode || 'CL',
      clientName: ord.clientName,
      orderId: ord.id,
      orderNumber: ord.orderNumber,
      deliveredCount: palletsDeliveredCount,
      receivedCount: palletsReceivedCount,
      carPlateNumber,
      driverName,
      notes: `مع تحميل الطلبية ${ord.orderNumber} — سيارة ${carPlateNumber} ${carNotes ? '(' + carNotes + ')' : ''}`,
      createdBy: currentUser.name,
      updatedAt: now
    });
  }

  ord.stage = 'completed';
  ord.status = 'completed';
  ord.carDispatchVoucher = {
    voucherNo: carVoucherNo,
    dispatchDate,
    carPlateNumber,
    driverName,
    driverPhone,
    palletsDeliveredCount,
    palletsReceivedCount,
    notes: carNotes,
    dispatchedBy: currentUser.name,
    dispatchedAt: now
  };
  ord.updatedAt = now;

  closeModal();
  saveState(`🚚 تم صرف الطلبية (${ord.orderNumber}) للعميل ${ord.clientName} وتحميل السيارة رقم (${carPlateNumber}) وتسليم (${palletsDeliveredCount}) بالتة وخصم الأرصدة من المخزن فوراً`);
  setTimeout(() => {
    printVehicleDispatchVoucher(ord.id);
  }, 250);
}

// Raw Materials, Scrap & Spare Parts Quick Stock Actions (Mobile-Friendly HTML Modals)
function adjustRawMaterialStock(rmId, dir) {
  const item = state.rawMaterials.find(r => r.id === rmId);
  if (!item) return;
  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot) return;
  modalRoot.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal-box" style="max-width:460px;">
        <div class="card-header">
          <div>
            <div class="card-title">${dir === 'in' ? '📥 توريد وإضافة خامات' : '📤 صرف خامات للتشغيل'}</div>
            <small style="color:var(--text-muted);">الصنف: <strong>${item.name}</strong> | الرصيد الحالي: <strong>${item.quantity} ${item.unit}</strong></small>
          </div>
          <button type="button" class="btn btn-sm btn-outline" onclick="closeModal()">✕</button>
        </div>
        <form onsubmit="submitAdjustRawMaterialStock(event, '${item.id}', '${dir}')">
          <div class="form-grid">
            <div class="form-group">
              <label>الكمية بـ (${item.unit})</label>
              <input id="rm-adj-qty" type="number" step="0.01" min="0.01" class="form-control" value="5" required autofocus />
            </div>
            <div class="form-group">
              <label>تاريخ الحركة</label>
              <input id="rm-adj-date" type="date" class="form-control" value="${todayStr()}" required />
            </div>
          </div>
          <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;">
            <button type="button" class="btn btn-outline" onclick="closeModal()">إلغاء</button>
            <button type="submit" class="btn ${dir === 'in' ? 'btn-success' : 'btn-primary'}">${dir === 'in' ? '📥 تأكيد التوريد' : '📤 تأكيد الصرف للتشغيل'}</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function submitAdjustRawMaterialStock(e, rmId, dir) {
  if (e) e.preventDefault();
  const item = state.rawMaterials.find(r => r.id === rmId);
  if (!item) return;
  const qty = Number(document.getElementById('rm-adj-qty')?.value || 0);
  if (isNaN(qty) || qty <= 0) return;
  const opDate = document.getElementById('rm-adj-date')?.value || todayStr();

  const now = new Date().toISOString();
  item.quantity = dir === 'in' ? +(Number(item.quantity) + qty).toFixed(3) : Math.max(0, +(Number(item.quantity) - qty).toFixed(3));
  item.updatedAt = now;

  state.warehouseMovements.unshift({
    id: uid('mov'),
    voucherNumber: `${dir === 'in' ? 'RCV' : 'ISS'}-RAW-${Date.now().toString().slice(-4)}`,
    date: opDate,
    warehouseType: 'raw_materials',
    warehouseLabel: 'مخزن الخامات',
    direction: dir,
    directionLabel: dir === 'in' ? 'إذن استلام خامات' : 'إذن صرف خامات للتشغيل',
    itemSummary: item.name,
    referenceCode: item.code,
    quantitySummary: `${qty} ${item.unit}`,
    performedBy: currentUser.name,
    approvedBy: currentUser.name,
    updatedAt: now
  });

  closeModal();
  saveState(`${dir === 'in' ? 'توريد' : 'صرف'} ${qty} ${item.unit} من ${item.name} بتاريخ ${opDate}`);
}

function openAddRawMaterialModal() {
  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot) return;
  modalRoot.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal-box" style="max-width:520px;">
        <div class="card-header">
          <div>
            <div class="card-title">➕ إضافة صنف خام جديد لمخزن الخامات</div>
            <small style="color:var(--text-muted);">تسجيل خام أو مستلزم إنتاج جديد في المخزن</small>
          </div>
          <button type="button" class="btn btn-sm btn-outline" onclick="closeModal()">✕</button>
        </div>
        <form onsubmit="submitAddRawMaterialModal(event)">
          <div class="form-grid">
            <div class="form-group" style="grid-column: 1 / -1;">
              <label>اسم الصنف الخام الجديد</label>
              <input id="rm-new-name" class="form-control" placeholder="مثال: جذوع خشب موسكي / غراء يوريا" required autofocus />
            </div>
            <div class="form-group">
              <label>وحدة القياس</label>
              <input id="rm-new-unit" class="form-control" value="م³" placeholder="م³ / طن / شيكارة / بكرة" required />
            </div>
            <div class="form-group">
              <label>الرصيد الافتتاحي</label>
              <input id="rm-new-qty" type="number" step="0.01" min="0" class="form-control" value="15" required />
            </div>
            ${canSeeFinancialPrices() ? `
              <div class="form-group">
                <label>تكلفة الوحدة بالجنيه</label>
                <input id="rm-new-cost" type="number" step="0.5" min="0" class="form-control" value="12000" />
              </div>
            ` : `<input id="rm-new-cost" type="hidden" value="0" />`}
            <div class="form-group">
              <label>تاريخ الإثبات</label>
              <input id="rm-new-date" type="date" class="form-control" value="${todayStr()}" required />
            </div>
          </div>
          <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;">
            <button type="button" class="btn btn-outline" onclick="closeModal()">إلغاء</button>
            <button type="submit" class="btn btn-primary">➕ حفظ الصنف الخام</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function submitAddRawMaterialModal(e) {
  if (e) e.preventDefault();
  const name = (document.getElementById('rm-new-name')?.value || '').trim();
  if (!name) return;
  const unit = (document.getElementById('rm-new-unit')?.value || 'م³').trim() || 'م³';
  const qty = Number(document.getElementById('rm-new-qty')?.value || 0);
  const cost = canSeeFinancialPrices() ? Number(document.getElementById('rm-new-cost')?.value || 0) : 0;
  const opDate = document.getElementById('rm-new-date')?.value || todayStr();
  const now = new Date().toISOString();

  state.rawMaterials.push({
    id: uid('rm'),
    code: `RAW-0${state.rawMaterials.length + 1}`,
    name,
    category: 'خامات ومستلزمات',
    unit,
    quantity: qty,
    minThreshold: 5,
    costPerUnit: cost,
    supplierName: 'مورد معتمد',
    location: 'مخزن الخامات',
    entryDate: opDate,
    updatedAt: now
  });
  closeModal();
  saveState(`إضافة صنف خام جديد: ${name} بتاريخ ${opDate}`);
}

function openAddScrapModal() {
  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot) return;
  modalRoot.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal-box" style="max-width:520px;">
        <div class="card-header">
          <div>
            <div class="card-title">➕ تسجيل هالك / قصاقيص جديدة</div>
            <small style="color:var(--text-muted);">إضافة كمية لمخزن الهالك والقصاقيص</small>
          </div>
          <button type="button" class="btn btn-sm btn-outline" onclick="closeModal()">✕</button>
        </div>
        <form onsubmit="submitAddScrapModal(event)">
          <div class="form-grid">
            <div class="form-group" style="grid-column: 1 / -1;">
              <label>بيان الهالك / القصاقيص</label>
              <input id="sc-new-name" class="form-control" placeholder="مثال: قصاقيص قشرة حور / نشارة تقشير" required autofocus />
            </div>
            <div class="form-group">
              <label>الوحدة</label>
              <input id="sc-new-unit" class="form-control" value="م³" placeholder="م³ / طن / عدد" required />
            </div>
            <div class="form-group">
              <label>الكمية</label>
              <input id="sc-new-qty" type="number" step="0.01" min="0" class="form-control" value="1.5" required />
            </div>
            ${canSeeFinancialPrices() ? `
              <div class="form-group">
                <label>السعر التقديري للوحدة</label>
                <input id="sc-new-price" type="number" step="0.5" min="0" class="form-control" value="6500" />
              </div>
            ` : `<input id="sc-new-price" type="hidden" value="0" />`}
            <div class="form-group">
              <label>تاريخ التسجيل</label>
              <input id="sc-new-date" type="date" class="form-control" value="${todayStr()}" required />
            </div>
          </div>
          <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;">
            <button type="button" class="btn btn-outline" onclick="closeModal()">إلغاء</button>
            <button type="submit" class="btn btn-primary">➕ حفظ بمخزن الهالك</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function submitAddScrapModal(e) {
  if (e) e.preventDefault();
  const name = (document.getElementById('sc-new-name')?.value || '').trim();
  if (!name) return;
  const unit = (document.getElementById('sc-new-unit')?.value || 'م³').trim() || 'م³';
  const qty = Number(document.getElementById('sc-new-qty')?.value || 0);
  const price = canSeeFinancialPrices() ? Number(document.getElementById('sc-new-price')?.value || 0) : 0;
  const opDate = document.getElementById('sc-new-date')?.value || todayStr();
  const now = new Date().toISOString();

  state.scrapItems.push({
    id: uid('sc'),
    code: `SCR-00${state.scrapItems.length + 1}`,
    name,
    woodTypeName: 'مختلط',
    category: 'قصاقيص وهالك',
    unit,
    quantity: qty,
    estimatedPricePerUnit: price,
    notes: `إضافة بتاريخ ${opDate}`,
    updatedAt: now
  });
  closeModal();
  saveState(`تسجيل إضافة هالك/قصاقيص: ${name} بتاريخ ${opDate}`);
}

function dispatchScrapItem(scId) {
  const item = state.scrapItems.find(s => s.id === scId);
  if (!item) return;
  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot) return;
  modalRoot.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal-box" style="max-width:440px;">
        <div class="card-header">
          <div>
            <div class="card-title">📤 صرف / بيع من مخزن الهالك</div>
            <small style="color:var(--text-muted);">الصنف: <strong>${item.name}</strong> | المتاح: <strong>${item.quantity} ${item.unit}</strong></small>
          </div>
          <button type="button" class="btn btn-sm btn-outline" onclick="closeModal()">✕</button>
        </div>
        <form onsubmit="submitDispatchScrapItem(event, '${item.id}')">
          <div class="form-group">
            <label>الكمية المطلوب صرفها بـ (${item.unit})</label>
            <input id="sc-disp-qty" type="number" step="0.01" min="0.01" max="${item.quantity || 99999}" class="form-control" value="1" required autofocus />
          </div>
          <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;">
            <button type="button" class="btn btn-outline" onclick="closeModal()">إلغاء</button>
            <button type="submit" class="btn btn-primary">📤 تأكيد الصرف</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function submitDispatchScrapItem(e, scId) {
  if (e) e.preventDefault();
  const item = state.scrapItems.find(s => s.id === scId);
  if (!item) return;
  const qty = Number(document.getElementById('sc-disp-qty')?.value || 0);
  if (qty <= 0) return;
  item.quantity = Math.max(0, +(Number(item.quantity) - qty).toFixed(3));
  item.updatedAt = new Date().toISOString();
  closeModal();
  saveState(`صرف/بيع ${qty} ${item.unit} من ${item.name}`);
}

function openAddSparePartModal() {
  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot) return;
  modalRoot.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal-box" style="max-width:520px;">
        <div class="card-header">
          <div>
            <div class="card-title">➕ إضافة قطعة غيار جديدة</div>
            <small style="color:var(--text-muted);">إضافة صنف جديد لمخزن قطع الغيار والمهمات</small>
          </div>
          <button type="button" class="btn btn-sm btn-outline" onclick="closeModal()">✕</button>
        </div>
        <form onsubmit="submitAddSparePartModal(event)">
          <div class="form-grid">
            <div class="form-group" style="grid-column: 1 / -1;">
              <label>اسم قطعة الغيار / المهمة</label>
              <input id="sp-new-name" class="form-control" placeholder="مثال: رولمان بلي للمجفف / سكينة مقصلة" required autofocus />
            </div>
            <div class="form-group">
              <label>اسم الماكينة التابعة لها</label>
              <input id="sp-new-machine" class="form-control" value="خط التقشير الأول" required />
            </div>
            <div class="form-group">
              <label>الكمية المتاحة (قطعة)</label>
              <input id="sp-new-qty" type="number" step="1" min="0" class="form-control" value="4" required />
            </div>
            ${canSeeFinancialPrices() ? `
              <div class="form-group">
                <label>تكلفة الوحدة بالجنيه</label>
                <input id="sp-new-cost" type="number" step="0.5" min="0" class="form-control" value="2500" />
              </div>
            ` : `<input id="sp-new-cost" type="hidden" value="0" />`}
          </div>
          <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;">
            <button type="button" class="btn btn-outline" onclick="closeModal()">إلغاء</button>
            <button type="submit" class="btn btn-primary">➕ حفظ قطعة الغيار</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function submitAddSparePartModal(e) {
  if (e) e.preventDefault();
  const name = (document.getElementById('sp-new-name')?.value || '').trim();
  if (!name) return;
  const machine = (document.getElementById('sp-new-machine')?.value || 'عام').trim() || 'عام';
  const qty = Number(document.getElementById('sp-new-qty')?.value || 0);
  const cost = canSeeFinancialPrices() ? Number(document.getElementById('sp-new-cost')?.value || 0) : 0;
  const now = new Date().toISOString();

  state.spareParts.push({
    id: uid('sp'),
    code: `SP-00${state.spareParts.length + 1}`,
    name,
    machineName: machine,
    category: 'قطع غيار صيانة',
    unit: 'قطعة',
    quantity: qty,
    minThreshold: 2,
    costPerUnit: cost,
    location: 'مخزن قطع الغيار',
    updatedAt: now
  });
  closeModal();
  saveState(`إضافة قطعة غيار جديدة: ${name}`);
}

function adjustSparePartStock(spId, dir) {
  const sp = state.spareParts.find(x => x.id === spId);
  if (!sp) return;
  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot) return;
  modalRoot.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal-box" style="max-width:440px;">
        <div class="card-header">
          <div>
            <div class="card-title">${dir === 'in' ? '📥 توريد قطعة غيار' : '🔧 صرف قطعة غيار للصيانة'}</div>
            <small style="color:var(--text-muted);">الصنف: <strong>${sp.name}</strong> | المتاح: <strong>${sp.quantity} قطعة</strong></small>
          </div>
          <button type="button" class="btn btn-sm btn-outline" onclick="closeModal()">✕</button>
        </div>
        <form onsubmit="submitAdjustSparePartStock(event, '${sp.id}', '${dir}')">
          <div class="form-group">
            <label>العدد المطلوب (${dir === 'in' ? 'توريد' : 'صرف للصيانة'})</label>
            <input id="sp-adj-qty" type="number" step="1" min="1" class="form-control" value="1" required autofocus />
          </div>
          <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;">
            <button type="button" class="btn btn-outline" onclick="closeModal()">إلغاء</button>
            <button type="submit" class="btn ${dir === 'in' ? 'btn-success' : 'btn-primary'}">${dir === 'in' ? '📥 تأكيد التوريد' : '🔧 تأكيد الصرف'}</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function submitAdjustSparePartStock(e, spId, dir) {
  if (e) e.preventDefault();
  const sp = state.spareParts.find(x => x.id === spId);
  if (!sp) return;
  const qty = Number(document.getElementById('sp-adj-qty')?.value || 0);
  if (qty <= 0) return;
  sp.quantity = dir === 'in' ? Number(sp.quantity) + qty : Math.max(0, Number(sp.quantity) - qty);
  sp.updatedAt = new Date().toISOString();
  closeModal();
  saveState(`${dir === 'in' ? 'توريد' : 'صرف صيانة'} عدد ${qty} من ${sp.name}`);
}

// Financial & Partners Modals
function openNewFinancialTxModal() {
  const desc = prompt('بيان الفاتورة أو المعاملة المالية:');
  if (!desc) return;
  const amount = Number(prompt('إجمالي المبلغ بالجنيه:', '25000') || 0);
  if (amount <= 0) return;
  const opDate = prompt('تاريخ المعاملة المالية (YYYY-MM-DD) — يدعم أي تاريخ سابق:', todayStr()) || todayStr();
  const now = new Date().toISOString();

  state.financialTransactions.unshift({
    id: uid('fin'),
    voucherNo: `VCH-${Date.now().toString().slice(-4)}`,
    date: opDate,
    type: 'sales_invoice',
    typeLabel: 'معاملة مالية / فاتورة',
    partnerName: 'حسابات المصنع',
    description: desc,
    totalAmount: amount,
    paidAmount: amount,
    remainingAmount: 0,
    paymentMethod: 'خزينة المصنع',
    createdBy: currentUser.name,
    approvedBy: currentUser.name,
    updatedAt: now
  });
  saveState(`تسجيل معاملة مالية بتاريخ ${opDate} بقيمة ${fmtMoney(amount)}: ${desc}`);
}

function openNewPartnerModal(returnToOrderModal = false) {
  const modalRoot = document.getElementById('modal-root');
  const nextCode = `CL-${101 + (state.partners?.length || 0)}`;

  modalRoot.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal-box" style="max-width:680px;">
        <div class="card-header">
          <div>
            <div class="card-title">🤝 إضافة عميل جديد بالكود والحسابات الافتتاحية (مالية + بالتات)</div>
            <small style="color:var(--text-muted);">يمكنك تحديد كود العميل المميز، ورصيده المالي الافتتاحي (عليه/له)، ورصيد البالتات المسلمة له أو المستلمة منه</small>
          </div>
          <button class="btn btn-sm btn-outline" onclick="closeModal()">✕</button>
        </div>

        <form onsubmit="submitNewPartnerModal(event, ${Boolean(returnToOrderModal)})">
          <div class="form-grid">
            <div class="form-group">
              <label style="color:var(--primary);font-weight:800;">🏷️ كود العميل المميز</label>
              <input id="pt-code" class="form-control" value="${nextCode}" placeholder="مثال: CL-101" required style="font-weight:800;border-color:var(--primary);" />
            </div>
            <div class="form-group">
              <label>🏢 اسم العميل / مصنع الكونتر والأبلكاش</label>
              <input id="pt-name" class="form-control" placeholder="اكتب اسم العميل أو الشركة..." required autofocus />
            </div>
            <div class="form-group">
              <label>📞 رقم الهاتف</label>
              <input id="pt-phone" class="form-control" placeholder="010xxxxxxxx" />
            </div>
            <div class="form-group">
              <label>📍 المدينة / المنطقة الصناعية</label>
              <input id="pt-city" class="form-control" placeholder="مثال: دمياط الجديدة / العاشر / بدر" />
            </div>
            <div class="form-group">
              <label>👤 الشخص المسؤول</label>
              <input id="pt-contact" class="form-control" placeholder="اسم مسؤول المشتريات / الحسابات" />
            </div>
            <div class="form-group">
              <label>📅 تاريخ فتح الحساب</label>
              <input id="pt-date" type="date" class="form-control" value="${todayStr()}" />
            </div>

            <div class="form-group">
              <label style="color:var(--danger);font-weight:800;">مديونية افتتاحية على العميل للمصنع (عليه ج.م)</label>
              <input id="pt-open-debit" type="number" step="0.5" min="0" class="form-control" value="0" />
            </div>
            <div class="form-group">
              <label style="color:var(--success);font-weight:800;">رصيد دائن / مستحقات افتتاحية للعميل (له ج.م)</label>
              <input id="pt-open-credit" type="number" step="0.5" min="0" class="form-control" value="0" />
            </div>

            <div class="form-group">
              <label style="color:var(--accent);font-weight:800;">🪵 بالتات خشبية مسلمة للعميل سابقاً (عدد)</label>
              <input id="pt-open-plt-del" type="number" min="0" class="form-control" value="0" />
            </div>
            <div class="form-group">
              <label style="color:var(--success);font-weight:800;">🪵 بالتات خشبية مستلمة من العميل سابقاً (عدد)</label>
              <input id="pt-open-plt-rec" type="number" min="0" class="form-control" value="0" />
            </div>

            <div class="form-group" style="grid-column: 1 / -1;">
              <label>ملاحظات إضافية على حساب العميل</label>
              <input id="pt-notes" class="form-control" placeholder="ملاحظات التعامل والائتمان..." />
            </div>
          </div>

          <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px;">
            <button type="button" class="btn btn-outline" onclick="closeModal()">إلغاء</button>
            <button type="submit" class="btn btn-primary">💾 حفظ بيانات العميل وكوده</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function submitNewPartnerModal(e, returnToOrderModal = false) {
  e.preventDefault();
  const code = (document.getElementById('pt-code')?.value || '').trim();
  const name = (document.getElementById('pt-name')?.value || '').trim();
  const phone = (document.getElementById('pt-phone')?.value || '').trim();
  const city = (document.getElementById('pt-city')?.value || '').trim();
  const contactPerson = (document.getElementById('pt-contact')?.value || '').trim();
  const entryDate = document.getElementById('pt-date')?.value || todayStr();
  const openingDebit = Math.max(0, Number(document.getElementById('pt-open-debit')?.value || 0));
  const openingCredit = Math.max(0, Number(document.getElementById('pt-open-credit')?.value || 0));
  const openingPalletsDelivered = Math.max(0, Number(document.getElementById('pt-open-plt-del')?.value || 0));
  const openingPalletsReceived = Math.max(0, Number(document.getElementById('pt-open-plt-rec')?.value || 0));
  const notes = (document.getElementById('pt-notes')?.value || '').trim();
  const now = new Date().toISOString();

  const newClient = {
    id: uid('pt'),
    code,
    type: 'client',
    name,
    contactPerson,
    phone,
    city,
    entryDate,
    openingDebit,
    openingCredit,
    openingPalletsDelivered,
    openingPalletsReceived,
    balance: +(openingDebit - openingCredit).toFixed(2),
    creditLimit: 500000,
    notes,
    updatedAt: now
  };

  state.partners = state.partners || [];
  state.partners.unshift(newClient);
  closeModal();
  saveState(`🤝 إضافة عميل جديد بكود (${code}) باسم: ${name}`);

  if (returnToOrderModal) {
    setTimeout(() => {
      openNewClientOrderPrepModal(newClient.id);
    }, 100);
  }
}

// CLIENT FULL HISTORY MODAL: Verify All Past Orders + Statement of Debts/Receivables + Wooden Pallets Ledger
function openClientFullHistoryModal(clientId, activeSection = 'all') {
  const pt = (state.partners || []).find(p => p.id === clientId);
  if (!pt) return;
  const m = computeClientMetrics(pt);
  const modalRoot = document.getElementById('modal-root');

  modalRoot.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal-box" style="max-width:980px;">
        <div class="card-header">
          <div>
            <div class="card-title">📂 ملف العميل الشامل: [${pt.code || 'CL'}] ${pt.name} — التحقق من الطلبيات الفائتة والمديونيات والبالتات</div>
            <small style="color:var(--text-muted);">
              📞 الهاتف: ${pt.phone || '-'} | 📍 المدينة: ${pt.city || '-'} | المسؤول: ${pt.contactPerson || '-'}
            </small>
          </div>
          <div style="display:flex;gap:6px;">
            <button class="btn btn-sm btn-accent" onclick="printClientFullStatement('${pt.id}')">🖨️ طباعة كشف حساب وبيان للعميل</button>
            <button class="btn btn-sm btn-outline" onclick="closeModal()">✕</button>
          </div>
        </div>

        <!-- Top Client KPI Summary -->
        <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(190px, 1fr));gap:10px;margin-bottom:16px;">
          <div style="background:var(--bg-elevated);padding:12px;border-radius:10px;border-right:4px solid var(--primary);">
            <small style="color:var(--text-muted);">إجمالي الطلبيات والمسحوبات</small>
            <div style="font-weight:900;font-size:1.05rem;">${m.orders.length} طلبية (${fmtMoney(m.totalDebit)})</div>
          </div>
          <div style="background:var(--bg-elevated);padding:12px;border-radius:10px;border-right:4px solid var(--success);">
            <small style="color:var(--text-muted);">إجمالي المدفوعات / الدائن</small>
            <div style="font-weight:900;font-size:1.05rem;color:var(--success);">${fmtMoney(m.totalCredit)}</div>
          </div>
          <div style="background:var(--bg-elevated);padding:12px;border-radius:10px;border-right:4px solid ${m.netDebt > 0 ? 'var(--danger)' : 'var(--success)'};">
            <small style="color:var(--text-muted);">صافي المديونية أو المستحقات</small>
            <div style="font-weight:900;font-size:1.05rem;color:${m.netDebt > 0 ? 'var(--danger)' : 'var(--success)'};">
              ${m.netDebt > 0 ? 'مدين (عليه): ' + fmtMoney(m.netDebt) : m.netDebt < 0 ? 'دائن (له): ' + fmtMoney(Math.abs(m.netDebt)) : 'خالص (0 ج.م)'}
            </div>
          </div>
          <div style="background:var(--bg-elevated);padding:12px;border-radius:10px;border-right:4px solid #d97706;">
            <small style="color:var(--text-muted);">رصيد البالتات الخشبية</small>
            <div style="font-weight:900;font-size:0.95rem;">
              مسلم له: ${m.palletsDelivered} | مستلم منه: ${m.palletsReceived}<br/>
              <span style="color:#d97706;">متبقي طرف العميل: ${m.netPalletsAtClient} بالتة</span>
            </div>
          </div>
        </div>

        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;">
          <button class="btn btn-sm btn-primary" onclick="closeModal(); openNewClientOrderPrepModal('${pt.id}');">📋 إنشاء طلبية جديدة لهذا العميل</button>
          <button class="btn btn-sm btn-success" onclick="openClientPaymentModal('${pt.id}')">💵 تسجيل تحصيل دفعة مالية / تسوية مديونية</button>
          <button class="btn btn-sm btn-accent" onclick="openClientPalletMovementModal('${pt.id}')">🪵 تسجيل تسليم / استلام بالتات خشبية</button>
        </div>

        <div style="max-height:58vh;overflow-y:auto;padding-left:4px;">
          <!-- 1. All Past & Current Orders -->
          <div style="margin-bottom:18px;">
            <h4 style="margin-bottom:8px;color:var(--primary);">1️⃣ التحقق من جميع الطلبيات الفائتة والحالية للعميل (${m.orders.length} طلبية):</h4>
            ${m.orders.length === 0 ? `<p style="color:var(--text-muted);font-size:0.88rem;">لا توجد طلبيات مسجلة لهذا العميل حتى الآن.</p>` : `
              <div class="table-responsive">
                <table>
                  <thead>
                    <tr>
                      <th>الطلبية</th>
                      <th>التاريخ</th>
                      <th>الأصناف (تخانة × جودة × مقاس × كمية)</th>
                      <th>قبل الخصم</th>
                      <th>الخصم</th>
                      <th>الصافي</th>
                      <th>السيارة</th>
                      <th>البيان والإجراء</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${m.orders.map(o => {
                      const items = Array.isArray(o.items) ? o.items : [];
                      const car = o.carDispatchVoucher;
                      return `
                        <tr>
                          <td><strong>${o.orderNumber}</strong></td>
                          <td>${o.date}</td>
                          <td>
                            ${items.map(i => `<div style="font-size:0.73rem;">• ${i.thicknessMm}مم (${i.direction === 'sada' ? 'سدا' : 'قص'}) × ${i.gradeName} <span style="color:var(--accent);">[${formatVeneerDimensions(i.lengthCm, i.widthCm, false)}]</span>: <strong>${i.sheetsCount} ق</strong> × ${i.unitPrice} ج = ${fmtMoney(i.totalItemAmount)}</div>`).join('')}
                          </td>
                          <td>${fmtMoney(o.subtotalAmount || o.netTotalAmount || 0)}</td>
                          <td style="color:var(--danger);">-${fmtMoney(o.discountAmount || 0)}</td>
                          <td><strong style="color:var(--primary);">${fmtMoney(o.netTotalAmount || 0)}</strong></td>
                          <td>
                            ${car ? `<strong>${car.carPlateNumber}</strong><br/><small>بالتات: ${car.palletsDeliveredCount}</small>` : '-'}
                          </td>
                          <td>
                            <div style="display:flex;flex-wrap:wrap;gap:3px;">
                              <button class="btn btn-sm btn-outline" onclick="openClientOrderStatementModal('${o.id}')">📄 البيان</button>
                              ${car ? `<button class="btn btn-sm btn-success" onclick="printVehicleDispatchVoucher('${o.id}')">🖨️ السيارة</button>` : ''}
                              ${isFullAdmin(currentUser) ? `
                                <button class="btn btn-sm btn-danger" onclick="deleteOrderWithStockRestore('${o.id}')">🗑️ حذف</button>
                              ` : ''}
                            </div>
                          </td>
                        </tr>
                      `;
                    }).join('')}
                  </tbody>
                </table>
              </div>
            `}
          </div>

          <!-- 2. Financial Debts & Receivables Statement -->
          <div style="margin-bottom:18px;">
            <h4 style="margin-bottom:8px;color:var(--primary);">2️⃣ بيان المديونيات والمستحقات والفواتير والدفعات (${m.txs.length} حركة مالية):</h4>
            <div class="table-responsive">
              <table>
                <thead>
                  <tr>
                    <th>رقم المستند</th>
                    <th>التاريخ</th>
                    <th>النوع</th>
                    <th>البيان</th>
                    <th>مدين (عليه)</th>
                    <th>دائن (مسدد / له)</th>
                    ${isFullAdmin(currentUser) ? '<th>تعديل / حذف</th>' : ''}
                  </tr>
                </thead>
                <tbody>
                  ${(m.openingDebit > 0 || m.openingCredit > 0) ? `
                    <tr style="background:var(--bg-elevated);">
                      <td><strong>OPEN-BAL</strong></td>
                      <td>${pt.entryDate || '-'}</td>
                      <td>رصيد افتتاحي</td>
                      <td>الرصيد الافتتاحي المسجل عند تكويد العميل</td>
                      <td style="color:var(--danger);font-weight:700;">${fmtMoney(m.openingDebit)}</td>
                      <td style="color:var(--success);font-weight:700;">${fmtMoney(m.openingCredit)}</td>
                      ${isFullAdmin(currentUser) ? `<td><button class="btn btn-sm btn-outline" onclick="openEditPartnerModal('${pt.id}')">✏️ تعديل</button></td>` : ''}
                    </tr>
                  ` : ''}
                  ${m.txs.map(tx => {
                    const isInv = tx.type === 'sales_invoice';
                    return `
                      <tr>
                        <td><strong>${tx.voucherNo}</strong></td>
                        <td>${tx.date}</td>
                        <td><span class="badge ${isInv ? 'badge-warning' : 'badge-success'}">${tx.typeLabel}</span></td>
                        <td>${tx.description}</td>
                        <td style="color:var(--danger);font-weight:700;">${isInv ? fmtMoney(tx.totalAmount) : fmtMoney(0)}</td>
                        <td style="color:var(--success);font-weight:700;">${fmtMoney(tx.paidAmount || (!isInv ? tx.totalAmount : 0))}</td>
                        ${isFullAdmin(currentUser) ? `
                          <td>
                            <div style="display:flex;gap:4px;">
                              <button class="btn btn-sm btn-outline" style="padding:3px 7px;" onclick="openEditFinancialTxModal('${tx.id}')">✏️</button>
                              <button class="btn btn-sm btn-danger" style="padding:3px 7px;" onclick="deleteFinancialTxRecord('${tx.id}')">🗑️</button>
                            </div>
                          </td>
                        ` : ''}
                      </tr>
                    `;
                  }).join('')}
                </tbody>
              </table>
            </div>
          </div>

          <!-- 3. Wooden Pallets Delivered & Received Ledger -->
          <div>
            <h4 style="margin-bottom:8px;color:var(--primary);">3️⃣ حساب البالتات الخشبية المسلمة للعميل والمستلمة منه (${m.palletMoves.length} حركة):</h4>
            <div class="table-responsive">
              <table>
                <thead>
                  <tr>
                    <th>رقم السند</th>
                    <th>التاريخ</th>
                    <th>بالتات مسلمة للعميل (+)</th>
                    <th>بالتات مستلمة من العميل (-)</th>
                    <th>رقم السيارة / السائق / البيان</th>
                    ${isFullAdmin(currentUser) ? '<th>تعديل / حذف</th>' : ''}
                  </tr>
                </thead>
                <tbody>
                  ${(pt.openingPalletsDelivered > 0 || pt.openingPalletsReceived > 0) ? `
                    <tr style="background:var(--bg-elevated);">
                      <td><strong>OPEN-PLT</strong></td>
                      <td>${pt.entryDate || '-'}</td>
                      <td><strong>+${pt.openingPalletsDelivered || 0} بالتة</strong></td>
                      <td><strong>-${pt.openingPalletsReceived || 0} بالتة</strong></td>
                      <td>رصيد بالتات افتتاحي</td>
                      ${isFullAdmin(currentUser) ? `<td><button class="btn btn-sm btn-outline" onclick="openEditPartnerModal('${pt.id}')">✏️ تعديل</button></td>` : ''}
                    </tr>
                  ` : ''}
                  ${m.palletMoves.map(pm => `
                    <tr>
                      <td><strong>${pm.voucherNo || '-'}</strong></td>
                      <td>${pm.date}</td>
                      <td><span class="badge badge-warning">+${pm.deliveredCount || 0} بالتة مسلمة</span></td>
                      <td><span class="badge badge-success">-${pm.receivedCount || 0} بالتة مستلمة</span></td>
                      <td>${pm.notes || pm.carPlateNumber || '-'}</td>
                      ${isFullAdmin(currentUser) ? `
                        <td>
                          <div style="display:flex;gap:4px;">
                            <button class="btn btn-sm btn-outline" style="padding:3px 7px;" onclick="openEditPalletMovementModal('${pm.id}')">✏️</button>
                            <button class="btn btn-sm btn-danger" style="padding:3px 7px;" onclick="deletePalletMovementRecord('${pm.id}')">🗑️</button>
                          </div>
                        </td>
                      ` : ''}
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

// CLIENT PAYMENT / DEBT SETTLEMENT MODAL
function openClientPaymentModal(clientId) {
  const pt = (state.partners || []).find(p => p.id === clientId);
  if (!pt) return;
  const m = computeClientMetrics(pt);
  const modalRoot = document.getElementById('modal-root');

  modalRoot.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal-box" style="max-width:560px;">
        <div class="card-header">
          <div>
            <div class="card-title">💵 تسجيل تحصيل دفعة مالية / تسوية حساب العميل (${pt.code || 'CL'} - ${pt.name})</div>
            <small style="color:var(--text-muted);">
              الرصيد الحالي قبل السند: <strong>${m.netDebt > 0 ? 'مدين (عليه للمصنع): ' + fmtMoney(m.netDebt) : m.netDebt < 0 ? 'دائن (له مستحقات): ' + fmtMoney(Math.abs(m.netDebt)) : 'خالص (0 ج.م)'}</strong>
            </small>
          </div>
          <button class="btn btn-sm btn-outline" onclick="closeModal()">✕</button>
        </div>

        <form onsubmit="submitClientPayment(event, '${pt.id}')">
          <div class="form-grid">
            <div class="form-group">
              <label>تاريخ السند (حالي أو سابق)</label>
              <input id="cpay-date" type="date" class="form-control" value="${todayStr()}" required />
            </div>
            <div class="form-group">
              <label>نوع التسوية المالية</label>
              <select id="cpay-type" class="form-control">
                <option value="client_payment">💵 تحصيل دفعة مسددة من العميل (تخصم من مديونيته)</option>
                <option value="sales_invoice">🧾 إضافة مديونية / مطالبة مالية على العميل</option>
                <option value="client_credit">🎁 إشعار خصم مكتسب / تسوية لصالح العميل</option>
              </select>
            </div>
            <div class="form-group">
              <label>المبلغ بالجنيه (ج.م)</label>
              <input id="cpay-amount" type="number" step="0.5" min="1" class="form-control" value="${m.netDebt > 0 ? m.netDebt : 10000}" required autofocus style="font-weight:800;border-color:var(--success);" />
            </div>
            <div class="form-group">
              <label>طريقة الدفع / الخزينة</label>
              <select id="cpay-method" class="form-control">
                <option value="نقدي بالخزينة">💵 نقدي بالخزينة</option>
                <option value="تحويل بنكي">🏦 تحويل بنكي</option>
                <option value="شيك بنكي">📝 شيك بنكي</option>
                <option value="تسوية حسابية">📒 تسوية حسابية</option>
              </select>
            </div>
            <div class="form-group" style="grid-column: 1 / -1;">
              <label>بيان السند / الملاحظات</label>
              <input id="cpay-notes" class="form-control" placeholder="مثال: دفعة من حساب الطلبيات السابقة..." required />
            </div>
          </div>

          <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px;">
            <button type="button" class="btn btn-outline" onclick="closeModal()">إلغاء</button>
            <button type="submit" class="btn btn-success">💾 حفظ السند وتحديث مديونية العميل فوراً</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function submitClientPayment(e, clientId) {
  e.preventDefault();
  const pt = (state.partners || []).find(p => p.id === clientId);
  if (!pt) return;

  const opDate = document.getElementById('cpay-date')?.value || todayStr();
  const txType = document.getElementById('cpay-type')?.value || 'client_payment';
  const amount = Math.max(0, Number(document.getElementById('cpay-amount')?.value || 0));
  const method = document.getElementById('cpay-method')?.value || 'نقدي بالخزينة';
  const notes = (document.getElementById('cpay-notes')?.value || '').trim();
  const now = new Date().toISOString();
  const vchNo = `RCV-${Date.now().toString().slice(-5)}`;

  if (txType === 'sales_invoice') {
    state.financialTransactions.unshift({
      id: uid('fin'),
      voucherNo: vchNo,
      date: opDate,
      type: 'sales_invoice',
      typeLabel: 'إثبات مديونية / مطالبة على العميل',
      partnerId: pt.id,
      partnerName: pt.name,
      description: notes || 'إضافة مديونية على حساب العميل',
      totalAmount: amount,
      paidAmount: 0,
      remainingAmount: amount,
      paymentMethod: method,
      createdBy: currentUser.name,
      approvedBy: currentUser.name,
      updatedAt: now
    });
  } else {
    state.financialTransactions.unshift({
      id: uid('fin'),
      voucherNo: vchNo,
      date: opDate,
      type: txType,
      typeLabel: txType === 'client_credit' ? 'إشعار خصم / مستحقات للعميل' : 'سند تحصيل دفعة من عميل',
      partnerId: pt.id,
      partnerName: pt.name,
      description: notes || `دفعة محصلة من العميل ${pt.name}`,
      totalAmount: amount,
      paidAmount: amount,
      remainingAmount: 0,
      paymentMethod: method,
      createdBy: currentUser.name,
      approvedBy: currentUser.name,
      updatedAt: now
    });

    if (txType === 'client_payment') {
      if (method.includes('بنك')) {
        state.treasuryBalances.bankAccount = Number(state.treasuryBalances.bankAccount || 0) + amount;
      } else if (method.includes('شيك')) {
        state.treasuryBalances.checksUnderCollection = Number(state.treasuryBalances.checksUnderCollection || 0) + amount;
      } else if (method.includes('نقدي')) {
        state.treasuryBalances.cashVault = Number(state.treasuryBalances.cashVault || 0) + amount;
      }
    }
  }

  closeModal();
  saveState(`💵 تسجيل حركة مالية للعميل (${pt.code || ''} - ${pt.name}) بقيمة ${fmtMoney(amount)} بتاريخ ${opDate}`);
}

// CLIENT WOODEN PALLETS DELIVERY / RETURN MODAL
function openClientPalletMovementModal(clientId) {
  const pt = (state.partners || []).find(p => p.id === clientId);
  if (!pt) return;
  const m = computeClientMetrics(pt);
  const modalRoot = document.getElementById('modal-root');

  modalRoot.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal-box" style="max-width:560px;">
        <div class="card-header">
          <div>
            <div class="card-title">🪵 حساب البالتات للعميل: [${pt.code || 'CL'}] ${pt.name}</div>
            <small style="color:var(--text-muted);">
              إجمالي مسلم له: <strong>${m.palletsDelivered}</strong> | مستلم منه: <strong>${m.palletsReceived}</strong> | المتبقي طرفه الآن: <strong>${m.netPalletsAtClient} بالتة</strong>
            </small>
          </div>
          <button class="btn btn-sm btn-outline" onclick="closeModal()">✕</button>
        </div>

        <form onsubmit="submitClientPalletMovement(event, '${pt.id}')">
          <div class="form-grid">
            <div class="form-group">
              <label>تاريخ حركة البالتات (حالي أو سابق)</label>
              <input id="pm-date" type="date" class="form-control" value="${todayStr()}" required />
            </div>
            <div class="form-group">
              <label>رقم السيارة / السائق (اختياري)</label>
              <input id="pm-car" class="form-control" placeholder="مثال: سيارة رقم 4582" />
            </div>
            <div class="form-group">
              <label style="color:var(--accent);font-weight:800;">📤 عدد البالتات المسلمة للعميل (+)</label>
              <input id="pm-del" type="number" min="0" class="form-control" value="0" required />
            </div>
            <div class="form-group">
              <label style="color:var(--success);font-weight:800;">📥 عدد البالتات المستلمة/المرتجعة من العميل (-)</label>
              <input id="pm-rec" type="number" min="0" class="form-control" value="${m.netPalletsAtClient > 0 ? m.netPalletsAtClient : 2}" required autofocus style="font-weight:800;border-color:var(--success);" />
            </div>
            <div class="form-group" style="grid-column: 1 / -1;">
              <label>ملاحظات حركة البالتات</label>
              <input id="pm-notes" class="form-control" placeholder="مثال: استلام بالتات فارغة مرتجعة من مصنع العميل..." />
            </div>
          </div>

          <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px;">
            <button type="button" class="btn btn-outline" onclick="closeModal()">إلغاء</button>
            <button type="submit" class="btn btn-primary">🪵 حفظ حركة البالتات في حساب العميل</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function submitClientPalletMovement(e, clientId) {
  e.preventDefault();
  const pt = (state.partners || []).find(p => p.id === clientId);
  if (!pt) return;

  const opDate = document.getElementById('pm-date')?.value || todayStr();
  const carPlateNumber = (document.getElementById('pm-car')?.value || '').trim();
  const deliveredCount = Math.max(0, Number(document.getElementById('pm-del')?.value || 0));
  const receivedCount = Math.max(0, Number(document.getElementById('pm-rec')?.value || 0));
  const notes = (document.getElementById('pm-notes')?.value || '').trim();

  if (deliveredCount === 0 && receivedCount === 0) {
    alert('يرجى إدخال عدد البالتات المسلمة أو المستلمة!');
    return;
  }

  state.palletMovements = state.palletMovements || [];
  state.palletMovements.unshift({
    id: uid('plm'),
    voucherNo: `PLT-${Date.now().toString().slice(-5)}`,
    date: opDate,
    clientId: pt.id,
    clientCode: pt.code || 'CL',
    clientName: pt.name,
    deliveredCount,
    receivedCount,
    carPlateNumber,
    notes: notes || (receivedCount > 0 ? `استلام ${receivedCount} بالتة من العميل` : `تسليم ${deliveredCount} بالتة للعميل`),
    createdBy: currentUser.name,
    updatedAt: new Date().toISOString()
  });

  closeModal();
  saveState(`🪵 تسجيل حركة بالتات للعميل (${pt.code || ''} - ${pt.name}): مسلم له (${deliveredCount}) / مستلم منه (${receivedCount}) بتاريخ ${opDate}`);
}

// Dynamic Catalog & Users Permissions Actions
function addWoodTypePrompt() {
  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot) return;
  modalRoot.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal-box" style="max-width:480px;">
        <div class="card-header">
          <div>
            <div class="card-title">🌲 إضافة نوع خشب جديد للكتالوج</div>
            <small style="color:var(--text-muted);">يظهر في قوائم مخزن القشرة التامة وأوامر التشغيل</small>
          </div>
          <button type="button" class="btn btn-sm btn-outline" onclick="closeModal()">✕</button>
        </div>
        <form onsubmit="submitAddWoodTypeModal(event)">
          <div class="form-grid">
            <div class="form-group" style="grid-column: 1 / -1;">
              <label>اسم نوع الخشب الجديد</label>
              <input id="wt-new-name" class="form-control" placeholder="مثال: خشب ماهوجني / خشب تيك / حور" required autofocus />
            </div>
            <div class="form-group">
              <label>كود مختصر (3 حروف)</label>
              <input id="wt-new-code" class="form-control" value="MAH" required />
            </div>
            ${canSeeFinancialPrices() ? `
              <div class="form-group">
                <label>متوسط سعر المتر المكعب الخام</label>
                <input id="wt-new-price" type="number" step="100" min="0" class="form-control" value="18000" />
              </div>
            ` : `<input id="wt-new-price" type="hidden" value="0" />`}
          </div>
          <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;">
            <button type="button" class="btn btn-outline" onclick="closeModal()">إلغاء</button>
            <button type="submit" class="btn btn-primary">➕ إضافة نوع الخشب</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function submitAddWoodTypeModal(e) {
  if (e) e.preventDefault();
  const name = (document.getElementById('wt-new-name')?.value || '').trim();
  if (!name) return;
  const code = (document.getElementById('wt-new-code')?.value || 'WOD').trim() || 'WOD';
  const price = canSeeFinancialPrices()
    ? Number(document.getElementById('wt-new-price')?.value || 15000)
    : 0;
  state.catalog.woodTypes.push({
    id: uid('wt'),
    name,
    code,
    defaultLogPricePerM3: price,
    active: true
  });
  closeModal();
  saveState(`إضافة نوع خشب جديد للكتالوج: ${name}`);
}

// Modal to manage and add Custom Company Dimensions (المقاس المعتمد 125×250 سم + مقاسات الشركات الخاصة)
function openCustomDimensionsModal() {
  const modalRoot = document.getElementById('modal-root');
  const dims = getPresetVeneerDimensions();
  modalRoot.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal-box" style="max-width:680px;">
        <div class="card-header">
          <div>
            <div class="card-title">📐 إدارة مقاسات القشرة (المقاس المعتمد 125×250 سم + مقاسات الشركات الخاصة)</div>
            <small style="color:var(--text-muted);">المقاس المعتمد الأساسي للقشرة هو <strong>125 سم × 250 سم</strong>، ويمكنك هنا إضافة أي مقاسات خاصة تطلبها بعض الشركات لتظهر في قوائم أوامر التشغيل والمخازن</small>
          </div>
          <button class="btn btn-sm btn-outline" onclick="closeModal()">✕</button>
        </div>

        <form onsubmit="submitAddCustomDimension(event)" style="background:var(--bg-elevated);padding:12px 14px;border-radius:10px;border:1px solid var(--border-color);margin-bottom:14px;">
          <div style="font-weight:800;color:var(--primary);margin-bottom:8px;">➕ إضافة مقاس خاص جديد للشركات:</div>
          <div class="form-grid">
            <div class="form-group">
              <label>العرض (سم) — مثال: 122 أو 110 أو 100</label>
              <input id="cdim-wid" type="number" step="0.5" min="10" class="form-control" placeholder="مثال: 122" required autofocus />
            </div>
            <div class="form-group">
              <label>الطول (سم) — مثال: 244 أو 220 أو 200</label>
              <input id="cdim-len" type="number" step="0.5" min="10" class="form-control" placeholder="مثال: 244" required />
            </div>
            <div class="form-group" style="grid-column: span 2;">
              <label>اسم الشركة / ملاحظة المقاس الخاص (اختياري)</label>
              <input id="cdim-note" class="form-control" placeholder="مثال: مقاس خاص لشركة الكونتر / الأبواب..." />
            </div>
          </div>
          <div style="display:flex;justify-content:flex-end;margin-top:10px;">
            <button type="submit" class="btn btn-sm btn-primary">➕ حفظ المقاس الخاص في النظام</button>
          </div>
        </form>

        <div class="table-responsive" style="max-height:45vh;overflow-y:auto;">
          <table>
            <thead>
              <tr>
                <th>المقاس (العرض × الطول)</th>
                <th>مساحة الفرخ (م²)</th>
                <th>التصنيف / البيان</th>
                <th>إجراء</th>
              </tr>
            </thead>
            <tbody>
              ${dims.map(d => {
                const area = +((Number(d.lengthCm) / 100) * (Number(d.widthCm) / 100)).toFixed(4);
                const isSavedCustom = (state.catalog?.customDimensions || []).some(cd => cd.id === d.id);
                return `
                  <tr>
                    <td><strong>${d.widthCm} × ${d.lengthCm} سم</strong></td>
                    <td>${area} م²</td>
                    <td>
                      ${d.isStandard
                        ? `<span class="badge badge-success">المقاس المعتمد الأساسي</span>`
                        : `<span class="badge" style="background:#7c3aed;color:#fff;">مقاس خاص للشركات</span> <small>${d.clientNote || ''}</small>`}
                    </td>
                    <td>
                      ${isSavedCustom ? `<button type="button" class="btn btn-sm btn-danger" style="padding:2px 6px;font-size:0.68rem;" onclick="deleteCustomDimension('${d.id}')">🗑️ حذف</button>` : '-'}
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

function submitAddCustomDimension(e) {
  e.preventDefault();
  const wid = Math.max(10, Number(document.getElementById('cdim-wid')?.value || 125));
  const len = Math.max(10, Number(document.getElementById('cdim-len')?.value || 250));
  const note = (document.getElementById('cdim-note')?.value || '').trim();
  if (isStandardVeneerDimension(len, wid)) {
    alert('المقاس 125 × 250 سم هو المقاس المعتمد الأساسي وموجود بالفعل!');
    return;
  }
  ensureCustomDimensionInCatalog(len, wid, note);
  saveState(`📐 إضافة مقاس قشرة خاص للشركات: ${wid}×${len} سم ${note ? '(' + note + ')' : ''}`);
  openCustomDimensionsModal();
}

function deleteCustomDimension(dimId) {
  if (!state.catalog?.customDimensions) return;
  markRecordIdDeleted(dimId);
  state.catalog.customDimensions = state.catalog.customDimensions.filter(d => d.id !== dimId);
  saveState(`🗑️ حذف مقاس خاص من قائمة المقاسات`);
  openCustomDimensionsModal();
}

// Modal to add Thickness asking whether it is Cut (قص) or Warp (سدا) or Both
function openAddThicknessModal() {
  const modalRoot = document.getElementById('modal-root');
  modalRoot.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal-box" style="max-width:560px;">
        <div class="card-header">
          <div>
            <div class="card-title">➕ إضافة تخانة قشرة جديدة (تحديد الاتجاه: قص / سدا)</div>
            <small style="color:var(--text-muted);">كل اتجاه (قص أو سدا) يعتبر منتجاً مستقلاً بصف خاص في جميع درجات الجودة</small>
          </div>
          <button class="btn btn-sm btn-outline" onclick="closeModal()">✕</button>
        </div>

        <form onsubmit="submitAddThicknessModal(event)">
          <div class="form-grid">
            <div class="form-group">
              <label>التخانة بالمليمتر (مم) — مثال: 0.6 أو 1.2 أو 1.5 أو 2.2</label>
              <input id="new-thk-mm" type="number" step="0.05" min="0.1" class="form-control" placeholder="مثال: 1.5" required autofocus />
            </div>

            <div class="form-group">
              <label>اتجاه القشرة لهذه التخانة (قص ولا سدا؟)</label>
              <select id="new-thk-dir" class="form-control" required style="font-weight:800;border-color:var(--primary);">
                <option value="qas">✂️ اتجاه قص (صف مستقل بالمخزن)</option>
                <option value="sada">📏 اتجاه سدا (صف مستقل بالمخزن)</option>
                <option value="both">🔄 إضافة الاتجاهين معاً (صف قص + صف سدا منفصلين)</option>
              </select>
            </div>

            <div class="form-group">
              <label>وصف إضافي للتخانة (اختياري)</label>
              <input id="new-thk-label" class="form-control" placeholder="مثال: قشرة وجه / حشو كونتر" />
            </div>

            <div class="form-group">
              <label>عدد القطع (الأفرخ) القياسي بالبالتة</label>
              <input id="new-thk-sheets" type="number" min="1" class="form-control" value="400" required />
            </div>

            ${canSeeFinancialPrices() ? `
            <div class="form-group" style="grid-column:1 / -1;">
              <label>سعر القطعة الواحدة الافتراضي بالجنيه (اختياري — يوضع تلقائياً في الجدول السفلي ويمكن تعديله لكل جودة)</label>
              <input id="new-thk-piece-price" type="number" step="0.5" min="0" class="form-control" placeholder="مثال: 45.00 (أو اتركه فارغاً لتسعير كل خلية جودة على حدة)" />
            </div>
            ` : `<input id="new-thk-piece-price" type="hidden" value="0" />`}
          </div>

          <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:18px;">
            <button type="button" class="btn btn-outline" onclick="closeModal()">إلغاء</button>
            <button type="submit" class="btn btn-primary">➕ إضافة التخانة لجدول المخازن</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function addThicknessPrompt() {
  openAddThicknessModal();
}

function submitAddThicknessModal(e) {
  e.preventDefault();
  const mm = Number(document.getElementById('new-thk-mm')?.value || 0);
  if (isNaN(mm) || mm <= 0) {
    alert('يرجى إدخال قيمة صحيحة للتخانة بالمليمتر!');
    return;
  }
  const dirChoice = document.getElementById('new-thk-dir')?.value || 'qas';
  const customLabel = (document.getElementById('new-thk-label')?.value || '').trim();
  const sheets = Number(document.getElementById('new-thk-sheets')?.value || 400);
  const defaultPiecePrice = Number(document.getElementById('new-thk-piece-price')?.value || 0);

  const directionsToAdd = dirChoice === 'both' ? ['qas', 'sada'] : [dirChoice];
  const addedNames = [];

  state.catalog.thicknesses = state.catalog.thicknesses || [];
  state.catalog.cellPrices = state.catalog.cellPrices || {};

  for (const dir of directionsToAdd) {
    const dirLabel = dir === 'sada' ? 'اتجاه سدا' : 'اتجاه قص';
    const rowId = `th-${mm}-${dir}`;
    const alreadyExists = state.catalog.thicknesses.some(
      t => t.id === rowId || (Number(t.mm) === mm && (t.direction || 'qas') === dir)
    );
    if (alreadyExists) {
      if (directionsToAdd.length === 1) {
        alert(`التخانة (${mm} مم — ${dirLabel}) موجودة بالفعل في الجدول!`);
        return;
      }
      continue;
    }

    state.deletedIds = (state.deletedIds || []).filter(id => id !== rowId);
    state.catalog.thicknesses.push({
      id: rowId,
      mm,
      direction: dir,
      directionLabel: dirLabel,
      label: customLabel ? `${customLabel} (${dirLabel})` : `${mm} مم — ${dirLabel}`,
      category: dirLabel,
      standardSheetsPerPallet: sheets
    });

    if (defaultPiecePrice > 0) {
      for (const g of (state.catalog.grades || [])) {
        state.catalog.cellPrices[getCellPriceKey(rowId, g.id)] = defaultPiecePrice;
      }
    }

    addedNames.push(`${mm} مم (${dirLabel})`);
  }

  state.catalog.thicknesses.sort((a, b) => {
    if (Number(a.mm) !== Number(b.mm)) return Number(a.mm) - Number(b.mm);
    return (a.direction || 'qas').localeCompare(b.direction || 'qas');
  });

  closeModal();
  if (addedNames.length > 0) {
    saveState(`إضافة تخانة جديدة لجدول المخازن وجدول الأسعار: ${addedNames.join(' + ')}`);
  }
}

function deleteThicknessFromMatrix(thkIdOrMm) {
  const target = state.catalog.thicknesses.find(
    t => t.id === thkIdOrMm || String(t.mm) === String(thkIdOrMm)
  );
  if (!target) return;

  const existingSheets = (state.pallets || [])
    .filter(p => p.status === 'in_stock' && matchPalletToThicknessRow(p, target))
    .reduce((s, p) => s + Number(p.sheetsCount || 0), 0);

  const dirLabel = target.direction === 'sada' ? 'اتجاه سدا' : 'اتجاه قص';

  if (existingSheets > 0) {
    alert(`⚠️ لا يمكن إلغاء التخانة (${target.mm} مم — ${dirLabel}) لوجود رصيد حالي بها في المخزن (${existingSheets} قطعة).\nيسمح بإلغاء التخانة فقط في حالة عدم وجود رصيد لها (الرصيد = 0).`);
    return;
  }

  if (!confirm(`هل أنت متأكد من إلغاء التخانة (${target.mm} مم — ${dirLabel}) من جدول المخزن وجدول الأسعار؟ (الرصيد الحالي = 0)`)) return;

  state.deletedIds = state.deletedIds || [];
  state.deletedIds.push(target.id);
  state.catalog.thicknesses = state.catalog.thicknesses.filter(t => t.id !== target.id);
  saveState(`إلغاء التخانة (${target.mm} مم — ${dirLabel}) لعدم وجود رصيد لها`);
}

function updateCellUnitPrice(thkId, gradeId, priceVal) {
  const price = Math.max(0, Number(priceVal || 0));
  state.catalog.cellPrices = state.catalog.cellPrices || {};
  const key = getCellPriceKey(thkId, gradeId);
  state.catalog.cellPrices[key] = price;

  const thkObj = state.catalog.thicknesses.find(t => t.id === thkId);
  const gradeObj = state.catalog.grades.find(g => g.id === gradeId);

  // Also update in-stock pallets matching this cell so inventory value reflects the new piece price immediately
  if (thkObj) {
    for (const p of (state.pallets || [])) {
      if (p.status === 'in_stock' && matchPalletToThicknessRow(p, thkObj) && p.gradeId === gradeId) {
        p.unitSheetPrice = price;
        p.totalValue = +(Number(p.sheetsCount || 0) * price).toFixed(2);
        p.updatedAt = new Date().toISOString();
      }
    }
  }

  const label = thkObj ? `${thkObj.mm} مم (${thkObj.direction === 'sada' ? 'سدا' : 'قص'})` : thkId;
  const gName = gradeObj ? gradeObj.name : gradeId;
  saveState(`تحديث سعر القطعة الواحدة لخلية [${label} × ${gName}] إلى ${fmtNum(price, 2)} ج.م`);
}

function addGradePrompt() {
  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot) return;
  modalRoot.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal-box" style="max-width:480px;">
        <div class="card-header">
          <div>
            <div class="card-title">➕ إضافة درجة جودة جديدة لجدول المخازن</div>
            <small style="color:var(--text-muted);">تضاف كعمود مستقل في مصفوفة كميات القشرة وجدول الأسعار</small>
          </div>
          <button type="button" class="btn btn-sm btn-outline" onclick="closeModal()">✕</button>
        </div>
        <form onsubmit="submitAddGradeModal(event)">
          <div class="form-grid">
            <div class="form-group">
              <label>رمز درجة الجودة (مثال: A أو B أو C أو A+)</label>
              <input id="gr-new-code" class="form-control" placeholder="مثال: A+" required autofocus oninput="const nm=document.getElementById('gr-new-name'); if(nm && !nm.dataset.edited) nm.value='جودة ('+this.value.trim()+')';" />
            </div>
            <div class="form-group">
              <label>اسم درجة الجودة في الجدول</label>
              <input id="gr-new-name" class="form-control" placeholder="مثال: جودة (A+)" oninput="this.dataset.edited='1'" required />
            </div>
            ${canSeeFinancialPrices() ? `
              <div class="form-group" style="grid-column: 1 / -1;">
                <label>سعر القطعة الواحدة الافتراضي بالجنيه (اختياري)</label>
                <input id="gr-new-price" type="number" step="0.5" min="0" class="form-control" placeholder="مثال: 50 (أو اتركه 0 لتسعير كل خلية منفردة)" value="0" />
              </div>
            ` : `<input id="gr-new-price" type="hidden" value="0" />`}
          </div>
          <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;">
            <button type="button" class="btn btn-outline" onclick="closeModal()">إلغاء</button>
            <button type="submit" class="btn btn-primary">➕ إضافة درجة الجودة</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function submitAddGradeModal(e) {
  if (e) e.preventDefault();
  const code = (document.getElementById('gr-new-code')?.value || '').trim();
  if (!code) return;
  const name = (document.getElementById('gr-new-name')?.value || `جودة (${code})`).trim() || code;
  const defaultPiecePrice = canSeeFinancialPrices()
    ? Number(document.getElementById('gr-new-price')?.value || 0)
    : 0;
  const newGradeId = uid('gr');

  state.catalog.grades.push({
    id: newGradeId,
    code,
    name,
    color: '#0f766e',
    defaultPricePerM3: 20000,
    description: 'درجة جودة'
  });

  if (defaultPiecePrice > 0) {
    state.catalog.cellPrices = state.catalog.cellPrices || {};
    for (const t of (state.catalog.thicknesses || [])) {
      state.catalog.cellPrices[getCellPriceKey(t.id, newGradeId)] = defaultPiecePrice;
    }
  }

  closeModal();
  saveState(`إضافة درجة جودة جديدة للجدول: ${name}`);
}

function deleteGradeFromMatrix(gradeId) {
  const gradeObj = state.catalog.grades.find(g => g.id === gradeId);
  if (!gradeObj) return;

  const existingSheets = (state.pallets || [])
    .filter(p => p.status === 'in_stock' && p.gradeId === gradeId)
    .reduce((s, p) => s + Number(p.sheetsCount || 0), 0);

  if (existingSheets > 0) {
    alert(`⚠️ لا يمكن إلغاء الجودة (${gradeObj.name}) لوجود رصيد حالي بها في المخزن (${existingSheets} قطعة).\nيسمح بإلغاء الجودة فقط في حالة عدم وجود رصيد لها (الرصيد = 0).`);
    return;
  }

  if (!confirm(`هل أنت متأكد من إلغاء درجة الجودة (${gradeObj.name}) من جدول المخزن؟ (الرصيد الحالي = 0)`)) return;
  state.deletedIds = state.deletedIds || [];
  state.deletedIds.push(gradeId);
  state.catalog.grades = state.catalog.grades.filter(g => g.id !== gradeId);
  saveState(`إلغاء درجة الجودة (${gradeObj.name}) لعدم وجود رصيد لها`);
}

// Interactive Cell Modal (In Production / Sales Return / Out Sales / Rework / Direct Set Balance)
let activeCellContext = null;

function openWarehouseOpShortcut(opType = 'in') {
  const thicknesses = getSortedThicknesses();
  const grades = state.catalog?.grades || [];

  // Ensure default thickness/grade exist if catalog was empty
  if (thicknesses.length === 0) {
    state.catalog.thicknesses = [
      { id: 'th-1.5-qas', mm: 1.5, direction: 'qas', directionLabel: 'اتجاه قص', label: '1.5 مم — اتجاه قص', category: 'اتجاه قص', standardSheetsPerPallet: 400 }
    ];
  }
  if (grades.length === 0) {
    state.catalog.grades = [
      { id: 'gr-a', code: 'A', name: 'درجة أولى ممتازة (A)', color: '#0f766e', defaultPricePerM3: 20000 }
    ];
  }

  const thkList = getSortedThicknesses();
  const grdList = state.catalog.grades;

  // If operation is 'out' or 'rework', prefer selecting a cell that currently has stock > 0
  if (opType === 'out' || opType === 'rework') {
    const stockedPallet = (state.pallets || []).find(p => p.status === 'in_stock' && Number(p.sheetsCount || 0) > 0);
    if (stockedPallet) {
      const tId = stockedPallet.thicknessId || `th-${stockedPallet.thicknessMm}-${stockedPallet.direction || 'qas'}`;
      openMatrixCellModal(tId, stockedPallet.gradeId || grdList[0].id, opType);
      return;
    }
  }

  openMatrixCellModal(thkList[0].id, grdList[0].id, opType);
}

function switchMatrixModalCell(newThkId, newGradeId) {
  if (!activeCellContext) return;
  const currentOp = activeCellContext.op || 'in';
  const currentDate = document.getElementById('cell-date')?.value || activeCellContext.opDate || todayStr();
  openMatrixCellModal(newThkId || activeCellContext.thkId, newGradeId || activeCellContext.gradeId, currentOp);
  if (activeCellContext) {
    activeCellContext.op = currentOp;
    activeCellContext.opDate = currentDate;
    const selectedWoodId = document.getElementById('cell-wood')?.value || (state.catalog.woodTypes?.[0]?.id || 'wt-general');
    renderMatrixCellModalUI(selectedWoodId, 100);
  }
}

function openMatrixCellModal(thkIdOrMm, gradeId, defaultOp = 'in') {
  const thkObj = state.catalog.thicknesses.find(
    t => t.id === thkIdOrMm || String(t.mm) === String(thkIdOrMm)
  ) || state.catalog.thicknesses[0] || {
    id: `th-${thkIdOrMm || 1.5}-qas`,
    mm: Number(thkIdOrMm) || 1.5,
    direction: 'qas',
    directionLabel: 'اتجاه قص',
    label: `${thkIdOrMm || 1.5} مم`,
    standardSheetsPerPallet: 400
  };

  const gradeObj = state.catalog.grades.find(g => g.id === gradeId) || state.catalog.grades[0] || {
    id: gradeId || 'gr-a',
    name: 'عام',
    code: 'A',
    defaultPricePerM3: 20000
  };

  const defaultWoodId = state.catalog.woodTypes?.length > 0 ? state.catalog.woodTypes[0].id : 'wt-general';
  const selectedWoodId = veneerFilterWood !== 'all' ? veneerFilterWood : defaultWoodId;

  const matchingPallets = (state.pallets || []).filter(p =>
    p.status === 'in_stock' &&
    matchPalletToThicknessRow(p, thkObj) &&
    p.gradeId === gradeObj.id &&
    (veneerFilterWood === 'all' || p.woodTypeId === veneerFilterWood)
  );

  const currentSheets = matchingPallets.reduce((s, p) => s + Number(p.sheetsCount || 0), 0);
  const currentM3 = matchingPallets.reduce((s, p) => s + Number(p.volumeM3 || 0), 0);
  const currentM2 = matchingPallets.reduce((s, p) => s + Number(p.areaM2 || 0), 0);
  const unitPiecePrice = getCellUnitPrice(thkObj.id, gradeObj.id);

  // Restrict 'set' to full admin only
  let effectiveOp = defaultOp;
  if (effectiveOp === 'set' && !isFullAdmin(currentUser)) {
    effectiveOp = 'in';
  }

  activeCellContext = {
    thkId: thkObj.id,
    thkMm: Number(thkObj.mm),
    direction: thkObj.direction || 'qas',
    directionLabel: thkObj.direction === 'sada' ? 'اتجاه سدا' : 'اتجاه قص',
    gradeId: gradeObj.id,
    gradeName: gradeObj.name,
    gradeCode: gradeObj.code,
    lengthCm: 250,
    widthCm: 125,
    unitPiecePrice,
    defaultPrice: gradeObj.defaultPricePerM3,
    currentSheets,
    currentM3,
    currentM2,
    opDate: todayStr(),
    op: effectiveOp
  };

  renderMatrixCellModalUI(selectedWoodId, thkObj.standardSheetsPerPallet || 400);
}

function renderMatrixCellModalUI(selectedWoodId, defaultSheets = 400) {
  if (!activeCellContext) return;
  const ctx = activeCellContext;
  const modalRoot = document.getElementById('modal-root');
  const isSada = ctx.direction === 'sada';
  const clients = (state.partners || []).filter(pt => pt.type === 'client');
  const thicknesses = getSortedThicknesses();
  const grades = state.catalog?.grades || [];
  const presetDims = getPresetVeneerDimensions();
  const curLen = Number(ctx.lengthCm || 250);
  const curWid = Number(ctx.widthCm || 125);
  const curDimKey = `${curLen}x${curWid}`;

  modalRoot.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal-box" style="max-width:780px;">
        <div class="card-header">
          <div>
            <div class="card-title">
              🪵 حركة كميات المخزن: تخانة (${ctx.thkMm} مم — <span style="color:${isSada ? '#0284c7' : '#d97706'};">${ctx.directionLabel}</span>) × جودة (${ctx.gradeName})
            </div>
            <small style="color:var(--text-muted);">
              المقاس المعتمد: 125 × 250 سم (مع دعم المقاسات والتخانات الخاصة للشركات) | الرصيد المتاح بالخلية: <strong>${fmtNum(ctx.currentSheets, 0)} قطعة (${fmtNum(ctx.currentM3, 4)} م³)</strong>
              ${canSeeFinancialPrices() ? `| سعر القطعة: <strong>${fmtNum(ctx.unitPiecePrice, 2)} ج.م</strong>` : ''}
            </small>
          </div>
          <button class="btn btn-sm btn-outline" onclick="closeModal()">✕</button>
        </div>

        <!-- Operation Selector Tabs (إضافة كميات إنتاج | إضافة مرتجع مبيعات | خروج حسب المبيعات | خروج لإعادة التشغيل) -->
        <div class="tabs-bar" style="margin-bottom:14px;">
          <button type="button" class="tab-btn ${ctx.op === 'in' ? 'active' : ''}" onclick="activeCellContext.op='in'; renderMatrixCellModalUI('${selectedWoodId}', ${defaultSheets});">
            📥 إضافة كميات إنتاج
          </button>
          <button type="button" class="tab-btn ${ctx.op === 'sales_return' ? 'active' : ''}" onclick="activeCellContext.op='sales_return'; renderMatrixCellModalUI('${selectedWoodId}', ${defaultSheets});">
            🔄 إضافة مرتجع مبيعات
          </button>
          <button type="button" class="tab-btn ${ctx.op === 'out' ? 'active' : ''}" onclick="activeCellContext.op='out'; renderMatrixCellModalUI('${selectedWoodId}', ${defaultSheets});">
            📤 خروج حسب المبيعات
          </button>
          <button type="button" class="tab-btn ${ctx.op === 'rework' ? 'active' : ''}" onclick="activeCellContext.op='rework'; renderMatrixCellModalUI('${selectedWoodId}', ${defaultSheets});">
            ♻️ خروج لإعادة التشغيل
          </button>
          ${isFullAdmin(currentUser) ? `
            <button type="button" class="tab-btn ${ctx.op === 'set' ? 'active' : ''}" onclick="activeCellContext.op='set'; renderMatrixCellModalUI('${selectedWoodId}', ${ctx.currentSheets});">
              ✏️ تعديل رصيد مباشر
            </button>
          ` : ''}
        </div>

        ${ctx.op === 'sales_return' ? `
          <div style="background:rgba(124,58,237,0.1);border:2px solid #7c3aed;padding:12px 16px;border-radius:10px;margin-bottom:14px;font-size:0.86rem;">
            🔄 <strong style="color:#6d28d9;">قاعدة إضافة مرتجع المبيعات للمخزن:</strong><br/>
            عند تسجيل مرتجع مبيعات، <strong>يدخل المرتجع المخزن مرة أخرى بعد موافقة (المدير التنفيذي أو مدير المشروعات أو المحاسب فقط)</strong>.
          </div>
        ` : ''}

        <form onsubmit="submitMatrixCellOperation(event)">
          <div class="form-grid">
            <div class="form-group">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:3px;">
                <label style="font-weight:800;margin:0;">التخانة والاتجاه (قص / سدا)</label>
                <button type="button" class="btn btn-sm btn-outline" style="padding:1px 6px;font-size:0.68rem;" onclick="const b=document.getElementById('cell-custom-thk-box'); b.style.display=b.style.display==='none'?'flex':'none';">
                  ➕ تخانة محددة جديدة
                </button>
              </div>
              <select id="cell-select-thk" class="form-control" style="font-weight:800;" onchange="switchMatrixModalCell(this.value, '${ctx.gradeId}')">
                ${thicknesses.map(t => `<option value="${t.id}" ${t.id === ctx.thkId ? 'selected' : ''}>${t.mm} مم — ${t.direction === 'sada' ? '📏 اتجاه سدا' : '✂️ اتجاه قص'}</option>`).join('')}
              </select>
              <div id="cell-custom-thk-box" style="display:none;gap:5px;margin-top:5px;background:rgba(124,58,237,0.08);padding:6px;border-radius:8px;border:1px dashed #7c3aed;">
                <input id="cell-custom-thk-mm" type="number" step="0.05" min="0.1" class="form-control" placeholder="التخانة المحددة (مم)" oninput="updateMatrixCellModalPreview()" />
                <select id="cell-custom-thk-dir" class="form-control" style="max-width:120px;" onchange="updateMatrixCellModalPreview()">
                  <option value="qas" ${ctx.direction !== 'sada' ? 'selected' : ''}>✂️ قص</option>
                  <option value="sada" ${ctx.direction === 'sada' ? 'selected' : ''}>📏 سدا</option>
                </select>
              </div>
            </div>

            <div class="form-group">
              <label style="font-weight:800;">درجة الجودة</label>
              <select id="cell-select-grade" class="form-control" style="font-weight:800;" onchange="switchMatrixModalCell('${ctx.thkId}', this.value)">
                ${grades.map(g => `<option value="${g.id}" ${g.id === ctx.gradeId ? 'selected' : ''}>${g.name} (${g.code})</option>`).join('')}
              </select>
            </div>

            <!-- Dimension Selector (Standard 125x250 cm or Custom Company Dimension) -->
            <div class="form-group" style="grid-column: span 2;background:rgba(15,118,110,0.06);padding:8px 12px;border-radius:10px;border:1px solid rgba(15,118,110,0.25);">
              <label style="color:var(--primary);font-weight:800;">📐 مقاس القشرة (المقاس المعتمد 125 سم × 250 سم أو مقاس مختلف للشركات)</label>
              <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:4px;">
                <select id="cell-dim-preset" class="form-control" style="max-width:270px;font-weight:800;" onchange="if(this.value!=='custom'){const [l,w]=this.value.split('x').map(Number);document.getElementById('cell-wid').value=w;document.getElementById('cell-len').value=l;activeCellContext.lengthCm=l;activeCellContext.widthCm=w;updateMatrixCellModalPreview();}">
                  ${presetDims.map(d => `<option value="${d.lengthCm}x${d.widthCm}" ${`${d.lengthCm}x${d.widthCm}` === curDimKey ? 'selected' : ''}>${d.label}</option>`).join('')}
                  <option value="custom">✏️ كتابة مقاس خاص آخر للشركة (العرض × الطول)...</option>
                </select>
                <div style="display:flex;align-items:center;gap:4px;">
                  <span style="font-size:0.75rem;font-weight:700;">العرض (سم):</span>
                  <input id="cell-wid" type="number" step="0.5" min="10" class="form-control" style="width:78px;font-weight:800;" value="${curWid}" oninput="document.getElementById('cell-dim-preset').value='custom'; activeCellContext.widthCm=Number(this.value||125); updateMatrixCellModalPreview();" required />
                </div>
                <span style="font-weight:900;">×</span>
                <div style="display:flex;align-items:center;gap:4px;">
                  <span style="font-size:0.75rem;font-weight:700;">الطول (سم):</span>
                  <input id="cell-len" type="number" step="0.5" min="10" class="form-control" style="width:78px;font-weight:800;" value="${curLen}" oninput="document.getElementById('cell-dim-preset').value='custom'; activeCellContext.lengthCm=Number(this.value||250); updateMatrixCellModalPreview();" required />
                </div>
              </div>
            </div>

            <div class="form-group">
              <label style="color:var(--primary);font-weight:800;">📅 تاريخ الحركة</label>
              <input id="cell-date" type="date" class="form-control" value="${ctx.opDate || todayStr()}" onchange="activeCellContext.opDate=this.value" required style="border-color:var(--primary);font-weight:700;" />
            </div>

            <div class="form-group">
              <label>نوع الخشب</label>
              <select id="cell-wood" class="form-control" required>
                ${state.catalog.woodTypes.length === 0 ? `<option value="wt-general">قشرة خشبية عامة (125×250)</option>` : ''}
                ${state.catalog.woodTypes.map(w => `<option value="${w.id}" ${w.id === selectedWoodId ? 'selected' : ''}>${w.name}</option>`).join('')}
              </select>
            </div>

            <div class="form-group">
              <label style="font-weight:800;">
                ${ctx.op === 'in' ? '📥 كمية الإنتاج الواردة للمخزن (عدد القطع / الأفرخ)' :
                  ctx.op === 'sales_return' ? '🔄 كمية مرتجع المبيعات المطلوبة للإرجاع للمخزن (عدد القطع)' :
                  ctx.op === 'out' ? '📤 الكمية الخارجة حسب المبيعات (عدد القطع)' :
                  ctx.op === 'rework' ? '♻️ الكمية الخارجة لإعادة التشغيل (عدد القطع)' :
                  'الرصيد الفعلي الجديد للخلية (عدد القطع)'}
              </label>
              <input id="cell-sheets" type="number" min="0" class="form-control" value="${ctx.op === 'set' ? ctx.currentSheets : Math.min(defaultSheets, (ctx.op === 'in' || ctx.op === 'sales_return') ? defaultSheets : (ctx.currentSheets || defaultSheets))}" oninput="updateMatrixCellModalPreview()" required />
            </div>

            ${canSeeFinancialPrices() ? `
            <div class="form-group">
              <label>💰 سعر القطعة الواحدة (الفرخ) بالجنيه</label>
              <input id="cell-unit-price" type="number" step="0.5" min="0" class="form-control" value="${ctx.unitPiecePrice || 0}" oninput="updateMatrixCellModalPreview()" required style="font-weight:800;border-color:var(--accent);" />
            </div>
            ` : `<input id="cell-unit-price" type="hidden" value="${ctx.unitPiecePrice || 0}" />`}

            <div class="form-group">
              <label>أو إدخال بالحجم (م³) ليحسب القطع تلقائياً</label>
              <input id="cell-m3-input" type="number" step="0.0001" class="form-control" placeholder="اكتب الـ م³ للتحويل..." oninput="syncSheetsFromM3Input(this.value)" />
            </div>

            ${(ctx.op === 'out' || ctx.op === 'sales_return') ? `
              <div class="form-group">
                <label>${ctx.op === 'sales_return' ? 'اسم العميل صاحب المرتجع' : 'اسم العميل / المبيعات'}</label>
                <input id="cell-client-name" class="form-control" list="clients-datalist" placeholder="اكتب اسم العميل أو اختره..." value="${clients[0]?.name || 'عميل مبيعات قشرة'}" required />
                <datalist id="clients-datalist">
                  ${clients.map(c => `<option value="${c.name}"></option>`).join('')}
                </datalist>
              </div>
            ` : `
              <div class="form-group">
                <label>عدد البالتات المعادلة</label>
                <input id="cell-pallets-count" type="number" min="1" class="form-control" value="1" />
              </div>
            `}
          </div>

          ${ctx.op === 'rework' ? `
            <div class="card" style="margin-top:14px;background:var(--bg-elevated);padding:14px;">
              <div style="font-weight:800;margin-bottom:10px;color:var(--primary);">♻️ تفاصيل ناتج إعادة التشغيل (تحويل لخلية أخرى / مقاس جديد / هالك):</div>
              <div class="form-grid">
                <div class="form-group">
                  <label>التخانة والاتجاه الجديد بعد إعادة التشغيل</label>
                  <select id="rework-target-thk" class="form-control">
                    ${state.catalog.thicknesses.map(t => `<option value="${t.id}" ${t.id === ctx.thkId ? 'selected' : ''}>${t.mm} مم — ${t.direction === 'sada' ? 'اتجاه سدا' : 'اتجاه قص'} (${t.label})</option>`).join('')}
                  </select>
                </div>
                <div class="form-group">
                  <label>درجة الجودة الجديدة بعد الفرز/التشغيل</label>
                  <select id="rework-target-grade" class="form-control">
                    ${state.catalog.grades.map(g => `<option value="${g.id}" ${g.id === ctx.gradeId ? 'selected' : ''}>${g.name}</option>`).join('')}
                  </select>
                </div>
                <div class="form-group">
                  <label>عدد القطع الصافية السليمة بعد التشغيل</label>
                  <input id="rework-good-sheets" type="number" min="0" class="form-control" value="${Math.floor((ctx.currentSheets || defaultSheets) * 0.9)}" oninput="updateMatrixCellModalPreview()" />
                </div>
              </div>
              <small style="display:block;margin-top:6px;color:var(--text-muted);">
                * الفرق بين الكمية المسحوبة والقطع السليمة الناتجة يتم ترحيله تلقائياً إلى <strong>مخزن الهالك والقصاقيص</strong>.
              </small>
            </div>
          ` : ''}

          <div class="form-group" style="margin-top:12px;">
            <label>البيان / الملاحظات (رقم التشغيلة أو اسم الشركة صاحبة المقاس أو سبب المرتجع)</label>
            <input id="cell-notes" class="form-control" placeholder="${
              ctx.op === 'in' ? 'مثال: إضافة كميات إنتاج جديدة للمخزن...' :
              ctx.op === 'sales_return' ? 'مثال: مرتجع مبيعات من عميل بانتظار موافقة الإدارة/الحسابات...' :
              ctx.op === 'out' ? 'مثال: خروج كميات على حسب المبيعات...' :
              ctx.op === 'rework' ? 'مثال: خروج كميات لإعادة التشغيل والفرز...' :
              'مثال: إثبات رصيد مخزني...'
            }" />
          </div>

          <div id="cell-live-preview" class="calc-preview-box"></div>

          <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px;">
            <button type="button" class="btn btn-outline" onclick="closeModal()">إلغاء</button>
            <button type="submit" class="btn btn-primary" style="${ctx.op === 'sales_return' ? 'background:#7c3aed;' : ''}">
              ${ctx.op === 'in' ? '📥 تأكيد إضافة كميات الإنتاج للمخزن' :
                ctx.op === 'sales_return' ? '🔄 تسجيل مرتجع المبيعات وإرساله للموافقة (التنفيذي / المشروعات / المحاسب)' :
                ctx.op === 'out' ? '📤 تأكيد خروج الكميات حسب المبيعات' :
                ctx.op === 'rework' ? '♻️ تأكيد خروج الكميات لإعادة التشغيل' :
                '✏️ حفظ الرصيد الفعلي الجديد'}
            </button>
          </div>
        </form>
      </div>
    </div>
  `;
  updateMatrixCellModalPreview();
}

function getEffectiveCellModalThicknessAndDimensions() {
  if (!activeCellContext) return { len: 250, wid: 125, thkMm: 1.5, thkDir: 'qas', useCustomThk: false };
  const len = Math.max(10, Number(document.getElementById('cell-len')?.value || activeCellContext.lengthCm || 250));
  const wid = Math.max(10, Number(document.getElementById('cell-wid')?.value || activeCellContext.widthCm || 125));
  const customBox = document.getElementById('cell-custom-thk-box');
  const customMmVal = Number(document.getElementById('cell-custom-thk-mm')?.value || 0);
  const useCustomThk = Boolean(customBox && customBox.style.display !== 'none' && customMmVal > 0);
  const thkMm = useCustomThk ? customMmVal : Number(activeCellContext.thkMm || 1.5);
  const thkDir = useCustomThk ? (document.getElementById('cell-custom-thk-dir')?.value || activeCellContext.direction || 'qas') : (activeCellContext.direction || 'qas');
  return { len, wid, thkMm, thkDir, useCustomThk };
}

function syncSheetsFromM3Input(m3Val) {
  if (!activeCellContext) return;
  const vol = Number(m3Val || 0);
  const { len, wid, thkMm } = getEffectiveCellModalThicknessAndDimensions();
  const sheetVol = (len / 100) * (wid / 100) * (thkMm / 1000);
  const sheets = sheetVol > 0 ? Math.round(vol / sheetVol) : 0;
  const sheetsInput = document.getElementById('cell-sheets');
  if (sheetsInput) {
    sheetsInput.value = sheets;
    updateMatrixCellModalPreview(false);
  }
}

function updateMatrixCellModalPreview(updateM3Box = true) {
  if (!activeCellContext) return;
  const ctx = activeCellContext;
  const { len, wid, thkMm } = getEffectiveCellModalThicknessAndDimensions();
  const sheets = Number(document.getElementById('cell-sheets')?.value || 0);
  const unitPrice = Number(document.getElementById('cell-unit-price')?.value || 0);
  const m = calculateVeneerMetrics(len, wid, thkMm, sheets);
  if (updateM3Box) {
    const m3Input = document.getElementById('cell-m3-input');
    if (m3Input) m3Input.value = m.totalVolumeM3;
  }

  let afterSheets = ctx.currentSheets;
  if (ctx.op === 'in' || ctx.op === 'sales_return') afterSheets = ctx.currentSheets + sheets;
  else if (ctx.op === 'out' || ctx.op === 'rework') afterSheets = Math.max(0, ctx.currentSheets - sheets);
  else if (ctx.op === 'set') afterSheets = sheets;

  const afterM = calculateVeneerMetrics(len, wid, thkMm, afterSheets);
  const totalOperationMoney = +(sheets * unitPrice).toFixed(2);
  const afterStockMoney = +(afterSheets * unitPrice).toFixed(2);

  const previewEl = document.getElementById('cell-live-preview');
  if (previewEl) {
    previewEl.innerHTML = `
      <div class="calc-preview-item">
        <span>كمية الحركة (${formatVeneerDimensions(len, wid, true)})</span>
        <strong>${fmtNum(sheets, 0)} قطعة (${fmtNum(m.totalAreaM2, 2)} م² | ${fmtNum(m.totalVolumeM3, 4)} م³)</strong>
      </div>
      ${canSeeFinancialPrices() ? `
      <div class="calc-preview-item">
        <span>إجمالي قيمة الحركة بسعر القطعة (${fmtNum(unitPrice, 2)} ج)</span>
        <strong style="color:var(--success);font-size:1.05rem;">${fmtMoney(totalOperationMoney)}</strong>
      </div>
      ` : ''}
      <div class="calc-preview-item">
        <span>${ctx.op === 'sales_return' ? 'رصيد الخلية بعد موافقة الإدارة/المحاسب' : 'رصيد الخلية بعد العملية'}</span>
        <strong style="color:var(--accent);">${fmtNum(afterSheets, 0)} قطعة (${fmtNum(afterM.totalVolumeM3, 4)} م³)</strong>
      </div>
      ${canSeeFinancialPrices() ? `
      <div class="calc-preview-item">
        <span>قيمة الرصيد المتبقي بالخلية</span>
        <strong style="color:var(--primary);">${fmtMoney(afterStockMoney)}</strong>
      </div>
      ` : ''}
    `;
  }
}

function deductSheetsFromCellPallets(thkId, gradeId, woodId, sheetsToDeduct, unitPrice = 0, targetLenCm = 0, targetWidCm = 0) {
  let remaining = Number(sheetsToDeduct);
  const thkObj = state.catalog.thicknesses.find(t => t.id === thkId) || { id: thkId, mm: activeCellContext?.thkMm || 1.5, direction: activeCellContext?.direction || 'qas' };
  const candidates = (state.pallets || []).filter(p =>
    p.status === 'in_stock' &&
    matchPalletToThicknessRow(p, thkObj) &&
    matchPalletToGrade(p, gradeId)
  );

  // Prefer pallets matching requested dimension (if custom dimension specified) and wood type
  candidates.sort((a, b) => {
    if (targetLenCm > 0 && targetWidCm > 0) {
      const aMatchDim = (Number(a.lengthCm || 250) === Number(targetLenCm) && Number(a.widthCm || 125) === Number(targetWidCm)) ||
                        (Number(a.lengthCm || 250) === Number(targetWidCm) && Number(a.widthCm || 125) === Number(targetLenCm));
      const bMatchDim = (Number(b.lengthCm || 250) === Number(targetLenCm) && Number(b.widthCm || 125) === Number(targetWidCm)) ||
                        (Number(b.lengthCm || 250) === Number(targetWidCm) && Number(b.widthCm || 125) === Number(targetLenCm));
      if (aMatchDim !== bMatchDim) return aMatchDim ? -1 : 1;
    }
    return (a.woodTypeId === woodId ? -1 : 1);
  });

  for (const p of candidates) {
    if (remaining <= 0) break;
    const pSheets = Number(p.sheetsCount || 0);
    const effectiveUnitPrice = unitPrice > 0 ? unitPrice : Number(p.unitSheetPrice || getCellUnitPrice(thkId, gradeId) || 0);
    const monoNow = getMonotonicIso(p.updatedAt);
    if (pSheets <= remaining) {
      remaining -= pSheets;
      p.sheetsCount = 0;
      p.areaM2 = 0;
      p.volumeM3 = 0;
      p.totalValue = 0;
      p.status = 'dispatched';
      p.updatedAt = monoNow;
    } else {
      const newSheets = pSheets - remaining;
      remaining = 0;
      const newM = calculateVeneerMetrics(p.lengthCm || 250, p.widthCm || 125, p.thicknessMm, newSheets);
      p.sheetsCount = newSheets;
      p.areaM2 = newM.totalAreaM2;
      p.volumeM3 = newM.totalVolumeM3;
      p.unitSheetPrice = effectiveUnitPrice;
      p.totalValue = effectiveUnitPrice > 0
        ? +(newSheets * effectiveUnitPrice).toFixed(2)
        : +(newM.totalVolumeM3 * Number(p.unitPricePerM3 || 20000)).toFixed(2);
      p.updatedAt = monoNow;
    }
  }
}

function addSheetsToCellPallets(thkId, gradeId, woodId, sheetsToAdd, notes = '', opDate = todayStr(), unitPrice = 0, lengthCm = 250, widthCm = 125) {
  if (sheetsToAdd <= 0) return;
  const len = Number(lengthCm || 250);
  const wid = Number(widthCm || 125);
  const thkObj = state.catalog.thicknesses.find(t => t.id === thkId) || {
    id: thkId,
    mm: activeCellContext?.thkMm || 1.5,
    direction: activeCellContext?.direction || 'qas',
    directionLabel: activeCellContext?.directionLabel || 'اتجاه قص'
  };
  const woodObj = state.catalog.woodTypes.find(w => w.id === woodId) || state.catalog.woodTypes[0] || { id: 'wt-general', name: 'قشرة خشبية' };
  const gradeObj = state.catalog.grades.find(g => g.id === gradeId || g.code === gradeId || g.name === gradeId) || state.catalog.grades[0] || { id: gradeId, code: 'A', name: 'عام', defaultPricePerM3: 20000 };
  const m = calculateVeneerMetrics(len, wid, thkObj.mm, sheetsToAdd);
  const now = new Date().toISOString();
  const code = `PLT-2026-00${(state.pallets?.length || 0) + 1}`;
  const effectiveUnitPrice = unitPrice > 0 ? unitPrice : getCellUnitPrice(thkId, gradeId);
  const totalVal = effectiveUnitPrice > 0
    ? +(sheetsToAdd * effectiveUnitPrice).toFixed(2)
    : +(m.totalVolumeM3 * (gradeObj.defaultPricePerM3 || 20000)).toFixed(2);

  if (!isStandardVeneerDimension(len, wid)) {
    ensureCustomDimensionInCatalog(len, wid, notes);
  }

  state.pallets.unshift({
    id: uid('plt'),
    palletCode: code,
    woodTypeId: woodObj.id,
    woodTypeName: woodObj.name,
    lengthCm: len,
    widthCm: wid,
    thicknessId: thkObj.id,
    thicknessMm: Number(thkObj.mm),
    direction: thkObj.direction || 'qas',
    directionLabel: thkObj.direction === 'sada' ? 'اتجاه سدا' : 'اتجاه قص',
    gradeId: gradeObj.id,
    gradeCode: gradeObj.code,
    gradeName: gradeObj.name,
    sheetsCount: Number(sheetsToAdd),
    areaM2: m.totalAreaM2,
    volumeM3: m.totalVolumeM3,
    unitSheetPrice: effectiveUnitPrice,
    unitPricePerM3: m.totalVolumeM3 > 0 ? +(totalVal / m.totalVolumeM3).toFixed(2) : (gradeObj.defaultPricePerM3 || 20000),
    totalValue: totalVal,
    batchNumber: notes || 'MATRIX-OP',
    status: 'in_stock',
    location: 'مخزن القشرة التامة',
    entryDate: opDate,
    createdBy: currentUser.name,
    createdAt: opDate,
    updatedAt: now
  });
}

function submitMatrixCellOperation(e) {
  e.preventDefault();
  if (!activeCellContext) return;
  const ctx = activeCellContext;
  const opDate = document.getElementById('cell-date')?.value || todayStr();
  const woodId = document.getElementById('cell-wood').value;
  const woodObj = state.catalog.woodTypes.find(w => w.id === woodId) || state.catalog.woodTypes[0] || { id: 'wt-general', name: 'قشرة خشبية' };
  const sheets = Number(document.getElementById('cell-sheets').value || 0);
  const unitPrice = Math.max(0, Number(document.getElementById('cell-unit-price')?.value || ctx.unitPiecePrice || 0));
  const notes = document.getElementById('cell-notes').value.trim();
  const now = new Date().toISOString();

  const { len, wid, thkMm, thkDir, useCustomThk } = getEffectiveCellModalThicknessAndDimensions();
  if (useCustomThk) {
    const ensured = ensureCatalogThicknessExists(thkMm, thkDir, unitPrice, ctx.gradeId);
    if (ensured) {
      ctx.thkId = ensured.id;
      ctx.thkMm = Number(ensured.mm);
      ctx.direction = ensured.direction || 'qas';
      ctx.directionLabel = ensured.directionLabel;
    }
  }
  ctx.lengthCm = len;
  ctx.widthCm = wid;
  if (!isStandardVeneerDimension(len, wid)) {
    ensureCustomDimensionInCatalog(len, wid, notes);
  }

  const m = calculateVeneerMetrics(len, wid, ctx.thkMm, sheets);
  const cellKey = getCellPriceKey(ctx.thkId, ctx.gradeId);
  const dimLabel = formatVeneerDimensions(len, wid, true);

  // Persist unit piece price in the mirror table automatically if user has financial permission
  if (unitPrice > 0 && canSeeFinancialPrices()) {
    state.catalog.cellPrices = state.catalog.cellPrices || {};
    state.catalog.cellPrices[cellKey] = unitPrice;
  }

  const totalAmount = +(sheets * unitPrice).toFixed(2);

  // 1) PRODUCTION IN (إضافة كميات إنتاج)
  if (ctx.op === 'in') {
    if (sheets <= 0) {
      alert('يرجى إدخال عدد قطع أكبر من صفر!');
      return;
    }
    addSheetsToCellPallets(ctx.thkId, ctx.gradeId, woodId, sheets, notes || 'إضافة كميات إنتاج', opDate, unitPrice, len, wid);
    state.warehouseMovements.unshift({
      id: uid('mov'),
      voucherNumber: `IN-${Date.now().toString().slice(-5)}`,
      date: opDate,
      warehouseType: 'finished_veneers',
      warehouseLabel: 'مخزن القشرة التامة (إضافة كميات إنتاج)',
      direction: 'in',
      directionLabel: 'إضافة كميات إنتاج',
      movementCategory: 'production_in',
      cellKey,
      lengthCm: len,
      widthCm: wid,
      sheetsCount: sheets,
      unitSheetPrice: unitPrice,
      totalSaleAmount: totalAmount,
      itemSummary: `إضافة كميات إنتاج قشرة ${woodObj.name} — مقاس (${dimLabel}) — تخانة ${ctx.thkMm} مم (${ctx.directionLabel}) × ${ctx.gradeName} (${notes || 'إنتاج جديد'})`,
      referenceCode: `${ctx.thkMm}mm-${ctx.direction}-${ctx.gradeCode}`,
      quantitySummary: `${sheets} قطعة (${formatVeneerDimensions(len, wid, false)}) | ${m.totalVolumeM3} م³`,
      performedBy: currentUser.name,
      approvedBy: currentUser.name,
      updatedAt: now
    });
    closeModal();
    saveState(`📥 إضافة كميات إنتاج (${sheets} قطعة — مقاس ${dimLabel} — ${m.totalVolumeM3} م³) بتاريخ ${opDate} لخلية تخانة ${ctx.thkMm} مم (${ctx.directionLabel}) × ${ctx.gradeName}`);
    return;
  }

  // 2) SALES RETURN (إضافة مرتجع مبيعات — لا يدخل المخزن إلا بعد موافقة المدير التنفيذي أو مدير المشروعات أو المحاسب فقط)
  if (ctx.op === 'sales_return') {
    if (sheets <= 0) {
      alert('يرجى إدخال كمية مرتجع المبيعات (عدد القطع أكبر من صفر)!');
      return;
    }
    const clientName = (document.getElementById('cell-client-name')?.value || 'عميل مبيعات').trim();
    const retNum = `RET-${Date.now().toString().slice(-5)}`;
    const newRet = {
      id: uid('sret'),
      returnNumber: retNum,
      date: opDate,
      clientName,
      woodTypeId: woodObj.id,
      woodTypeName: woodObj.name,
      lengthCm: len,
      widthCm: wid,
      thkId: ctx.thkId,
      thkMm: ctx.thkMm,
      direction: ctx.direction,
      directionLabel: ctx.directionLabel,
      gradeId: ctx.gradeId,
      gradeCode: ctx.gradeCode,
      gradeName: ctx.gradeName,
      sheetsCount: sheets,
      areaM2: m.totalAreaM2,
      volumeM3: m.totalVolumeM3,
      unitPrice,
      totalReturnAmount: totalAmount,
      notes: notes || 'مرتجع مبيعات من عميل',
      status: 'pending_approval',
      requestedBy: currentUser.name,
      requestedByRole: currentUser.roleKey,
      approvedBy: '',
      approvedAt: '',
      createdAt: now,
      updatedAt: now
    };

    state.salesReturns = state.salesReturns || [];
    state.salesReturns.unshift(newRet);
    markNotifIdsSeen([`sret_pend_${newRet.id}`]);

    closeModal();
    saveState(
      `🔄 تسجيل طلب مرتجع مبيعات رقم (${retNum}) من العميل (${clientName}) بكمية (${sheets} قطعة — مقاس ${dimLabel} — تخانة ${ctx.thkMm} مم ${ctx.directionLabel} × ${ctx.gradeName}) — بانتظار موافقة (المدير التنفيذي أو مدير المشروعات أو المحاسب فقط) ليدخل المخزن مرة أخرى`
    );
    return;
  }

  // 3) SALES OUT (خروج الكميات على حسب المبيعات)
  if (ctx.op === 'out') {
    if (sheets <= 0 || sheets > ctx.currentSheets) {
      alert(`الكمية المطلوبة للخروج (${sheets} قطعة) أكبر من الرصيد المتاح في الخلية (${ctx.currentSheets} قطعة)!`);
      return;
    }
    const clientName = (document.getElementById('cell-client-name')?.value || 'عميل مبيعات قشرة').trim();
    deductSheetsFromCellPallets(ctx.thkId, ctx.gradeId, woodId, sheets, unitPrice, len, wid);

    const voucherNo = `OUT-${Date.now().toString().slice(-5)}`;
    state.warehouseMovements.unshift({
      id: uid('mov'),
      voucherNumber: voucherNo,
      date: opDate,
      warehouseType: 'finished_veneers',
      warehouseLabel: 'مخزن القشرة التامة (خروج حسب المبيعات)',
      direction: 'out',
      directionLabel: 'خروج حسب المبيعات',
      movementCategory: 'sales_exit',
      cellKey,
      lengthCm: len,
      widthCm: wid,
      sheetsCount: sheets,
      unitSheetPrice: unitPrice,
      totalSaleAmount: totalAmount,
      itemSummary: `خروج كميات حسب المبيعات — قشرة ${woodObj.name} مقاس (${dimLabel}) تخانة ${ctx.thkMm} مم (${ctx.directionLabel}) × ${ctx.gradeName} للعميل (${clientName}) ${notes ? '— ' + notes : ''}`,
      referenceCode: `${ctx.thkMm}mm-${ctx.direction}-${ctx.gradeCode}`,
      quantitySummary: `${sheets} قطعة (${formatVeneerDimensions(len, wid, false)}) | ${m.totalVolumeM3} م³`,
      performedBy: currentUser.name,
      approvedBy: currentUser.name,
      updatedAt: now
    });

    // Immediately reflect in Financial Transactions & Treasury so accounting users see updated balances right away
    if (totalAmount > 0) {
      state.financialTransactions.unshift({
        id: uid('fin'),
        voucherNo: `INV-${voucherNo}`,
        date: opDate,
        type: 'sales_invoice',
        typeLabel: 'فاتورة مبيعات قشرة من المخزن',
        partnerName: clientName,
        description: `بيع ${sheets} قطعة قشرة مقاس (${dimLabel}) (${ctx.thkMm} مم ${ctx.directionLabel} - جودة ${ctx.gradeName}) بسعر ${unitPrice} ج للقطعة ${notes ? '— ' + notes : ''}`,
        totalAmount,
        paidAmount: totalAmount,
        remainingAmount: 0,
        paymentMethod: 'خزينة المبيعات',
        createdBy: currentUser.name,
        approvedBy: currentUser.name,
        updatedAt: now
      });
      state.treasuryBalances.cashVault = Number(state.treasuryBalances.cashVault || 0) + totalAmount;
    }

    closeModal();
    saveState(`📤 خروج كميات حسب المبيعات (${sheets} قطعة — مقاس ${dimLabel} — ${m.totalVolumeM3} م³) من خلية (${ctx.thkMm} مم ${ctx.directionLabel} × ${ctx.gradeName}) للعميل (${clientName}) بتاريخ ${opDate}`);
    return;
  }

  // 4) REWORK OUT (خروج الكميات لإعادة التشغيل)
  if (ctx.op === 'rework') {
    if (sheets <= 0 || sheets > ctx.currentSheets) {
      alert(`الكمية المطلوبة لإعادة التشغيل (${sheets} قطعة) أكبر من الرصيد المتاح في الخلية (${ctx.currentSheets} قطعة)!`);
      return;
    }
    const targetThkId = document.getElementById('rework-target-thk').value || ctx.thkId;
    const targetThkObj = state.catalog.thicknesses.find(t => t.id === targetThkId) || { id: targetThkId, mm: ctx.thkMm, direction: ctx.direction };
    const targetGradeId = document.getElementById('rework-target-grade').value || ctx.gradeId;
    const goodSheets = Number(document.getElementById('rework-good-sheets').value || 0);
    const targetGradeObj = state.catalog.grades.find(g => g.id === targetGradeId) || state.catalog.grades[0] || { id: targetGradeId, code: 'A', name: 'عام' };

    // 1. Deduct from source cell
    deductSheetsFromCellPallets(ctx.thkId, ctx.gradeId, woodId, sheets, unitPrice, len, wid);

    // 2. Add good output sheets to target cell
    if (goodSheets > 0) {
      const targetUnitPrice = getCellUnitPrice(targetThkObj.id, targetGradeId) || unitPrice;
      addSheetsToCellPallets(targetThkObj.id, targetGradeId, woodId, goodSheets, `ناتج إعادة تشغيل (${notes || ''})`, opDate, targetUnitPrice, len, wid);
    }

    // 3. Calculate scrap/waste difference and add to Scrap Warehouse
    const scrapSheets = Math.max(0, sheets - goodSheets);
    const scrapMetrics = calculateVeneerMetrics(len, wid, ctx.thkMm, scrapSheets);
    if (scrapMetrics.totalVolumeM3 > 0 && state.scrapItems?.length > 0) {
      state.scrapItems[0].quantity = +(Number(state.scrapItems[0].quantity) + scrapMetrics.totalVolumeM3).toFixed(3);
      state.scrapItems[0].updatedAt = now;
    }

    state.warehouseMovements.unshift({
      id: uid('mov'),
      voucherNumber: `RWK-${Date.now().toString().slice(-5)}`,
      date: opDate,
      warehouseType: 'finished_veneers',
      warehouseLabel: 'مخزن القشرة التامة (خروج لإعادة التشغيل)',
      direction: 'out',
      directionLabel: 'خروج لإعادة التشغيل',
      movementCategory: 'rework',
      cellKey,
      lengthCm: len,
      widthCm: wid,
      sheetsCount: sheets,
      unitSheetPrice: unitPrice,
      totalSaleAmount: 0,
      itemSummary: `خروج لإعادة التشغيل: سحب ${sheets} قطعة مقاس (${dimLabel}) (${ctx.thkMm}مم ${ctx.directionLabel}) ⬅ ناتج سليم ${goodSheets} قطعة (${targetThkObj.mm}مم ${targetGradeObj.code}) + هالك ${scrapMetrics.totalVolumeM3} م³`,
      referenceCode: `REWORK-${ctx.thkMm}mm`,
      quantitySummary: `${sheets} قطعة (${formatVeneerDimensions(len, wid, false)}) (${m.totalVolumeM3} م³)`,
      performedBy: currentUser.name,
      approvedBy: currentUser.name,
      updatedAt: now
    });

    closeModal();
    saveState(`♻️ خروج كميات لإعادة التشغيل (${sheets} قطعة — مقاس ${dimLabel}) بتاريخ ${opDate} من خلية (${ctx.thkMm} مم ${ctx.directionLabel} × ${ctx.gradeName})`);
    return;
  }

  // 5) DIRECT SET (تعديل الرصيد المباشر — للمدير التنفيذي ومدير المشروعات فقط)
  if (ctx.op === 'set') {
    if (!isFullAdmin(currentUser)) {
      alert('⛔ تعديل الرصيد المباشر مسموح فقط للمدير التنفيذي أو مدير المشروعات!');
      return;
    }
    const diff = sheets - ctx.currentSheets;
    if (diff > 0) {
      addSheetsToCellPallets(ctx.thkId, ctx.gradeId, woodId, diff, notes || 'تسوية رصيد / رصيد سابق', opDate, unitPrice, len, wid);
    } else if (diff < 0) {
      deductSheetsFromCellPallets(ctx.thkId, ctx.gradeId, woodId, Math.abs(diff), unitPrice, len, wid);
    }
    state.warehouseMovements.unshift({
      id: uid('mov'),
      voucherNumber: `ADJ-${Date.now().toString().slice(-5)}`,
      date: opDate,
      warehouseType: 'finished_veneers',
      warehouseLabel: 'تسوية / إثبات رصيد للخلية',
      direction: diff >= 0 ? 'in' : 'out',
      directionLabel: 'تعديل رصيد مباشر',
      movementCategory: 'adjustment',
      cellKey,
      lengthCm: len,
      widthCm: wid,
      sheetsCount: Math.abs(diff),
      unitSheetPrice: unitPrice,
      totalSaleAmount: +(Math.abs(diff) * unitPrice).toFixed(2),
      itemSummary: `تعديل/إثبات رصيد خلية (${ctx.thkMm} مم ${ctx.directionLabel} × ${ctx.gradeName}) مقاس (${dimLabel}) من ${ctx.currentSheets} قطعة إلى ${sheets} قطعة ${notes ? '— ' + notes : ''}`,
      referenceCode: `ADJ-${ctx.thkMm}mm-${ctx.direction}`,
      quantitySummary: `${sheets} قطعة (${formatVeneerDimensions(len, wid, false)}) | ${m.totalVolumeM3} م³`,
      performedBy: currentUser.name,
      approvedBy: currentUser.name,
      updatedAt: now
    });
    closeModal();
    saveState(`تعديل رصيد خلية (${ctx.thkMm} مم ${ctx.directionLabel} × ${ctx.gradeName}) مقاس (${dimLabel}) بتاريخ ${opDate} إلى ${sheets} قطعة`);
  }
}

// ============================================================================
// SALES RETURN APPROVAL WORKFLOW (الموافقة للمدير التنفيذي أو مدير المشروعات أو المحاسب فقط)
// ============================================================================
function approveSalesReturn(retId) {
  if (!canApproveSalesReturn(currentUser)) {
    alert('⛔ عفواً، الموافقة على دخول مرتجع المبيعات للمخزن مرة أخرى مسموحة فقط لـ (المدير التنفيذي أو مدير المشروعات أو المحاسب فقط)!');
    return;
  }

  const ret = (state.salesReturns || []).find(r => r.id === retId);
  if (!ret) return;
  if (ret.status === 'approved') {
    alert('تمت الموافقة على هذا المرتجع وإدخاله للمخزن بالفعل.');
    return;
  }

  const now = new Date().toISOString();
  const opDate = ret.date || todayStr();
  const unitPrice = Number(ret.unitPrice || getCellUnitPrice(ret.thkId, ret.gradeId) || 0);
  const totalReturnAmount = +(Number(ret.sheetsCount || 0) * unitPrice).toFixed(2);
  const cellKey = getCellPriceKey(ret.thkId, ret.gradeId);
  const retLen = Number(ret.lengthCm || 250);
  const retWid = Number(ret.widthCm || 125);
  const dimLabel = formatVeneerDimensions(retLen, retWid, true);

  // 1) Add returned quantity back into the warehouse stock cell!
  addSheetsToCellPallets(
    ret.thkId,
    ret.gradeId,
    ret.woodTypeId || 'wt-general',
    Number(ret.sheetsCount || 0),
    `مرتجع مبيعات معتمد (${ret.returnNumber}) — العميل: ${ret.clientName || ''}`,
    opDate,
    unitPrice,
    retLen,
    retWid
  );

  // 2) Record official warehouse movement (RET-...)
  state.warehouseMovements = state.warehouseMovements || [];
  state.warehouseMovements.unshift({
    id: uid('mov'),
    voucherNumber: ret.returnNumber || `RET-${Date.now().toString().slice(-5)}`,
    date: opDate,
    warehouseType: 'finished_veneers',
    warehouseLabel: 'مخزن القشرة التامة (دخول مرتجع مبيعات معتمد)',
    direction: 'in',
    directionLabel: 'دخول مرتجع مبيعات معتمد',
    movementCategory: 'sales_return_in',
    cellKey,
    lengthCm: retLen,
    widthCm: retWid,
    sheetsCount: Number(ret.sheetsCount || 0),
    unitSheetPrice: unitPrice,
    totalSaleAmount: totalReturnAmount,
    itemSummary: `دخول مرتجع مبيعات معتمد (${ret.returnNumber}) من العميل (${ret.clientName || 'عميل'}) — مقاس (${dimLabel}) تخانة ${ret.thkMm} مم (${ret.directionLabel || ''}) × ${ret.gradeName || ''} — بموافقة: ${currentUser.name}`,
    referenceCode: ret.returnNumber,
    quantitySummary: `${ret.sheetsCount} قطعة (${formatVeneerDimensions(retLen, retWid, false)}) | ${ret.volumeM3} م³`,
    performedBy: ret.requestedBy || currentUser.name,
    approvedBy: currentUser.name,
    updatedAt: now
  });

  // 3) Credit the client's account if totalReturnAmount > 0
  if (totalReturnAmount > 0) {
    state.financialTransactions = state.financialTransactions || [];
    state.financialTransactions.unshift({
      id: uid('fin'),
      voucherNo: `CRD-${ret.returnNumber}`,
      date: opDate,
      type: 'client_credit',
      typeLabel: 'إشعار دائن (مرتجع مبيعات معتمد)',
      partnerName: ret.clientName || 'عميل مبيعات',
      description: `مرتجع مبيعات معتمد رقم (${ret.returnNumber}) — ${ret.sheetsCount} قطعة (${ret.thkMm} مم ${ret.directionLabel || ''} × ${ret.gradeName || ''})`,
      totalAmount: totalReturnAmount,
      paidAmount: totalReturnAmount,
      remainingAmount: 0,
      paymentMethod: 'تسوية مرتجع مبيعات',
      createdBy: ret.requestedBy || currentUser.name,
      approvedBy: currentUser.name,
      updatedAt: now
    });
  }

  // 4) Update salesReturn status
  ret.status = 'approved';
  ret.approvedBy = currentUser.name;
  ret.approvedByRole = currentUser.roleTitle;
  ret.approvedAt = now;
  ret.updatedAt = now;

  markNotifIdsSeen([`sret_app_${ret.id}`]);
  saveState(
    `✅ موافقة (${currentUser.name} - ${currentUser.roleTitle}) على مرتجع المبيعات رقم (${ret.returnNumber}) للعميل (${ret.clientName}) — تم إدخال (${ret.sheetsCount} قطعة) إلى رصيد المخزن مرة أخرى`
  );
}

function rejectSalesReturn(retId) {
  if (!canApproveSalesReturn(currentUser)) {
    alert('⛔ عفواً، هذه الصلاحية للمدير التنفيذي أو مدير المشروعات أو المحاسب فقط!');
    return;
  }
  const ret = (state.salesReturns || []).find(r => r.id === retId);
  if (!ret) return;
  if (!confirm(`هل أنت متأكد من رفض طلب مرتجع المبيعات رقم (${ret.returnNumber}) وعدم إدخاله للمخزن؟`)) return;

  ret.status = 'rejected';
  ret.rejectedBy = currentUser.name;
  ret.updatedAt = new Date().toISOString();
  saveState(`❌ رفض طلب مرتجع المبيعات رقم (${ret.returnNumber}) بواسطة ${currentUser.name}`);
}

function deleteSalesReturnRecord(retId) {
  if (!isFullAdmin(currentUser)) {
    alert('⛔ الحذف متاح للمدير التنفيذي أو مدير المشروعات فقط.');
    return;
  }
  const ret = (state.salesReturns || []).find(r => r.id === retId);
  if (!ret) return;
  const wasApproved = ret.status === 'approved';
  const msg = wasApproved
    ? `⚠️ هذا المرتجع (${ret.returnNumber}) قد دخل المخزن بالفعل (${ret.sheetsCount} قطعة). عند الحذف سيتم خصم الكمية من الخلية وإلغاء حركة الدخول تلقائياً. هل تريد المتابعة؟`
    : `هل أنت متأكد من حذف طلب مرتجع المبيعات رقم (${ret.returnNumber})؟`;
  if (!confirm(msg)) return;

  if (wasApproved) {
    deductSheetsFromCellPallets(ret.thkId, ret.gradeId, ret.woodTypeId || 'wt-general', Number(ret.sheetsCount || 0), Number(ret.unitPrice || 0));
    const movToDel = (state.warehouseMovements || []).filter(m => m.referenceCode === ret.returnNumber || m.voucherNumber === ret.returnNumber);
    for (const m of movToDel) markRecordIdDeleted(m.id);
    state.warehouseMovements = (state.warehouseMovements || []).filter(m => m.referenceCode !== ret.returnNumber && m.voucherNumber !== ret.returnNumber);
  }

  markRecordIdDeleted(ret.id);
  state.salesReturns = (state.salesReturns || []).filter(r => r.id !== retId);
  saveState(`🗑️ حذف سجل مرتجع المبيعات رقم (${ret.returnNumber}) بواسطة ${currentUser.name}`);
}

function toggleUserPerm(userId, permKey, checked) {
  if (!isFullAdmin(currentUser)) {
    alert('⛔ عفواً، تعديل الصلاحيات مسموح فقط للمدير التنفيذي ومدير المشروعات!');
    render();
    return;
  }
  if (userId === currentUser.id) {
    alert('⛔ لا يحق لأي مستخدم تعديل صلاحياته الشخصية!');
    render();
    return;
  }
  const user = state.users.find(u => u.id === userId);
  if (!user) return;
  if (isFullAdmin(user)) {
    alert('⛔ المدير التنفيذي ومدير المشروعات يمتلكان كامل الصلاحيات دائماً ولا يمكن تقليصها!');
    render();
    return;
  }
  user.permissions = user.permissions || {};
  user.permissions[permKey] = Boolean(checked);
  user.updatedAt = new Date().toISOString();
  saveState(`تعديل صلاحية (${permKey}) للمستخدم ${user.name} بواسطة ${currentUser.name}`);
}

function editUserPrompt(userId) {
  openPasswordsManagerModal(userId);
}

function openPasswordsManagerModal(focusUserId = '') {
  if (!currentUser) return;
  const adminMode = isFullAdmin(currentUser);
  const modalRoot = document.getElementById('modal-root');

  // If المدير التنفيذي or مدير المشروعات: show all 8 users to edit any name & password/PIN
  // If regular user: show only their own account to change their own password
  const visibleUsers = adminMode ? state.users : [currentUser];

  modalRoot.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal-box" style="max-width:720px;">
        <div class="card-header">
          <div>
            <div class="card-title">🔑 ${adminMode ? 'تغيير الباسورد الخاص بك وباسوردات جميع الموبايلات (8 مستخدمين)' : 'تغيير الباسورد الخاص بحسابك'}</div>
            <small style="color:var(--text-muted);">
              ${adminMode
                ? 'يمكنك تعديل اسم أو باسورد أي مستخدم، وبمجرد الحفظ يسمّع الباسورد الجديد فوراً على كل الموبايلات والأجهزة'
                : 'اكتب الباسورد الجديد الخاص بك واضغط حفظ'}
            </small>
          </div>
          <button class="btn btn-sm btn-outline" onclick="closeModal()">✕</button>
        </div>

        <form onsubmit="submitPasswordsManagerModal(event)">
          <div class="table-responsive" style="max-height:60vh;overflow-y:auto;">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>المنصب الوظيفي</th>
                  <th>اسم المستخدم</th>
                  <th>الباسورد / كود الدخول (PIN)</th>
                </tr>
              </thead>
              <tbody>
                ${visibleUsers.map((u, idx) => {
                  const isFocused = focusUserId === u.id || (!focusUserId && u.id === currentUser.id);
                  return `
                    <tr style="${isFocused ? 'background:rgba(217,119,6,0.08);' : ''}">
                      <td><strong>${idx + 1}</strong></td>
                      <td>
                        <strong>${u.roleTitle}</strong>
                        ${u.id === currentUser.id ? `<span class="badge badge-info" style="margin-right:6px;">حسابك الحالي</span>` : ''}
                      </td>
                      <td>
                        <input id="usr-name-${u.id}" class="form-control" value="${u.name}" ${adminMode ? '' : 'readonly'} required />
                      </td>
                      <td>
                        <input id="usr-pin-${u.id}" type="text" class="form-control" value="${u.pin}" placeholder="اكتب الباسورد الجديد..." style="font-weight:800;letter-spacing:2px;border-color:var(--primary);text-align:center;" ${isFocused ? 'autofocus' : ''} required />
                      </td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>

          <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px;">
            <button type="button" class="btn btn-outline" onclick="closeModal()">إلغاء</button>
            <button type="submit" class="btn btn-primary">💾 حفظ الباسوردات وتسميعها فوراً على الموبايلات</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function submitPasswordsManagerModal(e) {
  e.preventDefault();
  if (!currentUser) return;
  const adminMode = isFullAdmin(currentUser);
  const targetUsers = adminMode ? state.users : [state.users.find(u => u.id === currentUser.id)].filter(Boolean);
  const now = new Date().toISOString();

  for (const u of targetUsers) {
    const nameInput = document.getElementById(`usr-name-${u.id}`);
    const pinInput = document.getElementById(`usr-pin-${u.id}`);
    if (nameInput && adminMode && nameInput.value.trim()) {
      u.name = nameInput.value.trim();
    }
    if (pinInput && pinInput.value.trim()) {
      u.pin = pinInput.value.trim();
    }
    u.updatedAt = now;
  }

  closeModal();
  saveState(`تحديث الباسوردات وبيانات الدخول بواسطة ${currentUser.name}`);
  alert('✅ تم حفظ الباسوردات الجديدة وتسميعها على جميع الموبايلات والأجهزة بنجاح!');
}

// ============================================================================
// UNIVERSAL PRINT ENGINE (يمنع ظهور صفحة فارغة نهائياً في جميع المتصفحات والموبايلات)
// ============================================================================
let _lastPrintDocumentHtml = '';
let _lastPrintDocumentTitle = 'طباعة مستند رسمي - مصنع العاصمة';
let _lastPrintLandscape = false;

function closeUniversalPrintView() {
  window._isPrintingActive = false;
  if (document.body && document.body.classList) {
    document.body.classList.remove('is-printing-mode');
  }
  const printEl = document.getElementById('print-area');
  if (printEl) {
    printEl.innerHTML = '';
    printEl.style.display = 'none';
  }
  render();
}

function buildStandalonePrintHtml(docHtml, docTitle, landscape) {
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${docTitle}</title>
  <style>
    @page { size: ${landscape ? 'A4 landscape' : 'A4 portrait'}; margin: 7mm; }
    * {
      box-sizing: border-box;
      font-family: 'Cairo', 'Segoe UI', Tahoma, Arial, sans-serif;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }
    html, body {
      background: #ffffff !important;
      color: #000000 !important;
      margin: 0 !important;
      padding: 12px !important;
      direction: rtl !important;
      text-align: right !important;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    .pdf-report-wrap {
      border: 2px solid #0f172a;
      border-radius: 8px;
      padding: 14px 16px;
      direction: rtl;
      color: #0f172a;
      background: #ffffff;
    }
    .pdf-report-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 2px solid #0f172a;
      padding-bottom: 8px;
      margin-bottom: 10px;
    }
    .pdf-report-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 11px;
      margin-bottom: 10px;
    }
    .pdf-report-table th, .pdf-report-table td {
      border: 1px solid #334155;
      padding: 4px 6px;
      text-align: center;
      vertical-align: middle;
    }
    .pdf-report-table th {
      background: #e2e8f0;
      font-weight: 800;
      color: #0f172a;
    }
    .pdf-report-footer {
      display: flex;
      justify-content: space-between;
      margin-top: 16px;
      padding-top: 8px;
      border-top: 1px dashed #64748b;
      font-size: 11px;
      font-weight: 700;
    }
    @media print {
      html, body {
        padding: 0 !important;
        margin: 0 !important;
      }
      .no-print-bar {
        display: none !important;
      }
    }
  </style>
</head>
<body>
  <div class="no-print-bar" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;background:#0f172a;color:#fff;padding:10px 16px;border-radius:10px;margin-bottom:14px;">
    <strong style="font-size:14px;color:#fbbf24;">🖨️ ${docTitle}</strong>
    <div style="display:flex;gap:8px;flex-wrap:wrap;">
      <button type="button" onclick="window.focus(); window.print();" style="background:#10b981;color:#fff;border:none;padding:8px 18px;border-radius:8px;font-weight:800;font-size:13px;cursor:pointer;">🖨️ فتح صفحة الطابعة الآن</button>
      <button type="button" onclick="window.close();" style="background:#ef4444;color:#fff;border:none;padding:8px 14px;border-radius:8px;font-weight:800;font-size:13px;cursor:pointer;">✕ إغلاق النافذة</button>
    </div>
  </div>
  <div id="standalone-print-body">
    ${docHtml}
  </div>
</body>
</html>`;
}

function triggerDirectIframePrint(fullHtml) {
  try {
    let iframe = document.getElementById('direct-print-iframe');
    if (iframe && iframe.parentNode) {
      iframe.parentNode.removeChild(iframe);
    }
    iframe = document.createElement('iframe');
    iframe.id = 'direct-print-iframe';
    iframe.style.position = 'fixed';
    iframe.style.right = '0';
    iframe.style.bottom = '0';
    iframe.style.width = '1px';
    iframe.style.height = '1px';
    iframe.style.border = '0';
    iframe.style.opacity = '0.01';
    document.body.appendChild(iframe);

    const iDoc = iframe.contentWindow ? iframe.contentWindow.document : iframe.contentDocument;
    if (!iDoc) return false;
    iDoc.open();
    iDoc.write(fullHtml);
    iDoc.close();
    if (iDoc.body) {
      void iDoc.body.offsetHeight;
    }
    if (iframe.contentWindow && typeof iframe.contentWindow.print === 'function') {
      const t0 = Date.now();
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
      if (Date.now() - t0 < 80) {
        setTimeout(() => {
          try {
            iframe.contentWindow.focus();
            iframe.contentWindow.print();
          } catch (_) {}
        }, 120);
      }
      return true;
    }
  } catch (_) {}
  return false;
}

function openStandalonePrintPopup() {
  if (!_lastPrintDocumentHtml) return;
  const fullHtml = buildStandalonePrintHtml(_lastPrintDocumentHtml, _lastPrintDocumentTitle, _lastPrintLandscape);
  const w = typeof window.open === 'function' ? window.open('', '_blank') : null;
  if (!w || !w.document) {
    if (!triggerDirectIframePrint(fullHtml)) {
      window.focus();
      window.print();
    }
    return;
  }
  w.document.open();
  w.document.write(fullHtml);
  w.document.close();
  if (w.document.body) {
    void w.document.body.offsetHeight;
  }
  const t0 = Date.now();
  try {
    w.focus();
    w.print();
  } catch (_) {}
  if (Date.now() - t0 < 80) {
    setTimeout(() => {
      try {
        w.focus();
        w.print();
      } catch (_) {}
    }, 150);
  }
}

function openUniversalPrintDocument(docHtml, docTitle = 'طباعة مستند رسمي - مصنع العاصمة', landscape = false) {
  _lastPrintDocumentHtml = docHtml;
  _lastPrintDocumentTitle = docTitle;
  _lastPrintLandscape = Boolean(landscape);
  window._isPrintingActive = true;

  const printEl = document.getElementById('print-area');
  if (!printEl) return;

  if (document.body && document.body.classList) {
    document.body.classList.add('is-printing-mode');
  }
  printEl.style.display = 'block';

  printEl.innerHTML = `
    <style>
      @page { size: ${landscape ? 'A4 landscape' : 'A4 portrait'}; margin: 7mm; }
      body.is-printing-mode {
        background: #ffffff !important;
        color: #000000 !important;
      }
      body.is-printing-mode #app,
      body.is-printing-mode #modal-root,
      body.is-printing-mode .live-alert-banner,
      body.is-printing-mode .floating-chat-fab {
        display: none !important;
      }
      body.is-printing-mode #print-area {
        display: block !important;
        visibility: visible !important;
        width: 100% !important;
        min-height: 100vh !important;
        background: #ffffff !important;
        color: #000000 !important;
        padding: 14px !important;
      }
      @media print {
        html, body {
          background: #ffffff !important;
          color: #000000 !important;
          margin: 0 !important;
          padding: 0 !important;
          height: auto !important;
          overflow: visible !important;
          -webkit-print-color-adjust: exact !important;
          print-color-adjust: exact !important;
        }
        #app, #modal-root, .live-alert-banner, .floating-chat-fab, .no-print-bar, #direct-print-iframe {
          display: none !important;
        }
        #print-area, #print-area * {
          visibility: visible !important;
        }
        #print-area {
          display: block !important;
          position: static !important;
          width: 100% !important;
          background: #ffffff !important;
          color: #000000 !important;
          padding: 0 !important;
          margin: 0 !important;
        }
      }
      .pdf-report-wrap {
        border: 2px solid #0f172a;
        border-radius: 8px;
        padding: 14px 16px;
        font-family: 'Cairo', 'Segoe UI', Tahoma, Arial, sans-serif;
        direction: rtl;
        color: #0f172a;
        background: #fff;
      }
      .pdf-report-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        border-bottom: 2px solid #0f172a;
        padding-bottom: 8px;
        margin-bottom: 10px;
      }
      .pdf-report-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 11px;
        margin-bottom: 10px;
      }
      .pdf-report-table th, .pdf-report-table td {
        border: 1px solid #334155;
        padding: 4px 6px;
        text-align: center;
        vertical-align: middle;
      }
      .pdf-report-table th {
        background: #e2e8f0;
        font-weight: 800;
        color: #0f172a;
      }
      .pdf-report-footer {
        display: flex;
        justify-content: space-between;
        margin-top: 16px;
        padding-top: 8px;
        border-top: 1px dashed #64748b;
        font-size: 11px;
        font-weight: 700;
      }
    </style>
    <div class="no-print-bar" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;background:#0f172a;color:#fff;padding:12px 18px;border-radius:10px;margin-bottom:16px;font-family:'Cairo',sans-serif;direction:rtl;">
      <div>
        <strong style="font-size:15px;color:#fbbf24;">🖨️ معاينة الطباعة الرسمية: ${docTitle}</strong>
        <div style="font-size:12px;color:#cbd5e1;">تم فتح صفحة الطابعة تلقائياً — يمكنك أيضاً الضغط على زر الطباعة بالأسفل</div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button type="button" onclick="openStandalonePrintPopup()" style="background:#10b981;color:#fff;border:none;padding:8px 16px;border-radius:8px;font-weight:800;font-size:13px;cursor:pointer;font-family:'Cairo',sans-serif;">
          🖨️ فتح في صفحة الطابعة الآن
        </button>
        <button type="button" onclick="window.focus(); window.print();" style="background:#2563eb;color:#fff;border:none;padding:8px 14px;border-radius:8px;font-weight:800;font-size:13px;cursor:pointer;font-family:'Cairo',sans-serif;">
          🖨️ طباعة مباشرة من نفس الشاشة
        </button>
        <button type="button" onclick="closeUniversalPrintView()" style="background:#ef4444;color:#fff;border:none;padding:8px 16px;border-radius:8px;font-weight:800;font-size:13px;cursor:pointer;font-family:'Cairo',sans-serif;">
          🔙 العودة للنظام وإغلاق شاشة الطباعة
        </button>
      </div>
    </div>
    <div id="print-document-content" style="background:#fff;color:#000;">
      ${docHtml}
    </div>
  `;

  if (typeof window.scrollTo === 'function') {
    window.scrollTo(0, 0);
  }
  void printEl.offsetHeight;

  // Open clean dedicated print window synchronously on user click so the Printer Dialog opens immediately with 100% visible content
  const fullStandaloneHtml = buildStandalonePrintHtml(docHtml, docTitle, landscape);
  const popupWin = typeof window.open === 'function' ? window.open('', '_blank') : null;
  if (popupWin && popupWin.document) {
    popupWin.document.open();
    popupWin.document.write(fullStandaloneHtml);
    popupWin.document.close();
    if (popupWin.document.body) {
      void popupWin.document.body.offsetHeight;
    }
    const t0 = Date.now();
    try {
      popupWin.focus();
      popupWin.print();
    } catch (_) {}
    if (Date.now() - t0 < 80) {
      setTimeout(() => {
        try {
          popupWin.focus();
          popupWin.print();
        } catch (_) {}
      }, 150);
    }
    return;
  }

  // Fallback if popup is blocked (e.g. PWA or strict browser): synchronous print on visible #print-area
  const t0 = Date.now();
  if (typeof window.focus === 'function') window.focus();
  window.print();
  if (Date.now() - t0 < 80) {
    setTimeout(() => {
      window.print();
    }, 150);
  }
}

// ============================================================================
// OFFICIAL PRINT TEMPLATES (بطاقة البالتة بالباركود + أذون الصرف + الفواتير)
// ============================================================================
function printPalletTag(palletId) {
  const p = state.pallets.find(x => x.id === palletId);
  if (!p) return;
  const html = `
    <div style="border:4px solid #000;border-radius:12px;padding:24px;max-width:650px;margin:0 auto;font-family:'Cairo',sans-serif;direction:rtl;background:#fff;color:#000;">
      <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:3px solid #000;padding-bottom:12px;margin-bottom:16px;">
        <div>
          <h1 style="font-size:24px;margin:0;">${state.factoryInfo.name}</h1>
          <p style="margin:4px 0 0;font-size:14px;">بطاقة تعريف بالتة قشرة خشبية (Pallet Quality Tag)</p>
        </div>
        ${getPrintTopLeftLogoHtml(`<div style="font-weight:800;font-size:18px;border:2px solid #000;padding:5px 12px;border-radius:8px;">${p.palletCode}</div>`)}
      </div>

      <table style="width:100%;border-collapse:collapse;font-size:16px;margin-bottom:18px;">
        <tr>
          <td style="border:1px solid #000;padding:10px;font-weight:700;background:#f1f5f9;">نوع الخشب:</td>
          <td style="border:1px solid #000;padding:10px;font-weight:800;font-size:18px;">${p.woodTypeName}</td>
          <td style="border:1px solid #000;padding:10px;font-weight:700;background:#f1f5f9;">المقاس (العرض × الطول):</td>
          <td style="border:1px solid #000;padding:10px;font-weight:800;font-size:18px;">${formatVeneerDimensions(p.lengthCm, p.widthCm, true)}</td>
        </tr>
        <tr>
          <td style="border:1px solid #000;padding:10px;font-weight:700;background:#f1f5f9;">التخانة (مم):</td>
          <td style="border:1px solid #000;padding:10px;font-weight:800;font-size:20px;">${p.thicknessMm} مم (${p.direction === 'sada' ? 'سدا' : 'قص'})</td>
          <td style="border:1px solid #000;padding:10px;font-weight:700;background:#f1f5f9;">درجة الجودة والفرز:</td>
          <td style="border:1px solid #000;padding:10px;font-weight:800;font-size:18px;">${p.gradeName}</td>
        </tr>
        <tr>
          <td style="border:1px solid #000;padding:10px;font-weight:700;background:#f1f5f9;">عدد الأفرخ بالبالتة:</td>
          <td style="border:1px solid #000;padding:10px;font-weight:800;font-size:20px;">${p.sheetsCount} فرخ</td>
          <td style="border:1px solid #000;padding:10px;font-weight:700;background:#f1f5f9;">إجمالي المساحة:</td>
          <td style="border:1px solid #000;padding:10px;font-weight:800;">${p.areaM2} م²</td>
        </tr>
        <tr>
          <td style="border:1px solid #000;padding:10px;font-weight:700;background:#f1f5f9;">إجمالي الحجم (م³):</td>
          <td style="border:1px solid #000;padding:10px;font-weight:800;font-size:22px;">${p.volumeM3} م³</td>
          <td style="border:1px solid #000;padding:10px;font-weight:700;background:#f1f5f9;">رقم التشغيلة / التاريخ:</td>
          <td style="border:1px solid #000;padding:10px;">${sanitizeTextForWarehouseKeeper(p.batchNumber || '-')} | ${fmtDate(p.createdAt)}</td>
        </tr>
      </table>

      <!-- Visual Barcode representation -->
      <div style="text-align:center;padding:12px;border:1px dashed #000;border-radius:8px;">
        <div style="font-family:monospace;font-size:28px;letter-spacing:6px;font-weight:900;">||| || |||| | ||| |||| || |||</div>
        <div style="font-weight:800;font-size:16px;margin-top:4px;">${p.palletCode} — ${p.lengthCm}x${p.widthCm}x${p.thicknessMm}mm</div>
      </div>

      <div style="display:flex;justify-content:space-between;margin-top:20px;font-size:14px;font-weight:700;">
        <span>أمين المخزن: ${p.createdBy}</span>
        <span>مراقب الجودة / التشغيل: ....................</span>
        <span>اعتماد الإدارة: ....................</span>
      </div>
    </div>
  `;
  openUniversalPrintDocument(html, `بطاقة بالتة ${p.palletCode}`, false);
}

function printApprovalDispatchOrder(reqId) {
  const r = state.approvalRequests.find(x => x.id === reqId);
  if (!r) return;
  const html = `
    <div style="border:2px solid #000;padding:28px;font-family:'Cairo',sans-serif;direction:rtl;background:#fff;color:#000;">
      <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #000;padding-bottom:14px;margin-bottom:20px;">
        <div>
          <h1 style="margin:0;font-size:22px;">${state.factoryInfo.name}</h1>
          <p style="margin:4px 0 0;">إذن صرف وتسليم قشرة خشبية (معتمد)</p>
        </div>
        ${getPrintTopLeftLogoHtml(`
          <div><strong>رقم الإذن:</strong> ${r.requestNumber}</div>
          <div><strong>التاريخ:</strong> ${fmtDate(r.createdAt)}</div>
        `)}
      </div>

      <p style="font-size:16px;margin-bottom:14px;">
        <strong>السادة / العميل المستلم:</strong> ${r.clientOrProjectName}
      </p>

      <table style="width:100%;border-collapse:collapse;margin-bottom:24px;font-size:15px;">
        <thead>
          <tr style="background:#e2e8f0;">
            <th style="border:1px solid #000;padding:10px;">كود البالتة</th>
            <th style="border:1px solid #000;padding:10px;">نوع الخشب</th>
            <th style="border:1px solid #000;padding:10px;">المقاس والتخانة</th>
            <th style="border:1px solid #000;padding:10px;">الجودة</th>
            <th style="border:1px solid #000;padding:10px;">عدد الأفرخ</th>
            <th style="border:1px solid #000;padding:10px;">المساحة (م²)</th>
            <th style="border:1px solid #000;padding:10px;">الحجم (م³)</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style="border:1px solid #000;padding:10px;font-weight:700;">${r.palletCode}</td>
            <td style="border:1px solid #000;padding:10px;">${r.woodTypeName}</td>
            <td style="border:1px solid #000;padding:10px;">${r.dimensions} — ${r.thicknessMm} مم</td>
            <td style="border:1px solid #000;padding:10px;">${r.gradeName}</td>
            <td style="border:1px solid #000;padding:10px;">${r.sheetsCount} فرخ</td>
            <td style="border:1px solid #000;padding:10px;">${r.areaM2} م²</td>
            <td style="border:1px solid #000;padding:10px;font-weight:800;">${r.volumeM3} م³</td>
          </tr>
        </tbody>
      </table>

      <div style="display:grid;grid-template-columns:repeat(4, 1fr);gap:16px;margin-top:40px;text-align:center;font-weight:700;">
        <div>طالب الصرف<br/><br/>${r.requestedBy}</div>
        <div>اعتماد الحسابات<br/><br/>${r.financialApprovedBy || '................'}</div>
        <div>أمين المخزن<br/><br/>${r.warehouseExecutedBy || '................'}</div>
        <div>توقيع المستلم<br/><br/>................</div>
      </div>
    </div>
  `;
  openUniversalPrintDocument(html, `إذن صرف ${r.requestNumber}`, false);
}

function printWarehouseVoucher(movId) {
  const m = state.warehouseMovements.find(x => x.id === movId);
  if (!m) return;
  const html = `
    <div style="border:2px solid #000;padding:28px;font-family:'Cairo',sans-serif;direction:rtl;background:#fff;color:#000;">
      <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #000;padding-bottom:12px;margin-bottom:16px;">
        <div>
          <h2 style="margin:0;">${state.factoryInfo.name}</h2>
          <h3 style="margin:4px 0 0;">${m.directionLabel} — رقم: ${m.voucherNumber || '-'}</h3>
        </div>
        ${getPrintTopLeftLogoHtml(`<div><strong>التاريخ:</strong> ${fmtDate(m.date)}</div>`)}
      </div>
      <p><strong>التاريخ:</strong> ${fmtDate(m.date)}</p>
      <p><strong>المخزن:</strong> ${m.warehouseLabel}</p>
      <p><strong>البيان:</strong> ${sanitizeTextForWarehouseKeeper(m.itemSummary)}</p>
      <p><strong>الكمية:</strong> ${sanitizeTextForWarehouseKeeper(m.quantitySummary)}</p>
      <p><strong>المرجع:</strong> ${m.referenceCode || '-'}</p>
      <div style="display:flex;justify-content:space-between;margin-top:45px;font-weight:700;">
        <span>أمين المخزن: ${m.performedBy}</span>
        <span>اعتماد الإدارة: ${m.approvedBy}</span>
      </div>
    </div>
  `;
  openUniversalPrintDocument(html, `إذن حركة مخزن ${m.voucherNumber}`, false);
}

function printProductionOrder(poId) {
  printClientOrderStatement(poId);
}

function printClientOrderStatement(orderId) {
  const ord = (state.productionOrders || []).find(x => x.id === orderId);
  if (!ord) return;
  const items = Array.isArray(ord.items) ? ord.items : [];
  const showPrices = canSeeFinancialPrices();
  const html = `
    <div style="border:3px solid #000;padding:24px;font-family:'Cairo',sans-serif;direction:rtl;background:#fff;color:#000;">
      <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #000;padding-bottom:12px;margin-bottom:16px;">
        <div>
          <h1 style="margin:0;font-size:22px;">${state.factoryInfo.name}</h1>
          <p style="margin:4px 0 0;font-size:14px;">بيان طلبية وأمر تجهيز قشرة خشبية للعميل (المقاس المعتمد 125×250 سم أو مقاس خاص)</p>
        </div>
        ${getPrintTopLeftLogoHtml(`
          <div><strong>رقم الطلبية:</strong> ${ord.orderNumber}</div>
          <div><strong>التاريخ:</strong> ${ord.date || fmtDate(ord.createdAt)}</div>
          <div><strong>كود العميل:</strong> ${ord.clientCode || 'CL'}</div>
        `)}
      </div>

      <p style="font-size:15px;margin-bottom:12px;">
        <strong>السادة / العميل:</strong> ${ord.clientName} ${ord.clientPhone ? ' — هاتف: ' + ord.clientPhone : ''}
      </p>

      <table style="width:100%;border-collapse:collapse;margin-bottom:18px;font-size:14px;">
        <thead>
          <tr style="background:#e2e8f0;">
            <th style="border:1px solid #000;padding:7px;">#</th>
            <th style="border:1px solid #000;padding:7px;">التخانة (مم)</th>
            <th style="border:1px solid #000;padding:7px;">الاتجاه (قص / سدا)</th>
            <th style="border:1px solid #000;padding:7px;">درجة الجودة</th>
            <th style="border:1px solid #000;padding:7px;">المقاس (العرض × الطول)</th>
            <th style="border:1px solid #000;padding:7px;">الكمية (قطعة)</th>
            <th style="border:1px solid #000;padding:7px;">الحجم (م³)</th>
            ${showPrices ? `
              <th style="border:1px solid #000;padding:7px;">سعر القطعة</th>
              <th style="border:1px solid #000;padding:7px;">إجمالي البند</th>
            ` : ''}
          </tr>
        </thead>
        <tbody>
          ${items.map((it, idx) => `
            <tr>
              <td style="border:1px solid #000;padding:7px;text-align:center;">${idx + 1}</td>
              <td style="border:1px solid #000;padding:7px;font-weight:700;">${it.thicknessMm} مم</td>
              <td style="border:1px solid #000;padding:7px;">${it.direction === 'sada' ? 'اتجاه سدا' : 'اتجاه قص'}</td>
              <td style="border:1px solid #000;padding:7px;font-weight:700;">${it.gradeName}</td>
              <td style="border:1px solid #000;padding:7px;font-weight:700;">${formatVeneerDimensions(it.lengthCm, it.widthCm, true)}</td>
              <td style="border:1px solid #000;padding:7px;font-weight:700;">${fmtNum(it.sheetsCount, 0)} قطعة</td>
              <td style="border:1px solid #000;padding:7px;">${fmtNum(it.volumeM3, 4)} م³</td>
              ${showPrices ? `
                <td style="border:1px solid #000;padding:7px;">${fmtMoney(it.unitPrice)}</td>
                <td style="border:1px solid #000;padding:7px;font-weight:800;">${fmtMoney(it.totalItemAmount)}</td>
              ` : ''}
            </tr>
          `).join('')}
        </tbody>
      </table>

      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px;">
        <div>
          <p style="margin:4px 0;"><strong>إجمالي عدد القطع:</strong> ${fmtNum(ord.totalSheetsCount, 0)} قطعة | <strong>إجمالي الحجم:</strong> ${fmtNum(ord.totalVolumeM3, 4)} م³</p>
          ${ord.notes ? `<p style="margin:4px 0;"><strong>ملاحظات:</strong> ${ord.notes}</p>` : ''}
        </div>
        ${showPrices ? `
        <div style="border:2px solid #000;padding:10px 16px;border-radius:8px;min-width:250px;">
          <div style="display:flex;justify-content:space-between;margin-bottom:5px;">
            <span>الإجمالي قبل الخصم:</span>
            <strong>${fmtMoney(ord.subtotalAmount || ord.netTotalAmount || 0)}</strong>
          </div>
          <div style="display:flex;justify-content:space-between;margin-bottom:5px;">
            <span>قيمة الخصم:</span>
            <strong>-${fmtMoney(ord.discountAmount || 0)}</strong>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:16px;border-top:1px solid #000;padding-top:5px;">
            <strong>الصافي النهائي للبيان:</strong>
            <strong>${fmtMoney(ord.netTotalAmount || 0)}</strong>
          </div>
        </div>
        ` : ''}
      </div>

      <div style="display:grid;grid-template-columns:repeat(4, 1fr);gap:14px;margin-top:30px;text-align:center;font-weight:700;font-size:13px;">
        <div>إعداد المحاسب<br/><br/>${ord.requestedBy || '................'}</div>
        <div>اعتماد المدير التنفيذي/المشروعات<br/><br/>${ord.executiveApprovedBy || '................'}</div>
        <div>موافقة المدير الإداري/أمين المخزن<br/><br/>${ord.warehousePrepApprovedBy || '................'}</div>
        <div>توقيع العميل<br/><br/>................</div>
      </div>
    </div>
  `;
  openUniversalPrintDocument(html, `بيان طلبية ${ord.orderNumber} - ${ord.clientName}`, false);
}

function printVehicleDispatchVoucher(orderId) {
  const ord = (state.productionOrders || []).find(x => x.id === orderId);
  if (!ord) return;
  const car = ord.carDispatchVoucher || {};
  const items = Array.isArray(ord.items) ? ord.items : [];
  const html = `
    <div style="border:3px solid #000;padding:24px;font-family:'Cairo',sans-serif;direction:rtl;background:#fff;color:#000;">
      <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:3px solid #000;padding-bottom:12px;margin-bottom:16px;">
        <div>
          <h1 style="margin:0;font-size:22px;">${state.factoryInfo.name}</h1>
          <h2 style="margin:6px 0 0;font-size:17px;">🚚 إذن صرف وتحميل سيارة بالبضاعة (معتمد للخروج من البوابة)</h2>
        </div>
        ${getPrintTopLeftLogoHtml(`
          <div style="border:2px solid #000;padding:5px 10px;border-radius:8px;">
            <div><strong>رقم إذن السيارة:</strong> ${car.voucherNo || 'CAR-' + ord.orderNumber}</div>
            <div><strong>رقم الطلبية:</strong> ${ord.orderNumber}</div>
            <div><strong>تاريخ التحميل:</strong> ${car.dispatchDate || ord.date}</div>
          </div>
        `)}
      </div>

      <table style="width:100%;border-collapse:collapse;margin-bottom:16px;font-size:14px;">
        <tr>
          <td style="border:1px solid #000;padding:8px;background:#f1f5f9;font-weight:700;">اسم العميل وكوده:</td>
          <td style="border:1px solid #000;padding:8px;font-weight:800;">[${ord.clientCode || 'CL'}] ${ord.clientName}</td>
          <td style="border:1px solid #000;padding:8px;background:#f1f5f9;font-weight:700;">رقم السيارة المحملة:</td>
          <td style="border:1px solid #000;padding:8px;font-weight:900;font-size:17px;">${car.carPlateNumber || '-'}</td>
        </tr>
        <tr>
          <td style="border:1px solid #000;padding:8px;background:#f1f5f9;font-weight:700;">اسم سائق السيارة:</td>
          <td style="border:1px solid #000;padding:8px;font-weight:800;">${car.driverName || '-'} (${car.driverPhone || ''})</td>
          <td style="border:1px solid #000;padding:8px;background:#f1f5f9;font-weight:700;">حساب البالتات مع السيارة:</td>
          <td style="border:1px solid #000;padding:8px;font-weight:800;">
            بالتات مسلمة للعميل: (${car.palletsDeliveredCount ?? 0}) | مستلمة منه: (${car.palletsReceivedCount ?? 0})
          </td>
        </tr>
      </table>

      <h3 style="margin:0 0 8px;font-size:15px;">بيان أصناف القشرة الخشبية المحملة على السيارة:</h3>
      <table style="width:100%;border-collapse:collapse;margin-bottom:20px;font-size:14px;">
        <thead>
          <tr style="background:#e2e8f0;">
            <th style="border:1px solid #000;padding:7px;">#</th>
            <th style="border:1px solid #000;padding:7px;">التخانة والاتجاه (قص / سدا)</th>
            <th style="border:1px solid #000;padding:7px;">درجة الجودة</th>
            <th style="border:1px solid #000;padding:7px;">المقاس (العرض × الطول)</th>
            <th style="border:1px solid #000;padding:7px;">الكمية المحملة (قطعة)</th>
            <th style="border:1px solid #000;padding:7px;">المساحة (م²)</th>
            <th style="border:1px solid #000;padding:7px;">الحجم (م³)</th>
          </tr>
        </thead>
        <tbody>
          ${items.map((it, idx) => `
            <tr>
              <td style="border:1px solid #000;padding:7px;text-align:center;">${idx + 1}</td>
              <td style="border:1px solid #000;padding:7px;font-weight:700;">${it.thicknessMm} مم (${it.direction === 'sada' ? 'اتجاه سدا' : 'اتجاه قص'})</td>
              <td style="border:1px solid #000;padding:7px;font-weight:700;">${it.gradeName}</td>
              <td style="border:1px solid #000;padding:7px;font-weight:700;">${formatVeneerDimensions(it.lengthCm, it.widthCm, true)}</td>
              <td style="border:1px solid #000;padding:7px;font-weight:800;">${fmtNum(it.sheetsCount, 0)} قطعة</td>
              <td style="border:1px solid #000;padding:7px;">${fmtNum(it.areaM2, 2)} م²</td>
              <td style="border:1px solid #000;padding:7px;font-weight:800;">${fmtNum(it.volumeM3, 4)} م³</td>
            </tr>
          `).join('')}
        </tbody>
      </table>

      <div style="display:grid;grid-template-columns:repeat(4, 1fr);gap:14px;margin-top:35px;text-align:center;font-weight:700;font-size:13px;">
        <div>اعتماد المحاسب للصرف<br/><br/>${ord.accountantReleaseBy || '................'}</div>
        <div>أمين المخزن / المدير الإداري<br/><br/>${car.dispatchedBy || currentUser.name}</div>
        <div>توقيع سائق السيارة بالاستلام<br/><br/>${car.driverName || '................'}</div>
        <div>مسؤول أمن البوابة<br/><br/>................</div>
      </div>
    </div>
  `;
  openUniversalPrintDocument(html, `إذن صرف سيارة ${car.carPlateNumber || ord.orderNumber}`, false);
}

function printClientFullStatement(clientId) {
  const pt = (state.partners || []).find(p => p.id === clientId);
  if (!pt) return;
  const m = computeClientMetrics(pt);
  const html = `
    <div style="border:3px solid #000;padding:24px;font-family:'Cairo',sans-serif;direction:rtl;background:#fff;color:#000;">
      <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #000;padding-bottom:12px;margin-bottom:16px;">
        <div>
          <h1 style="margin:0;font-size:21px;">${state.factoryInfo.name}</h1>
          <p style="margin:4px 0 0;font-size:14px;">بيان كشف حساب عميل شامل (الطلبيات الفائتة + المديونيات والمستحقات + حساب البالتات)</p>
        </div>
        ${getPrintTopLeftLogoHtml(`
          <div><strong>كود العميل:</strong> ${pt.code || 'CL'}</div>
          <div><strong>اسم العميل:</strong> ${pt.name}</div>
          <div><strong>تاريخ البيان:</strong> ${todayStr()}</div>
        `)}
      </div>

      <table style="width:100%;border-collapse:collapse;margin-bottom:16px;font-size:13px;">
        <tr style="background:#f1f5f9;">
          <td style="border:1px solid #000;padding:8px;"><strong>إجمالي المسحوبات (مدين):</strong> ${fmtMoney(m.totalDebit)}</td>
          <td style="border:1px solid #000;padding:8px;"><strong>إجمالي المدفوعات (دائن):</strong> ${fmtMoney(m.totalCredit)}</td>
          <td style="border:1px solid #000;padding:8px;font-size:15px;">
            <strong>صافي الرصيد المالي:</strong>
            ${m.netDebt > 0 ? 'مدين (عليه للمصنع): ' + fmtMoney(m.netDebt) : m.netDebt < 0 ? 'دائن (له مستحقات): ' + fmtMoney(Math.abs(m.netDebt)) : 'خالص (0 ج.م)'}
          </td>
        </tr>
        <tr>
          <td style="border:1px solid #000;padding:8px;"><strong>بالتات مسلمة للعميل:</strong> ${m.palletsDelivered} بالتة</td>
          <td style="border:1px solid #000;padding:8px;"><strong>بالتات مستلمة من العميل:</strong> ${m.palletsReceived} بالتة</td>
          <td style="border:1px solid #000;padding:8px;font-size:15px;"><strong>صافي البالتات طرف العميل:</strong> ${m.netPalletsAtClient} بالتة</td>
        </tr>
      </table>

      <h3 style="margin:12px 0 6px;font-size:14px;">1. بيان الطلبيات (${m.orders.length} طلبية):</h3>
      <table style="width:100%;border-collapse:collapse;margin-bottom:16px;font-size:12.5px;">
        <thead>
          <tr style="background:#e2e8f0;">
            <th style="border:1px solid #000;padding:6px;">رقم الطلبية</th>
            <th style="border:1px solid #000;padding:6px;">التاريخ</th>
            <th style="border:1px solid #000;padding:6px;">الأصناف (التخانات والجودات)</th>
            <th style="border:1px solid #000;padding:6px;">الخصم</th>
            <th style="border:1px solid #000;padding:6px;">الصافي</th>
          </tr>
        </thead>
        <tbody>
          ${m.orders.map(o => `
            <tr>
              <td style="border:1px solid #000;padding:6px;">${o.orderNumber}</td>
              <td style="border:1px solid #000;padding:6px;">${o.date}</td>
              <td style="border:1px solid #000;padding:6px;">${(o.items || []).map(i => `${i.thicknessMm}مم (${i.direction === 'sada' ? 'سدا' : 'قص'}) ${i.gradeName} [${formatVeneerDimensions(i.lengthCm, i.widthCm, false)}]: ${i.sheetsCount} ق`).join(' + ')}</td>
              <td style="border:1px solid #000;padding:6px;">${fmtMoney(o.discountAmount || 0)}</td>
              <td style="border:1px solid #000;padding:6px;font-weight:700;">${fmtMoney(o.netTotalAmount || 0)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>

      <div style="display:flex;justify-content:space-between;margin-top:30px;font-weight:700;font-size:13px;">
        <span>إعداد الحسابات: ${currentUser.name}</span>
        <span>اعتماد مدير الحسابات / المدير التنفيذي: ....................</span>
        <span>توقيع ومصادقة العميل: ....................</span>
      </div>
    </div>
  `;
  openUniversalPrintDocument(html, `كشف حساب عميل [${pt.code || 'CL'}] ${pt.name}`, false);
}

function printFinancialInvoice(txId) {
  const tx = state.financialTransactions.find(x => x.id === txId);
  if (!tx) return;
  const html = `
    <div style="border:2px solid #000;padding:24px;font-family:'Cairo',sans-serif;direction:rtl;background:#fff;color:#000;">
      <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #000;padding-bottom:12px;margin-bottom:16px;">
        <div>
          <h2 style="margin:0;">${state.factoryInfo.name}</h2>
          <h3 style="margin:4px 0 0;">${tx.typeLabel} — رقم: ${tx.voucherNo}</h3>
        </div>
        ${getPrintTopLeftLogoHtml(`<div><strong>التاريخ:</strong> ${tx.date}</div>`)}
      </div>
      <p><strong>التاريخ:</strong> ${tx.date}</p>
      <p><strong>العميل / الجهة:</strong> ${tx.partnerName}</p>
      <p><strong>البيان:</strong> ${tx.description}</p>
      <p><strong>إجمالي المبلغ:</strong> ${fmtMoney(tx.totalAmount)}</p>
      <p><strong>المدفوع:</strong> ${fmtMoney(tx.paidAmount)} | <strong>المتبقي:</strong> ${fmtMoney(tx.remainingAmount)}</p>
      <div style="display:flex;justify-content:space-between;margin-top:40px;font-weight:700;">
        <span>المحاسب: ${tx.createdBy}</span>
        <span>مدير الحسابات: ${tx.approvedBy}</span>
      </div>
    </div>
  `;
  openUniversalPrintDocument(html, `سند مالي ${tx.voucherNo}`, false);
}

// ============================================================================
// COMPREHENSIVE PDF / PRINT GENERATOR FOR ALL TABLES & REPORTS (بما في ذلك جدول الكميات وجدول الأسعار)
// ============================================================================
function triggerOfficialReportPdf(title, subtitle, bodyHtml, landscape = false) {
  const factoryName = state.factoryInfo?.name || 'مصنع العاصمة للصناعات المتخصصة';
  const userLabel = currentUser ? `${currentUser.name} (${currentUser.roleTitle})` : 'إدارة المصنع';
  const docHtml = `
    <div class="pdf-report-wrap">
      <div class="pdf-report-header">
        <div>
          <h1 style="margin:0;font-size:17px;font-weight:900;">🏭 ${factoryName}</h1>
          <div style="font-size:13px;font-weight:800;color:#0f766e;margin-top:2px;">${title}</div>
          ${subtitle ? `<div style="font-size:11px;color:#475569;margin-top:1px;">${subtitle}</div>` : ''}
        </div>
        ${getPrintTopLeftLogoHtml(`
          <div style="font-size:11px;border:1px solid #0f172a;padding:5px 10px;border-radius:6px;background:#f8fafc;">
            <div><strong>تاريخ الطباعة:</strong> ${todayStr()}</div>
            <div><strong>التوقيت:</strong> ${new Date().toLocaleTimeString('ar-EG')}</div>
            <div><strong>المستخدم:</strong> ${userLabel}</div>
          </div>
        `)}
      </div>
      ${bodyHtml}
      <div class="pdf-report-footer">
        <span>إعداد ومراجعة: ${userLabel}</span>
        <span>اعتماد الحسابات / المخازن: ....................</span>
        <span>اعتماد الإدارة التنفيذية: ....................</span>
      </div>
    </div>
  `;
  openUniversalPrintDocument(docHtml, title, landscape);
}

function buildVeneerQuantitiesMatrixPrintHtml() {
  const thicknesses = state.catalog?.thicknesses || [];
  const grades = state.catalog?.grades || [];
  const inStockPallets = (state.pallets || []).filter(p =>
    p.status === 'in_stock' &&
    (veneerFilterWood === 'all' || p.woodTypeId === veneerFilterWood) &&
    matchesPalletDimensionFilter(p, veneerFilterDimension)
  );

  let grandSheets = 0;
  let grandM3 = 0;
  const colTotals = {};
  grades.forEach(g => { colTotals[g.id] = { sheets: 0, m3: 0 }; });

  const rowsHtml = thicknesses.map(t => {
    const isSada = t.direction === 'sada';
    let rowSheets = 0;
    let rowM3 = 0;

    const cellsHtml = grades.map(g => {
      const matching = inStockPallets.filter(p => matchPalletToThicknessRow(p, t) && matchPalletToGrade(p, g.id));
      const sheets = matching.reduce((s, p) => s + Number(p.sheetsCount || 0), 0);
      const m3 = +(matching.reduce((s, p) => {
        if (Number(p.volumeM3) > 0) return s + Number(p.volumeM3);
        return s + calculateVeneerMetrics(p.lengthCm || 250, p.widthCm || 125, t.mm, p.sheetsCount).totalVolumeM3;
      }, 0)).toFixed(4);
      rowSheets += sheets;
      rowM3 += m3;
      colTotals[g.id].sheets += sheets;
      colTotals[g.id].m3 += m3;
      return `
        <td style="background:${sheets > 0 ? '#f0fdf4' : '#ffffff'};">
          <div style="font-weight:900;font-size:12px;color:${sheets > 0 ? '#0f172a' : '#94a3b8'};">${fmtNum(sheets, 0)} ق</div>
          <div style="font-size:9.5px;color:#475569;">${fmtNum(m3, 3)} م³</div>
        </td>
      `;
    }).join('');

    grandSheets += rowSheets;
    grandM3 += rowM3;

    return `
      <tr>
        <td style="background:${isSada ? '#e0f2fe' : '#fef3c7'};font-weight:900;text-align:right;white-space:nowrap;">
          ${t.mm} مم (${isSada ? 'سدا' : 'قص'})
        </td>
        ${cellsHtml}
        <td style="background:#f1f5f9;font-weight:900;">
          <div>${fmtNum(rowSheets, 0)} ق</div>
          <div style="font-size:9.5px;color:#0f766e;">${fmtNum(rowM3, 3)} م³</div>
        </td>
      </tr>
    `;
  }).join('');

  return `
    <table class="pdf-report-table">
      <thead>
        <tr>
          <th style="text-align:right;">التخانة والاتجاه \\ الجودة</th>
          ${grades.map(g => `<th>${g.code}<br/><span style="font-size:9px;font-weight:600;">${g.name}</span></th>`).join('')}
          <th>إجمالي الصف</th>
        </tr>
      </thead>
      <tbody>
        ${rowsHtml}
      </tbody>
      <tfoot>
        <tr style="background:#e2e8f0;font-weight:900;">
          <td style="text-align:right;">إجمالي العمود</td>
          ${grades.map(g => `
            <td>
              <div>${fmtNum(colTotals[g.id].sheets, 0)} ق</div>
              <div style="font-size:9.5px;color:#0f766e;">${fmtNum(colTotals[g.id].m3, 3)} م³</div>
            </td>
          `).join('')}
          <td style="background:#dcfce7;font-size:12px;">
            <div>${fmtNum(grandSheets, 0)} قطعة</div>
            <div style="font-size:10px;color:#15803d;">${fmtNum(grandM3, 3)} م³</div>
          </td>
        </tr>
      </tfoot>
    </table>
  `;
}

function buildVeneerPricesMatrixPrintHtml() {
  if (!canSeeFinancialPrices()) return '';
  const thicknesses = state.catalog?.thicknesses || [];
  const grades = state.catalog?.grades || [];
  const inStockPallets = (state.pallets || []).filter(p =>
    p.status === 'in_stock' && (veneerFilterWood === 'all' || p.woodTypeId === veneerFilterWood)
  );
  const allMovs = state.warehouseMovements || [];

  let grandStockValue = 0;
  let grandSalesValue = 0;
  const colTotals = {};
  grades.forEach(g => { colTotals[g.id] = { stockValue: 0, salesValue: 0 }; });

  const rowsHtml = thicknesses.map(t => {
    const isSada = t.direction === 'sada';
    let rowStockVal = 0;
    let rowSalesVal = 0;

    const cellsHtml = grades.map(g => {
      const matching = inStockPallets.filter(p => matchPalletToThicknessRow(p, t) && matchPalletToGrade(p, g.id));
      const sheets = matching.reduce((s, p) => s + Number(p.sheetsCount || 0), 0);
      const unitPrice = getCellUnitPrice(t.id, g.id, t.mm, t.direction);
      const stockValue = +(sheets * unitPrice).toFixed(2);
      const cellKey = getCellPriceKey(t.id, g.id);
      const soldMovs = allMovs.filter(m =>
        m.warehouseType === 'finished_veneers' &&
        m.direction === 'out' &&
        m.movementCategory === 'sales_exit' &&
        String(m.cellKey || '').replace(/[.#$/\[\]]/g, '_dot_') === cellKey
      );
      const soldValue = soldMovs.reduce((s, m) => s + Number(m.totalSaleAmount || 0), 0);

      rowStockVal += stockValue;
      rowSalesVal += soldValue;
      colTotals[g.id].stockValue += stockValue;
      colTotals[g.id].salesValue += soldValue;

      return `
        <td style="background:${sheets > 0 ? '#fffbeb' : '#ffffff'};">
          <div style="font-weight:900;font-size:11.5px;color:#b45309;">${fmtNum(unitPrice, 2)} ج/ق</div>
          <div style="font-size:9.5px;color:#0f172a;">رصيد (${fmtNum(sheets, 0)} ق): <strong>${fmtNum(stockValue, 0)} ج</strong></div>
          ${soldValue > 0 ? `<div style="font-size:9px;color:#15803d;">مباع: ${fmtNum(soldValue, 0)} ج</div>` : ''}
        </td>
      `;
    }).join('');

    grandStockValue += rowStockVal;
    grandSalesValue += rowSalesVal;

    return `
      <tr>
        <td style="background:${isSada ? '#e0f2fe' : '#fef3c7'};font-weight:900;text-align:right;white-space:nowrap;">
          ${t.mm} مم (${isSada ? 'سدا' : 'قص'})
        </td>
        ${cellsHtml}
        <td style="background:#f1f5f9;font-weight:900;">
          <div>رصيد: ${fmtMoney(rowStockVal)}</div>
          ${rowSalesVal > 0 ? `<div style="font-size:9.5px;color:#15803d;">مباع: ${fmtMoney(rowSalesVal)}</div>` : ''}
        </td>
      </tr>
    `;
  }).join('');

  return `
    <table class="pdf-report-table">
      <thead>
        <tr>
          <th style="text-align:right;">التخانة والاتجاه \\ الجودة</th>
          ${grades.map(g => `<th>${g.code}<br/><span style="font-size:9px;font-weight:600;">${g.name}</span></th>`).join('')}
          <th>إجمالي قيمة الصف</th>
        </tr>
      </thead>
      <tbody>
        ${rowsHtml}
      </tbody>
      <tfoot>
        <tr style="background:#fef3c7;font-weight:900;">
          <td style="text-align:right;">إجمالي القيمة بالعمود</td>
          ${grades.map(g => `
            <td>
              <div>${fmtMoney(colTotals[g.id].stockValue)}</div>
              ${colTotals[g.id].salesValue > 0 ? `<div style="font-size:9px;color:#15803d;">مباع: ${fmtMoney(colTotals[g.id].salesValue)}</div>` : ''}
            </td>
          `).join('')}
          <td style="background:#fde68a;font-size:11.5px;">
            <div>رصيد: ${fmtMoney(grandStockValue)}</div>
            <div style="font-size:9.5px;color:#15803d;">مباع: ${fmtMoney(grandSalesValue)}</div>
          </td>
        </tr>
      </tfoot>
    </table>
  `;
}

function printVeneerQuantitiesMatrixPdf() {
  const woodLabel = veneerFilterWood === 'all'
    ? 'جميع أنواع القشرة الخشبية (250×125 سم)'
    : ((state.catalog?.woodTypes || []).find(w => w.id === veneerFilterWood)?.name || 'قشرة خشبية');
  triggerOfficialReportPdf(
    '📊 جدول أرصدة كميات القشرة الخشبية بالمخزن (تخانات قص / سدا × درجات الجودة)',
    `نطاق الفلتر: ${woodLabel} — مقاس الفرخ القياسي: 250×125 سم (3.125 م²)`,
    buildVeneerQuantitiesMatrixPrintHtml(),
    true
  );
}

function printVeneerPricesMatrixPdf() {
  if (!canSeeFinancialPrices()) return;
  const woodLabel = veneerFilterWood === 'all'
    ? 'جميع أنواع القشرة الخشبية (250×125 سم)'
    : ((state.catalog?.woodTypes || []).find(w => w.id === veneerFilterWood)?.name || 'قشرة خشبية');
  triggerOfficialReportPdf(
    '💰 جدول أسعار القطعة وتقييم المخزون والمبيعات (تخانات قص / سدا × درجات الجودة)',
    `نطاق الفلتر: ${woodLabel}`,
    buildVeneerPricesMatrixPrintHtml(),
    true
  );
}

function printBothMatricesPdf() {
  const qtyHtml = buildVeneerQuantitiesMatrixPrintHtml();
  const pricesHtml = canSeeFinancialPrices() ? `
    <div style="margin-top:12px;page-break-inside:avoid;">
      <h3 style="margin:0 0 6px;font-size:13px;color:#b45309;">💰 ثانياً: جدول أسعار القطعة وتقييم المخزون والمبيعات</h3>
      ${buildVeneerPricesMatrixPrintHtml()}
    </div>
  ` : '';
  triggerOfficialReportPdf(
    '📊 التقرير الشامل: جدول كميات القشرة + جدول الأسعار وتقييم المخزون',
    'مقاس الفرخ القياسي: 250×125 سم (3.125 م²)',
    `<h3 style="margin:0 0 6px;font-size:13px;color:#0f766e;">📦 أولاً: جدول أرصدة كميات القشرة الخشبية (بالقطعة والمتر المكعب)</h3>${qtyHtml}${pricesHtml}`,
    true
  );
}

function printPalletsInventoryPdf() {
  const showPrices = canSeeFinancialPrices();
  const pallets = (state.pallets || []).filter(p => p.status === 'in_stock' && Number(p.sheetsCount || 0) > 0);
  const bodyHtml = `
    <table class="pdf-report-table">
      <thead>
        <tr>
          <th>#</th>
          <th>كود البالتة</th>
          <th>نوع الخشب</th>
          <th>المقاس (العرض×الطول)</th>
          <th>التخانة والاتجاه</th>
          <th>درجة الجودة</th>
          <th>عدد الأفرخ</th>
          <th>المساحة (م²)</th>
          <th>الحجم (م³)</th>
          ${showPrices ? '<th>سعر القطعة</th><th>إجمالي القيمة</th>' : ''}
          <th>التاريخ / البيان</th>
        </tr>
      </thead>
      <tbody>
        ${pallets.map((p, i) => `
          <tr>
            <td>${i + 1}</td>
            <td><strong>${p.palletCode}</strong></td>
            <td>${p.woodTypeName}</td>
            <td><strong>${formatVeneerDimensions(p.lengthCm, p.widthCm, true)}</strong></td>
            <td><strong>${p.thicknessMm} مم (${p.direction === 'sada' ? 'سدا' : 'قص'})</strong></td>
            <td><strong>${p.gradeCode || p.gradeName}</strong></td>
            <td><strong>${fmtNum(p.sheetsCount, 0)} قطعة</strong></td>
            <td>${fmtNum(p.areaM2, 2)} م²</td>
            <td><strong>${fmtNum(p.volumeM3, 4)} م³</strong></td>
            ${showPrices ? `<td>${fmtNum(p.unitSheetPrice || getCellUnitPrice(p.thicknessId, p.gradeId, p.thicknessMm, p.direction), 2)} ج</td><td><strong>${fmtMoney(p.totalValue)}</strong></td>` : ''}
            <td>${p.entryDate || fmtDate(p.createdAt)} — ${sanitizeTextForWarehouseKeeper(p.batchNumber || '')}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
  triggerOfficialReportPdf('🪵 تقرير سجل البالتات المتاحة بمخزن القشرة التامة', `إجمالي البالتات المتاحة: ${pallets.length} بالتة`, bodyHtml, true);
}

function printSalesReturnsReportPdf() {
  const showPrices = canSeeFinancialPrices();
  const returns = state.salesReturns || [];
  const bodyHtml = `
    <table class="pdf-report-table">
      <thead>
        <tr>
          <th>رقم المرتجع</th>
          <th>التاريخ</th>
          <th>العميل</th>
          <th>المقاس (سم)</th>
          <th>التخانة والاتجاه</th>
          <th>الجودة</th>
          <th>الكمية (قطعة)</th>
          <th>الحجم (م³)</th>
          ${showPrices ? '<th>القيمة المالية</th>' : ''}
          <th>الحالة والاعتماد</th>
        </tr>
      </thead>
      <tbody>
        ${returns.map(r => `
          <tr>
            <td><strong>${r.returnNumber}</strong></td>
            <td>${r.date}</td>
            <td><strong>${r.clientName || '-'}</strong></td>
            <td><strong>${formatVeneerDimensions(r.lengthCm, r.widthCm, false)}</strong></td>
            <td>${r.thkMm} مم (${r.direction === 'sada' ? 'سدا' : 'قص'})</td>
            <td>${r.gradeCode || r.gradeName}</td>
            <td><strong>${fmtNum(r.sheetsCount, 0)} قطعة</strong></td>
            <td>${fmtNum(r.volumeM3, 4)} م³</td>
            ${showPrices ? `<td><strong>${fmtMoney(r.totalReturnAmount || 0)}</strong></td>` : ''}
            <td>${r.status === 'approved' ? '✅ معتمد ودخل المخزن (' + (r.approvedBy || '') + ')' : r.status === 'rejected' ? '❌ مرفوض' : '⏳ بانتظار الموافقة'}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
  triggerOfficialReportPdf('🔄 تقرير سجل مرتجعات المبيعات وحالة اعتمادها', `إجمالي السجلات: ${returns.length}`, bodyHtml, false);
}

function printRawMaterialsReportPdf() {
  const showPrices = canSeeFinancialPrices();
  const items = state.rawMaterials || [];
  const bodyHtml = `
    <table class="pdf-report-table">
      <thead>
        <tr>
          <th>الكود</th>
          <th>الصنف / المادة الخام</th>
          <th>الفئة</th>
          <th>الرصيد المتاح</th>
          <th>الوحدة</th>
          ${showPrices ? '<th>تكلفة الوحدة</th><th>إجمالي القيمة</th>' : ''}
          <th>المورد</th>
        </tr>
      </thead>
      <tbody>
        ${items.map(rm => `
          <tr>
            <td><strong>${rm.code}</strong></td>
            <td><strong>${rm.name}</strong></td>
            <td>${rm.category}</td>
            <td><strong>${fmtNum(rm.quantity, 2)}</strong></td>
            <td>${rm.unit}</td>
            ${showPrices ? `<td>${fmtMoney(rm.unitCost)}</td><td><strong>${fmtMoney(Number(rm.quantity || 0) * Number(rm.unitCost || 0))}</strong></td>` : ''}
            <td>${rm.supplierName || '-'}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
  triggerOfficialReportPdf('🪵 تقرير جرد مخزن الخامات ومستلزمات الإنتاج', `إجمالي الأصناف: ${items.length}`, bodyHtml, false);
}

function printScrapReportPdf() {
  const showPrices = canSeeFinancialPrices();
  const items = state.scrapItems || [];
  const bodyHtml = `
    <table class="pdf-report-table">
      <thead>
        <tr>
          <th>الكود</th>
          <th>نوع الهالك / المخلفات</th>
          <th>المصدر</th>
          <th>الكمية المتاحة</th>
          <th>الوحدة</th>
          ${showPrices ? '<th>السعر التقديري للوحدة</th><th>القيمة التقديرية</th>' : ''}
        </tr>
      </thead>
      <tbody>
        ${items.map(sc => `
          <tr>
            <td><strong>${sc.code}</strong></td>
            <td><strong>${sc.name}</strong></td>
            <td>${sc.source}</td>
            <td><strong>${fmtNum(sc.quantity, 2)}</strong></td>
            <td>${sc.unit}</td>
            ${showPrices ? `<td>${fmtMoney(sc.estimatedUnitPrice)}</td><td><strong>${fmtMoney(Number(sc.quantity || 0) * Number(sc.estimatedUnitPrice || 0))}</strong></td>` : ''}
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
  triggerOfficialReportPdf('♻️ تقرير جرد مخزن الهالك ومخلفات التصنيع', `إجمالي الأصناف: ${items.length}`, bodyHtml, false);
}

function printSparePartsReportPdf() {
  const showPrices = canSeeFinancialPrices();
  const items = state.spareParts || [];
  const bodyHtml = `
    <table class="pdf-report-table">
      <thead>
        <tr>
          <th>الكود</th>
          <th>اسم قطعة الغيار</th>
          <th>الماكينة / القسم</th>
          <th>الرصيد الحالي</th>
          <th>الحد الأدنى</th>
          <th>الوحدة</th>
          ${showPrices ? '<th>سعر الوحدة</th><th>إجمالي القيمة</th>' : ''}
        </tr>
      </thead>
      <tbody>
        ${items.map(sp => `
          <tr>
            <td><strong>${sp.code}</strong></td>
            <td><strong>${sp.name}</strong></td>
            <td>${sp.machine}</td>
            <td><strong>${fmtNum(sp.quantity, 0)}</strong></td>
            <td>${sp.minStock}</td>
            <td>${sp.unit}</td>
            ${showPrices ? `<td>${fmtMoney(sp.unitCost)}</td><td><strong>${fmtMoney(Number(sp.quantity || 0) * Number(sp.unitCost || 0))}</strong></td>` : ''}
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
  triggerOfficialReportPdf('⚙️ تقرير جرد مخزن قطع الغيار والمهمات الفنية', `إجمالي الأصناف: ${items.length}`, bodyHtml, false);
}

function printWarehouseMovementsReportPdf() {
  const movs = state.warehouseMovements || [];
  const bodyHtml = `
    <table class="pdf-report-table">
      <thead>
        <tr>
          <th>رقم الإذن</th>
          <th>التاريخ</th>
          <th>المخزن</th>
          <th>نوع الحركة</th>
          <th>البيان والتفاصيل</th>
          <th>الكمية</th>
          <th>المنفذ / المعتمد</th>
        </tr>
      </thead>
      <tbody>
        ${movs.map(m => `
          <tr>
            <td><strong>${m.voucherNumber}</strong></td>
            <td>${fmtDate(m.date)}</td>
            <td>${m.warehouseLabel}</td>
            <td><strong>${m.directionLabel}</strong></td>
            <td style="text-align:right;">${sanitizeTextForWarehouseKeeper(m.itemSummary)}</td>
            <td><strong>${sanitizeTextForWarehouseKeeper(m.quantitySummary)}</strong></td>
            <td>${m.performedBy || '-'} / ${m.approvedBy || '-'}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
  triggerOfficialReportPdf('🔄 تقرير سجل حركات المخازن (إضافة إنتاج / مرتجعات / خروج مبيعات / إعادة تشغيل)', `إجمالي الحركات: ${movs.length}`, bodyHtml, true);
}

function printAllProductionOrdersReportPdf() {
  const showPrices = canSeeFinancialPrices();
  const orders = (state.productionOrders || []).filter(o => canUserSeeOrderInPrep(currentUser, o));
  const bodyHtml = `
    <table class="pdf-report-table">
      <thead>
        <tr>
          <th>رقم الطلبية</th>
          <th>التاريخ</th>
          <th>العميل وكوده</th>
          <th>الأصناف والكميات (التخانة × الجودة × القطع)</th>
          <th>إجمالي القطع والمتر المكعب</th>
          ${showPrices ? '<th>الصافي المالي</th>' : ''}
          <th>المرحلة وحالة الصرف</th>
        </tr>
      </thead>
      <tbody>
        ${orders.map(o => `
          <tr>
            <td><strong>${o.orderNumber}</strong></td>
            <td>${o.date || fmtDate(o.createdAt)}</td>
            <td><strong>${o.clientName}</strong> (${o.clientCode || 'CL'})</td>
            <td style="text-align:right;">
              ${(o.items || []).map(it => `${it.thicknessMm}مم (${it.direction === 'sada' ? 'سدا' : 'قص'}) × ${it.gradeName} [${formatVeneerDimensions(it.lengthCm, it.widthCm, false)}]: <strong>${it.sheetsCount} قطعة</strong>${showPrices ? ' × ' + fmtNum(it.unitPrice, 2) + ' ج' : ''}`).join('<br/>')}
            </td>
            <td><strong>${fmtNum(o.totalSheetsCount || 0, 0)} قطعة</strong><br/>(${fmtNum(o.totalVolumeM3 || 0, 4)} م³)</td>
            ${showPrices ? `<td><strong>${fmtMoney(o.netTotalAmount || 0)}</strong></td>` : ''}
            <td>${o.stage === 'completed' ? '✅ تم الصرف وتحميل السيارة' : o.stage === 'ready_for_car_dispatch' ? '🚚 جاهز لتحميل السيارة' : o.stage === 'pending_accountant_release' ? '💳 بانتظار اعتماد المحاسب' : o.stage === 'pending_warehouse_prep' ? '📦 قيد التجهيز بالمخزن' : '⏳ قيد موافقة الإدارة'}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
  triggerOfficialReportPdf('📋 تقرير سجل أوامر تجهيز طلبيات العملاء', `إجمالي الأوامر المعروضة: ${orders.length}`, bodyHtml, true);
}

function printAllApprovalsDispatchReportPdf() {
  const showPrices = canSeeFinancialPrices();
  const releaseOrders = (state.productionOrders || []).filter(o => {
    const st = o.stage || o.status;
    return st === 'pending_accountant_release' || st === 'ready_for_car_dispatch' || st === 'completed';
  });
  const bodyHtml = `
    <table class="pdf-report-table">
      <thead>
        <tr>
          <th>رقم الطلبية</th>
          <th>التاريخ</th>
          <th>العميل</th>
          <th>إجمالي الكمية</th>
          ${showPrices ? '<th>صافي القيمة</th><th>المدفوع / المتبقي</th>' : ''}
          <th>بيانات السيارة والسائق</th>
          <th>البالتات</th>
          <th>الحالة</th>
        </tr>
      </thead>
      <tbody>
        ${releaseOrders.map(o => {
          const car = o.carDispatchVoucher || {};
          return `
            <tr>
              <td><strong>${o.orderNumber}</strong></td>
              <td>${o.date}</td>
              <td><strong>${o.clientName}</strong></td>
              <td><strong>${fmtNum(o.totalSheetsCount || 0, 0)} قطعة</strong> (${fmtNum(o.totalVolumeM3 || 0, 4)} م³)</td>
              ${showPrices ? `
                <td><strong>${fmtMoney(o.netTotalAmount || 0)}</strong></td>
                <td>مدفوع: ${fmtMoney(o.financialSettlement?.paidAmount || 0)}<br/>متبقي: ${fmtMoney(o.financialSettlement?.remainingDebt || 0)}</td>
              ` : ''}
              <td>${car.carPlateNumber ? `سيارة: <strong>${car.carPlateNumber}</strong><br/>سائق: ${car.driverName || '-'}` : 'لم تحمل بعد'}</td>
              <td>مسلم: ${car.palletsDeliveredCount || 0} | مستلم: ${car.palletsReceivedCount || 0}</td>
              <td>${o.stage === 'completed' ? '✅ مكتمل' : o.stage === 'ready_for_car_dispatch' ? '🚚 جاهز للسيارة' : '💳 بانتظار المحاسب'}</td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;
  triggerOfficialReportPdf('✅ تقرير أذون الصرف المعتمدة وأوامر تحميل السيارات', `إجمالي الأذون: ${releaseOrders.length}`, bodyHtml, true);
}

function printAllClientsAccountingReportPdf() {
  if (!canSeeFinancialPrices()) return;
  const allClients = (state.partners || []).filter(p => p.type !== 'supplier');
  const rows = allClients.map(c => ({ partner: c, m: computeClientMetrics(c) }));
  const bodyHtml = `
    <table class="pdf-report-table">
      <thead>
        <tr>
          <th>كود العميل</th>
          <th>اسم العميل</th>
          <th>التليفون / المدينة</th>
          <th>عدد الطلبيات</th>
          <th>إجمالي المسحوبات (مدين)</th>
          <th>إجمالي المدفوعات (دائن)</th>
          <th>صافي المديونية / المستحقات</th>
          <th>رصيد البالتات طرف العميل</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(({ partner: pt, m }) => `
          <tr>
            <td><strong>${pt.code || 'CL'}</strong></td>
            <td><strong>${pt.name}</strong></td>
            <td>${pt.phone || '-'} / ${pt.city || '-'}</td>
            <td>${m.orders.length} طلبية</td>
            <td>${fmtMoney(m.totalDebit)}</td>
            <td>${fmtMoney(m.totalCredit)}</td>
            <td><strong>${m.netDebt > 0 ? 'مدين (عليه): ' + fmtMoney(m.netDebt) : m.netDebt < 0 ? 'دائن (له): ' + fmtMoney(Math.abs(m.netDebt)) : 'خالص (0 ج.م)'}</strong></td>
            <td><strong>${m.netPalletsAtClient} بالتة</strong> (مسلم: ${m.palletsDelivered} / مستلم: ${m.palletsReceived})</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
  triggerOfficialReportPdf('🤝 التقرير المالي الشامل لحسابات ومديونيات العملاء وأرصدة البالتات', `إجمالي العملاء: ${rows.length}`, bodyHtml, true);
}

function printAllFinancialTransactionsReportPdf() {
  if (!canSeeFinancialPrices()) return;
  const txs = state.financialTransactions || [];
  const bodyHtml = `
    <table class="pdf-report-table">
      <thead>
        <tr>
          <th>رقم المستند</th>
          <th>التاريخ</th>
          <th>العميل / الجهة</th>
          <th>النوع</th>
          <th>البيان</th>
          <th>الإجمالي</th>
          <th>المدفوع</th>
          <th>المتبقي</th>
        </tr>
      </thead>
      <tbody>
        ${txs.map(tx => `
          <tr>
            <td><strong>${tx.voucherNo}</strong></td>
            <td>${tx.date}</td>
            <td><strong>${tx.partnerName || '-'}</strong></td>
            <td>${tx.typeLabel || '-'}</td>
            <td style="text-align:right;">${tx.description || '-'}</td>
            <td><strong>${fmtMoney(tx.totalAmount)}</strong></td>
            <td>${fmtMoney(tx.paidAmount)}</td>
            <td><strong>${fmtMoney(tx.remainingAmount)}</strong></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
  triggerOfficialReportPdf('💰 تقرير سجل الفواتير والتحصيلات والمعاملات المالية', `إجمالي المعاملات: ${txs.length}`, bodyHtml, true);
}

function printAllPalletMovementsReportPdf() {
  const pms = state.palletMovements || [];
  const bodyHtml = `
    <table class="pdf-report-table">
      <thead>
        <tr>
          <th>التاريخ</th>
          <th>العميل وكوده</th>
          <th>بالتات مسلمة للعميل</th>
          <th>بالتات مستلمة من العميل</th>
          <th>السيارة / الملاحظات</th>
          <th>بواسطة</th>
        </tr>
      </thead>
      <tbody>
        ${pms.map(pm => `
          <tr>
            <td>${pm.date}</td>
            <td><strong>${pm.clientName}</strong> (${pm.clientCode || 'CL'})</td>
            <td><strong>+${pm.deliveredCount || 0}</strong></td>
            <td><strong>-${pm.receivedCount || 0}</strong></td>
            <td>${pm.notes || pm.carPlateNumber || '-'}</td>
            <td>${pm.createdBy || '-'}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
  triggerOfficialReportPdf('🪵 تقرير سجل حركة البالتات الخشبية مع العملاء', `إجمالي الحركات: ${pms.length}`, bodyHtml, false);
}

function printGeneralInventoryAndAuditReportPdf() {
  const showPrices = canSeeFinancialPrices();
  const woodSummary = (state.catalog?.woodTypes || []).map(wt => {
    const pallets = (state.pallets || []).filter(p => p.woodTypeId === wt.id && p.status === 'in_stock');
    const sheets = pallets.reduce((s, p) => s + Number(p.sheetsCount || 0), 0);
    const m3 = pallets.reduce((s, p) => s + Number(p.volumeM3 || 0), 0);
    const val = pallets.reduce((s, p) => s + Number(p.totalValue || 0), 0);
    return { name: wt.name, palletsCount: pallets.length, sheets, m3, val };
  });
  const bodyHtml = `
    <h3 style="margin:0 0 6px;font-size:13px;color:#0f766e;">1️⃣ ملخص جرد القشرة الخشبية حسب النوع</h3>
    <table class="pdf-report-table">
      <thead>
        <tr>
          <th>نوع الخشب</th>
          <th>عدد البالتات المتاحة</th>
          <th>إجمالي عدد الأفرخ (250×125)</th>
          <th>إجمالي الحجم (م³)</th>
          ${showPrices ? '<th>القيمة السوقية التقديرية</th>' : ''}
        </tr>
      </thead>
      <tbody>
        ${woodSummary.map(ws => `
          <tr>
            <td><strong>${ws.name}</strong></td>
            <td>${ws.palletsCount} بالتة</td>
            <td><strong>${fmtNum(ws.sheets, 0)} فرخ</strong></td>
            <td><strong>${fmtNum(ws.m3, 4)} م³</strong></td>
            ${showPrices ? `<td><strong>${fmtMoney(ws.val)}</strong></td>` : ''}
          </tr>
        `).join('')}
      </tbody>
    </table>
    <h3 style="margin:10px 0 6px;font-size:13px;color:#0f766e;">2️⃣ جدول أرصدة كميات القشرة التفصيلي (التخانات × الجودات)</h3>
    ${buildVeneerQuantitiesMatrixPrintHtml()}
  `;
  triggerOfficialReportPdf('📈 التقرير العام لجرد القشرة الخشبية بالمخازن', 'شامل ملخص الأنواع وجدول كميات التخانات والجودات', bodyHtml, true);
}

function printAuditLogReportPdf() {
  const logs = (state.auditLogs || []).filter(l => canUserSeeNotification(currentUser, l)).slice(0, 60);
  const bodyHtml = `
    <table class="pdf-report-table">
      <thead>
        <tr>
          <th>التوقيت</th>
          <th>المستخدم</th>
          <th>الوظيفة</th>
          <th>العملية المنفذة</th>
        </tr>
      </thead>
      <tbody>
        ${logs.map(l => `
          <tr>
            <td>${new Date(l.timestamp).toLocaleString('ar-EG')}</td>
            <td><strong>${l.userName}</strong></td>
            <td>${l.roleTitle}</td>
            <td style="text-align:right;">${sanitizeTextForWarehouseKeeper(l.action)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
  triggerOfficialReportPdf('🛡️ تقرير سجل الرقابة والحركات الإدارية (Audit Log)', `آخر ${logs.length} حركة مسجلة`, bodyHtml, false);
}

// Backup & CSV Export
function downloadBackupJson() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `al_asimah_factory_backup_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
}

function exportPalletsCsv() {
  const showPrices = canSeeFinancialPrices();
  const rows = [
    showPrices
      ? ['كود البالتة', 'نوع الخشب', 'الطول سم', 'العرض سم', 'التخانة مم', 'درجة الجودة', 'عدد الأفرخ', 'المساحة م2', 'الحجم م3', 'القيمة', 'الحالة']
      : ['كود البالتة', 'نوع الخشب', 'الطول سم', 'العرض سم', 'التخانة مم', 'درجة الجودة', 'عدد الأفرخ', 'المساحة م2', 'الحجم م3', 'الحالة']
  ];
  for (const p of (state.pallets || [])) {
    rows.push(
      showPrices
        ? [
            p.palletCode,
            p.woodTypeName,
            p.lengthCm,
            p.widthCm,
            p.thicknessMm,
            p.gradeName,
            p.sheetsCount,
            p.areaM2,
            p.volumeM3,
            p.totalValue,
            p.status === 'in_stock' ? 'متاح' : 'منصرف'
          ]
        : [
            p.palletCode,
            p.woodTypeName,
            p.lengthCm,
            p.widthCm,
            p.thicknessMm,
            p.gradeName,
            p.sheetsCount,
            p.areaM2,
            p.volumeM3,
            p.status === 'in_stock' ? 'متاح' : 'منصرف'
          ]
    );
  }
  const csvContent = '\uFEFF' + rows.map(r => r.join(',')).join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `jerd_qeshra_al_asimah_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
}

// ============================================================================
// EXECUTIVE & PROJECTS MANAGER: EDIT OR DELETE ANY RECORD WITH AUTOMATIC STOCK RESTORATION
// ============================================================================
function markRecordIdDeleted(id) {
  if (!id) return;
  state.deletedIds = state.deletedIds || [];
  if (!state.deletedIds.includes(id)) {
    state.deletedIds.push(id);
  }
}

// 1) Delete Order / Client Statement with Full Automatic Warehouse Stock & Financial Restoration
function deleteOrderWithStockRestore(orderId) {
  if (!isFullAdmin(currentUser)) {
    alert('⛔ هذه الصلاحية مخصصة للمدير التنفيذي أو مدير المشروعات فقط.');
    return;
  }
  const ord = (state.productionOrders || []).find(o => o.id === orderId);
  if (!ord) return;

  const isCompletedOrDeducted = Boolean(ord.stockDeducted || ord.stage === 'completed' || ord.status === 'completed');
  const msg = isCompletedOrDeducted
    ? `⚠️ تأكيد حذف الطلبية والبيان رقم (${ord.orderNumber}) للعميل (${ord.clientName})؟\n\n🔄 نظراً لأن الطلبية تم خصمها/صرفها من المخزن، سيقوم النظام تلقائياً بإرجاع كامل كمياتها (${ord.totalSheetsCount || 0} قطعة) إلى خلايا المخزن، وحذف إذن الصرف والفاتورة المرتبطة بها فوراً!`
    : `⚠️ هل أنت متأكد من حذف بيان وأمر تجهيز الطلبية رقم (${ord.orderNumber}) للعميل (${ord.clientName}) نهائياً؟`;

  if (!confirm(msg)) return;

  // Restore warehouse stock if order was already deducted/dispatched/completed
  if (isCompletedOrDeducted) {
    for (const it of (ord.items || [])) {
      const sh = Number(it.sheetsCount || 0);
      if (sh > 0) {
        const thkId = it.thicknessId || `th-${it.thicknessMm}-${it.direction || 'qas'}`;
        addSheetsToCellPallets(
          thkId,
          it.gradeId,
          it.woodTypeId || 'wt-general',
          sh,
          `إرجاع رصيد لحذف الطلبية ${ord.orderNumber}`,
          todayStr(),
          Number(it.unitPrice || 0),
          Number(it.lengthCm || 250),
          Number(it.widthCm || 125)
        );
      }
    }
  }

  // Remove linked warehouse movements
  const carVoucherNo = ord.carDispatchVoucher?.voucherNo || `CAR-${ord.orderNumber}`;
  (state.warehouseMovements || []).forEach(m => {
    if (m.voucherNumber === carVoucherNo || m.voucherNumber === `CAR-${ord.orderNumber}`) {
      markRecordIdDeleted(m.id);
    }
  });
  state.warehouseMovements = (state.warehouseMovements || []).filter(m => m.voucherNumber !== carVoucherNo && m.voucherNumber !== `CAR-${ord.orderNumber}`);

  // Remove linked pallet movements
  (state.palletMovements || []).forEach(pm => {
    if (pm.orderId === ord.id || pm.voucherNo === carVoucherNo) {
      markRecordIdDeleted(pm.id);
    }
  });
  state.palletMovements = (state.palletMovements || []).filter(pm => pm.orderId !== ord.id && pm.voucherNo !== carVoucherNo);

  // Remove linked financial invoice & reverse any paid amount from treasury
  (state.financialTransactions || []).forEach(tx => {
    if (tx.orderId === ord.id || tx.voucherNo === `INV-${ord.orderNumber}`) {
      const paid = Number(tx.paidAmount || 0);
      if (paid > 0 && state.treasuryBalances) {
        const pm = tx.paymentMethod || '';
        if (pm.includes('بنك')) {
          state.treasuryBalances.bankAccount = Math.max(0, Number(state.treasuryBalances.bankAccount || 0) - paid);
        } else if (pm.includes('شيك')) {
          state.treasuryBalances.checksUnderCollection = Math.max(0, Number(state.treasuryBalances.checksUnderCollection || 0) - paid);
        } else {
          state.treasuryBalances.cashVault = Math.max(0, Number(state.treasuryBalances.cashVault || 0) - paid);
        }
      }
      markRecordIdDeleted(tx.id);
    }
  });
  state.financialTransactions = (state.financialTransactions || []).filter(tx => tx.orderId !== ord.id && tx.voucherNo !== `INV-${ord.orderNumber}`);

  // Finally remove order itself
  markRecordIdDeleted(ord.id);
  state.productionOrders = (state.productionOrders || []).filter(o => o.id !== ord.id);

  closeModal();
  saveState(`🗑️ قام ${currentUser.name} بحذف بيان الطلبية (${ord.orderNumber}) للعميل (${ord.clientName})${isCompletedOrDeducted ? ' وإرجاع كامل أرصدتها إلى المخزن تلقائياً' : ''}`);
}

// 2) Edit & Delete Warehouse Movements with Automatic Stock Adjustment / Restoration
function openEditWarehouseMovementModal(movId) {
  if (!isFullAdmin(currentUser)) return;
  const mov = (state.warehouseMovements || []).find(m => m.id === movId);
  if (!mov) return;
  const modalRoot = document.getElementById('modal-root');
  const isVeneer = mov.warehouseType === 'finished_veneers' && mov.cellKey;

  modalRoot.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal-box" style="max-width:560px;">
        <div class="card-header">
          <div>
            <div class="card-title">✏️ تعديل حركة مخزنية (${mov.voucherNumber}) — مع تحديث رصيد المخزن تلقائياً</div>
            <small style="color:var(--text-muted);">${mov.warehouseLabel} | ${mov.directionLabel}</small>
          </div>
          <button class="btn btn-sm btn-outline" onclick="closeModal()">✕</button>
        </div>

        <form onsubmit="submitEditWarehouseMovementModal(event, '${mov.id}')">
          <div class="form-grid">
            <div class="form-group">
              <label>تاريخ الحركة</label>
              <input id="emov-date" type="date" class="form-control" value="${mov.date || todayStr()}" required />
            </div>
            <div class="form-group">
              <label>رقم الإذن / المرجع</label>
              <input id="emov-vno" class="form-control" value="${mov.voucherNumber || ''}" required />
            </div>
            ${isVeneer ? `
              <div class="form-group">
                <label style="color:var(--primary);font-weight:800;">📦 الكمية بالقطع (تعديلها يعدل رصيد المخزن تلقائياً)</label>
                <input id="emov-sheets" type="number" min="1" class="form-control" value="${mov.sheetsCount || 0}" required style="font-weight:800;border-color:var(--primary);" />
              </div>
              <div class="form-group">
                <label>💰 سعر القطعة (ج.م)</label>
                <input id="emov-price" type="number" step="0.5" min="0" class="form-control" value="${mov.unitSheetPrice || 0}" />
              </div>
            ` : `
              <div class="form-group" style="grid-column: 1 / -1;">
                <label>الكمية والوصف</label>
                <input id="emov-qtysum" class="form-control" value="${mov.quantitySummary || ''}" required />
              </div>
            `}
            <div class="form-group" style="grid-column: 1 / -1;">
              <label>بيان الحركة التفصيلي</label>
              <input id="emov-summary" class="form-control" value="${mov.itemSummary || ''}" required />
            </div>
          </div>

          <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px;">
            <button type="button" class="btn btn-outline" onclick="closeModal()">إلغاء</button>
            <button type="submit" class="btn btn-primary">💾 حفظ التعديل وتحديث رصيد المخزن</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function submitEditWarehouseMovementModal(e, movId) {
  e.preventDefault();
  if (!isFullAdmin(currentUser)) return;
  const mov = (state.warehouseMovements || []).find(m => m.id === movId);
  if (!mov) return;

  mov.date = document.getElementById('emov-date')?.value || mov.date;
  mov.voucherNumber = (document.getElementById('emov-vno')?.value || mov.voucherNumber).trim();
  mov.itemSummary = (document.getElementById('emov-summary')?.value || mov.itemSummary).trim();

  if (mov.warehouseType === 'finished_veneers' && mov.cellKey) {
    const oldSheets = Number(mov.sheetsCount || 0);
    const newSheets = Math.max(1, Number(document.getElementById('emov-sheets')?.value || oldSheets));
    const newPrice = Math.max(0, Number(document.getElementById('emov-price')?.value || mov.unitSheetPrice || 0));
    const [thkId, gradeId] = mov.cellKey.split('__');
    const diff = newSheets - oldSheets;

    if (diff !== 0 && thkId && gradeId) {
      const movLen = Number(mov.lengthCm || 250);
      const movWid = Number(mov.widthCm || 125);
      if (mov.direction === 'out') {
        if (diff > 0) {
          // Exited more -> deduct additional sheets from warehouse
          deductSheetsFromCellPallets(thkId, gradeId, 'wt-general', diff, newPrice, movLen, movWid);
        } else {
          // Exited less -> return difference back to warehouse
          addSheetsToCellPallets(thkId, gradeId, 'wt-general', Math.abs(diff), `إرجاع فرق تعديل حركة ${mov.voucherNumber}`, mov.date, newPrice, movLen, movWid);
        }
      } else {
        if (diff > 0) {
          // Entered more -> add difference to warehouse
          addSheetsToCellPallets(thkId, gradeId, 'wt-general', diff, `زيادة تعديل حركة ${mov.voucherNumber}`, mov.date, newPrice, movLen, movWid);
        } else {
          // Entered less -> deduct difference from warehouse
          deductSheetsFromCellPallets(thkId, gradeId, 'wt-general', Math.abs(diff), newPrice, movLen, movWid);
        }
      }
    }

    const tObj = (state.catalog?.thicknesses || []).find(t => t.id === thkId);
    const m = calculateVeneerMetrics(mov.lengthCm || 250, mov.widthCm || 125, tObj ? tObj.mm : 1.5, newSheets);
    mov.sheetsCount = newSheets;
    mov.unitSheetPrice = newPrice;
    mov.totalSaleAmount = +(newSheets * newPrice).toFixed(2);
    mov.quantitySummary = `${newSheets} قطعة | ${m.totalVolumeM3} م³`;
  } else {
    mov.quantitySummary = (document.getElementById('emov-qtysum')?.value || mov.quantitySummary).trim();
  }

  mov.updatedAt = new Date().toISOString();
  closeModal();
  saveState(`✏️ تعديل حركة مخزنية (${mov.voucherNumber}) بواسطة ${currentUser.name} وتحديث أرصدة المخازن تلقائياً`);
}

function deleteWarehouseMovementWithRestore(movId) {
  if (!isFullAdmin(currentUser)) return;
  const mov = (state.warehouseMovements || []).find(m => m.id === movId);
  if (!mov) return;

  if (!confirm(`⚠️ هل أنت متأكد من حذف الحركة المخزنية (${mov.voucherNumber})؟\nسيقوم النظام بعكس أثرها وإرجاع/تحديث رصيد المخزن تلقائياً!`)) return;

  if (mov.warehouseType === 'finished_veneers' && mov.cellKey) {
    const [thkId, gradeId] = mov.cellKey.split('__');
    const sh = Number(mov.sheetsCount || 0);
    if (sh > 0 && thkId && gradeId) {
      if (mov.direction === 'out') {
        // Movement was an exit -> return sheets back to warehouse!
        addSheetsToCellPallets(thkId, gradeId, 'wt-general', sh, `إرجاع رصيد لحذف حركة خروج ${mov.voucherNumber}`, todayStr(), Number(mov.unitSheetPrice || 0));
      } else {
        // Movement was an entry -> deduct those sheets from warehouse!
        deductSheetsFromCellPallets(thkId, gradeId, 'wt-general', sh, Number(mov.unitSheetPrice || 0));
      }
    }
  }

  markRecordIdDeleted(mov.id);
  state.warehouseMovements = (state.warehouseMovements || []).filter(m => m.id !== mov.id);
  saveState(`🗑️ حذف حركة مخزنية (${mov.voucherNumber}) بواسطة ${currentUser.name} وإرجاع رصيد المخزن تلقائياً`);
}

// 3) Edit & Delete Pallet Records in Warehouse
function openEditPalletModal(palletId) {
  if (!isFullAdmin(currentUser)) return;
  const p = (state.pallets || []).find(x => x.id === palletId);
  if (!p) return;
  const thicknesses = getSortedThicknesses();
  const grades = state.catalog?.grades || [];
  const modalRoot = document.getElementById('modal-root');

  modalRoot.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal-box" style="max-width:580px;">
        <div class="card-header">
          <div class="card-title">✏️ تعديل بيان بالتة قشرة (${p.palletCode})</div>
          <button class="btn btn-sm btn-outline" onclick="closeModal()">✕</button>
        </div>
        <form onsubmit="submitEditPalletModal(event, '${p.id}')">
          <div class="form-grid">
            <div class="form-group">
              <label>كود البالتة</label>
              <input id="eplt-code" class="form-control" value="${p.palletCode || ''}" required />
            </div>
            <div class="form-group">
              <label>تاريخ الدخول</label>
              <input id="eplt-date" type="date" class="form-control" value="${p.entryDate || p.createdAt || todayStr()}" required />
            </div>
            <div class="form-group">
              <label>التخانة والاتجاه (قص / سدا)</label>
              <select id="eplt-thk" class="form-control">
                ${thicknesses.map(t => `<option value="${t.id}" ${t.id === p.thicknessId ? 'selected' : ''}>${t.mm} مم (${t.direction === 'sada' ? 'سدا' : 'قص'})</option>`).join('')}
              </select>
            </div>
            <div class="form-group">
              <label>درجة الجودة</label>
              <select id="eplt-grd" class="form-control">
                ${grades.map(g => `<option value="${g.id}" ${g.id === p.gradeId ? 'selected' : ''}>${g.code}</option>`).join('')}
              </select>
            </div>
            <div class="form-group">
              <label>العرض (سم) — المعتمد 125</label>
              <input id="eplt-wid" type="number" step="0.5" min="10" class="form-control" value="${p.widthCm || 125}" required style="font-weight:800;" />
            </div>
            <div class="form-group">
              <label>الطول (سم) — المعتمد 250</label>
              <input id="eplt-len" type="number" step="0.5" min="10" class="form-control" value="${p.lengthCm || 250}" required style="font-weight:800;" />
            </div>
            <div class="form-group">
              <label>الكمية بالقطع</label>
              <input id="eplt-sheets" type="number" min="0" class="form-control" value="${p.sheetsCount || 0}" required style="font-weight:800;" />
            </div>
            <div class="form-group">
              <label>سعر القطعة الواحدة (ج.م)</label>
              <input id="eplt-price" type="number" step="0.5" min="0" class="form-control" value="${p.unitSheetPrice || 0}" />
            </div>
            <div class="form-group" style="grid-column: 1 / -1;">
              <label>الموقع المخزني</label>
              <input id="eplt-loc" class="form-control" value="${p.location || ''}" />
            </div>
          </div>
          <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px;">
            <button type="button" class="btn btn-outline" onclick="closeModal()">إلغاء</button>
            <button type="submit" class="btn btn-primary">💾 حفظ التعديل وتحديث رصيد المخزن</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function submitEditPalletModal(e, palletId) {
  e.preventDefault();
  if (!isFullAdmin(currentUser)) return;
  const p = (state.pallets || []).find(x => x.id === palletId);
  if (!p) return;

  const thkId = document.getElementById('eplt-thk')?.value || p.thicknessId;
  const grdId = document.getElementById('eplt-grd')?.value || p.gradeId;
  const tObj = (state.catalog?.thicknesses || []).find(t => t.id === thkId);
  const gObj = (state.catalog?.grades || []).find(g => g.id === grdId);
  const wid = Math.max(10, Number(document.getElementById('eplt-wid')?.value || p.widthCm || 125));
  const len = Math.max(10, Number(document.getElementById('eplt-len')?.value || p.lengthCm || 250));
  const sheets = Math.max(0, Number(document.getElementById('eplt-sheets')?.value || 0));
  const unitPrice = Math.max(0, Number(document.getElementById('eplt-price')?.value || 0));
  const m = calculateVeneerMetrics(len, wid, tObj ? tObj.mm : p.thicknessMm, sheets);
  ensureCustomDimensionInCatalog(len, wid, `تعديل بالتة ${p.palletCode}`);

  p.palletCode = (document.getElementById('eplt-code')?.value || p.palletCode).trim();
  p.entryDate = document.getElementById('eplt-date')?.value || p.entryDate;
  p.createdAt = p.entryDate;
  p.lengthCm = len;
  p.widthCm = wid;
  p.isCustomDimension = !isStandardVeneerDimension(len, wid);
  p.thicknessId = thkId;
  p.thicknessMm = tObj ? Number(tObj.mm) : p.thicknessMm;
  p.direction = tObj ? (tObj.direction || 'qas') : p.direction;
  p.gradeId = grdId;
  p.gradeName = gObj ? gObj.code : p.gradeName;
  p.sheetsCount = sheets;
  p.areaM2 = m.totalAreaM2;
  p.volumeM3 = m.totalVolumeM3;
  p.unitSheetPrice = unitPrice;
  p.totalValue = +(sheets * unitPrice).toFixed(2);
  p.location = (document.getElementById('eplt-loc')?.value || p.location).trim();
  p.status = sheets > 0 ? 'in_stock' : 'dispatched';
  p.updatedAt = new Date().toISOString();

  closeModal();
  saveState(`✏️ تعديل رصيد وبيانات البالتة (${p.palletCode}) بواسطة ${currentUser.name}`);
}

function deletePalletRecord(palletId) {
  if (!isFullAdmin(currentUser)) return;
  const p = (state.pallets || []).find(x => x.id === palletId);
  if (!p) return;
  if (!confirm(`⚠️ هل أنت متأكد من حذف البالتة (${p.palletCode}) بكمية (${p.sheetsCount} قطعة) من المخزن؟`)) return;
  markRecordIdDeleted(p.id);
  state.pallets = (state.pallets || []).filter(x => x.id !== p.id);
  saveState(`🗑️ حذف البالتة (${p.palletCode}) من المخزن بواسطة ${currentUser.name}`);
}

// 4) Edit & Delete Raw Materials, Scrap & Spare Parts
function openEditRawMaterialModal(rmId) {
  if (!isFullAdmin(currentUser)) return;
  const rm = (state.rawMaterials || []).find(r => r.id === rmId);
  if (!rm) return;
  const modalRoot = document.getElementById('modal-root');
  modalRoot.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal-box" style="max-width:520px;">
        <div class="card-header">
          <div class="card-title">✏️ تعديل رصيد وبيان خامة (${rm.name})</div>
          <button class="btn btn-sm btn-outline" onclick="closeModal()">✕</button>
        </div>
        <form onsubmit="submitEditRawMaterialModal(event, '${rm.id}')">
          <div class="form-grid">
            <div class="form-group"><label>كود الصنف</label><input id="erm-code" class="form-control" value="${rm.code || ''}" required /></div>
            <div class="form-group"><label>اسم الخامة</label><input id="erm-name" class="form-control" value="${rm.name || ''}" required /></div>
            <div class="form-group"><label>الرصيد الفعلي بالمخزن</label><input id="erm-qty" type="number" step="0.01" min="0" class="form-control" value="${rm.quantity || 0}" required style="font-weight:800;" /></div>
            <div class="form-group"><label>تكلفة الوحدة (ج.م)</label><input id="erm-cost" type="number" step="0.5" min="0" class="form-control" value="${rm.costPerUnit ?? rm.unitCost ?? 0}" required /></div>
            <div class="form-group"><label>المورد</label><input id="erm-sup" class="form-control" value="${rm.supplierName || ''}" /></div>
            <div class="form-group"><label>الموقع المخزني</label><input id="erm-loc" class="form-control" value="${rm.location || ''}" /></div>
          </div>
          <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px;">
            <button type="button" class="btn btn-outline" onclick="closeModal()">إلغاء</button>
            <button type="submit" class="btn btn-primary">💾 حفظ التعديل</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function submitEditRawMaterialModal(e, rmId) {
  e.preventDefault();
  const rm = (state.rawMaterials || []).find(r => r.id === rmId);
  if (!rm) return;
  rm.code = (document.getElementById('erm-code')?.value || rm.code).trim();
  rm.name = (document.getElementById('erm-name')?.value || rm.name).trim();
  rm.quantity = Math.max(0, Number(document.getElementById('erm-qty')?.value || 0));
  rm.costPerUnit = Math.max(0, Number(document.getElementById('erm-cost')?.value || 0));
  rm.unitCost = rm.costPerUnit;
  rm.totalValue = +(rm.quantity * rm.costPerUnit).toFixed(2);
  rm.supplierName = (document.getElementById('erm-sup')?.value || rm.supplierName).trim();
  rm.location = (document.getElementById('erm-loc')?.value || rm.location).trim();
  rm.updatedAt = new Date().toISOString();
  closeModal();
  saveState(`✏️ تعديل رصيد وبيانات الخامة (${rm.name}) بواسطة ${currentUser.name}`);
}

function deleteRawMaterialRecord(rmId) {
  if (!isFullAdmin(currentUser)) return;
  const rm = (state.rawMaterials || []).find(r => r.id === rmId);
  if (!rm) return;
  if (!confirm(`⚠️ هل أنت متأكد من حذف صنف الخامة (${rm.name}) من المخزن؟`)) return;
  markRecordIdDeleted(rm.id);
  state.rawMaterials = (state.rawMaterials || []).filter(r => r.id !== rm.id);
  saveState(`🗑️ حذف صنف الخامة (${rm.name}) بواسطة ${currentUser.name}`);
}

function openEditScrapModal(scId) {
  if (!isFullAdmin(currentUser)) return;
  const sc = (state.scrapItems || []).find(s => s.id === scId);
  if (!sc) return;
  const modalRoot = document.getElementById('modal-root');
  modalRoot.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal-box" style="max-width:520px;">
        <div class="card-header">
          <div class="card-title">✏️ تعديل بيان الهالك (${sc.name})</div>
          <button class="btn btn-sm btn-outline" onclick="closeModal()">✕</button>
        </div>
        <form onsubmit="submitEditScrapModal(event, '${sc.id}')">
          <div class="form-grid">
            <div class="form-group"><label>كود الهالك</label><input id="esc-code" class="form-control" value="${sc.code || ''}" required /></div>
            <div class="form-group"><label>بيان الهالك</label><input id="esc-name" class="form-control" value="${sc.name || ''}" required /></div>
            <div class="form-group"><label>الكمية المتاحة</label><input id="esc-qty" type="number" step="0.01" min="0" class="form-control" value="${sc.quantity || 0}" required /></div>
            <div class="form-group"><label>القيمة التقديرية للوحدة</label><input id="esc-val" type="number" step="0.5" min="0" class="form-control" value="${sc.estimatedPricePerUnit ?? sc.estimatedUnitValue ?? 0}" required /></div>
          </div>
          <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px;">
            <button type="button" class="btn btn-outline" onclick="closeModal()">إلغاء</button>
            <button type="submit" class="btn btn-primary">💾 حفظ التعديل</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function submitEditScrapModal(e, scId) {
  e.preventDefault();
  const sc = (state.scrapItems || []).find(s => s.id === scId);
  if (!sc) return;
  sc.code = (document.getElementById('esc-code')?.value || sc.code).trim();
  sc.name = (document.getElementById('esc-name')?.value || sc.name).trim();
  sc.quantity = Math.max(0, Number(document.getElementById('esc-qty')?.value || 0));
  sc.estimatedPricePerUnit = Math.max(0, Number(document.getElementById('esc-val')?.value || 0));
  sc.estimatedUnitValue = sc.estimatedPricePerUnit;
  sc.totalEstimatedValue = +(sc.quantity * sc.estimatedPricePerUnit).toFixed(2);
  sc.updatedAt = new Date().toISOString();
  closeModal();
  saveState(`✏️ تعديل بيان الهالك (${sc.name}) بواسطة ${currentUser.name}`);
}

function deleteScrapRecord(scId) {
  if (!isFullAdmin(currentUser)) return;
  const sc = (state.scrapItems || []).find(s => s.id === scId);
  if (!sc) return;
  if (!confirm(`⚠️ هل أنت متأكد من حذف سجل الهالك (${sc.name})؟`)) return;
  markRecordIdDeleted(sc.id);
  state.scrapItems = (state.scrapItems || []).filter(s => s.id !== sc.id);
  saveState(`🗑️ حذف سجل الهالك (${sc.name}) بواسطة ${currentUser.name}`);
}

function openEditSparePartModal(spId) {
  if (!isFullAdmin(currentUser)) return;
  const sp = (state.spareParts || []).find(s => s.id === spId);
  if (!sp) return;
  const modalRoot = document.getElementById('modal-root');
  modalRoot.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal-box" style="max-width:520px;">
        <div class="card-header">
          <div class="card-title">✏️ تعديل رصيد وبيان قطعة غيار (${sp.name})</div>
          <button class="btn btn-sm btn-outline" onclick="closeModal()">✕</button>
        </div>
        <form onsubmit="submitEditSparePartModal(event, '${sp.id}')">
          <div class="form-grid">
            <div class="form-group"><label>كود القطعة</label><input id="esp-code" class="form-control" value="${sp.code || ''}" required /></div>
            <div class="form-group"><label>اسم القطعة</label><input id="esp-name" class="form-control" value="${sp.name || ''}" required /></div>
            <div class="form-group"><label>الرصيد المتاح</label><input id="esp-qty" type="number" min="0" class="form-control" value="${sp.quantity || 0}" required /></div>
            <div class="form-group"><label>تكلفة الوحدة (ج.م)</label><input id="esp-cost" type="number" step="0.5" min="0" class="form-control" value="${sp.costPerUnit ?? sp.unitCost ?? 0}" required /></div>
          </div>
          <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px;">
            <button type="button" class="btn btn-outline" onclick="closeModal()">إلغاء</button>
            <button type="submit" class="btn btn-primary">💾 حفظ التعديل</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function submitEditSparePartModal(e, spId) {
  e.preventDefault();
  const sp = (state.spareParts || []).find(s => s.id === spId);
  if (!sp) return;
  sp.code = (document.getElementById('esp-code')?.value || sp.code).trim();
  sp.name = (document.getElementById('esp-name')?.value || sp.name).trim();
  sp.quantity = Math.max(0, Number(document.getElementById('esp-qty')?.value || 0));
  sp.costPerUnit = Math.max(0, Number(document.getElementById('esp-cost')?.value || 0));
  sp.unitCost = sp.costPerUnit;
  sp.totalValue = +(sp.quantity * sp.costPerUnit).toFixed(2);
  sp.updatedAt = new Date().toISOString();
  closeModal();
  saveState(`✏️ تعديل رصيد وبيانات قطعة الغيار (${sp.name}) بواسطة ${currentUser.name}`);
}

function deleteSparePartRecord(spId) {
  if (!isFullAdmin(currentUser)) return;
  const sp = (state.spareParts || []).find(s => s.id === spId);
  if (!sp) return;
  if (!confirm(`⚠️ هل أنت متأكد من حذف قطعة الغيار (${sp.name})؟`)) return;
  markRecordIdDeleted(sp.id);
  state.spareParts = (state.spareParts || []).filter(s => s.id !== sp.id);
  saveState(`🗑️ حذف قطعة الغيار (${sp.name}) بواسطة ${currentUser.name}`);
}

// 5) Edit & Delete Client Partner, Financial Transactions & Pallet Movements
function openEditPartnerModal(clientId) {
  if (!isFullAdmin(currentUser)) return;
  const pt = (state.partners || []).find(p => p.id === clientId);
  if (!pt) return;
  const modalRoot = document.getElementById('modal-root');

  modalRoot.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal-box" style="max-width:600px;">
        <div class="card-header">
          <div class="card-title">✏️ تعديل بيانات العميل والأرصدة الافتتاحية (${pt.code || 'CL'} - ${pt.name})</div>
          <button class="btn btn-sm btn-outline" onclick="closeModal()">✕</button>
        </div>
        <form onsubmit="submitEditPartnerModal(event, '${pt.id}')">
          <div class="form-grid">
            <div class="form-group"><label>كود العميل</label><input id="ept-code" class="form-control" value="${pt.code || ''}" required /></div>
            <div class="form-group"><label>اسم العميل</label><input id="ept-name" class="form-control" value="${pt.name || ''}" required /></div>
            <div class="form-group"><label>رقم التليفون</label><input id="ept-phone" class="form-control" value="${pt.phone || ''}" /></div>
            <div class="form-group"><label>المدينة / العنوان</label><input id="ept-city" class="form-control" value="${pt.city || ''}" /></div>
            <div class="form-group"><label>مديونية افتتاحية (عليه - ج.م)</label><input id="ept-debit" type="number" step="0.5" min="0" class="form-control" value="${pt.openingDebit || 0}" /></div>
            <div class="form-group"><label>رصيد دائن افتتاحي (له - ج.م)</label><input id="ept-credit" type="number" step="0.5" min="0" class="form-control" value="${pt.openingCredit || 0}" /></div>
            <div class="form-group"><label>بالتات افتتاحية مسلمة للعميل</label><input id="ept-pdel" type="number" min="0" class="form-control" value="${pt.openingPalletsDelivered || 0}" /></div>
            <div class="form-group"><label>بالتات افتتاحية مستلمة من العميل</label><input id="ept-prec" type="number" min="0" class="form-control" value="${pt.openingPalletsReceived || 0}" /></div>
          </div>
          <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px;">
            <button type="button" class="btn btn-outline" onclick="closeModal()">إلغاء</button>
            <button type="submit" class="btn btn-primary">💾 حفظ تعديل بيانات العميل</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function submitEditPartnerModal(e, clientId) {
  e.preventDefault();
  const pt = (state.partners || []).find(p => p.id === clientId);
  if (!pt) return;
  pt.code = (document.getElementById('ept-code')?.value || pt.code).trim();
  pt.name = (document.getElementById('ept-name')?.value || pt.name).trim();
  pt.phone = (document.getElementById('ept-phone')?.value || pt.phone).trim();
  pt.city = (document.getElementById('ept-city')?.value || pt.city).trim();
  pt.openingDebit = Math.max(0, Number(document.getElementById('ept-debit')?.value || 0));
  pt.openingCredit = Math.max(0, Number(document.getElementById('ept-credit')?.value || 0));
  pt.openingPalletsDelivered = Math.max(0, Number(document.getElementById('ept-pdel')?.value || 0));
  pt.openingPalletsReceived = Math.max(0, Number(document.getElementById('ept-prec')?.value || 0));
  pt.balance = +(pt.openingDebit - pt.openingCredit).toFixed(2);
  pt.updatedAt = new Date().toISOString();
  closeModal();
  saveState(`✏️ تعديل بيانات وأرصدة العميل (${pt.code} - ${pt.name}) بواسطة ${currentUser.name}`);
}

function deletePartnerRecord(clientId) {
  if (!isFullAdmin(currentUser)) return;
  const pt = (state.partners || []).find(p => p.id === clientId);
  if (!pt) return;
  if (!confirm(`⚠️ هل أنت متأكد من حذف ملف العميل (${pt.code} - ${pt.name})؟`)) return;
  markRecordIdDeleted(pt.id);
  state.partners = (state.partners || []).filter(p => p.id !== pt.id);
  closeModal();
  saveState(`🗑️ حذف ملف العميل (${pt.code} - ${pt.name}) بواسطة ${currentUser.name}`);
}

function openEditFinancialTxModal(txId) {
  if (!isFullAdmin(currentUser)) return;
  const tx = (state.financialTransactions || []).find(t => t.id === txId);
  if (!tx) return;
  const modalRoot = document.getElementById('modal-root');

  modalRoot.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal-box" style="max-width:560px;">
        <div class="card-header">
          <div class="card-title">✏️ تعديل السند المالي / الفاتورة (${tx.voucherNo})</div>
          <button class="btn btn-sm btn-outline" onclick="closeModal()">✕</button>
        </div>
        <form onsubmit="submitEditFinancialTxModal(event, '${tx.id}')">
          <div class="form-grid">
            <div class="form-group"><label>تاريخ السند</label><input id="eftx-date" type="date" class="form-control" value="${tx.date || todayStr()}" required /></div>
            <div class="form-group"><label>رقم المستند</label><input id="eftx-vno" class="form-control" value="${tx.voucherNo || ''}" required /></div>
            <div class="form-group"><label>إجمالي المبلغ (ج.م)</label><input id="eftx-total" type="number" step="0.5" min="0" class="form-control" value="${tx.totalAmount || 0}" required style="font-weight:800;" /></div>
            <div class="form-group"><label>المبلغ المدفوع / المسدد (ج.م)</label><input id="eftx-paid" type="number" step="0.5" min="0" class="form-control" value="${tx.paidAmount || 0}" required style="font-weight:800;border-color:var(--success);" /></div>
            <div class="form-group" style="grid-column: 1 / -1;"><label>البيان والتفاصيل</label><input id="eftx-desc" class="form-control" value="${tx.description || ''}" required /></div>
          </div>
          <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px;">
            <button type="button" class="btn btn-outline" onclick="closeModal()">إلغاء</button>
            <button type="submit" class="btn btn-primary">💾 حفظ التعديل وتحديث الحسابات</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function submitEditFinancialTxModal(e, txId) {
  e.preventDefault();
  const tx = (state.financialTransactions || []).find(t => t.id === txId);
  if (!tx) return;
  const oldPaid = Number(tx.paidAmount || 0);
  const newTotal = Math.max(0, Number(document.getElementById('eftx-total')?.value || 0));
  const newPaid = Math.max(0, Number(document.getElementById('eftx-paid')?.value || 0));
  const diffPaid = newPaid - oldPaid;

  tx.date = document.getElementById('eftx-date')?.value || tx.date;
  tx.voucherNo = (document.getElementById('eftx-vno')?.value || tx.voucherNo).trim();
  tx.totalAmount = newTotal;
  tx.paidAmount = newPaid;
  tx.remainingAmount = Math.max(0, +(newTotal - newPaid).toFixed(2));
  tx.description = (document.getElementById('eftx-desc')?.value || tx.description).trim();
  tx.updatedAt = new Date().toISOString();

  if (diffPaid !== 0 && state.treasuryBalances) {
    state.treasuryBalances.cashVault = Math.max(0, Number(state.treasuryBalances.cashVault || 0) + diffPaid);
  }

  closeModal();
  saveState(`✏️ تعديل السند المالي (${tx.voucherNo}) للعميل (${tx.partnerName || ''}) بواسطة ${currentUser.name}`);
}

function deleteFinancialTxRecord(txId) {
  if (!isFullAdmin(currentUser)) return;
  const tx = (state.financialTransactions || []).find(t => t.id === txId);
  if (!tx) return;
  if (!confirm(`⚠️ هل أنت متأكد من حذف السند المالي / الفاتورة (${tx.voucherNo}) بقيمة ${fmtMoney(tx.totalAmount)}؟`)) return;

  const paid = Number(tx.paidAmount || 0);
  if (paid > 0 && state.treasuryBalances) {
    state.treasuryBalances.cashVault = Math.max(0, Number(state.treasuryBalances.cashVault || 0) - paid);
  }
  markRecordIdDeleted(tx.id);
  state.financialTransactions = (state.financialTransactions || []).filter(t => t.id !== tx.id);
  closeModal();
  saveState(`🗑️ حذف السند المالي (${tx.voucherNo}) بواسطة ${currentUser.name} وتحديث رصيد العميل والخزينة`);
}

function openEditPalletMovementModal(pmId) {
  if (!isFullAdmin(currentUser)) return;
  const pm = (state.palletMovements || []).find(x => x.id === pmId);
  if (!pm) return;
  const modalRoot = document.getElementById('modal-root');

  modalRoot.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal-box" style="max-width:520px;">
        <div class="card-header">
          <div class="card-title">✏️ تعديل حركة بالتات العميل (${pm.clientName})</div>
          <button class="btn btn-sm btn-outline" onclick="closeModal()">✕</button>
        </div>
        <form onsubmit="submitEditPalletMovementModal(event, '${pm.id}')">
          <div class="form-grid">
            <div class="form-group"><label>التاريخ</label><input id="epm-date" type="date" class="form-control" value="${pm.date || todayStr()}" required /></div>
            <div class="form-group"><label>رقم السيارة</label><input id="epm-car" class="form-control" value="${pm.carPlateNumber || ''}" /></div>
            <div class="form-group"><label>بالتات مسلمة للعميل (+)</label><input id="epm-del" type="number" min="0" class="form-control" value="${pm.deliveredCount || 0}" required /></div>
            <div class="form-group"><label>بالتات مستلمة من العميل (-)</label><input id="epm-rec" type="number" min="0" class="form-control" value="${pm.receivedCount || 0}" required /></div>
            <div class="form-group" style="grid-column: 1 / -1;"><label>البيان والملاحظات</label><input id="epm-notes" class="form-control" value="${pm.notes || ''}" /></div>
          </div>
          <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px;">
            <button type="button" class="btn btn-outline" onclick="closeModal()">إلغاء</button>
            <button type="submit" class="btn btn-primary">💾 حفظ التعديل</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function submitEditPalletMovementModal(e, pmId) {
  e.preventDefault();
  const pm = (state.palletMovements || []).find(x => x.id === pmId);
  if (!pm) return;
  pm.date = document.getElementById('epm-date')?.value || pm.date;
  pm.carPlateNumber = (document.getElementById('epm-car')?.value || pm.carPlateNumber).trim();
  pm.deliveredCount = Math.max(0, Number(document.getElementById('epm-del')?.value || 0));
  pm.receivedCount = Math.max(0, Number(document.getElementById('epm-rec')?.value || 0));
  pm.notes = (document.getElementById('epm-notes')?.value || pm.notes).trim();
  pm.updatedAt = new Date().toISOString();
  closeModal();
  saveState(`✏️ تعديل حركة بالتات للعميل (${pm.clientName}) بواسطة ${currentUser.name}`);
}

function deletePalletMovementRecord(pmId) {
  if (!isFullAdmin(currentUser)) return;
  const pm = (state.palletMovements || []).find(x => x.id === pmId);
  if (!pm) return;
  if (!confirm(`⚠️ هل أنت متأكد من حذف حركة البالتات للعميل (${pm.clientName})؟`)) return;
  markRecordIdDeleted(pm.id);
  state.palletMovements = (state.palletMovements || []).filter(x => x.id !== pm.id);
  closeModal();
  saveState(`🗑️ حذف حركة بالتات للعميل (${pm.clientName}) بواسطة ${currentUser.name}`);
}

// Initialize
initTheme();
loadData();
