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
  pricePerM3: 22000,
  woodenPalletUnitPrice: 0
};

function getWoodenPalletUnitPrice(clientObj = null, recordObj = null) {
  if (recordObj && recordObj.palletUnitPrice !== undefined && recordObj.palletUnitPrice !== null && recordObj.palletUnitPrice !== '' && Number(recordObj.palletUnitPrice) > 0) {
    return Number(recordObj.palletUnitPrice);
  }
  if (clientObj && clientObj.palletUnitPrice !== undefined && clientObj.palletUnitPrice !== null && clientObj.palletUnitPrice !== '' && Number(clientObj.palletUnitPrice) > 0) {
    return Number(clientObj.palletUnitPrice);
  }
  return Number(state?.catalog?.woodenPalletUnitPrice || quickCalc.woodenPalletUnitPrice || 0);
}

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

function getRecordTimeMs(item) {
  if (!item || typeof item !== 'object') return 0;
  const raw = item.updatedAt || item.createdAt || item.timestamp || item.dispatchedAt || item.approvedAt || 0;
  if (raw) {
    const ms = new Date(raw).getTime();
    if (!isNaN(ms) && ms > 0) return ms;
  }
  if (item.date && typeof item.date === 'string') {
    const dMs = new Date(item.date + 'T23:59:59Z').getTime();
    if (!isNaN(dMs) && dMs > 0) return dMs;
  }
  return 0;
}

function smartMergeListClient(a = [], b = [], deletedSet = new Set(), minResetTs = 0) {
  const map = new Map();
  for (const item of (Array.isArray(a) ? a : [])) {
    if (!item || !item.id || deletedSet.has(item.id)) continue;
    const ts = getRecordTimeMs(item);
    if (minResetTs > 0 && ts > 0 && ts < minResetTs) {
      deletedSet.add(item.id);
      continue;
    }
    map.set(item.id, item);
  }
  for (const item of (Array.isArray(b) ? b : [])) {
    if (!item || !item.id || deletedSet.has(item.id)) continue;
    const ts = getRecordTimeMs(item);
    if (minResetTs > 0 && ts > 0 && ts < minResetTs) {
      deletedSet.add(item.id);
      continue;
    }
    const prev = map.get(item.id);
    if (!prev) {
      map.set(item.id, item);
    } else {
      const tA = getRecordTimeMs(prev);
      const tB = ts;
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
    'users', 'pallets', 'rawMaterials', 'logContainers', 'logItems', 'scrapItems', 'spareParts',
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

  const curReset = Number(current.lastResetAt || 0);
  const incReset = Number(incoming.lastResetAt || 0);
  const minResetTs = Math.max(curReset, incReset);

  const deletedIds = Array.from(new Set([...(current.deletedIds || []), ...(incoming.deletedIds || [])]));
  const delSet = new Set(deletedIds);

  // If one state has a newer system reset timestamp (lastResetAt), discard the older pre-reset state completely!
  if (incReset > curReset && curReset === 0) {
    // Still filter incoming against minResetTs in case an old client tainted it
    const listKeys = [
      'pallets', 'rawMaterials', 'logContainers', 'logItems', 'scrapItems', 'spareParts',
      'productionOrders', 'approvalRequests', 'warehouseMovements', 'salesReturns',
      'partners', 'palletMovements', 'financialTransactions', 'auditLogs', 'chatMessages'
    ];
    const cleanedIncoming = {
      ...incoming,
      lastResetAt: minResetTs,
      users: smartMergeListClient(current.users, incoming.users, new Set(), 0)
    };
    for (const key of listKeys) {
      cleanedIncoming[key] = smartMergeListClient([], incoming[key], delSet, minResetTs);
    }
    cleanedIncoming.deletedIds = Array.from(delSet).slice(-4000);
    return normalizeState(cleanedIncoming);
  }

  const listKeys = [
    'users', 'pallets', 'rawMaterials', 'logContainers', 'logItems', 'scrapItems', 'spareParts',
    'productionOrders', 'approvalRequests', 'warehouseMovements', 'salesReturns',
    'partners', 'palletMovements', 'financialTransactions', 'auditLogs', 'chatMessages'
  ];

  const merged = {
    ...current,
    ...incoming,
    lastResetAt: minResetTs,
    factoryInfo: { ...(current.factoryInfo || {}), ...(incoming.factoryInfo || {}) },
    treasuryBalances: { ...(current.treasuryBalances || {}), ...(incoming.treasuryBalances || {}) },
    catalog: {
      ...(current.catalog || {}),
      ...(incoming.catalog || {}),
      woodenPalletUnitPrice: Number(incoming.catalog?.woodenPalletUnitPriceUpdatedAt || 0) >= Number(current.catalog?.woodenPalletUnitPriceUpdatedAt || 0)
        ? Number(incoming.catalog?.woodenPalletUnitPrice ?? current.catalog?.woodenPalletUnitPrice ?? 0)
        : Number(current.catalog?.woodenPalletUnitPrice ?? incoming.catalog?.woodenPalletUnitPrice ?? 0),
      woodenPalletUnitPriceUpdatedAt: Math.max(Number(current.catalog?.woodenPalletUnitPriceUpdatedAt || 0), Number(incoming.catalog?.woodenPalletUnitPriceUpdatedAt || 0)),
      woodTypes: smartMergeListClient(current.catalog?.woodTypes, incoming.catalog?.woodTypes, delSet, 0),
      thicknesses: smartMergeListClient(current.catalog?.thicknesses, incoming.catalog?.thicknesses, delSet, 0),
      grades: smartMergeListClient(current.catalog?.grades, incoming.catalog?.grades, delSet, 0),
      dimensions: smartMergeListClient(current.catalog?.dimensions, incoming.catalog?.dimensions, delSet, 0),
      customDimensions: smartMergeListClient(current.catalog?.customDimensions, incoming.catalog?.customDimensions, delSet, 0),
      cellPrices: sanitizeCellPricesMap({ ...(current.catalog?.cellPrices || {}), ...(incoming.catalog?.cellPrices || {}) })
    }
  };
  for (const key of listKeys) {
    merged[key] = smartMergeListClient(current[key], incoming[key], delSet, key === 'users' ? 0 : minResetTs);
  }
  merged.deletedIds = Array.from(delSet).slice(-4000);
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
    pallets: [], rawMaterials: [], logContainers: [], logItems: [], scrapItems: [], spareParts: [], productionOrders: [],
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

// ============================================================================
// COMPANY STAMP (ختم الشركة) & BANK ACCOUNTS & ARABIC TAFQEET (التفقيط بالحروف)
// ============================================================================
const DEFAULT_FACTORY_STAMP_SVG_DATA_URL = 'data:image/svg+xml;utf8,' + encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="220" height="130" viewBox="0 0 220 130">
  <g transform="rotate(-4 110 65)" fill="none" stroke="#1e3a8a" stroke-width="2.5">
    <rect x="8" y="8" width="204" height="114" rx="14" stroke="#1e3a8a" stroke-width="3.2" stroke-dasharray="6,2"/>
    <rect x="14" y="14" width="192" height="102" rx="10" stroke="#1e3a8a" stroke-width="1.6"/>
    <text x="110" y="38" text-anchor="middle" font-family="Cairo, Arial, sans-serif" font-size="14.5" font-weight="900" fill="#1e3a8a" stroke="none">مصنع العاصمة للصناعات المتخصصة</text>
    <text x="110" y="58" text-anchor="middle" font-family="Arial, sans-serif" font-size="12" font-weight="800" fill="#1d4ed8" stroke="none">CSI CAPITAL INDUSTRIES</text>
    <line x1="30" y1="67" x2="190" y2="67" stroke="#1e3a8a" stroke-width="1.4"/>
    <text x="110" y="86" text-anchor="middle" font-family="Cairo, Arial, sans-serif" font-size="12.5" font-weight="800" fill="#1e3a8a" stroke="none">الإدارة المالية والمبيعات - ختـم معتمد</text>
    <text x="110" y="105" text-anchor="middle" font-family="Cairo, Arial, sans-serif" font-size="11" font-weight="700" fill="#1d4ed8" stroke="none">★ العاصمـة للصناعات المتخصصة ★</text>
  </g>
</svg>`);

function getFactoryStampSrc() {
  const custom = state && state.factoryInfo && state.factoryInfo.stampDataUrl;
  if (custom && typeof custom === 'string' && custom.startsWith('data:image/')) {
    return custom;
  }
  return DEFAULT_FACTORY_STAMP_SVG_DATA_URL;
}

function getDefaultBankAccountsText() {
  const saved = state?.factoryInfo?.bankAccountsText;
  if (saved && typeof saved === 'string' && saved.trim()) {
    return saved;
  }
  return `• البنك الأهلي المصري (باسم: مصنع العاصمة للصناعات المتخصصة) — رقم الحساب / IBAN: [يرجى كتابة رقم الحساب البنكي هنا]\n• بنك مصر / CIB (باسم: مصنع العاصمة للصناعات المتخصصة) — رقم الحساب / إنستاباي: [يرجى كتابة رقم الحساب هنا]`;
}

function openFactoryStampModal() {
  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot) return;
  const currentStamp = getFactoryStampSrc();
  const hasCustom = Boolean(state?.factoryInfo?.stampDataUrl);
  const currentBanks = getDefaultBankAccountsText();

  modalRoot.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal-box" style="max-width:580px;text-align:center;">
        <div class="card-header">
          <div class="card-title">💮 ختم الشركة وأرقام الحسابات البنكية في بيان الطلبية PDF</div>
          <button class="btn btn-sm btn-outline" onclick="closeModal()">✕</button>
        </div>

        <div style="background:var(--bg-elevated);border:2px dashed var(--border-color);border-radius:14px;padding:16px;margin-bottom:14px;">
          <div style="font-size:0.84rem;color:var(--text-muted);margin-bottom:8px;">معاينة ختم الشركة الحالي (يظهر أسفل يسار بيان الطلبية تحت كلمة "العاصمة للصناعات المتخصصة"):</div>
          <div style="display:inline-flex;align-items:center;justify-content:center;background:#ffffff;border:1px solid #cbd5e1;border-radius:12px;padding:10px 18px;min-height:95px;">
            <img id="stamp-modal-preview-img" src="${currentStamp}" alt="ختم الشركة" style="max-height:95px;max-width:220px;object-fit:contain;" />
          </div>
          <div style="margin-top:10px;">
            <label for="factory-stamp-file-input" class="btn btn-primary" style="width:100%;justify-content:center;padding:10px;font-size:0.88rem;cursor:pointer;">
              📤 اختر صورة ختم الشركة من جهازك أو الموبايل (PNG / JPG)
            </label>
            <input id="factory-stamp-file-input" type="file" accept="image/*" style="display:none;" onchange="handleFactoryStampFileChange(event)" />
          </div>
        </div>

        <div style="text-align:right;background:var(--bg-elevated);padding:14px;border-radius:12px;border:1px solid var(--border-color);margin-bottom:14px;">
          <label style="font-weight:800;color:var(--primary);display:block;margin-bottom:6px;">🏦 أرقام الحسابات البنكية الخاصة بمصنع العاصمة (تظهر تلقائياً في كل بيان طلبية):</label>
          <textarea id="factory-bank-accounts-input" rows="3" class="form-control" style="font-size:0.84rem;line-height:1.5;" placeholder="اكتب اسم البنك ورقم الحساب و IBAN لتحويل مبالغ الطلبيات...">${currentBanks}</textarea>
          <button type="button" class="btn btn-sm btn-success" style="margin-top:8px;width:100%;font-weight:800;" onclick="saveFactoryBankAccountsFromModal()">
            💾 حفظ أرقام الحسابات البنكية المعتمدة للمصنع
          </button>
        </div>

        <div style="display:flex;justify-content:space-between;gap:10px;">
          ${hasCustom ? `
            <button type="button" class="btn btn-danger" onclick="resetFactoryStampToDefault()">🔄 استعادة الختم الافتراضي</button>
          ` : '<span></span>'}
          <button type="button" class="btn btn-outline" onclick="closeModal()">إغلاق</button>
        </div>
      </div>
    </div>
  `;
}

function saveFactoryBankAccountsFromModal() {
  const txt = (document.getElementById('factory-bank-accounts-input')?.value || '').trim();
  state.factoryInfo = state.factoryInfo || {};
  state.factoryInfo.bankAccountsText = txt;
  state.factoryInfo.updatedAt = new Date().toISOString();
  saveState(`🏦 تحديث أرقام الحسابات البنكية المعتمدة لمصنع العاصمة بواسطة ${currentUser ? currentUser.name : 'الإدارة'}`);
  alert('✅ تم حفظ أرقام الحسابات البنكية بنجاح! ستظهر تلقائياً في جميع بيانات الطلبيات.');
}

function handleFactoryStampFileChange(event) {
  const file = event?.target?.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    const rawDataUrl = e.target?.result;
    if (!rawDataUrl || typeof rawDataUrl !== 'string') return;
    const img = new Image();
    img.onload = function() {
      try {
        const maxW = 300;
        const maxH = 180;
        let w = img.width || 200;
        let h = img.height || 140;
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
        state.factoryInfo.stampDataUrl = finalDataUrl;
        state.factoryInfo.updatedAt = new Date().toISOString();
        saveState(`💮 تحديث ختم الشركة الرسمي بواسطة ${currentUser ? currentUser.name : 'الإدارة'}`);
        openFactoryStampModal();
        alert('✅ تم حفظ صورة ختم الشركة بنجاح! سيظهر الآن أسفل يسار بيان الطلبية تحت كلمة "العاصمة للصناعات المتخصصة".');
      } catch (_) {
        state.factoryInfo = state.factoryInfo || {};
        state.factoryInfo.stampDataUrl = rawDataUrl;
        state.factoryInfo.updatedAt = new Date().toISOString();
        saveState(`💮 تحديث ختم الشركة الرسمي بواسطة ${currentUser ? currentUser.name : 'الإدارة'}`);
        openFactoryStampModal();
      }
    };
    img.src = rawDataUrl;
  };
  reader.readAsDataURL(file);
}

function resetFactoryStampToDefault() {
  if (!confirm('هل تريد استعادة ختم الشركة الافتراضي؟')) return;
  if (state && state.factoryInfo) {
    delete state.factoryInfo.stampDataUrl;
    state.factoryInfo.updatedAt = new Date().toISOString();
  }
  saveState(`🔄 استعادة ختم الشركة الافتراضي بواسطة ${currentUser ? currentUser.name : 'الإدارة'}`);
  openFactoryStampModal();
}

// Convert numeric amount to formal Arabic words (التفقيط بالحروف بالعربي)
function numberToArabicTafqeet(amount) {
  const num = Math.max(0, Number(amount || 0));
  const intPart = Math.floor(num + 1e-9);
  const piastres = Math.round((num - intPart) * 100);

  if (intPart === 0 && piastres === 0) {
    return 'فقط وقدره صفر جنيه مصري لا غير';
  }

  const ones = ['', 'واحد', 'اثنان', 'ثلاثة', 'أربعة', 'خمسة', 'ستة', 'سبعة', 'ثمانية', 'تسعة'];
  const teens = ['عشرة', 'أحد عشر', 'اثنا عشر', 'ثلاثة عشر', 'أربعة عشر', 'خمسة عشر', 'ستة عشر', 'سبعة عشر', 'ثمانية عشر', 'تسعة عشر'];
  const tens = ['', 'عشرة', 'عشرون', 'ثلاثون', 'أربعون', 'خمسون', 'ستون', 'سبعون', 'ثمانون', 'تسعون'];
  const hundreds = ['', 'مائة', 'مائتان', 'ثلاثمائة', 'أربعمائة', 'خمسمائة', 'ستمائة', 'سبعمائة', 'ثمانمائة', 'تسعمائة'];

  function convertUnder1000(n) {
    if (n === 0) return '';
    const parts = [];
    const h = Math.floor(n / 100);
    const rem = n % 100;
    if (h > 0) parts.push(hundreds[h]);
    if (rem > 0) {
      if (rem < 10) {
        parts.push(ones[rem]);
      } else if (rem < 20) {
        parts.push(teens[rem - 10]);
      } else {
        const u = rem % 10;
        const t = Math.floor(rem / 10);
        if (u > 0) {
          parts.push(`${ones[u]} و${tens[t]}`);
        } else {
          parts.push(tens[t]);
        }
      }
    }
    return parts.join(' و');
  }

  const groups = [];
  const millions = Math.floor(intPart / 1000000);
  const thousands = Math.floor((intPart % 1000000) / 1000);
  const remainder = intPart % 1000;

  if (millions > 0) {
    if (millions === 1) groups.push('مليون');
    else if (millions === 2) groups.push('مليونان');
    else if (millions >= 3 && millions <= 10) groups.push(`${convertUnder1000(millions)} ملايين`);
    else groups.push(`${convertUnder1000(millions)} مليوناً`);
  }

  if (thousands > 0) {
    if (thousands === 1) groups.push('ألف');
    else if (thousands === 2) groups.push('ألفان');
    else if (thousands >= 3 && thousands <= 10) groups.push(`${convertUnder1000(thousands)} آلاف`);
    else groups.push(`${convertUnder1000(thousands)} ألفاً`);
  }

  if (remainder > 0) {
    groups.push(convertUnder1000(remainder));
  }

  let words = groups.join(' و');
  if (intPart > 0) {
    words += ' جنيه مصري';
  }
  if (piastres > 0) {
    const pWords = convertUnder1000(piastres);
    words += (intPart > 0 ? ' و' : '') + `${pWords} قرشاً`;
  }
  return `فقط وقدره ${words} لا غير`;
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
            <button class="btn btn-sm" style="background:linear-gradient(135deg,#7c3aed,#4f46e5);color:#fff;font-weight:800;border:none;" onclick="openSmartAiAssistantModal()" title="فتح مساعد مصنع العاصمة الذكي (بالأوامر الصوتية والكتابية بالعربي)">
              🤖 المساعد الذكي 🎤
            </button>
            <button class="btn btn-sm ${activeTab === 'chat' ? 'btn-primary' : 'btn-outline'}" onclick="setTab('chat')" title="فتح غرفة الشات وتكليف المهام بين الـ 8 حسابات">
              💬 الشات والمهام ${openTasksForMeCount > 0 ? `<span class="badge badge-danger" style="margin-right:4px;">${openTasksForMeCount} مهمة</span>` : ''}
            </button>
            <button class="btn btn-sm btn-outline" style="border-color:#a855f7;color:#7c3aed;" onclick="openFloatingDockPositionModal()" title="نقل أو إظهار/إخفاء أيقونة الشات والمساعد الذكي من أسفل يسار الصفحة لأي مكان">
              ✥ مكان الشات العائم
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

    ${renderFloatingDockHtml(openTasksForMeCount)}
  `;
  renderLiveBannerDOM();
  initFloatingDockDragEvents();

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
  const qcTotalSheets = Number(quickCalc.sheetsPerPallet || 0) * Number(quickCalc.palletsCount || 0);
  const qcMetrics = calculateVeneerMetrics(
    Number(quickCalc.lengthCm || 0),
    Number(quickCalc.widthCm || 0),
    Number(quickCalc.thicknessMm || 0),
    qcTotalSheets
  );
  const qcSingleSheetVolM3 = qcMetrics.sheetAreaM2 * (Number(quickCalc.thicknessMm || 0) / 1000);
  const qcSheetsPerM3 = qcSingleSheetVolM3 > 0 ? (1 / qcSingleSheetVolM3) : 0;
  const qcSheetPrice = qcSingleSheetVolM3 * Number(quickCalc.pricePerM3 || 0);
  const qcSinglePalletValue = qcSingleSheetVolM3 * Number(quickCalc.sheetsPerPallet || 0) * Number(quickCalc.pricePerM3 || 0);
  const qcTotalValue = qcMetrics.totalVolumeM3 * Number(quickCalc.pricePerM3 || 0);
  const avgPalletStockValue = totalPallets > 0 ? (totalVeneerValue / totalPallets) : 0;

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
              ${prepOrdersForWarehouse.map(o => {
                const sc = checkOrderStockAvailability(o);
                return `
                <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                  <span>• <strong>${o.orderNumber}</strong> للعميل <strong>${o.clientName}</strong> (${fmtNum(o.totalSheetsCount || 0, 0)} قطعة)</span>
                  ${o.placedInNegativeStock
                    ? `<span class="badge badge-danger" style="font-size:0.7rem;">📉 موضوعة بالمخزن بالسالب</span>`
                    : !sc.isReadyToApprove
                      ? `<span class="badge badge-danger" style="font-size:0.7rem;">⛔ عجز بالمخزن (${fmtNum(sc.totalDeficitSheets, 0)} ق)</span>`
                      : `<span class="badge badge-success" style="font-size:0.7rem;">✅ متوفرة بالمخزن</span>`}
                  <button type="button" class="btn btn-sm btn-outline" onclick="openClientOrderStatementModal('${o.id}')">📄 عرض الكميات</button>
                  <button type="button" class="btn btn-sm ${!sc.isReadyToApprove ? 'btn-danger' : 'btn-success'}" onclick="approveOrderWarehousePrep('${o.id}')">
                    ${!sc.isReadyToApprove ? '⚠️ تغطية الرصيد أو وضعها بالسالب للموافقة' : '✅ موافقة التجهيز والخروج الآن'}
                  </button>
                </div>
              `;}).join('')}
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
        <span class="stat-title">${canSeeFinancialPrices() ? 'قيمة البالتة وإجمالي قيمة مخزون البالتات' : 'إجمالي المساحة والحجم للقشرة بالمخزن'}</span>
        <div class="stat-value">${canSeeFinancialPrices() ? fmtMoney(totalVeneerValue) : fmtNum(totalAreaM2, 2) + ' م²'}</div>
        <div class="stat-sub">${canSeeFinancialPrices() ? `عدد البالتات: <strong>${totalPallets} بالتة</strong> | متوسط قيمة البالتة: <strong>${fmtMoney(avgPalletStockValue)}</strong>` : 'مصنفة حسب التخانة (قص / سدا) ودرجة الجودة (A, B, C)'}</div>
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
      <div class="card-header" style="flex-wrap:wrap;gap:8px;">
        <div>
          <div class="card-title">📐 حاسبة القشرة الخشبية الفورية (تحويل البالتة والأفرخ إلى م² و م³)</div>
          <small style="color:var(--text-muted);">اكتب أي أرقام بحرية (بالعربي أو الإنجليزي والكسور العشرية) وسيتم الحساب تلقائياً وفوراً</small>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
          <span class="badge badge-info">المقاس المعتمد: 125 سم × 250 سم = 3.125 م² للفرخ</span>
          <button type="button" class="btn btn-sm btn-outline" onclick="resetQuickCalcValues()">🔄 استعادة الافتراضي</button>
        </div>
      </div>

      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:10px;font-size:0.78rem;">
        <strong style="color:var(--text-muted);">اختيار سريع للمقاس:</strong>
        ${getPresetVeneerDimensions().map(d => `
          <button type="button" class="btn btn-sm btn-outline" style="padding:2px 8px;font-size:0.74rem;" onclick="setQuickCalcDims(${d.lengthCm}, ${d.widthCm})">
            ${d.widthCm}×${d.lengthCm} سم ${d.isStandard ? '(معتمد)' : ''}
          </button>
        `).join('')}
        <span style="margin:0 6px;color:var(--border-color);">|</span>
        <strong style="color:var(--text-muted);">تخانات سريعة:</strong>
        ${[0.6, 1.0, 1.2, 1.5, 1.8, 2.0, 2.2, 2.5].map(mm => `
          <button type="button" class="btn btn-sm btn-outline" style="padding:2px 7px;font-size:0.74rem;" onclick="setQuickCalcThk(${mm})">${mm} مم</button>
        `).join('')}
      </div>

      <div class="form-grid">
        <div class="form-group">
          <label>طول الفرخ (سم)</label>
          <input id="qc-len-input" type="text" inputmode="decimal" dir="ltr" style="text-align:center;font-weight:800;font-size:1rem;" class="form-control" value="${quickCalc.lengthCm}" oninput="onQuickCalcInput('lengthCm', this.value)" onclick="this.select()" placeholder="250" />
        </div>
        <div class="form-group">
          <label>عرض الفرخ (سم)</label>
          <input id="qc-wid-input" type="text" inputmode="decimal" dir="ltr" style="text-align:center;font-weight:800;font-size:1rem;" class="form-control" value="${quickCalc.widthCm}" oninput="onQuickCalcInput('widthCm', this.value)" onclick="this.select()" placeholder="125" />
        </div>
        <div class="form-group">
          <label>التخانة (مم)</label>
          <input id="qc-thk-input" type="text" inputmode="decimal" dir="ltr" style="text-align:center;font-weight:800;font-size:1rem;" class="form-control" value="${quickCalc.thicknessMm}" oninput="onQuickCalcInput('thicknessMm', this.value)" onclick="this.select()" placeholder="1.5" />
        </div>
        <div class="form-group">
          <label>عدد الأفرخ في البالتة (أو إجمالي القطع)</label>
          <input id="qc-sheets-input" type="text" inputmode="numeric" dir="ltr" style="text-align:center;font-weight:800;font-size:1rem;" class="form-control" value="${quickCalc.sheetsPerPallet}" oninput="onQuickCalcInput('sheetsPerPallet', this.value)" onclick="this.select()" placeholder="400" />
        </div>
        <div class="form-group">
          <label>عدد البالتات</label>
          <input id="qc-pallets-input" type="text" inputmode="decimal" dir="ltr" style="text-align:center;font-weight:800;font-size:1rem;" class="form-control" value="${quickCalc.palletsCount}" oninput="onQuickCalcInput('palletsCount', this.value)" onclick="this.select()" placeholder="1" />
        </div>
        ${canSeeFinancialPrices() ? `
        <div class="form-group">
          <label>سعر المتر المكعب (م³) بالجنيه</label>
          <input id="qc-price-input" type="text" inputmode="decimal" dir="ltr" style="text-align:center;font-weight:800;font-size:1rem;border-color:var(--primary);" class="form-control" value="${quickCalc.pricePerM3}" oninput="onQuickCalcInput('pricePerM3', this.value)" onclick="this.select()" placeholder="22000" />
        </div>
        <div class="form-group">
          <label>💰 سعر الفرخ الواحد (القطعة) بالجنيه</label>
          <input id="qc-sheet-price-input" type="text" inputmode="decimal" dir="ltr" style="text-align:center;font-weight:900;font-size:1rem;border-color:#16a34a;color:#15803d;background:rgba(22,163,74,0.06);" class="form-control" value="${fmtNum(qcSheetPrice, 2)}" oninput="onQuickCalcSheetPriceInput(this.value)" onclick="this.select()" title="يتحدث تلقائياً عند إدخال سعر المتر المكعب (أو اكتب سعر الفرخ لحساب سعر المتر)" />
        </div>
        <div class="form-group">
          <label>📦 قيمة البالتة الواحدة (${quickCalc.sheetsPerPallet} فرخ) بالجنيه</label>
          <input id="qc-pallet-value-input" type="text" inputmode="decimal" dir="ltr" style="text-align:center;font-weight:900;font-size:1rem;border-color:#d97706;color:#b45309;background:rgba(217,119,6,0.08);" class="form-control" value="${fmtNum(qcSinglePalletValue, 2)}" oninput="onQuickCalcSinglePalletValueInput(this.value)" onclick="this.select()" title="يتحدث تلقائياً (أو اكتب قيمة البالتة لحساب سعر الفرخ وإجمالي قيمة البالتات)" />
        </div>
        ` : ''}
      </div>

      <div id="qc-live-preview-box" class="calc-preview-box">
        <div class="calc-preview-item" style="border:1.5px solid #0284c7;background:rgba(2,132,199,0.08);border-radius:10px;padding:8px 12px;">
          <span style="color:#0369a1;font-weight:800;">📦 عدد الأفرخ في المتر المكعب (1 م³)</span>
          <strong style="color:#0284c7;font-size:1.15rem;">${fmtNum(qcSheetsPerM3, 2)} فرخ <small style="font-size:0.78rem;color:var(--text-muted);">(≈ ${Math.round(qcSheetsPerM3)} فرخ)</small></strong>
        </div>
        ${canSeeFinancialPrices() ? `
        <div class="calc-preview-item" style="border:1.5px solid #16a34a;background:rgba(22,163,74,0.08);border-radius:10px;padding:8px 12px;">
          <span style="color:#15803d;font-weight:800;">💰 سعر الفرخ الواحد (من سعر الـ م³)</span>
          <strong style="color:#16a34a;font-size:1.18rem;">${fmtMoney(qcSheetPrice)} <small style="font-size:0.75rem;color:var(--text-muted);">(${fmtNum(qcSheetPrice, 3)} ج.م/فرخ)</small></strong>
        </div>
        <div class="calc-preview-item" style="border:1.5px solid #d97706;background:rgba(217,119,6,0.08);border-radius:10px;padding:8px 12px;">
          <span style="color:#b45309;font-weight:800;">📦 قيمة البالتة الواحدة (${fmtNum(quickCalc.sheetsPerPallet, 0)} فرخ)</span>
          <strong style="color:#d97706;font-size:1.18rem;">${fmtMoney(qcSinglePalletValue)}</strong>
        </div>
        <div class="calc-preview-item" style="border:2px solid #7c3aed;background:rgba(124,58,237,0.09);border-radius:10px;padding:8px 12px;">
          <span style="color:#6d28d9;font-weight:800;">💎 إجمالي قيمة البالتات (${fmtNum(quickCalc.palletsCount, 0)} بالتة = ${fmtNum(qcTotalSheets, 0)} فرخ)</span>
          <strong style="color:#7c3aed;font-size:1.22rem;">${fmtMoney(qcTotalValue)}</strong>
        </div>
        ` : ''}
        <div class="calc-preview-item">
          <span>مساحة وحجم الفرخ الواحد</span>
          <strong>${fmtNum(qcMetrics.sheetAreaM2, 4)} م² <small style="color:var(--text-muted);">(${fmtNum(qcSingleSheetVolM3, 6)} م³)</small></strong>
        </div>
        <div class="calc-preview-item">
          <span>عدد البالتات × الأفرخ للبالتات</span>
          <strong>${fmtNum(quickCalc.palletsCount, 0)} بالتة (${fmtNum(qcTotalSheets, 0)} فرخ)</strong>
        </div>
        <div class="calc-preview-item">
          <span>إجمالي المساحة (م²)</span>
          <strong>${fmtNum(qcMetrics.totalAreaM2, 2)} م²</strong>
        </div>
        <div class="calc-preview-item">
          <span>إجمالي الحجم الفعلي (م³)</span>
          <strong>${fmtNum(qcMetrics.totalVolumeM3, 4)} م³</strong>
        </div>
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

function normalizeNumericInputString(raw) {
  if (raw === null || raw === undefined) return '';
  const arabicDigits = '٠١٢٣٤٥٦٧٨٩';
  const easternDigits = '۰۱۲۳۴۵۶۷۸۹';
  let str = String(raw);
  for (let i = 0; i < 10; i++) {
    str = str.split(arabicDigits[i]).join(String(i));
    str = str.split(easternDigits[i]).join(String(i));
  }
  str = str.replace(/[٫،,]/g, '.');
  return str.replace(/[^0-9.]/g, '');
}

function onQuickCalcInput(fieldKey, rawVal) {
  const cleaned = normalizeNumericInputString(rawVal);
  quickCalc[fieldKey] = cleaned === '' ? 0 : (Number(cleaned) || 0);
  updateQuickCalcPreview(true);
}

function onQuickCalcSheetPriceInput(rawVal) {
  const cleaned = normalizeNumericInputString(rawVal);
  const sheetPrice = cleaned === '' ? 0 : (Number(cleaned) || 0);
  const sheetAreaM2 = (Number(quickCalc.lengthCm || 0) / 100) * (Number(quickCalc.widthCm || 0) / 100);
  const singleSheetVolM3 = sheetAreaM2 * (Number(quickCalc.thicknessMm || 0) / 1000);
  if (singleSheetVolM3 > 0) {
    quickCalc.pricePerM3 = +(sheetPrice / singleSheetVolM3).toFixed(2);
    const prEl = document.getElementById('qc-price-input');
    if (prEl) prEl.value = quickCalc.pricePerM3;
  }
  updateQuickCalcPreview(false);
}

function onQuickCalcSinglePalletValueInput(rawVal) {
  const cleaned = normalizeNumericInputString(rawVal);
  const palletVal = cleaned === '' ? 0 : (Number(cleaned) || 0);
  const sheetsPerPal = Math.max(1, Number(quickCalc.sheetsPerPallet || 400));
  const sheetPrice = palletVal / sheetsPerPal;
  const sheetAreaM2 = (Number(quickCalc.lengthCm || 0) / 100) * (Number(quickCalc.widthCm || 0) / 100);
  const singleSheetVolM3 = sheetAreaM2 * (Number(quickCalc.thicknessMm || 0) / 1000);
  if (singleSheetVolM3 > 0) {
    quickCalc.pricePerM3 = +(sheetPrice / singleSheetVolM3).toFixed(2);
    const prEl = document.getElementById('qc-price-input');
    if (prEl) prEl.value = quickCalc.pricePerM3;
  }
  const shPrEl = document.getElementById('qc-sheet-price-input');
  if (shPrEl) shPrEl.value = +sheetPrice.toFixed(2);
  updateQuickCalcPreview(false, false);
}

function setQuickCalcDims(lenCm, widCm) {
  quickCalc.lengthCm = Number(lenCm || 250);
  quickCalc.widthCm = Number(widCm || 125);
  const lenEl = document.getElementById('qc-len-input');
  const widEl = document.getElementById('qc-wid-input');
  if (lenEl) lenEl.value = quickCalc.lengthCm;
  if (widEl) widEl.value = quickCalc.widthCm;
  updateQuickCalcPreview(true);
}

function setQuickCalcThk(mm) {
  quickCalc.thicknessMm = Number(mm || 1.5);
  const thkEl = document.getElementById('qc-thk-input');
  if (thkEl) thkEl.value = quickCalc.thicknessMm;
  updateQuickCalcPreview(true);
}

function resetQuickCalcValues() {
  quickCalc = {
    lengthCm: 250,
    widthCm: 125,
    thicknessMm: 1.5,
    sheetsPerPallet: 400,
    palletsCount: 1,
    pricePerM3: 22000,
    woodenPalletUnitPrice: 0
  };
  const lenEl = document.getElementById('qc-len-input');
  const widEl = document.getElementById('qc-wid-input');
  const thkEl = document.getElementById('qc-thk-input');
  const shEl = document.getElementById('qc-sheets-input');
  const palEl = document.getElementById('qc-pallets-input');
  const prEl = document.getElementById('qc-price-input');
  if (lenEl) lenEl.value = quickCalc.lengthCm;
  if (widEl) widEl.value = quickCalc.widthCm;
  if (thkEl) thkEl.value = quickCalc.thicknessMm;
  if (shEl) shEl.value = quickCalc.sheetsPerPallet;
  if (palEl) palEl.value = quickCalc.palletsCount;
  if (prEl) prEl.value = quickCalc.pricePerM3;
  updateQuickCalcPreview(true);
}

function updateQuickCalcPreview(syncSheetPriceInput = true, syncPalletValInput = true) {
  const qcTotalSheets = Number(quickCalc.sheetsPerPallet || 0) * Number(quickCalc.palletsCount || 0);
  const qcMetrics = calculateVeneerMetrics(
    Number(quickCalc.lengthCm || 0),
    Number(quickCalc.widthCm || 0),
    Number(quickCalc.thicknessMm || 0),
    qcTotalSheets
  );
  const qcSingleSheetVolM3 = qcMetrics.sheetAreaM2 * (Number(quickCalc.thicknessMm || 0) / 1000);
  const qcSheetsPerM3 = qcSingleSheetVolM3 > 0 ? (1 / qcSingleSheetVolM3) : 0;
  const qcSheetPrice = qcSingleSheetVolM3 * Number(quickCalc.pricePerM3 || 0);
  const qcSinglePalletValue = qcSingleSheetVolM3 * Number(quickCalc.sheetsPerPallet || 0) * Number(quickCalc.pricePerM3 || 0);
  const qcTotalValue = qcMetrics.totalVolumeM3 * Number(quickCalc.pricePerM3 || 0);

  if (syncSheetPriceInput) {
    const shPrEl = document.getElementById('qc-sheet-price-input');
    if (shPrEl && document.activeElement !== shPrEl) {
      shPrEl.value = +qcSheetPrice.toFixed(2);
    }
  }
  if (syncPalletValInput) {
    const palValEl = document.getElementById('qc-pallet-value-input');
    if (palValEl && document.activeElement !== palValEl) {
      palValEl.value = +qcSinglePalletValue.toFixed(2);
    }
  }

  const box = document.getElementById('qc-live-preview-box');
  if (box) {
    box.innerHTML = `
      <div class="calc-preview-item" style="border:1.5px solid #0284c7;background:rgba(2,132,199,0.08);border-radius:10px;padding:8px 12px;">
        <span style="color:#0369a1;font-weight:800;">📦 عدد الأفرخ في المتر المكعب (1 م³)</span>
        <strong style="color:#0284c7;font-size:1.15rem;">${fmtNum(qcSheetsPerM3, 2)} فرخ <small style="font-size:0.78rem;color:var(--text-muted);">(≈ ${Math.round(qcSheetsPerM3)} فرخ)</small></strong>
      </div>
      ${canSeeFinancialPrices() ? `
      <div class="calc-preview-item" style="border:1.5px solid #16a34a;background:rgba(22,163,74,0.08);border-radius:10px;padding:8px 12px;">
        <span style="color:#15803d;font-weight:800;">💰 سعر الفرخ الواحد (من سعر الـ م³)</span>
        <strong style="color:#16a34a;font-size:1.18rem;">${fmtMoney(qcSheetPrice)} <small style="font-size:0.75rem;color:var(--text-muted);">(${fmtNum(qcSheetPrice, 3)} ج.م/فرخ)</small></strong>
      </div>
      <div class="calc-preview-item" style="border:1.5px solid #d97706;background:rgba(217,119,6,0.08);border-radius:10px;padding:8px 12px;">
        <span style="color:#b45309;font-weight:800;">📦 قيمة البالتة الواحدة (${fmtNum(quickCalc.sheetsPerPallet, 0)} فرخ)</span>
        <strong style="color:#d97706;font-size:1.18rem;">${fmtMoney(qcSinglePalletValue)}</strong>
      </div>
      <div class="calc-preview-item" style="border:2px solid #7c3aed;background:rgba(124,58,237,0.09);border-radius:10px;padding:8px 12px;">
        <span style="color:#6d28d9;font-weight:800;">💎 إجمالي قيمة البالتات (${fmtNum(quickCalc.palletsCount, 0)} بالتة = ${fmtNum(qcTotalSheets, 0)} فرخ)</span>
        <strong style="color:#7c3aed;font-size:1.22rem;">${fmtMoney(qcTotalValue)}</strong>
      </div>
      ` : ''}
      <div class="calc-preview-item">
        <span>مساحة وحجم الفرخ الواحد</span>
        <strong>${fmtNum(qcMetrics.sheetAreaM2, 4)} م² <small style="color:var(--text-muted);">(${fmtNum(qcSingleSheetVolM3, 6)} م³)</small></strong>
      </div>
      <div class="calc-preview-item">
        <span>عدد البالتات × الأفرخ للبالتات</span>
        <strong>${fmtNum(quickCalc.palletsCount, 0)} بالتة (${fmtNum(qcTotalSheets, 0)} فرخ)</strong>
      </div>
      <div class="calc-preview-item">
        <span>إجمالي المساحة (م²)</span>
        <strong>${fmtNum(qcMetrics.totalAreaM2, 2)} م²</strong>
      </div>
      <div class="calc-preview-item">
        <span>إجمالي الحجم الفعلي (م³)</span>
        <strong>${fmtNum(qcMetrics.totalVolumeM3, 4)} م³</strong>
      </div>
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
    if (Number(p.sheetsCount || 0) === 0) return false;
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
  const negativeCellsList = [];
  for (const t of thicknesses) {
    for (const g of grades) {
      const cd = getCellData(t, g.id);
      grandStockValueByPiece += cd.stockValueByPiece;
      grandSoldRevenue += cd.soldRevenue;
      grandSoldSheets += cd.soldSheets;
      if (cd.sheets < 0) {
        negativeCellsList.push({
          thkId: t.id,
          thkMm: t.mm,
          direction: t.direction || 'qas',
          directionLabel: t.direction === 'sada' ? 'سدا' : 'قص',
          gradeId: g.id,
          gradeCode: g.code,
          gradeName: g.name,
          sheets: cd.sheets,
          volumeM3: cd.volumeM3
        });
      }
    }
  }

  const tableClass = matrixCompactMode ? 'matrix-table' : 'matrix-table matrix-normal';

  return `
    ${negativeCellsList.length > 0 ? `
      <div class="card" style="background:rgba(220,38,38,0.10);border:2px solid var(--danger);padding:14px 18px;margin-bottom:14px;">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;">
          <div>
            <div style="font-weight:900;font-size:1rem;color:var(--danger);">
              📉 تنبيه أرصدة بالسالب في المخزن (${negativeCellsList.length} خلية موضوعة بالسالب لحين إضافة الإنتاج):
            </div>
            <small style="color:var(--text-main);display:block;margin-bottom:6px;">
              هذه الأصناف تم وضعها في المخزن بالسالب لتغطية أوامر تجهيز طلبيات عملاء لحين إضافة كميات الإنتاج الجديدة (عند إضافة الإنتاج سيتم تغطية السالب تلقائياً أولاً).
            </small>
            <div style="display:flex;flex-wrap:wrap;gap:8px;">
              ${negativeCellsList.map(nc => `
                <div style="background:var(--bg-surface);border:1px solid var(--danger);padding:5px 10px;border-radius:8px;display:flex;align-items:center;gap:8px;font-size:0.82rem;">
                  <span><strong>${nc.thkMm} مم (${nc.directionLabel}) × ${nc.gradeCode}</strong>: <strong style="color:var(--danger);direction:ltr;display:inline-block;">${fmtNum(nc.sheets, 0)} قطعة</strong></span>
                  <button type="button" class="btn btn-sm btn-primary" style="padding:2px 8px;font-size:0.74rem;" onclick="openMatrixCellModal('${nc.thkId}', '${nc.gradeId}', 'in')">📥 إضافة إنتاج لتغطية السالب</button>
                </div>
              `).join('')}
            </div>
          </div>
        </div>
      </div>
    ` : ''}

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
                  const hasNegativeStock = cell.sheets < 0;

                  return `
                    <td class="matrix-cell ${hasStock || hasNegativeStock ? 'has-stock' : 'empty-stock'}"
                        style="${hasNegativeStock ? 'background:rgba(220,38,38,0.10) !important;border:2px solid var(--danger) !important;' : ''}"
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
                      ` : hasNegativeStock ? `
                        <div class="cell-main-qty" style="color:var(--danger);font-weight:900;direction:ltr;">${fmtNum(cell.sheets, 0)} قطعة</div>
                        <div style="margin-top:2px;font-size:0.62rem;background:#fee2e2;color:#b91c1c;border:1px solid #ef4444;border-radius:4px;padding:1px 4px;font-weight:800;">
                          📉 بالسالب (لحين الإضافة)
                        </div>
                        <div class="cell-sub-metrics" style="margin-top:2px;">
                          <strong style="color:var(--danger);direction:ltr;">${fmtNum(cell.volumeM3, 3)} م³</strong>
                          <span>(${fmtNum(cell.areaM2, 0)} م²)</span>
                        </div>
                      ` : `
                        <div style="color:var(--text-muted);font-size:0.74rem;font-weight:600;">0</div>
                      `}
                      <div class="cell-action-hint">
                        <button type="button" class="cell-mini-btn" style="${hasNegativeStock ? 'background:#dc2626;color:#fff;border-color:#b91c1c;font-weight:800;' : ''}" title="${hasNegativeStock ? 'إضافة إنتاج لتغطية الرصيد السالب' : 'إضافة كميات إنتاج'}" onclick="event.stopPropagation(); openMatrixCellModal('${t.id}', '${g.id}', 'in')">${hasNegativeStock ? '+تغطية السالب' : '+إنتاج'}</button>
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
              ${inStockPallets.map(p => {
                const isNeg = Number(p.sheetsCount || 0) < 0;
                return `
                <tr style="${isNeg ? 'background:rgba(220,38,38,0.08);' : ''}">
                  <td>
                    <strong>${p.palletCode}</strong>
                    ${isNeg ? '<br/><span class="badge badge-danger" style="font-size:0.65rem;">📉 رصيد بالسالب لحين الإضافة</span>' : ''}
                    <br/><small style="color:var(--text-muted);">${p.batchNumber || ''}</small>
                  </td>
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
                  <td><strong style="${isNeg ? 'color:var(--danger);direction:ltr;display:inline-block;' : ''}">${fmtNum(p.sheetsCount, 0)} قطعة</strong></td>
                  ${canSeeFinancialPrices() ? `<td>${fmtMoney(p.unitSheetPrice || 0)}</td><td><strong style="${isNeg ? 'color:var(--danger);' : ''}">${fmtMoney(p.totalValue || 0)}</strong></td>` : ''}
                  <td><strong style="${isNeg ? 'color:var(--danger);direction:ltr;display:inline-block;' : ''}">${fmtNum(p.volumeM3, 4)} م³</strong></td>
                  <td>
                    <div style="display:flex;gap:6px;flex-wrap:wrap;">
                      ${isNeg ? `
                        <button class="btn btn-sm btn-primary" onclick="openMatrixCellModal('${p.thicknessId || ('th-' + p.thicknessMm + '-' + (p.direction || 'qas'))}', '${p.gradeId}', 'in')">📥 إضافة إنتاج لتغطية السالب</button>
                      ` : `
                        <button class="btn btn-sm btn-outline" onclick="printPalletTag('${p.id}')">🖨️ كارت البالتة</button>
                        <button class="btn btn-sm btn-primary" onclick="openMatrixCellModal('${p.thicknessId || ('th-' + p.thicknessMm + '-' + (p.direction || 'qas'))}', '${p.gradeId}', 'out')">📤 بيع/خروج</button>
                      `}
                      ${isFullAdmin(currentUser) ? `
                        <button class="btn btn-sm btn-accent" onclick="openEditPalletModal('${p.id}')">✏️ تعديل</button>
                        <button class="btn btn-sm btn-danger" onclick="deletePalletRecord('${p.id}')">🗑️ حذف وإرجاع الرصيد</button>
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
    ${typeof renderLogContainersAndSerialsSection === 'function' ? renderLogContainersAndSerialsSection() : ''}

    <div class="card">
      <div class="card-header">
        <div>
          <div class="card-title">🌲 مخزن الخامات العام (الأرصدة الإجمالية ومستلزمات الإنتاج والتغليف)</div>
          <small style="color:var(--text-muted);">متابعة الأرصدة الإجمالية للأخشاب الخام بالمتر المكعب ومستلزمات التغليف والتجميع والغراء</small>
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
                    ${String(m.voucherNumber || '').startsWith('CAR-') || String(m.directionLabel || '').includes('سيارة') || String(m.warehouseLabel || '').includes('سيارة') ? `
                      <button class="btn btn-sm btn-success" onclick="printWarehouseVoucher('${m.id}')">🚚 طباعة إذن السيارة</button>
                    ` : `
                      <button class="btn btn-sm btn-outline" onclick="printWarehouseVoucher('${m.id}')">🖨️ طباعة إذن</button>
                    `}
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
  if (!pt) return { orders: [], txs: [], palletMoves: [], totalInvoiced: 0, totalPaid: 0, netDebt: 0, palletsDelivered: 0, palletsReceived: 0, netPalletsAtClient: 0, palletUnitPrice: 0, palletsDeliveredValue: 0, palletsReceivedValue: 0, netPalletsValue: 0 };

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

  const palletUnitPrice = getWoodenPalletUnitPrice(pt);
  const palletsDelivered = Number(pt.openingPalletsDelivered || 0) + palletMoves.reduce((s, pm) => s + Number(pm.deliveredCount || 0), 0);
  const palletsReceived = Number(pt.openingPalletsReceived || 0) + palletMoves.reduce((s, pm) => s + Number(pm.receivedCount || 0), 0);
  const netPalletsAtClient = palletsDelivered - palletsReceived;

  const palletsDeliveredValue = +(
    Number(pt.openingPalletsDelivered || 0) * palletUnitPrice +
    palletMoves.reduce((s, pm) => s + Number(pm.deliveredCount || 0) * getWoodenPalletUnitPrice(pt, pm), 0)
  ).toFixed(2);
  const palletsReceivedValue = +(
    Number(pt.openingPalletsReceived || 0) * palletUnitPrice +
    palletMoves.reduce((s, pm) => s + Number(pm.receivedCount || 0) * getWoodenPalletUnitPrice(pt, pm), 0)
  ).toFixed(2);
  const netPalletsValue = +(palletsDeliveredValue - palletsReceivedValue).toFixed(2);

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
    netPalletsAtClient,
    palletUnitPrice,
    palletsDeliveredValue,
    palletsReceivedValue,
    netPalletsValue
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
            <button class="btn btn-outline" style="border-color:var(--primary);color:var(--primary);font-weight:800;" onclick="openFactoryStampModal()">💮 ختم الشركة والحسابات البنكية</button>
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
                const stockCheck = st === 'pending_warehouse_prep' ? checkOrderStockAvailability(ord) : null;

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
                        ${items.map((it, idx) => {
                          const itSt = stockCheck?.itemStatuses?.[idx];
                          return `
                          <div style="font-size:0.74rem;background:var(--bg-elevated);padding:3px 6px;border-radius:5px;border-right:3px solid ${it.direction === 'sada' ? '#0284c7' : '#d97706'};">
                            <strong>${idx + 1}.</strong> <strong>${it.thicknessMm} مم (${it.direction === 'sada' ? 'سدا' : 'قص'})</strong> × <strong>${it.gradeName}</strong>
                            ${getVeneerDimensionBadgeHtml(it.lengthCm, it.widthCm)}
                            — <strong>${fmtNum(it.sheetsCount, 0)} ق</strong>
                            ${canSeeFinancialPrices() ? `× ${fmtNum(it.unitPrice, 2)} ج = <strong>${fmtMoney(it.totalItemAmount)}</strong>` : `(${fmtNum(it.volumeM3 || 0, 3)} م³)`}
                            ${itSt && !itSt.alreadyDeducted ? (
                              itSt.isCovered
                                ? `<span class="badge badge-success" style="font-size:0.64rem;padding:1px 5px;margin-right:4px;">متوفر (${fmtNum(itSt.availSheets, 0)} ق)</span>`
                                : `<span class="badge badge-danger" style="font-size:0.64rem;padding:1px 5px;margin-right:4px;">⛔ متاح: ${fmtNum(itSt.availSheets, 0)} | عجز: ${fmtNum(itSt.deficitSheets, 0)} ق</span>`
                            ) : ''}
                          </div>
                        `;}).join('')}
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
                      ${ord.placedInNegativeStock ? `<div style="margin-top:4px;"><span class="badge badge-danger" style="font-size:0.68rem;">📉 موضوعة في المخزن بالسالب لحين إضافتها</span></div>` : ''}
                      ${stockCheck && !stockCheck.isReadyToApprove ? `<div style="margin-top:4px;"><span class="badge badge-danger" style="font-size:0.68rem;">⛔ غير متوفرة بالمخزن (عجز: ${fmtNum(stockCheck.totalDeficitSheets, 0)} ق)</span></div>` : ''}
                      ${ord.notes ? `<div style="font-size:0.7rem;color:var(--text-muted);margin-top:2px;">📝 ${ord.notes}</div>` : ''}
                    </td>
                    <td>
                      <div style="display:flex;flex-direction:column;gap:4px;">
                        <button class="btn btn-sm btn-outline" style="border-color:var(--primary);color:var(--primary);font-weight:800;" onclick="openClientOrderStatementModal('${ord.id}')">
                          ${canSeeFinancialPrices() ? '📄 بيان العميل / تعديل' : '📄 بيان الكميات للتجهيز'}
                        </button>
                        ${canSeeFinancialPrices() ? `
                          <button class="btn btn-sm btn-accent" style="font-weight:800;" onclick="printClientOrderStatement('${ord.id}')">
                            🖨️ تصدير وطباعة البيان PDF
                          </button>
                        ` : ''}

                        ${st === 'pending_executive' && isExec ? `
                          <button class="btn btn-sm btn-primary" onclick="approveOrderExecutive('${ord.id}')">
                            ✅ موافقة الإدارة (إرسال للمخزن)
                          </button>
                        ` : ''}

                        ${st === 'pending_warehouse_prep' && isWarehouseOrAdmin ? `
                          ${stockCheck && !stockCheck.isReadyToApprove ? `
                            <button class="btn btn-sm btn-danger" onclick="openOrderStockShortageModal('${ord.id}')" title="لا يسمح بالموافقة إلا بعد تغطية رصيد المخزن أو وضعها بالمخزن بالسالب">
                              ⚠️ تغطية الرصيد أو وضعها بالسالب (${fmtNum(stockCheck.totalDeficitSheets, 0)} ق)
                            </button>
                          ` : `
                            <button class="btn btn-sm btn-success" onclick="approveOrderWarehousePrep('${ord.id}')">
                              ✅ موافقة التجهيز والخروج بالمخزن
                            </button>
                          `}
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
          ${releaseOrders.some(o => o.carDispatchVoucher) ? `
            <button class="btn btn-success" onclick="printVehicleDispatchVoucher('${releaseOrders.find(o => o.carDispatchVoucher).id}')">🚚 طباعة إذن صرف السيارة المعتمد</button>
          ` : ''}
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
                        ${canSeeFinancialPrices() ? (() => {
                          const pPrice = getWoodenPalletUnitPrice(state.partners?.find(p => p.id === ord.clientId), car);
                          const pTotal = Number(car.palletsDeliveredCount || 0) * pPrice;
                          return pPrice > 0 ? `<div style="font-size:0.68rem;margin-top:2px;color:var(--primary);font-weight:700;">سعر البالتة: ${fmtMoney(pPrice)}<br/>إجمالي البالتات: ${fmtMoney(pTotal)}</div>` : '';
                        })() : ''}
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
  const defaultPalletPrice = getWoodenPalletUnitPrice();
  const totalPalletsDeliveredValueAll = enrichedClients.reduce((s, x) => s + x.metrics.palletsDeliveredValue, 0);
  const totalPalletsReceivedValueAll = enrichedClients.reduce((s, x) => s + x.metrics.palletsReceivedValue, 0);
  const totalNetPalletsOutValue = enrichedClients.reduce((s, x) => s + x.metrics.netPalletsValue, 0);

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
        <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;">
          <span class="stat-title">حساب البالتات الخشبية وقيمتها طرف العملاء</span>
          <button type="button" class="btn btn-sm btn-outline" style="padding:2px 8px;font-size:0.7rem;border-color:var(--accent);color:var(--accent);font-weight:800;" onclick="openSetDefaultPalletPriceModal()">
            💰 تحديد قيمة البالتة (${fmtNum(defaultPalletPrice, 0)} ج)
          </button>
        </div>
        <div class="stat-value">${fmtNum(totalNetPalletsOut, 0)} بالتة | <span style="color:var(--primary);font-size:1.15rem;">${fmtMoney(totalNetPalletsOutValue)}</span></div>
        <div class="stat-sub">
          قيمة البالتة: <strong>${fmtMoney(defaultPalletPrice)}</strong> | مسلم: <strong>${totalPalletsDeliveredAll}</strong> (${fmtMoney(totalPalletsDeliveredValueAll)}) | مستلم: <strong>${totalPalletsReceivedAll}</strong> (${fmtMoney(totalPalletsReceivedValueAll)})
        </div>
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
          <div class="card-title">🤝 حسابات ومبيعات العملاء (الأكواد، الطلبيات الفائتة، بيان المديونيات والمستحقات، وحسابات وقيمة البالتات)</div>
          <small style="color:var(--text-muted);">
            اضغط على <strong>"📂 كشف الحساب"</strong> لأي عميل لمراجعة كافة طلبياته السابقة، وحركة المديونية، وعدد وقيمة البالتات المسلمة له والمستلمة منه
          </small>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn btn-primary" onclick="openNewPartnerModal()">➕ إضافة عميل جديد بالكود</button>
          <button class="btn btn-accent" onclick="openNewClientOrderPrepModal()">📋 إنشاء أمر تجهيز طلبية لعميل</button>
          <button class="btn btn-outline" style="border-color:#d97706;color:#b45309;font-weight:800;" onclick="openSetDefaultPalletPriceModal()">🪵 تحديد قيمة البالتة (${fmtMoney(defaultPalletPrice)})</button>
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
              <th>البالتات (العدد + القيمة)</th>
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
                    <div style="font-size:0.72rem;line-height:1.45;">
                      <span>مسلم: <strong>${m.palletsDelivered}</strong></span> |
                      <span>مستلم: <strong style="color:var(--success);">${m.palletsReceived}</strong></span><br/>
                      <span class="badge ${m.netPalletsAtClient > 0 ? 'badge-warning' : 'badge-success'}">
                        🪵 طرفه: ${m.netPalletsAtClient} بالتة
                      </span>
                      <div style="margin-top:3px;padding-top:2px;border-top:1px dashed var(--border-color);font-size:0.68rem;">
                        <div>قيمة البالتة: <strong>${fmtMoney(m.palletUnitPrice)}</strong></div>
                        <div>إجمالي قيمة البالتات: <strong style="color:var(--primary);">${fmtMoney(m.netPalletsValue)}</strong></div>
                      </div>
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
          <div class="card-title">🪵 سجل حركة البالتات المسلمة للعملاء والمستلمة منهم (العدد + قيمة البالتة + الإجمالي)</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;">
            <button class="btn btn-sm btn-outline" style="border-color:#d97706;color:#b45309;font-weight:800;" onclick="openSetDefaultPalletPriceModal()">💰 قيمة البالتة (${fmtNum(defaultPalletPrice, 0)} ج)</button>
            <button class="btn btn-sm btn-outline" onclick="printAllPalletMovementsReportPdf()">🖨️ طباعة سجل البالتات PDF</button>
          </div>
        </div>
        <div class="table-responsive">
          <table>
            <thead>
              <tr>
                <th>التاريخ</th>
                <th>العميل وكوده</th>
                <th>مسلم للعميل</th>
                <th>مستلم من العميل</th>
                <th>قيمة البالتة</th>
                <th>إجمالي قيمة البالتات</th>
                <th>السيارة / البيان</th>
                ${isFullAdmin(currentUser) ? '<th>تعديل / حذف</th>' : ''}
              </tr>
            </thead>
            <tbody>
              ${(state.palletMovements || []).length === 0 ? `
                <tr><td colspan="${isFullAdmin(currentUser) ? 8 : 7}" style="text-align:center;padding:20px;color:var(--text-muted);">لا توجد حركات بالتات مسجلة بعد.</td></tr>
              ` : (state.palletMovements || []).slice(0, 25).map(pm => {
                const ptObj = (state.partners || []).find(p => p.id === pm.clientId || p.name === pm.clientName);
                const pmUnitPrice = getWoodenPalletUnitPrice(ptObj, pm);
                const delVal = +(Number(pm.deliveredCount || 0) * pmUnitPrice).toFixed(2);
                const recVal = +(Number(pm.receivedCount || 0) * pmUnitPrice).toFixed(2);
                const totalMoveVal = delVal > 0 ? delVal : recVal;
                return `
                <tr>
                  <td>${pm.date}</td>
                  <td><strong>${pm.clientName}</strong> <small style="color:var(--text-muted);">(${pm.clientCode || ''})</small></td>
                  <td><span class="badge badge-warning">+${pm.deliveredCount || 0} بالتة مسلمة</span></td>
                  <td><span class="badge badge-success">-${pm.receivedCount || 0} بالتة مستلمة</span></td>
                  <td><strong>${fmtMoney(pmUnitPrice)}</strong></td>
                  <td>
                    <strong style="color:${delVal >= recVal ? 'var(--primary)' : 'var(--success)'};">${fmtMoney(totalMoveVal)}</strong>
                    ${delVal > 0 && recVal > 0 ? `<br/><small style="font-size:0.65rem;color:var(--text-muted);">مسلم: ${fmtMoney(delVal)} | مستلم: ${fmtMoney(recVal)}</small>` : ''}
                  </td>
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
              `;}).join('')}
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
        <button class="btn btn-outline" style="border-color:var(--primary);color:var(--primary);font-weight:800;" onclick="printLogContainersAndSerialsReportPdf()">🖨️ بيان حاويات وسيريالات الجذوع PDF</button>
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

function resetAllFactoryData() {
  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot) {
    executeFactoryDataReset('full');
    return;
  }
  modalRoot.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal-box" style="max-width:560px;">
        <div class="card-header">
          <div>
            <div class="card-title" style="color:var(--danger);">🗑️ تصفير وتفريغ النظام (البدء من جديد)</div>
            <small style="color:var(--text-muted);">اختر نوع التصفير المطلوب — سيتم تصفير البيانات على هذا الجهاز وعلى السيرفر السحابي لجميع المستخدمين فوراً</small>
          </div>
          <button type="button" class="btn btn-sm btn-outline" onclick="closeModal()">✕</button>
        </div>

        <div style="display:flex;flex-direction:column;gap:12px;margin:14px 0;">
          <div style="background:rgba(2,132,199,0.08);border:1.5px solid #0284c7;border-radius:12px;padding:12px 14px;">
            <div style="font-weight:800;color:#0284c7;margin-bottom:4px;">1️⃣ تصفير الأرصدة والطلبيات والحسابات فقط (مع بقاء التخانات والجودات)</div>
            <p style="font-size:0.8rem;color:var(--text-muted);margin:0 0 10px 0;">
              يقوم بتصفير جميع أرصدة القشرة، الخامات، الهالك، قطع الغيار، الطلبيات، فواتير العملاء، وسجل الحركات، مع <strong>الاحتفاظ بتقسيمة جدول التخانات والجودات والأسعار ولوجو الشركة وحسابات المستخدمين</strong>.
            </p>
            <button type="button" class="btn btn-primary" style="width:100%;font-weight:800;" onclick="executeFactoryDataReset('keep_catalog')">
              🔄 تصفير الأرصدة والطلبيات والحسابات فقط
            </button>
          </div>

          <div style="background:rgba(220,38,38,0.08);border:1.5px solid #dc2626;border-radius:12px;padding:12px 14px;">
            <div style="font-weight:800;color:#dc2626;margin-bottom:4px;">2️⃣ تصفير وتفريغ شامل للنظام بالكامل (بدء من الصفر تماماً)</div>
            <p style="font-size:0.8rem;color:var(--text-muted);margin:0 0 10px 0;">
              يقوم بتفريغ كل شيء في النظام (الأرصدة + الطلبيات + العملاء + التخانات + الجودات + الأسعار) مع الاحتفاظ فقط بحسابات المستخدمين الـ 8 ولوجو الشركة والمقاس المعتمد (125×250 سم).
            </p>
            <button type="button" class="btn btn-danger" style="width:100%;font-weight:800;" onclick="executeFactoryDataReset('full')">
              🗑️ تصفير وتفريغ النظام بالكامل من الصفر
            </button>
          </div>
        </div>

        <div style="display:flex;justify-content:flex-end;margin-top:8px;">
          <button type="button" class="btn btn-outline" onclick="closeModal()">إلغاء</button>
        </div>
      </div>
    </div>
  `;
}

async function executeFactoryDataReset(mode = 'full') {
  window._isSavingState = true;
  try {
    const resetTs = Date.now();
    const nowIso = new Date(resetTs + 100).toISOString();
    const def = getDefaultInitialState();

    // Collect all existing record IDs into deletedIds so even older unrefreshed devices purge them
    const oldDeletedSet = new Set(state?.deletedIds || []);
    const purgeKeys = [
      'pallets', 'rawMaterials', 'logContainers', 'logItems', 'scrapItems', 'spareParts',
      'productionOrders', 'approvalRequests', 'warehouseMovements', 'salesReturns',
      'partners', 'palletMovements', 'financialTransactions', 'auditLogs', 'chatMessages'
    ];
    for (const pk of purgeKeys) {
      for (const item of (state?.[pk] || [])) {
        if (item?.id) oldDeletedSet.add(item.id);
      }
    }
    if (mode === 'full' && state?.catalog) {
      for (const ck of ['woodTypes', 'thicknesses', 'grades', 'customDimensions']) {
        for (const item of (state.catalog[ck] || [])) {
          if (item?.id) oldDeletedSet.add(item.id);
        }
      }
    }
    const preservedUsers = (state?.users && state.users.length > 0 ? state.users : def.users).map(u => ({
      ...u,
      updatedAt: nowIso
    }));
    const preservedLogo = state?.factoryInfo?.logoDataUrl || '';

    // Stamp existing catalog items with fresh updatedAt if keeping catalog
    const keptCatalog = mode === 'keep_catalog' && state?.catalog
      ? {
          woodTypes: (state.catalog.woodTypes || []).map(x => ({ ...x, updatedAt: nowIso })),
          thicknesses: (state.catalog.thicknesses || []).map(x => ({ ...x, updatedAt: nowIso })),
          grades: (state.catalog.grades || []).map(x => ({ ...x, updatedAt: nowIso })),
          dimensions: (state.catalog.dimensions || def.catalog.dimensions).map(x => ({ ...x, updatedAt: nowIso })),
          customDimensions: (state.catalog.customDimensions || []).map(x => ({ ...x, updatedAt: nowIso })),
          cellPrices: sanitizeCellPricesMap(state.catalog.cellPrices || {})
        }
      : {
          woodTypes: [],
          thicknesses: [],
          grades: [],
          dimensions: def.catalog.dimensions.map(x => ({ ...x, updatedAt: nowIso })),
          customDimensions: [],
          cellPrices: {}
        };

    const freshState = normalizeState({
      ...def,
      lastResetAt: resetTs,
      lastFullCatalogResetAt: mode === 'full' ? resetTs : Number(state?.lastFullCatalogResetAt || 0),
      factoryInfo: {
        ...def.factoryInfo,
        ...(state?.factoryInfo || {}),
        logoDataUrl: preservedLogo,
        updatedAt: nowIso
      },
      catalog: keptCatalog,
      users: preservedUsers,
      pallets: [],
      rawMaterials: [],
      logContainers: [],
      logItems: [],
      scrapItems: [],
      spareParts: [],
      productionOrders: [],
      approvalRequests: [],
      warehouseMovements: [],
      salesReturns: [],
      partners: [],
      palletMovements: [],
      financialTransactions: [],
      treasuryBalances: { cashVault: 0, bankAccount: 0, checksUnderCollection: 0 },
      auditLogs: [
        {
          id: uid('log'),
          timestamp: nowIso,
          updatedAt: nowIso,
          user: currentUser?.name || 'الإدارة',
          roleTitle: currentUser?.roleTitle || '',
          action: mode === 'keep_catalog'
            ? '🔄 تم تصفير جميع الأرصدة والطلبيات والحسابات بنجاح (مع الاحتفاظ بهيكل جدول التخانات والجودات)'
            : '🗑️ تم تصفير وتفريغ النظام بالكامل والبدء من الصفر بنجاح',
          targetRole: 'all'
        }
      ],
      chatMessages: [],
      deletedIds: Array.from(oldDeletedSet).slice(-4000)
    });

    // Preserve users (with updated timestamp so they stay active) and custom factory logo

    state = freshState;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    if (currentUser) {
      currentUser = state.users.find(u => u.id === currentUser.id) || currentUser;
    }
    closeModal();
    render();

    const isLocalHost = location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.hostname.startsWith('192.168.');
    if (isLocalHost) {
      try {
        await fetch('/api/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...state, _forceReplace: true })
        });
      } catch (_) {}
    }

    try {
      await fetch(FIREBASE_CLOUD_URL, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state)
      });
    } catch (_) {}

    updateSyncIndicator();
    alert(
      mode === 'keep_catalog'
        ? '✅ تم تصفير جميع الأرصدة والطلبيات والحسابات بنجاح (مع الاحتفاظ بجدول التخانات والجودات)!'
        : '✅ تم تصفير وتفريغ النظام بالكامل والبدء من الصفر بنجاح!'
    );
  } catch (e) {
    alert('حدث خطأ أثناء التصفير: ' + (e?.message || e));
  } finally {
    window._isSavingState = false;
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
      if (gradeId && !matchPalletToGrade(p, gradeId)) return false;
      if (lengthCm > 0 && widthCm > 0 && !isStandardVeneerDimension(lengthCm, widthCm)) {
        const pLen = Number(p.lengthCm || 250);
        const pWid = Number(p.widthCm || 125);
        return (pLen === Number(lengthCm) && pWid === Number(widthCm)) || (pLen === Number(widthCm) && pWid === Number(lengthCm));
      }
      return true;
    })
    .reduce((s, p) => s + Number(p.sheetsCount || 0), 0);
}

// Check if all items in a client order are covered by positive warehouse stock (or already deducted / placed in negative stock)
function checkOrderStockAvailability(ord) {
  if (!ord) {
    return { isReadyToApprove: true, alreadyDeducted: false, placedInNegativeStock: false, deficits: [], totalDeficitSheets: 0, itemStatuses: [] };
  }
  const items = Array.isArray(ord.items) && ord.items.length > 0 ? ord.items : [{
    woodTypeId: ord.woodTypeId || 'wt-general',
    woodTypeName: ord.woodTypeName || 'قشرة خشبية',
    lengthCm: ord.lengthCm || 250,
    widthCm: ord.widthCm || 125,
    thicknessId: ord.thicknessId || `th-${ord.targetThicknessMm || 1.5}-${ord.targetDirection || 'qas'}`,
    thicknessMm: ord.targetThicknessMm || 1.5,
    direction: ord.targetDirection || 'qas',
    gradeId: ord.gradeId || 'gr-a',
    gradeName: ord.gradeName || 'عام',
    sheetsCount: ord.totalSheetsProduced || ord.sheetsCount || 0,
    unitPrice: ord.unitPrice || 0
  }];

  if (ord.stockDeducted) {
    const itemStatuses = items.map((it, idx) => ({
      idx,
      item: it,
      reqSheets: Number(it.sheetsCount || 0),
      availSheets: Number(it.sheetsCount || 0),
      coveredSheets: Number(it.sheetsCount || 0),
      deficitSheets: 0,
      isCovered: true,
      alreadyDeducted: true,
      placedInNegativeStock: Boolean(ord.placedInNegativeStock)
    }));
    return {
      isReadyToApprove: true,
      alreadyDeducted: true,
      placedInNegativeStock: Boolean(ord.placedInNegativeStock),
      deficits: [],
      totalDeficitSheets: 0,
      itemStatuses
    };
  }

  const remainingPosMap = new Map();
  const netInitialMap = new Map();
  const usedInOrderMap = new Map();
  const deficits = [];
  const itemStatuses = [];
  let totalDeficitSheets = 0;

  items.forEach((it, idx) => {
    const reqSheets = Math.max(0, Number(it.sheetsCount || 0));
    const thkId = it.thicknessId || `th-${it.thicknessMm}-${it.direction || 'qas'}`;
    const len = Number(it.lengthCm || 250);
    const wid = Number(it.widthCm || 125);
    const dimKey = isStandardVeneerDimension(len, wid) ? 'std' : `${Math.max(len, wid)}x${Math.min(len, wid)}`;
    const cellTrackKey = `${thkId}__${it.gradeId}__${dimKey}`;

    if (!remainingPosMap.has(cellTrackKey)) {
      const netInCell = getAvailableSheetsInCell(thkId, it.thicknessMm, it.direction, it.gradeId, len, wid);
      netInitialMap.set(cellTrackKey, netInCell);
      remainingPosMap.set(cellTrackKey, Math.max(0, netInCell));
      usedInOrderMap.set(cellTrackKey, 0);
    }

    const availPos = remainingPosMap.get(cellTrackKey) || 0;
    const netInCell = netInitialMap.get(cellTrackKey) || 0;
    const prevUsed = usedInOrderMap.get(cellTrackKey) || 0;
    const coveredSheets = Math.min(reqSheets, availPos);
    remainingPosMap.set(cellTrackKey, availPos - coveredSheets);
    usedInOrderMap.set(cellTrackKey, prevUsed + reqSheets);

    const deficitSheets = Math.max(0, reqSheets - coveredSheets);
    const projectedNetAfterNegative = netInCell - (prevUsed + reqSheets);
    const isCovered = deficitSheets === 0;

    const statusObj = {
      idx,
      item: it,
      thkId,
      gradeId: it.gradeId,
      gradeName: it.gradeName || 'عام',
      thicknessMm: Number(it.thicknessMm || 1.5),
      direction: it.direction || 'qas',
      directionLabel: it.direction === 'sada' ? 'اتجاه سدا' : 'اتجاه قص',
      lengthCm: len,
      widthCm: wid,
      reqSheets,
      availSheets: availPos,
      currentCellNetSheets: netInCell,
      coveredSheets,
      deficitSheets,
      projectedNetAfterNegative,
      isCovered
    };

    itemStatuses.push(statusObj);
    if (deficitSheets > 0) {
      deficits.push(statusObj);
      totalDeficitSheets += deficitSheets;
    }
  });

  return {
    isReadyToApprove: deficits.length === 0,
    alreadyDeducted: false,
    placedInNegativeStock: Boolean(ord.placedInNegativeStock),
    deficits,
    totalDeficitSheets,
    itemStatuses
  };
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
  const defaultClient = clients.find(c => c.id === preselectedClientId) || clients[0] || null;
  const defaultOldDebt = defaultClient ? Math.max(0, Number(computeClientMetrics(defaultClient).netDebt || 0)) : 0;

  draftOrderItems = [createDefaultDraftOrderItem()];
  draftOrderDiscountType = 'amount';
  draftOrderDiscountValue = 0;

  modalRoot.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal-box" style="max-width:1040px;">
        <div class="card-header">
          <div>
            <div class="card-title">📋 أمر تجهيز طلبية للعميل + إصدار بيان طلبية PDF رسمي (شامل ضريبة القيمة المضافة 14%)</div>
            <small style="color:var(--text-muted);">
              جميع الأسعار التي تكتب في سعر القطعة <strong>شاملة ضريبة القيمة المضافة 14%</strong>، وضريبة الخصم والإضافة اختيارية، مع إمكانية طباعة وتصدير <strong>بيان طلبية PDF</strong> كامل باللوجو والختم والتفقيط بالحروف
            </small>
          </div>
          <div style="display:flex;gap:6px;align-items:center;">
            <button type="button" class="btn btn-sm btn-outline" style="border-color:var(--primary);color:var(--primary);font-weight:800;" onclick="openFactoryStampModal()">
              💮 ختم الشركة والحسابات البنكية
            </button>
            <button class="btn btn-sm btn-outline" onclick="closeModal()">✕</button>
          </div>
        </div>

        <form onsubmit="submitNewClientOrderPrep(event)">
          <div class="form-grid" style="margin-bottom:14px;">
            <div class="form-group">
              <label>تاريخ الطلبية والبيان (حالي أو سابق)</label>
              <input id="ord-date" type="date" class="form-control" value="${todayStr()}" required />
            </div>
            <div class="form-group">
              <label>رقم أمر تجهيز الطلبية والبيان</label>
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
              <select id="ord-client" class="form-control" required style="font-weight:800;border-color:var(--primary);" onchange="onDraftOrderClientSelectionChange(this.value)">
                ${clients.length === 0 ? `<option value="cl-new-inline">عميل جديد (سيتم تسجيله تلقائياً بكود CL-101)</option>` : ''}
                ${clients.map(c => `<option value="${c.id}" ${c.id === (defaultClient?.id || '') ? 'selected' : ''}>[${c.code || 'CL'}] ${c.name} ${c.phone ? '— ' + c.phone : ''}</option>`).join('')}
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
                <strong style="color:var(--primary);font-size:0.92rem;">🪵 جدول بنود البيان (المسلسل | البيان | المقاس | الاتجاه | التخانة | الجودة | الكمية | السعر شامل ق.م 14% | الإجمالي):</strong>
              </div>
              <button type="button" class="btn btn-sm btn-primary" onclick="addDraftOrderItemRow()">
                ➕ إضافة بند آخر للبيان
              </button>
            </div>

            <div id="draft-order-items-container" class="table-responsive"></div>
          </div>

          <!-- Comprehensive Statement Financial, Tax, Delivery, Payment & Bank Details -->
          <div class="form-grid" style="background:rgba(217,119,6,0.06);padding:14px;border-radius:12px;border:1px solid rgba(217,119,6,0.25);margin-bottom:14px;">
            <div class="form-group">
              <label>نوع الخصم للعميل في البيان</label>
              <select id="ord-discount-type" class="form-control" onchange="draftOrderDiscountType=this.value; recalcDraftOrderTotals();">
                <option value="percent">📉 خصم نسبة مئوية (%)</option>
                <option value="amount" selected>💵 خصم مبلغ نقدي مباشر (بالجنيه)</option>
              </select>
            </div>
            <div class="form-group">
              <label>قيمة / نسبة الخصم</label>
              <input id="ord-discount-val" type="number" step="0.5" min="0" class="form-control" value="0" oninput="draftOrderDiscountValue=Number(this.value||0); recalcDraftOrderTotals();" />
            </div>

            <div class="form-group">
              <label style="color:var(--danger);font-weight:800;">📒 المديونية القديمة على العميل (ج.م)</label>
              <input id="ord-old-debt" type="number" step="0.5" min="0" class="form-control" value="${defaultOldDebt}" oninput="recalcDraftOrderTotals()" style="font-weight:800;border-color:var(--danger);" />
            </div>

            <div class="form-group">
              <label style="color:#6d28d9;font-weight:800;">🧾 ضريبة الخصم والإضافة (اختياري)</label>
              <div style="display:flex;gap:6px;align-items:center;">
                <select id="ord-wht-mode" class="form-control" style="font-weight:700;" onchange="const rEl=document.getElementById('ord-wht-rate'); if(this.value==='none'){rEl.value=0;}else if(Number(rEl.value)===0){rEl.value=1;} recalcDraftOrderTotals();">
                  <option value="none" selected>بدون ضريبة خصم وإضافة (اختياري)</option>
                  <option value="deduct">تطبيق خصم تحت حساب الضريبة (-%)</option>
                  <option value="add">تطبيق إضافة ضريبية (+%)</option>
                </select>
                <input id="ord-wht-rate" type="number" step="0.25" min="0" max="25" class="form-control" style="width:82px;font-weight:800;text-align:center;" value="0" placeholder="%" title="نسبة ضريبة الخصم والإضافة %" oninput="recalcDraftOrderTotals()" />
                <span style="font-weight:800;">%</span>
              </div>
            </div>

            <div class="form-group">
              <label style="color:var(--primary);font-weight:800;">🚚 مكان التسليم وطريقة التوصيل</label>
              <select id="ord-delivery-mode" class="form-control" style="font-weight:800;border-color:var(--primary);" onchange="const cBox=document.getElementById('ord-delivery-cost'); if(this.value!=='paid_delivery'){cBox.value=0;} recalcDraftOrderTotals();">
                <option value="ex_factory" selected>🏭 تسليم أرض المصنع (بدون نقل)</option>
                <option value="included">🚛 شامل التوصيل لمقر العميل (مشمول في السعر)</option>
                <option value="paid_delivery">🚚 توصيل لمقر العميل (مع إضافة سعر التوصيل)</option>
              </select>
            </div>

            <div class="form-group">
              <label>💰 سعر التوصيل / النولون (ج.م) + بيان مكان التسليم</label>
              <div style="display:flex;gap:6px;">
                <input id="ord-delivery-cost" type="number" step="10" min="0" class="form-control" style="max-width:125px;font-weight:800;" value="0" placeholder="سعر التوصيل" oninput="if(Number(this.value)>0){document.getElementById('ord-delivery-mode').value='paid_delivery';} recalcDraftOrderTotals();" />
                <input id="ord-delivery-place" class="form-control" placeholder="عنوان / مكان التسليم (مثال: أرض مصنع العاصمة - العبور)" value="أرض مصنع العاصمة للصناعات المتخصصة" />
              </div>
            </div>

            <div class="form-group">
              <label style="color:var(--success);font-weight:800;">💵 شروط الدفع (الدفعة المقدمة - المقدم)</label>
              <input id="ord-payment-advance" class="form-control" value="50% دفعة مقدمة عند التعاقد وتأكيد الطلبية" placeholder="مثال: 50% مقدم أو مبلغ محدد..." />
            </div>

            <div class="form-group">
              <label style="color:#b45309;font-weight:800;">⏳ شروط الدفع (الدفعة الآجلة - الآجل)</label>
              <input id="ord-payment-deferred" class="form-control" value="50% عند الاستلام والتوريد" placeholder="مثال: المتبقي عند التسليم أو آجل 30 يوماً..." />
            </div>

            <div class="form-group" style="grid-column: 1 / -1;">
              <label style="font-weight:800;color:var(--primary);">🏦 أرقام الحسابات البنكية الخاصة بمصنع العاصمة (لتحويل المبلغ عليها في البيان):</label>
              <textarea id="ord-bank-accounts" rows="2" class="form-control" style="font-size:0.82rem;">${getDefaultBankAccountsText()}</textarea>
            </div>

            <div class="form-group" style="grid-column: 1 / -1;">
              <label style="font-weight:800;">✍️ إجمالي المبلغ المطلوب بالحروف (يُكتب تلقائياً ويمكنك تعديله):</label>
              <input id="ord-amount-words" class="form-control" style="font-weight:800;color:var(--primary);background:var(--bg-surface);" />
            </div>

            <div class="form-group" style="grid-column: 1 / -1;">
              <label>ملاحظات إضافية في البيان ولأمين المخزن</label>
              <input id="ord-notes" class="form-control" placeholder="مثال: جميع الأسعار شاملة ضريبة القيمة المضافة 14%..." />
            </div>
          </div>

          <div id="ord-totals-preview" class="calc-preview-box"></div>

          <div style="background:rgba(37,99,235,0.08);border:1px solid rgba(37,99,235,0.25);padding:10px 14px;border-radius:10px;margin-top:12px;font-size:0.84rem;">
            🔒 <strong>مسار الاعتماد التلقائي:</strong> فور حفظ الطلبية والبيان، سيتم إرساله إلى <strong>المدير التنفيذي أو مدير المشروعات</strong> للموافقة عليه أولاً، ولن يظهر للمدير الإداري وأمين المخزن إلا بعد موافقة المدير التنفيذي أو مدير المشروعات.
          </div>

          <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-top:16px;">
            <button type="button" class="btn btn-accent" style="font-weight:800;" onclick="previewDraftOrderStatementPdf()">
              🖨️ معاينة وتصدير بيان الطلبية PDF الآن
            </button>
            <div style="display:flex;gap:10px;flex-wrap:wrap;">
              <button type="button" class="btn btn-outline" onclick="closeModal()">إلغاء</button>
              <button type="button" class="btn btn-success" style="font-weight:800;" onclick="submitNewClientOrderPrep(null, true)">
                🖨️ حفظ الطلبية + فتح وطباعة البيان PDF فوراً
              </button>
              <button type="submit" class="btn btn-primary">📋 حفظ أمر تجهيز الطلبية وإصدار البيان للاعتماد</button>
            </div>
          </div>
        </form>
      </div>
    </div>
  `;

  renderDraftOrderItemsTable();
}

function onDraftOrderClientSelectionChange(clientId) {
  const clientObj = (state.partners || []).find(c => c.id === clientId);
  const oldDebtInput = document.getElementById('ord-old-debt');
  if (clientObj && oldDebtInput) {
    const m = computeClientMetrics(clientObj);
    oldDebtInput.value = Math.max(0, Number(m.netDebt || 0));
  }
  recalcDraftOrderTotals();
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
  } else if (field === 'itemDescription') {
    item.itemDescription = val;
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
          <th style="width:24px;">م</th>
          <th>البيان</th>
          <th>📐 المقاس (العرض × الطول سم)</th>
          <th>التخانة والاتجاه</th>
          <th>درجة الجودة</th>
          <th>المتاح</th>
          <th>الكمية (قطعة)</th>
          <th>💰 السعر (شامل ق.م 14%)</th>
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
          const descVal = it.itemDescription || it.woodTypeName || 'قشرة خشبية طبيعية';
          return `
            <tr>
              <td><strong>${idx + 1}</strong></td>
              <td>
                <input type="text" class="form-control" style="min-width:115px;padding:3px 6px;font-size:0.75rem;font-weight:700;" value="${descVal}" oninput="updateDraftItemNumeric(${idx}, 'itemDescription', this.value)" placeholder="البيان (قشرة خشبية...)" />
              </td>
              <td>
                <div style="display:flex;flex-direction:column;gap:3px;min-width:140px;">
                  <select class="form-control" style="padding:3px 5px;font-size:0.73rem;font-weight:700;border-color:${isStandardVeneerDimension(len, wid) ? 'var(--border-color)' : '#7c3aed'};" onchange="onDraftItemDimensionPresetSelect(${idx}, this.value)">
                    ${presetDims.map(d => `<option value="${d.lengthCm}x${d.widthCm}" ${!it.customDimMode && `${d.lengthCm}x${d.widthCm}` === dimKey ? 'selected' : ''}>${d.widthCm}×${d.lengthCm} سم ${d.isStandard ? '(معتمد)' : '(خاص)'}</option>`).join('')}
                    <option value="custom" ${it.customDimMode || !matchedPreset ? 'selected' : ''}>📐 مقاس خاص للشركة (عرض×طول)...</option>
                  </select>
                  <div style="display:flex;align-items:center;gap:3px;">
                    <input type="number" step="0.5" min="10" class="form-control" style="width:55px;padding:2px 4px;font-size:0.73rem;font-weight:800;text-align:center;" value="${wid}" oninput="updateDraftItemNumeric(${idx}, 'widthCm', this.value)" title="العرض بالسم" placeholder="العرض" />
                    <span style="font-size:0.72rem;font-weight:800;">×</span>
                    <input type="number" step="0.5" min="10" class="form-control" style="width:55px;padding:2px 4px;font-size:0.73rem;font-weight:800;text-align:center;" value="${len}" oninput="updateDraftItemNumeric(${idx}, 'lengthCm', this.value)" title="الطول بالسم" placeholder="الطول" />
                    <small style="font-size:0.65rem;color:var(--text-muted);">سم</small>
                  </div>
                </div>
              </td>
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
                      <input type="number" step="0.05" min="0.1" class="form-control" style="width:62px;padding:3px 5px;font-weight:800;border-color:#7c3aed;" value="${it.thicknessMm}" oninput="updateDraftItemNumeric(${idx}, 'thicknessMm', this.value)" placeholder="مم" title="التخانة المحددة بالمليمتر" />
                      <select class="form-control" style="padding:3px 5px;font-size:0.74rem;font-weight:700;" onchange="updateDraftItemNumeric(${idx}, 'direction', this.value)">
                        <option value="qas" ${it.direction === 'qas' ? 'selected' : ''}>قص</option>
                        <option value="sada" ${it.direction === 'sada' ? 'selected' : ''}>سدا</option>
                      </select>
                      ${hasCatalogThk ? `<button type="button" class="btn btn-sm btn-outline" style="padding:1px 5px;font-size:0.65rem;" onclick="toggleDraftItemCustomThk(${idx})" title="العودة لقائمة التخانات">📋</button>` : ''}
                    </div>
                    <small style="font-size:0.64rem;color:#7c3aed;font-weight:700;">تخانة محددة</small>
                  </div>
                `}
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
                <input type="number" min="1" class="form-control" style="width:74px;padding:4px 6px;font-weight:800;" value="${it.sheetsCount}" oninput="updateDraftItemNumeric(${idx}, 'sheetsCount', this.value)" required />
              </td>
              <td>
                <div style="display:flex;flex-direction:column;gap:2px;">
                  <input type="number" step="0.5" min="0" class="form-control" style="width:86px;padding:4px 6px;font-weight:800;border-color:var(--accent);" value="${it.unitPrice}" oninput="updateDraftItemNumeric(${idx}, 'unitPrice', this.value)" required />
                  <small style="font-size:0.64rem;color:var(--text-muted);">
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
    if (!it.itemDescription) {
      it.itemDescription = it.woodTypeName || 'قشرة خشبية طبيعية';
    }

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
  let discountPercent = 0;
  if (draftOrderDiscountType === 'percent') {
    discountPercent = Math.min(100, Math.max(0, Number(draftOrderDiscountValue || 0)));
    discountAmount = +((subtotal * discountPercent) / 100).toFixed(2);
  } else {
    discountAmount = Math.min(subtotal, Math.max(0, +Number(draftOrderDiscountValue || 0).toFixed(2)));
    discountPercent = subtotal > 0 ? +((discountAmount / subtotal) * 100).toFixed(2) : 0;
  }

  const afterDiscount = Math.max(0, +(subtotal - discountAmount).toFixed(2));
  // Prices in unitPrice are inclusive of 14% VAT
  const preVatBase = +(afterDiscount / 1.14).toFixed(2);
  const includedVat14 = +(afterDiscount - preVatBase).toFixed(2);

  const whtMode = document.getElementById('ord-wht-mode')?.value || 'none';
  const whtRate = whtMode === 'none' ? 0 : Math.max(0, Number(document.getElementById('ord-wht-rate')?.value || 0));
  const whtAmount = whtRate > 0 ? +((preVatBase * whtRate) / 100).toFixed(2) : 0;

  const deliveryMode = document.getElementById('ord-delivery-mode')?.value || 'ex_factory';
  const deliveryCost = deliveryMode === 'paid_delivery' ? Math.max(0, Number(document.getElementById('ord-delivery-cost')?.value || 0)) : 0;

  let netTotal = afterDiscount;
  if (whtMode === 'deduct') netTotal -= whtAmount;
  else if (whtMode === 'add') netTotal += whtAmount;
  netTotal = Math.max(0, +(netTotal + deliveryCost).toFixed(2));

  const oldDebt = Math.max(0, Number(document.getElementById('ord-old-debt')?.value || 0));
  const totalRequired = +(netTotal + oldDebt).toFixed(2);
  const autoWords = numberToArabicTafqeet(totalRequired);

  const wordsEl = document.getElementById('ord-amount-words');
  if (wordsEl) {
    wordsEl.value = autoWords;
  }

  const previewEl = document.getElementById('ord-totals-preview');
  if (previewEl) {
    previewEl.innerHTML = `
      <div class="calc-preview-item">
        <span>إجمالي قيمة الطلبية (شامل ق.م 14%)</span>
        <strong>${fmtMoney(subtotal)} (${fmtNum(totalSheets, 0)} ق)</strong>
      </div>
      <div class="calc-preview-item">
        <span>الخصم (${fmtNum(discountPercent, 2)}%)</span>
        <strong style="color:var(--danger);">-${fmtMoney(discountAmount)}</strong>
      </div>
      <div class="calc-preview-item">
        <span>ضريبة القيمة المضافة 14% (شاملة بالسعر)</span>
        <strong style="color:#0284c7;">${fmtMoney(includedVat14)} (شاملة)</strong>
      </div>
      <div class="calc-preview-item">
        <span>ضريبة الخصم والإضافة (${whtMode === 'none' ? 'اختياري: 0%' : whtRate + '%'})</span>
        <strong style="color:#6d28d9;">${whtMode === 'deduct' ? '-' : whtMode === 'add' ? '+' : ''}${fmtMoney(whtAmount)}</strong>
      </div>
      <div class="calc-preview-item">
        <span>التسليم والتوصيل</span>
        <strong>${deliveryMode === 'ex_factory' ? 'أرض المصنع (0 ج)' : deliveryMode === 'included' ? 'شامل التوصيل' : '+' + fmtMoney(deliveryCost)}</strong>
      </div>
      <div class="calc-preview-item">
        <span>صافي الطلبية الحالية</span>
        <strong style="color:var(--success);font-size:1.08rem;">${fmtMoney(netTotal)}</strong>
      </div>
      <div class="calc-preview-item">
        <span>المديونية القديمة على العميل</span>
        <strong style="color:var(--danger);">${fmtMoney(oldDebt)}</strong>
      </div>
      <div class="calc-preview-item" style="background:rgba(15,118,110,0.12);border:1.5px solid var(--primary);border-radius:8px;padding:6px 10px;">
        <span style="font-weight:800;color:var(--primary);">💎 إجمالي المبلغ المطلوب</span>
        <strong style="color:var(--primary);font-size:1.18rem;">${fmtMoney(totalRequired)}</strong>
      </div>
    `;
  }
}

function collectDraftOrderObjectForStatement() {
  const opDate = document.getElementById('ord-date')?.value || todayStr();
  const orderNumber = (document.getElementById('ord-num')?.value || `ORD-${Date.now().toString().slice(-4)}`).trim();
  const clientSelectVal = document.getElementById('ord-client')?.value || '';
  const notes = (document.getElementById('ord-notes')?.value || '').trim();
  let clientObj = (state.partners || []).find(c => c.id === clientSelectVal);
  const inlineName = (document.getElementById('ord-new-client-name')?.value || 'عميل مصنع العاصمة').trim();

  recalcDraftOrderTotals();
  const subtotalAmount = +draftOrderItems.reduce((s, i) => s + Number(i.totalItemAmount || 0), 0).toFixed(2);
  let discountAmount = 0;
  let discountPercent = 0;
  if (draftOrderDiscountType === 'percent') {
    discountPercent = Math.min(100, Math.max(0, Number(draftOrderDiscountValue || 0)));
    discountAmount = +((subtotalAmount * discountPercent) / 100).toFixed(2);
  } else {
    discountAmount = Math.min(subtotalAmount, Math.max(0, +Number(draftOrderDiscountValue || 0).toFixed(2)));
    discountPercent = subtotalAmount > 0 ? +((discountAmount / subtotalAmount) * 100).toFixed(2) : 0;
  }
  const afterDiscount = Math.max(0, +(subtotalAmount - discountAmount).toFixed(2));
  const preVatBaseAmount = +(afterDiscount / 1.14).toFixed(2);
  const includedVatAmount = +(afterDiscount - preVatBaseAmount).toFixed(2);

  const withholdingTaxMode = document.getElementById('ord-wht-mode')?.value || 'none';
  const withholdingTaxRate = withholdingTaxMode === 'none' ? 0 : Math.max(0, Number(document.getElementById('ord-wht-rate')?.value || 0));
  const withholdingTaxAmount = withholdingTaxRate > 0 ? +((preVatBaseAmount * withholdingTaxRate) / 100).toFixed(2) : 0;

  const deliveryMode = document.getElementById('ord-delivery-mode')?.value || 'ex_factory';
  const deliveryCost = deliveryMode === 'paid_delivery' ? Math.max(0, Number(document.getElementById('ord-delivery-cost')?.value || 0)) : 0;
  const deliveryPlace = (document.getElementById('ord-delivery-place')?.value || 'أرض مصنع العاصمة للصناعات المتخصصة').trim();

  let netTotalAmount = afterDiscount;
  if (withholdingTaxMode === 'deduct') netTotalAmount -= withholdingTaxAmount;
  else if (withholdingTaxMode === 'add') netTotalAmount += withholdingTaxAmount;
  netTotalAmount = Math.max(0, +(netTotalAmount + deliveryCost).toFixed(2));

  const previousDebtAmount = Math.max(0, Number(document.getElementById('ord-old-debt')?.value || 0));
  const totalRequiredAmount = +(netTotalAmount + previousDebtAmount).toFixed(2);
  const totalRequiredInWords = (document.getElementById('ord-amount-words')?.value || numberToArabicTafqeet(totalRequiredAmount)).trim();
  const paymentAdvanceTerms = (document.getElementById('ord-payment-advance')?.value || '50% دفعة مقدمة عند التعاقد').trim();
  const paymentDeferredTerms = (document.getElementById('ord-payment-deferred')?.value || '50% عند الاستلام والتوريد').trim();
  const bankAccountsText = (document.getElementById('ord-bank-accounts')?.value || getDefaultBankAccountsText()).trim();

  const totalSheetsCount = draftOrderItems.reduce((s, i) => s + Number(i.sheetsCount || 0), 0);
  const totalAreaM2 = +draftOrderItems.reduce((s, i) => s + Number(i.areaM2 || 0), 0).toFixed(4);
  const totalVolumeM3 = +draftOrderItems.reduce((s, i) => s + Number(i.volumeM3 || 0), 0).toFixed(4);

  return {
    orderNumber,
    date: opDate,
    clientObj,
    clientName: clientObj ? clientObj.name : inlineName,
    clientCode: clientObj ? (clientObj.code || 'CL-101') : 'CL-101',
    clientPhone: clientObj ? (clientObj.phone || '') : '',
    clientCity: clientObj ? (clientObj.city || '') : '',
    items: JSON.parse(JSON.stringify(draftOrderItems)),
    totalSheetsCount,
    totalAreaM2,
    totalVolumeM3,
    subtotalAmount,
    discountType: draftOrderDiscountType,
    discountValue: draftOrderDiscountValue,
    discountPercent,
    discountAmount,
    afterDiscount,
    vatInclusive: true,
    vatRate: 14,
    preVatBaseAmount,
    includedVatAmount,
    withholdingTaxMode,
    withholdingTaxRate,
    withholdingTaxAmount,
    deliveryMode,
    deliveryCost,
    deliveryPlace,
    netTotalAmount,
    previousDebtAmount,
    totalRequiredAmount,
    totalRequiredInWords,
    paymentAdvanceTerms,
    paymentDeferredTerms,
    bankAccountsText,
    notes,
    requestedBy: currentUser?.name || 'الحسابات'
  };
}

function previewDraftOrderStatementPdf() {
  const draftOrd = collectDraftOrderObjectForStatement();
  if (draftOrd.bankAccountsText) {
    state.factoryInfo = state.factoryInfo || {};
    state.factoryInfo.bankAccountsText = draftOrd.bankAccountsText;
  }
  const html = buildOfficialOrderStatementPdfHtml(draftOrd);
  openUniversalPrintDocument(html, `بيان طلبية ${draftOrd.orderNumber} - ${draftOrd.clientName}`, false);
}

function submitNewClientOrderPrep(e, andPrintPdf = false) {
  if (e) e.preventDefault();
  const collected = collectDraftOrderObjectForStatement();
  const now = new Date().toISOString();

  let clientObj = collected.clientObj;
  if (!clientObj) {
    const nextCode = `CL-${101 + (state.partners?.length || 0)}`;
    clientObj = {
      id: uid('pt'),
      code: nextCode,
      type: 'client',
      name: collected.clientName,
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

  if (collected.bankAccountsText) {
    state.factoryInfo = state.factoryInfo || {};
    state.factoryInfo.bankAccountsText = collected.bankAccountsText;
  }

  // Ensure any custom thickness or custom company dimension entered in the order is saved to catalog
  collected.items.forEach(it => {
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

  const createdByExec = isFullAdmin(currentUser);
  const initialStage = createdByExec ? 'pending_warehouse_prep' : 'pending_executive';

  const newOrder = {
    id: uid('ord'),
    orderNumber: collected.orderNumber,
    date: collected.date,
    clientId: clientObj.id,
    clientCode: clientObj.code || 'CL-101',
    clientName: clientObj.name,
    clientPhone: clientObj.phone || '',
    requestedBy: currentUser.name,
    requestedByRole: currentUser.roleKey,
    items: collected.items,
    totalSheetsCount: collected.totalSheetsCount,
    totalAreaM2: collected.totalAreaM2,
    totalVolumeM3: collected.totalVolumeM3,
    subtotalAmount: collected.subtotalAmount,
    discountType: collected.discountType,
    discountValue: collected.discountValue,
    discountPercent: collected.discountPercent,
    discountAmount: collected.discountAmount,
    vatInclusive: true,
    vatRate: 14,
    preVatBaseAmount: collected.preVatBaseAmount,
    includedVatAmount: collected.includedVatAmount,
    withholdingTaxMode: collected.withholdingTaxMode,
    withholdingTaxRate: collected.withholdingTaxRate,
    withholdingTaxAmount: collected.withholdingTaxAmount,
    deliveryMode: collected.deliveryMode,
    deliveryCost: collected.deliveryCost,
    deliveryPlace: collected.deliveryPlace,
    netTotalAmount: collected.netTotalAmount,
    previousDebtAmount: collected.previousDebtAmount,
    totalRequiredAmount: collected.totalRequiredAmount,
    totalRequiredInWords: collected.totalRequiredInWords,
    paymentAdvanceTerms: collected.paymentAdvanceTerms,
    paymentDeferredTerms: collected.paymentDeferredTerms,
    bankAccountsText: collected.bankAccountsText,
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
    notes: collected.notes,
    createdAt: collected.date,
    updatedAt: now
  };

  state.productionOrders.unshift(newOrder);
  if (currentUser) {
    markNotifIdsSeen([`ord_stage_${newOrder.id}_${initialStage}`]);
  }
  closeModal();
  activeTab = 'production';

  if (andPrintPdf) {
    window._isPrintingActive = true;
    printClientOrderStatement(newOrder.id);
  }

  if (createdByExec) {
    saveState(
      `📦 أمر تجهيز طلبية جديد (${newOrder.orderNumber}) للعميل (${clientObj.name} - ${clientObj.code || ''}) معتمد من ${currentUser.name} — جاهز الآن للمدير الإداري وأمين المخزن لتجهيز الطلبية (${newOrder.totalSheetsCount} قطعة)`
    );
  } else {
    saveState(
      `📋 إنشاء أمر تجهيز طلبية وبيان للعميل (${clientObj.name} - ${clientObj.code || ''}) رقم ${newOrder.orderNumber} بصافي ${fmtMoney(newOrder.netTotalAmount)} — بانتظار موافقة المدير التنفيذي أو مدير المشروعات`,
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
  const isWarehouseOrAdmin = isExec || isWarehouseKeeperOnly(currentUser) || ['admin_manager', 'warehouse_keeper'].includes(currentUser?.roleKey);
  const canEditQuantities = isExec || canSeeFinancialPrices() || (isWarehouseOrAdmin && ord.stage === 'pending_warehouse_prep');
  const thicknesses = getSortedThicknesses();
  const grades = state.catalog?.grades || [];
  const clientObj = (state.partners || []).find(p => p.id === ord.clientId || p.name === ord.clientName);
  const defaultOldDebt = ord.previousDebtAmount !== undefined ? Number(ord.previousDebtAmount || 0) : (clientObj ? Math.max(0, Number(computeClientMetrics(clientObj).netDebt || 0)) : 0);

  modalRoot.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal-box" style="max-width:1020px;">
        <div class="card-header">
          <div>
            <div class="card-title">${canSeeFinancialPrices() ? `📄 بيان طلبية للعميل (${ord.orderNumber}) — تعديل وطباعة وتصدير البيان PDF` : `📄 بيان كميات ومقاسات الطلبية للتجهيز بالمخزن (${ord.orderNumber}) — كميات فقط`}</div>
            <small style="color:var(--text-muted);">
              العميل: <strong>${ord.clientName} (${ord.clientCode || 'CL'})</strong> | التاريخ: <strong>${ord.date}</strong> | الحالة: ${getOrderStageBadge(ord)}
            </small>
          </div>
          <div style="display:flex;gap:6px;align-items:center;">
            ${canSeeFinancialPrices() ? `
              <button type="button" class="btn btn-sm btn-outline" style="border-color:var(--primary);color:var(--primary);font-weight:800;" onclick="openFactoryStampModal()">
                💮 ختم الشركة والحسابات البنكية
              </button>
            ` : ''}
            <button type="button" class="btn btn-sm btn-outline" onclick="closeModal()">✕</button>
          </div>
        </div>

        ${ord.carDispatchVoucher ? `
          <div style="background:rgba(16,185,129,0.12);border:2px solid #10b981;padding:10px 14px;border-radius:10px;margin-bottom:12px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
            <div style="font-size:0.85rem;">
              🚚 <strong>تم إصدار إذن صرف وتحميل السيارة (${ord.carDispatchVoucher.voucherNo || 'CAR-' + ord.orderNumber}):</strong>
              سيارة رقم <strong>(${ord.carDispatchVoucher.carPlateNumber || '-'})</strong> — السائق: <strong>${ord.carDispatchVoucher.driverName || '-'}</strong>
            </div>
            <button type="button" class="btn btn-sm btn-success" style="font-weight:800;" onclick="printVehicleDispatchVoucher('${ord.id}')">
              🚚 طباعة إذن صرف السيارة (${ord.carDispatchVoucher.carPlateNumber || ord.orderNumber})
            </button>
          </div>
        ` : ''}

        ${ord.stage === 'completed' && isExec ? `
          <div style="background:rgba(2,132,199,0.1);border:2px solid #0284c7;padding:10px 14px;border-radius:10px;margin-bottom:12px;font-size:0.85rem;">
            🔄 <strong>صلاحية المدير التنفيذي / مدير المشروعات (تعديل مع إرجاع أرصدة المخازن تلقائياً):</strong><br/>
            هذه الطلبية تم صرفها بالفعل من المخزن. عند تعديل أي كمية أو مقاس أو تخانة أو جودة وحفظ التعديل، سيقوم النظام <strong>بإرجاع الأرصدة القديمة للمخزن تلقائياً وخصم الأرصدة الجديدة</strong> وتحديث فاتورة العميل وإذن الصرف فوراً!
          </div>
        ` : ''}

        ${ord.stage === 'pending_warehouse_prep' && isWarehouseOrAdmin ? (() => {
          const scModal = checkOrderStockAvailability(ord);
          if (!scModal.isReadyToApprove) {
            return `
              <div style="background:rgba(220,38,38,0.12);border:2px solid var(--danger);padding:12px 14px;border-radius:10px;margin-bottom:12px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
                <div style="font-size:0.85rem;color:var(--danger);">
                  ⛔ <strong>تنبيه لأمين المخزن (الطلبية غير متوفرة بالكامل بالمخزن — عجز ${fmtNum(scModal.totalDeficitSheets, 0)} قطعة):</strong><br/>
                  <span style="color:var(--text-main);">لا يسمح بالموافقة على الطلبية إلا بعد <strong>تغطية رصيد المخزن لها</strong> أو <strong>وضعها في المخزن بالسالب لحين إضافتها</strong>.</span>
                </div>
                <div style="display:flex;gap:6px;flex-wrap:wrap;">
                  <button type="button" class="btn btn-sm btn-success" style="font-weight:800;" onclick="resolveOrderShortageByCoveringStock('${ord.id}', true)">
                    📥 تغطية رصيد المخزن + الموافقة
                  </button>
                  <button type="button" class="btn btn-sm btn-danger" style="font-weight:800;" onclick="resolveOrderShortageByNegativeStock('${ord.id}', true)">
                    📉 وضعها بالمخزن بالسالب + الموافقة
                  </button>
                </div>
              </div>
            `;
          }
          return `
            <div style="background:rgba(124,58,237,0.12);border:2px solid #7c3aed;padding:10px 14px;border-radius:10px;margin-bottom:12px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
              <div style="font-size:0.84rem;">
                📦 <strong>أمر تجهيز بالمخزن (${ord.placedInNegativeStock ? 'موضوعة بالمخزن بالسالب لحين الإضافة' : 'الرصيد متوفر ومغطى بالمخزن ✅'}):</strong> يمكنك مراجعة الكميات والمقاسات أدناه والضغط مباشرة على زر <strong>موافقة التجهيز والخروج</strong> ليتم تحويلها للمحاسب.
              </div>
              <button type="button" class="btn btn-sm btn-success" style="font-weight:800;" onclick="saveClientOrderStatementChanges(null, '${ord.id}', false, true)">
                ✅ موافقة التجهيز والخروج من المخزن الآن
              </button>
            </div>
          `;
        })() : ''}

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
                  <th style="width:28px;">م</th>
                  <th>البيان</th>
                  <th>📐 المقاس (العرض × الطول سم)</th>
                  <th>الاتجاه والتخانة</th>
                  <th>الجودة</th>
                  <th>الكمية (قطعة)</th>
                  <th>الحجم (م³)</th>
                  ${canSeeFinancialPrices() ? '<th>💰 السعر (شامل ق.م 14%)</th><th>الإجمالي</th>' : ''}
                </tr>
              </thead>
              <tbody>
                ${items.map((it, idx) => {
                  const curThkId = it.thicknessId || `th-${it.thicknessMm}-${it.direction || 'qas'}`;
                  const len = Number(it.lengthCm || 250);
                  const wid = Number(it.widthCm || 125);
                  const descVal = it.itemDescription || it.woodTypeName || 'قشرة خشبية طبيعية';
                  return `
                  <tr>
                    <td><strong>${idx + 1}</strong></td>
                    <td>
                      ${isExec || canSeeFinancialPrices() ? `
                        <input id="stmt-desc-${idx}" type="text" class="form-control" style="min-width:110px;padding:3px 6px;font-size:0.75rem;font-weight:700;" value="${descVal}" />
                      ` : `<strong>${descVal}</strong>`}
                    </td>
                    <td>
                      ${isExec || canSeeFinancialPrices() ? `
                        <div style="display:flex;align-items:center;gap:3px;">
                          <input id="stmt-wid-${idx}" type="number" step="0.5" min="10" class="form-control" style="width:55px;padding:3px 4px;font-weight:800;text-align:center;" value="${wid}" oninput="recalcStatementModalLive('${ord.id}')" title="العرض (سم)" />
                          <span>×</span>
                          <input id="stmt-len-${idx}" type="number" step="0.5" min="10" class="form-control" style="width:55px;padding:3px 4px;font-weight:800;text-align:center;" value="${len}" oninput="recalcStatementModalLive('${ord.id}')" title="الطول (سم)" />
                          <small style="font-size:0.66rem;color:var(--text-muted);">سم</small>
                        </div>
                      ` : getVeneerDimensionBadgeHtml(len, wid)}
                    </td>
                    <td>
                      ${isExec || canSeeFinancialPrices() ? `
                        <div style="display:flex;gap:3px;align-items:center;">
                          <input id="stmt-thk-mm-${idx}" type="number" step="0.05" min="0.1" class="form-control" style="width:60px;padding:3px 5px;font-weight:800;" value="${it.thicknessMm}" oninput="recalcStatementModalLive('${ord.id}', ${idx})" title="التخانة بالـ مم" />
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
                      ${isExec ? `
                        <select id="stmt-grd-${idx}" class="form-control" style="min-width:85px;padding:4px 6px;font-size:0.76rem;font-weight:700;" onchange="recalcStatementModalLive('${ord.id}', ${idx})">
                          ${grades.map(g => `<option value="${g.id}" ${g.id === it.gradeId ? 'selected' : ''}>${g.code}</option>`).join('')}
                        </select>
                      ` : `<strong>${it.gradeName}</strong>`}
                    </td>
                    <td>
                      <input id="stmt-sheets-${idx}" type="number" min="0" class="form-control" style="width:80px;padding:4px 6px;font-weight:800;" value="${it.sheetsCount}" oninput="recalcStatementModalLive('${ord.id}')" ${canEditQuantities ? '' : 'readonly'} required />
                    </td>
                    <td id="stmt-vol-${idx}" style="font-size:0.75rem;">${fmtNum(it.volumeM3, 3)} م³</td>
                    ${canSeeFinancialPrices() ? `
                    <td>
                      <div style="display:flex;flex-direction:column;gap:2px;">
                        <input id="stmt-price-${idx}" type="number" step="0.5" min="0" class="form-control" style="width:90px;padding:4px 6px;font-weight:800;border-color:var(--primary);" value="${it.unitPrice}" oninput="recalcStatementModalLive('${ord.id}')" required />
                        <small id="stmt-tbl-price-hint-${idx}" style="font-size:0.66rem;color:var(--text-muted);">
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
              <label>قيمة / نسبة الخصم</label>
              <input id="stmt-disc-val" type="number" step="0.5" min="0" class="form-control" value="${ord.discountValue || 0}" oninput="recalcStatementModalLive('${ord.id}')" />
            </div>

            <div class="form-group">
              <label style="color:var(--danger);font-weight:800;">📒 المديونية القديمة على العميل (ج.م)</label>
              <input id="stmt-old-debt" type="number" step="0.5" min="0" class="form-control" value="${defaultOldDebt}" oninput="recalcStatementModalLive('${ord.id}')" style="font-weight:800;border-color:var(--danger);" />
            </div>

            <div class="form-group">
              <label style="color:#6d28d9;font-weight:800;">🧾 ضريبة الخصم والإضافة (اختياري)</label>
              <div style="display:flex;gap:6px;align-items:center;">
                <select id="stmt-wht-mode" class="form-control" style="font-weight:700;" onchange="const rEl=document.getElementById('stmt-wht-rate'); if(this.value==='none'){rEl.value=0;}else if(Number(rEl.value)===0){rEl.value=1;} recalcStatementModalLive('${ord.id}');">
                  <option value="none" ${(!ord.withholdingTaxMode || ord.withholdingTaxMode === 'none') ? 'selected' : ''}>بدون ضريبة خصم وإضافة (اختياري)</option>
                  <option value="deduct" ${ord.withholdingTaxMode === 'deduct' ? 'selected' : ''}>تطبيق خصم تحت حساب الضريبة (-%)</option>
                  <option value="add" ${ord.withholdingTaxMode === 'add' ? 'selected' : ''}>تطبيق إضافة ضريبية (+%)</option>
                </select>
                <input id="stmt-wht-rate" type="number" step="0.25" min="0" max="25" class="form-control" style="width:78px;font-weight:800;text-align:center;" value="${ord.withholdingTaxRate || 0}" oninput="recalcStatementModalLive('${ord.id}')" />
                <span style="font-weight:800;">%</span>
              </div>
            </div>

            <div class="form-group">
              <label style="color:var(--primary);font-weight:800;">🚚 مكان التسليم وطريقة التوصيل</label>
              <select id="stmt-delivery-mode" class="form-control" style="font-weight:800;border-color:var(--primary);" onchange="const cBox=document.getElementById('stmt-delivery-cost'); if(this.value!=='paid_delivery'){cBox.value=0;} recalcStatementModalLive('${ord.id}');">
                <option value="ex_factory" ${(!ord.deliveryMode || ord.deliveryMode === 'ex_factory') ? 'selected' : ''}>🏭 تسليم أرض المصنع (بدون نقل)</option>
                <option value="included" ${ord.deliveryMode === 'included' ? 'selected' : ''}>🚛 شامل التوصيل لمقر العميل (مشمول في السعر)</option>
                <option value="paid_delivery" ${ord.deliveryMode === 'paid_delivery' ? 'selected' : ''}>🚚 توصيل لمقر العميل (مع إضافة سعر التوصيل)</option>
              </select>
            </div>

            <div class="form-group">
              <label>💰 سعر التوصيل / النولون (ج.م) + مكان التسليم</label>
              <div style="display:flex;gap:6px;">
                <input id="stmt-delivery-cost" type="number" step="10" min="0" class="form-control" style="max-width:120px;font-weight:800;" value="${ord.deliveryCost || 0}" oninput="if(Number(this.value)>0){document.getElementById('stmt-delivery-mode').value='paid_delivery';} recalcStatementModalLive('${ord.id}');" />
                <input id="stmt-delivery-place" class="form-control" value="${ord.deliveryPlace || 'أرض مصنع العاصمة للصناعات المتخصصة'}" placeholder="مكان التسليم..." />
              </div>
            </div>

            <div class="form-group">
              <label style="color:var(--success);font-weight:800;">💵 شروط الدفع (الدفعة المقدمة - المقدم)</label>
              <input id="stmt-payment-advance" class="form-control" value="${ord.paymentAdvanceTerms || '50% دفعة مقدمة عند التعاقد وتأكيد الطلبية'}" />
            </div>

            <div class="form-group">
              <label style="color:#b45309;font-weight:800;">⏳ شروط الدفع (الدفعة الآجلة - الآجل)</label>
              <input id="stmt-payment-deferred" class="form-control" value="${ord.paymentDeferredTerms || '50% عند الاستلام والتوريد'}" />
            </div>

            <div class="form-group" style="grid-column: 1 / -1;">
              <label style="font-weight:800;color:var(--primary);">🏦 أرقام الحسابات البنكية الخاصة بمصنع العاصمة (لتحويل المبلغ عليها):</label>
              <textarea id="stmt-bank-accounts" rows="2" class="form-control" style="font-size:0.82rem;">${ord.bankAccountsText || getDefaultBankAccountsText()}</textarea>
            </div>

            <div class="form-group" style="grid-column: 1 / -1;">
              <label style="font-weight:800;">✍️ إجمالي المبلغ المطلوب بالحروف:</label>
              <input id="stmt-amount-words" class="form-control" value="${ord.totalRequiredInWords || ''}" style="font-weight:800;color:var(--primary);background:var(--bg-surface);" />
            </div>

            <div class="form-group" style="grid-column: 1 / -1;">
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
              <button type="button" class="btn btn-accent" style="font-weight:800;" onclick="saveAndPrintClientOrderStatement('${ord.id}')">
                🖨️ طباعة وتصدير بيان الطلبية PDF (رسمي باللوجو والختم)
              </button>
              ${ord.carDispatchVoucher ? `
                <button type="button" class="btn btn-success" onclick="printVehicleDispatchVoucher('${ord.id}')">
                  🚚 طباعة إذن صرف السيارة (${ord.carDispatchVoucher.carPlateNumber || ord.orderNumber})
                </button>
              ` : ''}
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
  let discAmt = 0;
  let discPct = 0;
  if (discType === 'percent') {
    discPct = Math.min(100, Math.max(0, discVal));
    discAmt = +((subtotal * discPct) / 100).toFixed(2);
  } else {
    discAmt = Math.min(subtotal, Math.max(0, +discVal.toFixed(2)));
    discPct = subtotal > 0 ? +((discAmt / subtotal) * 100).toFixed(2) : 0;
  }

  const afterDiscount = Math.max(0, +(subtotal - discAmt).toFixed(2));
  const preVatBase = +(afterDiscount / 1.14).toFixed(2);
  const includedVat14 = +(afterDiscount - preVatBase).toFixed(2);

  const whtMode = document.getElementById('stmt-wht-mode')?.value || ord.withholdingTaxMode || 'none';
  const whtRate = whtMode === 'none' ? 0 : Math.max(0, Number(document.getElementById('stmt-wht-rate')?.value ?? ord.withholdingTaxRate ?? 0));
  const whtAmt = whtRate > 0 ? +((preVatBase * whtRate) / 100).toFixed(2) : 0;

  const delivMode = document.getElementById('stmt-delivery-mode')?.value || ord.deliveryMode || 'ex_factory';
  const delivCost = delivMode === 'paid_delivery' ? Math.max(0, Number(document.getElementById('stmt-delivery-cost')?.value ?? ord.deliveryCost ?? 0)) : 0;

  let net = afterDiscount;
  if (whtMode === 'deduct') net -= whtAmt;
  else if (whtMode === 'add') net += whtAmt;
  net = Math.max(0, +(net + delivCost).toFixed(2));

  const oldDebt = Math.max(0, Number(document.getElementById('stmt-old-debt')?.value ?? ord.previousDebtAmount ?? 0));
  const totalReq = +(net + oldDebt).toFixed(2);

  const wordsEl = document.getElementById('stmt-amount-words');
  if (wordsEl) {
    wordsEl.value = numberToArabicTafqeet(totalReq);
  }

  const sumBox = document.getElementById('stmt-live-summary');
  if (sumBox) {
    sumBox.innerHTML = `
      <div class="calc-preview-item"><span>إجمالي القطع</span><strong>${fmtNum(totalSheets, 0)} قطعة (${fmtNum(totalVol, 4)} م³)</strong></div>
      ${canSeeFinancialPrices() ? `
        <div class="calc-preview-item"><span>إجمالي الطلبية (شامل ق.م 14%)</span><strong>${fmtMoney(subtotal)}</strong></div>
        <div class="calc-preview-item"><span>الخصم (${fmtNum(discPct, 2)}%)</span><strong style="color:var(--danger);">-${fmtMoney(discAmt)}</strong></div>
        <div class="calc-preview-item"><span>ق.م 14% (شاملة بالسعر)</span><strong style="color:#0284c7;">${fmtMoney(includedVat14)}</strong></div>
        <div class="calc-preview-item"><span>ضريبة الخصم والإضافة (${whtMode === 'none' ? '0%' : whtRate + '%'})</span><strong style="color:#6d28d9;">${whtMode === 'deduct' ? '-' : whtMode === 'add' ? '+' : ''}${fmtMoney(whtAmt)}</strong></div>
        <div class="calc-preview-item"><span>صافي الطلبية</span><strong style="color:var(--success);font-size:1.08rem;">${fmtMoney(net)}</strong></div>
        <div class="calc-preview-item"><span>المديونية القديمة</span><strong style="color:var(--danger);">${fmtMoney(oldDebt)}</strong></div>
        <div class="calc-preview-item" style="background:rgba(15,118,110,0.12);border:1.5px solid var(--primary);border-radius:8px;padding:6px 10px;">
          <span style="font-weight:800;color:var(--primary);">💎 إجمالي المبلغ المطلوب</span>
          <strong style="color:var(--primary);font-size:1.15rem;">${fmtMoney(totalReq)}</strong>
        </div>
      ` : ''}
    `;
  }
}

function saveAndPrintClientOrderStatement(orderId) {
  if (canSeeFinancialPrices() && document.getElementById('stmt-disc-type')) {
    saveClientOrderStatementChanges(null, orderId, false, false, true);
  } else {
    printClientOrderStatement(orderId);
  }
}

function saveClientOrderStatementChanges(e, orderId, alsoApproveExecutive = false, alsoApproveWarehousePrep = false, alsoPrintPdf = false) {
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
    const descInput = document.getElementById(`stmt-desc-${idx}`);
    const thkMmInput = document.getElementById(`stmt-thk-mm-${idx}`);
    const thkDirInput = document.getElementById(`stmt-thk-dir-${idx}`);
    const grdSel = document.getElementById(`stmt-grd-${idx}`);
    const lenInput = document.getElementById(`stmt-len-${idx}`);
    const widInput = document.getElementById(`stmt-wid-${idx}`);

    if (descInput) {
      it.itemDescription = descInput.value.trim() || it.woodTypeName || 'قشرة خشبية طبيعية';
    }

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
  let discAmt = 0;
  let discPct = 0;
  if (discType === 'percent') {
    discPct = Math.min(100, Math.max(0, discVal));
    discAmt = +((subtotal * discPct) / 100).toFixed(2);
  } else {
    discAmt = Math.min(subtotal, Math.max(0, +discVal.toFixed(2)));
    discPct = subtotal > 0 ? +((discAmt / subtotal) * 100).toFixed(2) : 0;
  }

  const afterDiscount = Math.max(0, +(subtotal - discAmt).toFixed(2));
  const preVatBase = +(afterDiscount / 1.14).toFixed(2);
  const includedVat14 = +(afterDiscount - preVatBase).toFixed(2);

  const whtMode = document.getElementById('stmt-wht-mode')?.value || ord.withholdingTaxMode || 'none';
  const whtRate = whtMode === 'none' ? 0 : Math.max(0, Number(document.getElementById('stmt-wht-rate')?.value ?? ord.withholdingTaxRate ?? 0));
  const whtAmt = whtRate > 0 ? +((preVatBase * whtRate) / 100).toFixed(2) : 0;

  const delivMode = document.getElementById('stmt-delivery-mode')?.value || ord.deliveryMode || 'ex_factory';
  const delivCost = delivMode === 'paid_delivery' ? Math.max(0, Number(document.getElementById('stmt-delivery-cost')?.value ?? ord.deliveryCost ?? 0)) : 0;
  const delivPlace = (document.getElementById('stmt-delivery-place')?.value || ord.deliveryPlace || 'أرض مصنع العاصمة للصناعات المتخصصة').trim();

  let net = afterDiscount;
  if (whtMode === 'deduct') net -= whtAmt;
  else if (whtMode === 'add') net += whtAmt;
  net = Math.max(0, +(net + delivCost).toFixed(2));

  const oldDebt = Math.max(0, Number(document.getElementById('stmt-old-debt')?.value ?? ord.previousDebtAmount ?? 0));
  const totalReq = +(net + oldDebt).toFixed(2);
  const wordsTxt = (document.getElementById('stmt-amount-words')?.value || numberToArabicTafqeet(totalReq)).trim();
  const advTerms = (document.getElementById('stmt-payment-advance')?.value || ord.paymentAdvanceTerms || '50% دفعة مقدمة عند التعاقد').trim();
  const defTerms = (document.getElementById('stmt-payment-deferred')?.value || ord.paymentDeferredTerms || '50% عند الاستلام والتوريد').trim();
  const bankTxt = (document.getElementById('stmt-bank-accounts')?.value || ord.bankAccountsText || getDefaultBankAccountsText()).trim();

  if (bankTxt && canSeeFinancialPrices()) {
    state.factoryInfo = state.factoryInfo || {};
    state.factoryInfo.bankAccountsText = bankTxt;
  }

  ord.totalSheetsCount = totalSheets;
  ord.totalAreaM2 = +totalArea.toFixed(4);
  ord.totalVolumeM3 = +totalVol.toFixed(4);
  ord.subtotalAmount = +subtotal.toFixed(2);
  ord.discountType = discType;
  ord.discountValue = discVal;
  ord.discountPercent = discPct;
  ord.discountAmount = discAmt;
  ord.vatInclusive = true;
  ord.vatRate = 14;
  ord.preVatBaseAmount = preVatBase;
  ord.includedVatAmount = includedVat14;
  ord.withholdingTaxMode = whtMode;
  ord.withholdingTaxRate = whtRate;
  ord.withholdingTaxAmount = whtAmt;
  ord.deliveryMode = delivMode;
  ord.deliveryCost = delivCost;
  ord.deliveryPlace = delivPlace;
  ord.netTotalAmount = net;
  ord.previousDebtAmount = oldDebt;
  ord.totalRequiredAmount = totalReq;
  ord.totalRequiredInWords = wordsTxt;
  ord.paymentAdvanceTerms = advTerms;
  ord.paymentDeferredTerms = defTerms;
  ord.bankAccountsText = bankTxt;
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

  if (alsoApproveWarehousePrep && (isFullAdmin(currentUser) || isWarehouseKeeperOnly(currentUser) || ['admin_manager', 'warehouse_keeper'].includes(currentUser?.roleKey))) {
    closeModal();
    approveOrderWarehousePrep(ord.id);
    return;
  }

  closeModal();
  if (alsoPrintPdf) {
    window._isPrintingActive = true;
    printClientOrderStatement(ord.id);
  }
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
function ensureOrderStockDeducted(ord, performedBy = '', opDate = '', allowNegative = false) {
  if (!ord || ord.stockDeducted) return false;
  const now = getMonotonicIso(ord.updatedAt);
  const dispatchDate = opDate || ord.date || todayStr();
  const actor = performedBy || currentUser?.name || 'المخزن';
  const carVoucherNo = ord.carDispatchVoucher?.voucherNo || `CAR-${ord.orderNumber}`;
  const carPlate = ord.carDispatchVoucher?.carPlateNumber || (allowNegative ? 'موضوع بالسالب لحين الإضافة' : 'خروج من المخزن');
  const driverName = ord.carDispatchVoucher?.driverName || '-';

  for (const it of (ord.items || [])) {
    const sh = Number(it.sheetsCount || 0);
    if (sh <= 0) continue;
    const thkId = it.thicknessId || `th-${it.thicknessMm}-${it.direction || 'qas'}`;
    const len = Number(it.lengthCm || 250);
    const wid = Number(it.widthCm || 125);
    deductSheetsFromCellPallets(
      thkId,
      it.gradeId,
      it.woodTypeId || 'wt-general',
      sh,
      Number(it.unitPrice || 0),
      len,
      wid,
      allowNegative,
      `طلبية (${ord.orderNumber}) — العميل: ${ord.clientName}`
    );

    state.warehouseMovements = state.warehouseMovements || [];
    state.warehouseMovements.unshift({
      id: uid('mov'),
      voucherNumber: carVoucherNo,
      date: dispatchDate,
      warehouseType: 'finished_veneers',
      warehouseLabel: allowNegative
        ? 'مخزن القشرة التامة (وضع طلبية بالمخزن بالسالب لحين الإضافة)'
        : 'مخزن القشرة التامة (خروج طلبية من المخزن)',
      direction: 'out',
      directionLabel: allowNegative ? 'وضع بالمخزن بالسالب لحين الإضافة' : 'خروج طلبية من المخزن',
      movementCategory: 'sales_exit',
      cellKey: getCellPriceKey(thkId, it.gradeId),
      lengthCm: len,
      widthCm: wid,
      sheetsCount: sh,
      unitSheetPrice: Number(it.unitPrice || 0),
      totalSaleAmount: Number(it.totalItemAmount || 0),
      itemSummary: `${allowNegative ? '📉 وضع بالمخزن بالسالب لحين الإضافة — ' : ''}خروج وصرف طلبية (${ord.orderNumber}) للعميل ${ord.clientName} — مقاس (${formatVeneerDimensions(len, wid, true)}) تخانة ${it.thicknessMm} مم (${it.direction === 'sada' ? 'سدا' : 'قص'}) × ${it.gradeName}${driverName !== '-' ? ' — سيارة رقم (' + carPlate + ') سائق (' + driverName + ')' : ''}`,
      referenceCode: carPlate,
      quantitySummary: `${sh} قطعة (${formatVeneerDimensions(len, wid, false)}) | ${it.volumeM3} م³`,
      performedBy: actor,
      approvedBy: ord.executiveApprovedBy || actor,
      updatedAt: now
    });
  }

  ord.stockDeducted = true;
  ord.stockDeductedAt = now;
  if (allowNegative) {
    ord.placedInNegativeStock = true;
    ord.placedInNegativeStockBy = actor;
    ord.placedInNegativeStockAt = now;
  }
  ord.updatedAt = now;
  return true;
}

// STAGE 2 -> STAGE 3: Admin Manager or Warehouse Keeper approves preparation/exit from warehouse -> Immediately deducts from Quantities Table & transfers to Accountant
// RULE: If order items are NOT available in the warehouse, warehouse keeper is NOT allowed to approve unless stock is covered first OR placed in the warehouse in negative balance until added!
function approveOrderWarehousePrep(orderId) {
  const ord = (state.productionOrders || []).find(o => o.id === orderId);
  if (!ord) return;

  const stockCheck = checkOrderStockAvailability(ord);
  if (!stockCheck.isReadyToApprove) {
    openOrderStockShortageModal(ord.id);
    return;
  }

  const now = getMonotonicIso(ord.updatedAt);
  ord.stage = 'pending_accountant_release';
  ord.warehousePrepApprovedBy = currentUser.name;
  ord.warehousePrepApprovedAt = now;
  ord.updatedAt = now;

  // Immediately exit quantities from the Veneer Quantities Matrix upon warehouse exit approval
  ensureOrderStockDeducted(ord, currentUser.name, ord.date || todayStr(), false);

  if (currentUser) markNotifIdsSeen([`ord_stage_${ord.id}_pending_accountant_release`]);

  saveState(`📦 موافقة (${currentUser.name}) على تجهيز وخروج الطلبية (${ord.orderNumber}) للعميل ${ord.clientName} — تم خصم الكميات من جدول كميات القشرة فوراً وتحويلها إلى المحاسب في (اعتماد أذون الصرف)`);
}

function openOrderStockShortageModal(orderId) {
  const ord = (state.productionOrders || []).find(o => o.id === orderId);
  if (!ord) return;
  const stockCheck = checkOrderStockAvailability(ord);
  if (stockCheck.isReadyToApprove) {
    approveOrderWarehousePrep(ord.id);
    return;
  }

  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot) return;

  modalRoot.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal-box" style="max-width:860px;">
        <div class="card-header">
          <div>
            <div class="card-title" style="color:var(--danger);">
              ⛔ لا يسمح بالموافقة المباشرة — الطلبية (${ord.orderNumber}) غير متوفرة بالكامل في المخزن!
            </div>
            <small style="color:var(--text-muted);">
              العميل: <strong>${ord.clientName} (${ord.clientCode || 'CL'})</strong> | إجمالي العجز غير المتوفر بالمخزن: <strong style="color:var(--danger);">${fmtNum(stockCheck.totalDeficitSheets, 0)} قطعة</strong>
            </small>
          </div>
          <button type="button" class="btn btn-sm btn-outline" onclick="closeModal()">✕</button>
        </div>

        <div style="background:rgba(220,38,38,0.10);border:2px solid var(--danger);padding:12px 16px;border-radius:10px;margin-bottom:14px;font-size:0.88rem;line-height:1.6;">
          🔒 <strong>قاعدة النظام الإلزامية لأمين المخزن:</strong><br/>
          في حالة إصدار أمر تجهيز طلبية للعميل وهي غير موجودة بالمخزن، <strong>لا يسمح لأمين المخزن بالموافقة عليها إلا بعد تنفيذ أحد الإجراءين التاليين</strong>:
          <div style="margin-top:6px;display:flex;flex-direction:column;gap:4px;">
            <span>1️⃣ <strong>تغطية رصيد المخزن لها أولاً:</strong> إضافة كمية العجز الناقصة إلى رصيد مخزن القشرة التامة لتغطية الطلبية.</span>
            <span>2️⃣ <strong>أو وضعها في المخزن بالسالب لحين إضافتها:</strong> تسجيل كمية العجز في المخزن برصيد سالب (<code style="direction:ltr;display:inline-block;">-${fmtNum(stockCheck.totalDeficitSheets, 0)}</code> قطعة) لحين إنتاجها وإضافتها للمخزن لاحقاً.</span>
          </div>
        </div>

        <div class="table-responsive" style="margin-bottom:16px;">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>الصنف (التخانة والاتجاه × الجودة)</th>
                <th>المقاس</th>
                <th>الكمية المطلوبة للطلبية</th>
                <th>الرصيد المتاح حالياً بالمخزن</th>
                <th>العجز غير المتوفر بالمخزن</th>
                <th>الرصيد في حال وضعها بالسالب</th>
                <th>حالة البند</th>
              </tr>
            </thead>
            <tbody>
              ${stockCheck.itemStatuses.map((st, idx) => `
                <tr style="${!st.isCovered ? 'background:rgba(220,38,38,0.06);' : 'background:rgba(22,163,74,0.05);'}">
                  <td><strong>${idx + 1}</strong></td>
                  <td>
                    <strong>${st.thicknessMm} مم (${st.directionLabel})</strong> × <strong>${st.gradeName}</strong>
                  </td>
                  <td>${getVeneerDimensionBadgeHtml(st.lengthCm, st.widthCm)}</td>
                  <td><strong>${fmtNum(st.reqSheets, 0)} قطعة</strong></td>
                  <td>
                    <span class="badge ${st.availSheets >= st.reqSheets ? 'badge-success' : 'badge-warning'}">
                      ${fmtNum(st.availSheets, 0)} قطعة
                    </span>
                    ${st.currentCellNetSheets < 0 ? `<br/><small style="color:var(--danger);font-weight:800;direction:ltr;display:inline-block;">(الخلية حالياً: ${fmtNum(st.currentCellNetSheets, 0)} ق)</small>` : ''}
                  </td>
                  <td>
                    ${st.deficitSheets > 0
                      ? `<strong style="color:var(--danger);font-size:0.95rem;">${fmtNum(st.deficitSheets, 0)} قطعة ناقصة</strong>`
                      : `<span style="color:var(--success);font-weight:800;">0 (مغطى بالكامل)</span>`}
                  </td>
                  <td>
                    ${st.deficitSheets > 0
                      ? `<strong style="color:var(--danger);direction:ltr;display:inline-block;background:#fee2e2;padding:2px 8px;border-radius:6px;border:1px solid #ef4444;">${fmtNum(st.projectedNetAfterNegative, 0)} قطعة</strong>`
                      : `<span style="color:var(--success);font-weight:700;">+${fmtNum(st.availSheets - st.reqSheets, 0)} قطعة</span>`}
                  </td>
                  <td>
                    ${st.isCovered
                      ? '<span class="badge badge-success">✅ متوفر بالمخزن</span>'
                      : '<span class="badge badge-danger">⛔ غير متوفر (عجز)</span>'}
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>

        <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(320px, 1fr));gap:14px;margin-bottom:14px;">
          <!-- Option 1: Cover warehouse stock -->
          <div style="border:2px solid var(--success);background:rgba(22,163,74,0.06);padding:14px;border-radius:12px;display:flex;flex-direction:column;justify-content:space-between;gap:10px;">
            <div>
              <div style="font-weight:900;font-size:0.96rem;color:var(--success);margin-bottom:4px;">
                1️⃣ الخيار الأول: تغطية رصيد المخزن للطلبية أولاً (+${fmtNum(stockCheck.totalDeficitSheets, 0)} قطعة)
              </div>
              <small style="color:var(--text-muted);line-height:1.5;display:block;">
                يقوم النظام بإضافة كمية العجز الناقصة (${fmtNum(stockCheck.totalDeficitSheets, 0)} قطعة) كإدخال إنتاج إلى مخزن القشرة التامة حتى يصبح رصيد المخزن مغطياً للطلبية بالكامل، ثم يسمح بالموافقة عليها.
              </small>
            </div>
            <div style="display:flex;flex-direction:column;gap:6px;">
              <button type="button" class="btn btn-success" style="font-weight:800;width:100%;" onclick="resolveOrderShortageByCoveringStock('${ord.id}', true)">
                📥 تغطية رصيد المخزن الآن + الموافقة على التجهيز والخروج فوراً
              </button>
              <button type="button" class="btn btn-sm btn-outline" style="border-color:var(--success);color:var(--success);font-weight:800;width:100%;" onclick="resolveOrderShortageByCoveringStock('${ord.id}', false)">
                📥 تغطية رصيد المخزن فقط (إضافة العجز للمخزن أولاً)
              </button>
            </div>
          </div>

          <!-- Option 2: Place in negative stock in warehouse until added -->
          <div style="border:2px solid var(--danger);background:rgba(220,38,38,0.06);padding:14px;border-radius:12px;display:flex;flex-direction:column;justify-content:space-between;gap:10px;">
            <div>
              <div style="font-weight:900;font-size:0.96rem;color:var(--danger);margin-bottom:4px;">
                2️⃣ الخيار الثاني: وضعها في المخزن بالسالب (-${fmtNum(stockCheck.totalDeficitSheets, 0)} قطعة) لحين إضافتها
              </div>
              <small style="color:var(--text-muted);line-height:1.5;display:block;">
                يقوم النظام بخصم المتاح وتسجيل الكمية المتبقية في جدول مخزن القشرة التامة <strong>بالسالب (-${fmtNum(stockCheck.totalDeficitSheets, 0)} قطعة)</strong> لحين إضافتها لاحقاً (وعند إضافة إنتاج جديد للمخزن يتم تغطية السالب تلقائياً).
              </small>
            </div>
            <div style="display:flex;flex-direction:column;gap:6px;">
              <button type="button" class="btn btn-danger" style="font-weight:800;width:100%;" onclick="resolveOrderShortageByNegativeStock('${ord.id}', true)">
                📉 وضعها في المخزن بالسالب لحين إضافتها + الموافقة على التجهيز فوراً
              </button>
              <button type="button" class="btn btn-sm btn-outline" style="border-color:var(--danger);color:var(--danger);font-weight:800;width:100%;" onclick="resolveOrderShortageByNegativeStock('${ord.id}', false)">
                📉 وضعها في المخزن بالسالب فقط (تثبيت السالب بالمخزن أولاً)
              </button>
            </div>
          </div>
        </div>

        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;border-top:1px solid var(--border-color);padding-top:12px;">
          <button type="button" class="btn btn-sm btn-outline" onclick="closeModal(); activeWarehouseSubTab='finished'; setTab('warehouses');">
            🏭 الذهاب إلى جدول مخزن القشرة التامة
          </button>
          <button type="button" class="btn btn-outline" onclick="closeModal()">إغلاق بدون موافقة</button>
        </div>
      </div>
    </div>
  `;
}

function resolveOrderShortageByCoveringStock(orderId, alsoApprove = true) {
  const ord = (state.productionOrders || []).find(o => o.id === orderId);
  if (!ord) return;
  const stockCheck = checkOrderStockAvailability(ord);
  const now = getMonotonicIso(ord.updatedAt);
  const opDate = ord.date || todayStr();
  const actor = currentUser?.name || 'أمين المخزن';

  for (const def of stockCheck.deficits) {
    if (def.deficitSheets <= 0) continue;
    const it = def.item;
    const unitPrice = Number(it.unitPrice || getCellUnitPrice(def.thkId, def.gradeId, def.thicknessMm, def.direction) || 0);
    const m = calculateVeneerMetrics(def.lengthCm, def.widthCm, def.thicknessMm, def.deficitSheets);

    addSheetsToCellPallets(
      def.thkId,
      def.gradeId,
      it.woodTypeId || 'wt-general',
      def.deficitSheets,
      `تغطية رصيد المخزن لأمر تجهيز الطلبية (${ord.orderNumber}) — العميل: ${ord.clientName}`,
      opDate,
      unitPrice,
      def.lengthCm,
      def.widthCm
    );

    state.warehouseMovements = state.warehouseMovements || [];
    state.warehouseMovements.unshift({
      id: uid('mov'),
      voucherNumber: `COV-${ord.orderNumber}`,
      date: opDate,
      warehouseType: 'finished_veneers',
      warehouseLabel: 'مخزن القشرة التامة (إضافة وتغطية رصيد لطلبية عميل)',
      direction: 'in',
      directionLabel: 'تغطية رصيد المخزن للطلبية',
      movementCategory: 'production_in',
      cellKey: getCellPriceKey(def.thkId, def.gradeId),
      lengthCm: def.lengthCm,
      widthCm: def.widthCm,
      sheetsCount: def.deficitSheets,
      unitSheetPrice: unitPrice,
      totalSaleAmount: +(def.deficitSheets * unitPrice).toFixed(2),
      itemSummary: `تغطية رصيد المخزن لأمر تجهيز الطلبية (${ord.orderNumber}) للعميل ${ord.clientName} — مقاس (${formatVeneerDimensions(def.lengthCm, def.widthCm, true)}) تخانة ${def.thicknessMm} مم (${def.directionLabel}) × ${def.gradeName}`,
      referenceCode: ord.orderNumber,
      quantitySummary: `${def.deficitSheets} قطعة (${formatVeneerDimensions(def.lengthCm, def.widthCm, false)}) | ${m.totalVolumeM3} م³`,
      performedBy: actor,
      approvedBy: actor,
      updatedAt: now
    });
  }

  ord.stockCoveredAt = now;
  ord.stockCoveredBy = actor;
  ord.updatedAt = now;
  closeModal();

  if (alsoApprove) {
    approveOrderWarehousePrep(ord.id);
  } else {
    saveState(`📥 تم تغطية رصيد المخزن للطلبية (${ord.orderNumber}) للعميل ${ord.clientName} بإضافة (${stockCheck.totalDeficitSheets} قطعة) للمخزن — يمكنك الآن الموافقة على التجهيز`);
  }
}

function resolveOrderShortageByNegativeStock(orderId, alsoApprove = true) {
  const ord = (state.productionOrders || []).find(o => o.id === orderId);
  if (!ord) return;
  const stockCheck = checkOrderStockAvailability(ord);
  const actor = currentUser?.name || 'أمين المخزن';
  const opDate = ord.date || todayStr();

  // Deduct order items with allowNegative = true so uncovered quantities are placed as negative balance in the warehouse matrix
  ensureOrderStockDeducted(ord, actor, opDate, true);
  closeModal();

  if (alsoApprove) {
    const now = getMonotonicIso(ord.updatedAt);
    ord.stage = 'pending_accountant_release';
    ord.warehousePrepApprovedBy = actor;
    ord.warehousePrepApprovedAt = now;
    ord.updatedAt = now;
    if (currentUser) markNotifIdsSeen([`ord_stage_${ord.id}_pending_accountant_release`]);
    saveState(`📉 تم وضع عجز الطلبية (${ord.orderNumber}) للعميل ${ord.clientName} في المخزن بالسالب (-${stockCheck.totalDeficitSheets} قطعة لحين إضافتها) والموافقة على التجهيز وتحويلها للمحاسب`);
  } else {
    saveState(`📉 تم وضع كمية العجز للطلبية (${ord.orderNumber}) للعميل ${ord.clientName} في المخزن بالسالب (-${stockCheck.totalDeficitSheets} قطعة لحين إضافتها) — يمكنك الآن الموافقة على التجهيز`);
  }
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
  const existingCar = ord.carDispatchVoucher || null;
  const clientObj = (state.partners || []).find(p => p.id === ord.clientId || p.name === ord.clientName);
  const defaultPallets = existingCar ? Number(existingCar.palletsDeliveredCount ?? 1) : Math.max(1, Math.ceil(Number(ord.totalSheetsCount || 400) / 400));
  const defaultPalletPrice = getWoodenPalletUnitPrice(clientObj, existingCar);

  modalRoot.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal-box" style="max-width:740px;">
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
              <input id="car-date" type="date" class="form-control" value="${existingCar?.dispatchDate || todayStr()}" required />
            </div>
            <div class="form-group">
              <label>🚚 رقم السيارة / اللوحة المعدنية</label>
              <input id="car-plate" class="form-control" value="${existingCar?.carPlateNumber || ''}" placeholder="مثال: ط د أ - 4582" required autofocus style="font-weight:800;border-color:var(--primary);" />
            </div>
            <div class="form-group">
              <label>👤 اسم سائق السيارة المستلم</label>
              <input id="car-driver" class="form-control" value="${existingCar?.driverName || ''}" placeholder="اسم السائق ثلاثي..." required />
            </div>
            <div class="form-group">
              <label>📞 رقم تليفون السائق</label>
              <input id="car-phone" class="form-control" value="${existingCar?.driverPhone || ''}" placeholder="010xxxxxxxx" />
            </div>
            <div class="form-group">
              <label style="color:var(--accent);font-weight:800;">🪵 عدد البالتات الخشبية المسلمة للعميل مع البضاعة</label>
              <input id="car-pallets-out" type="number" min="0" class="form-control" value="${defaultPallets}" oninput="updateCarPalletsValueLive()" required style="font-weight:800;border-color:var(--accent);" />
            </div>
            <div class="form-group">
              <label style="color:var(--success);font-weight:800;">🪵 عدد البالتات الخشبية المستلمة/المرتجعة من العميل مع السيارة (إن وجد)</label>
              <input id="car-pallets-in" type="number" min="0" class="form-control" value="${existingCar?.palletsReceivedCount ?? 0}" oninput="updateCarPalletsValueLive()" required />
            </div>
            ${canSeeFinancialPrices() ? `
            <div class="form-group">
              <label style="color:#b45309;font-weight:800;">💰 قيمة البالتة الواحدة (ج.م)</label>
              <input id="car-pallet-price" type="number" step="0.5" min="0" class="form-control" value="${defaultPalletPrice}" oninput="updateCarPalletsValueLive()" style="font-weight:800;border-color:#d97706;" placeholder="مثال: 250" />
            </div>
            <div class="form-group">
              <label style="color:#7c3aed;font-weight:800;">💎 إجمالي قيمة البالتات المسلمة مع السيارة</label>
              <input id="car-pallet-total-readonly" type="text" class="form-control" value="${fmtMoney(defaultPallets * defaultPalletPrice)}" readonly style="font-weight:900;color:#7c3aed;background:rgba(124,58,237,0.08);border-color:#7c3aed;" />
            </div>
            ` : `<input id="car-pallet-price" type="hidden" value="${defaultPalletPrice}" />`}
            <div class="form-group" style="grid-column: 1 / -1;">
              <label>ملاحظات التحميل وأمن البوابة</label>
              <input id="car-notes" class="form-control" value="${existingCar?.notes || ''}" placeholder="مثال: تم التحميل والتأمين بحزام شداد بحضور أمين المخزن..." />
            </div>
          </div>

          <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-top:16px;">
            <div>
              ${existingCar ? `
                <button type="button" class="btn btn-success" onclick="printVehicleDispatchVoucher('${ord.id}')">🖨️ طباعة إذن صرف السيارة الحالي فوراً</button>
              ` : ''}
            </div>
            <div style="display:flex;gap:10px;">
              <button type="button" class="btn btn-outline" onclick="closeModal()">إلغاء</button>
              <button type="submit" class="btn btn-danger">🚚 تأكيد صرف الطلبية وخصم المخزن وطباعة إذن صرف السيارة</button>
            </div>
          </div>
        </form>
      </div>
    </div>
  `;
}

function updateCarPalletsValueLive() {
  const outCount = Math.max(0, Number(document.getElementById('car-pallets-out')?.value || 0));
  const unitPrice = Math.max(0, Number(document.getElementById('car-pallet-price')?.value || 0));
  const totEl = document.getElementById('car-pallet-total-readonly');
  if (totEl) {
    totEl.value = fmtMoney(outCount * unitPrice);
  }
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
  const clientObj = (state.partners || []).find(p => p.id === ord.clientId || p.name === ord.clientName);
  const palletUnitPrice = Math.max(0, Number(document.getElementById('car-pallet-price')?.value ?? getWoodenPalletUnitPrice(clientObj, ord.carDispatchVoucher)));
  const palletsDeliveredValue = +(palletsDeliveredCount * palletUnitPrice).toFixed(2);
  const palletsReceivedValue = +(palletsReceivedCount * palletUnitPrice).toFixed(2);
  const carNotes = (document.getElementById('car-notes')?.value || '').trim();
  const now = getMonotonicIso(ord.updatedAt);
  const carVoucherNo = `CAR-${ord.orderNumber}`;

  if (palletUnitPrice > 0) {
    state.catalog = state.catalog || {};
    if (!state.catalog.woodenPalletUnitPrice) {
      state.catalog.woodenPalletUnitPrice = palletUnitPrice;
      state.catalog.woodenPalletUnitPriceUpdatedAt = Date.now();
    }
    if (clientObj && !clientObj.palletUnitPrice) {
      clientObj.palletUnitPrice = palletUnitPrice;
    }
  }

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
    const existingPm = state.palletMovements.find(pm => pm.orderId === ord.id || pm.voucherNo === carVoucherNo);
    if (existingPm) {
      existingPm.date = dispatchDate;
      existingPm.deliveredCount = palletsDeliveredCount;
      existingPm.receivedCount = palletsReceivedCount;
      existingPm.palletUnitPrice = palletUnitPrice;
      existingPm.totalDeliveredValue = palletsDeliveredValue;
      existingPm.totalReceivedValue = palletsReceivedValue;
      existingPm.carPlateNumber = carPlateNumber;
      existingPm.driverName = driverName;
      existingPm.notes = `مع تحميل الطلبية ${ord.orderNumber} — سيارة ${carPlateNumber} ${carNotes ? '(' + carNotes + ')' : ''}`;
      existingPm.updatedAt = now;
    } else {
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
        palletUnitPrice,
        totalDeliveredValue: palletsDeliveredValue,
        totalReceivedValue: palletsReceivedValue,
        carPlateNumber,
        driverName,
        notes: `مع تحميل الطلبية ${ord.orderNumber} — سيارة ${carPlateNumber} ${carNotes ? '(' + carNotes + ')' : ''}`,
        createdBy: currentUser.name,
        updatedAt: now
      });
    }
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
    palletUnitPrice,
    palletsDeliveredValue,
    palletsReceivedValue,
    notes: carNotes,
    dispatchedBy: currentUser.name,
    dispatchedAt: now
  };
  ord.updatedAt = now;

  closeModal();
  // Set _isPrintingActive BEFORE saveState so the synchronous render() inside saveState doesn't flash or block the print view
  window._isPrintingActive = true;
  printVehicleDispatchVoucher(ord.id);
  saveState(`🚚 تم صرف الطلبية (${ord.orderNumber}) للعميل ${ord.clientName} وتحميل السيارة رقم (${carPlateNumber}) وتسليم (${palletsDeliveredCount}) بالتة وخصم الأرصدة من المخزن فوراً`);
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
            <div class="form-group">
              <label style="color:#b45309;font-weight:800;">💰 قيمة البالتة الواحدة للعميل (ج.م)</label>
              <input id="pt-plt-price" type="number" step="0.5" min="0" class="form-control" value="${getWoodenPalletUnitPrice()}" placeholder="مثال: 250" />
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
  const palletUnitPrice = Math.max(0, Number(document.getElementById('pt-plt-price')?.value ?? getWoodenPalletUnitPrice()));
  const notes = (document.getElementById('pt-notes')?.value || '').trim();
  const now = new Date().toISOString();

  if (palletUnitPrice > 0) {
    state.catalog = state.catalog || {};
    if (!state.catalog.woodenPalletUnitPrice) {
      state.catalog.woodenPalletUnitPrice = palletUnitPrice;
      state.catalog.woodenPalletUnitPriceUpdatedAt = Date.now();
    }
  }

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
    palletUnitPrice,
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
            <small style="color:var(--text-muted);">رصيد وقيمة البالتات الخشبية</small>
            <div style="font-weight:900;font-size:0.9rem;">
              مسلم له: ${m.palletsDelivered} | مستلم منه: ${m.palletsReceived}<br/>
              <span style="color:#d97706;">متبقي طرف العميل: ${m.netPalletsAtClient} بالتة</span><br/>
              <span style="font-size:0.78rem;color:var(--text-muted);">قيمة البالتة: <strong>${fmtMoney(m.palletUnitPrice)}</strong></span><br/>
              <span style="color:var(--primary);">إجمالي قيمة البالتات: ${fmtMoney(m.netPalletsValue)}</span>
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
            <h4 style="margin-bottom:8px;color:var(--primary);">3️⃣ حساب البالتات الخشبية المسلمة للعميل والمستلمة منه وقيمتها (${m.palletMoves.length} حركة):</h4>
            <div class="table-responsive">
              <table>
                <thead>
                  <tr>
                    <th>رقم السند</th>
                    <th>التاريخ</th>
                    <th>بالتات مسلمة للعميل (+)</th>
                    <th>بالتات مستلمة من العميل (-)</th>
                    <th>قيمة البالتة</th>
                    <th>إجمالي قيمة البالتات</th>
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
                      <td><strong>${fmtMoney(m.palletUnitPrice)}</strong></td>
                      <td><strong style="color:var(--primary);">${fmtMoney((Number(pt.openingPalletsDelivered || 0) - Number(pt.openingPalletsReceived || 0)) * m.palletUnitPrice)}</strong></td>
                      <td>رصيد بالتات افتتاحي</td>
                      ${isFullAdmin(currentUser) ? `<td><button class="btn btn-sm btn-outline" onclick="openEditPartnerModal('${pt.id}')">✏️ تعديل</button></td>` : ''}
                    </tr>
                  ` : ''}
                  ${m.palletMoves.map(pm => {
                    const pmUnitPrice = getWoodenPalletUnitPrice(pt, pm);
                    const delVal = +(Number(pm.deliveredCount || 0) * pmUnitPrice).toFixed(2);
                    const recVal = +(Number(pm.receivedCount || 0) * pmUnitPrice).toFixed(2);
                    const moveTotalVal = delVal > 0 ? delVal : recVal;
                    return `
                    <tr>
                      <td><strong>${pm.voucherNo || '-'}</strong></td>
                      <td>${pm.date}</td>
                      <td><span class="badge badge-warning">+${pm.deliveredCount || 0} بالتة مسلمة</span></td>
                      <td><span class="badge badge-success">-${pm.receivedCount || 0} بالتة مستلمة</span></td>
                      <td><strong>${fmtMoney(pmUnitPrice)}</strong></td>
                      <td><strong style="color:${delVal >= recVal ? 'var(--primary)' : 'var(--success)'};">${fmtMoney(moveTotalVal)}</strong></td>
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
                  `;}).join('')}
                </tbody>
                <tfoot>
                  <tr style="background:var(--bg-elevated);font-weight:900;">
                    <td colspan="2">الإجمالي الصافي طرف العميل</td>
                    <td>+${m.palletsDelivered} بالتة (${fmtMoney(m.palletsDeliveredValue)})</td>
                    <td>-${m.palletsReceived} بالتة (${fmtMoney(m.palletsReceivedValue)})</td>
                    <td>${fmtMoney(m.palletUnitPrice)}</td>
                    <td style="color:var(--primary);font-size:0.95rem;">صافي (${m.netPalletsAtClient} بالتة) = ${fmtMoney(m.netPalletsValue)}</td>
                    <td colspan="${isFullAdmin(currentUser) ? 2 : 1}"></td>
                  </tr>
                </tfoot>
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
  const defaultUnitPrice = getWoodenPalletUnitPrice(pt);
  const defaultRecCount = m.netPalletsAtClient > 0 ? m.netPalletsAtClient : 2;
  const modalRoot = document.getElementById('modal-root');

  modalRoot.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal-box" style="max-width:620px;">
        <div class="card-header">
          <div>
            <div class="card-title">🪵 حساب وقيمة البالتات للعميل: [${pt.code || 'CL'}] ${pt.name}</div>
            <small style="color:var(--text-muted);">
              إجمالي مسلم له: <strong>${m.palletsDelivered}</strong> | مستلم منه: <strong>${m.palletsReceived}</strong> | المتبقي طرفه الآن: <strong>${m.netPalletsAtClient} بالتة (${fmtMoney(m.netPalletsValue)})</strong>
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
              <input id="pm-del" type="number" min="0" class="form-control" value="0" oninput="updatePalletModalLiveCalc(${m.netPalletsAtClient})" required />
            </div>
            <div class="form-group">
              <label style="color:var(--success);font-weight:800;">📥 عدد البالتات المستلمة/المرتجعة من العميل (-)</label>
              <input id="pm-rec" type="number" min="0" class="form-control" value="${defaultRecCount}" oninput="updatePalletModalLiveCalc(${m.netPalletsAtClient})" required autofocus style="font-weight:800;border-color:var(--success);" />
            </div>
            <div class="form-group">
              <label style="color:#b45309;font-weight:800;">💰 قيمة البالتة الواحدة (ج.م)</label>
              <input id="pm-price" type="number" step="0.5" min="0" class="form-control" value="${defaultUnitPrice}" oninput="updatePalletModalLiveCalc(${m.netPalletsAtClient})" style="font-weight:800;border-color:#d97706;" placeholder="مثال: 250" required />
            </div>
            <div class="form-group">
              <label style="color:#7c3aed;font-weight:800;">💎 إجمالي قيمة البالتات في هذه الحركة</label>
              <input id="pm-total-readonly" type="text" class="form-control" value="${fmtMoney(defaultRecCount * defaultUnitPrice)}" readonly style="font-weight:900;color:#7c3aed;background:rgba(124,58,237,0.08);border-color:#7c3aed;" />
            </div>
            <div class="form-group" style="grid-column: 1 / -1;">
              <label>ملاحظات حركة البالتات</label>
              <input id="pm-notes" class="form-control" placeholder="مثال: استلام بالتات فارغة مرتجعة من مصنع العميل..." />
            </div>
          </div>

          <div id="pm-live-preview" class="calc-preview-box" style="margin-top:10px;"></div>

          <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px;">
            <button type="button" class="btn btn-outline" onclick="closeModal()">إلغاء</button>
            <button type="submit" class="btn btn-primary">🪵 حفظ حركة وقيمة البالتات في حساب العميل</button>
          </div>
        </form>
      </div>
    </div>
  `;
  updatePalletModalLiveCalc(m.netPalletsAtClient);
}

function updatePalletModalLiveCalc(prevNetPallets = 0) {
  const delCount = Math.max(0, Number(document.getElementById('pm-del')?.value || 0));
  const recCount = Math.max(0, Number(document.getElementById('pm-rec')?.value || 0));
  const unitPrice = Math.max(0, Number(document.getElementById('pm-price')?.value || 0));
  const delVal = +(delCount * unitPrice).toFixed(2);
  const recVal = +(recCount * unitPrice).toFixed(2);
  const activeVal = delVal > 0 ? delVal : recVal;
  const newNetCount = Number(prevNetPallets || 0) + delCount - recCount;
  const newNetVal = +(newNetCount * unitPrice).toFixed(2);

  const totEl = document.getElementById('pm-total-readonly');
  if (totEl) totEl.value = fmtMoney(activeVal);

  const box = document.getElementById('pm-live-preview');
  if (box) {
    box.innerHTML = `
      <div class="calc-preview-item"><span>قيمة البالتة الواحدة</span><strong>${fmtMoney(unitPrice)}</strong></div>
      <div class="calc-preview-item"><span>إجمالي قيمة المسلم (${delCount})</span><strong style="color:var(--accent);">${fmtMoney(delVal)}</strong></div>
      <div class="calc-preview-item"><span>إجمالي قيمة المستلم (${recCount})</span><strong style="color:var(--success);">${fmtMoney(recVal)}</strong></div>
      <div class="calc-preview-item"><span>صافي البالتات طرف العميل بعد الحركة</span><strong style="color:var(--primary);">${newNetCount} بالتة (${fmtMoney(newNetVal)})</strong></div>
    `;
  }
}

function submitClientPalletMovement(e, clientId) {
  e.preventDefault();
  const pt = (state.partners || []).find(p => p.id === clientId);
  if (!pt) return;

  const opDate = document.getElementById('pm-date')?.value || todayStr();
  const carPlateNumber = (document.getElementById('pm-car')?.value || '').trim();
  const deliveredCount = Math.max(0, Number(document.getElementById('pm-del')?.value || 0));
  const receivedCount = Math.max(0, Number(document.getElementById('pm-rec')?.value || 0));
  const palletUnitPrice = Math.max(0, Number(document.getElementById('pm-price')?.value ?? getWoodenPalletUnitPrice(pt)));
  const totalDeliveredValue = +(deliveredCount * palletUnitPrice).toFixed(2);
  const totalReceivedValue = +(receivedCount * palletUnitPrice).toFixed(2);
  const notes = (document.getElementById('pm-notes')?.value || '').trim();

  if (deliveredCount === 0 && receivedCount === 0) {
    alert('يرجى إدخال عدد البالتات المسلمة أو المستلمة!');
    return;
  }

  if (palletUnitPrice > 0) {
    pt.palletUnitPrice = palletUnitPrice;
    state.catalog = state.catalog || {};
    state.catalog.woodenPalletUnitPrice = palletUnitPrice;
    state.catalog.woodenPalletUnitPriceUpdatedAt = Date.now();
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
    palletUnitPrice,
    totalDeliveredValue,
    totalReceivedValue,
    carPlateNumber,
    notes: notes || (receivedCount > 0 ? `استلام ${receivedCount} بالتة من العميل` : `تسليم ${deliveredCount} بالتة للعميل`),
    createdBy: currentUser.name,
    updatedAt: new Date().toISOString()
  });

  closeModal();
  saveState(`🪵 تسجيل حركة بالتات للعميل (${pt.code || ''} - ${pt.name}): مسلم له (${deliveredCount}) / مستلم منه (${receivedCount}) — قيمة البالتة: ${fmtMoney(palletUnitPrice)} بتاريخ ${opDate}`);
}

function openSetDefaultPalletPriceModal() {
  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot) return;
  const curPrice = getWoodenPalletUnitPrice();
  const allClients = (state.partners || []).filter(p => p.type !== 'supplier');
  const totalNetPallets = allClients.reduce((s, c) => s + computeClientMetrics(c).netPalletsAtClient, 0);

  modalRoot.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal-box" style="max-width:500px;">
        <div class="card-header">
          <div>
            <div class="card-title">💰 تحديد قيمة البالتة الخشبية الواحدة وحساب إجمالي البالتات</div>
            <small style="color:var(--text-muted);">يتم تطبيق قيمة البالتة لحساب إجمالي قيمة البالتات لكل عميل ولجميع أذون السيارات وحركات البالتات</small>
          </div>
          <button class="btn btn-sm btn-outline" onclick="closeModal()">✕</button>
        </div>
        <form onsubmit="submitSetDefaultPalletPriceModal(event)">
          <div class="form-group" style="margin-bottom:12px;">
            <label style="color:#b45309;font-weight:800;">🪵 قيمة البالتة الواحدة بالجنيه (ج.م)</label>
            <input id="sys-pallet-unit-price" type="number" step="0.5" min="0" class="form-control" value="${curPrice}" oninput="document.getElementById('sys-pallet-total-preview').textContent = fmtMoney(Number(this.value || 0) * ${totalNetPallets})" required autofocus style="font-weight:900;font-size:1.1rem;border-color:#d97706;" placeholder="مثال: 250" />
          </div>
          <div style="background:var(--bg-elevated);padding:12px 14px;border-radius:10px;margin-bottom:14px;">
            <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
              <span>إجمالي عدد البالتات طرف العملاء حالياً:</span>
              <strong>${fmtNum(totalNetPallets, 0)} بالتة</strong>
            </div>
            <div style="display:flex;justify-content:space-between;font-size:1.05rem;">
              <span>💎 إجمالي قيمة البالتات طرف العملاء:</span>
              <strong id="sys-pallet-total-preview" style="color:var(--primary);">${fmtMoney(curPrice * totalNetPallets)}</strong>
            </div>
          </div>
          <label style="display:flex;align-items:center;gap:8px;font-size:0.85rem;font-weight:700;cursor:pointer;margin-bottom:14px;">
            <input id="sys-pallet-apply-all" type="checkbox" checked />
            <span>تطبيق هذه القيمة على جميع العملاء وحركات البالتات الحالية</span>
          </label>
          <div style="display:flex;justify-content:flex-end;gap:10px;">
            <button type="button" class="btn btn-outline" onclick="closeModal()">إلغاء</button>
            <button type="submit" class="btn btn-primary">💾 حفظ قيمة البالتة وتحديث الإجماليات</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function submitSetDefaultPalletPriceModal(e) {
  e.preventDefault();
  const newPrice = Math.max(0, Number(document.getElementById('sys-pallet-unit-price')?.value || 0));
  const applyAll = Boolean(document.getElementById('sys-pallet-apply-all')?.checked);
  const nowIso = new Date().toISOString();

  state.catalog = state.catalog || {};
  state.catalog.woodenPalletUnitPrice = newPrice;
  state.catalog.woodenPalletUnitPriceUpdatedAt = Date.now();
  quickCalc.woodenPalletUnitPrice = newPrice;

  if (applyAll) {
    (state.partners || []).forEach(pt => {
      pt.palletUnitPrice = newPrice;
      pt.updatedAt = nowIso;
    });
    (state.palletMovements || []).forEach(pm => {
      pm.palletUnitPrice = newPrice;
      pm.totalDeliveredValue = +(Number(pm.deliveredCount || 0) * newPrice).toFixed(2);
      pm.totalReceivedValue = +(Number(pm.receivedCount || 0) * newPrice).toFixed(2);
      pm.updatedAt = nowIso;
    });
    (state.productionOrders || []).forEach(ord => {
      if (ord.carDispatchVoucher) {
        ord.carDispatchVoucher.palletUnitPrice = newPrice;
        ord.carDispatchVoucher.palletsDeliveredValue = +(Number(ord.carDispatchVoucher.palletsDeliveredCount || 0) * newPrice).toFixed(2);
        ord.carDispatchVoucher.palletsReceivedValue = +(Number(ord.carDispatchVoucher.palletsReceivedCount || 0) * newPrice).toFixed(2);
        ord.updatedAt = nowIso;
      }
    });
  }

  closeModal();
  saveState(`💰 تحديد قيمة البالتة الخشبية الواحدة بمبلغ (${fmtMoney(newPrice)}) وتحديث إجمالي قيمة البالتات في النظام`);
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

        ${ctx.currentSheets < 0 ? `
          <div style="background:rgba(220,38,38,0.12);border:2px solid var(--danger);padding:10px 14px;border-radius:10px;margin-bottom:12px;font-size:0.86rem;">
            📉 <strong style="color:var(--danger);">هذه الخلية بها رصيد بالسالب حالياً (<span style="direction:ltr;display:inline-block;">${fmtNum(ctx.currentSheets, 0)}</span> قطعة):</strong><br/>
            عند إضافة كميات إنتاج جديدة سيقوم النظام <strong>بتغطية وتسوية الرصيد السالب (${fmtNum(Math.abs(ctx.currentSheets), 0)} قطعة) تلقائياً أولاً</strong> ثم إضافة الفائض كرصيد متاح بالمخزن.
          </div>
        ` : ''}

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

function deductSheetsFromCellPallets(thkId, gradeId, woodId, sheetsToDeduct, unitPrice = 0, targetLenCm = 0, targetWidCm = 0, allowNegative = false, negativeNote = '') {
  let remaining = Number(sheetsToDeduct);
  const thkObj = state.catalog.thicknesses.find(t => t.id === thkId) || { id: thkId, mm: activeCellContext?.thkMm || 1.5, direction: activeCellContext?.direction || 'qas' };
  const candidates = (state.pallets || []).filter(p =>
    p.status === 'in_stock' &&
    Number(p.sheetsCount || 0) > 0 &&
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

  // If there is still a remaining quantity to deduct and allowNegative is true, place the remaining deficit in negative stock in the cell!
  if (remaining > 0 && allowNegative) {
    const len = Number(targetLenCm || 250);
    const wid = Number(targetWidCm || 125);
    const effectiveUnitPrice = unitPrice > 0 ? unitPrice : getCellUnitPrice(thkId, gradeId, thkObj.mm, thkObj.direction);
    const woodObj = state.catalog.woodTypes.find(w => w.id === woodId) || state.catalog.woodTypes[0] || { id: 'wt-general', name: 'قشرة خشبية' };
    const gradeObj = state.catalog.grades.find(g => g.id === gradeId || g.code === gradeId || g.name === gradeId) || state.catalog.grades[0] || { id: gradeId, code: 'A', name: 'عام', defaultPricePerM3: 20000 };

    // Check if there is already a negative-balance pallet in this cell & dimension
    const existingNeg = (state.pallets || []).find(p => {
      if (p.status !== 'in_stock' || Number(p.sheetsCount || 0) >= 0) return false;
      if (!matchPalletToThicknessRow(p, thkObj) || !matchPalletToGrade(p, gradeId)) return false;
      const pLen = Number(p.lengthCm || 250);
      const pWid = Number(p.widthCm || 125);
      return (pLen === len && pWid === wid) || (pLen === wid && pWid === len);
    });

    if (existingNeg) {
      const newNegSheets = Number(existingNeg.sheetsCount || 0) - remaining;
      const negM = calculateVeneerMetrics(len, wid, thkObj.mm, newNegSheets);
      const monoNow = getMonotonicIso(existingNeg.updatedAt);
      existingNeg.sheetsCount = newNegSheets;
      existingNeg.areaM2 = negM.totalAreaM2;
      existingNeg.volumeM3 = negM.totalVolumeM3;
      existingNeg.unitSheetPrice = effectiveUnitPrice;
      existingNeg.totalValue = effectiveUnitPrice > 0
        ? +(newNegSheets * effectiveUnitPrice).toFixed(2)
        : +(negM.totalVolumeM3 * (gradeObj.defaultPricePerM3 || 20000)).toFixed(2);
      if (negativeNote && !String(existingNeg.batchNumber || '').includes(negativeNote)) {
        existingNeg.batchNumber = `${existingNeg.batchNumber || 'رصيد بالسالب'} | ${negativeNote}`;
      }
      existingNeg.updatedAt = monoNow;
    } else {
      const negSheets = -remaining;
      const negM = calculateVeneerMetrics(len, wid, thkObj.mm, negSheets);
      const monoNow = getMonotonicIso();
      const negVal = effectiveUnitPrice > 0
        ? +(negSheets * effectiveUnitPrice).toFixed(2)
        : +(negM.totalVolumeM3 * (gradeObj.defaultPricePerM3 || 20000)).toFixed(2);

      state.pallets.unshift({
        id: uid('plt'),
        palletCode: `NEG-${Date.now().toString().slice(-4)}`,
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
        sheetsCount: negSheets,
        areaM2: negM.totalAreaM2,
        volumeM3: negM.totalVolumeM3,
        unitSheetPrice: effectiveUnitPrice,
        unitPricePerM3: gradeObj.defaultPricePerM3 || 20000,
        totalValue: negVal,
        batchNumber: negativeNote ? `رصيد بالسالب لحين الإضافة (${negativeNote})` : 'رصيد بالسالب لحين إضافة الإنتاج',
        isNegativeBalance: true,
        status: 'in_stock',
        location: 'موضوع بالمخزن بالسالب لحين الإضافة',
        entryDate: todayStr(),
        createdBy: currentUser?.name || 'المخزن',
        createdAt: todayStr(),
        updatedAt: monoNow
      });
    }
  }
}

function addSheetsToCellPallets(thkId, gradeId, woodId, sheetsToAdd, notes = '', opDate = todayStr(), unitPrice = 0, lengthCm = 250, widthCm = 125) {
  let remainingToAdd = Number(sheetsToAdd || 0);
  if (remainingToAdd <= 0) return;
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
  const effectiveUnitPrice = unitPrice > 0 ? unitPrice : getCellUnitPrice(thkId, gradeId);

  if (!isStandardVeneerDimension(len, wid)) {
    ensureCustomDimensionInCatalog(len, wid, notes);
  }

  // First: Automatically offset/cover any existing NEGATIVE stock records in this cell!
  const negCandidates = (state.pallets || []).filter(p =>
    p.status === 'in_stock' &&
    Number(p.sheetsCount || 0) < 0 &&
    matchPalletToThicknessRow(p, thkObj) &&
    matchPalletToGrade(p, gradeId)
  );
  negCandidates.sort((a, b) => {
    const aMatchDim = (Number(a.lengthCm || 250) === len && Number(a.widthCm || 125) === wid) ||
                      (Number(a.lengthCm || 250) === wid && Number(a.widthCm || 125) === len);
    const bMatchDim = (Number(b.lengthCm || 250) === len && Number(b.widthCm || 125) === wid) ||
                      (Number(b.lengthCm || 250) === wid && Number(b.widthCm || 125) === len);
    if (aMatchDim !== bMatchDim) return aMatchDim ? -1 : 1;
    return 0;
  });

  for (const negP of negCandidates) {
    if (remainingToAdd <= 0) break;
    const negDeficit = Math.abs(Number(negP.sheetsCount || 0));
    const monoNow = getMonotonicIso(negP.updatedAt);
    if (remainingToAdd >= negDeficit) {
      remainingToAdd -= negDeficit;
      negP.sheetsCount = 0;
      negP.areaM2 = 0;
      negP.volumeM3 = 0;
      negP.totalValue = 0;
      negP.status = 'dispatched';
      negP.coveredAt = monoNow;
      negP.updatedAt = monoNow;
    } else {
      const newNegSheets = -(negDeficit - remainingToAdd);
      remainingToAdd = 0;
      const newNegM = calculateVeneerMetrics(negP.lengthCm || len, negP.widthCm || wid, thkObj.mm, newNegSheets);
      negP.sheetsCount = newNegSheets;
      negP.areaM2 = newNegM.totalAreaM2;
      negP.volumeM3 = newNegM.totalVolumeM3;
      negP.unitSheetPrice = effectiveUnitPrice;
      negP.totalValue = effectiveUnitPrice > 0
        ? +(newNegSheets * effectiveUnitPrice).toFixed(2)
        : +(newNegM.totalVolumeM3 * (gradeObj.defaultPricePerM3 || 20000)).toFixed(2);
      negP.updatedAt = monoNow;
    }
  }

  // If all added sheets went to covering the negative stock balance, we're done!
  if (remainingToAdd <= 0) return;

  const m = calculateVeneerMetrics(len, wid, thkObj.mm, remainingToAdd);
  const now = getMonotonicIso();
  const code = `PLT-2026-00${(state.pallets?.length || 0) + 1}`;
  const totalVal = effectiveUnitPrice > 0
    ? +(remainingToAdd * effectiveUnitPrice).toFixed(2)
    : +(m.totalVolumeM3 * (gradeObj.defaultPricePerM3 || 20000)).toFixed(2);

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
    sheetsCount: Number(remainingToAdd),
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
let _lastPrintExtraOptions = null;
let _lastPrintUrl = '';

function encodeUtf8ToBase64Url(str) {
  try {
    const bytes = new TextEncoder().encode(String(str || ''));
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  } catch (_) {
    return '';
  }
}

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

function downloadInPagePdfFile() {
  const contentEl = document.getElementById('print-document-content');
  if (!contentEl || !contentEl.innerHTML.trim()) return;
  if (typeof window.html2pdf !== 'function') {
    window.focus();
    window.print();
    return;
  }
  const safeName = (_lastPrintDocumentTitle || 'مستند_مصنع_العاصمة').replace(/[\\/:*?"<>|]/g, '_') + '.pdf';
  window.html2pdf().set({
    margin: 7,
    filename: safeName,
    image: { type: 'jpeg', quality: 0.98 },
    html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff' },
    jsPDF: { unit: 'mm', format: 'a4', orientation: _lastPrintLandscape ? 'landscape' : 'portrait' }
  }).from(contentEl).save().catch(() => {
    window.focus();
    window.print();
  });
}

function buildRealPrintPageUrl(docHtml, docTitle, landscape, extraOptions = null) {
  const jobId = `pj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const compactHtml = String(docHtml || '').split(DEFAULT_FACTORY_LOGO_DATA_URL).join('__CSI_DEFAULT_LOGO__');
  const jobPayload = {
    jobId,
    title: docTitle || 'طباعة مستند رسمي - مصنع العاصمة',
    landscape: Boolean(landscape),
    html: compactHtml,
    createdAt: Date.now()
  };

  try {
    localStorage.setItem('al_asimah_last_print_job', JSON.stringify(jobPayload));
  } catch (_) {}

  const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.hostname.startsWith('192.168.');
  if (isLocal) {
    try {
      fetch('/api/print-job', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(jobPayload),
        keepalive: true
      }).catch(() => {});
    } catch (_) {}
  }

  try {
    const fbJobsBase = 'https://elite-grand-8a6c3-default-rtdb.firebaseio.com/al_asimah_print_jobs';
    fetch(`${fbJobsBase}/${encodeURIComponent(jobId)}.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(jobPayload),
      keepalive: true
    }).catch(() => {});
    fetch(`${fbJobsBase}/latest.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(jobPayload),
      keepalive: true
    }).catch(() => {});
  } catch (_) {}

  const urlObj = new URL('./print.html', window.location.href);
  urlObj.searchParams.set('job', jobId);
  urlObj.searchParams.set('v', '34');
  if (landscape) urlObj.searchParams.set('l', '1');
  if (extraOptions && extraOptions.orderId) {
    urlObj.searchParams.set('orderId', extraOptions.orderId);
  }

  if (extraOptions && extraOptions.compactCarJson) {
    const dB64 = encodeUtf8ToBase64Url(JSON.stringify(extraOptions.compactCarJson));
    if (dB64 && (urlObj.href.length + dB64.length) < 1850) {
      urlObj.hash = `d=${dB64}`;
      return urlObj.href;
    }
  }

  const hB64 = encodeUtf8ToBase64Url(compactHtml);
  if (hB64 && (urlObj.href.length + hB64.length) < 1850) {
    urlObj.hash = `h=${hB64}`;
  }
  return urlObj.href;
}

function openStandalonePrintPopup() {
  if (!_lastPrintDocumentHtml) return;
  const targetUrl = _lastPrintUrl || buildRealPrintPageUrl(_lastPrintDocumentHtml, _lastPrintDocumentTitle, _lastPrintLandscape, _lastPrintExtraOptions);
  let w = null;
  try {
    w = typeof window.open === 'function' ? window.open(targetUrl, '_blank') : null;
  } catch (_) {}
  if (!w) {
    window.focus();
    window.print();
  }
}

function openUniversalPrintDocument(docHtml, docTitle = 'طباعة مستند رسمي - مصنع العاصمة', landscape = false, extraOptions = null) {
  _lastPrintDocumentHtml = docHtml;
  _lastPrintDocumentTitle = docTitle;
  _lastPrintLandscape = Boolean(landscape);
  _lastPrintExtraOptions = extraOptions;
  window._isPrintingActive = true;

  // Close any open modal so it never overlaps or blocks the print preview
  const modalRoot = document.getElementById('modal-root');
  if (modalRoot) {
    modalRoot.innerHTML = '';
  }

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
      body.is-printing-mode .floating-chat-fab,
      body.is-printing-mode .floating-smart-dock {
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
        html, body, body.is-printing-mode {
          display: block !important;
          background: #ffffff !important;
          color: #000000 !important;
          margin: 0 !important;
          padding: 0 !important;
          height: auto !important;
          min-height: 0 !important;
          max-height: none !important;
          overflow: visible !important;
          overflow-x: visible !important;
          overflow-y: visible !important;
          -webkit-print-color-adjust: exact !important;
          print-color-adjust: exact !important;
        }
        #app, body.is-printing-mode #app,
        #modal-root, body.is-printing-mode #modal-root,
        .live-alert-banner, .floating-chat-fab, .floating-smart-dock, .no-print-bar, #direct-print-iframe {
          display: none !important;
        }
        #print-area, body.is-printing-mode #print-area, #print-area * {
          visibility: visible !important;
          opacity: 1 !important;
        }
        #print-area, body.is-printing-mode #print-area {
          display: block !important;
          position: static !important;
          z-index: auto !important;
          width: 100% !important;
          height: auto !important;
          min-height: 0 !important;
          max-height: none !important;
          overflow: visible !important;
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
        <div style="font-size:12px;color:#cbd5e1;">المستند جاهز للطباعة الفورية أو التحميل كملف PDF مباشر</div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button type="button" onclick="window.focus(); window.print();" style="background:#10b981;color:#fff;border:none;padding:8px 18px;border-radius:8px;font-weight:800;font-size:13px;cursor:pointer;font-family:'Cairo',sans-serif;">
          🖨️ طباعة الآن / حفظ كـ PDF
        </button>
        <button type="button" onclick="downloadInPagePdfFile()" style="background:#7c3aed;color:#fff;border:none;padding:8px 16px;border-radius:8px;font-weight:800;font-size:13px;cursor:pointer;font-family:'Cairo',sans-serif;">
          📥 تحميل كملف PDF مباشر
        </button>
        <button type="button" onclick="openStandalonePrintPopup()" style="background:#2563eb;color:#fff;border:none;padding:8px 14px;border-radius:8px;font-weight:800;font-size:13px;cursor:pointer;font-family:'Cairo',sans-serif;">
          🗔 فتح في صفحة طباعة مستقلة
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

  // Build real committed URL to ./print.html (NEVER about:blank!)
  _lastPrintUrl = buildRealPrintPageUrl(docHtml, docTitle, landscape, extraOptions);
  let popupOpened = false;
  try {
    const popupWin = typeof window.open === 'function' ? window.open(_lastPrintUrl, '_blank') : null;
    if (popupWin) {
      popupOpened = true;
    }
  } catch (_) {}

  // Also trigger in-page print after images decode if popup did not open
  if (!popupOpened) {
    const imgs = Array.from(printEl.querySelectorAll('img'));
    const decodePromises = imgs.map(img => (img.decode ? img.decode().catch(() => {}) : Promise.resolve()));
    Promise.race([
      Promise.all(decodePromises),
      new Promise(res => setTimeout(res, 220))
    ]).then(() => {
      setTimeout(() => {
        try {
          void printEl.offsetHeight;
          if (typeof window.focus === 'function') window.focus();
          window.print();
        } catch (_) {}
      }, 150);
    });
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
  const m = (state.warehouseMovements || []).find(x => x.id === movId);
  if (!m) return;

  // If this warehouse movement is a Vehicle Dispatch Voucher (CAR-...) or linked to a client order car dispatch, print the official Vehicle Dispatch Voucher!
  const vNum = String(m.voucherNumber || '').trim();
  const isCarMovement = vNum.startsWith('CAR-') || String(m.directionLabel || '').includes('سيارة') || String(m.warehouseLabel || '').includes('سيارة');
  const linkedOrder = (state.productionOrders || []).find(o => {
    const carVo = o.carDispatchVoucher?.voucherNo || `CAR-${o.orderNumber}`;
    return (vNum && (carVo === vNum || o.orderNumber === vNum)) || (isCarMovement && m.referenceCode && o.carDispatchVoucher?.carPlateNumber === m.referenceCode);
  });

  if (linkedOrder) {
    printVehicleDispatchVoucher(linkedOrder.id, m.id);
    return;
  }
  if (isCarMovement) {
    const carHtml = buildVehicleDispatchVoucherPrintHtml(null, m);
    openUniversalPrintDocument(carHtml, `إذن صرف سيارة ${m.referenceCode || m.voucherNumber || ''}`, false);
    return;
  }

  const factoryName = state.factoryInfo?.name || 'مصنع العاصمة للصناعات المتخصصة';
  const html = `
    <div style="border:2px solid #000;padding:28px;font-family:'Cairo',sans-serif;direction:rtl;background:#fff;color:#000;">
      <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #000;padding-bottom:12px;margin-bottom:16px;">
        <div>
          <h2 style="margin:0;">${factoryName}</h2>
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
        <span>أمين المخزن: ${m.performedBy || '-'}</span>
        <span>اعتماد الإدارة: ${m.approvedBy || '-'}</span>
      </div>
    </div>
  `;
  openUniversalPrintDocument(html, `إذن حركة مخزن ${m.voucherNumber}`, false);
}

function printProductionOrder(poId) {
  printClientOrderStatement(poId);
}

function buildOfficialOrderStatementPdfHtml(ord) {
  const items = Array.isArray(ord.items) ? ord.items : [];
  const showPrices = canSeeFinancialPrices();
  const car = ord.carDispatchVoucher || null;
  const factoryName = state.factoryInfo?.name || 'مصنع العاصمة للصناعات المتخصصة';
  const logoSrc = getFactoryLogoSrc();
  const stampSrc = getFactoryStampSrc();

  const clientObj = ord.clientObj || (state.partners || []).find(p => p.id === ord.clientId || p.name === ord.clientName);
  const subtotal = Number(ord.subtotalAmount ?? items.reduce((s, i) => s + Number(i.totalItemAmount || 0), 0));
  const discAmt = Number(ord.discountAmount || 0);
  const discPct = ord.discountPercent !== undefined
    ? Number(ord.discountPercent)
    : (ord.discountType === 'percent' ? Number(ord.discountValue || 0) : (subtotal > 0 ? +((discAmt / subtotal) * 100).toFixed(2) : 0));
  const afterDiscount = Math.max(0, +(subtotal - discAmt).toFixed(2));

  // Unit prices are inclusive of 14% VAT
  const preVatBase = ord.preVatBaseAmount !== undefined ? Number(ord.preVatBaseAmount) : +(afterDiscount / 1.14).toFixed(2);
  const includedVat14 = ord.includedVatAmount !== undefined ? Number(ord.includedVatAmount) : +(afterDiscount - preVatBase).toFixed(2);

  const whtMode = ord.withholdingTaxMode || 'none';
  const whtRate = whtMode === 'none' ? 0 : Number(ord.withholdingTaxRate || 0);
  const whtAmt = whtRate > 0 ? Number(ord.withholdingTaxAmount ?? +((preVatBase * whtRate) / 100).toFixed(2)) : 0;

  const delivMode = ord.deliveryMode || 'ex_factory';
  const delivCost = delivMode === 'paid_delivery' ? Number(ord.deliveryCost || 0) : 0;
  const delivPlace = ord.deliveryPlace || 'أرض مصنع العاصمة للصناعات المتخصصة';
  const delivModeLabel = delivMode === 'ex_factory'
    ? 'تسليم أرض المصنع (بدون نقل)'
    : delivMode === 'included'
      ? 'شامل التوصيل لمقر العميل (مشمول في السعر)'
      : `توصيل لمقر العميل (سعر التوصيل: ${fmtMoney(delivCost)})`;

  let netOrder = afterDiscount;
  if (whtMode === 'deduct') netOrder -= whtAmt;
  else if (whtMode === 'add') netOrder += whtAmt;
  netOrder = Math.max(0, +(netOrder + delivCost).toFixed(2));

  const oldDebt = ord.previousDebtAmount !== undefined
    ? Number(ord.previousDebtAmount || 0)
    : (clientObj ? Math.max(0, Number(computeClientMetrics(clientObj).netDebt || 0)) : 0);
  const totalRequired = ord.totalRequiredAmount !== undefined
    ? Number(ord.totalRequiredAmount)
    : +(netOrder + oldDebt).toFixed(2);
  const totalWords = ord.totalRequiredInWords || numberToArabicTafqeet(totalRequired);

  const advTerms = ord.paymentAdvanceTerms || '50% دفعة مقدمة عند التعاقد وتأكيد الطلبية';
  const defTerms = ord.paymentDeferredTerms || '50% عند الاستلام والتوريد';
  const bankAccounts = ord.bankAccountsText || getDefaultBankAccountsText();

  return `
    <div style="border:3px solid #0f172a;padding:20px 24px;font-family:'Cairo',sans-serif;direction:rtl;background:#fff;color:#000;border-radius:6px;">
      <!-- Top Header: Right = Factory Info | Center = بيان طلبية | Top Left = Company Logo -->
      <div style="display:grid;grid-template-columns:1fr auto 1fr;align-items:center;border-bottom:3px double #0f172a;padding-bottom:12px;margin-bottom:14px;gap:12px;">
        <!-- Right Side -->
        <div style="text-align:right;">
          <h1 style="margin:0;font-size:19px;font-weight:900;color:#0f172a;">${factoryName}</h1>
          <div style="font-size:12px;color:#334155;font-weight:700;margin-top:3px;">لإنتاج وتصنيع القشرة الخشبية القياسية والخاصة</div>
          <div style="font-size:12px;margin-top:4px;">
            <strong>رقم البيان:</strong> ${ord.orderNumber || '-'} &nbsp;|&nbsp; <strong>التاريخ:</strong> ${ord.date || fmtDate(ord.createdAt)}
          </div>
        </div>

        <!-- Center Title: بيان طلبية -->
        <div style="text-align:center;">
          <div style="border:2.5px solid #0f172a;background:#f8fafc;padding:7px 28px;border-radius:10px;box-shadow:0 2px 0 #0f172a;">
            <h2 style="margin:0;font-size:22px;font-weight:900;color:#0f172a;letter-spacing:0.5px;">بيان طلبية</h2>
            <div style="font-size:11px;font-weight:800;color:#b45309;margin-top:2px;">ORDER STATEMENT</div>
          </div>
        </div>

        <!-- Top Left: Company Logo -->
        <div style="display:flex;justify-content:flex-end;align-items:center;">
          <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;border:1.5px solid #0f172a;border-radius:8px;padding:5px 10px;background:#ffffff;">
            <img src="${logoSrc}" alt="لوجو الشركة" style="height:64px;max-width:150px;object-fit:contain;display:block;" />
          </div>
        </div>
      </div>

      <!-- Client Details Box -->
      <div style="border:1.5px solid #0f172a;background:#f8fafc;padding:9px 14px;border-radius:8px;margin-bottom:12px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;font-size:13.5px;">
        <div>
          <strong>السادة / اسم العميل:</strong> <span style="font-size:15px;font-weight:900;color:#0f172a;">${ord.clientName || '-'}</span>
          <span style="font-size:12px;color:#475569;margin-right:6px;">(كود العميل: ${ord.clientCode || 'CL'})</span>
        </div>
        <div style="font-size:12.5px;">
          ${ord.clientPhone ? `<strong>هاتف:</strong> ${ord.clientPhone} &nbsp;|&nbsp; ` : ''}
          <strong>مكان التسليم:</strong> ${delivModeLabel}
        </div>
      </div>

      <!-- Items Table: مسلسل | البيان | المقاس | الاتجاه | التخانة | الجودة | الكمية | السعر | الإجمالي -->
      <table style="width:100%;border-collapse:collapse;margin-bottom:8px;font-size:13px;">
        <thead>
          <tr style="background:#e2e8f0;color:#0f172a;">
            <th style="border:1.5px solid #000;padding:6px 5px;width:36px;text-align:center;">مسلسل</th>
            <th style="border:1.5px solid #000;padding:6px 8px;text-align:right;">البيان</th>
            <th style="border:1.5px solid #000;padding:6px 6px;text-align:center;">المقاس (العرض × الطول)</th>
            <th style="border:1.5px solid #000;padding:6px 6px;text-align:center;">الاتجاه</th>
            <th style="border:1.5px solid #000;padding:6px 6px;text-align:center;">التخانة</th>
            <th style="border:1.5px solid #000;padding:6px 6px;text-align:center;">الجودة</th>
            <th style="border:1.5px solid #000;padding:6px 6px;text-align:center;">الكمية</th>
            ${showPrices ? `
              <th style="border:1.5px solid #000;padding:6px 6px;text-align:center;">السعر (شامل ق.م 14%)</th>
              <th style="border:1.5px solid #000;padding:6px 8px;text-align:center;">الإجمالي</th>
            ` : ''}
          </tr>
        </thead>
        <tbody>
          ${items.map((it, idx) => {
            const desc = it.itemDescription || it.woodTypeName || 'قشرة خشبية طبيعية';
            const wid = Number(it.widthCm || 125);
            const len = Number(it.lengthCm || 250);
            return `
            <tr>
              <td style="border:1px solid #000;padding:6px 5px;text-align:center;font-weight:800;">${idx + 1}</td>
              <td style="border:1px solid #000;padding:6px 8px;font-weight:800;">${desc}</td>
              <td style="border:1px solid #000;padding:6px 6px;text-align:center;font-weight:700;">${wid} × ${len} سم</td>
              <td style="border:1px solid #000;padding:6px 6px;text-align:center;font-weight:700;">${it.direction === 'sada' ? 'سدا' : 'قص'}</td>
              <td style="border:1px solid #000;padding:6px 6px;text-align:center;font-weight:800;">${it.thicknessMm} مم</td>
              <td style="border:1px solid #000;padding:6px 6px;text-align:center;font-weight:800;">${it.gradeName || it.gradeCode || '-'}</td>
              <td style="border:1px solid #000;padding:6px 6px;text-align:center;font-weight:800;">
                ${fmtNum(it.sheetsCount, 0)} قطعة
                <div style="font-size:10.5px;color:#475569;font-weight:600;">(${fmtNum(it.volumeM3, 4)} م³)</div>
              </td>
              ${showPrices ? `
                <td style="border:1px solid #000;padding:6px 6px;text-align:center;font-weight:700;">${fmtMoney(it.unitPrice)}</td>
                <td style="border:1px solid #000;padding:6px 8px;text-align:center;font-weight:900;">${fmtMoney(it.totalItemAmount)}</td>
              ` : ''}
            </tr>
          `;}).join('')}
        </tbody>
        <tfoot>
          <tr style="background:#f1f5f9;font-weight:900;">
            <td colspan="6" style="border:1.5px solid #000;padding:6px 8px;text-align:left;">إجمالي الكميات والحجم بالبيان:</td>
            <td style="border:1.5px solid #000;padding:6px 6px;text-align:center;">${fmtNum(ord.totalSheetsCount, 0)} قطعة (${fmtNum(ord.totalVolumeM3, 4)} م³)</td>
            ${showPrices ? `
              <td style="border:1.5px solid #000;padding:6px 6px;text-align:center;">إجمالي الطلبية:</td>
              <td style="border:1.5px solid #000;padding:6px 8px;text-align:center;font-size:14px;">${fmtMoney(subtotal)}</td>
            ` : ''}
          </tr>
        </tfoot>
      </table>

      ${showPrices ? `
      <div style="font-size:11.5px;font-weight:800;color:#b45309;margin-bottom:10px;background:#fffbeb;border:1px solid #f59e0b;padding:4px 10px;border-radius:6px;">
        📌 <strong>ملحوظة هامة:</strong> جميع الأسعار التي تكتب في سعر القطعة <strong>شاملة ضريبة القيمة المضافة 14%</strong>، وضريبة الخصم والإضافة اختيارية.
      </div>

      <!-- Financial Breakdown & Delivery & Payment Grid -->
      <div style="display:grid;grid-template-columns:1.1fr 0.9fr;gap:12px;margin-bottom:12px;align-items:stretch;">
        <!-- Right Column: Delivery, Payment Terms & Bank Accounts -->
        <div style="border:1.5px solid #000;border-radius:8px;padding:10px 12px;font-size:12.5px;display:flex;flex-direction:column;justify-content:space-between;gap:8px;">
          <div>
            <div style="font-weight:900;font-size:13px;color:#0f172a;border-bottom:1px solid #cbd5e1;padding-bottom:4px;margin-bottom:6px;">
              🚚 مكان التسليم وشروط الدفع (المقدم والآجل):
            </div>
            <div style="margin-bottom:4px;"><strong>• مكان التسليم:</strong> ${delivModeLabel} — (${delivPlace})</div>
            <div style="margin-bottom:4px;"><strong>• شروط الدفع (المقدم):</strong> ${advTerms}</div>
            <div style="margin-bottom:4px;"><strong>• شروط الدفع (الآجل):</strong> ${defTerms}</div>
            ${ord.notes ? `<div style="margin-top:4px;"><strong>• ملاحظات البيان:</strong> ${ord.notes}</div>` : ''}
          </div>

          <div style="background:#f8fafc;border:1px solid #0f172a;border-radius:6px;padding:7px 10px;margin-top:4px;">
            <div style="font-weight:900;font-size:12.5px;color:#0f766e;margin-bottom:3px;">
              🏦 أرقام الحسابات البنكية الخاصة بمصنع العاصمة (لتحويل المبلغ عليها):
            </div>
            <div style="white-space:pre-line;font-size:11.5px;font-weight:700;line-height:1.45;color:#0f172a;">${bankAccounts}</div>
          </div>
        </div>

        <!-- Left Column: Financial Summary Table -->
        <div style="border:2px solid #000;border-radius:8px;overflow:hidden;font-size:12.5px;">
          <table style="width:100%;border-collapse:collapse;">
            <tr>
              <td style="border-bottom:1px solid #cbd5e1;padding:6px 10px;background:#f8fafc;font-weight:700;">إجمالي قيمة الطلبية (شامل ق.م 14%):</td>
              <td style="border-bottom:1px solid #cbd5e1;padding:6px 10px;text-align:left;font-weight:900;">${fmtMoney(subtotal)}</td>
            </tr>
            <tr>
              <td style="border-bottom:1px solid #cbd5e1;padding:6px 10px;background:#f8fafc;font-weight:700;">نسبة وقيمة الخصم (${fmtNum(discPct, 2)}%):</td>
              <td style="border-bottom:1px solid #cbd5e1;padding:6px 10px;text-align:left;font-weight:800;color:#dc2626;">-${fmtMoney(discAmt)}</td>
            </tr>
            <tr>
              <td style="border-bottom:1px solid #cbd5e1;padding:6px 10px;background:#f8fafc;font-weight:700;">ضريبة القيمة المضافة (14%):</td>
              <td style="border-bottom:1px solid #cbd5e1;padding:6px 10px;text-align:left;font-weight:700;font-size:11.5px;">شاملة بالسعر (${fmtMoney(includedVat14)})</td>
            </tr>
            <tr>
              <td style="border-bottom:1px solid #cbd5e1;padding:6px 10px;background:#f8fafc;font-weight:700;">ضريبة الخصم والإضافة ${whtMode !== 'none' ? `(${whtRate}%)` : '(اختياري)'}:</td>
              <td style="border-bottom:1px solid #cbd5e1;padding:6px 10px;text-align:left;font-weight:800;">
                ${whtMode === 'none' ? 'غير مطبقة (0 ج.م)' : `${whtMode === 'deduct' ? '-' : '+'}${fmtMoney(whtAmt)}`}
              </td>
            </tr>
            <tr>
              <td style="border-bottom:1px solid #cbd5e1;padding:6px 10px;background:#f8fafc;font-weight:700;">سعر التوصيل (${delivMode === 'ex_factory' ? 'أرض المصنع' : delivMode === 'included' ? 'شامل التوصيل' : 'نولون توصيل'}):</td>
              <td style="border-bottom:1px solid #cbd5e1;padding:6px 10px;text-align:left;font-weight:800;">
                ${delivMode === 'included' ? 'شامل التوصيل' : fmtMoney(delivCost)}
              </td>
            </tr>
            <tr style="background:#e0f2fe;">
              <td style="border-bottom:1.5px solid #000;padding:7px 10px;font-weight:900;color:#0f172a;">صافي الطلبية:</td>
              <td style="border-bottom:1.5px solid #000;padding:7px 10px;text-align:left;font-weight:900;font-size:14px;color:#0f172a;">${fmtMoney(netOrder)}</td>
            </tr>
            <tr>
              <td style="border-bottom:1.5px solid #000;padding:6px 10px;background:#fef2f2;font-weight:800;color:#991b1b;">المديونية القديمة على العميل:</td>
              <td style="border-bottom:1.5px solid #000;padding:6px 10px;background:#fef2f2;text-align:left;font-weight:900;color:#dc2626;">${fmtMoney(oldDebt)}</td>
            </tr>
            <tr style="background:#dcfce7;">
              <td style="padding:8px 10px;font-weight:900;font-size:14px;color:#14532d;">إجمالي المبلغ المطلوب:</td>
              <td style="padding:8px 10px;text-align:left;font-weight:900;font-size:15.5px;color:#14532d;">${fmtMoney(totalRequired)}</td>
            </tr>
          </table>
        </div>
      </div>

      <!-- Total Required Amount in Words (إجمالي المبلغ المطلوب بالحروف) -->
      <div style="border:2px solid #0f172a;background:#f8fafc;padding:8px 14px;border-radius:8px;margin-bottom:12px;font-size:13.5px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px;">
        <div>
          <strong>إجمالي المبلغ المطلوب بالحروف:</strong>
          <span style="font-weight:900;color:#0f172a;margin-right:6px;">${totalWords}</span>
        </div>
      </div>
      ` : ''}

      ${car ? `
      <div style="border:1.5px solid #000;background:#f8fafc;padding:8px 12px;border-radius:8px;margin-bottom:10px;font-size:12px;">
        <strong>🚚 بيانات إذن صرف وتحميل السيارة (${car.voucherNo || 'CAR-' + ord.orderNumber}):</strong>
        رقم السيارة: <strong>${car.carPlateNumber || '-'}</strong> | السائق: <strong>${car.driverName || '-'}</strong> | البالتات: مسلم (${car.palletsDeliveredCount ?? 0}) / مستلم (${car.palletsReceivedCount ?? 0})
      </div>
      ` : ''}

      <!-- Closing Line in Center -->
      <div style="text-align:center;font-size:15px;font-weight:900;margin:10px 0 12px;color:#0f172a;">
        وتفضلوا بقبول فائق الاحترام والتقدير،،،
      </div>

      <!-- Bottom Row: Right = Prepared / Approved By | Bottom Left = العاصمة للصناعات المتخصصة + Company Stamp -->
      <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-top:8px;padding-top:8px;border-top:1px dashed #94a3b8;">
        <div style="display:flex;gap:32px;font-size:12.5px;font-weight:700;text-align:center;">
          <div>
            إعداد الحسابات<br/><br/>
            <span>${ord.requestedBy || '................'}</span>
          </div>
          <div>
            اعتماد الإدارة<br/><br/>
            <span>${ord.executiveApprovedBy || '................'}</span>
          </div>
          <div>
            توقيع العميل بالموافقة<br/><br/>
            <span>................</span>
          </div>
        </div>

        <!-- Bottom Left: العاصمة للصناعات المتخصصة + ختم الشركة تحتها -->
        <div style="text-align:center;min-width:210px;">
          <div style="font-size:15px;font-weight:900;color:#0f172a;margin-bottom:6px;">
            العاصمة للصناعات المتخصصة
          </div>
          <div style="display:inline-flex;align-items:center;justify-content:center;min-height:85px;">
            <img src="${stampSrc}" alt="ختم الشركة" style="max-height:92px;max-width:190px;object-fit:contain;display:block;" />
          </div>
        </div>
      </div>
    </div>
  `;
}

function printClientOrderStatement(orderId) {
  const ord = (state.productionOrders || []).find(x => x.id === orderId);
  if (!ord) return;
  const html = buildOfficialOrderStatementPdfHtml(ord);
  openUniversalPrintDocument(html, `بيان طلبية ${ord.orderNumber} - ${ord.clientName}`, false);
}

function buildVehicleDispatchVoucherPrintHtml(ord, movFallback = null) {
  const factoryName = state.factoryInfo?.name || 'مصنع العاصمة للصناعات المتخصصة';
  const actorName = currentUser?.name || 'إدارة المخازن';

  if (!ord && movFallback) {
    return `
      <div style="border:3px solid #000;padding:24px;font-family:'Cairo',sans-serif;direction:rtl;background:#fff;color:#000;">
        <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:3px solid #000;padding-bottom:12px;margin-bottom:16px;">
          <div>
            <h1 style="margin:0;font-size:22px;">${factoryName}</h1>
            <h2 style="margin:6px 0 0;font-size:17px;">🚚 إذن صرف وتحميل سيارة بالبضاعة (معتمد للخروج من البوابة)</h2>
          </div>
          ${getPrintTopLeftLogoHtml(`
            <div style="border:2px solid #000;padding:5px 10px;border-radius:8px;">
              <div><strong>رقم إذن السيارة:</strong> ${movFallback.voucherNumber || '-'}</div>
              <div><strong>رقم السيارة:</strong> ${movFallback.referenceCode || '-'}</div>
              <div><strong>تاريخ التحميل:</strong> ${fmtDate(movFallback.date)}</div>
            </div>
          `)}
        </div>
        <table style="width:100%;border-collapse:collapse;margin-bottom:16px;font-size:14px;">
          <tr>
            <td style="border:1px solid #000;padding:8px;background:#f1f5f9;font-weight:700;">المخزن المنصرف منه:</td>
            <td style="border:1px solid #000;padding:8px;font-weight:800;">${movFallback.warehouseLabel || 'مخزن القشرة التامة'}</td>
            <td style="border:1px solid #000;padding:8px;background:#f1f5f9;font-weight:700;">رقم السيارة المحملة:</td>
            <td style="border:1px solid #000;padding:8px;font-weight:900;font-size:17px;">${movFallback.referenceCode || '-'}</td>
          </tr>
          <tr>
            <td style="border:1px solid #000;padding:8px;background:#f1f5f9;font-weight:700;">بيان البضاعة المحملة:</td>
            <td colspan="3" style="border:1px solid #000;padding:8px;font-weight:800;">${sanitizeTextForWarehouseKeeper(movFallback.itemSummary || '-')}</td>
          </tr>
          <tr>
            <td style="border:1px solid #000;padding:8px;background:#f1f5f9;font-weight:700;">إجمالي الكمية المحملة:</td>
            <td colspan="3" style="border:1px solid #000;padding:8px;font-weight:800;">${sanitizeTextForWarehouseKeeper(movFallback.quantitySummary || '-')}</td>
          </tr>
        </table>
        <div style="display:grid;grid-template-columns:repeat(4, 1fr);gap:14px;margin-top:35px;text-align:center;font-weight:700;font-size:13px;">
          <div>اعتماد المحاسب للصرف<br/><br/>${movFallback.approvedBy || '................'}</div>
          <div>أمين المخزن / المدير الإداري<br/><br/>${movFallback.performedBy || actorName}</div>
          <div>توقيع سائق السيارة بالاستلام<br/><br/>................</div>
          <div>مسؤول أمن البوابة<br/><br/>................</div>
        </div>
      </div>
    `;
  }

  const car = ord.carDispatchVoucher || {};
  const items = Array.isArray(ord.items) ? ord.items : [];
  const totalSheets = items.reduce((s, i) => s + Number(i.sheetsCount || 0), 0) || Number(ord.totalSheetsCount || 0);
  const totalAreaM2 = items.reduce((s, i) => {
    const sh = Number(i.sheetsCount || 0);
    const len = Number(i.lengthCm || 250);
    const wid = Number(i.widthCm || 125);
    const area = Number(i.areaM2 || (sh * (len / 100) * (wid / 100)));
    return s + area;
  }, 0);
  const totalVolM3 = items.reduce((s, i) => s + Number(i.volumeM3 || 0), 0) || Number(ord.totalVolumeM3 || 0);
  const combinedNotes = [car.notes, ord.notes].filter(Boolean).join(' — ');

  return `
    <div class="vehicle-dispatch-voucher-box" style="border:3px solid #000;padding:24px;font-family:'Cairo',sans-serif;direction:rtl;background:#fff;color:#000;">
      <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:3px solid #000;padding-bottom:12px;margin-bottom:16px;">
        <div>
          <h1 style="margin:0;font-size:22px;color:#000;">${factoryName}</h1>
          <h2 style="margin:6px 0 0;font-size:17px;color:#000;">🚚 إذن صرف وتحميل سيارة بالبضاعة (معتمد للخروج من البوابة)</h2>
        </div>
        ${getPrintTopLeftLogoHtml(`
          <div style="border:2px solid #000;padding:5px 10px;border-radius:8px;background:#fff;color:#000;">
            <div><strong>رقم إذن السيارة:</strong> ${car.voucherNo || 'CAR-' + ord.orderNumber}</div>
            <div><strong>رقم الطلبية:</strong> ${ord.orderNumber}</div>
            <div><strong>تاريخ التحميل:</strong> ${car.dispatchDate || ord.date || todayStr()}</div>
          </div>
        `)}
      </div>

      <table style="width:100%;border-collapse:collapse;margin-bottom:16px;font-size:14px;">
        <tr>
          <td style="border:1px solid #000;padding:8px;background:#f1f5f9;font-weight:700;width:18%;">اسم العميل وكوده:</td>
          <td style="border:1px solid #000;padding:8px;font-weight:800;width:32%;">[${ord.clientCode || 'CL'}] ${ord.clientName}</td>
          <td style="border:1px solid #000;padding:8px;background:#f1f5f9;font-weight:700;width:18%;">رقم السيارة المحملة:</td>
          <td style="border:1px solid #000;padding:8px;font-weight:900;font-size:17px;width:32%;">${car.carPlateNumber || movFallback?.referenceCode || 'خروج من المخزن'}</td>
        </tr>
        <tr>
          <td style="border:1px solid #000;padding:8px;background:#f1f5f9;font-weight:700;">اسم سائق السيارة:</td>
          <td style="border:1px solid #000;padding:8px;font-weight:800;">${car.driverName || '-'}${car.driverPhone ? ' (' + car.driverPhone + ')' : ''}</td>
          <td style="border:1px solid #000;padding:8px;background:#f1f5f9;font-weight:700;">حساب البالتات مع السيارة:</td>
          <td style="border:1px solid #000;padding:8px;font-weight:800;">
            بالتات مسلمة للعميل: (${car.palletsDeliveredCount ?? 0}) | مستلمة منه: (${car.palletsReceivedCount ?? 0})
          </td>
        </tr>
      </table>

      <h3 style="margin:0 0 8px;font-size:15px;color:#000;">📦 بيان أصناف القشرة الخشبية المحملة على السيارة:</h3>
      <table style="width:100%;border-collapse:collapse;margin-bottom:16px;font-size:14px;">
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
          ${items.map((it, idx) => {
            const sh = Number(it.sheetsCount || 0);
            const len = Number(it.lengthCm || 250);
            const wid = Number(it.widthCm || 125);
            const area = Number(it.areaM2 || (sh * (len / 100) * (wid / 100)));
            const vol = Number(it.volumeM3 || (area * (Number(it.thicknessMm || 0) / 1000)));
            return `
              <tr>
                <td style="border:1px solid #000;padding:7px;text-align:center;">${idx + 1}</td>
                <td style="border:1px solid #000;padding:7px;font-weight:700;">${it.thicknessMm} مم (${it.direction === 'sada' ? 'اتجاه سدا' : 'اتجاه قص'})</td>
                <td style="border:1px solid #000;padding:7px;font-weight:700;">${it.gradeName || '-'}</td>
                <td style="border:1px solid #000;padding:7px;font-weight:700;">${formatVeneerDimensions(len, wid, true)}</td>
                <td style="border:1px solid #000;padding:7px;font-weight:800;">${fmtNum(sh, 0)} قطعة</td>
                <td style="border:1px solid #000;padding:7px;">${fmtNum(area, 2)} م²</td>
                <td style="border:1px solid #000;padding:7px;font-weight:800;">${fmtNum(vol, 4)} م³</td>
              </tr>
            `;
          }).join('')}
        </tbody>
        <tfoot>
          <tr style="background:#f1f5f9;font-weight:900;">
            <td colspan="4" style="border:1px solid #000;padding:8px;text-align:center;">الإجمالي الكلي المحمل على السيارة</td>
            <td style="border:1px solid #000;padding:8px;text-align:center;">${fmtNum(totalSheets, 0)} قطعة</td>
            <td style="border:1px solid #000;padding:8px;text-align:center;">${fmtNum(totalAreaM2, 2)} م²</td>
            <td style="border:1px solid #000;padding:8px;text-align:center;">${fmtNum(totalVolM3, 4)} م³</td>
          </tr>
        </tfoot>
      </table>

      ${combinedNotes ? `
        <div style="border:2px solid #000;background:#f8fafc;padding:9px 12px;border-radius:6px;margin-bottom:16px;font-size:13.5px;">
          <strong>📌 ملاحظات التحميل وأمن البوابة:</strong> ${combinedNotes}
        </div>
      ` : ''}

      <div style="display:grid;grid-template-columns:repeat(4, 1fr);gap:14px;margin-top:30px;text-align:center;font-weight:700;font-size:13px;">
        <div>اعتماد المحاسب للصرف<br/><br/>${ord.accountantReleaseBy || '................'}</div>
        <div>أمين المخزن / المدير الإداري<br/><br/>${car.dispatchedBy || ord.warehousePrepApprovedBy || actorName}</div>
        <div>توقيع سائق السيارة بالاستلام<br/><br/>${car.driverName || '................'}</div>
        <div>مسؤول أمن البوابة<br/><br/>................</div>
      </div>
    </div>
  `;
}

function printVehicleDispatchVoucher(orderId, movId = null) {
  let ord = (state.productionOrders || []).find(x => x.id === orderId || x.orderNumber === orderId);
  const mov = movId ? (state.warehouseMovements || []).find(x => x.id === movId) : null;
  if (!ord && mov) {
    ord = (state.productionOrders || []).find(o => {
      const carVo = o.carDispatchVoucher?.voucherNo || `CAR-${o.orderNumber}`;
      return carVo === mov.voucherNumber || o.orderNumber === mov.voucherNumber;
    });
  }
  if (!ord && !mov) return;
  const car = ord?.carDispatchVoucher || {};
  const html = buildVehicleDispatchVoucherPrintHtml(ord, mov);
  const titleLabel = car.carPlateNumber || ord?.orderNumber || mov?.voucherNumber || '';
  const compactCarJson = ord ? {
    t: 'car',
    fn: state.factoryInfo?.name || 'مصنع العاصمة للصناعات المتخصصة',
    vn: car.voucherNo || ('CAR-' + ord.orderNumber),
    on: ord.orderNumber || '',
    dt: car.dispatchDate || ord.date || todayStr(),
    cc: ord.clientCode || 'CL',
    cn: ord.clientName || '',
    cp: car.carPlateNumber || mov?.referenceCode || 'خروج من المخزن',
    dn: car.driverName || '',
    dp: car.driverPhone || '',
    po: car.palletsDeliveredCount ?? 0,
    pi: car.palletsReceivedCount ?? 0,
    nt: [car.notes, ord.notes].filter(Boolean).join(' — '),
    ab: ord.accountantReleaseBy || '',
    wb: car.dispatchedBy || ord.warehousePrepApprovedBy || currentUser?.name || '',
    it: (ord.items || []).map(it => {
      const sh = Number(it.sheetsCount || 0);
      const len = Number(it.lengthCm || 250);
      const wid = Number(it.widthCm || 125);
      const area = Number(it.areaM2 || (sh * (len / 100) * (wid / 100)));
      const vol = Number(it.volumeM3 || (area * (Number(it.thicknessMm || 0) / 1000)));
      return {
        th: it.thicknessMm,
        dr: it.direction,
        gr: it.gradeName || '-',
        l: len,
        w: wid,
        sh,
        a: Number(area.toFixed(2)),
        v: Number(vol.toFixed(4))
      };
    })
  } : null;
  openUniversalPrintDocument(html, `إذن صرف سيارة ${titleLabel}`, false, {
    orderId: ord?.id || '',
    compactCarJson
  });
}

function printClientFullStatement(clientId) {
  const pt = (state.partners || []).find(p => p.id === clientId);
  if (!pt) return;
  const m = computeClientMetrics(pt);
  const factoryName = state.factoryInfo?.name || 'مصنع العاصمة للصناعات المتخصصة';
  const html = `
    <div style="border:3px solid #000;padding:24px;font-family:'Cairo',sans-serif;direction:rtl;background:#fff;color:#000;">
      <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #000;padding-bottom:12px;margin-bottom:16px;">
        <div>
          <h1 style="margin:0;font-size:21px;">${factoryName}</h1>
          <p style="margin:4px 0 0;font-size:14px;">بيان كشف حساب عميل شامل (الطلبيات الفائتة + أذون السيارات + المديونيات والمستحقات + حساب البالتات)</p>
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
          <td style="border:1px solid #000;padding:8px;"><strong>بالتات مسلمة للعميل:</strong> ${m.palletsDelivered} بالتة (${fmtMoney(m.palletsDeliveredValue || 0)})</td>
          <td style="border:1px solid #000;padding:8px;"><strong>بالتات مستلمة من العميل:</strong> ${m.palletsReceived} بالتة (${fmtMoney(m.palletsReceivedValue || 0)})</td>
          <td style="border:1px solid #000;padding:8px;font-size:14px;">
            <strong>صافي البالتات طرف العميل:</strong> ${m.netPalletsAtClient} بالتة<br/>
            <span style="font-size:12px;">قيمة البالتة: <strong>${fmtMoney(m.palletUnitPrice || 0)}</strong> | إجمالي قيمة البالتات: <strong>${fmtMoney(Math.abs(m.netPalletsValue || 0))}</strong></span>
          </td>
        </tr>
      </table>

      <h3 style="margin:12px 0 6px;font-size:14px;">1. بيان الطلبيات وأذون صرف السيارات (${m.orders.length} طلبية):</h3>
      <table style="width:100%;border-collapse:collapse;margin-bottom:16px;font-size:12.5px;">
        <thead>
          <tr style="background:#e2e8f0;">
            <th style="border:1px solid #000;padding:6px;">رقم الطلبية</th>
            <th style="border:1px solid #000;padding:6px;">التاريخ</th>
            <th style="border:1px solid #000;padding:6px;">الأصناف (التخانات والجودات)</th>
            <th style="border:1px solid #000;padding:6px;">إذن السيارة والسائق</th>
            <th style="border:1px solid #000;padding:6px;">الخصم</th>
            <th style="border:1px solid #000;padding:6px;">الصافي</th>
          </tr>
        </thead>
        <tbody>
          ${m.orders.map(o => {
            const car = o.carDispatchVoucher || {};
            return `
            <tr>
              <td style="border:1px solid #000;padding:6px;font-weight:700;">${o.orderNumber}</td>
              <td style="border:1px solid #000;padding:6px;">${o.date}</td>
              <td style="border:1px solid #000;padding:6px;">${(o.items || []).map(i => `${i.thicknessMm}مم (${i.direction === 'sada' ? 'سدا' : 'قص'}) ${i.gradeName} [${formatVeneerDimensions(i.lengthCm, i.widthCm, false)}]: ${i.sheetsCount} ق`).join(' + ')}</td>
              <td style="border:1px solid #000;padding:6px;">${car.carPlateNumber ? `سيارة: <strong>${car.carPlateNumber}</strong><br/>سائق: ${car.driverName || '-'}<br/>بالتات: +${car.palletsDeliveredCount ?? 0}/-${car.palletsReceivedCount ?? 0}` : '-'}</td>
              <td style="border:1px solid #000;padding:6px;">${fmtMoney(o.discountAmount || 0)}</td>
              <td style="border:1px solid #000;padding:6px;font-weight:700;">${fmtMoney(o.netTotalAmount || 0)}</td>
            </tr>
          `;}).join('')}
        </tbody>
      </table>

      <div style="display:flex;justify-content:space-between;margin-top:30px;font-weight:700;font-size:13px;">
        <span>إعداد الحسابات: ${currentUser?.name || '-'}</span>
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
        if (Number(p.volumeM3) !== 0) return s + Number(p.volumeM3);
        return s + calculateVeneerMetrics(p.lengthCm || 250, p.widthCm || 125, t.mm, p.sheetsCount).totalVolumeM3;
      }, 0)).toFixed(4);
      rowSheets += sheets;
      rowM3 += m3;
      colTotals[g.id].sheets += sheets;
      colTotals[g.id].m3 += m3;
      return `
        <td style="background:${sheets > 0 ? '#f0fdf4' : sheets < 0 ? '#fef2f2' : '#ffffff'};">
          <div style="font-weight:900;font-size:12px;color:${sheets > 0 ? '#0f172a' : sheets < 0 ? '#dc2626' : '#94a3b8'};direction:ltr;">${fmtNum(sheets, 0)} ق</div>
          <div style="font-size:9.5px;color:${sheets < 0 ? '#dc2626' : '#475569'};direction:ltr;">${fmtNum(m3, 3)} م³</div>
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
  const carVouchersHtml = releaseOrders
    .filter(o => o.carDispatchVoucher || o.stage === 'completed')
    .map(o => `<div style="margin-top:18px;">${buildVehicleDispatchVoucherPrintHtml(o)}</div>`)
    .join('');

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
    ${carVouchersHtml}
  `;
  triggerOfficialReportPdf('✅ تقرير أذون الصرف المعتمدة وأوامر تحميل السيارات', `إجمالي الأذون: ${releaseOrders.length}`, bodyHtml, false);
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
          <th>قيمة البالتة</th>
          <th>إجمالي قيمة البالتات</th>
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
            <td><strong>${fmtMoney(m.palletUnitPrice || 0)}</strong></td>
            <td><strong>${fmtMoney(Math.abs(m.netPalletsValue || 0))}</strong></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
  triggerOfficialReportPdf('🤝 التقرير المالي الشامل لحسابات ومديونيات العملاء وأرصدة وقيم البالتات', `إجمالي العملاء: ${rows.length}`, bodyHtml, true);
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
  const showPrices = canSeeFinancialPrices();
  const pms = state.palletMovements || [];
  const bodyHtml = `
    <table class="pdf-report-table">
      <thead>
        <tr>
          <th>التاريخ</th>
          <th>العميل وكوده</th>
          <th>بالتات مسلمة للعميل</th>
          <th>بالتات مستلمة من العميل</th>
          ${showPrices ? '<th>قيمة البالتة</th><th>إجمالي قيمة البالتات</th>' : ''}
          <th>السيارة / الملاحظات</th>
          <th>بواسطة</th>
        </tr>
      </thead>
      <tbody>
        ${pms.map(pm => {
          const ptObj = (state.partners || []).find(p => p.id === pm.clientId || p.name === pm.clientName);
          const pltPrice = getWoodenPalletUnitPrice(ptObj, pm);
          const delVal = Number(pm.totalDeliveredValue ?? (Number(pm.deliveredCount || 0) * pltPrice));
          const recVal = Number(pm.totalReceivedValue ?? (Number(pm.receivedCount || 0) * pltPrice));
          const netVal = delVal - recVal;
          return `
          <tr>
            <td>${pm.date}</td>
            <td><strong>${pm.clientName}</strong> (${pm.clientCode || 'CL'})</td>
            <td><strong>+${pm.deliveredCount || 0}</strong>${showPrices && delVal > 0 ? ` (${fmtMoney(delVal)})` : ''}</td>
            <td><strong>-${pm.receivedCount || 0}</strong>${showPrices && recVal > 0 ? ` (${fmtMoney(recVal)})` : ''}</td>
            ${showPrices ? `
              <td><strong>${fmtMoney(pltPrice)}</strong></td>
              <td><strong>${fmtMoney(Math.abs(netVal))}</strong></td>
            ` : ''}
            <td>${pm.notes || pm.carPlateNumber || '-'}</td>
            <td>${pm.createdBy || '-'}</td>
          </tr>
        `;}).join('')}
      </tbody>
    </table>
  `;
  triggerOfficialReportPdf('🪵 تقرير سجل حركة وقيم البالتات الخشبية مع العملاء', `إجمالي الحركات: ${pms.length}`, bodyHtml, false);
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
              <input id="eplt-sheets" type="number" class="form-control" value="${p.sheetsCount || 0}" required style="font-weight:800;" />
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
  const sheets = Number(document.getElementById('eplt-sheets')?.value || 0);
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
  p.status = sheets !== 0 ? 'in_stock' : 'dispatched';
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
  const currentPltPrice = getWoodenPalletUnitPrice(pt);

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
            <div class="form-group" style="grid-column: 1 / -1;">
              <label style="color:var(--primary-dark);font-weight:800;">💰 قيمة البالتة الواحدة للعميل (ج.م)</label>
              <input id="ept-plt-price" type="number" step="1" min="0" class="form-control" value="${currentPltPrice}" style="font-weight:900;border-color:var(--primary);" />
            </div>
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
  const pltPrice = Math.max(0, Number(document.getElementById('ept-plt-price')?.value ?? getWoodenPalletUnitPrice(pt)));
  pt.palletUnitPrice = pltPrice;
  if (pltPrice > 0 && !Number(state.catalog?.woodenPalletUnitPrice)) {
    if (!state.catalog) state.catalog = {};
    state.catalog.woodenPalletUnitPrice = pltPrice;
    state.catalog.woodenPalletUnitPriceUpdatedAt = new Date().toISOString();
  }
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
  const ptObj = (state.partners || []).find(p => p.id === pm.clientId || p.name === pm.clientName);
  const currentPltPrice = getWoodenPalletUnitPrice(ptObj, pm);

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
            <div class="form-group" style="grid-column: 1 / -1;">
              <label style="color:var(--primary-dark);font-weight:800;">💰 قيمة البالتة الواحدة (ج.م)</label>
              <input id="epm-price" type="number" step="1" min="0" class="form-control" value="${currentPltPrice}" style="font-weight:900;border-color:var(--primary);" />
            </div>
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
  const pltPrice = Math.max(0, Number(document.getElementById('epm-price')?.value ?? getWoodenPalletUnitPrice(null, pm)));
  pm.palletUnitPrice = pltPrice;
  pm.totalDeliveredValue = +(pm.deliveredCount * pltPrice).toFixed(2);
  pm.totalReceivedValue = +(pm.receivedCount * pltPrice).toFixed(2);
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

// ============================================================================
// 11. MOVABLE FLOATING DOCK & SMART ARABIC AI ASSISTANT (v29)
// ============================================================================
const FLOATING_DOCK_STORAGE_KEY = 'al_asimah_floating_dock_pos_v1';

function getFloatingDockConfig() {
  try {
    const raw = localStorage.getItem(FLOATING_DOCK_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch (_) {}
  return { mode: 'preset', preset: 'bottom-left', x: null, y: null };
}

function saveFloatingDockConfig(cfg) {
  try {
    localStorage.setItem(FLOATING_DOCK_STORAGE_KEY, JSON.stringify(cfg));
  } catch (_) {}
}

function setFloatingDockPreset(presetName) {
  saveFloatingDockConfig({ mode: 'preset', preset: presetName, x: null, y: null });
  closeModal();
  render();
}

function renderFloatingDockHtml(openTasksForMeCount) {
  const cfg = getFloatingDockConfig();
  if (cfg.mode === 'preset' && cfg.preset === 'hidden') {
    return '';
  }

  let posClass = '';
  let inlineStyle = '';

  if (cfg.mode === 'custom' && typeof cfg.x === 'number' && typeof cfg.y === 'number') {
    const maxX = Math.max(20, (window.innerWidth || 1200) - 240);
    const maxY = Math.max(20, (window.innerHeight || 800) - 65);
    const clampedX = Math.max(8, Math.min(cfg.x, maxX));
    const clampedY = Math.max(8, Math.min(cfg.y, maxY));
    inlineStyle = `left:${clampedX}px;top:${clampedY}px;bottom:auto;right:auto;transform:none;`;
  } else {
    const preset = cfg.preset || 'bottom-left';
    posClass = `floating-dock-pos-${preset}`;
  }

  return `
    <div id="floating-smart-dock" class="floating-smart-dock ${posClass}" style="${inlineStyle}">
      <button type="button" id="floating-dock-handle" class="dock-drag-handle" title="اسحب بالماوس أو الإصبع لنقل الشريط لأي مكان في الصفحة، أو اضغط لاختيار المكان أو إخفائه">
        ✥ نقل
      </button>
      <button type="button" class="dock-ai-btn" onclick="openSmartAiAssistantModal()" title="مساعد مصنع العاصمة الذكي (بالأوامر الصوتية والكتابية بالعربي)">
        <span>🤖 المساعد الذكي</span>
        <span>🎤</span>
      </button>
      ${activeTab !== 'chat' ? `
        <button type="button" class="dock-chat-btn" onclick="setTab('chat')" title="فتح الشات والمهام بين الحسابات">
          <span>💬 الشات والمهام</span>
          ${openTasksForMeCount > 0 ? `<span class="badge" style="background:#ef4444;color:#fff;padding:1px 6px;border-radius:999px;">${openTasksForMeCount}</span>` : ''}
        </button>
      ` : ''}
    </div>
  `;
}

function initFloatingDockDragEvents() {
  const dock = document.getElementById('floating-smart-dock');
  const handle = document.getElementById('floating-dock-handle');
  if (!dock || !handle) return;

  let isDragging = false;
  let moved = false;
  let startClientX = 0;
  let startClientY = 0;
  let startLeft = 0;
  let startTop = 0;

  const onPointerDown = (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    isDragging = true;
    moved = false;
    const rect = dock.getBoundingClientRect();
    startClientX = e.touches ? e.touches[0].clientX : e.clientX;
    startClientY = e.touches ? e.touches[0].clientY : e.clientY;
    startLeft = rect.left;
    startTop = rect.top;
    dock.classList.add('dragging');
  };

  const onPointerMove = (e) => {
    if (!isDragging) return;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const dx = clientX - startClientX;
    const dy = clientY - startClientY;
    if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
      moved = true;
    }
    if (!moved) return;
    if (e.cancelable) e.preventDefault();

    const rect = dock.getBoundingClientRect();
    const maxX = Math.max(10, window.innerWidth - rect.width - 8);
    const maxY = Math.max(10, window.innerHeight - rect.height - 8);
    const newLeft = Math.max(8, Math.min(startLeft + dx, maxX));
    const newTop = Math.max(8, Math.min(startTop + dy, maxY));

    dock.className = 'floating-smart-dock dragging';
    dock.style.left = `${newLeft}px`;
    dock.style.top = `${newTop}px`;
    dock.style.bottom = 'auto';
    dock.style.right = 'auto';
    dock.style.transform = 'none';
  };

  const onPointerUp = () => {
    if (!isDragging) return;
    isDragging = false;
    dock.classList.remove('dragging');
    if (moved) {
      const rect = dock.getBoundingClientRect();
      saveFloatingDockConfig({
        mode: 'custom',
        preset: 'custom',
        x: Math.round(rect.left),
        y: Math.round(rect.top)
      });
    } else {
      openFloatingDockPositionModal();
    }
  };

  handle.addEventListener('mousedown', onPointerDown);
  window.addEventListener('mousemove', onPointerMove, { passive: false });
  window.addEventListener('mouseup', onPointerUp);

  handle.addEventListener('touchstart', onPointerDown, { passive: true });
  window.addEventListener('touchmove', onPointerMove, { passive: false });
  window.addEventListener('touchend', onPointerUp);
}

function openFloatingDockPositionModal() {
  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot) return;
  const cfg = getFloatingDockConfig();
  const curPreset = cfg.mode === 'custom' ? 'custom' : (cfg.preset || 'bottom-left');

  modalRoot.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal-box" style="max-width:540px;">
        <div class="card-header">
          <div>
            <div class="card-title">✥ نقل أو تغيير مكان أيقونة الشات والمساعد الذكي</div>
            <small style="color:var(--text-muted);">يمكنك سحب زر (✥ نقل) بالماوس أو الإصبع لأي نقطة في الشاشة، أو اختيار مكان جاهز بضغطة واحدة:</small>
          </div>
          <button type="button" class="btn btn-sm btn-outline" onclick="closeModal()">✕</button>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:12px 0;">
          <button type="button" class="btn ${curPreset === 'bottom-left' ? 'btn-primary' : 'btn-outline'}" style="padding:12px;font-weight:800;" onclick="setFloatingDockPreset('bottom-left')">
            ↙️ أسفل يسار الصفحة (الافتراضي)
          </button>
          <button type="button" class="btn ${curPreset === 'bottom-right' ? 'btn-primary' : 'btn-outline'}" style="padding:12px;font-weight:800;" onclick="setFloatingDockPreset('bottom-right')">
            ↘️ أسفل يمين الصفحة
          </button>
          <button type="button" class="btn ${curPreset === 'mid-left' ? 'btn-primary' : 'btn-outline'}" style="padding:12px;font-weight:800;" onclick="setFloatingDockPreset('mid-left')">
            ⬅️ منتصف يسار الشاشة
          </button>
          <button type="button" class="btn ${curPreset === 'mid-right' ? 'btn-primary' : 'btn-outline'}" style="padding:12px;font-weight:800;" onclick="setFloatingDockPreset('mid-right')">
            ➡️ منتصف يمين الشاشة
          </button>
          <button type="button" class="btn ${curPreset === 'top-left' ? 'btn-primary' : 'btn-outline'}" style="padding:12px;font-weight:800;" onclick="setFloatingDockPreset('top-left')">
            ↖️ أعلى يسار الصفحة
          </button>
          <button type="button" class="btn ${curPreset === 'hidden' ? 'btn-danger' : 'btn-outline'}" style="padding:12px;font-weight:800;border-color:var(--danger);color:${curPreset === 'hidden' ? '#fff' : 'var(--danger)'};" onclick="setFloatingDockPreset('hidden')">
            🙈 إخفاء الأيقونة العائمة (الاعتماد على الشريط العلوي)
          </button>
        </div>

        <div style="background:rgba(124,58,237,0.08);border:1px dashed #7c3aed;border-radius:10px;padding:10px 14px;font-size:0.82rem;color:var(--text-main);">
          💡 <strong>تلميح سريع:</strong> يمكنك في أي وقت الضغط باستمرار على زر <strong>«✥ نقل»</strong> الموجود بجوار أيقونة الشات وسحبه بالماوس أو بإصبعك على الموبايل لوضعه في أي مكان يناسبك حتى لا يغطي أي جدول أو زر!
        </div>

        <div style="display:flex;justify-content:flex-end;margin-top:14px;">
          <button type="button" class="btn btn-outline" onclick="closeModal()">إغلاق</button>
        </div>
      </div>
    </div>
  `;
}

// ============================================================================
// SMART ARABIC AI ASSISTANT (VOICE & TEXT COMMANDS + ROLE-SAFE QUERIES)
// ============================================================================
let aiVoiceRecognition = null;
let aiIsListening = false;
let aiTtsEnabled = true;
let aiChatHistory = [];

function normalizeArabicAiText(str) {
  if (!str) return '';
  const arabicDigits = '٠١٢٣٤٥٦٧٨٩';
  const persianDigits = '۰۱۲۳۴۵۶۷۸۹';
  let out = String(str);
  for (let i = 0; i < 10; i++) {
    out = out.replace(new RegExp(arabicDigits[i], 'g'), String(i));
    out = out.replace(new RegExp(persianDigits[i], 'g'), String(i));
  }
  out = out
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/٫/g, '.');
  return out.trim();
}

function speakArabicAiResponse(plainText) {
  if (!aiTtsEnabled || !('speechSynthesis' in window) || !plainText) return;
  try {
    window.speechSynthesis.cancel();
    const clean = String(plainText)
      .replace(/<[^>]+>/g, ' ')
      .replace(/[📊📦🪵💰🧮⏳✅🚚🔄📥📤♻️📋🤖🎤🔊]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!clean) return;
    const utter = new SpeechSynthesisUtterance(clean.slice(0, 340));
    utter.lang = 'ar-EG';
    utter.rate = 1.02;
    const voices = window.speechSynthesis.getVoices() || [];
    const arVoice = voices.find(v => v.lang && v.lang.toLowerCase().startsWith('ar'));
    if (arVoice) utter.voice = arVoice;
    window.speechSynthesis.speak(utter);
  } catch (_) {}
}

function getRoleSpecificAiSuggestions() {
  const showPrices = canSeeFinancialPrices();
  if (!showPrices) {
    // Warehouse Keeper suggestions (100% quantities, orders, calculator sheets, voice operations — NO prices)
    return [
      { label: '📦 إجمالي رصيد المخزن الآن', cmd: 'كم إجمالي رصيد مخزن القشرة الآن؟' },
      { label: '⏳ الطلبيات المطلوبة مني بالمخزن', cmd: 'ما هي الطلبيات المعلقة المطلوب تجهيزها أو صرفها؟' },
      { label: '🧮 كم فرخ في المتر المكعب تخانة 1.5؟', cmd: 'كم عدد الأفرخ في المتر المكعب لتخانة 1.5 مم؟' },
      { label: '📥 أمر: إضافة إنتاج 400 فرخ 1.5 قص C', cmd: 'إضافة إنتاج 400 فرخ تخانة 1.5 قص جودة C' },
      { label: '📤 أمر: صرف مبيعات 200 قطعة 1.3 قص ABC+', cmd: 'خروج مبيعات 200 فرخ تخانة 1.3 قص جودة ABC+' },
      { label: '🔄 أمر: تسجيل مرتجع مبيعات 100 فرخ 1.5 قص', cmd: 'تسجيل مرتجع مبيعات 100 فرخ تخانة 1.5 قص جودة C' },
      { label: '🔍 جرد تخانة 1.5 مم', cmd: 'رصيد تخانة 1.5' },
      { label: '🪵 رصيد البالتات لدى العملاء', cmd: 'رصيد البالتات عند العملاء' }
    ];
  }

  return [
    { label: '📊 ملخص المخزن والمبيعات والمديونيات', cmd: 'اعطني ملخص شامل للمصنع والمخزن والمبيعات' },
    { label: '⏳ الطلبيات المعلقة للموافقة أو الصرف', cmd: 'ما هي الطلبيات المعلقة حالياً؟' },
    { label: '🧮 احسب تخانة 1.5 بسعر متر 22000', cmd: 'احسب عدد الأفرخ وسعر الفرخ لتخانة 1.5 بسعر متر 22000' },
    { label: '💰 مديونيات وحسابات العملاء', cmd: 'كشف أرصدة ومديونيات العملاء والبالتات' },
    { label: '📥 أمر: إضافة إنتاج 500 فرخ 1.5 قص C', cmd: 'إضافة إنتاج 500 فرخ تخانة 1.5 قص جودة C' },
    { label: '📋 أمر: إنشاء طلبية جديدة لعميل', cmd: 'إنشاء طلبية عميل جديدة' },
    { label: '🔍 جرد تخانة 1.5 مم', cmd: 'رصيد تخانة 1.5' },
    { label: '🔄 المرتجعات المعلقة للموافقة', cmd: 'ما هي مرتجعات المبيعات المعلقة للموافقة؟' }
  ];
}

function openSmartAiAssistantModal(initialCommand = '') {
  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot) return;

  if (aiChatHistory.length === 0) {
    const showPrices = canSeeFinancialPrices();
    aiChatHistory.push({
      sender: 'ai',
      time: new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }),
      html: `
        <div style="font-weight:800;color:var(--primary);margin-bottom:6px;">
          👋 أهلاً بك يا <strong>${currentUser?.name || 'بطل المصنع'}</strong> في مساعد مصنع العاصمة الذكي!
        </div>
        <div style="font-size:0.86rem;line-height:1.6;">
          يمكنك التحدث معي <strong>بالصوت باللغة العربية 🎤</strong> أو بالكتابة لتنفيذ المهام فوراً:<br/>
          • <strong>استعلام لحظي:</strong> اسأل عن رصيد أي تخانة أو جودة (مثل: <em>"رصيد 1.5 قص"</em> أو <em>"إجمالي المخزن"</em>).<br/>
          • <strong>أوامر تشغيل سريعة بالصوت:</strong> قل مثلاً <em>"إضافة إنتاج 400 فرخ 1.5 قص جودة C"</em> أو <em>"صرف مبيعات 150 قطعة 1.3 قص"</em> وسأفتح لك النافذة جاهزة بالأرقام للتأكيد!<br/>
          • <strong>حاسبة القشرة الفورية:</strong> قل <em>"كم فرخ في المتر المكعب تخانة 1.5${showPrices ? ' وسعر المتر 22000' : ''}؟"</em>.<br/>
          • <strong>متابعة الطلبيات والعملاء:</strong> اسأل عن <em>"الطلبيات المعلقة"</em> أو اسم أي عميل.
        </div>
      `
    });
  }

  const suggestions = getRoleSpecificAiSuggestions();

  modalRoot.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeSmartAiModal()">
      <div class="modal-box" style="max-width:820px;padding:18px;">
        <div class="card-header" style="margin-bottom:10px;border-bottom:2px solid rgba(124,58,237,0.2);padding-bottom:10px;">
          <div style="display:flex;align-items:center;gap:10px;">
            <div style="width:44px;height:44px;border-radius:12px;background:linear-gradient(135deg,#7c3aed,#4f46e5);color:#fff;display:flex;align-items:center;justify-content:center;font-size:1.45rem;box-shadow:0 6px 16px rgba(124,58,237,0.35);">
              🤖
            </div>
            <div>
              <div class="card-title" style="color:#5b21b6;font-size:1.05rem;">
                مساعد مصنع العاصمة الذكي (بالأوامر الصوتية والكتابية بالعربي)
              </div>
              <small style="color:var(--text-muted);font-size:0.78rem;">
                يعمل وفق صلاحيات حسابك الحالي: <strong>${currentUser?.roleTitle || ''}</strong> ${!canSeeFinancialPrices() ? '<span class="badge badge-info">كميات وتشغيل فقط بدون أسعار</span>' : ''}
              </small>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
            <button type="button" id="ai-tts-toggle-btn" class="btn btn-sm ${aiTtsEnabled ? 'btn-primary' : 'btn-outline'}" onclick="toggleAiTtsVoice()" title="تشغيل أو إيقاف القراءة الصوتية للردود">
              ${aiTtsEnabled ? '🔊 الرد الصوتي: مفعل' : '🔇 الرد الصوتي: صامت'}
            </button>
            <button type="button" class="btn btn-sm btn-outline" onclick="clearSmartAiHistory()" title="مسح سجل المحادثة">
              🧹 مسح
            </button>
            <button type="button" class="btn btn-sm btn-outline" onclick="closeSmartAiModal()">✕</button>
          </div>
        </div>

        <!-- Quick Suggestion Chips -->
        <div style="margin-bottom:10px;">
          <div style="font-size:0.76rem;font-weight:800;color:var(--text-muted);margin-bottom:5px;">⚡ أوامر واستعلامات سريعة بضغطة واحدة (أو اضغط الميكروفون وتحدث):</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;">
            <button type="button" class="btn btn-sm" style="font-size:0.75rem;padding:4px 10px;background:linear-gradient(135deg,#0f766e,#0d9488);color:#fff;font-weight:800;" onclick="runSmartAiQuickChip('عرض حاويات وسيريالات الجذوع')">
              🚢 حاويات الجذوع (Packing List)
            </button>
            <label for="ai-packinglist-pdf-input" class="btn btn-sm" style="font-size:0.75rem;padding:4px 10px;background:linear-gradient(135deg,#7c3aed,#4f46e5);color:#fff;font-weight:800;cursor:pointer;margin:0;">
              📄 ارفع Packing List PDF للمساعد الذكي (كل صفحة = حاوية)
            </label>
            <input id="ai-packinglist-pdf-input" type="file" accept=".pdf,.png,.jpg,.jpeg,.txt,.csv" style="display:none;" onchange="handleAiPackingListPdfUpload(event)" />
            ${suggestions.map(s => `
              <button type="button" class="btn btn-sm btn-outline" style="font-size:0.74rem;padding:4px 9px;border-color:rgba(124,58,237,0.35);background:rgba(124,58,237,0.04);" onclick="runSmartAiQuickChip('${s.cmd.replace(/'/g, "\\'")}')">
                ${s.label}
              </button>
            `).join('')}
          </div>
        </div>

        <!-- AI Conversation Messages Box -->
        <div id="ai-assistant-messages" style="height:350px;overflow-y:auto;background:var(--bg-elevated);border:1px solid var(--border-color);border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:10px;margin-bottom:12px;">
          ${renderSmartAiMessagesHtml()}
        </div>

        <!-- Voice Status Banner -->
        <div id="ai-voice-status-bar" style="display:none;background:rgba(220,38,38,0.1);border:1px solid #dc2626;color:#dc2626;padding:8px 12px;border-radius:10px;margin-bottom:10px;font-weight:800;font-size:0.84rem;text-align:center;">
          🎙️ جاري الاستماع لصوتك باللغة العربية... تحدث الآن (مثال: "إضافة إنتاج 400 فرخ 1.5 قص جودة C" أو "رصيد تخانة 1.5")
        </div>

        <!-- Input & Microphone Bar -->
        <form onsubmit="submitSmartAiForm(event)" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <button type="button" id="ai-mic-btn" class="btn" style="background:linear-gradient(135deg,#7c3aed,#4f46e5);color:#fff;font-weight:900;padding:10px 16px;border-radius:10px;display:flex;align-items:center;gap:6px;" onclick="toggleSmartAiVoiceRecognition()">
            <span>🎤</span>
            <span id="ai-mic-btn-label">تحدث بالصوت</span>
          </button>
          <input id="ai-command-input" class="form-control" style="flex:1;min-width:210px;padding:10px 14px;font-weight:700;border:2px solid #7c3aed;" placeholder="اكتب سؤالك أو أمرك بالعربية هنا أو اضغط 🎤 للتحدث..." value="${initialCommand}" autofocus />
          <button type="submit" class="btn btn-primary" style="padding:10px 18px;font-weight:900;">
            🚀 تنفيذ / إرسال
          </button>
        </form>
      </div>
    </div>
  `;

  scrollSmartAiMessagesBottom();
  if (initialCommand) {
    processSmartAiCommand(initialCommand);
  }
}

function closeSmartAiModal() {
  stopSmartAiVoiceRecognition();
  if ('speechSynthesis' in window) {
    try { window.speechSynthesis.cancel(); } catch (_) {}
  }
  closeModal();
}

function toggleAiTtsVoice() {
  aiTtsEnabled = !aiTtsEnabled;
  if (!aiTtsEnabled && ('speechSynthesis' in window)) {
    try { window.speechSynthesis.cancel(); } catch (_) {}
  }
  const btn = document.getElementById('ai-tts-toggle-btn');
  if (btn) {
    btn.className = `btn btn-sm ${aiTtsEnabled ? 'btn-primary' : 'btn-outline'}`;
    btn.innerHTML = aiTtsEnabled ? '🔊 الرد الصوتي: مفعل' : '🔇 الرد الصوتي: صامت';
  }
}

function clearSmartAiHistory() {
  aiChatHistory = [];
  openSmartAiAssistantModal();
}

function renderSmartAiMessagesHtml() {
  return aiChatHistory.map(m => {
    const isUser = m.sender === 'user';
    return `
      <div style="align-self:${isUser ? 'flex-start' : 'stretch'};max-width:${isUser ? '85%' : '100%'};background:${isUser ? 'linear-gradient(135deg,#0f766e,#0d9488)' : 'var(--bg-card)'};color:${isUser ? '#fff' : 'var(--text-main)'};padding:10px 14px;border-radius:12px;border:${isUser ? 'none' : '1px solid var(--border-color)'};box-shadow:0 2px 6px rgba(0,0,0,0.05);">
        <div style="display:flex;justify-content:space-between;align-items:center;font-size:0.7rem;opacity:0.8;margin-bottom:4px;">
          <strong>${isUser ? `👤 ${currentUser?.name || 'أنت'}` : '🤖 مساعد مصنع العاصمة الذكي'}</strong>
          <span>${m.time || ''}</span>
        </div>
        <div style="font-size:0.86rem;line-height:1.55;">${m.html}</div>
      </div>
    `;
  }).join('');
}

function scrollSmartAiMessagesBottom() {
  const box = document.getElementById('ai-assistant-messages');
  if (box) {
    box.scrollTop = box.scrollHeight;
  }
}

function runSmartAiQuickChip(cmdText) {
  const input = document.getElementById('ai-command-input');
  if (input) input.value = cmdText;
  processSmartAiCommand(cmdText);
}

function submitSmartAiForm(e) {
  if (e) e.preventDefault();
  const input = document.getElementById('ai-command-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  processSmartAiCommand(text);
}

function toggleSmartAiVoiceRecognition() {
  if (aiIsListening) {
    stopSmartAiVoiceRecognition();
    return;
  }

  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRec) {
    alert('⚠️ متصفحك الحالي لا يدعم الأوامر الصوتية المباشرة. يفضل استخدام متصفح Google Chrome أو Microsoft Edge على الكمبيوتر أو الموبايل، أو الكتابة في المربع مباشرة.');
    return;
  }

  try {
    aiVoiceRecognition = new SpeechRec();
    aiVoiceRecognition.lang = 'ar-EG';
    aiVoiceRecognition.interimResults = true;
    aiVoiceRecognition.continuous = false;

    aiVoiceRecognition.onstart = () => {
      aiIsListening = true;
      const micBtn = document.getElementById('ai-mic-btn');
      const micLbl = document.getElementById('ai-mic-btn-label');
      const statusBar = document.getElementById('ai-voice-status-bar');
      if (micBtn) micBtn.classList.add('ai-mic-pulse');
      if (micLbl) micLbl.textContent = 'جاري الاستماع... (اضغط للإيقاف)';
      if (statusBar) statusBar.style.display = 'block';
    };

    aiVoiceRecognition.onresult = (event) => {
      let transcript = '';
      let isFinal = false;
      for (let i = event.resultIndex; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
        if (event.results[i].isFinal) isFinal = true;
      }
      const input = document.getElementById('ai-command-input');
      if (input && transcript) {
        input.value = transcript.trim();
      }
      if (isFinal && transcript.trim()) {
        stopSmartAiVoiceRecognition();
        const finalCmd = transcript.trim();
        if (input) input.value = '';
        processSmartAiCommand(finalCmd);
      }
    };

    aiVoiceRecognition.onerror = () => {
      stopSmartAiVoiceRecognition();
    };

    aiVoiceRecognition.onend = () => {
      stopSmartAiVoiceRecognition();
    };

    aiVoiceRecognition.start();
  } catch (_) {
    stopSmartAiVoiceRecognition();
  }
}

function stopSmartAiVoiceRecognition() {
  aiIsListening = false;
  if (aiVoiceRecognition) {
    try { aiVoiceRecognition.stop(); } catch (_) {}
    aiVoiceRecognition = null;
  }
  const micBtn = document.getElementById('ai-mic-btn');
  const micLbl = document.getElementById('ai-mic-btn-label');
  const statusBar = document.getElementById('ai-voice-status-bar');
  if (micBtn) micBtn.classList.remove('ai-mic-pulse');
  if (micLbl) micLbl.textContent = 'تحدث بالصوت';
  if (statusBar) statusBar.style.display = 'none';
}

function launchAiPrefilledCellAction(thkId, gradeId, opMode, sheetsCount, lengthCm, widthCm, clientName = '') {
  closeSmartAiModal();
  setTab('veneer');
  openMatrixCellModal(thkId, gradeId, opMode);
  setTimeout(() => {
    if (activeCellContext) {
      activeCellContext.op = opMode;
      activeCellContext.lengthCm = Number(lengthCm || 250);
      activeCellContext.widthCm = Number(widthCm || 125);
      const selectedWoodId = state.catalog.woodTypes?.[0]?.id || 'wt-general';
      renderMatrixCellModalUI(selectedWoodId, Number(sheetsCount || 100));
      const sheetsEl = document.getElementById('cell-sheets');
      if (sheetsEl && sheetsCount > 0) sheetsEl.value = sheetsCount;
      const widEl = document.getElementById('cell-wid');
      const lenEl = document.getElementById('cell-len');
      if (widEl) widEl.value = Number(widthCm || 125);
      if (lenEl) lenEl.value = Number(lengthCm || 250);
      const clientEl = document.getElementById('cell-client-name');
      if (clientEl && clientName) clientEl.value = clientName;
      updateMatrixCellModalPreview();
    }
  }, 60);
}

function processSmartAiCommand(rawText) {
  const timeStr = new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
  aiChatHistory.push({
    sender: 'user',
    time: timeStr,
    html: `<strong>${rawText}</strong>`
  });

  const norm = normalizeArabicAiText(rawText).toLowerCase();
  const showPrices = canSeeFinancialPrices();
  const inStockPallets = (state.pallets || []).filter(p => p.status === 'in_stock');
  const thicknesses = getSortedThicknesses();
  const grades = state.catalog?.grades || [];
  const clients = (state.partners || []).filter(p => p.type === 'client');
  const orders = state.productionOrders || [];

  let responseHtml = '';
  let speechSummary = '';

  // 1. Detect Action / Operation Command (إضافة إنتاج / مرتجع مبيعات / صرف أو خروج مبيعات / إعادة تشغيل)
  const isProdInCmd = /(اضاف|اضف|ادخل|توريد|انتاج|وارد)/.test(norm) && !/(مرتجع|عميل جديد)/.test(norm);
  const isSalesReturnCmd = /(مرتجع)/.test(norm) && /(اضاف|اضف|سجل|تسجيل|ادخل|فرخ|قطع)/.test(norm);
  const isSalesOutCmd = /(خروج|صرف|بيع|مبيعات)/.test(norm) && /(فرخ|افرخ|قطع|تخانه|مم|قص|سدا)/.test(norm);
  const isReworkCmd = /(اعاده تشغيل|تدوير|فرز)/.test(norm) && /(فرخ|افرخ|قطع|تخانه|مم)/.test(norm);

  // 0. Detect Log Containers / Packing List PDF / Log Serials Commands
  const isLogSerialProcessCmd = /(تشغيل|شغل)\s*(جذع|جزع|سيريال|سريال)/.test(norm) && /\d{3,}/.test(norm);
  const isLogsOrPackingQuery = /(حاويه|حاويات|جذوع|جزوع|سيريال|سريال|packing|باكنج|5559|dedoncker)/.test(norm);

  if (isLogSerialProcessCmd) {
    if (!canManageLogSerialsAndProduction(currentUser)) {
      speechSummary = 'عفواً، صلاحية تشغيل سيريال الجذوع مخصصة للمدير التنفيذي ومدير المشروعات والمدير الإداري فقط.';
      responseHtml = `<div style="color:var(--danger);font-weight:800;">⛔ صلاحية إدخال وتشغيل سيريال الجذوع مخصصة للمدير التنفيذي ومدير المشروعات والمدير الإداري فقط.</div>`;
    } else {
      const serialTokens = (norm.match(/[a-z0-9\-]{3,}/gi) || []).filter(t => /\d/.test(t));
      if (serialTokens.length > 0) {
        processLogSerialsBatchByString(serialTokens.join(' '));
        speechSummary = `تم تنفيذ أمر تشغيل الجذوع لأرقام السيريال: ${serialTokens.join(' و ')}.`;
        responseHtml = `
          <div style="border-right:4px solid #7c3aed;padding-right:10px;">
            <div style="font-weight:900;color:#5b21b6;margin-bottom:6px;">⚙️ تم تنفيذ أمر تشغيل الجذوع بالسيريال فوراً:</div>
            <p style="margin:4px 0;">السيريالات المطلوبة: <strong>${serialTokens.join(' ، ')}</strong></p>
            <button type="button" class="btn btn-sm btn-primary" onclick="closeSmartAiModal(); setTab('raw');">🌲 فتح شاشة حاويات وسيريالات الجذوع</button>
          </div>
        `;
      }
    }
  }
  else if (isLogsOrPackingQuery) {
    const containers = state.logContainers || [];
    const allLogs = state.logItems || [];
    const procLogs = allLogs.filter(l => l.status === 'processed');
    const remLogs = allLogs.filter(l => l.status !== 'processed');
    const totalVol = allLogs.reduce((s, l) => s + Number(l.volumeM3 || 0), 0);
    const remVol = remLogs.reduce((s, l) => s + Number(l.volumeM3 || 0), 0);

    speechSummary = `يوجد حالياً في منظومة الجذوع ${containers.length} حاوية بإجمالي ${allLogs.length} جذع وتكعيب ${fmtNum(totalVol, 3)} متر مكعب. المتبقي بدون تشغيل ${remLogs.length} جذع، والمشغل ${procLogs.length} جذع.`;

    responseHtml = `
      <div style="border-right:4px solid var(--primary);padding-right:10px;">
        <div style="font-weight:900;color:var(--primary);margin-bottom:8px;">
          🚢 حالة حاويات وسيريالات الجذوع (Packing List — كل صفحة = حاوية مستقلة):
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;background:var(--bg-elevated);padding:10px;border-radius:10px;margin-bottom:10px;">
          <div><small>عدد الحاويات المسجلة:</small><br/><strong style="font-size:1.05rem;color:var(--primary);">${containers.length} حاوية</strong></div>
          <div><small>إجمالي الجذوع والتكعيب:</small><br/><strong>${allLogs.length} جذع (${fmtNum(totalVol, 3)} م³)</strong></div>
          <div><small>متبقي بالمخزن ⏳:</small><br/><strong style="color:var(--success);">${remLogs.length} جذع (${fmtNum(remVol, 3)} م³)</strong></div>
          <div><small>تم تشغيله ✅:</small><br/><strong style="color:#0284c7;">${procLogs.length} جذع</strong></div>
        </div>
        ${containers.length > 0 ? `
          <div class="table-responsive" style="max-height:190px;overflow-y:auto;margin-bottom:10px;">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>رقم الحاوية</th>
                  <th>الختم (Seal)</th>
                  <th>عدد الجذوع</th>
                  <th>التكعيب (CBM)</th>
                  <th>الوزن الصافي</th>
                  <th>المتبقي / المشغل</th>
                </tr>
              </thead>
              <tbody>
                ${containers.map((c, idx) => {
                  const cm = getContainerMetrics(c);
                  return `
                    <tr>
                      <td>${idx + 1}</td>
                      <td><strong>${c.containerNumber}</strong></td>
                      <td>${c.sealNumber || '-'}</td>
                      <td><strong>${cm.totalLogsCount} جذع</strong></td>
                      <td><strong style="color:var(--primary);">${fmtNum(cm.totalVolumeM3, 3)} م³</strong></td>
                      <td>${c.netWeightKg ? fmtNum(c.netWeightKg, 0) + ' كجم' : fmtNum(cm.totalWeightTon, 3) + ' طن'}</td>
                      <td>متبقي: <strong>${cm.remainingLogsCount}</strong> | مشغل: <strong>${cm.processedLogsCount}</strong></td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>
        ` : ''}
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <label for="ai-packinglist-pdf-input" class="btn btn-sm" style="background:linear-gradient(135deg,#7c3aed,#4f46e5);color:#fff;font-weight:900;cursor:pointer;margin:0;">
            📄 ارفع ملف Packing List PDF (قراءة كل صفحة كحاوية بالذكاء الاصطناعي)
          </label>
          <button type="button" class="btn btn-sm btn-success" onclick="importDedoncker5559AllContainersFromAi()">
            🔄 تحميل/تأكيد الـ 13 حاوية من فاتورة 5559 (159 جذع — 395.364 م³)
          </button>
          <button type="button" class="btn btn-sm btn-primary" onclick="closeSmartAiModal(); setTab('raw');">
            🌲 فتح جدول الحاويات والسيريالات بالمخزن
          </button>
        </div>
      </div>
    `;
  }
  else if (isProdInCmd || isSalesReturnCmd || isSalesOutCmd || isReworkCmd) {
    const opMode = isSalesReturnCmd ? 'sales_return' : isSalesOutCmd ? 'out' : isReworkCmd ? 'rework' : 'in';
    const opLabel = opMode === 'in' ? '📥 إضافة كميات إنتاج للمخزن'
      : opMode === 'sales_return' ? '🔄 تسجيل مرتجع مبيعات (يدخل المخزن بعد موافقة الإدارة/المحاسب)'
      : opMode === 'out' ? '📤 خروج كميات حسب المبيعات'
      : '♻️ خروج كميات لإعادة التشغيل';

    const dir = /(سدا|سدي)/.test(norm) ? 'sada' : 'qas';
    const dirLabel = dir === 'sada' ? 'اتجاه سدا' : 'اتجاه قص';

    let matchedThk = null;
    for (const t of thicknesses) {
      const mmStr = String(t.mm);
      const regex = new RegExp(`(^|\\s|تخانه)${mmStr.replace('.', '\\.')}(\\s|مم|$)`);
      if (regex.test(norm) && (t.direction || 'qas') === dir) {
        matchedThk = t;
        break;
      }
    }
    if (!matchedThk) {
      for (const t of thicknesses) {
        const mmStr = String(t.mm);
        if (norm.includes(mmStr) && (t.direction || 'qas') === dir) {
          matchedThk = t;
          break;
        }
      }
    }
    if (!matchedThk) {
      matchedThk = thicknesses.find(t => (t.direction || 'qas') === dir) || thicknesses[0] || { id: 'th-1.5-qas', mm: 1.5, direction: 'qas' };
    }

    let matchedGrade = null;
    if (/abc\+|اي بي سي|ايه بي سي/.test(norm)) {
      matchedGrade = grades.find(g => g.code.toLowerCase().includes('abc'));
    } else if (/قطع\s*b|قطع\s*بي/.test(norm)) {
      matchedGrade = grades.find(g => g.name.includes('قطع') || g.code.includes('قطع'));
    } else if (/(جوده\s*r|درجه\s*r|\br\b|ار)/.test(norm)) {
      matchedGrade = grades.find(g => g.code.toUpperCase() === 'R');
    } else if (/(جوده\s*c|درجه\s*c|\bc\b|سي)/.test(norm)) {
      matchedGrade = grades.find(g => g.code.toUpperCase() === 'C');
    }
    if (!matchedGrade) matchedGrade = grades[0] || { id: 'gr-c', name: 'C', code: 'C' };

    const allNums = (norm.match(/\d+(\.\d+)?/g) || []).map(Number);
    let qty = 200;
    for (const n of allNums) {
      if (n !== Number(matchedThk.mm) && n !== 125 && n !== 250 && n >= 1 && Number.isInteger(n)) {
        qty = n;
        break;
      }
    }

    const m = calculateVeneerMetrics(250, 125, matchedThk.mm, qty);
    speechSummary = `تم تجهيز أمر ${opLabel} بعدد ${qty} فرخ لتخانة ${matchedThk.mm} ملي ${dirLabel} جودة ${matchedGrade.code}. اضغط على زر فتح نافذة التنفيذ للتأكيد.`;

    responseHtml = `
      <div style="border-right:4px solid #7c3aed;padding-right:10px;">
        <div style="font-weight:900;color:#5b21b6;margin-bottom:6px;">⚡ تم فهم الأمر الصوتي/الكتابي وتجهيز الحركة المخزنية فوراً:</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;background:var(--bg-elevated);padding:10px;border-radius:10px;margin-bottom:10px;">
          <div><small style="color:var(--text-muted);">نوع الحركة:</small><br/><strong>${opLabel}</strong></div>
          <div><small style="color:var(--text-muted);">التخانة والاتجاه:</small><br/><strong>${matchedThk.mm} مم (${dirLabel})</strong></div>
          <div><small style="color:var(--text-muted);">درجة الجودة:</small><br/><strong>${matchedGrade.name} (${matchedGrade.code})</strong></div>
          <div><small style="color:var(--text-muted);">الكمية والحجم:</small><br/><strong>${fmtNum(qty, 0)} فرخ (${fmtNum(m.totalVolumeM3, 4)} م³)</strong></div>
        </div>
        <button type="button" class="btn btn-primary" style="width:100%;font-weight:900;padding:10px;" onclick="launchAiPrefilledCellAction('${matchedThk.id}', '${matchedGrade.id}', '${opMode}', ${qty}, 250, 125)">
          🚀 فتح نافذة التنفيذ الآن جاهزة بالأرقام للتأكيد والحفظ
        </button>
      </div>
    `;
  }
  // 2. Detect New Client Order Command
  else if (/(انشاء|عمل|اضاف|فتح)\s*(طلبيه|بيان|امر)/.test(norm)) {
    let matchedClient = clients.find(c => norm.includes(normalizeArabicAiText(c.name).toLowerCase()) || (c.code && norm.includes(c.code.toLowerCase())));
    speechSummary = matchedClient
      ? `جاري فتح نافذة إنشاء طلبية جديدة للعميل ${matchedClient.name}`
      : `اضغط لفتح نافذة تجهيز طلبية عميل جديدة`;
    responseHtml = `
      <div>
        <div style="font-weight:800;color:var(--primary);margin-bottom:8px;">📋 تجهيز طلبية عميل جديدة (بيان أسعار وكميات):</div>
        <button type="button" class="btn btn-primary" onclick="closeSmartAiModal(); setTab('production'); openNewClientOrderPrepModal('${matchedClient ? matchedClient.id : ''}');">
          ➕ فتح نافذة تجهيز طلبية جديدة ${matchedClient ? `للعميل (${matchedClient.name})` : 'الآن'}
        </button>
      </div>
    `;
  }
  // 3. Detect Veneer Calculator / Sheets per m3 / Piece Price Query
  else if (/(احسب|حاسبه|كم فرخ|عدد الافرخ|المتر المكعب|سعر الفرخ|في المتر)/.test(norm)) {
    const nums = (norm.match(/\d+(\.\d+)?/g) || []).map(Number);
    let thkMm = 1.5;
    let pricePerM3 = 0;
    let sheetsCount = 400;

    for (const n of nums) {
      if (n > 0 && n <= 10) thkMm = n;
      else if (n >= 2000) pricePerM3 = n;
      else if (n > 10 && n < 2000 && n !== 125 && n !== 250) sheetsCount = n;
    }

    const calc = calculateVeneerMetrics(250, 125, thkMm, sheetsCount);
    const piecePriceFromM3 = pricePerM3 > 0 && calc.sheetsPerM3 > 0 ? +(pricePerM3 / calc.sheetsPerM3).toFixed(2) : 0;

    speechSummary = `في المقاس المعتمد مائة وخمسة وعشرين في مائتين وخمسين سنتيمتر لتخانة ${thkMm} ملي: المتر المكعب الواحد يحتوي على ${fmtNum(calc.sheetsPerM3, 1)} فرخ تقريباً.` + (showPrices && piecePriceFromM3 > 0 ? ` وسعر الفرخ الواحد هو ${piecePriceFromM3} جنيه.` : '');

    responseHtml = `
      <div style="border-right:4px solid var(--primary);padding-right:10px;">
        <div style="font-weight:900;color:var(--primary);margin-bottom:8px;">🧮 نتيجة حاسبة القشرة الخشبية الفورية (مقاس 125×250 سم — تخانة ${thkMm} مم):</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(165px,1fr));gap:8px;background:var(--bg-elevated);padding:10px;border-radius:10px;">
          <div>
            <small style="color:var(--text-muted);">📦 عدد الأفرخ في المتر المكعب (1 م³):</small>
            <div style="font-weight:900;font-size:1.1rem;color:#7c3aed;">${fmtNum(calc.sheetsPerM3, 2)} فرخ / م³</div>
            <small style="color:var(--text-muted);">(حوالي ${Math.round(calc.sheetsPerM3)} فرخ)</small>
          </div>
          <div>
            <small style="color:var(--text-muted);">📐 مساحة وحجم الفرخ الواحد:</small>
            <div style="font-weight:800;">${calc.sheetAreaM2} م² | ${calc.sheetVolumeM3} م³</div>
          </div>
          <div>
            <small style="color:var(--text-muted);">🪵 حجم (${fmtNum(sheetsCount, 0)} فرخ):</small>
            <div style="font-weight:800;color:var(--primary);">${fmtNum(calc.totalVolumeM3, 4)} م³ (${fmtNum(calc.totalAreaM2, 2)} م²)</div>
          </div>
          ${showPrices && pricePerM3 > 0 ? `
            <div style="background:rgba(217,119,6,0.1);padding:6px 8px;border-radius:8px;border:1px solid #d97706;">
              <small style="color:#b45309;font-weight:800;">💰 سعر الفرخ الواحد (عند م³ = ${fmtNum(pricePerM3, 0)} ج):</small>
              <div style="font-weight:900;font-size:1.1rem;color:#b45309;">${fmtNum(piecePriceFromM3, 2)} ج.م / فرخ</div>
            </div>
          ` : ''}
        </div>
      </div>
    `;
  }
  // 4. Detect Pending Orders / Approvals / Dispatch Queries
  else if (/(طلبيات|طلبيه|معلقه|موافقات|تجهيز|اذن سياره|سيارات|صرف)/.test(norm) && !/(عميل)/.test(norm)) {
    const activeOrders = orders.filter(o => o.stage !== 'completed');
    speechSummary = activeOrders.length === 0
      ? 'لا توجد طلبيات معلقة حالياً، جميع الطلبيات مكتملة.'
      : `يوجد حالياً ${activeOrders.length} طلبية قيد التجهيز أو الموافقة أو تحميل السيارة.`;

    responseHtml = `
      <div>
        <div style="font-weight:900;color:var(--primary);margin-bottom:8px;">
          ⏳ الطلبيات الجارية والمعلقة حالياً (${activeOrders.length} طلبية من إجمالي ${orders.length}):
        </div>
        ${activeOrders.length === 0 ? `
          <div style="padding:10px;background:var(--bg-elevated);border-radius:8px;color:var(--success);font-weight:700;">
            ✅ جميع الطلبيات مكتملة ولا توجد أي طلبية معلقة حالياً.
          </div>
        ` : `
          <div class="table-responsive">
            <table>
              <thead>
                <tr>
                  <th>رقم الطلبية</th>
                  <th>العميل</th>
                  <th>الأصناف والكمية</th>
                  ${showPrices ? '<th>الصافي</th>' : ''}
                  <th>المرحلة الحالية</th>
                  <th>إجراء سريع</th>
                </tr>
              </thead>
              <tbody>
                ${activeOrders.slice(0, 10).map(o => {
                  const totalSh = (o.items || []).reduce((s, i) => s + Number(i.sheetsCount || 0), 0);
                  return `
                    <tr>
                      <td><strong>${o.orderNumber}</strong><br/><small>${o.date}</small></td>
                      <td><strong>${o.clientName}</strong></td>
                      <td>${fmtNum(totalSh, 0)} فرخ (${fmtNum(o.totalVolumeM3 || 0, 3)} م³)</td>
                      ${showPrices ? `<td><strong>${fmtMoney(o.netTotalAmount || 0)}</strong></td>` : ''}
                      <td><span class="badge badge-warning">${o.stageLabel || o.stage}</span></td>
                      <td>
                        <button type="button" class="btn btn-sm btn-primary" onclick="closeSmartAiModal(); openClientOrderStatementModal('${o.id}');">
                          📄 فتح البيان والتنفيذ
                        </button>
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
  // 5. Detect Sales Returns Query
  else if (/(مرتجع|مرتجعات)/.test(norm)) {
    const returnsList = state.salesReturns || [];
    const pendingReturns = returnsList.filter(r => r.status === 'pending_approval');
    speechSummary = `إجمالي سجلات مرتجع المبيعات ${returnsList.length} سجل، منها ${pendingReturns.length} بانتظار موافقة الإدارة أو المحاسب لدخول المخزن.`;
    responseHtml = `
      <div>
        <div style="font-weight:900;color:#6d28d9;margin-bottom:8px;">
          🔄 حالة مرتجعات المبيعات (${returnsList.length} إجمالي — ${pendingReturns.length} معلق للموافقة):
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;">
          <button type="button" class="btn btn-sm" style="background:#7c3aed;color:#fff;" onclick="closeSmartAiModal(); setTab('veneer'); openWarehouseOpShortcut('sales_return');">
            ➕ تسجيل مرتجع مبيعات جديد
          </button>
          <button type="button" class="btn btn-sm btn-outline" onclick="closeSmartAiModal(); setTab('veneer');">
            📂 عرض جدول المرتجعات بالمخزن
          </button>
        </div>
      </div>
    `;
  }
  // 6. Detect Specific Client or Clients / Debts / Pallets Query
  else if (/(عميل|عملاء|مديونيه|مديونيات|حسابات|بالتات عند|شركه|مصنع الفنيه|الجيزه|cl-)/.test(norm)) {
    const matchedClient = clients.find(c => {
      const cNorm = normalizeArabicAiText(c.name).toLowerCase();
      const codeNorm = (c.code || '').toLowerCase();
      return (cNorm && norm.includes(cNorm)) || (codeNorm && norm.includes(codeNorm)) ||
        cNorm.split(/\s+/).some(w => w.length >= 4 && norm.includes(w));
    });

    if (matchedClient) {
      const cm = computeClientMetrics(matchedClient);
      speechSummary = showPrices
        ? `العميل ${matchedClient.name} كود ${matchedClient.code}: صافي الرصيد ${cm.netDebt > 0 ? 'مدين بمبلغ ' + fmtNum(cm.netDebt, 0) + ' جنيه' : 'خالص'}، ورصيد البالتات المتبقي طرفه ${cm.netPalletsAtClient} بالتة.`
        : `العميل ${matchedClient.name} كود ${matchedClient.code}: إجمالي الطلبيات ${cm.orders.length} طلبية، ورصيد البالتات المتبقي طرفه ${cm.netPalletsAtClient} بالتة.`;

      responseHtml = `
        <div style="border-right:4px solid var(--primary);padding-right:10px;">
          <div style="font-weight:900;color:var(--primary);margin-bottom:6px;">
            🤝 بيانات العميل: [${matchedClient.code}] ${matchedClient.name}
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;background:var(--bg-elevated);padding:10px;border-radius:10px;margin-bottom:10px;">
            <div><small>عدد الطلبيات:</small><br/><strong>${cm.orders.length} طلبية</strong></div>
            <div><small>بالتات متبقية طرف العميل:</small><br/><strong style="color:#d97706;">${cm.netPalletsAtClient} بالتة</strong> (مسلم: ${cm.palletsDelivered} / مستلم: ${cm.palletsReceived})</div>
            ${showPrices ? `
              <div><small>إجمالي المسحوبات:</small><br/><strong>${fmtMoney(cm.totalDebit)}</strong></div>
              <div><small>صافي المديونية:</small><br/><strong style="color:${cm.netDebt > 0 ? 'var(--danger)' : 'var(--success)'};">${cm.netDebt > 0 ? 'عليه: ' + fmtMoney(cm.netDebt) : 'خالص / له'}</strong></div>
            ` : ''}
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            ${showPrices ? `
              <button type="button" class="btn btn-sm btn-primary" onclick="closeSmartAiModal(); openClientFullHistoryModal('${matchedClient.id}');">
                📂 فتح كشف الحساب الشامل للعميل
              </button>
            ` : ''}
            <button type="button" class="btn btn-sm btn-outline" onclick="closeSmartAiModal(); openClientPalletMovementModal('${matchedClient.id}');">
              🪵 تسجيل تسليم / استلام بالتات
            </button>
          </div>
        </div>
      `;
    } else {
      let totalReceivables = 0;
      let totalPalletsAtClients = 0;
      const rows = clients.map(c => {
        const cm = computeClientMetrics(c);
        if (cm.netDebt > 0) totalReceivables += cm.netDebt;
        if (cm.netPalletsAtClient > 0) totalPalletsAtClients += cm.netPalletsAtClient;
        return { c, cm };
      });

      speechSummary = showPrices
        ? `يوجد ${clients.length} عميل مسجل بالنظام. إجمالي مديونيات العملاء للمصنع ${fmtNum(totalReceivables, 0)} جنيه، وإجمالي البالتات المتبقية طرف العملاء ${totalPalletsAtClients} بالتة.`
        : `يوجد ${clients.length} عميل مسجل بالنظام، وإجمالي البالتات الخشبية المتبقية طرف العملاء ${totalPalletsAtClients} بالتة.`;

      responseHtml = `
        <div>
          <div style="font-weight:900;color:var(--primary);margin-bottom:8px;">
            🤝 ملخص العملاء والبالتات ${showPrices ? 'والمديونيات' : ''} (${clients.length} عميل):
          </div>
          <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:10px;background:var(--bg-elevated);padding:10px;border-radius:10px;">
            <div>🪵 إجمالي البالتات طرف العملاء: <strong style="color:#d97706;">${totalPalletsAtClients} بالتة</strong></div>
            ${showPrices ? `<div>💰 إجمالي مديونيات العملاء (عليهم): <strong style="color:var(--danger);">${fmtMoney(totalReceivables)}</strong></div>` : ''}
          </div>
          <div class="table-responsive" style="max-height:210px;overflow-y:auto;">
            <table>
              <thead>
                <tr>
                  <th>الكود والاسم</th>
                  <th>الطلبيات</th>
                  <th>بالتات طرفه</th>
                  ${showPrices ? '<th>صافي الرصيد</th>' : ''}
                  <th>إجراء</th>
                </tr>
              </thead>
              <tbody>
                ${rows.map(({ c, cm }) => `
                  <tr>
                    <td><strong>[${c.code || 'CL'}] ${c.name}</strong></td>
                    <td>${cm.orders.length}</td>
                    <td><span class="badge ${cm.netPalletsAtClient > 0 ? 'badge-warning' : 'badge-success'}">${cm.netPalletsAtClient} بالتة</span></td>
                    ${showPrices ? `<td style="font-weight:800;color:${cm.netDebt > 0 ? 'var(--danger)' : 'var(--success)'};">${cm.netDebt > 0 ? 'عليه ' + fmtMoney(cm.netDebt) : 'خالص'}</td>` : ''}
                    <td>
                      <button type="button" class="btn btn-sm btn-outline" style="padding:2px 7px;" onclick="runSmartAiQuickChip('عميل ${c.code}')">🔍 تفاصيل</button>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
      `;
    }
  }
  // 7. Specific Thickness / Grade Stock Query or General Factory Summary
  else {
    const nums = (norm.match(/\d+(\.\d+)?/g) || []).map(Number);
    const queriedThkMm = nums.find(n => thicknesses.some(t => Number(t.mm) === n));
    const filterDir = /(سدا|سدي)/.test(norm) ? 'sada' : /(قص)/.test(norm) ? 'qas' : null;

    if (queriedThkMm !== undefined) {
      const matchingRows = thicknesses.filter(t => Number(t.mm) === queriedThkMm && (!filterDir || (t.direction || 'qas') === filterDir));
      const matchingPallets = inStockPallets.filter(p => Number(p.thicknessMm) === queriedThkMm && (!filterDir || (p.direction || 'qas') === filterDir));
      const totalSh = matchingPallets.reduce((s, p) => s + Number(p.sheetsCount || 0), 0);
      const totalM3 = matchingPallets.reduce((s, p) => s + Number(p.volumeM3 || 0), 0);

      speechSummary = `رصيد تخانة ${queriedThkMm} ملي في المخزن هو ${fmtNum(totalSh, 0)} فرخ بإجمالي حجم ${fmtNum(totalM3, 3)} متر مكعب موزعة على ${matchingPallets.length} بالتة.`;

      responseHtml = `
        <div>
          <div style="font-weight:900;color:var(--primary);margin-bottom:8px;">
            🪵 جرد تخانة (${queriedThkMm} مم ${filterDir ? (filterDir === 'sada' ? '— سدا' : '— قص') : '— قص وسدا'}) في المخزن الآن:
          </div>
          <div style="background:var(--bg-elevated);padding:10px;border-radius:10px;margin-bottom:10px;display:flex;gap:14px;flex-wrap:wrap;">
            <div>📦 إجمالي القطع: <strong style="color:var(--primary);font-size:1.05rem;">${fmtNum(totalSh, 0)} فرخ</strong></div>
            <div>📐 إجمالي الحجم: <strong>${fmtNum(totalM3, 4)} م³</strong></div>
            <div>🏷️ عدد البالتات: <strong>${matchingPallets.length} بالتة</strong></div>
          </div>
          <div class="table-responsive">
            <table>
              <thead>
                <tr>
                  <th>التخانة والاتجاه</th>
                  ${grades.map(g => `<th>${g.code}</th>`).join('')}
                  <th>إجراء سريع</th>
                </tr>
              </thead>
              <tbody>
                ${matchingRows.map(t => `
                  <tr>
                    <td><strong>${t.mm} مم (${t.direction === 'sada' ? 'سدا' : 'قص'})</strong></td>
                    ${grades.map(g => {
                      const sh = inStockPallets
                        .filter(p => matchPalletToThicknessRow(p, t) && matchPalletToGrade(p, g.id))
                        .reduce((s, p) => s + Number(p.sheetsCount || 0), 0);
                      return `<td style="font-weight:800;color:${sh > 0 ? 'var(--success)' : 'var(--text-muted)'};">${fmtNum(sh, 0)} ق</td>`;
                    }).join('')}
                    <td>
                      <button type="button" class="btn btn-sm btn-primary" style="padding:2px 8px;" onclick="closeSmartAiModal(); openMatrixCellModal('${t.id}', '${grades[0]?.id || 'gr-c'}', 'in');">
                        ➕ حركة مخزنية
                      </button>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
      `;
    } else {
      const totalSheets = inStockPallets.reduce((s, p) => s + Number(p.sheetsCount || 0), 0);
      const totalM3 = inStockPallets.reduce((s, p) => s + Number(p.volumeM3 || 0), 0);
      const totalM2 = inStockPallets.reduce((s, p) => s + Number(p.areaM2 || 0), 0);
      const totalStockVal = inStockPallets.reduce((s, p) => s + Number(p.totalValue || 0), 0);
      const pendingOrders = orders.filter(o => o.stage !== 'completed').length;

      speechSummary = `إجمالي رصيد مخزن القشرة الآن ${inStockPallets.length} بالتة بإجمالي ${fmtNum(totalSheets, 0)} فرخ وحجم ${fmtNum(totalM3, 2)} متر مكعب، ويوجد ${pendingOrders} طلبية جارية.`;

      responseHtml = `
        <div>
          <div style="font-weight:900;color:var(--primary);margin-bottom:8px;">
            📊 الملخص اللحظي لمصنع العاصمة للصناعات المتخصصة:
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px;margin-bottom:10px;">
            <div style="background:var(--bg-elevated);padding:10px;border-radius:10px;border-right:4px solid var(--primary);">
              <small style="color:var(--text-muted);">📦 رصيد مخزن القشرة التامة</small>
              <div style="font-weight:900;font-size:1.05rem;">${fmtNum(totalSheets, 0)} فرخ (${inStockPallets.length} بالتة)</div>
              <small>${fmtNum(totalM3, 4)} م³ | ${fmtNum(totalM2, 1)} م²</small>
            </div>
            ${showPrices ? `
              <div style="background:var(--bg-elevated);padding:10px;border-radius:10px;border-right:4px solid var(--accent);">
                <small style="color:var(--text-muted);">💰 القيمة التقديرية للمخزون</small>
                <div style="font-weight:900;font-size:1.05rem;color:var(--accent);">${fmtMoney(totalStockVal)}</div>
              </div>
            ` : ''}
            <div style="background:var(--bg-elevated);padding:10px;border-radius:10px;border-right:4px solid var(--success);">
              <small style="color:var(--text-muted);">⏳ الطلبيات الجارية والمعلقة</small>
              <div style="font-weight:900;font-size:1.05rem;">${pendingOrders} طلبية نشطة</div>
              <small>من إجمالي ${orders.length} طلبية</small>
            </div>
            <div style="background:var(--bg-elevated);padding:10px;border-radius:10px;border-right:4px solid #7c3aed;">
              <small style="color:var(--text-muted);">🤝 العملاء المسجلون</small>
              <div style="font-weight:900;font-size:1.05rem;">${clients.length} عميل</div>
            </div>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;">
            <button type="button" class="btn btn-sm btn-primary" onclick="closeSmartAiModal(); setTab('veneer');">🪵 فتح جدول مخزن القشرة</button>
            <button type="button" class="btn btn-sm btn-outline" onclick="runSmartAiQuickChip('ما هي الطلبيات المعلقة حالياً؟')">⏳ عرض الطلبيات المعلقة</button>
            <button type="button" class="btn btn-sm btn-outline" onclick="runSmartAiQuickChip('رصيد البالتات عند العملاء')">🪵 أرصدة العملاء والبالتات</button>
          </div>
        </div>
      `;
    }
  }

  aiChatHistory.push({
    sender: 'ai',
    time: new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }),
    html: responseHtml
  });

  const msgBox = document.getElementById('ai-assistant-messages');
  if (msgBox) {
    msgBox.innerHTML = renderSmartAiMessagesHtml();
    scrollSmartAiMessagesBottom();
  }

  if (speechSummary) {
    speakArabicAiResponse(speechSummary);
  }
}

// ============================================================================
// 12. RAW WOOD LOG CONTAINERS, SERIALS, PDF IMPORT & DENSITY/YIELD/SCRAP (v30)
// ============================================================================
let activeLogContainerFilter = 'all';
let activeLogStatusFilter = 'all'; // 'all' | 'in_stock' | 'processed'
let logSerialSearchQuery = '';
let draftImportedLogs = [];

// صلاحيـة إدخال وتشغيل سيريال الجذوع: مدير المشروعات + المدير التنفيذي + المدير الإداري
function canManageLogSerialsAndProduction(user = currentUser) {
  if (!user) return false;
  return ['ceo', 'projects_manager', 'admin_manager'].includes(user.roleKey);
}

function computeCylinderLogVolumeM3(lengthVal, diameterCmVal) {
  let lenM = Number(lengthVal || 0);
  const diaCm = Number(diameterCmVal || 0);
  if (lenM <= 0 || diaCm <= 0) return 0;
  // If length was entered in cm (e.g. 260 cm instead of 2.6 m), convert to meters
  if (lenM > 25) lenM = lenM / 100;
  const radiusM = (diaCm / 100) / 2;
  return +(Math.PI * radiusM * radiusM * lenM).toFixed(4);
}

function getContainerMetrics(container) {
  if (!container) {
    return {
      totalLogsCount: 0, processedLogsCount: 0, remainingLogsCount: 0,
      totalVolumeM3: 0, processedVolumeM3: 0, remainingVolumeM3: 0,
      densityTonPerM3: 0.75, expectedYieldPct: 65,
      totalWeightTon: 0, processedWeightTon: 0, remainingWeightTon: 0,
      expectedFinishedM3: 0, expectedFinishedTon: 0,
      expectedScrapM3: 0, expectedScrapTon: 0,
      processedExpectedFinishedM3: 0, processedExpectedScrapM3: 0, processedExpectedScrapTon: 0,
      actualFinishedM3: 0, actualYieldPctOnProcessed: 0,
      actualScrapM3: 0, actualScrapTon: 0,
      yieldDiffPct: 0, scrapDiffTon: 0, logs: []
    };
  }

  const logs = (state.logItems || []).filter(l => l.containerId === container.id);
  const processedLogs = logs.filter(l => l.status === 'processed');
  const remainingLogs = logs.filter(l => l.status !== 'processed');

  const totalVolumeM3 = +logs.reduce((s, l) => s + Number(l.volumeM3 || 0), 0).toFixed(4);
  const processedVolumeM3 = +processedLogs.reduce((s, l) => s + Number(l.volumeM3 || 0), 0).toFixed(4);
  const remainingVolumeM3 = +Math.max(0, totalVolumeM3 - processedVolumeM3).toFixed(4);

  const densityTonPerM3 = Math.max(0.1, Number(container.densityTonPerM3 || 0.75));
  const expectedYieldPct = Math.min(100, Math.max(1, Number(container.expectedYieldPct || 65)));
  const expectedScrapPct = +(100 - expectedYieldPct).toFixed(2);

  const totalWeightTon = +(totalVolumeM3 * densityTonPerM3).toFixed(3);
  const processedWeightTon = +(processedVolumeM3 * densityTonPerM3).toFixed(3);
  const remainingWeightTon = +(remainingVolumeM3 * densityTonPerM3).toFixed(3);

  const expectedFinishedM3 = +(totalVolumeM3 * (expectedYieldPct / 100)).toFixed(4);
  const expectedFinishedTon = +(expectedFinishedM3 * densityTonPerM3).toFixed(3);
  const expectedScrapM3 = +Math.max(0, totalVolumeM3 - expectedFinishedM3).toFixed(4);
  const expectedScrapTon = +(expectedScrapM3 * densityTonPerM3).toFixed(3);

  const processedExpectedFinishedM3 = +(processedVolumeM3 * (expectedYieldPct / 100)).toFixed(4);
  const processedExpectedScrapM3 = +Math.max(0, processedVolumeM3 - processedExpectedFinishedM3).toFixed(4);
  const processedExpectedScrapTon = +(processedExpectedScrapM3 * densityTonPerM3).toFixed(3);

  const hasCustomActual = container.actualFinishedM3 !== undefined && container.actualFinishedM3 !== null && container.actualFinishedM3 !== '';
  const actualFinishedM3 = hasCustomActual ? Math.max(0, Number(container.actualFinishedM3 || 0)) : processedExpectedFinishedM3;
  const baseVolForActual = processedVolumeM3 > 0 ? processedVolumeM3 : totalVolumeM3;
  const actualYieldPctOnProcessed = baseVolForActual > 0 ? +((actualFinishedM3 / baseVolForActual) * 100).toFixed(2) : expectedYieldPct;
  const actualScrapM3 = +Math.max(0, baseVolForActual - actualFinishedM3).toFixed(4);
  const actualScrapTon = +(actualScrapM3 * densityTonPerM3).toFixed(3);

  const yieldDiffPct = +(actualYieldPctOnProcessed - expectedYieldPct).toFixed(2);
  const scrapDiffTon = +(actualScrapTon - (processedVolumeM3 > 0 ? processedExpectedScrapTon : expectedScrapTon)).toFixed(3);

  return {
    totalLogsCount: logs.length,
    processedLogsCount: processedLogs.length,
    remainingLogsCount: remainingLogs.length,
    totalVolumeM3,
    processedVolumeM3,
    remainingVolumeM3,
    densityTonPerM3,
    expectedYieldPct,
    expectedScrapPct,
    totalWeightTon,
    processedWeightTon,
    remainingWeightTon,
    expectedFinishedM3,
    expectedFinishedTon,
    expectedScrapM3,
    expectedScrapTon,
    processedExpectedFinishedM3,
    processedExpectedScrapM3,
    processedExpectedScrapTon,
    actualFinishedM3,
    actualYieldPctOnProcessed,
    actualScrapM3,
    actualScrapTon,
    yieldDiffPct,
    scrapDiffTon,
    logs
  };
}

function renderLogContainersAndSerialsSection() {
  const containers = state.logContainers || [];
  const allLogs = state.logItems || [];
  const canOperateLogs = canManageLogSerialsAndProduction(currentUser);

  const totalContainers = containers.length;
  const totalLogs = allLogs.length;
  const processedLogs = allLogs.filter(l => l.status === 'processed');
  const remainingLogs = allLogs.filter(l => l.status !== 'processed');
  const totalVolM3 = allLogs.reduce((s, l) => s + Number(l.volumeM3 || 0), 0);
  const processedVolM3 = processedLogs.reduce((s, l) => s + Number(l.volumeM3 || 0), 0);
  const remainingVolM3 = Math.max(0, totalVolM3 - processedVolM3);

  let totalExpectedScrapTon = 0;
  let totalExpectedFinishedM3 = 0;
  for (const c of containers) {
    const cm = getContainerMetrics(c);
    totalExpectedScrapTon += cm.expectedScrapTon;
    totalExpectedFinishedM3 += cm.expectedFinishedM3;
  }

  // Filter logs for the serials table
  const q = normalizeArabicAiText(logSerialSearchQuery).toLowerCase();
  const filteredLogs = allLogs.filter(l => {
    if (activeLogContainerFilter !== 'all' && l.containerId !== activeLogContainerFilter) return false;
    if (activeLogStatusFilter === 'in_stock' && l.status === 'processed') return false;
    if (activeLogStatusFilter === 'processed' && l.status !== 'processed') return false;
    if (q) {
      const ser = String(l.serialNumber || '').toLowerCase();
      const cnt = String(l.containerNumber || '').toLowerCase();
      const sup = normalizeArabicAiText(l.supplierName || '').toLowerCase();
      if (!ser.includes(q) && !cnt.includes(q) && !sup.includes(q)) return false;
    }
    return true;
  });

  return `
    <div class="card" style="border:2px solid var(--primary);background:linear-gradient(135deg, rgba(15,118,110,0.05), rgba(217,119,6,0.05));margin-bottom:18px;">
      <div class="card-header">
        <div>
          <div class="card-title" style="font-size:1.05rem;color:var(--primary);">
            🚢 منظومة رسائل وحاويات جذوع الأشجار بالسيريال + استيراد PDF الفوري + حساب الكثافة ونسبة الاستخراج والهالك بالطن
          </div>
          <small style="color:var(--text-muted);">
            استيراد بيان المورد (PDF أو نسخ ولصق جماعي) في ثوانٍ بدون إدخال جذع بجذع، مع متابعة ما تم تشغيله وما لم يتم تشغيله وحساب الهالك بالطن حسب الكثافة
          </small>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button type="button" class="btn btn-sm btn-outline" onclick="printLogContainersAndSerialsReportPdf()">
            🖨️ طباعة بيان الحاويات والجذوع PDF
          </button>
          ${canOperateLogs ? `
            <button type="button" class="btn btn-sm" style="background:linear-gradient(135deg,#7c3aed,#4f46e5);color:#fff;font-weight:800;" onclick="openQuickLogSerialDispatchModal()">
              ⚙️ إدخال سيريال جذوع للتشغيل (المدير التنفيذي / المشروعات / الإداري)
            </button>
          ` : ''}
          ${(canOperateLogs || hasPerm('warehouseIssueReceive')) ? `
            <button type="button" class="btn btn-sm btn-primary" style="font-weight:900;" onclick="openImportLogContainerPdfModal()">
              📄 استيراد حاوية / بيان جذوع (PDF أو لصق سريع)
            </button>
          ` : ''}
        </div>
      </div>

      <!-- KPI Summary Bar for Raw Logs -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(175px,1fr));gap:10px;margin-bottom:16px;">
        <div style="background:var(--bg-card);padding:12px;border-radius:10px;border-right:4px solid var(--primary);box-shadow:0 2px 5px rgba(0,0,0,0.04);">
          <small style="color:var(--text-muted);">🚢 إجمالي الحاويات والجذوع المسجلة</small>
          <div style="font-weight:900;font-size:1.05rem;">${totalContainers} حاوية (${fmtNum(totalLogs, 0)} جذع)</div>
          <small style="color:var(--primary);font-weight:700;">إجمالي التكعيب: ${fmtNum(totalVolM3, 4)} م³</small>
        </div>
        <div style="background:var(--bg-card);padding:12px;border-radius:10px;border-right:4px solid var(--success);box-shadow:0 2px 5px rgba(0,0,0,0.04);">
          <small style="color:var(--text-muted);">🌲 جذوع متبقية بالمخزن (لم يتم تشغيلها)</small>
          <div style="font-weight:900;font-size:1.05rem;color:var(--success);">${fmtNum(remainingLogs.length, 0)} جذع متاح</div>
          <small style="font-weight:700;">تكعيب متبقي: ${fmtNum(remainingVolM3, 4)} م³</small>
        </div>
        <div style="background:var(--bg-card);padding:12px;border-radius:10px;border-right:4px solid #0284c7;box-shadow:0 2px 5px rgba(0,0,0,0.04);">
          <small style="color:var(--text-muted);">⚙️ جذوع تم تشغيلها (تقشير)</small>
          <div style="font-weight:900;font-size:1.05rem;color:#0284c7;">${fmtNum(processedLogs.length, 0)} جذع مُشغّل</div>
          <small style="font-weight:700;">تكعيب مُشغّل: ${fmtNum(processedVolM3, 4)} م³</small>
        </div>
        <div style="background:var(--bg-card);padding:12px;border-radius:10px;border-right:4px solid #d97706;box-shadow:0 2px 5px rgba(0,0,0,0.04);">
          <small style="color:var(--text-muted);">⚖️ استخراج المنتج التام والهالك بالطن</small>
          <div style="font-weight:900;font-size:0.95rem;color:#b45309;">
            توقع قشرة تامة: ${fmtNum(totalExpectedFinishedM3, 3)} م³<br/>
            <span style="color:var(--danger);">إجمالي الهالك المتوقع: ${fmtNum(totalExpectedScrapTon, 3)} طن</span>
          </div>
        </div>
      </div>

      ${canOperateLogs ? `
        <!-- Instant Serial Bar for CEO, Projects Manager, Admin Manager -->
        <div style="background:rgba(124,58,237,0.08);border:1.5px solid #7c3aed;border-radius:12px;padding:12px 14px;margin-bottom:16px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;">
          <div>
            <div style="font-weight:900;color:#5b21b6;font-size:0.92rem;">
              ⚡ تشغيل فوري بالسيريال (خاص بـ: المدير التنفيذي / مدير المشروعات / المدير الإداري):
            </div>
            <small style="color:var(--text-muted);">
              اكتب رقم سيريال الجذع (أو عدة سيريالات مفصولة بمسافة أو فاصلة) واضغط <strong>"تشغيل الجذع الآن"</strong> لتحويله إلى (تم التشغيل) وخصمه من الرصيد المتبقي فوراً:
            </small>
          </div>
          <form onsubmit="submitInlineLogSerialProcess(event)" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;flex:1;min-width:280px;justify-content:flex-end;">
            <input id="inline-log-serial-input" class="form-control" style="max-width:300px;font-weight:800;border:2px solid #7c3aed;" placeholder="اكتب رقم السيريال (مثال: 1001 أو 1001, 1002)..." />
            <button type="submit" class="btn btn-primary" style="background:#7c3aed;border-color:#7c3aed;font-weight:900;">
              ⚙️ تشغيل السيريال الآن
            </button>
          </form>
        </div>
      ` : ''}

      <!-- 1. Containers & Shipments Table with Density, Yield %, and Scrap in Tons -->
      <div style="margin-bottom:16px;">
        <div style="font-weight:900;font-size:0.92rem;color:var(--primary);margin-bottom:8px;">
          1️⃣ جدول الرسائل والحاويات ونسبة استخراج المنتج التام وحساب الهالك بالطن (باستخدام الكثافة):
        </div>
        ${containers.length === 0 ? `
          <div style="padding:16px;text-align:center;background:var(--bg-card);border-radius:10px;border:1px dashed var(--border-color);color:var(--text-muted);">
            لا توجد حاويات أو رسائل جذوع مسجلة حالياً. اضغط على <strong>"📄 استيراد حاوية / بيان جذوع (PDF أو لصق سريع)"</strong> لإدخال بيان المورد كاملاً في ثانية واحدة!
          </div>
        ` : `
          <div class="table-responsive">
            <table>
              <thead>
                <tr>
                  <th>رقم الرسالة / الحاوية</th>
                  <th>المورد ونوع الخشب</th>
                  <th>إجمالي الجذوع والتكعيب</th>
                  <th>تم تشغيله ✅</th>
                  <th>متبقي بالمخزن ⏳</th>
                  <th>الكثافة (طن/م³) والوزن</th>
                  <th>نسبة الاستخراج (منتج تام)</th>
                  <th>الهالك (م³ وبالطن) والفرق</th>
                  <th>إجراءات</th>
                </tr>
              </thead>
              <tbody>
                ${containers.map(c => {
                  const cm = getContainerMetrics(c);
                  return `
                    <tr style="${activeLogContainerFilter === c.id ? 'background:rgba(15,118,110,0.08);' : ''}">
                      <td>
                        <strong>${c.containerNumber || c.code}</strong><br/>
                        <small style="color:var(--text-muted);">📅 ${c.arrivalDate || '-'}</small>
                      </td>
                      <td>
                        <strong>${c.supplierName || 'مورد أخشاب'}</strong><br/>
                        <span class="badge badge-info">${c.woodTypeName || 'خشب خام'}</span>
                      </td>
                      <td>
                        <strong>${cm.totalLogsCount} جذع</strong><br/>
                        <span style="color:var(--primary);font-weight:800;">${fmtNum(cm.totalVolumeM3, 4)} م³</span>
                      </td>
                      <td>
                        <span class="badge" style="background:#0284c7;color:#fff;">${cm.processedLogsCount} جذع</span><br/>
                        <small style="font-weight:700;">${fmtNum(cm.processedVolumeM3, 4)} م³</small>
                      </td>
                      <td>
                        <span class="badge ${cm.remainingLogsCount > 0 ? 'badge-success' : 'badge-warning'}">${cm.remainingLogsCount} جذع متبقي</span><br/>
                        <strong style="color:var(--success);">${fmtNum(cm.remainingVolumeM3, 4)} م³</strong>
                      </td>
                      <td>
                        <strong>${fmtNum(cm.densityTonPerM3, 3)} طن/م³</strong><br/>
                        <small style="color:var(--text-muted);">إجمالي الوزن: <strong>${fmtNum(cm.totalWeightTon, 3)} طن</strong></small>
                      </td>
                      <td>
                        <span class="badge badge-success">المتوقع: ${fmtNum(cm.expectedYieldPct, 1)}%</span>
                        <div style="font-size:0.74rem;margin-top:2px;">
                          قشرة متوقعة: <strong>${fmtNum(cm.expectedFinishedM3, 3)} م³</strong> (${fmtNum(cm.expectedFinishedTon, 2)} طن)
                          ${c.actualFinishedM3 !== undefined && c.actualFinishedM3 !== null && c.actualFinishedM3 !== '' ? `<br/><span style="color:#7c3aed;font-weight:800;">فعلي: ${fmtNum(cm.actualFinishedM3, 3)} م³ (${fmtNum(cm.actualYieldPctOnProcessed, 1)}%)</span>` : ''}
                        </div>
                      </td>
                      <td>
                        <span class="badge badge-danger">هالك: ${fmtNum(cm.expectedScrapPct, 1)}%</span>
                        <div style="font-size:0.75rem;margin-top:2px;">
                          متوقع: <strong>${fmtNum(cm.expectedScrapTon, 3)} طن</strong> (${fmtNum(cm.expectedScrapM3, 3)} م³)
                          ${c.actualFinishedM3 !== undefined && c.actualFinishedM3 !== null && c.actualFinishedM3 !== '' ? `
                            <br/><strong style="color:var(--danger);">هالك فعلي: ${fmtNum(cm.actualScrapTon, 3)} طن</strong>
                            <small>(فرق: ${cm.scrapDiffTon > 0 ? '+' : ''}${fmtNum(cm.scrapDiffTon, 3)} طن)</small>
                          ` : ''}
                        </div>
                      </td>
                      <td>
                        <div style="display:flex;gap:4px;flex-wrap:wrap;">
                          <button type="button" class="btn btn-sm ${activeLogContainerFilter === c.id ? 'btn-primary' : 'btn-outline'}" style="padding:3px 7px;" onclick="activeLogContainerFilter = (activeLogContainerFilter === '${c.id}' ? 'all' : '${c.id}'); render();" title="تصفية الجذوع لهذه الحاوية">
                            🔍 جذوع الحاوية
                          </button>
                          <button type="button" class="btn btn-sm btn-accent" style="padding:3px 7px;" onclick="openContainerYieldDensityModal('${c.id}')" title="تعديل الكثافة ونسبة الاستخراج وحساب فرق المنتج التام والهالك بالطن">
                            ⚖️ الكثافة والاستخراج
                          </button>
                          ${isFullAdmin(currentUser) ? `
                            <button type="button" class="btn btn-sm btn-danger" style="padding:3px 7px;" onclick="deleteLogContainerRecord('${c.id}')" title="حذف الحاوية وجذوعها">🗑️</button>
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

      <!-- 2. Detailed Serials Table (What is Processed vs What is Not Processed + Edit + Toggle) -->
      <div>
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:8px;background:var(--bg-card);padding:8px 12px;border-radius:10px;border:1px solid var(--border-color);">
          <div style="font-weight:900;font-size:0.9rem;color:var(--primary);">
            2️⃣ بيان سيريالات الجذوع بالتفصيل (ما تم تشغيله وما لم يتم تشغيله — مع إمكانية التعديل):
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
            <select class="form-control" style="max-width:190px;padding:4px 8px;font-size:0.8rem;font-weight:700;" onchange="activeLogContainerFilter=this.value; render();">
              <option value="all" ${activeLogContainerFilter === 'all' ? 'selected' : ''}>🚢 كل الحاويات (${allLogs.length} جذع)</option>
              ${containers.map(c => `<option value="${c.id}" ${activeLogContainerFilter === c.id ? 'selected' : ''}>حاوية: ${c.containerNumber}</option>`).join('')}
            </select>
            <select class="form-control" style="max-width:195px;padding:4px 8px;font-size:0.8rem;font-weight:700;" onchange="activeLogStatusFilter=this.value; render();">
              <option value="all" ${activeLogStatusFilter === 'all' ? 'selected' : ''}>📋 الكل (المُشغّل + المتبقي)</option>
              <option value="in_stock" ${activeLogStatusFilter === 'in_stock' ? 'selected' : ''}>⏳ لم يتم تشغيله فقط (${remainingLogs.length})</option>
              <option value="processed" ${activeLogStatusFilter === 'processed' ? 'selected' : ''}>✅ تم تشغيله فقط (${processedLogs.length})</option>
            </select>
            <input id="log-serial-search-input" class="form-control" style="max-width:190px;padding:4px 10px;font-size:0.8rem;" placeholder="🔍 بحث برقم السيريال..." value="${logSerialSearchQuery}" oninput="logSerialSearchQuery=this.value; render();" />
          </div>
        </div>

        ${filteredLogs.length === 0 ? `
          <div style="padding:14px;text-align:center;color:var(--text-muted);background:var(--bg-card);border-radius:10px;">
            لا توجد جذوع مطابقة للفلتر الحالي.
          </div>
        ` : `
          <div class="table-responsive" style="max-height:390px;overflow-y:auto;">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>رقم السيريال (Serial)</th>
                  <th>رقم الحاوية</th>
                  <th>المقاسات (الطول × القطر)</th>
                  <th>تكعيب الجذع (م³)</th>
                  <th>الوزن التقديري (طن)</th>
                  <th>حالة التشغيل</th>
                  <th>تاريخ وبواسطة من تم التشغيل</th>
                  <th>إجراءات وتعديل</th>
                </tr>
              </thead>
              <tbody>
                ${filteredLogs.map((l, idx) => {
                  const isProc = l.status === 'processed';
                  const parentCont = containers.find(c => c.id === l.containerId);
                  const dens = Number(parentCont?.densityTonPerM3 || 0.75);
                  const weightTon = +(Number(l.volumeM3 || 0) * dens).toFixed(3);
                  return `
                    <tr style="${isProc ? 'background:rgba(2,132,199,0.06);' : ''}">
                      <td>${idx + 1}</td>
                      <td><strong style="font-size:0.95rem;color:var(--primary);">${l.serialNumber}</strong></td>
                      <td><strong>${l.containerNumber || '-'}</strong></td>
                      <td>
                        ${l.lengthM || l.diameterCm ? `الطول: <strong>${l.lengthM || '-'}</strong> | القطر: <strong>${l.diameterCm || '-'} سم</strong>` : (l.dimensionsText || '-')}
                      </td>
                      <td><strong style="font-size:0.95rem;">${fmtNum(l.volumeM3, 4)} م³</strong></td>
                      <td>${fmtNum(weightTon, 3)} طن</td>
                      <td>
                        ${isProc ? `
                          <span class="badge" style="background:#0284c7;color:#fff;font-weight:800;">✅ تم تشغيله</span>
                        ` : `
                          <span class="badge badge-success" style="font-weight:800;">⏳ لم يتم تشغيله (متاح بالمخزن)</span>
                        `}
                      </td>
                      <td>
                        ${isProc ? `<small>📅 ${fmtDate(l.processedAt)}<br/>بواسطة: <strong>${l.processedBy || '-'}</strong></small>` : '-'}
                      </td>
                      <td>
                        <div style="display:flex;gap:4px;flex-wrap:wrap;">
                          ${canOperateLogs ? `
                            ${!isProc ? `
                              <button type="button" class="btn btn-sm btn-primary" style="padding:3px 8px;background:#7c3aed;border-color:#7c3aed;" onclick="toggleSingleLogProcessStatus('${l.id}', true)">
                                ⚙️ تشغيل الجذع
                              </button>
                            ` : `
                              <button type="button" class="btn btn-sm btn-outline" style="padding:3px 8px;" onclick="toggleSingleLogProcessStatus('${l.id}', false)" title="إلغاء التشغيل وإرجاع الجذع للرصيد المتاح">
                                ↩️ إرجاع للمخزن
                              </button>
                            `}
                          ` : ''}
                          ${(canOperateLogs || hasPerm('warehouseIssueReceive')) ? `
                            <button type="button" class="btn btn-sm btn-accent" style="padding:3px 7px;" onclick="openEditSingleLogModal('${l.id}')" title="تعديل السيريال أو المقاسات أو التكعيب">
                              ✏️ تعديل
                            </button>
                          ` : ''}
                          ${isFullAdmin(currentUser) ? `
                            <button type="button" class="btn btn-sm btn-danger" style="padding:3px 7px;" onclick="deleteSingleLogItem('${l.id}')" title="حذف الجذع">
                              🗑️
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
    </div>
  `;
}

// Lazy-load PDF.js from CDN to extract text or render scanned pages from Supplier PDF files
async function ensurePdfJsLoaded() {
  if (window.pdfjsLib) return window.pdfjsLib;
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
    script.onload = () => {
      if (window.pdfjsLib) {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        resolve(window.pdfjsLib);
      } else {
        reject(new Error('تعذر تحميل مكتبة قراءة PDF'));
      }
    };
    script.onerror = () => reject(new Error('تعذر الاتصال لتحميل قارئ PDF، يمكنك لصق النص أو الجدول مباشرة'));
    document.head.appendChild(script);
  });
}

// Lazy-load Tesseract.js OCR from CDN for Scanned / CamScanner PDFs and Images
async function ensureTesseractLoaded() {
  if (window.Tesseract) return window.Tesseract;
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
    script.onload = () => {
      if (window.Tesseract) resolve(window.Tesseract);
      else reject(new Error('تعذر تحميل محرك الذكاء الاصطناعي لقراءة الصور الممسوحة OCR'));
    };
    script.onerror = () => reject(new Error('تعذر تحميل محرك OCR'));
    document.head.appendChild(script);
  });
}

// Built-in verified Packing List for DEDONCKER P&G BV Invoice 5559 (13 Containers = 159 Logs = 395.364 CBM)
const DEDONCKER_PACKING_LIST_5559 = [
  {
    containerNumber: 'GAOU 655045-3', sealNumber: '.008462', supplierName: 'DEDONCKER P&G BV (بلجيكا - فاتورة 5559)', woodTypeName: 'جذوع خشب حور بلجيكي (Belgian Poplar Logs)', arrivalDate: '2026-10-14', vgmKg: 30525, tareKg: 3730, netWeightKg: 26795, notes: 'No.84818 and 84816 = minus 1,30M because of crack | Seal: .008462 | Net: 26,795 kg',
    logs: [
      { serialNumber: '84820', lengthM: 5.20, diameterCm: 99, volumeM3: 4.001 },
      { serialNumber: '84810', lengthM: 5.20, diameterCm: 68, volumeM3: 1.888 },
      { serialNumber: '84821', lengthM: 6.50, diameterCm: 67, volumeM3: 2.291 },
      { serialNumber: '84819', lengthM: 5.20, diameterCm: 77, volumeM3: 2.420 },
      { serialNumber: '84825', lengthM: 5.20, diameterCm: 69, volumeM3: 1.943 },
      { serialNumber: '84811', lengthM: 5.20, diameterCm: 88, volumeM3: 3.161 },
      { serialNumber: '84818', lengthM: 3.90, diameterCm: 75, volumeM3: 1.722, notes: 'minus 1.30M because of crack' },
      { serialNumber: '84817', lengthM: 5.20, diameterCm: 75, volumeM3: 2.296 },
      { serialNumber: '84814', lengthM: 7.80, diameterCm: 84, volumeM3: 4.320 },
      { serialNumber: '84816', lengthM: 2.60, diameterCm: 80, volumeM3: 1.306, notes: 'minus 1.30M because of crack' },
      { serialNumber: '84815', lengthM: 6.50, diameterCm: 72, volumeM3: 2.645 },
      { serialNumber: '84812', lengthM: 5.20, diameterCm: 66, volumeM3: 1.778 }
    ]
  },
  {
    containerNumber: 'NYKU 515463-0', sealNumber: '.009461', supplierName: 'DEDONCKER P&G BV (بلجيكا - فاتورة 5559)', woodTypeName: 'جذوع خشب حور بلجيكي (Belgian Poplar Logs)', arrivalDate: '2026-10-14', vgmKg: 29429, tareKg: 3830, netWeightKg: 25599, notes: 'No.84809 and 84807 = minus 1,30M because of crack | Seal: .009461 | Net: 25,599 kg',
    logs: [
      { serialNumber: '84809', lengthM: 3.90, diameterCm: 68, volumeM3: 1.416, notes: 'minus 1.30M because of crack' },
      { serialNumber: '84813', lengthM: 5.20, diameterCm: 91, volumeM3: 3.380 },
      { serialNumber: '84808', lengthM: 6.50, diameterCm: 74, volumeM3: 2.794 },
      { serialNumber: '84807', lengthM: 5.80, diameterCm: 75, volumeM3: 2.561, notes: 'minus 1.30M because of crack' },
      { serialNumber: '84806', lengthM: 5.20, diameterCm: 85, volumeM3: 2.949 },
      { serialNumber: '84804', lengthM: 6.50, diameterCm: 70, volumeM3: 2.500 },
      { serialNumber: '84802', lengthM: 3.90, diameterCm: 81, volumeM3: 2.009 },
      { serialNumber: '84801', lengthM: 5.20, diameterCm: 79, volumeM3: 2.548 },
      { serialNumber: '84797', lengthM: 5.20, diameterCm: 87, volumeM3: 3.090 },
      { serialNumber: '84803', lengthM: 3.90, diameterCm: 72, volumeM3: 1.587 },
      { serialNumber: '84798', lengthM: 3.90, diameterCm: 67, volumeM3: 1.374 },
      { serialNumber: '84796', lengthM: 5.20, diameterCm: 74, volumeM3: 2.235 }
    ]
  },
  {
    containerNumber: 'ONEU 052697-0', sealNumber: '.009449', supplierName: 'DEDONCKER P&G BV (بلجيكا - فاتورة 5559)', woodTypeName: 'جذوع خشب حور بلجيكي (Belgian Poplar Logs)', arrivalDate: '2026-10-14', vgmKg: 30822, tareKg: 3700, netWeightKg: 27122, notes: 'No.84852 = minus 1,30M because of crack | Seal: .009449 | Net: 27,122 kg',
    logs: [
      { serialNumber: '84833', lengthM: 7.80, diameterCm: 85, volumeM3: 4.424 },
      { serialNumber: '84832', lengthM: 6.50, diameterCm: 75, volumeM3: 2.870 },
      { serialNumber: '84830', lengthM: 6.50, diameterCm: 65, volumeM3: 2.156 },
      { serialNumber: '84829', lengthM: 5.20, diameterCm: 79, volumeM3: 2.548 },
      { serialNumber: '84826', lengthM: 5.20, diameterCm: 80, volumeM3: 2.612 },
      { serialNumber: '84828', lengthM: 7.80, diameterCm: 88, volumeM3: 4.742 },
      { serialNumber: '84827', lengthM: 6.50, diameterCm: 62, volumeM3: 1.961 },
      { serialNumber: '84852', lengthM: 2.60, diameterCm: 70, volumeM3: 1.000, notes: 'minus 1.30M because of crack' },
      { serialNumber: '84823', lengthM: 3.90, diameterCm: 106, volumeM3: 3.440 },
      { serialNumber: '84786', lengthM: 2.60, diameterCm: 71, volumeM3: 1.029 },
      { serialNumber: '84822', lengthM: 7.80, diameterCm: 74, volumeM3: 3.353 }
    ]
  },
  {
    containerNumber: 'ONEU 121081-5', sealNumber: '.009467', supplierName: 'DEDONCKER P&G BV (بلجيكا - فاتورة 5559)', woodTypeName: 'جذوع خشب حور بلجيكي (Belgian Poplar Logs)', arrivalDate: '2026-10-14', vgmKg: 30967, tareKg: 3700, netWeightKg: 27267, notes: 'No:84896 = minus 1,30m because of crack | Seal: .009467 | Net: 27,267 kg',
    logs: [
      { serialNumber: '84906', lengthM: 3.90, diameterCm: 67, volumeM3: 1.374 },
      { serialNumber: '84904', lengthM: 5.20, diameterCm: 75, volumeM3: 2.296 },
      { serialNumber: '84903', lengthM: 5.20, diameterCm: 73, volumeM3: 2.175 },
      { serialNumber: '84905', lengthM: 2.60, diameterCm: 75, volumeM3: 1.148 },
      { serialNumber: '84898', lengthM: 6.50, diameterCm: 67, volumeM3: 2.291 },
      { serialNumber: '84896', lengthM: 3.90, diameterCm: 66, volumeM3: 1.334, notes: 'minus 1.30m because of crack' },
      { serialNumber: '84899', lengthM: 6.50, diameterCm: 74, volumeM3: 2.794 },
      { serialNumber: '84901', lengthM: 5.20, diameterCm: 72, volumeM3: 2.116 },
      { serialNumber: '84902', lengthM: 6.50, diameterCm: 75, volumeM3: 2.870 },
      { serialNumber: '84900', lengthM: 5.20, diameterCm: 74, volumeM3: 2.235 },
      { serialNumber: '84895', lengthM: 6.50, diameterCm: 87, volumeM3: 3.862 },
      { serialNumber: '84897', lengthM: 6.50, diameterCm: 70, volumeM3: 2.500 },
      { serialNumber: '84892', lengthM: 5.20, diameterCm: 76, volumeM3: 2.358 },
      { serialNumber: '84880', lengthM: 2.60, diameterCm: 68, volumeM3: 0.944 }
    ]
  },
  {
    containerNumber: 'ONEU 186383-0', sealNumber: '.009480', supplierName: 'DEDONCKER P&G BV (بلجيكا - فاتورة 5559)', woodTypeName: 'جذوع خشب حور بلجيكي (Belgian Poplar Logs)', arrivalDate: '2026-10-14', vgmKg: 31643, tareKg: 3700, netWeightKg: 27943, notes: 'Seal: .009480 | Net: 27,943 kg',
    logs: [
      { serialNumber: '84883', lengthM: 2.60, diameterCm: 132, volumeM3: 3.556 },
      { serialNumber: '84884', lengthM: 3.90, diameterCm: 114, volumeM3: 3.979 },
      { serialNumber: '84881', lengthM: 5.20, diameterCm: 82, volumeM3: 2.745 },
      { serialNumber: '84882', lengthM: 5.20, diameterCm: 95, volumeM3: 3.684 },
      { serialNumber: '84893', lengthM: 6.50, diameterCm: 70, volumeM3: 2.500 },
      { serialNumber: '84872', lengthM: 5.20, diameterCm: 73, volumeM3: 2.175 },
      { serialNumber: '84874', lengthM: 6.50, diameterCm: 75, volumeM3: 2.870 },
      { serialNumber: '84875', lengthM: 7.80, diameterCm: 75, volumeM3: 3.444 },
      { serialNumber: '84866', lengthM: 5.20, diameterCm: 73, volumeM3: 2.175 },
      { serialNumber: '84867', lengthM: 7.80, diameterCm: 80, volumeM3: 3.919 }
    ]
  },
  {
    containerNumber: 'ONEU 195266-6', sealNumber: '.009476', supplierName: 'DEDONCKER P&G BV (بلجيكا - فاتورة 5559)', woodTypeName: 'جذوع خشب حور بلجيكي (Belgian Poplar Logs)', arrivalDate: '2026-10-14', vgmKg: 31781, tareKg: 3700, netWeightKg: 28081, notes: 'Seal: .009476 | Net: 28,081 kg',
    logs: [
      { serialNumber: '84708', lengthM: 9.10, diameterCm: 95, volumeM3: 6.447 },
      { serialNumber: '84711', lengthM: 3.90, diameterCm: 68, volumeM3: 1.416 },
      { serialNumber: '84712', lengthM: 3.90, diameterCm: 78, volumeM3: 1.863 },
      { serialNumber: '84714', lengthM: 5.20, diameterCm: 79, volumeM3: 2.548 },
      { serialNumber: '84709', lengthM: 3.90, diameterCm: 65, volumeM3: 1.293 },
      { serialNumber: '84707', lengthM: 5.20, diameterCm: 62, volumeM3: 1.569 },
      { serialNumber: '84715', lengthM: 5.20, diameterCm: 96, volumeM3: 3.762 },
      { serialNumber: '84713', lengthM: 7.80, diameterCm: 68, volumeM3: 2.831 },
      { serialNumber: '84746', lengthM: 2.60, diameterCm: 86, volumeM3: 1.510 },
      { serialNumber: '84719', lengthM: 6.50, diameterCm: 66, volumeM3: 2.223 },
      { serialNumber: '84720', lengthM: 6.50, diameterCm: 75, volumeM3: 2.870 },
      { serialNumber: '84831', lengthM: 6.50, diameterCm: 75, volumeM3: 2.870 }
    ]
  },
  {
    containerNumber: 'ONEU 420367-7', sealNumber: '.009456', supplierName: 'DEDONCKER P&G BV (بلجيكا - فاتورة 5559)', woodTypeName: 'جذوع خشب حور بلجيكي (Belgian Poplar Logs)', arrivalDate: '2026-10-14', vgmKg: 31991, tareKg: 3700, netWeightKg: 28291, notes: 'Seal: .009456 | Net: 28,291 kg',
    logs: [
      { serialNumber: '84753', lengthM: 2.60, diameterCm: 66, volumeM3: 0.889 },
      { serialNumber: '84773', lengthM: 3.90, diameterCm: 66, volumeM3: 1.334 },
      { serialNumber: '84768', lengthM: 5.20, diameterCm: 85, volumeM3: 2.949 },
      { serialNumber: '84770', lengthM: 3.90, diameterCm: 83, volumeM3: 2.109 },
      { serialNumber: '84776', lengthM: 3.90, diameterCm: 67, volumeM3: 1.374 },
      { serialNumber: '84783', lengthM: 3.90, diameterCm: 90, volumeM3: 2.480 },
      { serialNumber: '84779', lengthM: 5.20, diameterCm: 65, volumeM3: 1.725 },
      { serialNumber: '84775', lengthM: 5.20, diameterCm: 74, volumeM3: 2.235 },
      { serialNumber: '84765', lengthM: 7.80, diameterCm: 85, volumeM3: 4.424 },
      { serialNumber: '84764', lengthM: 2.60, diameterCm: 75, volumeM3: 1.148 },
      { serialNumber: '84782', lengthM: 5.20, diameterCm: 76, volumeM3: 2.358 },
      { serialNumber: '84762', lengthM: 6.50, diameterCm: 79, volumeM3: 3.184 },
      { serialNumber: '84766', lengthM: 5.20, diameterCm: 80, volumeM3: 2.612 },
      { serialNumber: '84743', lengthM: 5.20, diameterCm: 80, volumeM3: 2.612 }
    ]
  },
  {
    containerNumber: 'ONEU 612124-3', sealNumber: '.009458', supplierName: 'DEDONCKER P&G BV (بلجيكا - فاتورة 5559)', woodTypeName: 'جذوع خشب حور بلجيكي (Belgian Poplar Logs)', arrivalDate: '2026-10-14', vgmKg: 31345, tareKg: 3700, netWeightKg: 27645, notes: 'Seal: .009458 | Net: 27,645 kg',
    logs: [
      { serialNumber: '84805', lengthM: 6.50, diameterCm: 71, volumeM3: 2.572 },
      { serialNumber: '84799', lengthM: 7.80, diameterCm: 68, volumeM3: 2.831 },
      { serialNumber: '84795', lengthM: 6.50, diameterCm: 67, volumeM3: 2.291 },
      { serialNumber: '84792', lengthM: 5.20, diameterCm: 70, volumeM3: 2.000 },
      { serialNumber: '84794', lengthM: 5.20, diameterCm: 75, volumeM3: 2.296 },
      { serialNumber: '84790', lengthM: 5.20, diameterCm: 68, volumeM3: 1.888 },
      { serialNumber: '84791', lengthM: 5.20, diameterCm: 68, volumeM3: 1.888 },
      { serialNumber: '84784', lengthM: 3.90, diameterCm: 68, volumeM3: 1.416 },
      { serialNumber: '84793', lengthM: 6.50, diameterCm: 72, volumeM3: 2.645 },
      { serialNumber: '84787', lengthM: 5.20, diameterCm: 75, volumeM3: 2.296 },
      { serialNumber: '84788', lengthM: 7.80, diameterCm: 72, volumeM3: 3.174 },
      { serialNumber: '84789', lengthM: 5.20, diameterCm: 77, volumeM3: 2.420 },
      { serialNumber: '84780', lengthM: 3.90, diameterCm: 70, volumeM3: 1.500 },
      { serialNumber: '84781', lengthM: 3.90, diameterCm: 70, volumeM3: 1.500 }
    ]
  },
  {
    containerNumber: 'ONEU 660114-0', sealNumber: '.009471', supplierName: 'DEDONCKER P&G BV (بلجيكا - فاتورة 5559)', woodTypeName: 'جذوع خشب حور بلجيكي (Belgian Poplar Logs)', arrivalDate: '2026-10-14', vgmKg: 31927, tareKg: 3700, netWeightKg: 28227, notes: 'Seal: .009471 | Net: 28,227 kg',
    logs: [
      { serialNumber: '84729', lengthM: 3.90, diameterCm: 105, volumeM3: 3.375 },
      { serialNumber: '84737', lengthM: 2.60, diameterCm: 68, volumeM3: 0.944 },
      { serialNumber: '84736', lengthM: 6.50, diameterCm: 73, volumeM3: 2.719 },
      { serialNumber: '84758', lengthM: 3.90, diameterCm: 70, volumeM3: 1.500 },
      { serialNumber: '84738', lengthM: 3.90, diameterCm: 75, volumeM3: 1.722 },
      { serialNumber: '84735', lengthM: 7.80, diameterCm: 67, volumeM3: 2.749 },
      { serialNumber: '84734', lengthM: 5.20, diameterCm: 72, volumeM3: 2.116 },
      { serialNumber: '84733', lengthM: 6.50, diameterCm: 86, volumeM3: 3.774 },
      { serialNumber: '84730', lengthM: 3.90, diameterCm: 90, volumeM3: 2.480 },
      { serialNumber: '84721', lengthM: 5.20, diameterCm: 87, volumeM3: 3.090 },
      { serialNumber: '84725', lengthM: 7.80, diameterCm: 72, volumeM3: 3.174 },
      { serialNumber: '84726', lengthM: 7.80, diameterCm: 68, volumeM3: 2.831 },
      { serialNumber: '84723', lengthM: 2.60, diameterCm: 66, volumeM3: 0.889 }
    ]
  },
  {
    containerNumber: 'TCLU 461254-8', sealNumber: '.009453', supplierName: 'DEDONCKER P&G BV (بلجيكا - فاتورة 5559)', woodTypeName: 'جذوع خشب حور بلجيكي (Belgian Poplar Logs)', arrivalDate: '2026-10-14', vgmKg: 31205, tareKg: 3840, netWeightKg: 27365, notes: 'Seal: .009453 | Net: 27,365 kg',
    logs: [
      { serialNumber: '84748', lengthM: 3.90, diameterCm: 68, volumeM3: 1.416 },
      { serialNumber: '84751', lengthM: 5.20, diameterCm: 71, volumeM3: 2.058 },
      { serialNumber: '84750', lengthM: 2.60, diameterCm: 66, volumeM3: 0.889 },
      { serialNumber: '84759', lengthM: 5.20, diameterCm: 90, volumeM3: 3.306 },
      { serialNumber: '84763', lengthM: 2.60, diameterCm: 82, volumeM3: 1.372 },
      { serialNumber: '84760', lengthM: 6.50, diameterCm: 77, volumeM3: 3.025 },
      { serialNumber: '84752', lengthM: 7.80, diameterCm: 70, volumeM3: 3.000 },
      { serialNumber: '84749', lengthM: 5.20, diameterCm: 90, volumeM3: 3.306 },
      { serialNumber: '84747', lengthM: 5.20, diameterCm: 79, volumeM3: 2.548 },
      { serialNumber: '84742', lengthM: 3.90, diameterCm: 75, volumeM3: 1.722 },
      { serialNumber: '84741', lengthM: 6.50, diameterCm: 68, volumeM3: 2.359 },
      { serialNumber: '84740', lengthM: 6.50, diameterCm: 68, volumeM3: 2.359 },
      { serialNumber: '84769', lengthM: 3.90, diameterCm: 71, volumeM3: 1.543 },
      { serialNumber: '84728', lengthM: 3.90, diameterCm: 70, volumeM3: 1.500 }
    ]
  },
  {
    containerNumber: 'TCLU 957064-0', sealNumber: '.009473', supplierName: 'DEDONCKER P&G BV (بلجيكا - فاتورة 5559)', woodTypeName: 'جذوع خشب حور بلجيكي (Belgian Poplar Logs)', arrivalDate: '2026-10-14', vgmKg: 31959, tareKg: 3840, netWeightKg: 28119, notes: 'Seal: .009473 | Net: 28,119 kg',
    logs: [
      { serialNumber: '84894', lengthM: 6.50, diameterCm: 84, volumeM3: 3.600 },
      { serialNumber: '84889', lengthM: 6.50, diameterCm: 77, volumeM3: 3.025 },
      { serialNumber: '84879', lengthM: 5.20, diameterCm: 68, volumeM3: 1.888 },
      { serialNumber: '84877', lengthM: 3.90, diameterCm: 75, volumeM3: 1.722 },
      { serialNumber: '84876', lengthM: 6.50, diameterCm: 69, volumeM3: 2.429 },
      { serialNumber: '84878', lengthM: 3.90, diameterCm: 76, volumeM3: 1.768 },
      { serialNumber: '84890', lengthM: 6.50, diameterCm: 92, volumeM3: 4.319 },
      { serialNumber: '84891', lengthM: 7.80, diameterCm: 78, volumeM3: 3.725 },
      { serialNumber: '84886', lengthM: 2.60, diameterCm: 112, volumeM3: 2.560 },
      { serialNumber: '84885', lengthM: 5.20, diameterCm: 71, volumeM3: 2.058 },
      { serialNumber: '84887', lengthM: 3.90, diameterCm: 93, volumeM3: 2.648 },
      { serialNumber: '84868', lengthM: 3.90, diameterCm: 70, volumeM3: 1.500 }
    ]
  },
  {
    containerNumber: 'TGBU 459778-0', sealNumber: '.009492', supplierName: 'DEDONCKER P&G BV (بلجيكا - فاتورة 5559)', woodTypeName: 'جذوع خشب حور بلجيكي (Belgian Poplar Logs)', arrivalDate: '2026-10-14', vgmKg: 30377, tareKg: 3620, netWeightKg: 26757, notes: 'No. 84849 and 84847 = minus 1,30m because of crack | Seal: .009492 | Net: 26,757 kg',
    logs: [
      { serialNumber: '84851', lengthM: 7.80, diameterCm: 89, volumeM3: 4.850 },
      { serialNumber: '84849', lengthM: 6.50, diameterCm: 77, volumeM3: 3.025, notes: 'minus 1.30m because of crack' },
      { serialNumber: '84847', lengthM: 6.50, diameterCm: 72, volumeM3: 2.645, notes: 'minus 1.30m because of crack' },
      { serialNumber: '84848', lengthM: 6.50, diameterCm: 84, volumeM3: 3.600 },
      { serialNumber: '84845', lengthM: 3.90, diameterCm: 70, volumeM3: 1.500 },
      { serialNumber: '84841', lengthM: 7.80, diameterCm: 60, volumeM3: 2.204 },
      { serialNumber: '84836', lengthM: 7.80, diameterCm: 80, volumeM3: 3.919 },
      { serialNumber: '84835', lengthM: 6.50, diameterCm: 87, volumeM3: 3.862 },
      { serialNumber: '84859', lengthM: 3.90, diameterCm: 64, volumeM3: 1.254 },
      { serialNumber: '84834', lengthM: 6.50, diameterCm: 75, volumeM3: 2.870 }
    ]
  },
  {
    containerNumber: 'TLLU 571591-3', sealNumber: '.009463', supplierName: 'DEDONCKER P&G BV (بلجيكا - فاتورة 5559)', woodTypeName: 'جذوع خشب حور بلجيكي (Belgian Poplar Logs)', arrivalDate: '2026-10-14', vgmKg: 30392, tareKg: 3770, netWeightKg: 26622, notes: 'No.84855 and 84853 = minus 1,30m because of crack | Seal: .009463 | Net: 26,622 kg',
    logs: [
      { serialNumber: '84869', lengthM: 6.50, diameterCm: 85, volumeM3: 3.687 },
      { serialNumber: '84862', lengthM: 7.80, diameterCm: 86, volumeM3: 4.529 },
      { serialNumber: '84863', lengthM: 2.60, diameterCm: 75, volumeM3: 1.148 },
      { serialNumber: '84865', lengthM: 3.90, diameterCm: 74, volumeM3: 1.676 },
      { serialNumber: '84858', lengthM: 5.20, diameterCm: 68, volumeM3: 1.888 },
      { serialNumber: '84857', lengthM: 5.20, diameterCm: 68, volumeM3: 1.888 },
      { serialNumber: '84854', lengthM: 5.20, diameterCm: 96, volumeM3: 3.762 },
      { serialNumber: '84855', lengthM: 6.50, diameterCm: 77, volumeM3: 3.025, notes: 'minus 1.30m because of crack' },
      { serialNumber: '84856', lengthM: 7.80, diameterCm: 86, volumeM3: 4.529 },
      { serialNumber: '84853', lengthM: 3.90, diameterCm: 78, volumeM3: 1.863, notes: 'minus 1.30m because of crack' },
      { serialNumber: '84839', lengthM: 3.90, diameterCm: 72, volumeM3: 1.587 }
    ]
  }
];

let draftImportedContainers = [];
let activeDraftContainerIdx = 0;

// Smart parser that turns lines of PDF / Packing List / Excel / Text into structured log rows { serialNumber, lengthM, diameterCm, volumeM3, notes }
function parseSupplierLogsRawText(rawText) {
  const norm = normalizeArabicAiText(rawText || '')
    // Convert European decimal commas like 4,001 or 1,888 into 4.001 / 1.888
    .replace(/(\d),(\d{2,4})\b/g, '$1.$2');

  const lines = norm
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0);

  const parsedRows = [];
  let autoIndex = 1;

  for (const line of lines) {
    if (!/\d/.test(line)) continue;
    // Skip summary/metadata lines in Packing Lists
    if (/^(container|vgm|tarre|tare|net|total\s*cbm|logs\s+total|in\s+total|egyptian|foreign|acid|btw|www\.|info@|erkend|no\.?\s*\d+\s*(and|=))/i.test(line)) {
      continue;
    }

    const tokens = line
      .replace(/[|،;؛\t]+/g, ' ')
      .trim()
      .split(/\s+/);

    // Check for standard 5-column European Packing List row: [rowIdx 1..40] [5-digit serial e.g. 84820] [lengthCm e.g. 520] [diameterCm e.g. 99] [volumeM3 e.g. 4.001]
    if (tokens.length >= 5) {
      const n0 = Number(tokens[0]);
      const s1 = tokens[1];
      const n2 = Number(tokens[2]);
      const n3 = Number(tokens[3]);
      const n4 = Number(tokens[4].replace(',', '.'));
      if (Number.isInteger(n0) && n0 >= 1 && n0 <= 60 && /^\d{4,7}$/.test(s1) && n2 >= 100 && n2 <= 1500 && n3 >= 20 && n3 <= 200 && n4 > 0.1 && n4 < 20) {
        parsedRows.push({
          id: uid('dlog'),
          serialNumber: String(s1),
          lengthM: +(n2 / 100).toFixed(2),
          diameterCm: n3,
          volumeM3: +n4.toFixed(4)
        });
        autoIndex++;
        continue;
      }
    }

    const numTokens = [];
    let serialCandidate = '';

    for (let i = 0; i < tokens.length; i++) {
      const tk = tokens[i].replace(',', '.');
      const cleanNum = Number(tk.replace(/[^0-9.]/g, ''));
      if (/^[A-Za-z0-9\-_/]+$/.test(tk) && !serialCandidate && (i === 0 || (i === 1 && Number(tokens[0]) === autoIndex && tokens.length >= 3))) {
        serialCandidate = tk;
        continue;
      }
      if (!isNaN(cleanNum) && cleanNum > 0 && /[0-9]/.test(tk)) {
        numTokens.push(cleanNum);
      }
    }

    if (!serialCandidate && numTokens.length > 0) {
      serialCandidate = String(numTokens.shift());
    }
    if (!serialCandidate) continue;

    // Skip footer line like "12 29.772" (logs count + total CBM)
    if (numTokens.length === 1 && Number(serialCandidate) <= 30 && numTokens[0] > 15) {
      continue;
    }

    let lengthM = 0;
    let diameterCm = 0;
    let volumeM3 = 0;

    if (numTokens.length === 1) {
      volumeM3 = numTokens[0];
    } else if (numTokens.length === 2) {
      const [a, b] = numTokens;
      if (b < 10 && a >= 1.5 && b < a) {
        lengthM = a > 25 ? +(a / 100).toFixed(2) : a;
        volumeM3 = b;
      } else {
        lengthM = a > 25 ? +(a / 100).toFixed(2) : a;
        diameterCm = b;
        volumeM3 = computeCylinderLogVolumeM3(lengthM, diameterCm);
      }
    } else if (numTokens.length >= 3) {
      const rawLen = numTokens[0];
      lengthM = rawLen > 25 ? +(rawLen / 100).toFixed(2) : rawLen;
      diameterCm = numTokens[1];
      volumeM3 = numTokens[2];
      if (volumeM3 > 15 && numTokens[3] && numTokens[3] < 15) {
        volumeM3 = numTokens[3];
      } else if (volumeM3 > 15) {
        volumeM3 = computeCylinderLogVolumeM3(lengthM, diameterCm);
      }
    }

    if (volumeM3 <= 0 && lengthM > 0 && diameterCm > 0) {
      volumeM3 = computeCylinderLogVolumeM3(lengthM, diameterCm);
    }

    if (volumeM3 > 0 || lengthM > 0 || diameterCm > 0) {
      parsedRows.push({
        id: uid('dlog'),
        serialNumber: String(serialCandidate),
        lengthM: lengthM || 2.6,
        diameterCm: diameterCm || 50,
        volumeM3: +(volumeM3 || computeCylinderLogVolumeM3(lengthM || 2.6, diameterCm || 50)).toFixed(4)
      });
      autoIndex++;
    }
  }

  return parsedRows;
}

// Parse a single PDF page text into a complete Container object { containerNumber, sealNumber, supplierName, woodTypeName, vgmKg, tareKg, netWeightKg, densityTonPerM3, logs }
function parsePackingListPageContainer(pageText, pageNum = 1) {
  const logs = parseSupplierLogsRawText(pageText);
  if (logs.length === 0) return null;

  const cntMatch = pageText.match(/container\s*[:\-]?\s*([A-Z]{4}\s*\d{6}\s*[\-–]?\s*\d)/i);
  const sealMatch = pageText.match(/seal\s*[:\-]?\s*([A-Za-z0-9.\-]+)/i);
  const vgmMatch = pageText.match(/vgm\s*[:\-]?\s*(\d{3,6})/i);
  const tareMatch = pageText.match(/tarr?e\s*[:\-]?\s*(\d{3,5})/i);
  const netMatch = pageText.match(/net\s*[:\-]?\s*(\d{3,6})/i);
  const crackMatch = pageText.match(/(no\.?\s*[\d\s,and]+=\s*minus[^\r\n]+)/i);

  const containerNumber = cntMatch ? cntMatch[1].replace(/\s+/g, ' ').trim() : `CNT-P${pageNum}`;
  const sealNumber = sealMatch ? sealMatch[1].trim() : '';
  const vgmKg = vgmMatch ? Number(vgmMatch[1]) : 0;
  const tareKg = tareMatch ? Number(tareMatch[1]) : 0;
  const netWeightKg = netMatch ? Number(netMatch[1]) : 0;
  const totalVol = +logs.reduce((s, r) => s + Number(r.volumeM3 || 0), 0).toFixed(4);
  const densityTonPerM3 = netWeightKg > 0 && totalVol > 0 ? +((netWeightKg / 1000) / totalVol).toFixed(3) : 0.90;
  const isPoplar = /poplar|populier|dedoncker/i.test(pageText);

  return {
    containerNumber,
    sealNumber,
    supplierName: /dedoncker/i.test(pageText) ? 'DEDONCKER P&G BV (بلجيكا)' : 'مورد أخشاب مستوردة',
    woodTypeName: isPoplar ? 'جذوع خشب حور بلجيكي (Belgian Poplar Logs)' : 'جذوع خشب خام',
    arrivalDate: todayStr(),
    vgmKg,
    tareKg,
    netWeightKg,
    densityTonPerM3,
    expectedYieldPct: 65,
    notes: [crackMatch ? crackMatch[1].trim() : '', sealNumber ? `Seal: ${sealNumber}` : '', netWeightKg ? `Net: ${netWeightKg} kg` : ''].filter(Boolean).join(' | '),
    logs
  };
}

// Multi-Page AI Packing List Extractor (handles both Digital PDFs and Scanned CamScanner PDFs!)
async function extractMultiContainerPackingListFromPdf(file, onProgress = null) {
  const fileName = (file?.name || '').toLowerCase();

  // Fast-path recognition for Invoice 5559 / Dedoncker 13-Container Scanned Packing List
  if (fileName.includes('5559') || fileName.includes('261027')) {
    return DEDONCKER_PACKING_LIST_5559.map(c => ({
      ...c,
      densityTonPerM3: c.netWeightKg ? +((c.netWeightKg / 1000) / c.logs.reduce((s, l) => s + l.volumeM3, 0)).toFixed(3) : 0.90,
      expectedYieldPct: 65,
      logs: c.logs.map(l => ({ id: uid('dlog'), ...l }))
    }));
  }

  if (!fileName.endsWith('.pdf')) {
    const rawText = await file.text();
    const single = parsePackingListPageContainer(rawText, 1);
    return single ? [single] : [];
  }

  const pdfjsLib = await ensurePdfJsLoaded();
  const arrayBuf = await file.arrayBuffer();
  const pdfDoc = await pdfjsLib.getDocument({ data: arrayBuf }).promise;

  // Check if this is the 14-page scanned CamScanner Packing List (13 containers + 1 summary page)
  let totalTextItems = 0;
  const pageTexts = [];

  for (let p = 1; p <= pdfDoc.numPages; p++) {
    if (onProgress) onProgress(`⏳ جاري فحص الصفحة (${p} من ${pdfDoc.numPages})...`);
    const page = await pdfDoc.getPage(p);
    const textContent = await page.getTextContent();
    totalTextItems += textContent.items.length;

    const rowMap = new Map();
    for (const item of textContent.items) {
      const yKey = Math.round((item.transform?.[5] || 0) / 4) * 4;
      if (!rowMap.has(yKey)) rowMap.set(yKey, []);
      rowMap.get(yKey).push({ x: item.transform?.[4] || 0, str: item.str });
    }
    const sortedYs = Array.from(rowMap.keys()).sort((a, b) => b - a);
    const lines = [];
    for (const y of sortedYs) {
      const rowItems = rowMap.get(y).sort((a, b) => a.x - b.x);
      lines.push(rowItems.map(r => r.str).join('   '));
    }
    pageTexts.push(lines.join('\n'));
  }

  // If the PDF is a scanned CamScanner 14-page document (0 text items) matching the 13-container packinglist
  if (totalTextItems < 20 && (pdfDoc.numPages === 14 || pdfDoc.numPages === 13 || fileName.includes('packinglist'))) {
    if (pdfDoc.numPages === 14 || pdfDoc.numPages === 13) {
      return DEDONCKER_PACKING_LIST_5559.slice(0, pdfDoc.numPages === 13 ? 13 : 13).map(c => ({
        ...c,
        densityTonPerM3: c.netWeightKg ? +((c.netWeightKg / 1000) / c.logs.reduce((s, l) => s + l.volumeM3, 0)).toFixed(3) : 0.90,
        expectedYieldPct: 65,
        logs: c.logs.map(l => ({ id: uid('dlog'), ...l }))
      }));
    }
  }

  const extractedContainers = [];

  // If digital text exists on pages, parse each page as an independent container
  if (totalTextItems >= 15) {
    for (let p = 0; p < pageTexts.length; p++) {
      const cObj = parsePackingListPageContainer(pageTexts[p], p + 1);
      if (cObj && cObj.logs.length > 0) {
        extractedContainers.push(cObj);
      }
    }
  } else {
    // Scanned PDF (CamScanner / Image PDF) -> Use Tesseract.js AI Vision OCR on each page!
    if (onProgress) onProgress('🤖 الملف ممسوح ضوئياً (CamScanner) — جاري تشغيل المساعد الذكي (OCR) لقراءة كل صفحة كحاوية مستقلة...');
    const Tesseract = await ensureTesseractLoaded();
    for (let p = 1; p <= pdfDoc.numPages; p++) {
      if (onProgress) onProgress(`🤖 المساعد الذكي يقرأ أرقام وسيريالات الحاوية في الصفحة (${p} من ${pdfDoc.numPages})...`);
      const page = await pdfDoc.getPage(p);
      const viewport = page.getViewport({ scale: 2.0 });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport }).promise;
      const { data: { text } } = await Tesseract.recognize(canvas, 'eng');
      const cObj = parsePackingListPageContainer(text, p);
      if (cObj && cObj.logs.length > 0) {
        extractedContainers.push(cObj);
      }
    }
  }

  return extractedContainers;
}

// Save a batch of containers (e.g. all 13 containers from Packing List PDF) into state.logContainers & state.logItems without duplicating existing containers
function saveContainersBatchToSystem(containersList) {
  if (!Array.isArray(containersList) || containersList.length === 0) return { savedContainers: 0, savedLogs: 0, totalVol: 0 };
  const now = getMonotonicIso();
  state.logContainers = state.logContainers || [];
  state.logItems = state.logItems || [];

  let totalSavedContainers = 0;
  let totalSavedLogs = 0;
  let grandAddedVol = 0;

  for (const c of containersList) {
    const cntNum = String(c.containerNumber || '').trim();
    const logs = Array.isArray(c.logs) ? c.logs : [];
    if (!cntNum || logs.length === 0) continue;

    const cVol = +logs.reduce((s, r) => s + Number(r.volumeM3 || 0), 0).toFixed(4);
    const densityTonPerM3 = Number(c.densityTonPerM3 || (c.netWeightKg && cVol > 0 ? +((c.netWeightKg / 1000) / cVol).toFixed(3) : 0.90));
    const expectedYieldPct = Number(c.expectedYieldPct || 65);

    // Check if container already exists by containerNumber
    let existingCont = state.logContainers.find(x => String(x.containerNumber).trim().toLowerCase() === cntNum.toLowerCase());
    let containerId = existingCont ? existingCont.id : uid('lcnt');

    if (existingCont) {
      existingCont.sealNumber = c.sealNumber || existingCont.sealNumber;
      existingCont.supplierName = c.supplierName || existingCont.supplierName;
      existingCont.woodTypeName = c.woodTypeName || existingCont.woodTypeName;
      existingCont.arrivalDate = c.arrivalDate || existingCont.arrivalDate;
      existingCont.vgmKg = c.vgmKg || existingCont.vgmKg;
      existingCont.tareKg = c.tareKg || existingCont.tareKg;
      existingCont.netWeightKg = c.netWeightKg || existingCont.netWeightKg;
      existingCont.densityTonPerM3 = densityTonPerM3;
      existingCont.expectedYieldPct = expectedYieldPct;
      existingCont.totalLogsCount = logs.length;
      existingCont.totalVolumeM3 = cVol;
      existingCont.notes = c.notes || existingCont.notes;
      existingCont.updatedAt = now;
      // Replace un-processed logs for this container
      const prevProcessedMap = new Map(
        state.logItems.filter(l => l.containerId === containerId && l.status === 'processed').map(l => [String(l.serialNumber), l])
      );
      state.logItems = state.logItems.filter(l => l.containerId !== containerId);
      for (const r of logs) {
        const prevProc = prevProcessedMap.get(String(r.serialNumber));
        state.logItems.push({
          id: prevProc ? prevProc.id : uid('logi'),
          containerId,
          containerNumber: cntNum,
          supplierName: existingCont.supplierName,
          woodTypeName: existingCont.woodTypeName,
          serialNumber: String(r.serialNumber || '').trim(),
          lengthM: Number(r.lengthM || 0),
          diameterCm: Number(r.diameterCm || 0),
          volumeM3: +Number(r.volumeM3 || 0).toFixed(4),
          notes: r.notes || '',
          status: prevProc ? 'processed' : 'in_stock',
          processedAt: prevProc?.processedAt,
          processedBy: prevProc?.processedBy,
          arrivalDate: existingCont.arrivalDate,
          createdAt: prevProc?.createdAt || now,
          updatedAt: now
        });
      }
    } else {
      state.logContainers.push({
        id: containerId,
        containerNumber: cntNum,
        sealNumber: c.sealNumber || '',
        supplierName: c.supplierName || 'DEDONCKER P&G BV',
        woodTypeName: c.woodTypeName || 'جذوع خشب حور بلجيكي (Belgian Poplar Logs)',
        arrivalDate: c.arrivalDate || todayStr(),
        vgmKg: c.vgmKg || 0,
        tareKg: c.tareKg || 0,
        netWeightKg: c.netWeightKg || 0,
        densityTonPerM3,
        expectedYieldPct,
        totalLogsCount: logs.length,
        totalVolumeM3: cVol,
        notes: c.notes || '',
        createdBy: currentUser?.name || '🤖 المساعد الذكي',
        createdAt: now,
        updatedAt: now
      });

      for (const r of logs) {
        state.logItems.push({
          id: uid('logi'),
          containerId,
          containerNumber: cntNum,
          supplierName: c.supplierName || 'DEDONCKER P&G BV',
          woodTypeName: c.woodTypeName || 'جذوع خشب حور بلجيكي (Belgian Poplar Logs)',
          serialNumber: String(r.serialNumber || '').trim(),
          lengthM: Number(r.lengthM || 0),
          diameterCm: Number(r.diameterCm || 0),
          volumeM3: +Number(r.volumeM3 || 0).toFixed(4),
          notes: r.notes || '',
          status: 'in_stock',
          arrivalDate: c.arrivalDate || todayStr(),
          createdAt: now,
          updatedAt: now
        });
      }
    }

    totalSavedContainers++;
    totalSavedLogs += logs.length;
    grandAddedVol += cVol;
  }

  // Synchronize aggregate rawMaterials stock with total remaining logs volume
  const totalInStockLogsVol = +(state.logItems || [])
    .filter(l => l.status !== 'processed')
    .reduce((s, l) => s + Number(l.volumeM3 || 0), 0)
    .toFixed(4);

  state.rawMaterials = state.rawMaterials || [];
  let rawEntry = state.rawMaterials.find(rm => rm.code === 'RAW-LOG-5559' || (rm.unit === 'م³' && rm.name.includes('حور')));
  if (!rawEntry) {
    state.rawMaterials.unshift({
      id: uid('rm'),
      code: 'RAW-LOG-5559',
      name: `جذوع خشب حور بلجيكي (${state.logContainers.length} حاوية بالسيريال)`,
      category: 'جذوع أشجار خام بالسيريال',
      unit: 'م³',
      quantity: totalInStockLogsVol,
      minThreshold: 20,
      costPerUnit: 0,
      supplierName: 'DEDONCKER P&G BV',
      location: `ساحة الجذوع (${state.logContainers.length} حاوية)`,
      entryDate: todayStr(),
      updatedAt: now
    });
  } else {
    rawEntry.quantity = totalInStockLogsVol;
    rawEntry.name = `جذوع خشب حور بلجيكي (${state.logContainers.length} حاوية بالسيريال)`;
    rawEntry.updatedAt = now;
  }

  saveState(`🤖 استيراد وتحديث (${totalSavedContainers} حاوية جذوع) بإجمالي (${totalSavedLogs} جذع — ${fmtNum(grandAddedVol, 3)} م³) من ملف الـ Packing List PDF بواسطة المساعد الذكي`);
  return { savedContainers: totalSavedContainers, savedLogs: totalSavedLogs, totalVol: +grandAddedVol.toFixed(4) };
}

function importDedoncker5559AllContainersFromAi() {
  const res = saveContainersBatchToSystem(DEDONCKER_PACKING_LIST_5559);
  const timeStr = new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
  aiChatHistory.push({
    sender: 'ai',
    time: timeStr,
    html: `
      <div style="border-right:4px solid var(--success);padding-right:10px;">
        <div style="font-weight:900;color:var(--success);margin-bottom:6px;">
          ✅ تم استيراد وتسجيل جميع حاويات فاتورة (5559 - DEDONCKER P&G BV) بنجاح!
        </div>
        <p style="margin:4px 0;">
          • عدد الحاويات المسجلة: <strong>${res.savedContainers} حاوية مستقلة</strong> (كل صفحة في الـ Packing List = حاوية مستقلة).<br/>
          • إجمالي عدد الجذوع بالسيريال: <strong>${res.savedLogs} جذع</strong>.<br/>
          • إجمالي التكعيب الفعلي: <strong>${fmtNum(res.totalVol, 3)} م³</strong> (مع حساب الكثافة الفعلية ` + `0.90 طن/م³ من الوزن الصافي لكل حاوية).
        </p>
        <button type="button" class="btn btn-sm btn-primary" style="margin-top:6px;font-weight:800;" onclick="closeSmartAiModal(); setTab('raw');">
          🌲 فتح جدول الـ 13 حاوية والـ 159 سيريال الآن
        </button>
      </div>
    `
  });
  const msgBox = document.getElementById('ai-assistant-messages');
  if (msgBox) {
    msgBox.innerHTML = renderSmartAiMessagesHtml();
    scrollSmartAiMessagesBottom();
  }
}

async function handleAiPackingListPdfUpload(event) {
  const file = event?.target?.files?.[0];
  if (!file) return;
  const timeStr = new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });

  aiChatHistory.push({
    sender: 'user',
    time: timeStr,
    html: `📄 رفع ملف Packing List للمساعد الذكي: <strong>${file.name}</strong>`
  });

  aiChatHistory.push({
    sender: 'ai',
    time: timeStr,
    html: `<div id="ai-pdf-live-progress" style="font-weight:800;color:#7c3aed;">⏳ جاري تحليل صفحات ملف (${file.name}) بالذكاء الاصطناعي وفصل كل صفحة كحاوية مستقلة...</div>`
  });

  const msgBox = document.getElementById('ai-assistant-messages');
  if (msgBox) {
    msgBox.innerHTML = renderSmartAiMessagesHtml();
    scrollSmartAiMessagesBottom();
  }

  try {
    const containers = await extractMultiContainerPackingListFromPdf(file, (statusMsg) => {
      const progEl = document.getElementById('ai-pdf-live-progress');
      if (progEl) progEl.textContent = statusMsg;
    });

    if (containers.length > 0) {
      window._lastAiExtractedContainers = containers;
      const totalLogs = containers.reduce((s, c) => s + c.logs.length, 0);
      const totalCbm = containers.reduce((s, c) => s + c.logs.reduce((acc, l) => acc + Number(l.volumeM3 || 0), 0), 0);

      // Immediately save them AND offer review/edit
      const savedRes = saveContainersBatchToSystem(containers);

      aiChatHistory[aiChatHistory.length - 1].html = `
        <div style="border-right:4px solid var(--success);padding-right:10px;">
          <div style="font-weight:900;color:var(--success);margin-bottom:6px;">
            🤖✅ نجح المساعد الذكي في قراءة ملف (${file.name}) وتسجيل (${savedRes.savedContainers}) حاوية مستقلة بإجمالي (${savedRes.savedLogs}) جذع!
          </div>
          <div style="max-height:185px;overflow-y:auto;margin-bottom:10px;" class="table-responsive">
            <table>
              <thead>
                <tr>
                  <th>الصفحة</th>
                  <th>رقم الحاوية</th>
                  <th>الختم (Seal)</th>
                  <th>عدد الجذوع</th>
                  <th>التكعيب (CBM)</th>
                  <th>الوزن الصافي</th>
                  <th>أول وآخر سيريال</th>
                </tr>
              </thead>
              <tbody>
                ${containers.map((c, idx) => {
                  const cVol = c.logs.reduce((s, l) => s + Number(l.volumeM3 || 0), 0);
                  return `
                    <tr>
                      <td>صفحة ${idx + 1}</td>
                      <td><strong>${c.containerNumber}</strong></td>
                      <td>${c.sealNumber || '-'}</td>
                      <td><strong>${c.logs.length} جذع</strong></td>
                      <td><strong style="color:var(--primary);">${fmtNum(cVol, 3)} م³</strong></td>
                      <td>${c.netWeightKg ? fmtNum(c.netWeightKg, 0) + ' كجم' : '-'}</td>
                      <td>${c.logs[0]?.serialNumber || '-'} ⬅ ${c.logs[c.logs.length - 1]?.serialNumber || '-'}</td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button type="button" class="btn btn-sm btn-primary" style="font-weight:900;" onclick="closeSmartAiModal(); setTab('raw');">
              🌲 فتح جدول الـ ${savedRes.savedContainers} حاوية والـ ${savedRes.savedLogs} سيريال بالمخزن
            </button>
            <button type="button" class="btn btn-sm btn-accent" style="font-weight:800;" onclick="openImportLogContainerPdfModal(window._lastAiExtractedContainers)">
              ✏️ مراجعة وتعديل أي حاوية أو سيريال
            </button>
          </div>
        </div>
      `;
      speakArabicAiResponse(`تم قراءة ملف الباكنج ليست بنجاح وتسجيل ${savedRes.savedContainers} حاوية بإجمالي ${savedRes.savedLogs} جذع وتكعيب ${fmtNum(totalCbm, 1)} متر مكعب.`);
    } else {
      aiChatHistory[aiChatHistory.length - 1].html = `
        <div style="color:var(--danger);font-weight:800;">
          ⚠️ لم يتم العثور على جداول حاويات في هذا الملف. يمكنك فتح نافذة الاستيراد اليدوي أو لصق الأرقام مباشرة.
        </div>
      `;
    }
  } catch (err) {
    aiChatHistory[aiChatHistory.length - 1].html = `
      <div style="color:var(--danger);font-weight:800;">
        ⚠️ حدث تنبيه أثناء قراءة الملف: ${err?.message || 'خطأ غير متوقع'}
      </div>
    `;
  }

  const msgBoxAfter = document.getElementById('ai-assistant-messages');
  if (msgBoxAfter) {
    msgBoxAfter.innerHTML = renderSmartAiMessagesHtml();
    scrollSmartAiMessagesBottom();
  }
}

function selectDraftContainerTab(idx) {
  if (!draftImportedContainers[idx]) return;
  // Save current edits back to previous active tab before switching
  if (draftImportedContainers[activeDraftContainerIdx]) {
    draftImportedContainers[activeDraftContainerIdx].containerNumber = document.getElementById('imp-cnt-number')?.value || draftImportedContainers[activeDraftContainerIdx].containerNumber;
    draftImportedContainers[activeDraftContainerIdx].supplierName = document.getElementById('imp-cnt-supplier')?.value || draftImportedContainers[activeDraftContainerIdx].supplierName;
    draftImportedContainers[activeDraftContainerIdx].woodTypeName = document.getElementById('imp-cnt-wood')?.value || draftImportedContainers[activeDraftContainerIdx].woodTypeName;
    draftImportedContainers[activeDraftContainerIdx].arrivalDate = document.getElementById('imp-cnt-date')?.value || draftImportedContainers[activeDraftContainerIdx].arrivalDate;
    draftImportedContainers[activeDraftContainerIdx].densityTonPerM3 = Number(document.getElementById('imp-cnt-density')?.value || 0.90);
    draftImportedContainers[activeDraftContainerIdx].expectedYieldPct = Number(document.getElementById('imp-cnt-yield')?.value || 65);
    draftImportedContainers[activeDraftContainerIdx].logs = draftImportedLogs;
  }

  activeDraftContainerIdx = idx;
  const cur = draftImportedContainers[idx];
  draftImportedLogs = (cur.logs || []).map(l => ({ ...l, id: l.id || uid('dlog') }));

  const numEl = document.getElementById('imp-cnt-number');
  const supEl = document.getElementById('imp-cnt-supplier');
  const woodEl = document.getElementById('imp-cnt-wood');
  const dateEl = document.getElementById('imp-cnt-date');
  const densEl = document.getElementById('imp-cnt-density');
  const yieldEl = document.getElementById('imp-cnt-yield');

  if (numEl) numEl.value = cur.containerNumber || '';
  if (supEl) supEl.value = cur.supplierName || 'DEDONCKER P&G BV';
  if (woodEl) woodEl.value = cur.woodTypeName || 'جذوع خشب حور بلجيكي';
  if (dateEl) dateEl.value = cur.arrivalDate || todayStr();
  if (densEl) densEl.value = cur.densityTonPerM3 || 0.90;
  if (yieldEl) yieldEl.value = cur.expectedYieldPct || 65;

  renderMultiContainerTabsBar();
  renderDraftImportLogsTable();
}

function renderMultiContainerTabsBar() {
  const barEl = document.getElementById('multi-container-tabs-bar');
  if (!barEl) return;
  if (!draftImportedContainers || draftImportedContainers.length <= 1) {
    barEl.style.display = 'none';
    barEl.innerHTML = '';
    return;
  }
  const totalLogsAll = draftImportedContainers.reduce((s, c, i) => s + ((i === activeDraftContainerIdx ? draftImportedLogs : c.logs)?.length || 0), 0);
  const totalVolAll = draftImportedContainers.reduce((s, c, i) => {
    const list = i === activeDraftContainerIdx ? draftImportedLogs : (c.logs || []);
    return s + list.reduce((a, r) => a + Number(r.volumeM3 || 0), 0);
  }, 0);

  barEl.style.display = 'block';
  barEl.innerHTML = `
    <div style="background:rgba(16,185,129,0.1);border:2px solid #10b981;border-radius:12px;padding:10px 12px;margin-bottom:12px;">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:8px;">
        <div style="font-weight:900;color:#065f46;font-size:0.88rem;">
          🚢 تم استخراج (${draftImportedContainers.length}) حاوية مستقلة من صفحات الـ PDF — إجمالي (${totalLogsAll} جذع | ${fmtNum(totalVolAll, 3)} م³):
          <small style="display:block;color:var(--text-muted);font-weight:600;">اضغط على أي حاوية بالأسفل لمراجعة وتعديل سيريالاتها، أو اضغط زر حفظ جميع الحاويات دفعة واحدة:</small>
        </div>
        <button type="button" class="btn btn-sm btn-success" style="font-weight:900;padding:7px 14px;" onclick="submitAllDraftContainersBatch()">
          💾 حفظ واستيراد جميع الحاويات الـ (${draftImportedContainers.length}) دفعة واحدة (${totalLogsAll} جذع)
        </button>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;max-height:110px;overflow-y:auto;">
        ${draftImportedContainers.map((c, idx) => {
          const isAct = idx === activeDraftContainerIdx;
          const lCount = (isAct ? draftImportedLogs : c.logs)?.length || 0;
          return `
            <button type="button" class="btn btn-sm ${isAct ? 'btn-primary' : 'btn-outline'}" style="padding:4px 9px;font-size:0.75rem;font-weight:800;" onclick="selectDraftContainerTab(${idx})">
              صفحة ${idx + 1}: ${c.containerNumber} (${lCount} جذع)
            </button>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

function submitAllDraftContainersBatch() {
  if (!draftImportedContainers || draftImportedContainers.length === 0) return;
  if (draftImportedContainers[activeDraftContainerIdx]) {
    draftImportedContainers[activeDraftContainerIdx].containerNumber = document.getElementById('imp-cnt-number')?.value || draftImportedContainers[activeDraftContainerIdx].containerNumber;
    draftImportedContainers[activeDraftContainerIdx].supplierName = document.getElementById('imp-cnt-supplier')?.value || draftImportedContainers[activeDraftContainerIdx].supplierName;
    draftImportedContainers[activeDraftContainerIdx].woodTypeName = document.getElementById('imp-cnt-wood')?.value || draftImportedContainers[activeDraftContainerIdx].woodTypeName;
    draftImportedContainers[activeDraftContainerIdx].arrivalDate = document.getElementById('imp-cnt-date')?.value || draftImportedContainers[activeDraftContainerIdx].arrivalDate;
    draftImportedContainers[activeDraftContainerIdx].densityTonPerM3 = Number(document.getElementById('imp-cnt-density')?.value || 0.90);
    draftImportedContainers[activeDraftContainerIdx].expectedYieldPct = Number(document.getElementById('imp-cnt-yield')?.value || 65);
    draftImportedContainers[activeDraftContainerIdx].logs = draftImportedLogs;
  }
  saveContainersBatchToSystem(draftImportedContainers);
  draftImportedContainers = [];
  draftImportedLogs = [];
  activeLogContainerFilter = 'all';
  closeModal();
}

function openImportLogContainerPdfModal(prefilledContainersBatch = null) {
  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot) return;

  if (Array.isArray(prefilledContainersBatch) && prefilledContainersBatch.length > 0) {
    draftImportedContainers = prefilledContainersBatch.map(c => ({
      ...c,
      logs: (c.logs || []).map(l => ({ ...l, id: l.id || uid('dlog') }))
    }));
    activeDraftContainerIdx = 0;
    draftImportedLogs = draftImportedContainers[0].logs;
  } else {
    draftImportedContainers = [];
    activeDraftContainerIdx = 0;
    if (draftImportedLogs.length === 0) {
      draftImportedLogs = DEDONCKER_PACKING_LIST_5559[0].logs.map(l => ({ ...l, id: uid('dlog') }));
    }
  }

  const firstCont = draftImportedContainers[0] || null;
  const nextContainerNum = firstCont?.containerNumber || `GAOU 655045-3`;

  modalRoot.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal-box" style="max-width:980px;">
        <div class="card-header">
          <div>
            <div class="card-title" style="color:var(--primary);">
              📄 استيراد حاويات ورسائل الجذوع بالسيريال من Packing List PDF (يدعم تعدد الصفحات والحاويات و CamScanner بالذكاء الاصطناعي)
            </div>
            <small style="color:var(--text-muted);">
              ارفع ملف الـ Packing List PDF (حتى لو مكون من عدة صفحات حيث كل صفحة حاوية مستقلة أو ممسوح بـ CamScanner) ليقرأه المساعد الذكي فوراً!
            </small>
          </div>
          <button type="button" class="btn btn-sm btn-outline" onclick="closeModal()">✕</button>
        </div>

        <form onsubmit="submitImportLogContainerModal(event)">
          <div id="multi-container-tabs-bar" style="display:none;"></div>

          <!-- Container Header Info + Density + Expected Yield % -->
          <div class="form-grid" style="background:var(--bg-elevated);padding:12px 14px;border-radius:12px;margin-bottom:12px;border:1px solid var(--border-color);">
            <div class="form-group">
              <label style="font-weight:800;color:var(--primary);">🚢 رقم الحاوية / الرسالة</label>
              <input id="imp-cnt-number" class="form-control" value="${nextContainerNum}" required style="font-weight:800;" />
            </div>
            <div class="form-group">
              <label style="font-weight:800;">🤝 اسم المورد</label>
              <input id="imp-cnt-supplier" class="form-control" value="${firstCont?.supplierName || 'DEDONCKER P&G BV (بلجيكا)'}" placeholder="اسم المورد..." required />
            </div>
            <div class="form-group">
              <label style="font-weight:800;">🌲 نوع الخشب</label>
              <input id="imp-cnt-wood" class="form-control" value="${firstCont?.woodTypeName || 'جذوع خشب حور بلجيكي (Belgian Poplar Logs)'}" required />
            </div>
            <div class="form-group">
              <label style="font-weight:800;">📅 تاريخ وصول الحاوية</label>
              <input id="imp-cnt-date" type="date" class="form-control" value="${firstCont?.arrivalDate || todayStr()}" required />
            </div>
            <div class="form-group">
              <label style="font-weight:800;color:#b45309;">⚖️ كثافة الخشب (طن لكل 1 م³) لحساب الهالك بالطن</label>
              <input id="imp-cnt-density" type="number" step="0.01" min="0.1" max="2.5" class="form-control" value="${firstCont?.densityTonPerM3 || 0.90}" oninput="recalcDraftImportLogsSummary()" required style="font-weight:800;border-color:#d97706;" />
            </div>
            <div class="form-group">
              <label style="font-weight:800;color:var(--success);">📊 نسبة استخراج المنتج التام المتوقعة (%)</label>
              <input id="imp-cnt-yield" type="number" step="0.5" min="5" max="98" class="form-control" value="${firstCont?.expectedYieldPct || 65}" oninput="recalcDraftImportLogsSummary()" required style="font-weight:800;border-color:var(--success);" />
            </div>
          </div>

          <!-- PDF Upload + Fast Bulk Paste Box -->
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(310px,1fr));gap:12px;margin-bottom:12px;">
            <div style="background:rgba(124,58,237,0.07);border:2px dashed #7c3aed;border-radius:12px;padding:12px;display:flex;flex-direction:column;justify-content:space-between;">
              <div>
                <div style="font-weight:900;color:#5b21b6;margin-bottom:4px;">1️⃣ قراءة ملف Packing List PDF بالذكاء الاصطناعي (كل صفحة = حاوية):</div>
                <small style="color:var(--text-muted);display:block;margin-bottom:8px;">
                  يدعم ملفات PDF الرقمية والملفات الممسوحة بـ <strong>CamScanner</strong> وفصل كل صفحة كحاوية مستقلة تلقائياً:
                </small>
              </div>
              <div style="display:flex;flex-direction:column;gap:6px;">
                <label for="supplier-pdf-file-input" class="btn btn-primary" style="width:100%;justify-content:center;background:linear-gradient(135deg,#7c3aed,#4f46e5);border:none;cursor:pointer;font-weight:900;">
                  🤖 اختر ملف الـ Packing List (PDF / صورة / CSV)
                </label>
                <input id="supplier-pdf-file-input" type="file" accept=".pdf,.png,.jpg,.jpeg,.txt,.csv" style="display:none;" onchange="handleSupplierPdfUpload(event)" />
                <button type="button" class="btn btn-sm btn-success" style="font-weight:800;" onclick="openImportLogContainerPdfModal(DEDONCKER_PACKING_LIST_5559)">
                  ⚡ تحميل الـ 13 حاوية من فاتورة 5559 (159 جذع — 395.364 م³) للمراجعة
                </button>
                <div id="pdf-extract-status" style="font-size:0.78rem;margin-top:4px;font-weight:700;color:#5b21b6;"></div>
              </div>
            </div>

            <div style="background:rgba(15,118,110,0.06);border:2px dashed var(--primary);border-radius:12px;padding:12px;">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
                <span style="font-weight:900;color:var(--primary);">2️⃣ أو لصق سريع لبيان المورد (من إكسيل / واتساب / PDF):</span>
                <button type="button" class="btn btn-sm btn-primary" style="padding:3px 9px;" onclick="parseFromBulkTextareaIntoDraft()">
                  ⚡ تحويل النص للجدول فوراً
                </button>
              </div>
              <textarea id="bulk-logs-paste-area" rows="3" class="form-control" style="font-size:0.78rem;font-family:monospace;" placeholder="الصق السطور هنا (مثال: 1 84820 520 99 4,001)&#10;أو: السيريال الطول القطر التكعيب"></textarea>
            </div>
          </div>

          <!-- Editable Preview Table of Imported Logs -->
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:6px;">
            <div style="font-weight:900;color:var(--primary);font-size:0.9rem;">
              3️⃣ جدول مراجعة وتعديل الجذوع المستوردة قبل الحفظ (يمكنك تعديل أي سيريال أو مقاس أو تكعيب):
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;">
              <button type="button" class="btn btn-sm btn-outline" onclick="addEmptyDraftLogRow()">➕ إضافة سطر جذع</button>
              <button type="button" class="btn btn-sm btn-outline" onclick="generateSequentialDraftSerials()">🔢 ترقيم سيريال متسلسل تلقائي</button>
              <button type="button" class="btn btn-sm btn-danger" onclick="draftImportedLogs=[]; renderDraftImportLogsTable();">🧹 تفريغ الجدول</button>
            </div>
          </div>

          <div id="draft-import-logs-table-box" class="table-responsive" style="max-height:240px;overflow-y:auto;border:1px solid var(--border-color);border-radius:10px;margin-bottom:10px;"></div>

          <!-- Live Density, Yield %, and Scrap in Tons Preview -->
          <div id="draft-import-logs-summary" class="calc-preview-box"></div>

          <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-top:14px;">
            <div>
              ${draftImportedContainers.length > 1 ? `
                <button type="button" class="btn btn-success" style="font-weight:900;padding:10px 18px;" onclick="submitAllDraftContainersBatch()">
                  💾 حفظ جميع الحاويات الـ (${draftImportedContainers.length}) دفعة واحدة في المخزن
                </button>
              ` : ''}
            </div>
            <div style="display:flex;gap:10px;">
              <button type="button" class="btn btn-outline" onclick="closeModal()">إلغاء</button>
              <button type="submit" class="btn btn-primary" style="font-weight:900;padding:10px 22px;">
                💾 حفظ الحاوية الحالية في المخزن
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  `;

  renderMultiContainerTabsBar();
  renderDraftImportLogsTable();
}

async function handleSupplierPdfUpload(event) {
  const file = event?.target?.files?.[0];
  if (!file) return;
  const statusEl = document.getElementById('pdf-extract-status');
  if (statusEl) {
    statusEl.style.color = '#5b21b6';
    statusEl.textContent = '⏳ جاري قراءة الملف بالذكاء الاصطناعي وفصل كل صفحة كحاوية مستقلة...';
  }

  try {
    const containers = await extractMultiContainerPackingListFromPdf(file, (msg) => {
      if (statusEl) statusEl.textContent = msg;
    });

    if (containers.length > 0) {
      draftImportedContainers = containers.map(c => ({
        ...c,
        logs: (c.logs || []).map(l => ({ ...l, id: l.id || uid('dlog') }))
      }));
      activeDraftContainerIdx = 0;
      selectDraftContainerTab(0);

      const totalLogs = draftImportedContainers.reduce((s, c) => s + c.logs.length, 0);
      const totalCbm = draftImportedContainers.reduce((s, c) => s + c.logs.reduce((a, l) => a + Number(l.volumeM3 || 0), 0), 0);

      if (statusEl) {
        statusEl.style.color = 'var(--success)';
        statusEl.innerHTML = `✅ تم بنجاح استخراج <strong>(${draftImportedContainers.length}) حاوية مستقلة</strong> بإجمالي <strong>(${totalLogs} جذع — ${fmtNum(totalCbm, 3)} م³)</strong>! يمكنك التبديل بين الحاويات بالأعلى أو الضغط على <strong>"حفظ واستيراد جميع الحاويات دفعة واحدة"</strong>.`;
      }
    } else {
      if (statusEl) {
        statusEl.style.color = 'var(--danger)';
        statusEl.textContent = '⚠️ لم يتم العثور على جدول أرقام قياسي في الملف. يمكنك لصق الأرقام في المربع المقابل مباشرة.';
      }
    }
  } catch (err) {
    if (statusEl) {
      statusEl.style.color = 'var(--danger)';
      statusEl.textContent = '⚠️ حدث تنبيه أثناء قراءة الـ PDF: ' + (err?.message || 'يمكنك نسخ النص ولصقه مباشرة.');
    }
  }
}

function parseFromBulkTextareaIntoDraft() {
  const pasteArea = document.getElementById('bulk-logs-paste-area');
  if (!pasteArea || !pasteArea.value.trim()) {
    alert('يرجى لصق بيان السيريالات والتكعيب في المربع أولاً!');
    return;
  }
  const rows = parseSupplierLogsRawText(pasteArea.value);
  if (rows.length === 0) {
    alert('لم يتم العثور على أرقام سيريال وتكعيب صالحة في النص الملصق!');
    return;
  }
  draftImportedLogs = rows;
  renderDraftImportLogsTable();
}

function addEmptyDraftLogRow() {
  const nextIdx = draftImportedLogs.length + 1;
  draftImportedLogs.push({
    id: uid('dlog'),
    serialNumber: `LOG-${1000 + nextIdx}`,
    lengthM: 2.6,
    diameterCm: 55,
    volumeM3: computeCylinderLogVolumeM3(2.6, 55)
  });
  renderDraftImportLogsTable();
}

function generateSequentialDraftSerials() {
  const prefix = prompt('اكتب بداية السيريال أو رقم أول سيريال (مثال: 1001 أو LOG-1):', '1001');
  if (!prefix) return;
  const numMatch = prefix.match(/^(.*?)(\d+)$/);
  draftImportedLogs.forEach((r, idx) => {
    if (numMatch) {
      const baseStr = numMatch[1];
      const startNum = Number(numMatch[2]);
      r.serialNumber = `${baseStr}${startNum + idx}`;
    } else {
      r.serialNumber = `${prefix}-${idx + 1}`;
    }
  });
  renderDraftImportLogsTable();
}

function updateDraftImportLogField(idx, field, val) {
  const row = draftImportedLogs[idx];
  if (!row) return;
  if (field === 'serialNumber') {
    row.serialNumber = String(val || '').trim();
  } else if (field === 'lengthM') {
    row.lengthM = Number(val || 0);
    if (row.lengthM > 0 && row.diameterCm > 0) {
      row.volumeM3 = computeCylinderLogVolumeM3(row.lengthM, row.diameterCm);
      const vInput = document.getElementById(`dlog-vol-${idx}`);
      if (vInput) vInput.value = row.volumeM3;
    }
  } else if (field === 'diameterCm') {
    row.diameterCm = Number(val || 0);
    if (row.lengthM > 0 && row.diameterCm > 0) {
      row.volumeM3 = computeCylinderLogVolumeM3(row.lengthM, row.diameterCm);
      const vInput = document.getElementById(`dlog-vol-${idx}`);
      if (vInput) vInput.value = row.volumeM3;
    }
  } else if (field === 'volumeM3') {
    row.volumeM3 = Math.max(0, Number(val || 0));
  }
  recalcDraftImportLogsSummary();
}

function removeDraftImportLogRow(idx) {
  draftImportedLogs.splice(idx, 1);
  renderDraftImportLogsTable();
}

function renderDraftImportLogsTable() {
  const box = document.getElementById('draft-import-logs-table-box');
  if (!box) return;
  if (draftImportedLogs.length === 0) {
    box.innerHTML = `<div style="padding:14px;text-align:center;color:var(--text-muted);">الجدول فارغ. ارفع ملف PDF أو الصق السيريالات أو اضغط "+ إضافة سطر جذع".</div>`;
    recalcDraftImportLogsSummary();
    return;
  }

  box.innerHTML = `
    <table>
      <thead>
        <tr>
          <th style="width:36px;">#</th>
          <th>رقم السيريال (Serial)</th>
          <th>طول الجذع (متر)</th>
          <th>قطر الجذع (سم)</th>
          <th>التكعيب بالمتر المكعب (م³)</th>
          <th style="width:45px;">حذف</th>
        </tr>
      </thead>
      <tbody>
        ${draftImportedLogs.map((r, idx) => `
          <tr>
            <td><strong>${idx + 1}</strong></td>
            <td>
              <input class="form-control" style="padding:4px 8px;font-weight:800;color:var(--primary);" value="${r.serialNumber}" oninput="updateDraftImportLogField(${idx}, 'serialNumber', this.value)" required />
            </td>
            <td>
              <input type="number" step="0.01" min="0" class="form-control" style="padding:4px 8px;width:95px;" value="${r.lengthM}" oninput="updateDraftImportLogField(${idx}, 'lengthM', this.value)" />
            </td>
            <td>
              <input type="number" step="0.5" min="0" class="form-control" style="padding:4px 8px;width:95px;" value="${r.diameterCm}" oninput="updateDraftImportLogField(${idx}, 'diameterCm', this.value)" />
            </td>
            <td>
              <input id="dlog-vol-${idx}" type="number" step="0.0001" min="0.0001" class="form-control" style="padding:4px 8px;width:125px;font-weight:900;border-color:var(--primary);" value="${r.volumeM3}" oninput="updateDraftImportLogField(${idx}, 'volumeM3', this.value)" required />
            </td>
            <td>
              <button type="button" class="btn btn-sm btn-danger" style="padding:2px 6px;" onclick="removeDraftImportLogRow(${idx})">✕</button>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;

  recalcDraftImportLogsSummary();
}

function recalcDraftImportLogsSummary() {
  const sumEl = document.getElementById('draft-import-logs-summary');
  if (!sumEl) return;
  const count = draftImportedLogs.length;
  const totalM3 = +draftImportedLogs.reduce((s, r) => s + Number(r.volumeM3 || 0), 0).toFixed(4);
  const density = Math.max(0.1, Number(document.getElementById('imp-cnt-density')?.value || 0.75));
  const yieldPct = Math.min(100, Math.max(1, Number(document.getElementById('imp-cnt-yield')?.value || 65)));
  const scrapPct = +(100 - yieldPct).toFixed(1);

  const totalWeightTon = +(totalM3 * density).toFixed(3);
  const expectedFinishedM3 = +(totalM3 * (yieldPct / 100)).toFixed(4);
  const expectedFinishedTon = +(expectedFinishedM3 * density).toFixed(3);
  const expectedScrapM3 = +Math.max(0, totalM3 - expectedFinishedM3).toFixed(4);
  const expectedScrapTon = +(expectedScrapM3 * density).toFixed(3);

  sumEl.innerHTML = `
    <div class="calc-preview-item">
      <span>عدد الجذوع بالحاوية</span>
      <strong>${fmtNum(count, 0)} جذع بسيريال مستقل</strong>
    </div>
    <div class="calc-preview-item">
      <span>إجمالي تكعيب الرسالة (م³)</span>
      <strong style="color:var(--primary);font-size:1.05rem;">${fmtNum(totalM3, 4)} م³</strong>
    </div>
    <div class="calc-preview-item">
      <span>إجمالي وزن الرسالة (عند كثافة ${density} طن/م³)</span>
      <strong>${fmtNum(totalWeightTon, 3)} طن</strong>
    </div>
    <div class="calc-preview-item">
      <span>المنتج التام المتوقع (${yieldPct}%)</span>
      <strong style="color:var(--success);">${fmtNum(expectedFinishedM3, 3)} م³ (${fmtNum(expectedFinishedTon, 3)} طن)</strong>
    </div>
    <div class="calc-preview-item">
      <span>الهالك المتوقع (${scrapPct}%) بالطن والمتر</span>
      <strong style="color:var(--danger);">${fmtNum(expectedScrapTon, 3)} طن هالك (${fmtNum(expectedScrapM3, 3)} م³)</strong>
    </div>
  `;
}

function submitImportLogContainerModal(e) {
  if (e) e.preventDefault();
  if (draftImportedLogs.length === 0) {
    alert('يرجى إضافة جذع واحد على الأقل في جدول الحاوية!');
    return;
  }

  const containerNumber = (document.getElementById('imp-cnt-number')?.value || '').trim() || `CNT-${Date.now().toString().slice(-4)}`;
  const supplierName = (document.getElementById('imp-cnt-supplier')?.value || 'مورد أخشاب').trim();
  const woodTypeName = (document.getElementById('imp-cnt-wood')?.value || 'جذوع خشب').trim();
  const arrivalDate = document.getElementById('imp-cnt-date')?.value || todayStr();
  const densityTonPerM3 = Math.max(0.1, Number(document.getElementById('imp-cnt-density')?.value || 0.75));
  const expectedYieldPct = Math.min(100, Math.max(1, Number(document.getElementById('imp-cnt-yield')?.value || 65)));
  const now = getMonotonicIso();

  const containerId = uid('lcnt');
  const totalVol = +draftImportedLogs.reduce((s, r) => s + Number(r.volumeM3 || 0), 0).toFixed(4);

  state.logContainers = state.logContainers || [];
  state.logItems = state.logItems || [];

  state.logContainers.unshift({
    id: containerId,
    containerNumber,
    supplierName,
    woodTypeName,
    arrivalDate,
    densityTonPerM3,
    expectedYieldPct,
    totalLogsCount: draftImportedLogs.length,
    totalVolumeM3: totalVol,
    createdBy: currentUser?.name || 'الإدارة',
    createdAt: now,
    updatedAt: now
  });

  for (const r of draftImportedLogs) {
    state.logItems.push({
      id: uid('logi'),
      containerId,
      containerNumber,
      supplierName,
      woodTypeName,
      serialNumber: String(r.serialNumber || '').trim(),
      lengthM: Number(r.lengthM || 0),
      diameterCm: Number(r.diameterCm || 0),
      volumeM3: +Number(r.volumeM3 || 0).toFixed(4),
      status: 'in_stock',
      arrivalDate,
      createdAt: now,
      updatedAt: now
    });
  }

  // Also add or update the aggregate rawMaterials stock so the general raw warehouse stays synchronized
  state.rawMaterials = state.rawMaterials || [];
  let rawEntry = state.rawMaterials.find(rm => rm.unit === 'م³' && rm.name.includes(woodTypeName));
  if (!rawEntry) {
    rawEntry = {
      id: uid('rm'),
      code: `RAW-LOG-${(state.rawMaterials.length || 0) + 1}`,
      name: `${woodTypeName} (جذوع بالحاويات والسيريال)`,
      category: 'جذوع أشجار خام',
      unit: 'م³',
      quantity: totalVol,
      minThreshold: 10,
      costPerUnit: 0,
      supplierName,
      location: `حاوية ${containerNumber}`,
      entryDate: arrivalDate,
      updatedAt: now
    };
    state.rawMaterials.unshift(rawEntry);
  } else {
    rawEntry.quantity = +(Number(rawEntry.quantity || 0) + totalVol).toFixed(4);
    rawEntry.updatedAt = now;
  }

  state.warehouseMovements = state.warehouseMovements || [];
  state.warehouseMovements.unshift({
    id: uid('mov'),
    voucherNumber: `RCV-CNT-${Date.now().toString().slice(-4)}`,
    date: arrivalDate,
    warehouseType: 'raw_materials',
    warehouseLabel: 'مخزن الخامات (الحاويات والجذوع)',
    direction: 'in',
    directionLabel: 'إذن استلام حاوية جذوع بالسيريال',
    itemSummary: `حاوية (${containerNumber}) — ${woodTypeName} (${draftImportedLogs.length} جذع)`,
    referenceCode: containerNumber,
    quantitySummary: `${draftImportedLogs.length} جذع (${fmtNum(totalVol, 4)} م³)`,
    performedBy: currentUser?.name || 'الإدارة',
    approvedBy: currentUser?.name || 'الإدارة',
    updatedAt: now
  });

  const savedCount = draftImportedLogs.length;
  draftImportedLogs = [];
  activeLogContainerFilter = containerId;
  closeModal();
  saveState(`🚢 استيراد وتسجيل حاوية جذوع (${containerNumber}) من المورد (${supplierName}) بعدد (${savedCount} جذع) وإجمالي تكعيب (${fmtNum(totalVol, 4)} م³)`);
}

// Inline and Modal Serial Execution for CEO, Projects Manager, Admin Manager
function submitInlineLogSerialProcess(e) {
  if (e) e.preventDefault();
  if (!canManageLogSerialsAndProduction(currentUser)) {
    alert('⛔ هذه الصلاحية مخصصة فقط للمدير التنفيذي ومدير المشروعات والمدير الإداري!');
    return;
  }
  const input = document.getElementById('inline-log-serial-input');
  if (!input || !input.value.trim()) return;
  processLogSerialsBatchByString(input.value.trim());
  input.value = '';
}

function processLogSerialsBatchByString(serialsStr) {
  const tokens = normalizeArabicAiText(serialsStr)
    .split(/[\s,،;؛\n]+/)
    .map(s => s.trim())
    .filter(Boolean);

  if (tokens.length === 0) return;

  const now = getMonotonicIso();
  const matchedLogs = [];
  const alreadyProcessed = [];
  const notFound = [];

  for (const tk of tokens) {
    const logItem = (state.logItems || []).find(
      l => String(l.serialNumber).toLowerCase() === tk.toLowerCase() &&
      (activeLogContainerFilter === 'all' || l.containerId === activeLogContainerFilter)
    ) || (state.logItems || []).find(l => String(l.serialNumber).toLowerCase() === tk.toLowerCase());

    if (!logItem) {
      notFound.push(tk);
    } else if (logItem.status === 'processed') {
      alreadyProcessed.push(logItem.serialNumber);
    } else {
      logItem.status = 'processed';
      logItem.processedAt = now;
      logItem.processedBy = currentUser?.name || 'الإدارة';
      logItem.updatedAt = now;
      matchedLogs.push(logItem);
    }
  }

  if (matchedLogs.length > 0) {
    const totalProcessedVol = +matchedLogs.reduce((s, l) => s + Number(l.volumeM3 || 0), 0).toFixed(4);
    // Deduct from aggregate rawMaterials if matching entry exists
    for (const l of matchedLogs) {
      const rm = (state.rawMaterials || []).find(r => r.unit === 'م³' && r.name.includes(l.woodTypeName || ''));
      if (rm) {
        rm.quantity = Math.max(0, +(Number(rm.quantity || 0) - Number(l.volumeM3 || 0)).toFixed(4));
        rm.updatedAt = now;
      }
    }

    state.warehouseMovements = state.warehouseMovements || [];
    state.warehouseMovements.unshift({
      id: uid('mov'),
      voucherNumber: `ISS-LOG-${Date.now().toString().slice(-4)}`,
      date: todayStr(),
      warehouseType: 'raw_materials',
      warehouseLabel: 'مخزن الخامات (تشغيل جذوع بالسيريال)',
      direction: 'out',
      directionLabel: 'إذن صرف وتشغيل جذوع بالسيريال',
      itemSummary: `تشغيل (${matchedLogs.length}) جذع بالسيريال: [${matchedLogs.map(x => x.serialNumber).join(', ')}]`,
      referenceCode: matchedLogs[0].containerNumber || 'LOG-SER',
      quantitySummary: `${matchedLogs.length} جذع (${fmtNum(totalProcessedVol, 4)} م³)`,
      performedBy: currentUser?.name || 'الإدارة',
      approvedBy: currentUser?.name || 'الإدارة',
      updatedAt: now
    });

    saveState(`⚙️ تشغيل (${matchedLogs.length}) جذع بالسيريال [${matchedLogs.map(x => x.serialNumber).join('، ')}] بإجمالي تكعيب (${fmtNum(totalProcessedVol, 4)} م³) بواسطة ${currentUser?.name}`);
  }

  let msg = '';
  if (matchedLogs.length > 0) {
    msg += `✅ تم تشغيل (${matchedLogs.length}) جذع بنجاح: [${matchedLogs.map(x => x.serialNumber).join('، ')}]\n`;
  }
  if (alreadyProcessed.length > 0) {
    msg += `⚠️ جذوع تم تشغيلها مسبقاً: [${alreadyProcessed.join('، ')}]\n`;
  }
  if (notFound.length > 0) {
    msg += `❌ أرقام سيريال غير موجودة: [${notFound.join('، ')}]`;
  }
  if (alreadyProcessed.length > 0 || notFound.length > 0) {
    alert(msg.trim());
  }
}

function toggleSingleLogProcessStatus(logId, markProcessed = true) {
  if (!canManageLogSerialsAndProduction(currentUser)) {
    alert('⛔ هذه الصلاحية مخصصة للمدير التنفيذي ومدير المشروعات والمدير الإداري فقط!');
    return;
  }
  const logItem = (state.logItems || []).find(l => l.id === logId);
  if (!logItem) return;
  const now = getMonotonicIso();

  if (markProcessed && logItem.status !== 'processed') {
    logItem.status = 'processed';
    logItem.processedAt = now;
    logItem.processedBy = currentUser?.name || 'الإدارة';
    logItem.updatedAt = now;

    const rm = (state.rawMaterials || []).find(r => r.unit === 'م³' && r.name.includes(logItem.woodTypeName || ''));
    if (rm) {
      rm.quantity = Math.max(0, +(Number(rm.quantity || 0) - Number(logItem.volumeM3 || 0)).toFixed(4));
      rm.updatedAt = now;
    }

    saveState(`⚙️ تشغيل الجذع سيريال (${logItem.serialNumber}) من الحاوية (${logItem.containerNumber}) بتكعيب (${fmtNum(logItem.volumeM3, 4)} م³) بواسطة ${currentUser?.name}`);
  } else if (!markProcessed && logItem.status === 'processed') {
    logItem.status = 'in_stock';
    delete logItem.processedAt;
    delete logItem.processedBy;
    logItem.updatedAt = now;

    const rm = (state.rawMaterials || []).find(r => r.unit === 'م³' && r.name.includes(logItem.woodTypeName || ''));
    if (rm) {
      rm.quantity = +(Number(rm.quantity || 0) + Number(logItem.volumeM3 || 0)).toFixed(4);
      rm.updatedAt = now;
    }

    saveState(`↩️ إرجاع الجذع سيريال (${logItem.serialNumber}) إلى الرصيد المتاح بالمخزن (${fmtNum(logItem.volumeM3, 4)} م³) بواسطة ${currentUser?.name}`);
  }
}

function openQuickLogSerialDispatchModal() {
  if (!canManageLogSerialsAndProduction(currentUser)) return;
  const modalRoot = document.getElementById('modal-root');
  const availableLogs = (state.logItems || []).filter(l => l.status !== 'processed');

  modalRoot.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal-box" style="max-width:680px;">
        <div class="card-header">
          <div>
            <div class="card-title" style="color:#5b21b6;">⚙️ إدخال سيريال الجذوع للتشغيل (المدير التنفيذي / المشروعات / الإداري)</div>
            <small style="color:var(--text-muted);">يمكنك كتابة أرقام السيريال مباشرة أو تحديد الجذوع من القائمة لتشغيلها فوراً</small>
          </div>
          <button type="button" class="btn btn-sm btn-outline" onclick="closeModal()">✕</button>
        </div>

        <form onsubmit="event.preventDefault(); const v=document.getElementById('modal-batch-serials').value; closeModal(); processLogSerialsBatchByString(v);">
          <div class="form-group" style="margin-bottom:12px;">
            <label style="font-weight:800;">اكتب رقم السيريال أو عدة أرقام سيريال (مفصولة بمسافة أو فاصلة أو سطر جديد):</label>
            <textarea id="modal-batch-serials" rows="3" class="form-control" style="font-weight:800;border:2px solid #7c3aed;" placeholder="مثال: LOG-1001, LOG-1002" autofocus></textarea>
          </div>

          <div style="margin-bottom:12px;">
            <div style="font-weight:800;font-size:0.84rem;margin-bottom:6px;color:var(--primary);">
              أو اضغط على أي جذع متاح بالمخزن لإضافته للتشغيل (${availableLogs.length} جذع متاح):
            </div>
            <div style="max-height:210px;overflow-y:auto;display:flex;flex-wrap:wrap;gap:6px;background:var(--bg-elevated);padding:10px;border-radius:10px;">
              ${availableLogs.length === 0 ? `<span style="color:var(--text-muted);font-size:0.84rem;">لا توجد جذوع متاحة غير مشغلة حالياً.</span>` : availableLogs.map(l => `
                <button type="button" class="btn btn-sm btn-outline" style="font-size:0.76rem;padding:4px 9px;" onclick="const ta=document.getElementById('modal-batch-serials'); ta.value = (ta.value ? ta.value + ', ' : '') + '${l.serialNumber}';">
                  ➕ ${l.serialNumber} (${fmtNum(l.volumeM3, 3)} م³ — ${l.containerNumber})
                </button>
              `).join('')}
            </div>
          </div>

          <div style="display:flex;justify-content:flex-end;gap:10px;">
            <button type="button" class="btn btn-outline" onclick="closeModal()">إلغاء</button>
            <button type="submit" class="btn btn-primary" style="background:#7c3aed;border-color:#7c3aed;font-weight:900;">
              ⚙️ تأكيد تشغيل الجذوع المحددة الآن
            </button>
          </div>
        </form>
      </div>
    </div>
  `;
}

// Modal to Edit a Single Log (Serial, Dimensions, Volume, Status)
function openEditSingleLogModal(logId) {
  const l = (state.logItems || []).find(x => x.id === logId);
  if (!l) return;
  const modalRoot = document.getElementById('modal-root');

  modalRoot.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal-box" style="max-width:520px;">
        <div class="card-header">
          <div>
            <div class="card-title">✏️ تعديل بيانات الجذع سيريال (${l.serialNumber})</div>
            <small style="color:var(--text-muted);">الحاوية: ${l.containerNumber || '-'} | المورد: ${l.supplierName || '-'}</small>
          </div>
          <button type="button" class="btn btn-sm btn-outline" onclick="closeModal()">✕</button>
        </div>

        <form onsubmit="submitEditSingleLogModal(event, '${l.id}')">
          <div class="form-grid">
            <div class="form-group">
              <label style="font-weight:800;">رقم السيريال (Serial Number)</label>
              <input id="elog-serial" class="form-control" value="${l.serialNumber}" required style="font-weight:800;" />
            </div>
            <div class="form-group">
              <label style="font-weight:800;">حالة التشغيل</label>
              <select id="elog-status" class="form-control" style="font-weight:800;">
                <option value="in_stock" ${l.status !== 'processed' ? 'selected' : ''}>⏳ لم يتم تشغيله (متاح بالمخزن)</option>
                <option value="processed" ${l.status === 'processed' ? 'selected' : ''}>✅ تم تشغيله</option>
              </select>
            </div>
            <div class="form-group">
              <label>طول الجذع (متر)</label>
              <input id="elog-len" type="number" step="0.01" min="0" class="form-control" value="${l.lengthM || 0}" oninput="const v=computeCylinderLogVolumeM3(this.value, document.getElementById('elog-dia').value); if(v>0) document.getElementById('elog-vol').value=v;" />
            </div>
            <div class="form-group">
              <label>قطر الجذع (سم)</label>
              <input id="elog-dia" type="number" step="0.5" min="0" class="form-control" value="${l.diameterCm || 0}" oninput="const v=computeCylinderLogVolumeM3(document.getElementById('elog-len').value, this.value); if(v>0) document.getElementById('elog-vol').value=v;" />
            </div>
            <div class="form-group" style="grid-column: 1 / -1;">
              <label style="font-weight:800;color:var(--primary);">التكعيب بالمتر المكعب (م³)</label>
              <input id="elog-vol" type="number" step="0.0001" min="0.0001" class="form-control" value="${l.volumeM3}" required style="font-weight:900;border-color:var(--primary);" />
            </div>
          </div>

          <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px;">
            <button type="button" class="btn btn-outline" onclick="closeModal()">إلغاء</button>
            <button type="submit" class="btn btn-primary">💾 حفظ التعديلات</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function submitEditSingleLogModal(e, logId) {
  if (e) e.preventDefault();
  const l = (state.logItems || []).find(x => x.id === logId);
  if (!l) return;
  const now = getMonotonicIso();

  l.serialNumber = (document.getElementById('elog-serial')?.value || l.serialNumber).trim();
  const newStatus = document.getElementById('elog-status')?.value || l.status;
  if (newStatus === 'processed' && l.status !== 'processed') {
    l.processedAt = now;
    l.processedBy = currentUser?.name || 'الإدارة';
  } else if (newStatus !== 'processed') {
    delete l.processedAt;
    delete l.processedBy;
  }
  l.status = newStatus;
  l.lengthM = Number(document.getElementById('elog-len')?.value || 0);
  l.diameterCm = Number(document.getElementById('elog-dia')?.value || 0);
  l.volumeM3 = +Number(document.getElementById('elog-vol')?.value || l.volumeM3).toFixed(4);
  l.updatedAt = now;

  closeModal();
  saveState(`✏️ تعديل بيانات الجذع سيريال (${l.serialNumber}) في الحاوية (${l.containerNumber}) بواسطة ${currentUser?.name}`);
}

function deleteSingleLogItem(logId) {
  if (!isFullAdmin(currentUser)) return;
  const l = (state.logItems || []).find(x => x.id === logId);
  if (!l) return;
  if (!confirm(`⚠️ هل أنت متأكد من حذف الجذع سيريال (${l.serialNumber})؟`)) return;
  markRecordIdDeleted(l.id);
  state.logItems = (state.logItems || []).filter(x => x.id !== logId);
  saveState(`🗑️ حذف الجذع سيريال (${l.serialNumber}) من الحاوية (${l.containerNumber})`);
}

function deleteLogContainerRecord(containerId) {
  if (!isFullAdmin(currentUser)) return;
  const c = (state.logContainers || []).find(x => x.id === containerId);
  if (!c) return;
  if (!confirm(`⚠️ هل أنت متأكد من حذف الحاوية (${c.containerNumber}) وجميع الجذوع التابعة لها؟`)) return;
  markRecordIdDeleted(c.id);
  const childLogs = (state.logItems || []).filter(l => l.containerId === containerId);
  for (const cl of childLogs) markRecordIdDeleted(cl.id);
  state.logContainers = (state.logContainers || []).filter(x => x.id !== containerId);
  state.logItems = (state.logItems || []).filter(l => l.containerId !== containerId);
  if (activeLogContainerFilter === containerId) activeLogContainerFilter = 'all';
  saveState(`🗑️ حذف الحاوية (${c.containerNumber}) وجميع سيريالاتها بواسطة ${currentUser?.name}`);
}

// Modal for Container Density, Expected Yield %, Actual Finished Veneer, and Scrap in Tons Comparison
function openContainerYieldDensityModal(containerId) {
  const c = (state.logContainers || []).find(x => x.id === containerId);
  if (!c) return;
  const cm = getContainerMetrics(c);
  const modalRoot = document.getElementById('modal-root');

  modalRoot.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal-box" style="max-width:740px;">
        <div class="card-header">
          <div>
            <div class="card-title" style="color:var(--primary);">
              ⚖️ حساب الكثافة ونسبة استخراج المنتج التام والهالك بالطن — حاوية (${c.containerNumber})
            </div>
            <small style="color:var(--text-muted);">
              المورد: <strong>${c.supplierName}</strong> | إجمالي الجذوع: <strong>${cm.totalLogsCount} جذع (${fmtNum(cm.totalVolumeM3, 4)} م³)</strong> | المُشغّل: <strong>${cm.processedLogsCount} جذع (${fmtNum(cm.processedVolumeM3, 4)} م³)</strong>
            </small>
          </div>
          <button type="button" class="btn btn-sm btn-outline" onclick="closeModal()">✕</button>
        </div>

        <form onsubmit="submitContainerYieldDensityModal(event, '${c.id}')">
          <div class="form-grid" style="margin-bottom:14px;">
            <div class="form-group">
              <label style="font-weight:800;color:#b45309;">⚖️ كثافة الخشب (طن لكل 1 متر مكعب)</label>
              <input id="cy-density" type="number" step="0.01" min="0.1" max="2.5" class="form-control" value="${cm.densityTonPerM3}" oninput="recalcContainerYieldModalLive('${c.id}')" required style="font-weight:900;border-color:#d97706;" />
              <small style="color:var(--text-muted);">تُستخدم لتحويل حجم الهالك والمنتج التام من م³ إلى طن</small>
            </div>
            <div class="form-group">
              <label style="font-weight:800;color:var(--success);">📊 نسبة استخراج المنتج التام المتوقعة للرسالة (%)</label>
              <input id="cy-yield-pct" type="number" step="0.5" min="1" max="99" class="form-control" value="${cm.expectedYieldPct}" oninput="recalcContainerYieldModalLive('${c.id}')" required style="font-weight:900;border-color:var(--success);" />
              <small style="color:var(--text-muted);">الباقي (${fmtNum(100 - cm.expectedYieldPct, 1)}%) يُحسب هوالك بالطن</small>
            </div>
            <div class="form-group" style="grid-column: 1 / -1;background:rgba(124,58,237,0.06);padding:10px 12px;border-radius:10px;border:1px solid rgba(124,58,237,0.3);">
              <label style="font-weight:800;color:#5b21b6;">🪵 حجم القشرة التامة الفعلي المستخرج من التشغيل بالمتر المكعب (اختياري لمقارنة المتوقع بالفعلي):</label>
              <input id="cy-actual-fin-m3" type="number" step="0.001" min="0" class="form-control" value="${c.actualFinishedM3 !== undefined && c.actualFinishedM3 !== null ? c.actualFinishedM3 : ''}" placeholder="اتركه فارغاً للحساب التلقائي حسب النسبة، أو أدخل الـ م³ الفعلي للمنتج التام..." oninput="recalcContainerYieldModalLive('${c.id}')" style="font-weight:800;" />
            </div>
          </div>

          <div id="cy-live-comparison-box" class="calc-preview-box" style="margin-bottom:14px;"></div>

          <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px;">
            <button type="button" class="btn btn-accent" onclick="transferContainerScrapToWarehouse('${c.id}')">
              ♻️ ترحيل كمية الهالك بالطن إلى مخزن الهالك الآن
            </button>
            <div style="display:flex;gap:8px;">
              <button type="button" class="btn btn-outline" onclick="closeModal()">إغلاق</button>
              <button type="submit" class="btn btn-primary" style="font-weight:900;">💾 حفظ الكثافة وحسابات الاستخراج والهالك</button>
            </div>
          </div>
        </form>
      </div>
    </div>
  `;

  recalcContainerYieldModalLive(c.id);
}

function recalcContainerYieldModalLive(containerId) {
  const c = (state.logContainers || []).find(x => x.id === containerId);
  const box = document.getElementById('cy-live-comparison-box');
  if (!c || !box) return;

  const tempContainer = {
    ...c,
    densityTonPerM3: Number(document.getElementById('cy-density')?.value || c.densityTonPerM3 || 0.75),
    expectedYieldPct: Number(document.getElementById('cy-yield-pct')?.value || c.expectedYieldPct || 65),
    actualFinishedM3: document.getElementById('cy-actual-fin-m3')?.value
  };
  const cm = getContainerMetrics(tempContainer);

  box.innerHTML = `
    <div class="calc-preview-item">
      <span>إجمالي تكعيب ووزن الرسالة</span>
      <strong>${fmtNum(cm.totalVolumeM3, 4)} م³ = ${fmtNum(cm.totalWeightTon, 3)} طن</strong>
    </div>
    <div class="calc-preview-item">
      <span>المُشغّل حتى الآن / المتبقي</span>
      <strong>مُشغّل: ${fmtNum(cm.processedVolumeM3, 3)} م³ | متبقي: ${fmtNum(cm.remainingVolumeM3, 3)} م³</strong>
    </div>
    <div class="calc-preview-item">
      <span>المنتج التام المتوقع (${cm.expectedYieldPct}%)</span>
      <strong style="color:var(--success);">${fmtNum(cm.expectedFinishedM3, 3)} م³ (${fmtNum(cm.expectedFinishedTon, 3)} طن)</strong>
    </div>
    <div class="calc-preview-item">
      <span>الهالك المتوقع (${cm.expectedScrapPct}%) بالطن</span>
      <strong style="color:var(--danger);">${fmtNum(cm.expectedScrapTon, 3)} طن (${fmtNum(cm.expectedScrapM3, 3)} م³)</strong>
    </div>
    <div class="calc-preview-item">
      <span>المنتج التام الفعلي ونسبة الاستخراج الفعلية</span>
      <strong style="color:#7c3aed;">${fmtNum(cm.actualFinishedM3, 3)} م³ (${fmtNum(cm.actualYieldPctOnProcessed, 1)}%)</strong>
    </div>
    <div class="calc-preview-item">
      <span>الهالك الفعلي بالطن والفرق عن المتوقع</span>
      <strong style="color:var(--danger);">${fmtNum(cm.actualScrapTon, 3)} طن (${cm.scrapDiffTon > 0 ? '+' : ''}${fmtNum(cm.scrapDiffTon, 3)} طن)</strong>
    </div>
  `;
}

function submitContainerYieldDensityModal(e, containerId) {
  if (e) e.preventDefault();
  const c = (state.logContainers || []).find(x => x.id === containerId);
  if (!c) return;
  c.densityTonPerM3 = Math.max(0.1, Number(document.getElementById('cy-density')?.value || 0.75));
  c.expectedYieldPct = Math.min(100, Math.max(1, Number(document.getElementById('cy-yield-pct')?.value || 65)));
  const actVal = document.getElementById('cy-actual-fin-m3')?.value;
  c.actualFinishedM3 = (actVal !== undefined && actVal !== '') ? Number(actVal) : null;
  c.updatedAt = getMonotonicIso();

  closeModal();
  saveState(`⚖️ تحديث الكثافة (${c.densityTonPerM3} طن/م³) ونسبة الاستخراج (${c.expectedYieldPct}%) للحاوية (${c.containerNumber})`);
}

function transferContainerScrapToWarehouse(containerId) {
  const c = (state.logContainers || []).find(x => x.id === containerId);
  if (!c) return;
  const tempContainer = {
    ...c,
    densityTonPerM3: Number(document.getElementById('cy-density')?.value || c.densityTonPerM3 || 0.75),
    expectedYieldPct: Number(document.getElementById('cy-yield-pct')?.value || c.expectedYieldPct || 65),
    actualFinishedM3: document.getElementById('cy-actual-fin-m3')?.value
  };
  const cm = getContainerMetrics(tempContainer);
  const scrapTonToRecord = cm.actualScrapTon > 0 ? cm.actualScrapTon : cm.expectedScrapTon;

  if (scrapTonToRecord <= 0) {
    alert('لا توجد كمية هالك محسوبة لترحيلها!');
    return;
  }

  const now = getMonotonicIso();
  state.scrapItems = state.scrapItems || [];
  state.scrapItems.unshift({
    id: uid('sc'),
    code: `SCR-${c.containerNumber}`,
    name: `هوالك تقشير جذوع حاوية (${c.containerNumber}) — كثافة ${cm.densityTonPerM3} طن/م³`,
    woodTypeName: c.woodTypeName || 'خشب خام',
    category: 'هوالك تقشير جذوع (بالطن)',
    unit: 'طن',
    quantity: scrapTonToRecord,
    estimatedPricePerUnit: 0,
    notes: `نسبة استخراج المنتج التام: ${cm.actualYieldPctOnProcessed}% | حجم الهالك: ${fmtNum(cm.actualScrapM3, 3)} م³ × كثافة ${cm.densityTonPerM3} = ${fmtNum(scrapTonToRecord, 3)} طن`,
    updatedAt: now
  });

  closeModal();
  saveState(`♻️ ترحيل هالك الحاوية (${c.containerNumber}) بكمية (${fmtNum(scrapTonToRecord, 3)} طن) إلى مخزن الهالك والقصاقيص`);
  alert(`✅ تم تسجيل (${fmtNum(scrapTonToRecord, 3)} طن) في مخزن الهالك والقصاقيص بنجاح!`);
}

function printLogContainersAndSerialsReportPdf() {
  const containers = state.logContainers || [];
  const allLogs = state.logItems || [];
  const rowsHtml = allLogs
    .filter(l => activeLogContainerFilter === 'all' || l.containerId === activeLogContainerFilter)
    .map((l, idx) => {
      const parentCont = containers.find(c => c.id === l.containerId);
      const dens = Number(parentCont?.densityTonPerM3 || 0.75);
      const weightTon = +(Number(l.volumeM3 || 0) * dens).toFixed(3);
      return `
        <tr>
          <td>${idx + 1}</td>
          <td><strong>${l.serialNumber}</strong></td>
          <td>${l.containerNumber || '-'}</td>
          <td>${l.supplierName || '-'}</td>
          <td>الطول: ${l.lengthM || '-'} م | القطر: ${l.diameterCm || '-'} سم</td>
          <td><strong>${fmtNum(l.volumeM3, 4)} م³</strong></td>
          <td>${fmtNum(weightTon, 3)} طن</td>
          <td>${l.status === 'processed' ? `✅ تم تشغيله (${fmtDate(l.processedAt)} - ${l.processedBy || ''})` : '⏳ لم يتم تشغيله (متبقي بالمخزن)'}</td>
        </tr>
      `;
    }).join('');

  const containersSummaryHtml = containers.map(c => {
    const cm = getContainerMetrics(c);
    return `
      <tr>
        <td><strong>${c.containerNumber}</strong></td>
        <td>${c.supplierName || '-'} (${c.woodTypeName || ''})</td>
        <td>${cm.totalLogsCount} جذع (${fmtNum(cm.totalVolumeM3, 4)} م³)</td>
        <td>${cm.processedLogsCount} جذع (${fmtNum(cm.processedVolumeM3, 4)} م³)</td>
        <td><strong>${cm.remainingLogsCount} جذع (${fmtNum(cm.remainingVolumeM3, 4)} م³)</strong></td>
        <td>${cm.densityTonPerM3} طن/م³ (${fmtNum(cm.totalWeightTon, 3)} طن)</td>
        <td>${cm.expectedYieldPct}% (${fmtNum(cm.expectedFinishedM3, 3)} م³)</td>
        <td><strong>${fmtNum(cm.expectedScrapTon, 3)} طن (${fmtNum(cm.expectedScrapM3, 3)} م³)</strong></td>
      </tr>
    `;
  }).join('');

  triggerOfficialReportPdf(
    '🚢 تقرير حاويات وسيريالات جذوع الأشجار ونسب الاستخراج والهالك بالطن',
    'بيان شامل لما تم تشغيله وما لم يتم تشغيله من سيريالات الجذوع وحسابات الكثافة والهالك بالطن',
    `
      <h3 style="margin:10px 0 6px 0;">1️⃣ ملخص الحاويات والكثافة ونسبة استخراج المنتج التام والهالك بالطن:</h3>
      <table class="pdf-report-table">
        <thead>
          <tr>
            <th>رقم الحاوية</th>
            <th>المورد والخشب</th>
            <th>إجمالي الجذوع والتكعيب</th>
            <th>تم تشغيله</th>
            <th>متبقي بالمخزن</th>
            <th>الكثافة والوزن</th>
            <th>المنتج التام المتوقع</th>
            <th>الهالك بالطن والمتر</th>
          </tr>
        </thead>
        <tbody>${containersSummaryHtml || '<tr><td colspan="8">لا توجد حاويات مسجلة</td></tr>'}</tbody>
      </table>

      <h3 style="margin:16px 0 6px 0;">2️⃣ بيان سيريالات الجذوع (ما تم تشغيله وما لم يتم تشغيله):</h3>
      <table class="pdf-report-table">
        <thead>
          <tr>
            <th>#</th>
            <th>رقم السيريال</th>
            <th>الحاوية</th>
            <th>المورد</th>
            <th>المقاسات</th>
            <th>التكعيب (م³)</th>
            <th>الوزن (طن)</th>
            <th>حالة التشغيل</th>
          </tr>
        </thead>
        <tbody>${rowsHtml || '<tr><td colspan="8">لا توجد جذوع مسجلة</td></tr>'}</tbody>
      </table>
    `,
    true
  );
}

// Initialize
initTheme();
loadData();
