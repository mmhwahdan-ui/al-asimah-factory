const CACHE_NAME = 'al-asimah-factory-v89';
const META_CACHE_NAME = 'al-asimah-sw-meta-v1';
const FIREBASE_DEFAULT_URL = 'https://elite-grand-8a6c3-default-rtdb.firebaseio.com/al_asimah_factory_clean.json';

const ASSETS = [
  './',
  './index.html',
  './print.html',
  './styles.css?v=89',
  './app.js?v=89',
  './manifest.webmanifest',
  './icons/logo.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      for (const asset of ASSETS) {
        try {
          await cache.add(asset);
        } catch (_) {}
      }
    }).catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      const oldKeys = keys.filter((k) => k !== CACHE_NAME && k !== META_CACHE_NAME);
      await Promise.all(oldKeys.map((k) => caches.delete(k)));
      await self.clients.claim();
      if (oldKeys.length > 0) {
        const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const client of clientList) {
          try {
            client.postMessage({ type: 'FORCE_RELOAD_V83' });
            if (client.navigate) {
              await client.navigate(client.url);
            }
          } catch (_) {}
        }
      }
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const reqUrl = event.request.url || '';
  if (reqUrl.includes('/api/') || reqUrl.includes('firebaseio.com') || reqUrl.includes('al-asimah-local')) {
    return;
  }
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request, { cache: 'no-store' })
      .then((res) => {
        if (res && res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone)).catch(() => {});
        }
        return res;
      })
      .catch(async () => {
        const cached = await caches.match(event.request, { ignoreSearch: false });
        if (cached) return cached;
        const cachedIgnoreSearch = await caches.match(event.request, { ignoreSearch: true });
        if (cachedIgnoreSearch) return cachedIgnoreSearch;
        return caches.match('./index.html');
      })
  );
});

// ============================================================================
// BACKGROUND WORKFLOW NOTIFICATIONS & OFFLINE AUTO-SYNC ENGINE (WhatsApp-Style)
// ============================================================================
function isFullAdminSw(user) {
  return Boolean(user && (user.roleKey === 'ceo' || user.roleKey === 'projects_manager'));
}

function isWarehouseKeeperOnlySw(user) {
  if (!user) return false;
  return Boolean(
    user.roleKey === 'warehouse_keeper' ||
    user.id === 'u-6' ||
    (user.name && user.name.includes('مخزن')) ||
    (user.roleTitle && user.roleTitle.includes('مخزن'))
  );
}

function canUserSeeFinancialsSw(user) {
  if (!user || isWarehouseKeeperOnlySw(user)) return false;
  if (isFullAdminSw(user)) return true;
  if (['accounts_manager', 'accounting_manager', 'accountant', 'reserve_user'].includes(user.roleKey)) return true;
  return Boolean(user.permissions && user.permissions.salesAccounting);
}

function sanitizeForUserSw(str, user) {
  if (!str || canUserSeeFinancialsSw(user)) return str || '';
  return String(str)
    .replace(/\s*[×xX]\s*[0-9.,]+\s*ج(?:\.م)?\s*=\s*[0-9.,]+\s*(?:ج\.م|ج)?/g, '')
    .replace(/\s*(?:بصافي|بقيمة|بسعر|إجمالي|خصم|إلى|بمبلغ|مدين|دائن)\s*[0-9.,]+\s*(?:ج\.م|جنيه|ج)/g, '')
    .replace(/[0-9.,]+\s*(?:ج\.م|جنيه)/g, '');
}

function isModificationOrSilentActionSw(actionText = '') {
  const txt = String(actionText || '').trim();
  if (!txt) return true;
  return (
    txt.includes('تعديل') ||
    txt.includes('تحديث سعر') ||
    txt.includes('تحديث القيمة الافتراضية') ||
    txt.includes('تحديث الباسورد') ||
    txt.includes('حذف') ||
    txt.includes('إلغاء التخانة') ||
    txt.includes('إلغاء درجة الجودة') ||
    txt.includes('تراجع (Undo)') ||
    txt.includes('إعادة تطبيق العملية') ||
    txt.includes('تسجيل دخول') ||
    txt.includes('لوجو الشركة') ||
    txt.includes('ختم الشركة')
  );
}

