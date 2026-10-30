// Laraigo Auto-Reply Copilot - Especial Soporte Técnico Claro (Versión Auditada v1.4)
// Mejoras clave de fiabilidad de envío:
//   1. Espera inteligente de carga del chat (waitForTicketContentToLoad + waitForChatInput) tras abrir un ticket
//   2. Envío verificado con reintentos automáticos (pasteAndSendWithRetry): comprueba que la caja de texto quede vacía;
//      si el texto sigue en la caja, reintenta hasta 4 veces combinando Enter, eventos Angular/React y clic en el botón Enviar
//   3. Saludo inmediato (0s) ➔ Espera de 5s para recibir fotos/cintillos/textos ➔ 2° Respuesta inteligente

(function () {
  'use strict';

  const BASE_GREETING = "Hola Técnico, Procederemos con la atención";
  const SECOND_MESSAGE_DELAY_MS = 5000; // 5 segundos de espera antes del 2° mensaje

  const SUBMOTIVO_MAP = [
    {
      id: "reenvio",
      name: "Reenvío de señal",
      keywords: ["reenvio"],
      defaultQuestion: "enviar captura de reenvio desde su toa"
    },
    {
      id: "cintillos",
      name: "Consulta de Cintillos",
      keywords: ["cintillo", "fat", "tap"],
      defaultQuestion: "Enviar captura de imagen de Fat/Tap y cintillos"
    },
    {
      id: "mesh",
      name: "Registro de Mesh",
      keywords: ["mesh", "repetidor"],
      defaultQuestion: "Enviar imagen del repetidor"
    },
    {
      id: "manto",
      name: "SOT de Manto",
      keywords: ["manto", "mantenimiento"],
      defaultQuestion: "Enviar motivo de sot de manto"
    },
    {
      id: "pext",
      name: "Derivación a PEXT",
      keywords: ["pext", "derivacion", "planta externa"],
      defaultQuestion: "Enviar evidencias porfavor"
    },
    {
      id: "activaciones",
      name: "Activaciones",
      keywords: ["activacion", "activar"],
      defaultQuestion: "enviar error de toa"
    }
  ];

  function normalizeText(str) {
    return (str || '')
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim();
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ==============================================================
  // ESTADO INDEPENDIENTE POR PESTAÑA Y MODOS DE OPERACIÓN
  //   - 'greeting_only': Solo Notificación + Saludo Instantáneo (0s)
  //   - 'full_beta':     Modo Completo + 2° Respuestas Inteligentes (BETA)
  // ==============================================================
  let isDisabledInThisTab = sessionStorage.getItem('laraigo_copilot_tab_disabled') === 'true';
  let currentOperationMode = localStorage.getItem('laraigo_copilot_mode') === 'greeting_only'
    ? 'greeting_only'
    : (localStorage.getItem('laraigo_copilot_mode') === 'full_beta' ? 'full_beta' : 'greeting_only');
  let isMinimizedToCube = localStorage.getItem('laraigo_copilot_minimized') === 'true';
  let manualObserver = null;
  let inboxArrivalObserver = null;

  // ==============================================================
  // FILTRO ANTI-DUPLICADOS SINCRONIZADO ENTRE PESTAÑAS
  // ==============================================================
  let answeredRegistry = {};
  let skippedTickets = new Set();
  let isSendingLock = false;
  let isStepInProgress = false;

  chrome.storage.local.get(["laraigo_answered_registry", "laraigo_copilot_mode"], (res) => {
    if (res.laraigo_answered_registry) {
      const now = Date.now();
      const cleaned = {};
      for (const [key, ts] of Object.entries(res.laraigo_answered_registry)) {
        if (now - ts < 24 * 60 * 60 * 1000) {
          cleaned[key] = ts;
        }
      }
      answeredRegistry = cleaned;
      chrome.storage.local.set({ laraigo_answered_registry: answeredRegistry });
    }
    if (res.laraigo_copilot_mode === 'greeting_only' || res.laraigo_copilot_mode === 'full_beta') {
      if (res.laraigo_copilot_mode !== currentOperationMode) {
        setOperationMode(res.laraigo_copilot_mode, false);
      }
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local") {
      if (changes.laraigo_answered_registry?.newValue) {
        answeredRegistry = changes.laraigo_answered_registry.newValue;
      }
      if (changes.laraigo_copilot_mode?.newValue) {
        const newMode = changes.laraigo_copilot_mode.newValue;
        if ((newMode === 'greeting_only' || newMode === 'full_beta') && newMode !== currentOperationMode) {
          setOperationMode(newMode, false);
        }
      }
    }
  });

  function markTicketAsGreeted(sot, ticketNum, convId) {
    const now = Date.now();
    if (sot) {
      const cleanSot = String(sot).trim();
      if (cleanSot) answeredRegistry[`GREETED_SOT_${cleanSot}`] = answeredRegistry[`GREETED_SOT_${cleanSot}`] || now;
    }
    if (ticketNum) {
      const cleanTkt = String(ticketNum).trim();
      if (cleanTkt) {
        apiGreetedTickets.add(cleanTkt);
        answeredRegistry[`GREETED_TKT_${cleanTkt}`] = answeredRegistry[`GREETED_TKT_${cleanTkt}`] || now;
      }
    }
    if (convId) {
      const cleanConv = String(convId).trim();
      if (cleanConv && cleanConv !== '0') {
        answeredRegistry[`GREETED_CONV_${cleanConv}`] = answeredRegistry[`GREETED_CONV_${cleanConv}`] || now;
      }
    }
    chrome.storage.local.set({ laraigo_answered_registry: answeredRegistry });
  }

  function wasTicketAlreadyGreeted(sot, ticketNum, convId) {
    if (ticketNum) {
      const cleanTkt = String(ticketNum).trim();
      if (apiGreetedTickets.has(cleanTkt)) return true;
      if (answeredRegistry[`GREETED_TKT_${cleanTkt}`] || answeredRegistry[`TICKET_${cleanTkt}`]) return true;
      return false;
    }
    if (convId) {
      const cleanConv = String(convId).trim();
      if (answeredRegistry[`GREETED_CONV_${cleanConv}`] || answeredRegistry[`CONV_${cleanConv}`]) return true;
    }
    if (sot) {
      const cleanSot = String(sot).trim();
      if (answeredRegistry[`GREETED_SOT_${cleanSot}`] || answeredRegistry[`SOT_${cleanSot}`]) return true;
    }
    return false;
  }

  function markTicketAsAnswered(sot, ticketNum, signature, convId = null) {
    const now = Date.now();
    if (sot) answeredRegistry[`SOT_${sot}`] = now;
    if (ticketNum) answeredRegistry[`TICKET_${String(ticketNum).trim()}`] = now;
    if (signature) answeredRegistry[`SIG_${signature}`] = now;
    if (convId) answeredRegistry[`CONV_${convId}`] = now;
    markTicketAsGreeted(sot, ticketNum, convId);
    chrome.storage.local.set({ laraigo_answered_registry: answeredRegistry });
  }

  function wasTicketAlreadyAnsweredInStorage(sot, ticketNum, signature, convId = null) {
    // Si conocemos el número de Ticket, ese número es la clave única del ticket en Laraigo
    // (evita que una SOT repetida de un ticket anterior bloquee el 2° mensaje de un ticket nuevo)
    if (ticketNum) {
      const cleanTkt = String(ticketNum).trim();
      if (answeredRegistry[`TICKET_${cleanTkt}`]) {
        return { answered: true, reason: `El Ticket ${cleanTkt} ya fue respondido.` };
      }
      return { answered: false };
    }
    if (convId && answeredRegistry[`CONV_${convId}`]) {
      return { answered: true, reason: `La conversación ${convId} ya fue respondida.` };
    }
    if (sot && answeredRegistry[`SOT_${sot}`]) {
      return { answered: true, reason: `La SOT ${sot} ya fue respondida.` };
    }
    if (signature && answeredRegistry[`SIG_${signature}`]) {
      return { answered: true, reason: `Este ticket ya fue respondido.` };
    }
    return { answered: false };
  }

  let isScanningQueue = !isDisabledInThisTab;
  let isPausedForQuestion = false;
  let scannerLoopTimeout = null;
  let currentTicketIndex = 0;

  const imageClassificationCache = new Map();

  // ==============================================================
  // PUENTE DE RED CON LA API DE LARAIGO (page-bridge.js)
  // Permite leer Submotivo/SOT directo del JSON (UFN_CONVERSATION_PERSON_SEL / INTERACTION)
  // sin depender del scroll, y enviar mensajes directo a POST /api/ticket/reply
  // ==============================================================
  const apiTicketsByTicketNum = new Map();
  const apiTicketsByConvId = new Map();
  const apiInteractionsByConvId = new Map();
  const apiPersonByTicketNum = new Map();
  const apiGreetedTickets = new Set();
  const greetedTimestampByTicket = new Map();
  const backgroundTicketsInProgress = new Set();
  const notifiedTicketsLocalSet = new Set();
  const pendingBridgeRequests = new Map();
  let lastOpenedTicketNum = null;
  let lastOpenedConvId = null;

  // Enviar notificación nativa de Windows (Punto 1) con filtro de 1 sola vez por Ticket (Punto 5)
  function notifyNewTicketOnce(ticketNum, techName = '') {
    if (isDisabledInThisTab) return;
    const cleanNum = String(ticketNum || '').trim();
    if (!cleanNum) return;

    const ticketKey = `TKT_${cleanNum}`;
    if (notifiedTicketsLocalSet.has(ticketKey)) return;
    if (wasTicketAlreadyAnsweredInStorage(null, cleanNum, null).answered) return;

    notifiedTicketsLocalSet.add(ticketKey);

    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      try {
        chrome.runtime.sendMessage({
          action: "notifyNewTicket",
          ticketKey,
          ticketNum: cleanNum,
          techName: String(techName || '').trim()
        });
      } catch (e) {}
    }
  }

  window.addEventListener('message', async (event) => {
    if (event.source !== window || !event.data || event.data.source !== 'LARAIGO_BRIDGE') return;

    const msg = event.data;

    // 1. Respuesta a comandos enviados desde content.js (SEND_API_REPLY / FETCH_CONVERSATION_INTERACTIONS / POLL_ASSIGNED)
    if (
      (msg.type === 'API_REPLY_RESULT' ||
        msg.type === 'FETCH_INTERACTIONS_RESULT' ||
        msg.type === 'POLL_ASSIGNED_RESULT') &&
      msg.requestId
    ) {
      const resolver = pendingBridgeRequests.get(msg.requestId);
      if (resolver) {
        pendingBridgeRequests.delete(msg.requestId);
        resolver(msg);
      }
      return;
    }

    // 2. Lista de tickets en bandeja "Asignados" (UFN_CONVERSATION_SEL_TICKETSBYUSER)
    if (msg.type === 'ASSIGNED_TICKETS' && Array.isArray(msg.tickets)) {
      for (const t of msg.tickets) {
        if (!t || !t.ticketnum) continue;
        const tNum = String(t.ticketnum).trim();
        const cId = Number(t.conversationid);
        const statusUpper = String(t.status || '').toUpperCase();
        if (statusUpper && statusUpper !== 'ASIGNADO') continue;

        apiTicketsByTicketNum.set(tNum, t);
        if (cId) apiTicketsByConvId.set(cId, t);

        // Notificación nativa de Windows (1 sola vez por Ticket) apenas aparece en ASIGNADO (sin entrar al ticket)
        if (!isDisabledInThisTab) {
          notifyNewTicketOnce(tNum, t.displayname || '');
        }

        // Atención automática 100% en 2° plano por API (sin entrar al ticket ni scrollear)
        if (!isDisabledInThisTab && isScanningQueue && !isPausedForQuestion) {
          processTicketInBackgroundViaApi(t);
        }
      }
    }

    // 3. Historial de mensajes de la conversación (UFN_CONVERSATION_SEL_INTERACTION)
    if (msg.type === 'INTERACTIONS' && msg.conversationid && Array.isArray(msg.interactions)) {
      const cId = Number(msg.conversationid);
      apiInteractionsByConvId.set(cId, msg.interactions);
      const matchedTkt = apiTicketsByConvId.get(cId);
      // Solo actualizar lastOpenedConvId / lastOpenedTicketNum si fue clic del usuario en la UI (no desde llamadas en 2° plano)
      if (!msg.isFromBackground) {
        lastOpenedConvId = cId;
        if (matchedTkt && matchedTkt.ticketnum) {
          lastOpenedTicketNum = String(matchedTkt.ticketnum).trim();
        }
      }
      if (doesInteractionsListHaveGreeting(msg.interactions)) {
        markTicketAsGreeted(null, matchedTkt?.ticketnum || null, cId);
      }
    }

    // 4. Datos completos de la persona y variablecontext (incluye useranswer con SOT y Submotivo)
    if (msg.type === 'PERSON_CONTEXT' && msg.person) {
      const p = msg.person;
      const tNum = String(p.ticketnum || p.variablecontext?.ticketnum || '').trim();
      const cId = Number(p.variablecontext?.conversationid || 0);
      if (tNum) {
        apiPersonByTicketNum.set(tNum, p);
        if (!msg.isFromBackground) {
          lastOpenedTicketNum = tNum;
        }
      }
      if (cId && !msg.isFromBackground) {
        lastOpenedConvId = cId;
      }
      if (tNum && cId && !apiTicketsByTicketNum.has(tNum)) {
        const synthesized = {
          conversationid: cId,
          ticketnum: tNum,
          personid: Number(p.personid || p.variablecontext?.personid),
          communicationchannelid: Number(p.lastcommunicationchannelid || p.variablecontext?.communicationchannelid || 64),
          personcommunicationchannel: String(p.variablecontext?.personcommunicationchannel || ''),
          communicationchannelsite: String(p.variablecontext?.communicationchannelsite || '51915021111'),
          communicationchanneltype: 'WHAL',
          postexternalid: null,
          status: 'ASIGNADO'
        };
        apiTicketsByTicketNum.set(tNum, synthesized);
        apiTicketsByConvId.set(cId, synthesized);
      }
    }
  });

  function getActiveTicketMeta(explicitTicketNum = null) {
    const tNum = explicitTicketNum || getCurrentLaraigoTicketNumber();
    if (tNum && apiTicketsByTicketNum.has(tNum)) {
      return apiTicketsByTicketNum.get(tNum);
    }
    if (tNum && apiPersonByTicketNum.has(tNum)) {
      const p = apiPersonByTicketNum.get(tNum);
      const vc = p.variablecontext || {};
      if (vc.conversationid && (p.personid || vc.personid)) {
        return {
          conversationid: Number(vc.conversationid),
          ticketnum: tNum,
          personid: Number(p.personid || vc.personid),
          communicationchannelid: Number(p.lastcommunicationchannelid || vc.communicationchannelid || 64),
          personcommunicationchannel: String(vc.personcommunicationchannel || ''),
          communicationchannelsite: String(vc.communicationchannelsite || '51915021111'),
          communicationchanneltype: 'WHAL',
          postexternalid: null
        };
      }
    }
    if (apiTicketsByTicketNum.size === 1) {
      return Array.from(apiTicketsByTicketNum.values())[0];
    }
    return null;
  }

  function getCurrentTicketInteractionsSlice(interactions) {
    if (!Array.isArray(interactions) || interactions.length === 0) return [];
    let lastSubmotivoIdx = -1;
    for (let i = interactions.length - 1; i >= 0; i--) {
      const item = interactions[i];
      if (!item || item.interactiontype === 'LOG') continue;
      const txt = String(item.interactiontext || '');
      if (/submotivo\s*:/i.test(txt)) {
        lastSubmotivoIdx = i;
        break;
      }
    }
    if (lastSubmotivoIdx >= 0) {
      return interactions.slice(lastSubmotivoIdx);
    }
    return interactions;
  }

  function getApiCollectedTextForTicket(explicitTicketNum = null) {
    const tNum = explicitTicketNum || getCurrentLaraigoTicketNumber();
    const meta = getActiveTicketMeta(tNum);
    const person = tNum ? apiPersonByTicketNum.get(tNum) : null;
    let combined = '';

    // 1. useranswer en variablecontext trae la plantilla completa con SOT y Submotivo sin scrollear
    if (person && person.variablecontext) {
      const vc = typeof person.variablecontext === 'string'
        ? (() => { try { return JSON.parse(person.variablecontext); } catch (e) { return {}; } })()
        : person.variablecontext;
      const vcTkt = String(person.ticketnum || vc?.ticketnum || '').trim();
      if ((!tNum || !vcTkt || vcTkt === String(tNum).trim()) && vc?.useranswer) {
        combined += '\n' + vc.useranswer;
      }
    }

    // 2. Respaldo desde lastmessage del ticket en Asignados si contiene la plantilla
    if (meta && meta.lastmessage && /submotivo\s*:/i.test(String(meta.lastmessage))) {
      combined += '\n' + String(meta.lastmessage);
    }

    // 3. Interacciones del ticket actual desde UFN_CONVERSATION_SEL_INTERACTION
    const convId = meta?.conversationid || Number(person?.variablecontext?.conversationid || 0);
    if (convId && apiInteractionsByConvId.has(Number(convId))) {
      const rawInteractions = apiInteractionsByConvId.get(Number(convId)) || [];
      const currentSlice = getCurrentTicketInteractionsSlice(rawInteractions);
      for (const item of currentSlice) {
        if (item && item.interactiontype === 'text' && item.interactiontext && item.usertype !== 'BOT') {
          combined += '\n' + item.interactiontext;
        }
      }
    }

    return combined;
  }

  function sendMessageViaLaraigoApi(messageText, explicitTicketMeta = null, isFirstReply = false) {
    const ticketMeta = explicitTicketMeta || getActiveTicketMeta();
    if (!ticketMeta || !ticketMeta.conversationid || !ticketMeta.personid) {
      return Promise.resolve(false);
    }

    const reqId = 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingBridgeRequests.delete(reqId);
        resolve(false);
      }, 7500);

      pendingBridgeRequests.set(reqId, (res) => {
        clearTimeout(timer);
        resolve(Boolean(res && res.ok));
      });

      window.postMessage({
        source: 'LARAIGO_CONTENT',
        action: 'SEND_API_REPLY',
        requestId: reqId,
        payload: {
          ticketMeta,
          messageText,
          isFirstReply
        }
      }, '*');
    });
  }

  function fetchConversationDetailsViaBridge(conversationid, personid, ticketnum = null) {
    if (!conversationid) return Promise.resolve({ ok: false, interactions: [], person: null });

    const reqId = 'fetch_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingBridgeRequests.delete(reqId);
        resolve({
          ok: false,
          interactions: apiInteractionsByConvId.get(Number(conversationid)) || [],
          person: ticketnum ? (apiPersonByTicketNum.get(String(ticketnum).trim()) || null) : null
        });
      }, 5500);

      pendingBridgeRequests.set(reqId, (res) => {
        clearTimeout(timer);
        if (res && Array.isArray(res.interactions) && res.interactions.length > 0) {
          apiInteractionsByConvId.set(Number(conversationid), res.interactions);
        }
        if (res && res.person) {
          const pTkt = String(res.person.ticketnum || res.person.variablecontext?.ticketnum || ticketnum || '').trim();
          if (pTkt) apiPersonByTicketNum.set(pTkt, res.person);
        }
        resolve({
          ok: Boolean(res && res.ok),
          interactions: res?.interactions || apiInteractionsByConvId.get(Number(conversationid)) || [],
          person: res?.person || (ticketnum ? (apiPersonByTicketNum.get(String(ticketnum).trim()) || null) : null)
        });
      });

      window.postMessage({
        source: 'LARAIGO_CONTENT',
        action: 'FETCH_CONVERSATION_INTERACTIONS',
        requestId: reqId,
        payload: { conversationid, personid, ticketnum }
      }, '*');
    });
  }

  function pollAssignedTicketsViaBridge() {
    const reqId = 'poll_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingBridgeRequests.delete(reqId);
        resolve(false);
      }, 2500);

      pendingBridgeRequests.set(reqId, (res) => {
        clearTimeout(timer);
        resolve(Boolean(res && res.ok));
      });

      window.postMessage({
        source: 'LARAIGO_CONTENT',
        action: 'POLL_ASSIGNED_TICKETS',
        requestId: reqId,
        payload: {}
      }, '*');
    });
  }

  // ==============================================================
  // DELIMITADOR GEOMÉTRICO DEL PANEL IZQUIERDO ("Asignados") Y CHAT CENTRAL
  // ==============================================================
  function isElementInOurOverlay(el) {
    if (!el) return false;
    const widget = document.getElementById('laraigo-copilot-container');
    const pill = document.getElementById('laraigo-disabled-pill');
    const toast = document.getElementById('lc-toast');
    if (widget && widget.contains(el)) return true;
    if (pill && pill.contains(el)) return true;
    if (toast && toast.contains(el)) return true;
    return false;
  }

  function getAsignadosColumnInfo() {
    const allEls = Array.from(document.querySelectorAll('div, span, a, button, li'));
    let asignadosEl = null;
    let assignedCount = 0;

    for (const el of allEls) {
      if (isElementInOurOverlay(el)) continue;
      if (el.offsetParent === null) continue;
      const txt = (el.innerText || '').trim();
      const match = txt.match(/^Asignados\s*\((\d+)\)$/i);
      if (match) {
        asignadosEl = el;
        assignedCount = parseInt(match[1], 10);
        break;
      }
    }

    if (!asignadosEl) {
      return null;
    }

    const tabRect = asignadosEl.getBoundingClientRect();

    let tabBar = asignadosEl.parentElement;
    let colLeft = Math.max(30, tabRect.left - 15);
    let colRight = Math.max(tabRect.right + 140, 240);
    let tabBarBottom = tabRect.bottom;

    for (let i = 0; i < 6; i++) {
      if (!tabBar || tabBar === document.body) break;
      const r = tabBar.getBoundingClientRect();
      const t = (tabBar.innerText || '');
      if (t.includes('Pausados') && r.width >= 140 && r.width <= 450) {
        colLeft = r.left;
        colRight = r.right;
        if (r.height < 80) {
          tabBarBottom = r.bottom;
        }
        break;
      }
      tabBar = tabBar.parentElement;
    }

    let leftColumnContainer = asignadosEl.parentElement;
    for (let i = 0; i < 7; i++) {
      if (!leftColumnContainer || leftColumnContainer === document.body) break;
      const r = leftColumnContainer.getBoundingClientRect();
      if (r.height > 260 && r.width >= 140 && r.width <= 460) {
        colLeft = r.left;
        colRight = r.right;
        break;
      }
      leftColumnContainer = leftColumnContainer.parentElement;
    }

    return {
      asignadosEl,
      assignedCount,
      colLeft,
      colRight,
      tabBarBottom,
      leftColumnContainer: leftColumnContainer || document.body
    };
  }

  function getChatColumnBounds() {
    let minLeft = 140;
    let maxRight = window.innerWidth;

    const asigInfo = getAsignadosColumnInfo();
    if (asigInfo) {
      minLeft = Math.max(120, asigInfo.colRight - 5);
    }

    const allEls = Array.from(document.querySelectorAll('div, span, a, button'));
    for (const el of allEls) {
      if (isElementInOurOverlay(el)) continue;
      const txt = (el.innerText || '').trim();
      if (txt === 'Vincular' || txt === 'Información' || txt === 'Variables') {
        const r = el.getBoundingClientRect();
        if (r.left > window.innerWidth * 0.45) {
          let panel = el.parentElement;
          for (let i = 0; i < 6; i++) {
            if (!panel || panel === document.body) break;
            const pr = panel.getBoundingClientRect();
            if (pr.height > 250 && pr.left > minLeft + 150) {
              maxRight = Math.min(maxRight, pr.left + 10);
              break;
            }
            panel = panel.parentElement;
          }
        }
      }
    }

    return { minLeft, maxRight };
  }

  function findChatMessagesScrollContainer() {
    const { minLeft, maxRight } = getChatColumnBounds();
    const allDivs = Array.from(document.querySelectorAll('div'));

    let bestCandidate = null;
    let maxScore = 0;

    for (const div of allDivs) {
      if (isElementInOurOverlay(div)) continue;
      if (div.offsetParent === null) continue;

      const rect = div.getBoundingClientRect();
      if (rect.left < minLeft - 30 || rect.right > maxRight + 40) continue;
      if (div.clientHeight < 140 || div.clientWidth < 160) continue;

      const style = window.getComputedStyle(div);
      const overflowY = style.overflowY;
      const isScrollable = (overflowY === 'auto' || overflowY === 'scroll');

      const text = (div.innerText || '').toLowerCase();
      const hasChatIndicators =
        text.includes('mensaje entregado') ||
        text.includes('submotivo:') ||
        text.includes('hola, soy el') ||
        text.includes('hola técnico') ||
        text.includes('asignado a holding') ||
        div.querySelectorAll('img, video').length > 0;

      if (hasChatIndicators && isScrollable) {
        const score = div.clientHeight * (div.scrollHeight > div.clientHeight ? 3 : 1);
        if (score > maxScore) {
          maxScore = score;
          bestCandidate = div;
        }
      }
    }

    return bestCandidate;
  }

  // Recolectar datos completos del ticket por API sin mover el scroll de la pantalla
  async function scrollChatAndCollectFullData(explicitTicketNum = null) {
    const meta = getActiveTicketMeta(explicitTicketNum);
    if (meta && meta.conversationid) {
      await fetchConversationDetailsViaBridge(meta.conversationid, meta.personid);
    }

    const scrollContainer = findChatMessagesScrollContainer();
    let collectedText = getApiCollectedTextForTicket(explicitTicketNum) || '';

    if (scrollContainer && (!explicitTicketNum || explicitTicketNum === getCurrentLaraigoTicketNumber())) {
      collectedText += '\n' + (scrollContainer.innerText || '');
    }

    const detected = scanScreenForSubmotivo(collectedText, explicitTicketNum);
    const contextStats = await analyzeFullTicketContext(detected, collectedText, explicitTicketNum);

    return { detected, contextStats };
  }

  // Esperar hasta 3.5 segundos a que carguen los mensajes y la caja de texto cuando recién se abre un ticket
  async function waitForTicketContentToLoad(maxWaitMs = 3500) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      if (isConversationBlockedByHSM()) return true;
      const hasSubmotivo = !!scanScreenForSubmotivo();
      const hasInput = !!findChatInput();
      if (hasSubmotivo && hasInput) return true;
      await sleep(250);
    }
    return false;
  }

  // ==============================================================
  // ANALIZADOR DE IMÁGENES, VIDEOS, NÚMEROS DE CINTILLOS Y TEXTO
  // ==============================================================
  function getChatAttachmentImages() {
    const { minLeft, maxRight } = getChatColumnBounds();
    const allImgs = Array.from(document.querySelectorAll('img'));

    return allImgs.filter(img => {
      if (isElementInOurOverlay(img)) return false;
      if (img.offsetParent === null) return false;
      const rect = img.getBoundingClientRect();
      if (rect.left < minLeft - 20 || rect.left > maxRight - 30) return false;
      if (rect.width < 95 || rect.height < 95) return false;
      const src = (img.src || '').toLowerCase();
      if (!src || src.includes('avatar') || src.includes('emoji') || src.includes('logo') || src.includes('profile')) return false;
      return true;
    });
  }

  async function waitForChatImagesToLoad(imgs, maxWaitMs = 1500) {
    const pending = imgs.filter(img => !img.complete || img.naturalWidth === 0);
    if (pending.length === 0) return;

    await Promise.race([
      Promise.all(
        pending.map(img => new Promise(res => {
          img.addEventListener('load', res, { once: true });
          img.addEventListener('error', res, { once: true });
        }))
      ),
      sleep(maxWaitMs)
    ]);
  }

  function hasVideoInChat() {
    const { minLeft, maxRight } = getChatColumnBounds();
    const videos = Array.from(
      document.querySelectorAll('video, a[href*=".mp4"], a[href*=".mov"], a[href*=".3gp"], [class*="video-player"], [class*="video_message"]')
    ).filter(el => {
      if (isElementInOurOverlay(el)) return false;
      if (el.offsetParent === null) return false;
      const r = el.getBoundingClientRect();
      return r.left >= minLeft - 20 && r.left <= maxRight;
    });
    return videos.length > 0;
  }

  function analyzePixelsFromImageSource(imgSource) {
    const SIZE = 120;
    const canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(imgSource, 0, 0, SIZE, SIZE);

    const imgData = ctx.getImageData(0, 0, SIZE, SIZE).data;
    let flatStrictCount = 0;
    let totalPairs = 0;
    let uiBgCount = 0;
    let darkUiCount = 0;
    const totalPixels = SIZE * SIZE;

    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const idx = (y * SIZE + x) * 4;
        const r = imgData[idx];
        const g = imgData[idx + 1];
        const b = imgData[idx + 2];

        const maxC = Math.max(r, g, b);
        const minC = Math.min(r, g, b);
        const sat = maxC - minC;

        if (sat <= 14 && minC > 130) {
          uiBgCount++;
        } else if (sat <= 12 && maxC < 45) {
          darkUiCount++;
        }

        if (x < SIZE - 1) {
          const idxNext = (y * SIZE + (x + 1)) * 4;
          const r2 = imgData[idxNext];
          const g2 = imgData[idxNext + 1];
          const b2 = imgData[idxNext + 2];
          const diff = Math.abs(r - r2) + Math.abs(g - g2) + Math.abs(b - b2);
          if (diff <= 3) {
            flatStrictCount++;
          }
          totalPairs++;
        }
      }
    }

    const flatStrictRatio = flatStrictCount / totalPairs;
    const uiBgRatio = uiBgCount / totalPixels;
    const darkUiRatio = darkUiCount / totalPixels;

    const isAppScreenshot =
      (flatStrictRatio >= 0.55 && uiBgRatio >= 0.25) ||
      uiBgRatio >= 0.45 ||
      (flatStrictRatio >= 0.68 && (uiBgRatio + darkUiRatio) >= 0.40);

    return {
      type: isAppScreenshot ? 'app_screenshot' : 'equipment_photo',
      flatStrictRatio,
      uiBgRatio
    };
  }

  function classifyImageUrlInMemory(src) {
    return new Promise((resolve) => {
      if (!src) {
        resolve({ type: 'unknown' });
        return;
      }
      if (imageClassificationCache.has(src)) {
        resolve(imageClassificationCache.get(src));
        return;
      }

      let settled = false;
      const finish = (val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        resolve(val);
      };

      const timeoutId = setTimeout(() => {
        finish({ type: 'equipment_photo' });
      }, 2200);

      const fallbackDirectImgLoad = () => {
        try {
          const directImg = new Image();
          directImg.onload = () => {
            try {
              const res = analyzePixelsFromImageSource(directImg);
              imageClassificationCache.set(src, res);
              finish(res);
            } catch (corsErr) {
              const w = directImg.naturalWidth || 1;
              const h = directImg.naturalHeight || 1;
              const isVerticalPhoneScreen = (h / w) >= 1.55;
              const res = { type: isVerticalPhoneScreen ? 'app_screenshot' : 'equipment_photo' };
              imageClassificationCache.set(src, res);
              finish(res);
            }
          };
          directImg.onerror = () => finish({ type: 'equipment_photo' });
          directImg.src = src;
        } catch (e) {
          finish({ type: 'equipment_photo' });
        }
      };

      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        try {
          chrome.runtime.sendMessage({ action: "fetchImageAsDataUrl", url: src }, (response) => {
            if (chrome.runtime.lastError || !response || !response.ok || !response.dataUrl) {
              fallbackDirectImgLoad();
              return;
            }
            const tempImg = new Image();
            tempImg.onload = () => {
              try {
                const res = analyzePixelsFromImageSource(tempImg);
                imageClassificationCache.set(src, res);
                finish(res);
              } catch (e) {
                fallbackDirectImgLoad();
              }
            };
            tempImg.onerror = () => fallbackDirectImgLoad();
            tempImg.src = response.dataUrl;
          });
        } catch (err) {
          fallbackDirectImgLoad();
        }
      } else {
        fallbackDirectImgLoad();
      }
    });
  }

  function classifySingleImageElement(imgEl) {
    return new Promise((resolve) => {
      const src = imgEl.src;
      if (!src) {
        resolve({ type: 'unknown' });
        return;
      }

      if (imageClassificationCache.has(src)) {
        resolve(imageClassificationCache.get(src));
        return;
      }

      try {
        if (imgEl.complete && imgEl.naturalWidth > 0) {
          const res = analyzePixelsFromImageSource(imgEl);
          imageClassificationCache.set(src, res);
          resolve(res);
          return;
        }
      } catch (corsErr) {}

      classifyImageUrlInMemory(src).then((res) => {
        if (res && res.type !== 'unknown') {
          resolve(res);
        } else {
          const w = imgEl.naturalWidth || imgEl.clientWidth || 1;
          const h = imgEl.naturalHeight || imgEl.clientHeight || 1;
          const isVerticalPhoneScreen = (h / w) >= 1.55;
          resolve({ type: isVerticalPhoneScreen ? 'app_screenshot' : 'equipment_photo' });
        }
      });
    });
  }

  function getCentralChatOnlyText(extraCollectedText = '', explicitTicketNum = null, forceApiOnly = false) {
    const apiText = getApiCollectedTextForTicket(explicitTicketNum);
    const baseText = (extraCollectedText || '') + (apiText ? '\n' + apiText : '');

    if (forceApiOnly) {
      return baseText;
    }

    const visibleDomTkt = getVisibleDomHeaderTicketNumber();
    if (explicitTicketNum && visibleDomTkt && String(explicitTicketNum).trim() !== String(visibleDomTkt).trim()) {
      return baseText;
    }
    if (explicitTicketNum && !visibleDomTkt) {
      return baseText;
    }

    const scrollContainer = findChatMessagesScrollContainer();
    if (scrollContainer) {
      return baseText + '\n' + (scrollContainer.innerText || '');
    }

    const { minLeft, maxRight } = getChatColumnBounds();
    const nodes = Array.from(document.querySelectorAll('div, p, span'));
    let chatText = baseText;

    for (const node of nodes) {
      if (isElementInOurOverlay(node)) continue;
      if (node.offsetParent === null) continue;
      if (node.children.length > 4) continue;
      const r = node.getBoundingClientRect();
      if (r.left >= minLeft && r.right <= maxRight && r.top > 95 && r.bottom < window.innerHeight - 40) {
        const t = (node.innerText || '').trim();
        if (t) chatText += '\n' + t;
      }
    }

    return chatText;
  }

  function analyzeTechnicianExtraText(detected, extraCollectedText = '', explicitTicketNum = null, forceApiOnly = false) {
    const rawChatText = getCentralChatOnlyText(extraCollectedText, explicitTicketNum, forceApiOnly);

    let cleaned = rawChatText
      .replace(/Hola,\s*soy\s*el\s*t[eé]cnico[\s\S]*?Submotivo\s*:\s*[^\r\n]+/gi, ' ')
      .replace(/Te estamos contactando con un asesor especializado[^\r\n]*/gi, ' ')
      .replace(/ASIGNADO A HOLDING[^\r\n]*/gi, ' ')
      .replace(/REASIGNADO DE HOLDING[^\r\n]*/gi, ' ')
      .replace(/MENSAJE ENTREGADO[^\r\n]*/gi, ' ')
      .replace(/Esta conversaci[oó]n se encuentra bloqueada[^\r\n]*/gi, ' ')
      .replace(/Ticket\s*:\s*\d+/gi, ' ')
      .replace(/Hola T[eé]cnico,\s*Procederemos con la atenci[oó]n\.?/gi, ' ')
      .replace(/enviar error de toa/gi, ' ')
      .replace(/enviar captura de reenvio desde su toa/gi, ' ')
      .replace(/enviar captura de imagen de fat\/tap y cintillos/gi, ' ')
      .replace(/enviar captura de imagen de fat\/tap/gi, ' ')
      .replace(/enviar cintillos/gi, ' ')
      .replace(/enviar imagen del repetidor/gi, ' ')
      .replace(/enviar motivo de sot de manto/gi, ' ')
      .replace(/enviar evidencias porfavor/gi, ' ')
      .replace(/un momento/gi, ' ')
      .replace(/se revisa/gi, ' ')
      .replace(/\b\d{1,2}:\d{2}\b/g, ' ');

    const sotStr = detected?.sot ? String(detected.sot) : '';
    const ticketStr = detected?.ticketNum ? String(detected.ticketNum) : '';

    const numberMatches = cleaned.match(/\b\d{6,9}\b/g) || [];
    const uniqueCintillos = new Set(
      numberMatches.filter(num => {
        if (num === sotStr || num === ticketStr) return false;
        if (num.length === 9 && num.startsWith('9')) return false;
        return true;
      })
    );

    const hasCintillosNumbers = uniqueCintillos.size >= 1;

    const textWithoutNumbers = cleaned
      .replace(/\b\d+\b/g, ' ')
      .replace(/\b(hola|buenas|tardes|dias|noches|buen|dia|por|favor|apoyo|gracias|estimado|asesor|con|la|el|de|en|su|para|activacion|consulta|cintillos|reenvio|mesh|manto|pext|text)\b/gi, ' ')
      .replace(/[^\wáéíóúñÁÉÍÓÚÑ]+/g, ' ')
      .trim();

    const hasExplanationText = textWithoutNumbers.length >= 8;

    return {
      hasCintillosNumbers,
      cintilloCount: uniqueCintillos.size,
      hasExplanationText
    };
  }

  async function analyzeFullTicketContext(detected, extraCollectedText = '', explicitTicketNum = null, explicitInteractions = null, forceApiOnly = false) {
    const tNum = explicitTicketNum || detected?.ticketNum || getCurrentLaraigoTicketNumber();
    const visibleDomTkt = getVisibleDomHeaderTicketNumber();
    const isCurrentlyOpenOnScreen =
      !forceApiOnly && (!explicitTicketNum || (visibleDomTkt && String(explicitTicketNum).trim() === String(visibleDomTkt).trim()));

    let appScreenshots = 0;
    let equipmentPhotos = 0;
    let hasVideo = false;
    const processedUrls = new Set();

    // 1. Analizar imágenes y videos desde el JSON de la API (UFN_CONVERSATION_SEL_INTERACTION) del ticket actual
    const meta = getActiveTicketMeta(tNum);
    const convId = meta?.conversationid || 0;
    const rawInteractions = Array.isArray(explicitInteractions) && explicitInteractions.length > 0
      ? explicitInteractions
      : (convId && apiInteractionsByConvId.has(Number(convId)) ? (apiInteractionsByConvId.get(Number(convId)) || []) : []);
    const currentInteractions = getCurrentTicketInteractionsSlice(rawInteractions);

    for (const item of currentInteractions) {
      if (!item || item.usertype === 'ASESOR' || item.usertype === 'BOT' || item.interactiontype === 'LOG') continue;
      const iType = String(item.interactiontype || '').toLowerCase();
      const iText = String(item.interactiontext || '').trim();

      if (iType.includes('video') || /\.(mp4|mov|3gp|avi|webm)(\?|$)/i.test(iText)) {
        hasVideo = true;
        continue;
      }

      const isImgInteraction =
        iType.includes('image') ||
        iType.includes('photo') ||
        iType.includes('img') ||
        /\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(iText) ||
        (iType !== 'text' && /^https?:\/\//i.test(iText));

      if (isImgInteraction) {
        const urlMatch = iText.match(/https?:\/\/[^\s"'<>]+/i);
        if (urlMatch && urlMatch[0]) {
          const imgUrl = urlMatch[0];
          processedUrls.add(imgUrl);
          const cls = await classifyImageUrlInMemory(imgUrl);
          if (cls.type === 'app_screenshot') {
            appScreenshots++;
          } else {
            equipmentPhotos++;
          }
        } else {
          equipmentPhotos++;
        }
      }
    }

    // 2. Solo si el ticket está literalmente abierto en la pantalla actual, complementar con las imágenes visibles
    if (isCurrentlyOpenOnScreen) {
      const imgs = getChatAttachmentImages();
      await waitForChatImagesToLoad(imgs, 1200);
      for (const img of imgs) {
        if (img.src && processedUrls.has(img.src)) continue;
        const result = await classifySingleImageElement(img);
        if (result.type === 'app_screenshot') {
          appScreenshots++;
        } else {
          equipmentPhotos++;
        }
      }
      if (hasVideoInChat()) {
        hasVideo = true;
      }
    }

    const totalImages = appScreenshots + equipmentPhotos;
    const extraTextStats = analyzeTechnicianExtraText(detected, extraCollectedText, tNum, forceApiOnly);

    return {
      totalImages,
      hasAnyImage: totalImages > 0,
      appScreenshots,
      equipmentPhotos,
      hasAppScreenshot: appScreenshots > 0,
      hasVideo,
      hasCintillosNumbers: extraTextStats.hasCintillosNumbers,
      cintilloCount: extraTextStats.cintilloCount,
      hasExplanationText: extraTextStats.hasExplanationText
    };
  }

  // ==============================================================
  // REGLAS DE DECISIÓN DEL 2° MENSAJE SEGÚN SUBMOTIVO Y EVIDENCIAS
  // ==============================================================
  function resolveSecondMessage(rule, stats) {
    if (!rule) return null;
    if (!stats) return rule.defaultQuestion;

    switch (rule.id) {
      case "activaciones":
        return stats.hasAppScreenshot ? "un momento" : "enviar error de toa";

      case "reenvio":
        return stats.hasAppScreenshot ? "un momento" : "enviar captura de reenvio desde su toa";

      case "mesh":
        return stats.hasAnyImage ? "Un momento" : "Enviar imagen del repetidor";

      case "cintillos":
        if (stats.hasCintillosNumbers && !stats.hasAnyImage) {
          return "Enviar captura de imagen de Fat/Tap";
        }
        if (!stats.hasCintillosNumbers && stats.hasAnyImage) {
          return "Enviar cintillos";
        }
        if (stats.hasCintillosNumbers && stats.hasAnyImage) {
          return "Un momento";
        }
        return "Enviar captura de imagen de Fat/Tap y cintillos";

      case "manto":
        if (stats.hasVideo || stats.hasAnyImage || stats.hasExplanationText) {
          return "Se revisa";
        }
        return "Enviar motivo de sot de manto";

      case "pext":
        if (stats.hasAnyImage || stats.hasVideo) {
          return "Se revisa";
        }
        return "Enviar evidencias porfavor";

      default:
        return rule.defaultQuestion;
    }
  }

  function buildContextSummaryHtml(rule, stats) {
    if (!rule || !stats) return '';

    switch (rule.id) {
      case "activaciones":
      case "reenvio":
        if (stats.hasAppScreenshot) {
          return `<div class="lc-ctx-note ok">📱 Captura App TOA detectada${stats.equipmentPhotos > 0 ? ` (${stats.equipmentPhotos} foto de equipo ignorada)` : ''} ➔ <b>"un momento"</b></div>`;
        }
        if (stats.equipmentPhotos > 0) {
          return `<div class="lc-ctx-note warn">📷 Solo foto de equipo (${stats.equipmentPhotos}) sin captura App TOA ➔ Pedirá captura</div>`;
        }
        return `<div class="lc-ctx-note info">🖼️ Sin captura de App TOA ➔ Pedirá captura</div>`;

      case "mesh":
        if (stats.hasAnyImage) {
          return `<div class="lc-ctx-note ok">📷 Imagen de repetidor detectada (${stats.totalImages}) ➔ <b>"Un momento"</b></div>`;
        }
        return `<div class="lc-ctx-note info">🖼️ Sin imagen de repetidor ➔ <b>"Enviar imagen del repetidor"</b></div>`;

      case "cintillos":
        if (stats.hasCintillosNumbers && !stats.hasAnyImage) {
          return `<div class="lc-ctx-note warn">🔢 Cintillos detectados (${stats.cintilloCount} núm.) pero falta foto ➔ <b>"Enviar captura de imagen de Fat/Tap"</b></div>`;
        }
        if (!stats.hasCintillosNumbers && stats.hasAnyImage) {
          return `<div class="lc-ctx-note warn">📷 Foto detectada pero faltan números ➔ <b>"Enviar cintillos"</b></div>`;
        }
        if (stats.hasCintillosNumbers && stats.hasAnyImage) {
          return `<div class="lc-ctx-note ok">✅ Foto + Cintillos (${stats.cintilloCount}) completos ➔ <b>"Un momento"</b></div>`;
        }
        return `<div class="lc-ctx-note info">⚠️ Sin foto ni cintillos ➔ <b>"Enviar captura de imagen de Fat/Tap y cintillos"</b></div>`;

      case "manto":
        if (stats.hasVideo || stats.hasAnyImage || stats.hasExplanationText) {
          return `<div class="lc-ctx-note ok">✅ Evidencia/motivo detectado en chat ➔ <b>"Se revisa"</b></div>`;
        }
        return `<div class="lc-ctx-note info">⚠️ Sin video, imagen ni explicación ➔ <b>"Enviar motivo de sot de manto"</b></div>`;

      case "pext":
        if (stats.hasAnyImage || stats.hasVideo) {
          return `<div class="lc-ctx-note ok">📷 Imágenes de evidencia detectadas (${stats.totalImages}) ➔ <b>"Se revisa"</b></div>`;
        }
        return `<div class="lc-ctx-note info">⚠️ Sin imágenes de evidencia ➔ <b>"Enviar evidencias porfavor"</b></div>`;

      default:
        return '';
    }
  }

  // ==============================================================
  // LOCALIZAR CAJA DE TEXTO Y ENVIAR MENSAJE CON REINTENTOS VERIFICADOS
  // ==============================================================
  function isConversationBlockedByHSM() {
    const bodyText = normalizeText(document.body.innerText || '');
    return bodyText.includes("esta conversacion se encuentra bloqueada hasta que el cliente responda");
  }

  function isAnyTicketCurrentlyOpenInCenter() {
    if (getCurrentLaraigoTicketNumber()) return true;
    if (findChatInput()) return true;
    if (isConversationBlockedByHSM()) return true;
    return false;
  }

  function findChatInput() {
    const textareas = Array.from(document.querySelectorAll('textarea'));
    for (const ta of textareas) {
      if (isElementInOurOverlay(ta)) continue;
      if (ta.offsetParent !== null && !ta.disabled && !ta.readOnly) {
        return { element: ta, type: 'textarea' };
      }
    }

    const editables = Array.from(document.querySelectorAll('[contenteditable="true"]'));
    for (const ed of editables) {
      if (isElementInOurOverlay(ed)) continue;
      if (ed.offsetParent !== null) {
        return { element: ed, type: 'contenteditable' };
      }
    }

    const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'));
    for (const inp of inputs) {
      if (isElementInOurOverlay(inp)) continue;
      if (inp.offsetParent === null || inp.disabled || inp.readOnly) continue;
      const placeholder = (inp.placeholder || '').toLowerCase();
      if (
        placeholder.includes('mensaje') ||
        placeholder.includes('escribe') ||
        placeholder.includes('chat') ||
        placeholder.includes('responder') ||
        placeholder.includes('texto')
      ) {
        return { element: inp, type: 'input' };
      }
    }

    // Fallback: cualquier input de texto visible en la parte inferior central del chat
    const { minLeft, maxRight } = getChatColumnBounds();
    for (const inp of inputs) {
      if (isElementInOurOverlay(inp)) continue;
      if (inp.offsetParent === null || inp.disabled || inp.readOnly) continue;
      const r = inp.getBoundingClientRect();
      if (r.left >= minLeft - 20 && r.right <= maxRight + 20 && r.top > window.innerHeight * 0.65) {
        return { element: inp, type: 'input' };
      }
    }

    return null;
  }

  // Espera hasta 3 segundos a que la caja de texto esté lista y habilitada
  async function waitForChatInputReady(maxWaitMs = 3000) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      if (isConversationBlockedByHSM()) return null;
      const target = findChatInput();
      if (target && target.element) return target;
      await sleep(150);
    }
    return findChatInput();
  }

  function findSendButtonNearInput(inputElement) {
    if (!inputElement) return null;

    let footerContainer = inputElement.parentElement;
    for (let level = 0; level < 5; level++) {
      if (!footerContainer || footerContainer === document.body) break;
      const candidates = Array.from(
        footerContainer.querySelectorAll('button, [role="button"], a, i[class*="send"], i[class*="paper-plane"], span[class*="send"], mat-icon, svg')
      ).filter(el => {
        if (isElementInOurOverlay(el)) return false;
        if (el.offsetParent === null || el.disabled) return false;
        return true;
      });

      for (const el of candidates) {
        const clickable = el.closest('button, [role="button"], a') || el;
        if (clickable.disabled) continue;
        const descriptor = (
          (clickable.getAttribute('aria-label') || '') + ' ' +
          (clickable.getAttribute('title') || '') + ' ' +
          (clickable.getAttribute('mattooltip') || '') + ' ' +
          (clickable.className || '') + ' ' +
          (clickable.innerText || '') + ' ' +
          (clickable.innerHTML || '')
        ).toLowerCase();

        if (
          descriptor.includes('send') ||
          descriptor.includes('enviar') ||
          descriptor.includes('paper-plane') ||
          descriptor.includes('fa-paper-plane') ||
          descriptor.includes('mdi-send') ||
          clickable.getAttribute('type') === 'submit'
        ) {
          return clickable;
        }
      }

      const buttonsInRow = Array.from(footerContainer.querySelectorAll('button, [role="button"], a')).filter(
        b => !isElementInOurOverlay(b) && b.offsetParent !== null && !b.disabled
      );
      if (buttonsInRow.length > 0) {
        const inputRect = inputElement.getBoundingClientRect();
        const rightButtons = buttonsInRow.filter(b => {
          const rect = b.getBoundingClientRect();
          return rect.left >= inputRect.right - 70 && Math.abs(rect.top - inputRect.top) < 110;
        });
        if (rightButtons.length > 0) {
          return rightButtons[rightButtons.length - 1];
        }
      }

      footerContainer = footerContainer.parentElement;
    }

    return null;
  }

  // Escribir texto en la caja de Laraigo activando todos los listeners de Angular / React / Vue
  function setInputValue(target, text) {
    if (!target || !target.element) return false;
    const { element, type } = target;

    // 1. Hacer clic y enfocar la caja de texto primero
    simulateRealClick(element);
    element.focus();

    if (type === 'textarea' || type === 'input') {
      const proto = type === 'textarea' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const valueSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;

      if (valueSetter) {
        valueSetter.call(element, text);
      } else {
        element.value = text;
      }

      element.dispatchEvent(new Event('focus', { bubbles: true }));
      element.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
      element.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      // Disparar keyup de una letra normal para que Angular habilite el botón Enviar si depende de (keyup)
      element.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', code: 'KeyA', keyCode: 65, bubbles: true }));
    } else if (type === 'contenteditable') {
      element.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);
      element.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
      element.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', code: 'KeyA', keyCode: 65, bubbles: true }));
    }

    return true;
  }

  function getInputCurrentText(target) {
    if (!target || !target.element) return '';
    if (target.type === 'textarea' || target.type === 'input') {
      return (target.element.value || '').trim();
    }
    return (target.element.innerText || '').trim();
  }

  function simulateRealClick(el) {
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;

    const eventInit = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX,
      clientY,
      button: 0,
      buttons: 1
    };

    try {
      el.dispatchEvent(new PointerEvent('pointerdown', eventInit));
      el.dispatchEvent(new MouseEvent('mousedown', eventInit));
      el.dispatchEvent(new PointerEvent('pointerup', eventInit));
      el.dispatchEvent(new MouseEvent('mouseup', eventInit));
    } catch (e) {}
    el.click();
  }

  function simulateEnterKey(el) {
    if (!el) return;
    el.focus();
    const keyOpts = {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      charCode: 13,
      bubbles: true,
      cancelable: true
    };
    el.dispatchEvent(new KeyboardEvent('keydown', keyOpts));
    el.dispatchEvent(new KeyboardEvent('keypress', keyOpts));
    el.dispatchEvent(new KeyboardEvent('keyup', keyOpts));

    const parentForm = el.closest('form');
    if (parentForm) {
      if (typeof parentForm.requestSubmit === 'function') {
        try { parentForm.requestSubmit(); } catch (e) {}
      } else {
        parentForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      }
    }
  }

  // Enviar mensaje priorizando la API directa (/api/ticket/reply) para no tocar la caja de texto ni interrumpir al usuario
  async function pasteAndSendSingleMessage(text, callback) {
    // 1. Intentar primero envío 100% silencioso por API (sin tocar el input ni el foco del usuario)
    const apiSentFirst = await sendMessageViaLaraigoApi(text);
    if (apiSentFirst) {
      if (callback) callback(true);
      return true;
    }

    // 2. Respaldo por DOM solo si aún no se capturó sesión de API
    const initialTarget = await waitForChatInputReady(2800);
    if (!initialTarget) {
      showToast("⚠️ No se encontró la caja de chat habilitada", "warning");
      if (callback) callback(false);
      return false;
    }

    for (let attempt = 1; attempt <= 4; attempt++) {
      const target = findChatInput() || initialTarget;
      if (!target || !target.element) break;

      // Si en el reintento la caja está vacía pero aún no habíamos pegado, o si quedó texto atascado, asegurar que tenga el texto
      const currentVal = getInputCurrentText(target);
      if (attempt === 1 || currentVal.length === 0) {
        setInputValue(target, text);
      } else {
        // El texto ya está pegado en la caja pero no salió; refrescar eventos para habilitar envío
        target.element.focus();
        target.element.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
        target.element.dispatchEvent(new Event('change', { bubbles: true }));
      }

      await sleep(160);

      // 1. Intentar envío por tecla Enter
      simulateEnterKey(target.element);
      await sleep(220);

      // Verificar si la caja ya se vació (mensaje enviado con éxito)
      if (getInputCurrentText(target).length === 0) {
        if (callback) callback(true);
        return true;
      }

      // 2. Si el texto sigue en la caja, buscar y hacer clic en el botón Enviar junto al input
      const sendBtn = findSendButtonNearInput(target.element);
      if (sendBtn) {
        simulateRealClick(sendBtn);
        await sleep(250);
        if (getInputCurrentText(target).length === 0) {
          if (callback) callback(true);
          return true;
        }
      }

      // 3. Respaldo directo por API POST /api/ticket/reply si el DOM no vació la caja
      const apiSent = await sendMessageViaLaraigoApi(text);
      if (apiSent) {
        setInputValue(target, '');
        if (callback) callback(true);
        return true;
      }

      // 4. En intentos >= 2, probar clic por coordenadas a la derecha de la caja de texto
      if (attempt >= 2) {
        const rect = target.element.getBoundingClientRect();
        const centerY = rect.top + rect.height / 2;
        for (const offsetX of [28, 48, 70]) {
          const probeX = rect.right + offsetX;
          if (probeX < window.innerWidth - 10) {
            const rightEl = document.elementFromPoint(probeX, centerY);
            if (rightEl && !isElementInOurOverlay(rightEl) && rightEl !== target.element) {
              const clickableRight = rightEl.closest('button, [role="button"], a') || rightEl;
              simulateRealClick(clickableRight);
              await sleep(200);
              if (getInputCurrentText(target).length === 0) {
                if (callback) callback(true);
                return true;
              }
            }
          }
        }
      }

      await sleep(200);
    }

    // Comprobación final
    const finalTarget = findChatInput() || initialTarget;
    const sentOk = finalTarget ? getInputCurrentText(finalTarget).length === 0 : false;
    if (callback) callback(sentOk);
    return sentOk;
  }

  // ==============================================================
  // ENVÍO INTELIGENTE EN 2 PASOS:
  // 1° INMEDIATO (0s): Manda SÍ O SÍ "Hola Técnico, Procederemos con la atención"
  // 2° ESPERA 5 SEGUNDOS: Da tiempo a que lleguen las fotos/cintillos/mensajes del técnico
  // 3° RE-ANALIZA EL CHAT COMPLETO y envía la 2° respuesta exacta
  // ==============================================================
  async function safeSendTwoStepSmartReply(ruleOrQuestion, detectedContext = null, force = false, onComplete = null) {
    if (isDisabledInThisTab) return false;

    if (isSendingLock) {
      showToast("⏳ Envío o espera de 5s en curso...", "warning");
      if (onComplete) onComplete(false);
      return false;
    }

    if (isConversationBlockedByHSM()) {
      showToast("⛔ Conversación bloqueada por HSM", "warning");
      if (onComplete) onComplete(false);
      return false;
    }

    const target = await waitForChatInputReady(2500);
    if (!target) {
      showToast("⚠️ Abre un chat habilitado primero", "warning");
      if (onComplete) onComplete(false);
      return false;
    }

    const initialDetected = detectedContext || scanScreenForSubmotivo();
    const initialSot = initialDetected?.sot || null;
    const initialTicketNum = initialDetected?.ticketNum || getCurrentLaraigoTicketNumber();
    const initialSig = initialDetected?.signature || null;

    if (!force) {
      if (doesCurrentChatAlreadyHaveSecondQuestion()) {
        askAgentConfirmation(
          `⚠️ Este chat ya tiene la respuesta enviada en pantalla. ¿Seguro que deseas volver a enviar?`,
          () => safeSendTwoStepSmartReply(ruleOrQuestion, initialDetected, true, onComplete)
        );
        return false;
      }

      const storageCheck = wasTicketAlreadyAnsweredInStorage(initialSot, initialTicketNum, initialSig);
      if (storageCheck.answered) {
        askAgentConfirmation(
          `⚠️ Filtro Anti-Duplicado: ${storageCheck.reason} ¿Deseas enviarlo de todas formas?`,
          () => safeSendTwoStepSmartReply(ruleOrQuestion, initialDetected, true, onComplete)
        );
        return false;
      }
    }

    isSendingLock = true;
    const badge = document.getElementById('lc-scanner-status');

    const activeMeta = getActiveTicketMeta(initialTicketNum);
    const activeConvId = activeMeta?.conversationid || lastOpenedConvId || null;
    const greetingAlreadyPresent =
      doesCurrentChatAlreadyHaveGreeting() ||
      wasTicketAlreadyGreeted(initialSot, initialTicketNum, activeConvId);

    // PASO 1: Enviar el saludo DE INMEDIATO (0s) SOLO si aún no fue enviado en este ticket
    if (!greetingAlreadyPresent) {
      showToast(`⚡ 1/2 Enviando saludo inmediato...`, "info");
      if (badge) badge.innerText = `⚡ Enviando saludo inmediato...`;

      const step1Success = await pasteAndSendSingleMessage(BASE_GREETING);

      if (!step1Success) {
        showToast("⚠️ No se pudo confirmar el envío del saludo, reintentará...", "warning");
        isSendingLock = false;
        if (onComplete) onComplete(false);
        return false;
      }
      markTicketAsGreeted(initialSot, initialTicketNum, activeConvId);
    } else {
      markTicketAsGreeted(initialSot, initialTicketNum, activeConvId);
      showToast(`✅ Saludo ya enviado previamente. Evaluando 2° mensaje...`, "info");
    }

    // PASO 2: Esperar 5 segundos (si recién se envió el saludo)
    const totalSeconds = greetingAlreadyPresent ? 1 : Math.round(SECOND_MESSAGE_DELAY_MS / 1000);
    for (let remaining = totalSeconds; remaining >= 1; remaining--) {
      if (isDisabledInThisTab) {
        isSendingLock = false;
        if (onComplete) onComplete(false);
        return false;
      }
      if (badge) {
        badge.innerText = `⏳ Esperando ${remaining}s para recibir mensajes/fotos del técnico...`;
      }
      showToast(`⏳ Esperando mensajes del técnico (${remaining}s)...`, "info");

      if (remaining === 1) {
        await scrollChatAndCollectFullData();
      } else {
        await sleep(1000);
      }
    }

    const currentTicketAfterWait = getCurrentLaraigoTicketNumber();
    if (initialTicketNum && currentTicketAfterWait && initialTicketNum !== currentTicketAfterWait) {
      showToast("⚠️ Se cambió de chat durante la espera; cancelando 2° envío", "warning");
      isSendingLock = false;
      if (onComplete) onComplete(false);
      return false;
    }

    const freshDetected = scanScreenForSubmotivo() || initialDetected;
    const freshStats = await analyzeFullTicketContext(freshDetected);
    updateDetectedPreview(freshDetected, freshStats);

    const activeRule = typeof ruleOrQuestion === 'object' ? ruleOrQuestion : freshDetected?.rule;
    const secondMessageText = typeof ruleOrQuestion === 'string'
      ? ruleOrQuestion
      : resolveSecondMessage(activeRule, freshStats);

    if (!secondMessageText) {
      isSendingLock = false;
      if (onComplete) onComplete(false);
      return false;
    }

    const finalSot = freshDetected?.sot || initialSot;
    const finalTicket = freshDetected?.ticketNum || initialTicketNum;
    const finalSig = freshDetected?.signature || initialSig;

    if (badge) {
      badge.innerText = `🚀 2/2 Enviando: "${secondMessageText}"`;
    }
    showToast(`🚀 2/2 Enviando: "${secondMessageText}"`, "info");

    const step2Success = await pasteAndSendSingleMessage(secondMessageText);
    if (step2Success) {
      markTicketAsAnswered(finalSot, finalTicket, finalSig, activeConvId);
      showToast(`✅ Atención completada${finalSot ? ' (SOT ' + finalSot + ')' : ''}`, "success");
    } else {
      showToast(`⚠️ El 2° mensaje quedó en caja; verifica el envío`, "warning");
    }

    setTimeout(() => {
      isSendingLock = false;
      if (onComplete) onComplete(step2Success);
    }, 1200);

    return step2Success;
  }

  // ==============================================================
  // EXTRACCIÓN ESTRICTA DE "Submotivo: ...", SOT Y TICKET DE LARAIGO
  // ==============================================================
  function getVisibleDomHeaderTicketNumber() {
    const bodyText = document.body.innerText || '';
    const match = bodyText.match(/Ticket\s*:\s*(\d{5,12})/i);
    return match ? match[1].trim() : null;
  }

  function getCurrentLaraigoTicketNumber() {
    const domTkt = getVisibleDomHeaderTicketNumber();
    if (domTkt) return domTkt;
    if (lastOpenedTicketNum && (findChatInput() || isConversationBlockedByHSM())) {
      return lastOpenedTicketNum;
    }
    return null;
  }

  function extractSubmotivoFromText(rawText, explicitTicketNum = null) {
    if (!rawText) return null;

    const allSubmotivoMatches = [...rawText.matchAll(/submotivo\s*:\s*([^\r\n]+)/gi)];
    if (allSubmotivoMatches.length === 0) return null;

    const lastMatch = allSubmotivoMatches[allSubmotivoMatches.length - 1];
    const rawSubmotivoValue = (lastMatch[1] || '').trim();
    const normalizedValue = normalizeText(rawSubmotivoValue);

    const sotMatches = [...rawText.matchAll(/SOT\s*[:#-]?\s*(\d{5,12})/gi)];
    const sotNumber = sotMatches.length > 0 ? sotMatches[sotMatches.length - 1][1] : null;

    const ticketNum = explicitTicketNum || getCurrentLaraigoTicketNumber();

    const techMatch = rawText.match(/t[eé]cnico\s+([A-ZÁÉÍÓÚÑ\s]{5,50}?)\s+del\s+departamento/i);
    const techName = techMatch ? techMatch[1].trim() : null;

    const signature = `${ticketNum || 'NOTKT'}_${sotNumber || 'NOSOT'}_${normalizedValue}`;

    const uniqueSubmotivos = new Set(allSubmotivoMatches.map(m => normalizeText(m[1])));
    const hasMultipleDifferentSubmotivos = uniqueSubmotivos.size > 1;

    if (!normalizedValue || normalizedValue === 'null' || normalizedValue === 'ninguno') {
      return {
        rule: null,
        rawSubmotivo: rawSubmotivoValue || 'null (vacío)',
        sot: sotNumber,
        ticketNum,
        techName,
        signature,
        casuistica: `El campo Submotivo vino vacío o "null"${sotNumber ? ' en la SOT ' + sotNumber : ''}.`
      };
    }

    let matchedRules = [];
    for (const rule of SUBMOTIVO_MAP) {
      if (rule.keywords.some(kw => normalizedValue.includes(normalizeText(kw)))) {
        matchedRules.push(rule);
      }
    }

    if (hasMultipleDifferentSubmotivos) {
      return {
        rule: matchedRules[0] || null,
        rawSubmotivo: rawSubmotivoValue,
        sot: sotNumber,
        ticketNum,
        techName,
        signature,
        casuistica: `El técnico envió ${uniqueSubmotivos.size} plantillas con submotivos distintos (${Array.from(uniqueSubmotivos).join(' / ')}). Confirma cuál responder.`
      };
    }

    if (matchedRules.length === 0) {
      return {
        rule: null,
        rawSubmotivo: rawSubmotivoValue,
        sot: sotNumber,
        ticketNum,
        techName,
        signature,
        casuistica: `Submotivo no reconocido en las 6 reglas: "${rawSubmotivoValue}".`
      };
    }

    return {
      rule: matchedRules[0],
      rawSubmotivo: rawSubmotivoValue,
      sot: sotNumber,
      ticketNum,
      techName,
      signature,
      casuistica: null
    };
  }

  function scanScreenForSubmotivo(extraCollectedText = '', explicitTicketNum = null, forceApiOnly = false) {
    const apiText = getApiCollectedTextForTicket(explicitTicketNum);
    let combinedChatText = (apiText ? apiText + '\n' : '') + (extraCollectedText || '');

    // Solo inspeccionamos el DOM si NO estamos en modo API puro y el ticket coincide con el encabezado visible
    const visibleDomTkt = getVisibleDomHeaderTicketNumber();
    const shouldInspectDom =
      !forceApiOnly &&
      (!explicitTicketNum || (visibleDomTkt && String(explicitTicketNum).trim() === String(visibleDomTkt).trim()));

    if (shouldInspectDom) {
      const { minLeft, maxRight } = getChatColumnBounds();
      const candidateNodes = document.querySelectorAll(
        '[class*="message"], [class*="bubble"], [class*="chat"], p, div, span'
      );

      for (const node of candidateNodes) {
        if (isElementInOurOverlay(node)) continue;
        if (node.offsetParent === null) continue;
        const r = node.getBoundingClientRect();
        if (r.left < minLeft - 30 || r.left > maxRight) continue;
        const text = node.innerText || '';
        if (/submotivo\s*:/i.test(text)) {
          combinedChatText += '\n' + text;
        }
      }
    }

    if (combinedChatText) {
      return extractSubmotivoFromText(combinedChatText, explicitTicketNum);
    }

    return null;
  }

  // ==========================================
  // COMPROBAR SI EL CHAT YA TIENE SALUDO O 2° RESPUESTA
  // ==========================================
  function getCentralChatBubbleNodes() {
    const { minLeft, maxRight } = getChatColumnBounds();
    const candidates = Array.from(document.querySelectorAll(
      '[class*="message"], [class*="bubble"], [class*="chat-item"], div[class*="msg"], p, span'
    ));

    return candidates.filter(el => {
      if (isElementInOurOverlay(el)) return false;
      if (el.offsetParent === null) return false;
      if (el.children.length > 5) return false;
      const r = el.getBoundingClientRect();
      return r.left >= minLeft - 20 && r.right <= maxRight + 20 && r.top > 90;
    });
  }

  function doesInteractionsListHaveGreeting(interactions) {
    if (!Array.isArray(interactions) || interactions.length === 0) return false;
    const currentSlice = getCurrentTicketInteractionsSlice(interactions);
    for (const item of currentSlice) {
      if (!item || item.interactiontype === 'LOG') continue;
      if (item.usertype === 'ASESOR' && item.interactiontype === 'text') {
        return true;
      }
      const iText = normalizeText(item.interactiontext || '');
      if (iText.includes("hola tecnico") || iText.includes("procederemos con la atencion")) {
        return true;
      }
    }
    return false;
  }

  function doesInteractionsListHaveSecondQuestion(interactions) {
    if (!Array.isArray(interactions) || interactions.length === 0) return false;
    const currentSlice = getCurrentTicketInteractionsSlice(interactions);
    const secondStepPhrases = [
      "enviar error de toa",
      "enviar captura de reenvio desde su toa",
      "enviar captura de imagen de fat/tap y cintillos",
      "enviar captura de imagen de fat/tap",
      "enviar cintillos",
      "enviar imagen del repetidor",
      "enviar motivo de sot de manto",
      "enviar evidencias porfavor",
      "enviar repetidor a activar",
      "cual es el motivo de la sot de manto",
      "enviar evidencias y motivo de la derivacion"
    ];

    let hasAdvisorGreeting = false;
    let hasAdvisorClosingReply = false;
    let advisorTextCount = 0;

    for (const item of currentSlice) {
      if (!item || item.interactiontype === 'LOG') continue;
      // Solo evaluar mensajes enviados por el ASESOR (evita confundir cuando el técnico escribe "Un momento")
      if (item.usertype !== 'ASESOR' || item.interactiontype !== 'text') continue;

      advisorTextCount++;
      const text = normalizeText(item.interactiontext || '');
      if (secondStepPhrases.some(phrase => text.includes(phrase))) {
        return true;
      }
      if (text.includes("hola tecnico") || text.includes("procederemos con la atencion")) {
        hasAdvisorGreeting = true;
      }
      const textNoTime = text.replace(/\b\d{1,2}:\d{2}\b/g, '').trim();
      if (textNoTime === "un momento" || textNoTime === "se revisa") {
        hasAdvisorClosingReply = true;
      }
    }

    if (advisorTextCount >= 2) return true;
    return hasAdvisorGreeting && hasAdvisorClosingReply;
  }

  function doesCurrentChatAlreadyHaveGreeting() {
    const currentTkt = getCurrentLaraigoTicketNumber();
    const meta = getActiveTicketMeta(currentTkt);
    const convId = meta?.conversationid || lastOpenedConvId || null;

    if (wasTicketAlreadyGreeted(null, currentTkt, convId)) {
      return true;
    }

    if (meta && meta.lastreplyuser) {
      return true;
    }

    if (convId && apiInteractionsByConvId.has(Number(convId))) {
      const interactions = apiInteractionsByConvId.get(Number(convId)) || [];
      if (doesInteractionsListHaveGreeting(interactions)) {
        markTicketAsGreeted(null, currentTkt, convId);
        return true;
      }
    }

    const bubbles = getCentralChatBubbleNodes();
    for (const msg of bubbles) {
      const text = normalizeText(msg.innerText || '');
      if (text.includes("hola tecnico") || text.includes("procederemos con la atencion")) {
        markTicketAsGreeted(null, currentTkt, convId);
        return true;
      }
    }
    return false;
  }

  function doesCurrentChatAlreadyHaveSecondQuestion() {
    const currentTkt = getCurrentLaraigoTicketNumber();
    const meta = getActiveTicketMeta(currentTkt);
    if (meta && meta.conversationid && apiInteractionsByConvId.has(Number(meta.conversationid))) {
      const interactions = apiInteractionsByConvId.get(Number(meta.conversationid)) || [];
      if (doesInteractionsListHaveSecondQuestion(interactions)) {
        return true;
      }
    }

    const bubbles = getCentralChatBubbleNodes();

    const secondStepPhrases = [
      "enviar error de toa",
      "enviar captura de reenvio desde su toa",
      "enviar captura de imagen de fat/tap y cintillos",
      "enviar captura de imagen de fat/tap",
      "enviar cintillos",
      "enviar imagen del repetidor",
      "enviar motivo de sot de manto",
      "enviar evidencias porfavor",
      "enviar repetidor a activar",
      "cual es el motivo de la sot de manto",
      "enviar evidencias y motivo de la derivacion"
    ];

    let hasGreeting = false;
    let hasShortClosingReply = false;

    for (const msg of bubbles) {
      const text = normalizeText(msg.innerText || '');
      if (secondStepPhrases.some(phrase => text.includes(phrase))) {
        return true;
      }
      if (text.includes("hola tecnico, procederemos con la atencion")) {
        hasGreeting = true;
      }
      const textNoTime = text.replace(/\b\d{1,2}:\d{2}\b/g, '').trim();
      if (textNoTime === "un momento" || textNoTime === "se revisa") {
        hasShortClosingReply = true;
      }
    }

    return hasGreeting && hasShortClosingReply;
  }

  // ==========================================
  // SISTEMA DE PREGUNTA / CONFIRMACIÓN EN CASUÍSTICAS
  // ==========================================
  function askAgentConfirmation(questionText, onConfirm, onSkip = null) {
    isPausedForQuestion = true;
    const modal = document.getElementById('lc-casuistica-modal');
    const msgEl = document.getElementById('lc-casuistica-text');
    const btnConfirm = document.getElementById('lc-casuistica-confirm');
    const btnCancel = document.getElementById('lc-casuistica-cancel');

    if (!modal || !msgEl) return;

    msgEl.innerText = questionText;
    modal.style.display = 'block';

    if (onConfirm) {
      btnConfirm.style.display = 'inline-block';
      btnConfirm.onclick = () => {
        modal.style.display = 'none';
        isPausedForQuestion = false;
        onConfirm();
      };
    } else {
      btnConfirm.style.display = 'none';
    }

    btnCancel.onclick = () => {
      modal.style.display = 'none';
      isPausedForQuestion = false;
      if (onSkip) onSkip();
    };
  }

  // ==============================================================
  // DETECCIÓN Y APERTURA AUTOMÁTICA DE TICKETS EN "Asignados(N)"
  // ==============================================================
  function getInboxTicketElements() {
    const asigInfo = getAsignadosColumnInfo();

    if (asigInfo) {
      const { colLeft, colRight, tabBarBottom, leftColumnContainer } = asigInfo;

      const allLeftEls = Array.from(leftColumnContainer.querySelectorAll('div, li, a, mat-list-item')).filter(el => {
        if (isElementInOurOverlay(el)) return false;
        if (el.offsetParent === null) return false;
        const r = el.getBoundingClientRect();

        if (r.top < tabBarBottom - 3) return false;
        if (r.top > window.innerHeight - 35) return false;
        if (r.left < colLeft - 12 || r.left > colRight - 40) return false;
        if (r.right > colRight + 25) return false;

        if (r.width < 90) return false;
        if (r.height < 38 || r.height > 155) return false;

        const text = (el.innerText || '').trim();
        if (text.length < 2 || text.length > 350) return false;

        return true;
      });

      if (allLeftEls.length > 0) {
        const pointerEls = allLeftEls.filter(el => {
          try {
            return window.getComputedStyle(el).cursor === 'pointer';
          } catch (e) {
            return false;
          }
        });

        const basePool = pointerEls.length > 0 ? pointerEls : allLeftEls;

        const innerCards = basePool.filter(el => {
          const rA = el.getBoundingClientRect();
          const hasTightInnerCard = basePool.some(other => {
            if (other === el || !el.contains(other)) return false;
            const rB = other.getBoundingClientRect();
            return Math.abs(rA.height - rB.height) < 18 && rB.width > rA.width * 0.7;
          });
          return !hasTightInnerCard;
        });

        const sortedByTop = (innerCards.length > 0 ? innerCards : basePool).sort(
          (a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top
        );

        const distinctRows = [];
        for (const item of sortedByTop) {
          const r = item.getBoundingClientRect();
          const centerY = r.top + r.height / 2;
          const alreadyHasRowAtThisY = distinctRows.some(existing => {
            const er = existing.getBoundingClientRect();
            const eCenterY = er.top + er.height / 2;
            return Math.abs(centerY - eCenterY) < 36;
          });
          if (!alreadyHasRowAtThisY) {
            distinctRows.push(item);
          }
        }

        if (distinctRows.length > 0) {
          return distinctRows;
        }
      }
    }

    const candidateSelectors = [
      'div[class*="conversation-item"]',
      'div[class*="chat-item"]',
      'div[class*="ticket-item"]',
      'div[class*="inbox-item"]',
      'div[class*="user-item"]',
      'li[class*="conversation"]',
      'li[class*="chat"]',
      'div[role="listitem"]',
      'div[class*="item_chat"]',
      'div[class*="itemChat"]'
    ];

    for (const sel of candidateSelectors) {
      const list = Array.from(document.querySelectorAll(sel)).filter(
        el => !isElementInOurOverlay(el) && el.offsetParent !== null
      );
      if (list.length > 0) {
        return list;
      }
    }

    return [];
  }

  // ==============================================================
  // ATENCIÓN 100% EN 2° PLANO POR API (SIN CAMBIAR DE CHAT NI SCROLLEAR)
  // Permite seguir trabajando en el mismo ticket sin interrupciones
  // ==============================================================
  async function processTicketInBackgroundViaApi(ticketMeta) {
    if (!ticketMeta || !ticketMeta.conversationid || !ticketMeta.ticketnum || isDisabledInThisTab) return false;

    const tNum = String(ticketMeta.ticketnum).trim();
    const convId = Number(ticketMeta.conversationid);
    if (!tNum || !convId) return false;

    if (backgroundTicketsInProgress.has(tNum)) return false;
    if (wasTicketAlreadyAnsweredInStorage(null, tNum, null, convId).answered) return false;

    backgroundTicketsInProgress.add(tNum);
    const badge = document.getElementById('lc-scanner-status');

    const buildDirectApiText = (fetchRes) => {
      let txt = '';
      const latestMeta = apiTicketsByTicketNum.get(tNum) || ticketMeta;
      if (latestMeta && latestMeta.lastmessage && /submotivo\s*:/i.test(String(latestMeta.lastmessage))) {
        txt += '\n' + String(latestMeta.lastmessage);
      }
      const p = fetchRes?.person || apiPersonByTicketNum.get(tNum) || null;
      if (p && p.variablecontext) {
        const vc = typeof p.variablecontext === 'string'
          ? (() => { try { return JSON.parse(p.variablecontext); } catch (e) { return {}; } })()
          : p.variablecontext;
        const pTkt = String(p.ticketnum || vc?.ticketnum || '').trim();
        const pConv = String(vc?.conversationid || '').trim();
        const pId = String(p.personid || vc?.personid || '').trim();
        const isMatchingPerson =
          (!pTkt && !pConv) ||
          pTkt === tNum ||
          pConv === String(convId) ||
          (latestMeta?.personid && pId === String(latestMeta.personid));
        if (isMatchingPerson && vc?.useranswer) {
          txt += '\n' + vc.useranswer;
        }
      }
      if (Array.isArray(fetchRes?.interactions) && fetchRes.interactions.length > 0) {
        const currentSlice = getCurrentTicketInteractionsSlice(fetchRes.interactions);
        for (const item of currentSlice) {
          if (item && item.interactiontype === 'text' && item.interactiontext && item.usertype !== 'BOT') {
            txt += '\n' + item.interactiontext;
          }
        }
      }
      return txt;
    };

    try {
      // Notificar en Windows al instante sin necesidad de entrar al ticket
      notifyNewTicketOnce(tNum, ticketMeta.displayname || '');

      const isGreetingOnlyMode = currentOperationMode === 'greeting_only';

      // Verificar si ya fue saludado previamente (en memoria, en storage o por lastreplyuser de la API)
      let greetedNow = false;
      const alreadyGreetedFast =
        wasTicketAlreadyGreeted(null, tNum, convId) ||
        Boolean(ticketMeta.lastreplyuser);

      if (alreadyGreetedFast) {
        markTicketAsGreeted(null, tNum, convId);
        if (isGreetingOnlyMode) {
          return true;
        }
      } else {
        // PASO 1 RAPIDÍSIMO (0ms): Si el ticket recién cayó (lastreplyuser === null),
        // enviamos el saludo de inmediato sin esperar ninguna consulta previa
        if (badge) {
          badge.innerText = `⚡ [2° Plano] Ticket #${tNum}: Enviando 1° Saludo (0s)...`;
        }
        const sentFast = await sendMessageViaLaraigoApi(BASE_GREETING, ticketMeta, true);
        if (sentFast) {
          markTicketAsGreeted(null, tNum, convId);
          greetedTimestampByTicket.set(tNum, Date.now());
          greetedNow = true;
          if (isGreetingOnlyMode) {
            if (badge) {
              badge.innerText = `✅ Ticket #${tNum}: Notificado + Saludo instantáneo enviado`;
            }
            showToast(`⚡ Ticket #${tNum}: Saludo instantáneo enviado en 2° plano`, "success");
            return true;
          } else {
            showToast(`⚡ Ticket #${tNum}: 1° Saludo enviado en 2° plano (esperando 5s...)`, "info");
          }
        }
      }

      // Consultar historial e información del ticket en 2° plano vía API (/api/multi)
      const initFetch = await fetchConversationDetailsViaBridge(convId, ticketMeta.personid, tNum);

      if (doesInteractionsListHaveGreeting(initFetch.interactions)) {
        markTicketAsGreeted(null, tNum, convId);
      }

      if (doesInteractionsListHaveSecondQuestion(initFetch.interactions)) {
        const dInit = scanScreenForSubmotivo(buildDirectApiText(initFetch), tNum, true);
        markTicketAsAnswered(dInit?.sot || null, tNum, dInit?.signature || null, convId);
        return true;
      }

      const dPre = scanScreenForSubmotivo(buildDirectApiText(initFetch), tNum, true);
      if (dPre && dPre.sot) {
        if (wasTicketAlreadyGreeted(dPre.sot, tNum, convId)) {
          markTicketAsGreeted(dPre.sot, tNum, convId);
        }
      }
      if (wasTicketAlreadyAnsweredInStorage(dPre?.sot || null, tNum, dPre?.signature || null, convId).answered) {
        return true;
      }
      if (dPre && skippedTickets.has(dPre.signature)) {
        return false;
      }

      // Si aún no se había enviado el saludo en el paso rápido, verificar en interacciones y enviarlo ahora
      const alreadyGreeted =
        greetedNow ||
        alreadyGreetedFast ||
        wasTicketAlreadyGreeted(dPre?.sot || null, tNum, convId) ||
        doesInteractionsListHaveGreeting(initFetch.interactions);

      if (!alreadyGreeted) {
        if (badge) {
          badge.innerText = `⚡ [2° Plano] Ticket #${tNum}: Enviando 1° Saludo (0s)...`;
        }
        const sent1 = await sendMessageViaLaraigoApi(BASE_GREETING, ticketMeta, true);
        if (sent1) {
          markTicketAsGreeted(dPre?.sot || null, tNum, convId);
          greetedTimestampByTicket.set(tNum, Date.now());
          greetedNow = true;
          if (isGreetingOnlyMode) {
            if (badge) {
              badge.innerText = `✅ Ticket #${tNum}: Notificado + Saludo instantáneo enviado`;
            }
            showToast(`⚡ Ticket #${tNum}: Saludo instantáneo enviado en 2° plano`, "success");
            return true;
          }
          showToast(`⚡ Ticket #${tNum}: 1° Saludo enviado en 2° plano (esperando 5s...)`, "info");
        } else {
          return false;
        }
      }

      // Si está en modo "Solo Notificación + Saludo Instantáneo", terminamos aquí sin enviar 2° respuesta
      if (currentOperationMode === 'greeting_only') {
        if (badge) {
          badge.innerText = `✅ Ticket #${tNum}: Saludo instantáneo listo (Modo Solo Saludo)`;
        }
        return true;
      }

      // PASO 2 (5s - MODO COMPLETO BETA): Esperar los 5 segundos desde el envío del saludo
      let waitMs = SECOND_MESSAGE_DELAY_MS;
      if (!greetedNow) {
        const greetedAt = greetedTimestampByTicket.get(tNum);
        if (greetedAt) {
          waitMs = Math.max(600, SECOND_MESSAGE_DELAY_MS - (Date.now() - greetedAt));
        } else {
          waitMs = 1200;
        }
      }

      if (badge) {
        badge.innerText = `⏳ [BETA 2° Plano] Ticket #${tNum}: Esperando ${Math.ceil(waitMs / 1000)}s por fotos/cintillos...`;
      }
      await sleep(waitMs);

      if (isDisabledInThisTab || currentOperationMode === 'greeting_only') return false;

      // PASO 3: Re-consultar mensajes/adjuntos del ticket vía API tras los 5 segundos (con hasta 3 reintentos automáticos)
      let secondFetch = await fetchConversationDetailsViaBridge(convId, ticketMeta.personid, tNum);
      if (doesInteractionsListHaveSecondQuestion(secondFetch.interactions)) {
        const dDone = scanScreenForSubmotivo(buildDirectApiText(secondFetch), tNum, true);
        markTicketAsAnswered(dDone?.sot || null, tNum, dDone?.signature || null, convId);
        return true;
      }

      let detected = scanScreenForSubmotivo(buildDirectApiText(secondFetch), tNum, true) || dPre;
      for (let retry = 0; retry < 3 && (!detected || !detected.rule); retry++) {
        await sleep(1200);
        if (isDisabledInThisTab || currentOperationMode === 'greeting_only') return false;
        secondFetch = await fetchConversationDetailsViaBridge(convId, ticketMeta.personid, tNum);
        const isVisibleOnScreen = getVisibleDomHeaderTicketNumber() === tNum;
        detected = scanScreenForSubmotivo(buildDirectApiText(secondFetch), tNum, !isVisibleOnScreen) || dPre;
      }

      if (!detected || !detected.rule) {
        if (badge) {
          badge.innerText = `⚠️ Ticket #${tNum}: Sin Submotivo reconocido (${detected?.rawSubmotivo || 'reintentando...'})`;
        }
        return false;
      }

      markTicketAsGreeted(detected.sot, tNum, convId);

      if (wasTicketAlreadyAnsweredInStorage(detected.sot, tNum, detected.signature, convId).answered) {
        return true;
      }

      // Analizar fotos (TOA vs equipo), videos, cintillos y texto directamente desde la API del ticket actual
      const isTicketVisibleInCenter = getVisibleDomHeaderTicketNumber() === tNum;
      const finalStats = await analyzeFullTicketContext(
        detected,
        buildDirectApiText(secondFetch),
        tNum,
        secondFetch.interactions,
        !isTicketVisibleInCenter
      );
      const secondMessageText = resolveSecondMessage(detected.rule, finalStats);
      if (!secondMessageText) return false;

      if (badge) {
        badge.innerText = `🚀 [BETA 2° Plano] Ticket #${tNum}: Enviando 2° "${secondMessageText}"...`;
      }

      // Enviar 2° mensaje vía API con hasta 3 intentos automáticos para garantizar la entrega sin recargar la página
      let sent2 = false;
      for (let sendAttempt = 0; sendAttempt < 3 && !sent2; sendAttempt++) {
        if (sendAttempt > 0) {
          await sleep(900);
        }
        const latestMeta = apiTicketsByTicketNum.get(tNum) || ticketMeta;
        sent2 = await sendMessageViaLaraigoApi(secondMessageText, latestMeta, false);
      }

      // Si el usuario tiene este mismo ticket abierto en pantalla y la API demoró, usar respaldo de envío directo
      if (!sent2 && getVisibleDomHeaderTicketNumber() === tNum) {
        sent2 = await pasteAndSendSingleMessage(secondMessageText);
      }

      if (sent2) {
        markTicketAsAnswered(detected.sot, tNum, detected.signature, convId);
        if (badge) {
          badge.innerText = `✅ Ticket #${tNum} (${detected.rule.name}): "${secondMessageText}" enviado sin cambiar de chat`;
        }
        showToast(`✅ Ticket #${tNum}: "${secondMessageText}" enviado en 2° plano`, "success");
        return true;
      }

      return false;
    } finally {
      backgroundTicketsInProgress.delete(tNum);
    }
  }

  function startInstantInboxArrivalWatcher() {
    if (inboxArrivalObserver) inboxArrivalObserver.disconnect();

    let arrivalDebounce = null;
    inboxArrivalObserver = new MutationObserver(() => {
      if (!isScanningQueue || isPausedForQuestion || isDisabledInThisTab) return;

      const asigInfo = getAsignadosColumnInfo();
      if (asigInfo && asigInfo.assignedCount > 0) {
        clearTimeout(arrivalDebounce);
        arrivalDebounce = setTimeout(() => {
          if (isScanningQueue && !isStepInProgress && !isDisabledInThisTab) {
            clearTimeout(scannerLoopTimeout);
            runNextScannerStep();
          }
        }, 300);
      }
    });

    inboxArrivalObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  // ==========================================
  // MOTOR DE AUTO-ATENCIÓN EN 2° PLANO (SIN SCROLL NI CAMBIO DE CHAT)
  // ==========================================
  function updateCubeStatusUI() {
    const cubeDot = document.getElementById('lc-cube-dot');
    const cubeModeTag = document.getElementById('lc-cube-mode-tag');
    const cubeIcon = document.getElementById('lc-cube-icon');
    if (cubeDot) {
      cubeDot.className = `lc-cube-dot ${isScanningQueue && !isDisabledInThisTab ? 'active' : 'paused'}`;
    }
    if (cubeModeTag) {
      cubeModeTag.innerText = currentOperationMode === 'full_beta' ? 'BETA' : '1°';
      cubeModeTag.className = `lc-cube-mode-tag ${currentOperationMode === 'full_beta' ? 'beta' : 'fast'}`;
    }
    if (cubeIcon) {
      cubeIcon.innerText = currentOperationMode === 'full_beta' ? '🤖' : '⚡';
    }
  }

  function stopScannerIfRunning() {
    if (isScanningQueue) {
      isScanningQueue = false;
      isPausedForQuestion = false;
      isStepInProgress = false;
      clearTimeout(scannerLoopTimeout);
      if (inboxArrivalObserver) inboxArrivalObserver.disconnect();
      const btn = document.getElementById('lc-btn-scanner');
      const badge = document.getElementById('lc-scanner-status');
      if (btn) {
        btn.classList.remove('active');
        btn.innerText = "▶️ Auto-Atender en 2° Plano (Sin cambiar de chat)";
      }
      if (badge) {
        badge.innerText = "Auto-atención en pausa";
      }
      updateCubeStatusUI();
    }
  }

  function toggleScanner() {
    if (isDisabledInThisTab) return;
    isScanningQueue = !isScanningQueue;
    isPausedForQuestion = false;
    isStepInProgress = false;
    const btn = document.getElementById('lc-btn-scanner');
    const badge = document.getElementById('lc-scanner-status');

    if (isScanningQueue) {
      if (btn) {
        btn.classList.add('active');
        btn.innerText = "⏹️ Pausar Auto-Atención en 2° Plano";
      }
      if (badge) {
        badge.innerText = currentOperationMode === 'greeting_only'
          ? "Activo (Solo Notif. + Saludo 0s): vigilando en 2° plano..."
          : "Activo (Modo Completo BETA): Saludo 0s + 2° Respuesta en 2° plano...";
      }
      showToast("🚀 Auto-Atención en 2° plano activa (sin cambiar de chat)", "info");
      updateCubeStatusUI();
      startInstantInboxArrivalWatcher();
      runNextScannerStep();
    } else {
      stopScannerIfRunning();
      showToast("⏸️ Auto-Atención en pausa", "warning");
    }
  }

  async function runNextScannerStep() {
    if (!isScanningQueue || isPausedForQuestion || isDisabledInThisTab || isStepInProgress) return;

    isStepInProgress = true;
    const badge = document.getElementById('lc-scanner-status');

    try {
      // 1. Consultar la lista actualizada de tickets en "Asignados" vía API en 2° plano (sin hacer clic en la UI)
      await pollAssignedTicketsViaBridge();

      // 2. Lanzar atención en 2° plano para todos los tickets ASIGNADO pendientes según el modo activo
      const pendingAssigned = [];
      for (const t of apiTicketsByTicketNum.values()) {
        if (!t || !t.ticketnum || t.status !== 'ASIGNADO') continue;
        const tNum = String(t.ticketnum).trim();
        if (backgroundTicketsInProgress.has(tNum)) continue;

        if (currentOperationMode === 'greeting_only') {
          notifyNewTicketOnce(tNum, t.displayname || '');
          if (wasTicketAlreadyGreeted(null, tNum, t.conversationid) || Boolean(t.lastreplyuser)) {
            markTicketAsGreeted(null, tNum, t.conversationid);
            continue;
          }
        } else {
          if (wasTicketAlreadyAnsweredInStorage(null, tNum, null, t.conversationid).answered) continue;
        }
        pendingAssigned.push(t);
      }

      if (pendingAssigned.length > 0) {
        for (const ticketMeta of pendingAssigned) {
          processTicketInBackgroundViaApi(ticketMeta);
        }
      } else if (isAnyTicketCurrentlyOpenInCenter() && !isSendingLock) {
        // Si el ticket actualmente abierto aún no fue atendido y no está en proceso en 2° plano
        const openTkt = getCurrentLaraigoTicketNumber();
        const openMeta = getActiveTicketMeta(openTkt);
        if (openMeta && openMeta.conversationid && openMeta.ticketnum) {
          const openNum = String(openMeta.ticketnum).trim();
          const alreadyDoneForMode = currentOperationMode === 'greeting_only'
            ? (wasTicketAlreadyGreeted(null, openNum, openMeta.conversationid) || Boolean(openMeta.lastreplyuser))
            : wasTicketAlreadyAnsweredInStorage(null, openNum, null, openMeta.conversationid).answered;

          if (!alreadyDoneForMode && !backgroundTicketsInProgress.has(openNum)) {
            processTicketInBackgroundViaApi(openMeta);
          }
        }
      } else if (badge && backgroundTicketsInProgress.size === 0) {
        badge.innerText = currentOperationMode === 'greeting_only'
          ? `👀 Vigilando Asignados (Modo: Solo Notif. + Saludo 0s)...`
          : `👀 Vigilando Asignados (Modo Completo BETA: Saludo + 2° Resp.)...`;
      }
    } finally {
      isStepInProgress = false;
      if (isScanningQueue && !isDisabledInThisTab) {
        scannerLoopTimeout = setTimeout(runNextScannerStep, 2200);
      }
    }
  }

  async function processCurrentOpenTicket(onDone) {
    if (isDisabledInThisTab) {
      if (onDone) onDone();
      return;
    }
    const openTkt = getCurrentLaraigoTicketNumber();
    const openMeta = getActiveTicketMeta(openTkt);
    if (openMeta && openMeta.conversationid) {
      await processTicketInBackgroundViaApi(openMeta);
      if (onDone) onDone();
      return;
    }
    if (onDone) onDone();
  }

  function updateDetectedPreview(detected, contextStats = null) {
    if (isDisabledInThisTab) return;
    const previewEl = document.getElementById('lc-live-detected');
    if (!previewEl) return;

    document.querySelectorAll('.lc-submotivo-btn').forEach(b => b.classList.remove('highlighted'));

    if (isConversationBlockedByHSM()) {
      previewEl.innerHTML = `
        <div class="lc-detected-box unknown">
          ⛔ <b>Conversación bloqueada por HSM</b><br>
          <small>El cliente/técnico aún no acepta el mensaje de consentimiento.</small>
        </div>
      `;
      return;
    }

    const alreadyInDom = doesCurrentChatAlreadyHaveSecondQuestion();
    const alreadyInStorage = detected ? wasTicketAlreadyAnsweredInStorage(detected.sot, detected.ticketNum, detected.signature).answered : false;
    const isAlreadyAttended = alreadyInDom || alreadyInStorage;

    if (detected && isAlreadyAttended) {
      previewEl.innerHTML = `
        <div class="lc-detected-box attended">
          🛡️ <b>YA ATENDIDO</b> ${detected.sot ? `(SOT: ${detected.sot})` : ''}<br>
          <small>Submotivo: ${detected.rawSubmotivo} — Protegido contra doble envío.</small>
        </div>
      `;
      return;
    }

    if (detected && detected.casuistica) {
      previewEl.innerHTML = `
        <div class="lc-detected-box unknown">
          ⚠️ <b>Casuística:</b> ${detected.casuistica}<br>
          <small>Selecciona manualmente qué responder abajo:</small>
        </div>
      `;
      return;
    }

    if (detected && detected.rule) {
      const sotBadge = detected.sot ? ` | <b>SOT: ${detected.sot}</b>` : '';
      const secondMsg = resolveSecondMessage(detected.rule, contextStats);
      const contextSummaryHtml = buildContextSummaryHtml(detected.rule, contextStats);

      previewEl.innerHTML = `
        <div class="lc-detected-box found">
          <div>🎯 Leído: <b>Submotivo: ${detected.rawSubmotivo}</b>${sotBadge}</div>
          ${contextSummaryHtml}
          <button id="lc-quick-send-detected" class="lc-quick-send-btn">
            🚀 1° Saludo (Inmediato) ➔ (5s) ➔ 2° "${secondMsg}"
          </button>
        </div>
      `;
      const qBtn = document.getElementById('lc-quick-send-detected');
      if (qBtn) {
        qBtn.onclick = () => safeSendTwoStepSmartReply(detected.rule, detected, false);
      }

      const matchingBtn = document.querySelector(`.lc-submotivo-btn[data-id="${detected.rule.id}"]`);
      if (matchingBtn) matchingBtn.classList.add('highlighted');
    } else {
      previewEl.innerHTML = `
        <div class="lc-detected-box waiting">
          🔍 Abre un chat para analizar <code>Submotivo:</code>, fotos y cintillos
        </div>
      `;
    }
  }

  function startManualTicketMonitor() {
    if (manualObserver) manualObserver.disconnect();
    if (isDisabledInThisTab) return;

    let debounceTimer = null;
    manualObserver = new MutationObserver(() => {
      if (isSendingLock || isDisabledInThisTab) return;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        if (isDisabledInThisTab || isSendingLock) return;
        const detected = scanScreenForSubmotivo();
        if (currentOperationMode === 'full_beta') {
          const contextStats = await analyzeFullTicketContext(detected);
          updateDetectedPreview(detected, contextStats);
        }

        // Si el modo automático está activo y hay un ticket abierto sin responder aún:
        if (isScanningQueue && !isPausedForQuestion && detected && detected.rule && !detected.casuistica) {
          const tNum = detected.ticketNum ? String(detected.ticketNum).trim() : getCurrentLaraigoTicketNumber();
          const openMeta = getActiveTicketMeta(tNum);
          const convId = openMeta?.conversationid || lastOpenedConvId || null;

          if (currentOperationMode === 'greeting_only') {
            const alreadyGreeted =
              doesCurrentChatAlreadyHaveGreeting() ||
              wasTicketAlreadyGreeted(detected.sot, tNum, convId) ||
              Boolean(openMeta?.lastreplyuser);
            const inBgProgress = (tNum && backgroundTicketsInProgress.has(tNum)) || backgroundTicketsInProgress.size > 0;
            if (!alreadyGreeted && !inBgProgress && openMeta && openMeta.conversationid && openMeta.ticketnum) {
              processTicketInBackgroundViaApi(openMeta);
            }
          } else {
            const alreadyInDom = doesCurrentChatAlreadyHaveSecondQuestion();
            const alreadyInStorage = wasTicketAlreadyAnsweredInStorage(detected.sot, tNum, detected.signature, convId).answered;
            const inBgProgress = (tNum && backgroundTicketsInProgress.has(tNum)) || backgroundTicketsInProgress.size > 0;

            if (!alreadyInDom && !alreadyInStorage && !inBgProgress && !skippedTickets.has(detected.signature)) {
              if (openMeta && openMeta.conversationid && openMeta.ticketnum) {
                processTicketInBackgroundViaApi(openMeta);
              } else {
                safeSendTwoStepSmartReply(detected.rule, detected, true);
              }
            }
          }
        }
      }, 650);
    });
    manualObserver.observe(document.body, { childList: true, subtree: true });
  }

  // ==========================================
  // CAMBIO DE MODO Y MINIMIZADO A "CUADRITO"
  // ==========================================
  function setOperationMode(mode, notifyUser = true) {
    if (mode !== 'greeting_only' && mode !== 'full_beta') return;
    currentOperationMode = mode;
    localStorage.setItem('laraigo_copilot_mode', mode);
    try {
      chrome.storage.local.set({ laraigo_copilot_mode: mode });
    } catch (e) {}

    const btnGreeting = document.getElementById('lc-mode-greeting');
    const btnBeta = document.getElementById('lc-mode-beta');
    const betaSection = document.getElementById('lc-beta-features-section');
    const greetingInfo = document.getElementById('lc-greeting-only-info');
    const headerModeBadge = document.getElementById('lc-header-mode-badge');
    const badge = document.getElementById('lc-scanner-status');

    if (btnGreeting && btnBeta) {
      btnGreeting.classList.toggle('active', mode === 'greeting_only');
      btnBeta.classList.toggle('active', mode === 'full_beta');
    }

    if (betaSection) {
      betaSection.style.display = mode === 'full_beta' ? 'block' : 'none';
    }
    if (greetingInfo) {
      greetingInfo.style.display = mode === 'greeting_only' ? 'block' : 'none';
    }
    if (headerModeBadge) {
      if (mode === 'full_beta') {
        headerModeBadge.innerText = 'BETA';
        headerModeBadge.className = 'lc-header-mode-badge beta';
      } else {
        headerModeBadge.innerText = '1° SALUDO';
        headerModeBadge.className = 'lc-header-mode-badge fast';
      }
    }

    updateCubeStatusUI();

    if (badge && isScanningQueue) {
      badge.innerText = mode === 'greeting_only'
        ? `👀 Vigilando Asignados (Modo: Solo Notif. + Saludo 0s)...`
        : `👀 Vigilando Asignados (Modo Completo BETA: Saludo + 2° Resp.)...`;
    }

    if (notifyUser) {
      if (mode === 'greeting_only') {
        showToast("⚡ Modo activo: Solo Notificación + Saludo Instantáneo (0s)", "info");
      } else {
        showToast("🧠 Modo Completo (BETA) activo: Saludo + 2° Respuestas Inteligentes", "info");
        const detected = scanScreenForSubmotivo();
        analyzeFullTicketContext(detected).then(stats => updateDetectedPreview(detected, stats));
      }
      if (isScanningQueue && !isStepInProgress && !isDisabledInThisTab) {
        clearTimeout(scannerLoopTimeout);
        runNextScannerStep();
      }
    }
  }

  function setMinimizedToCube(minimized) {
    isMinimizedToCube = Boolean(minimized);
    localStorage.setItem('laraigo_copilot_minimized', isMinimizedToCube ? 'true' : 'false');

    const container = document.getElementById('laraigo-copilot-container');
    if (!container) return;

    if (isMinimizedToCube) {
      container.classList.add('lc-cube-mode');
    } else {
      container.classList.remove('lc-cube-mode');
      // Asegurar que al expandir desde el cuadrito no quede cortado fuera de la pantalla
      if (container.style.left && container.style.left !== 'auto') {
        const currentLeft = parseFloat(container.style.left) || 0;
        const currentTop = parseFloat(container.style.top) || 0;
        const clampedLeft = Math.max(8, Math.min(window.innerWidth - 355, currentLeft));
        const clampedTop = Math.max(8, Math.min(window.innerHeight - 260, currentTop));
        container.style.left = `${clampedLeft}px`;
        container.style.top = `${clampedTop}px`;
      }
    }
    updateCubeStatusUI();
  }

  // ==========================================
  // ACTIVAR / DESACTIVAR EN ESTA PESTAÑA (ACTIVO / NO ACTIVO)
  // ==========================================
  function setTabDisabledState(disabled) {
    isDisabledInThisTab = disabled;
    sessionStorage.setItem('laraigo_copilot_tab_disabled', disabled ? 'true' : 'false');

    const mainWidget = document.getElementById('laraigo-copilot-container');
    const miniPill = document.getElementById('laraigo-disabled-pill');

    if (disabled) {
      stopScannerIfRunning();
      if (manualObserver) manualObserver.disconnect();
      if (mainWidget) mainWidget.style.display = 'none';
      if (miniPill) miniPill.style.display = 'flex';
      showToast("🔴 No activo en esta pestaña", "warning");
    } else {
      if (miniPill) miniPill.style.display = 'none';
      if (mainWidget) mainWidget.style.display = 'block';
      startManualTicketMonitor();
      if (!isScanningQueue) {
        toggleScanner();
      }
      updateCubeStatusUI();
      showToast("🟢 Activo en esta pestaña (Auto-atención 2° plano activa)", "success");
    }
  }

  // Escuchar mensajes desde el Popup de la extensión (Activo / No activo y Modo de operación)
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message) return;
      if (message.type === 'GET_TAB_STATUS') {
        sendResponse({
          active: !isDisabledInThisTab,
          scanning: isScanningQueue,
          mode: currentOperationMode,
          minimized: isMinimizedToCube
        });
        return true;
      }
      if (message.type === 'SET_TAB_STATUS') {
        const shouldBeActive = Boolean(message.active);
        setTabDisabledState(!shouldBeActive);
        sendResponse({
          active: !isDisabledInThisTab,
          scanning: isScanningQueue,
          mode: currentOperationMode,
          minimized: isMinimizedToCube
        });
        return true;
      }
      if (message.type === 'SET_OPERATION_MODE') {
        if (message.mode === 'greeting_only' || message.mode === 'full_beta') {
          setOperationMode(message.mode, true);
        }
        sendResponse({
          active: !isDisabledInThisTab,
          scanning: isScanningQueue,
          mode: currentOperationMode,
          minimized: isMinimizedToCube
        });
        return true;
      }
    });
  }

  function makeWidgetDraggable(widgetEl, handleEl, onClickWithoutDrag = null) {
    let isDragging = false;
    let hasMoved = false;
    let startX = 0, startY = 0, initialLeft = 0, initialTop = 0;

    handleEl.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON' || e.target.closest('button')) return;
      isDragging = true;
      hasMoved = false;
      const rect = widgetEl.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      initialLeft = rect.left;
      initialTop = rect.top;
      widgetEl.style.bottom = 'auto';
      widgetEl.style.right = 'auto';
      widgetEl.style.left = `${initialLeft}px`;
      widgetEl.style.top = `${initialTop}px`;
      widgetEl.style.transition = 'none';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.hypot(dx, dy) > 4) {
        hasMoved = true;
      }
      const minVisibleW = widgetEl.classList.contains('lc-cube-mode') ? 48 : 120;
      const newLeft = Math.max(0, Math.min(window.innerWidth - minVisibleW, initialLeft + dx));
      const newTop = Math.max(0, Math.min(window.innerHeight - 48, initialTop + dy));
      widgetEl.style.left = `${newLeft}px`;
      widgetEl.style.top = `${newTop}px`;
    });

    document.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        widgetEl.style.transition = 'all 0.2s ease-in-out';
        if (!hasMoved && typeof onClickWithoutDrag === 'function') {
          onClickWithoutDrag();
        }
      }
    });
  }

  // ==========================================
  // INTERFAZ DE USUARIO (WIDGET + CUADRITO MINIMIZADO + PASTILLA APAGADA)
  // ==========================================
  function initUI() {
    if (document.getElementById('laraigo-copilot-container')) return;

    const disabledPill = document.createElement('button');
    disabledPill.id = 'laraigo-disabled-pill';
    disabledPill.className = 'laraigo-disabled-pill';
    disabledPill.title = 'Haz clic para cambiar a ACTIVO en esta pestaña';
    disabledPill.innerHTML = `🔴 No activo`;
    disabledPill.style.display = isDisabledInThisTab ? 'flex' : 'none';
    disabledPill.addEventListener('click', () => setTabDisabledState(false));
    document.body.appendChild(disabledPill);

    const container = document.createElement('div');
    container.id = 'laraigo-copilot-container';
    container.className = `laraigo-copilot-widget ${isMinimizedToCube ? 'lc-cube-mode' : ''}`;
    container.style.display = isDisabledInThisTab ? 'none' : 'block';

    const isBeta = currentOperationMode === 'full_beta';

    container.innerHTML = `
      <!-- Vista Ultra-Compacta: "Un Cuadrito" (46x46px) al minimizar -->
      <div class="lc-mini-cube" id="lc-mini-cube" title="Clic para abrir Copiloto Claro (Arrastra para mover)">
        <span id="lc-cube-dot" class="lc-cube-dot ${isScanningQueue ? 'active' : 'paused'}"></span>
        <span id="lc-cube-icon" class="lc-cube-icon">${isBeta ? '🤖' : '⚡'}</span>
        <span id="lc-cube-mode-tag" class="lc-cube-mode-tag ${isBeta ? 'beta' : 'fast'}">${isBeta ? 'BETA' : '1°'}</span>
      </div>

      <!-- Encabezado normal del panel -->
      <div class="lc-header" id="lc-drag-handle" title="Arrastra desde aquí para mover el panel">
        <div class="lc-title">
          <span class="lc-badge">CLARO</span>
          <span>Copiloto</span>
          <span id="lc-header-mode-badge" class="lc-header-mode-badge ${isBeta ? 'beta' : 'fast'}">
            ${isBeta ? 'BETA' : '1° SALUDO'}
          </span>
        </div>
        <div class="lc-actions">
          <button id="lc-btn-disable-tab" class="lc-btn-disable-tab" title="Haz clic para cambiar a NO ACTIVO en esta pestaña">
            🟢 Activo
          </button>
          <button id="lc-btn-collapse" class="lc-btn-icon" title="Minimizar a cuadrito compacto">🗕</button>
        </div>
      </div>

      <div class="lc-body" id="lc-body">
        <!-- Selector de 2 Modos de Operación -->
        <div class="lc-mode-selector">
          <button id="lc-mode-greeting" class="lc-mode-btn ${!isBeta ? 'active' : ''}" title="Solo notifica en Windows y envía el 1° Saludo instantáneo (0s)">
            ⚡ Solo Notif. + Saludo
          </button>
          <button id="lc-mode-beta" class="lc-mode-btn ${isBeta ? 'active' : ''}" title="Modo Completo: Notificación + 1° Saludo (0s) + 2° Respuestas Inteligentes">
            🧠 Completo <span class="lc-beta-tag">BETA</span>
          </button>
        </div>

        <!-- Modal de Pregunta ante Casuísticas o Duplicados -->
        <div id="lc-casuistica-modal" class="lc-casuistica-modal" style="display: none;">
          <div id="lc-casuistica-text" class="lc-casuistica-text"></div>
          <div class="lc-casuistica-actions">
            <button id="lc-casuistica-confirm" class="lc-btn-confirm">✅ Sí, Enviar</button>
            <button id="lc-casuistica-cancel" class="lc-btn-cancel">⏭️ Omitir / Cancelar</button>
          </div>
        </div>

        <!-- Control de Auto-Atención en 2° Plano (Sin Scroll ni Cambio de Chat) -->
        <div class="lc-scanner-panel">
          <button id="lc-btn-scanner" class="lc-btn-scanner ${isScanningQueue ? 'active' : ''}">
            ${isScanningQueue ? '⏹️ Pausar Auto-Atención en 2° Plano' : '▶️ Auto-Atender en 2° Plano (Sin cambiar de chat)'}
          </button>
          <div id="lc-scanner-status" class="lc-scanner-status">
            ${isScanningQueue
              ? (isBeta ? 'Activo (Modo Completo BETA): Saludo 0s + 2° Respuesta en 2° plano...' : 'Activo (Solo Notif. + Saludo 0s): vigilando en 2° plano...')
              : 'Responde por API en 2° plano sin cambiar de ticket ni scrollear'}
          </div>
        </div>

        <!-- Info resumida cuando está en Modo 1 (Solo Notificación + Saludo Instantáneo) -->
        <div id="lc-greeting-only-info" class="lc-greeting-only-info" style="display: ${!isBeta ? 'block' : 'none'};">
          🔔 <b>Notificación Windows</b> + ⚡ <b>1° Saludo Instantáneo (0s)</b> en 2° plano.<br>
          <small>No envía segundas respuestas automáticas. Cambia a <b>Completo BETA</b> arriba si deseas activar las 2° respuestas.</small>
        </div>

        <!-- Sección Completa (BETA): Detector y 2° Respuestas por Submotivo -->
        <div id="lc-beta-features-section" style="display: ${isBeta ? 'block' : 'none'};">
          <div id="lc-live-detected">
            <div class="lc-detected-box waiting">
              🔍 Abre un chat para analizar <code>Submotivo:</code>, fotos y cintillos
            </div>
          </div>

          <div class="lc-section-title">
            ⚡ 2° Respuestas por Submotivo <span class="lc-beta-tag">BETA</span>
          </div>
          <div class="lc-submotivos-grid" id="lc-submotivos-list"></div>
        </div>
      </div>
    `;

    document.body.appendChild(container);

    const collapseBtn = container.querySelector('#lc-btn-collapse');
    const miniCube = container.querySelector('#lc-mini-cube');
    const disableTabBtn = container.querySelector('#lc-btn-disable-tab');
    const scannerBtn = container.querySelector('#lc-btn-scanner');
    const dragHandle = container.querySelector('#lc-drag-handle');
    const modeGreetingBtn = container.querySelector('#lc-mode-greeting');
    const modeBetaBtn = container.querySelector('#lc-mode-beta');

    collapseBtn.addEventListener('click', () => {
      setMinimizedToCube(true);
    });

    disableTabBtn.addEventListener('click', () => {
      setTabDisabledState(true);
    });

    modeGreetingBtn.addEventListener('click', () => {
      setOperationMode('greeting_only', true);
    });

    modeBetaBtn.addEventListener('click', () => {
      setOperationMode('full_beta', true);
    });

    scannerBtn.addEventListener('click', toggleScanner);

    makeWidgetDraggable(container, dragHandle);
    makeWidgetDraggable(container, miniCube, () => {
      setMinimizedToCube(false);
    });
    renderSubmotivoButtons();

    // Sincronizar de inmediato con page-bridge.js para recibir tickets ASIGNADO capturados al cargar
    window.postMessage({ source: 'LARAIGO_CONTENT', action: 'BRIDGE_HELLO' }, '*');

    if (!isDisabledInThisTab) {
      startManualTicketMonitor();
      if (isScanningQueue) {
        startInstantInboxArrivalWatcher();
        runNextScannerStep();
      }
    }
  }

  function renderSubmotivoButtons() {
    const list = document.getElementById('lc-submotivos-list');
    if (!list) return;
    list.innerHTML = '';

    const previews = {
      reenvio: 'Sin captura TOA: "enviar captura..." | Con captura: "un momento"',
      activaciones: 'Sin captura TOA: "enviar error..." | Con captura: "un momento"',
      cintillos: 'Verifica foto Fat/Tap y núm. cintillos (pide lo que falte)',
      mesh: 'Con foto: "Un momento" | Sin foto: "Enviar imagen del repetidor"',
      manto: 'Con video/foto/texto: "Se revisa" | Vacío: "Enviar motivo..."',
      pext: 'Con fotos: "Se revisa" | Sin fotos: "Enviar evidencias porfavor"'
    };

    SUBMOTIVO_MAP.forEach((item) => {
      const btn = document.createElement('button');
      btn.className = 'lc-submotivo-btn';
      btn.dataset.id = item.id;
      btn.title = previews[item.id] || item.defaultQuestion;

      btn.innerHTML = `
        <div class="lc-btn-top">
          <b>${item.name}</b>
        </div>
        <div class="lc-btn-preview">${previews[item.id]}</div>
      `;

      btn.addEventListener('click', () => {
        const detected = scanScreenForSubmotivo();
        safeSendTwoStepSmartReply(item, detected, false);
      });

      list.appendChild(btn);
    });
  }

  function showToast(message, type = "info") {
    let toast = document.getElementById('lc-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'lc-toast';
      document.body.appendChild(toast);
    }
    toast.className = `lc-toast lc-toast-${type} lc-toast-show`;
    toast.innerText = message;

    clearTimeout(toast.dismissTimeout);
    toast.dismissTimeout = setTimeout(() => {
      toast.classList.remove('lc-toast-show');
    }, 3000);
  }

  initUI();

})();
