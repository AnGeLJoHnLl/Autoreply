// ============================================================================
// Laraigo Auto-Reply Copilot - Page Network Bridge (MAIN World) v1.9.2
// Trabaja 100% en segundo plano por API (sin cambiar de chat ni scrollear):
//   1. Captura el Bearer Token (desde red y desde localStorage/sessionStorage)
//   2. Lee respuestas XHR con responseType='json' o 'text' sin InvalidStateError
//   3. Distingue llamadas de fondo (isFromBackground) de clics del usuario en la UI
//   4. Consulta garantizada de interacciones y Submotivo en 2° plano (/api/multi + /api/main)
//   5. Envía el saludo (0s) y la 2° respuesta (5s) directo a POST /api/ticket/reply
// ============================================================================

(function () {
  if (window.__laraigoCopilotBridgeInstalled) return;
  window.__laraigoCopilotBridgeInstalled = true;

  let capturedBearerToken = localStorage.getItem('__lc_bearer_token') || null;
  let apiOrigin = 'https://claroapi.laraigo.com';

  let learnedInteractionMethodTemplate = null;
  let learnedPersonMethodTemplate = null;
  let learnedAssignedTicketsTemplate = null;
  let learnedAssignedTicketsEndpoint = '/api/main';
  let learnedMultiUsesDataWrapper = false;

  const cachedAssignedTicketsMap = new Map();
  const cachedInteractionsMap = new Map();
  const cachedPersonsMap = new Map();

  try {
    const savedInt = localStorage.getItem('__lc_tpl_interaction');
    if (savedInt) learnedInteractionMethodTemplate = JSON.parse(savedInt);
    const savedPer = localStorage.getItem('__lc_tpl_person');
    if (savedPer) learnedPersonMethodTemplate = JSON.parse(savedPer);
    const savedTkt = localStorage.getItem('__lc_tpl_assigned_tickets');
    if (savedTkt) learnedAssignedTicketsTemplate = JSON.parse(savedTkt);
    const savedEnd = localStorage.getItem('__lc_tpl_assigned_ep');
    if (savedEnd) learnedAssignedTicketsEndpoint = savedEnd;
    const savedWrap = localStorage.getItem('__lc_tpl_multi_wrap');
    if (savedWrap) learnedMultiUsesDataWrapper = savedWrap === 'true';
  } catch (e) {}

  function generateUUID() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function postToContentScript(type, payload) {
    try {
      window.postMessage(
        Object.assign({ source: 'LARAIGO_BRIDGE', type }, payload),
        '*'
      );
    } catch (e) {}
  }

  function saveAuthHeaderIfValid(headerVal) {
    if (typeof headerVal === 'string' && headerVal.trim().toLowerCase().startsWith('bearer ')) {
      capturedBearerToken = headerVal.trim();
      try {
        localStorage.setItem('__lc_bearer_token', capturedBearerToken);
      } catch (e) {}
      postToContentScript('AUTH_CAPTURED', { hasToken: true });
    }
  }

  // Buscar token JWT en localStorage / sessionStorage por si ya existe al abrir la pestaña
  function tryDiscoverTokenFromStorage() {
    if (capturedBearerToken) return;
    const storages = [window.localStorage, window.sessionStorage];
    for (const st of storages) {
      if (!st) continue;
      try {
        for (let i = 0; i < st.length; i++) {
          const k = st.key(i);
          if (!k || k.startsWith('__lc_')) continue;
          const val = st.getItem(k) || '';
          if (/^Bearer\s+eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(val.trim())) {
            saveAuthHeaderIfValid(val.trim());
            return;
          }
          if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(val.trim())) {
            saveAuthHeaderIfValid('Bearer ' + val.trim());
            return;
          }
          if (val.includes('eyJ')) {
            const match = val.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
            if (match) {
              saveAuthHeaderIfValid('Bearer ' + match[0]);
              return;
            }
          }
        }
      } catch (e) {}
    }
  }

  function getUserIdFromToken() {
    tryDiscoverTokenFromStorage();
    if (!capturedBearerToken) return null;
    try {
      const rawJwt = capturedBearerToken.replace(/^Bearer\s+/i, '').trim();
      const parts = rawJwt.split('.');
      if (parts.length < 2) return null;
      const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const jsonPayload = decodeURIComponent(
        atob(base64)
          .split('')
          .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
          .join('')
      );
      const parsed = JSON.parse(jsonPayload);
      return (
        parsed?.user?.userid ||
        parsed?.user?.id ||
        parsed?.userid ||
        parsed?.id ||
        null
      );
    } catch (e) {
      return null;
    }
  }

  tryDiscoverTokenFromStorage();

  function inspectOutgoingBody(url, bodyStr) {
    if (!bodyStr || typeof bodyStr !== 'string') return;
    try {
      if (url.includes('claroapi.laraigo.com')) {
        const u = new URL(url, window.location.origin);
        apiOrigin = u.origin;
      }
      if (!url.includes('/multi') && !url.includes('/main')) return;

      const parsed = JSON.parse(bodyStr);
      let wrapperType = 'object';
      let items = [];

      if (Array.isArray(parsed)) {
        wrapperType = 'array';
        items = parsed;
      } else if (parsed && Array.isArray(parsed.data)) {
        wrapperType = 'data_array';
        items = parsed.data;
      } else if (parsed && parsed.data && typeof parsed.data === 'object') {
        wrapperType = 'data_object';
        items = [parsed.data];
      } else if (parsed && typeof parsed === 'object') {
        wrapperType = 'object';
        items = [parsed];
      }

      if (url.includes('/multi')) {
        learnedMultiUsesDataWrapper = wrapperType === 'data_array';
        try {
          localStorage.setItem('__lc_tpl_multi_wrap', String(learnedMultiUsesDataWrapper));
        } catch (e) {}
      }

      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const method = String(item.method || '');
        const key = String(item.key || '');

        if (method === 'UFN_CONVERSATION_SEL_INTERACTION' && item.parameters) {
          learnedInteractionMethodTemplate = JSON.parse(JSON.stringify(item));
          try {
            localStorage.setItem('__lc_tpl_interaction', JSON.stringify(learnedInteractionMethodTemplate));
          } catch (e) {}
        }

        if (method === 'UFN_CONVERSATION_PERSON_SEL' && item.parameters) {
          learnedPersonMethodTemplate = JSON.parse(JSON.stringify(item));
          try {
            localStorage.setItem('__lc_tpl_person', JSON.stringify(learnedPersonMethodTemplate));
          } catch (e) {}
        }

        if (
          method.startsWith('UFN_CONVERSATION_SEL_TICKETSBYUSER') ||
          key.startsWith('UFN_CONVERSATION_SEL_TICKETSBYUSER')
        ) {
          const paramStr = JSON.stringify(item.parameters || {}).toUpperCase();
          const isClosedOrPaused =
            paramStr.includes('CERRAD') ||
            paramStr.includes('PAUSAD') ||
            paramStr.includes('CLOSED') ||
            paramStr.includes('PAUSED') ||
            key.toUpperCase().includes('CLOSED') ||
            key.toUpperCase().includes('PAUSED');
          const isExplicitAssigned = paramStr.includes('ASIGNAD');

          // Guardar siempre la plantilla de ASIGNADO preservando el envoltorio exacto ({data:...} o [...] o {...})
          if (isExplicitAssigned || (!isClosedOrPaused && !learnedAssignedTicketsTemplate)) {
            const clonedItem = JSON.parse(JSON.stringify(item));
            if (wrapperType === 'array') {
              learnedAssignedTicketsTemplate = [clonedItem];
            } else if (wrapperType === 'data_array') {
              learnedAssignedTicketsTemplate = { data: [clonedItem] };
            } else if (wrapperType === 'data_object') {
              learnedAssignedTicketsTemplate = { data: clonedItem };
            } else {
              learnedAssignedTicketsTemplate = clonedItem;
            }
            learnedAssignedTicketsEndpoint = url.includes('/multi') ? '/api/multi' : '/api/main';
            try {
              localStorage.setItem('__lc_tpl_assigned_tickets', JSON.stringify(learnedAssignedTicketsTemplate));
              localStorage.setItem('__lc_tpl_assigned_ep', learnedAssignedTicketsEndpoint);
            } catch (e) {}
          }
        }
      }
    } catch (e) {}
  }

  function inspectIncomingJsonResponse(url, json, isFromBackground = false) {
    if (!json || typeof json !== 'object') return;
    try {
      const blocks = [];
      if (typeof json.key === 'string' && Array.isArray(json.data)) {
        blocks.push(json);
      } else if (Array.isArray(json.data)) {
        for (const sub of json.data) {
          if (sub && typeof sub === 'object' && (typeof sub.key === 'string' || Array.isArray(sub.data))) {
            blocks.push(sub);
          }
        }
      }

      for (const block of blocks) {
        const key = String(block.key || '');
        const rows = Array.isArray(block.data) ? block.data : [];

        // 1. Lista de tickets de UFN_CONVERSATION_SEL_TICKETSBYUSER
        if (key.startsWith('UFN_CONVERSATION_SEL_TICKETSBYUSER')) {
          const assignedRows = rows.filter(
            (r) => r && String(r.status || '').toUpperCase() === 'ASIGNADO'
          );
          if (assignedRows.length > 0) {
            for (const t of assignedRows) {
              if (t.ticketnum) cachedAssignedTicketsMap.set(String(t.ticketnum).trim(), t);
            }
            postToContentScript('ASSIGNED_TICKETS', {
              key,
              tickets: assignedRows,
              isFromBackground
            });
          }
        }

        // 2. Mensajes / interacciones dentro de un ticket
        if (key.startsWith('UFN_CONVERSATION_SEL_INTERACTION')) {
          const convIdMatch = key.match(/(\d+)$/);
          const conversationid = convIdMatch
            ? Number(convIdMatch[1])
            : (rows[0]?.conversationid ? Number(rows[0].conversationid) : null);
          if (conversationid && (rows.length > 0 || block.success)) {
            cachedInteractionsMap.set(conversationid, rows);
            postToContentScript('INTERACTIONS', {
              key,
              conversationid,
              interactions: rows,
              isFromBackground
            });
          }
        }

        // 3. Datos completos del técnico y variablecontext (incluye useranswer con SOT y Submotivo)
        if (key.startsWith('UFN_CONVERSATION_PERSON_SEL') && rows.length > 0) {
          const p = rows[0];
          const tNum = String(p.ticketnum || p.variablecontext?.ticketnum || '').trim();
          if (tNum) cachedPersonsMap.set(tNum, p);
          postToContentScript('PERSON_CONTEXT', {
            key,
            person: p,
            isFromBackground
          });
        }
      }
    } catch (e) {}
  }

  // ==========================================================================
  // DETECTOR DE EVENTOS EN TIEMPO REAL DE SOCKET.IO (XHR Polling + WebSocket)
  // ==========================================================================
  let socketPollTimer = null;
  function scheduleImmediateAssignedPoll(delayMs = 350) {
    clearTimeout(socketPollTimer);
    socketPollTimer = setTimeout(() => {
      pollAssignedTicketsInBackground();
    }, delayMs);
  }

  function inspectSocketIoTextPayload(rawText) {
    if (!rawText || typeof rawText !== 'string') return;
    if (
      rawText.includes('ASIGNADO') ||
      rawText.includes('ticket') ||
      rawText.includes('conversation') ||
      rawText.includes('interaction') ||
      rawText.includes('holding') ||
      rawText.includes('42[')
    ) {
      scheduleImmediateAssignedPoll(250);
    }
  }

  // ==========================================================================
  // 1. HOOK XMLHttpRequest (Soporta responseType='json' y 'text' sin errores)
  // ==========================================================================
  const origOpen = XMLHttpRequest.prototype.open;
  const origSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__laraigoUrl = typeof url === 'string' ? url : String(url || '');
    this.__laraigoMethod = method;
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (header, value) {
    try {
      if (typeof header === 'string' && header.toLowerCase() === 'authorization') {
        saveAuthHeaderIfValid(value);
      }
    } catch (e) {}
    return origSetRequestHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    try {
      const url = this.__laraigoUrl || '';
      const isInternalBg = Boolean(this.__laraigoIsBg);
      if (!isInternalBg && (url.includes('laraigo.com') || url.startsWith('/'))) {
        if (typeof body === 'string') {
          inspectOutgoingBody(url, body);
        }
        this.addEventListener('load', function () {
          try {
            if (this.status < 200 || this.status >= 300) return;

            if (url.includes('socket.io')) {
              if (!this.responseType || this.responseType === 'text') {
                inspectSocketIoTextPayload(this.responseText);
              }
              return;
            }

            let json = null;
            if (this.responseType === 'json') {
              json = this.response;
            } else if (!this.responseType || this.responseType === 'text') {
              const txt = this.responseText;
              if (txt && (txt.startsWith('{') || txt.startsWith('['))) {
                json = JSON.parse(txt);
              }
            } else if (this.response && typeof this.response === 'object') {
              json = this.response;
            }

            if (json) {
              inspectIncomingJsonResponse(url, json, false);
            }
          } catch (e) {}
        });
      }
    } catch (e) {}
    return origSend.apply(this, arguments);
  };

  // ==========================================================================
  // 2. HOOK window.fetch
  // ==========================================================================
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = async function (input, init) {
      let url = '';
      try {
        url = typeof input === 'string' ? input : (input && input.url ? input.url : '');
        if (init && init.headers) {
          if (init.headers instanceof Headers) {
            const auth = init.headers.get('Authorization') || init.headers.get('authorization');
            if (auth) saveAuthHeaderIfValid(auth);
          } else if (typeof init.headers === 'object') {
            for (const [k, v] of Object.entries(init.headers)) {
              if (k.toLowerCase() === 'authorization') saveAuthHeaderIfValid(v);
            }
          }
        }
        if (init && typeof init.body === 'string' && (url.includes('laraigo.com') || url.startsWith('/'))) {
          inspectOutgoingBody(url, init.body);
        }
      } catch (e) {}

      const response = await origFetch.apply(this, arguments);

      try {
        if ((url.includes('laraigo.com') || url.startsWith('/')) && response && response.ok) {
          const clone = response.clone();
          clone.json().then((json) => {
            inspectIncomingJsonResponse(url, json, false);
          }).catch(() => {});
        }
      } catch (e) {}

      return response;
    };
  }

  // ==========================================================================
  // 3. HOOK WebSocket (para detectar asignaciones por Socket.IO WebSocket)
  // ==========================================================================
  const OrigWebSocket = window.WebSocket;
  if (typeof OrigWebSocket === 'function') {
    window.WebSocket = function (url, protocols) {
      const ws = protocols ? new OrigWebSocket(url, protocols) : new OrigWebSocket(url);
      try {
        if (String(url || '').includes('laraigo.com')) {
          ws.addEventListener('message', (ev) => {
            if (typeof ev.data === 'string') {
              inspectSocketIoTextPayload(ev.data);
            }
          });
        }
      } catch (e) {}
      return ws;
    };
    window.WebSocket.prototype = OrigWebSocket.prototype;
    Object.assign(window.WebSocket, OrigWebSocket);
  }

  // ==========================================================================
  // 4. PETICIONES POST A LA API DE LARAIGO (SIN PROBLEMAS DE CORS)
  // ==========================================================================
  async function apiPostJson(endpointPath, payloadObj, isFromBackground = true) {
    tryDiscoverTokenFromStorage();
    if (!capturedBearerToken) {
      return { ok: false, status: 0, data: null, reason: 'NO_BEARER_TOKEN' };
    }

    const fullUrl = endpointPath.startsWith('http') ? endpointPath : `${apiOrigin}${endpointPath}`;
    const bodyString = JSON.stringify(payloadObj);

    try {
      const res = await origFetch(fullUrl, {
        method: 'POST',
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'Content-Type': 'application/json',
          'Authorization': capturedBearerToken
        },
        body: bodyString
      });
      let data = null;
      try {
        data = await res.json();
      } catch (e) {}
      if (data) {
        inspectIncomingJsonResponse(fullUrl, data, isFromBackground);
      }
      return { ok: res.ok, status: res.status, data };
    } catch (fetchErr) {
      return new Promise((resolve) => {
        try {
          const xhr = new XMLHttpRequest();
          xhr.__laraigoIsBg = true;
          origOpen.call(xhr, 'POST', fullUrl, true);
          origSetRequestHeader.call(xhr, 'Accept', 'application/json, text/plain, */*');
          origSetRequestHeader.call(xhr, 'Content-Type', 'application/json');
          origSetRequestHeader.call(xhr, 'Authorization', capturedBearerToken);
          xhr.onload = function () {
            let data = null;
            try {
              data = JSON.parse(xhr.responseText || 'null');
            } catch (e) {}
            if (data) inspectIncomingJsonResponse(fullUrl, data, isFromBackground);
            resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, data });
          };
          xhr.onerror = function () {
            resolve({ ok: false, status: 0, data: null });
          };
          origSend.call(xhr, bodyString);
        } catch (e) {
          resolve({ ok: false, status: 0, data: null });
        }
      });
    }
  }

  async function pollAssignedTicketsInBackground() {
    tryDiscoverTokenFromStorage();
    if (!capturedBearerToken) return { ok: false };

    if (learnedAssignedTicketsTemplate) {
      const endpoint = learnedAssignedTicketsEndpoint || '/api/main';
      const res = await apiPostJson(endpoint, learnedAssignedTicketsTemplate, true);
      if (res.ok && res.data) return res;
    }

    const uid = getUserIdFromToken();
    if (!uid) return { ok: false };

    const rawItem = {
      method: 'UFN_CONVERSATION_SEL_TICKETSBYUSER',
      key: `UFN_CONVERSATION_SEL_TICKETSBYUSER_${uid}`,
      parameters: {
        userid: Number(uid),
        status: 'ASIGNADO'
      }
    };

    let res = await apiPostJson('/api/main', rawItem, true);
    if (!res.ok || !res.data) {
      res = await apiPostJson('/api/main', { data: rawItem }, true);
    }
    return res;
  }

  function extractInteractionsAndPersonFromResponse(resJson, conversationid, personid, ticketnum) {
    let interactions = [];
    let person = null;

    const blocks = [];
    if (resJson && typeof resJson === 'object') {
      if (typeof resJson.key === 'string' && Array.isArray(resJson.data)) {
        blocks.push(resJson);
      } else if (Array.isArray(resJson.data)) {
        for (const b of resJson.data) {
          if (b && typeof b === 'object') blocks.push(b);
        }
      }
    }

    for (const block of blocks) {
      if (!block || !Array.isArray(block.data)) continue;
      const k = String(block.key || '');
      if (k.startsWith('UFN_CONVERSATION_SEL_INTERACTION') && block.data.length > 0) {
        interactions = block.data;
      }
      if (k.startsWith('UFN_CONVERSATION_PERSON_SEL') && block.data.length > 0) {
        const candidate = block.data[0];
        if (candidate) {
          const candTkt = String(candidate.ticketnum || candidate.variablecontext?.ticketnum || '').trim();
          const candConv = String(candidate.variablecontext?.conversationid || '').trim();
          const candPer = String(candidate.personid || candidate.variablecontext?.personid || '').trim();
          const matchesTarget =
            (ticketnum && candTkt && candTkt === String(ticketnum).trim()) ||
            (conversationid && candConv && candConv === String(conversationid).trim()) ||
            (personid && candPer && candPer === String(personid).trim());
          if (matchesTarget || !person) {
            person = candidate;
          }
        }
      }
    }

    return { interactions, person };
  }

  async function fetchConversationDetailsInBackground(conversationid, personid, ticketnum) {
    tryDiscoverTokenFromStorage();
    if (!capturedBearerToken || !conversationid) {
      return { ok: false, reason: 'MISSING_TOKEN_OR_CONVID', interactions: [], person: null };
    }

    const multiItems = [];

    // 1. Construir consulta UFN_CONVERSATION_SEL_INTERACTION
    if (learnedInteractionMethodTemplate) {
      const q = JSON.parse(JSON.stringify(learnedInteractionMethodTemplate));
      const oldConvMatch = String(q.key || '').match(/(\d+)$/);
      const oldConvIdStr = oldConvMatch ? oldConvMatch[1] : null;
      q.key = `UFN_CONVERSATION_SEL_INTERACTION_${conversationid}`;
      if (q.parameters && typeof q.parameters === 'object') {
        const paramKeys = Object.keys(q.parameters);
        let replaced = false;
        for (const k of paramKeys) {
          const valStr = String(q.parameters[k] ?? '');
          if (
            k.toLowerCase().includes('conv') ||
            paramKeys.length === 1 ||
            (oldConvIdStr && valStr === oldConvIdStr)
          ) {
            q.parameters[k] = typeof q.parameters[k] === 'string' ? String(conversationid) : Number(conversationid);
            replaced = true;
          }
        }
        if (!replaced) {
          q.parameters.conversationid = Number(conversationid);
        }
      }
      multiItems.push(q);
    } else {
      multiItems.push({
        method: 'UFN_CONVERSATION_SEL_INTERACTION',
        key: `UFN_CONVERSATION_SEL_INTERACTION_${conversationid}`,
        parameters: {
          conversationid: Number(conversationid)
        }
      });
    }

    // 2. Construir consulta UFN_CONVERSATION_PERSON_SEL (incluso si aún no se aprendió plantilla)
    if (personid) {
      if (learnedPersonMethodTemplate) {
        const pq = JSON.parse(JSON.stringify(learnedPersonMethodTemplate));
        pq.key = 'UFN_CONVERSATION_PERSON_SEL';
        if (pq.parameters && typeof pq.parameters === 'object') {
          const pKeys = Object.keys(pq.parameters);
          let replacedPerson = false;
          for (const k of pKeys) {
            const kl = k.toLowerCase();
            if (kl.includes('person') || (pKeys.length === 1 && !kl.includes('conv'))) {
              pq.parameters[k] = typeof pq.parameters[k] === 'string' ? String(personid) : Number(personid);
              replacedPerson = true;
            } else if (kl.includes('conv')) {
              pq.parameters[k] = typeof pq.parameters[k] === 'string' ? String(conversationid) : Number(conversationid);
            } else if (kl.includes('ticket') && ticketnum) {
              pq.parameters[k] = String(ticketnum);
            } else if ((kl === 'id' || kl === 'p_id') && !replacedPerson) {
              pq.parameters[k] = typeof pq.parameters[k] === 'string' ? String(personid) : Number(personid);
              replacedPerson = true;
            }
          }
        }
        multiItems.push(pq);
      } else {
        multiItems.push({
          method: 'UFN_CONVERSATION_PERSON_SEL',
          key: 'UFN_CONVERSATION_PERSON_SEL',
          parameters: {
            personid: Number(personid),
            conversationid: Number(conversationid)
          }
        });
      }
    }

    // Intentar primero con el formato aprendido (array directo o { data: array })
    const primaryPayload = learnedMultiUsesDataWrapper ? { data: multiItems } : multiItems;
    let res = await apiPostJson('/api/multi', primaryPayload, true);
    let extracted = extractInteractionsAndPersonFromResponse(res.data, conversationid, personid, ticketnum);

    // Si no devolvió interacciones, probar el formato alternativo ({ data: multiItems } vs multiItems)
    if (extracted.interactions.length === 0) {
      const altPayload = learnedMultiUsesDataWrapper ? multiItems : { data: multiItems };
      const altRes = await apiPostJson('/api/multi', altPayload, true);
      const altExtracted = extractInteractionsAndPersonFromResponse(altRes.data, conversationid, personid, ticketnum);
      if (altExtracted.interactions.length > 0 || altExtracted.person) {
        res = altRes;
        extracted = altExtracted;
      }
    }

    // Si aún no devolvió interacciones, probar vía /api/main con el primer ítem
    if (extracted.interactions.length === 0 && multiItems.length > 0) {
      const mainRes = await apiPostJson('/api/main', multiItems[0], true);
      const mainExtracted = extractInteractionsAndPersonFromResponse(mainRes.data, conversationid, personid, ticketnum);
      if (mainExtracted.interactions.length > 0) {
        extracted.interactions = mainExtracted.interactions;
      } else {
        const mainWrappedRes = await apiPostJson('/api/main', { data: multiItems[0] }, true);
        const mainWrappedExtracted = extractInteractionsAndPersonFromResponse(mainWrappedRes.data, conversationid, personid, ticketnum);
        if (mainWrappedExtracted.interactions.length > 0) {
          extracted.interactions = mainWrappedExtracted.interactions;
        }
      }
    }

    const finalInteractions =
      extracted.interactions.length > 0
        ? extracted.interactions
        : (cachedInteractionsMap.get(Number(conversationid)) || []);

    const finalPerson =
      extracted.person ||
      (ticketnum ? cachedPersonsMap.get(String(ticketnum).trim()) : null) ||
      null;

    return {
      ok: Boolean(res && res.ok) || finalInteractions.length > 0 || Boolean(finalPerson),
      interactions: finalInteractions,
      person: finalPerson
    };
  }

  // ==========================================================================
  // 5. ESCUCHAR COMANDOS DESDE CONTENT.JS
  // ==========================================================================
  window.addEventListener('message', async (event) => {
    if (event.source !== window || !event.data || event.data.source !== 'LARAIGO_CONTENT') return;

    const { action, requestId, payload } = event.data;

    // Acción 0: Sincronización inicial apenas carga content.js
    if (action === 'BRIDGE_HELLO') {
      tryDiscoverTokenFromStorage();
      if (cachedAssignedTicketsMap.size > 0) {
        postToContentScript('ASSIGNED_TICKETS', {
          key: 'UFN_CONVERSATION_SEL_TICKETSBYUSER_CACHE',
          tickets: Array.from(cachedAssignedTicketsMap.values()),
          isFromBackground: true
        });
      }
      for (const [convId, rows] of cachedInteractionsMap.entries()) {
        postToContentScript('INTERACTIONS', {
          key: `UFN_CONVERSATION_SEL_INTERACTION_${convId}`,
          conversationid: convId,
          interactions: rows,
          isFromBackground: true
        });
      }
      for (const p of cachedPersonsMap.values()) {
        postToContentScript('PERSON_CONTEXT', {
          key: 'UFN_CONVERSATION_PERSON_SEL',
          person: p,
          isFromBackground: true
        });
      }
      pollAssignedTicketsInBackground();
      return;
    }

    // Acción A: Enviar mensaje directo por API POST /api/ticket/reply
    if (action === 'SEND_API_REPLY') {
      try {
        tryDiscoverTokenFromStorage();
        if (!capturedBearerToken) {
          postToContentScript('API_REPLY_RESULT', {
            requestId,
            ok: false,
            reason: 'NO_BEARER_TOKEN'
          });
          return;
        }

        const { ticketMeta, messageText, isFirstReply } = payload || {};
        if (!ticketMeta || !ticketMeta.conversationid || !ticketMeta.personid || !messageText) {
          postToContentScript('API_REPLY_RESULT', {
            requestId,
            ok: false,
            reason: 'MISSING_TICKET_META'
          });
          return;
        }

        const tNum = String(ticketMeta.ticketnum || '').trim();
        const freshestTicket = (tNum && cachedAssignedTicketsMap.get(tNum)) || ticketMeta;

        const replyBody = {
          data: {
            p_conversationid: Number(freshestTicket.conversationid || ticketMeta.conversationid),
            p_personid: Number(freshestTicket.personid || ticketMeta.personid),
            p_communicationchannelid: Number(freshestTicket.communicationchannelid || ticketMeta.communicationchannelid || 64),
            p_messagesourcekey1: String(freshestTicket.personcommunicationchannel || ticketMeta.personcommunicationchannel || ''),
            p_messagetext: String(messageText),
            p_type: 'text',
            communicationchannelsite: String(freshestTicket.communicationchannelsite || ticketMeta.communicationchannelsite || '51915021111'),
            communicationchanneltype: String(freshestTicket.communicationchanneltype || ticketMeta.communicationchanneltype || 'WHAL'),
            postexternalid: freshestTicket.postexternalid || ticketMeta.postexternalid || null,
            commentexternalid: freshestTicket.commentexternalid || ticketMeta.commentexternalid || null,
            replyexternalid: freshestTicket.replyexternalid || ticketMeta.replyexternalid || null,
            ticketnum: tNum,
            uuid: generateUUID(),
            validateUserOnTicket: true,
            newanswered: Boolean(isFirstReply),
            p_emailcopy: '',
            p_emailcocopy: ''
          }
        };

        const res = await apiPostJson('/api/ticket/reply', replyBody, true);
        const ok = res.ok && (!res.data || res.data.error !== true);

        postToContentScript('API_REPLY_RESULT', {
          requestId,
          ok,
          status: res.status,
          data: res.data
        });
      } catch (err) {
        postToContentScript('API_REPLY_RESULT', {
          requestId,
          ok: false,
          reason: String(err && err.message ? err.message : err)
        });
      }
    }

    // Acción B: Consultar mensajes y Submotivo de una conversación en segundo plano
    if (action === 'FETCH_CONVERSATION_INTERACTIONS') {
      try {
        const { conversationid, personid, ticketnum } = payload || {};
        const result = await fetchConversationDetailsInBackground(conversationid, personid, ticketnum);
        postToContentScript('FETCH_INTERACTIONS_RESULT', Object.assign({ requestId }, result));
      } catch (err) {
        postToContentScript('FETCH_INTERACTIONS_RESULT', {
          requestId,
          ok: false,
          reason: String(err && err.message ? err.message : err)
        });
      }
    }

    // Acción C: Refrescar lista de tickets en Asignados en segundo plano
    if (action === 'POLL_ASSIGNED_TICKETS') {
      const res = await pollAssignedTicketsInBackground();
      postToContentScript('POLL_ASSIGNED_RESULT', { requestId, ok: Boolean(res && res.ok) });
    }
  });
})();