function canUserSeeChatMessageSw(user, msg) {
  if (!user || !msg) return false;
  if (isFullAdminSw(user)) return true;
  if (
    msg.senderId === user.id ||
    msg.assignedToUserId === user.id ||
    msg.recipientUserId === user.id ||
    msg.channel === `dm_${user.id}`
  ) {
    return true;
  }
  if (msg.channel && msg.channel.startsWith('dm_')) {
    const targetId = msg.channel.replace('dm_', '');
    return targetId === user.id || msg.recipientUserId === user.id || msg.assignedToUserId === user.id || msg.senderId === user.id;
  }
  if (msg.channel === 'warehouses') return Boolean(user.permissions?.warehouses);
  if (msg.channel === 'production') return Boolean(user.permissions?.production);
  if (msg.channel === 'accounting') return Boolean(user.permissions?.salesAccounting || user.permissions?.approvals);
  return true;
}

function canUserReceiveLogSw(user, logItem) {
  if (!user || !logItem) return false;
  if (logItem.isSilentEdit || isModificationOrSilentActionSw(logItem.action)) return false;
  if (Array.isArray(logItem.hiddenFromRoles) && logItem.hiddenFromRoles.includes(user.roleKey)) return false;
  if (!canUserSeeFinancialsSw(user)) {
    const act = String(logItem.action || '');
    if (act.includes('سعر القطعة') || act.includes('معاملة مالية') || act.includes('تحصيل دفعة') || act.includes('سند مالي') || act.includes('مديونية') || act.includes('شيك تحت التحصيل') || act.includes('تأمين البالتات')) {
      return false;
    }
  }
  if (isFullAdminSw(user)) return true;
  if (logItem.targetUserId && logItem.targetUserId !== 'all') {
    return logItem.targetUserId === user.id;
  }
  const perms = Array.isArray(logItem.permKeys) ? logItem.permKeys : [];
  if (perms.includes('all') || perms.includes('dashboard') || perms.includes('chat')) return true;
  return perms.some((pk) => Boolean(user.permissions && user.permissions[pk]));
}

async function readSwUserContext() {
  try {
    const cache = await caches.open(META_CACHE_NAME);
    const res = await cache.match('https://al-asimah-local/user-context.json');
    if (!res) return null;
    return await res.json();
  } catch (_) {
    return null;
  }
}

async function writeSwUserContext(ctx) {
  try {
    const cache = await caches.open(META_CACHE_NAME);
    await cache.put(
      'https://al-asimah-local/user-context.json',
      new Response(JSON.stringify(ctx), { headers: { 'Content-Type': 'application/json' } })
    );
  } catch (_) {}
}

async function flushPendingOfflineStateFromSw() {
  try {
    const cache = await caches.open(META_CACHE_NAME);
    const res = await cache.match('https://al-asimah-local/pending-offline-state.json');
    if (!res) return;
    const payload = await res.json();
    if (!payload || !payload.state) return;
    const fbUrl = payload.firebaseUrl || FIREBASE_DEFAULT_URL;
    const putRes = await fetch(fbUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload.state)
    });
    if (putRes && putRes.ok) {
      await cache.delete('https://al-asimah-local/pending-offline-state.json');
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of clients) {
        try {
          c.postMessage({ type: 'OFFLINE_SYNC_COMPLETED' });
        } catch (_) {}
      }
    }
  } catch (_) {}
}

