// Background Service Worker:
// 1. Descarga de imágenes sin bloqueo CORS para análisis en Canvas
// 2. Notificaciones nativas de Windows (1 sola vez por Ticket) con enfoque de ventana al hacer clic

const notifiedTicketsMemory = new Set();
const notificationTabMap = new Map();

// Cargar registro de tickets ya notificados para no repetir alertas
chrome.storage.local.get(["laraigo_notified_tickets"], (res) => {
  if (res.laraigo_notified_tickets && typeof res.laraigo_notified_tickets === "object") {
    const now = Date.now();
    for (const [tkt, ts] of Object.entries(res.laraigo_notified_tickets)) {
      if (now - ts < 24 * 60 * 60 * 1000) {
        notifiedTicketsMemory.add(tkt);
      }
    }
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // 1. Fetch de imagen en Base64 para evitar bloqueo CORS en Canvas
  if (request.action === "fetchImageAsDataUrl" && request.url) {
    fetch(request.url, { credentials: "include" })
      .then(response => response.blob())
      .then(blob => {
        const reader = new FileReader();
        reader.onloadend = () => {
          sendResponse({ ok: true, dataUrl: reader.result });
        };
        reader.onerror = () => {
          sendResponse({ ok: false });
        };
        reader.readAsDataURL(blob);
      })
      .catch(() => {
        sendResponse({ ok: false });
      });
    return true;
  }

  // 2. Notificación Nativa de Windows (con filtro de 1 sola vez por Ticket)
  if (request.action === "notifyNewTicket" && request.ticketKey) {
    const ticketKey = String(request.ticketKey).trim();
    if (!ticketKey || notifiedTicketsMemory.has(ticketKey)) {
      sendResponse({ ok: false, duplicate: true });
      return false;
    }

    notifiedTicketsMemory.add(ticketKey);

    chrome.storage.local.get(["laraigo_notified_tickets"], (res) => {
      const reg = res.laraigo_notified_tickets || {};
      reg[ticketKey] = Date.now();
      chrome.storage.local.set({ laraigo_notified_tickets: reg });
    });

    const notificationId = "laraigo_ticket_" + ticketKey + "_" + Date.now();
    if (sender && sender.tab) {
      notificationTabMap.set(notificationId, {
        tabId: sender.tab.id,
        windowId: sender.tab.windowId
      });
    }

    const titleText = request.ticketNum
      ? `🚨 ¡Nuevo Ticket en Laraigo! (#${request.ticketNum})`
      : `🚨 ¡Nuevo Ticket Asignado en Laraigo!`;

    const bodyText = request.techName
      ? `Técnico: ${request.techName}`
      : `Tienes un nuevo ticket por atender en tu bandeja de Asignados.`;

    chrome.notifications.create(
      notificationId,
      {
        type: "basic",
        iconUrl: "icon128.png",
        title: titleText,
        message: bodyText,
        priority: 2
      },
      () => {
        sendResponse({ ok: true });
      }
    );

    return true;
  }
});

// Al hacer clic en la notificación de Windows, llevar al frente la ventana/pestaña de Laraigo
chrome.notifications.onClicked.addListener((notificationId) => {
  const target = notificationTabMap.get(notificationId);
  if (target) {
    if (target.windowId) {
      chrome.windows.update(target.windowId, { focused: true }, () => {
        void chrome.runtime.lastError;
      });
    }
    if (target.tabId) {
      chrome.tabs.update(target.tabId, { active: true }, () => {
        void chrome.runtime.lastError;
      });
    }
    notificationTabMap.delete(notificationId);
  }
  chrome.notifications.clear(notificationId);
});