async function checkCloudForBackgroundNotifications() {
  try {
    await flushPendingOfflineStateFromSw();
    // Only skip if a window client is currently actively focused in the foreground
    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const hasActivelyFocusedClient = clientList.some((c) => Boolean(c.focused));
    if (hasActivelyFocusedClient) return;

    const ctx = await readSwUserContext();
    if (!ctx || !ctx.user) return;
    const user = ctx.user;
    const seenSet = new Set(Array.isArray(ctx.seenIds) ? ctx.seenIds : []);
    const fbUrl = ctx.firebaseUrl || FIREBASE_DEFAULT_URL;

    const fbRes = await fetch(fbUrl, { cache: 'no-store' });
    if (!fbRes.ok) return;
    const remote = await fbRes.json();
    if (!remote || !remote.users) return;

    let notified = false;
    const isWarehouseOrAdmin = isFullAdminSw(user) || Boolean(user.permissions?.approveWarehouse) || ['admin_manager', 'warehouse_keeper'].includes(user.roleKey);
    const isAccountantRole = isFullAdminSw(user) || Boolean(user.permissions?.approveFinancial);

    for (const ord of (remote.productionOrders || [])) {
      if (!ord || !ord.id) continue;
      const curStage = ord.stage || ord.status;
      const stageKey = `ord_stage_${ord.id}_${curStage}`;
      if (seenSet.has(stageKey)) continue;

      if (curStage === 'pending_warehouse_prep' && isWarehouseOrAdmin) {
        await self.registration.showNotification(`📦 أمر تجهيز طلبية جديد (${ord.orderNumber})`, {
          body: `أمر تجهيز للعميل (${ord.clientName}) — الكمية: ${ord.totalSheetsCount || 0} قطعة جاهز للتجهيز بالمخزن!`,
          icon: './icons/logo.svg',
          badge: './icons/logo.svg',
          dir: 'rtl',
          lang: 'ar',
          vibrate: [300, 120, 300, 120, 400],
          requireInteraction: true,
          renotify: true,
          tag: stageKey,
          data: { targetTab: 'production' }
        });
        seenSet.add(stageKey);
        notified = true;
        break;
      }
      if (curStage === 'ready_for_car_dispatch' && isWarehouseOrAdmin) {
        await self.registration.showNotification(`🚚 أمر صرف وتحميل سيارة (${ord.orderNumber})`, {
          body: `تم اعتماد حسابات الطلبية (${ord.orderNumber}) للعميل (${ord.clientName}) وجاهزة لتحميل السيارة وإصدار إذن الصرف!`,
          icon: './icons/logo.svg',
          badge: './icons/logo.svg',
          dir: 'rtl',
          lang: 'ar',
          vibrate: [300, 120, 300, 120, 400],
          requireInteraction: true,
          renotify: true,
          tag: stageKey,
          data: { targetTab: 'approvals' }
        });
        seenSet.add(stageKey);
        notified = true;
        break;
      }
      if (curStage === 'pending_executive' && (isFullAdminSw(user) || Boolean(user.permissions?.approveExecutive))) {
        await self.registration.showNotification(`📋 طلب موافقة على طلبية (${ord.orderNumber})`, {
          body: `بيان وأمر تجهيز طلبية جديد للعميل (${ord.clientName}) بانتظار موافقة الإدارة التنفيذية`,
          icon: './icons/logo.svg',
          badge: './icons/logo.svg',
          dir: 'rtl',
          lang: 'ar',
          vibrate: [300, 120, 300, 120, 400],
          requireInteraction: true,
          renotify: true,
          tag: stageKey,
          data: { targetTab: 'production' }
        });
        seenSet.add(stageKey);
        notified = true;
        break;
      }
      if (curStage === 'pending_accountant_release' && isAccountantRole) {
        await self.registration.showNotification(`💳 طلبية جاهزة لاعتماد الحسابات (${ord.orderNumber})`, {
          body: `تم تجهيز الطلبية (${ord.orderNumber}) للعميل (${ord.clientName}) بالمخزن وبانتظار موافقة الحسابات وإفراج الصرف`,
          icon: './icons/logo.svg',
          badge: './icons/logo.svg',
          dir: 'rtl',
          lang: 'ar',
          vibrate: [300, 120, 300, 120, 400],
          requireInteraction: true,
          renotify: true,
          tag: stageKey,
          data: { targetTab: 'approvals' }
        });
        seenSet.add(stageKey);
        notified = true;
        break;
      }
    }

    if (!notified) {
      const chatList = Array.isArray(remote.chatMessages) ? remote.chatMessages.slice(-20) : [];
      for (let i = chatList.length - 1; i >= 0; i--) {
        const c = chatList[i];
        if (!c || !c.id || seenSet.has(c.id)) continue;
        if (c.senderId === user.id) {
          seenSet.add(c.id);
          continue;
        }
        if (canUserSeeChatMessageSw(user, c)) {
          const isDirectToMe =
            (c.channel && c.channel.startsWith('dm_')) ||
            c.recipientUserId === user.id ||
            c.assignedToUserId === user.id;
          const targetChatChannel = isDirectToMe ? `dm_${c.senderId}` : (c.channel || 'general');
          const chatTitle = `${c.msgType === 'task' ? '📌 مهمة عمل جديدة' : c.msgType === 'urgent' ? '🚨 تنبيه عاجل' : '💬 رسالة شات جديدة'} من ${c.senderName || 'مستخدم'}`;
          await self.registration.showNotification(chatTitle, {
            body: sanitizeForUserSw(c.text || '', user),
            icon: './icons/logo.svg',
            badge: './icons/logo.svg',
            dir: 'rtl',
            lang: 'ar',
            vibrate: [300, 120, 300, 120, 400],
            requireInteraction: true,
            renotify: true,
            tag: c.id,
            data: { targetTab: 'chat', targetChatChannel }
          });
          seenSet.add(c.id);
          notified = true;
          break;
        }
      }
    }

    if (!notified) {
      for (const l of (remote.auditLogs || []).slice(0, 15)) {
        if (!l || !l.id || seenSet.has(l.id)) continue;
        if (l.actorId === user.id) {
          seenSet.add(l.id);
          continue;
        }
        if (l.isSilentEdit || isModificationOrSilentActionSw(l.action)) {
          seenSet.add(l.id);
          continue;
        }
        if (canUserReceiveLogSw(user, l)) {
          await self.registration.showNotification(`🔔 إشعار عمل جديد (${l.userName || 'النظام'})`, {
            body: sanitizeForUserSw(l.action, user),
            icon: './icons/logo.svg',
            badge: './icons/logo.svg',
            dir: 'rtl',
            lang: 'ar',
            vibrate: [300, 120, 300, 120, 400],
            requireInteraction: true,
            renotify: true,
            tag: l.id,
            data: { targetTab: l.targetTab || 'dashboard' }
          });
          seenSet.add(l.id);
          notified = true;
          break;
        }
      }
    }

    ctx.seenIds = Array.from(seenSet).slice(-350);
    await writeSwUserContext(ctx);
  } catch (_) {}
}

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'SET_USER_CONTEXT') {
    event.waitUntil(writeSwUserContext(data));
  }
});

self.addEventListener('sync', (event) => {
  if (event.tag === 'al-asimah-cloud-sync') {
    event.waitUntil(
      (async () => {
        await flushPendingOfflineStateFromSw();
        await checkCloudForBackgroundNotifications();
      })()
    );
  }
});

self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'al-asimah-bg-check') {
    event.waitUntil(checkCloudForBackgroundNotifications());
  }
});

self.addEventListener('push', (event) => {
  event.waitUntil(checkCloudForBackgroundNotifications());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetTab = event.notification?.data?.targetTab || 'dashboard';
  const targetChatChannel = event.notification?.data?.targetChatChannel || '';

  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clientList) {
        try {
          await client.focus();
          client.postMessage({
            type: 'OPEN_TARGET_TAB',
            targetTab,
            targetChatChannel
          });
          return;
        } catch (_) {}
      }
      if (self.clients.openWindow) {
        await self.clients.openWindow(`./index.html#${targetTab}`);
      }
    })()
  );
});

setInterval(() => {
  checkCloudForBackgroundNotifications();
}, 15000);
