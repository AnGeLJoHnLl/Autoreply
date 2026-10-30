// ============================================================================
// Laraigo Auto-Reply Copilot - Page Network Bridge (MAIN World) v1.9
// Trabaja 100% en segundo plano por API (sin cambiar de chat ni scrollear):
//   1. Captura el Bearer Token (desde red y desde localStorage/sessionStorage)
//   2. Lee respuestas XHR con responseType='json' o 'text' sin InvalidStateError
//   3. Distingue la consulta de tickets ASIGNADO frente a PAUSADO/CERRADO
//   4. Escucha eventos de Socket.IO / WebSocket para detectar tickets al instante
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
      const isArray = Array.isArray(parsed);
      const items = isArray ? parsed : (Array.isArray(parsed?.data) ? parsed.data : [parsed]);

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

          // Guardar siempre la plantilla de ASIGNADO y nunca sobrescribirla con CERRADO o PAUSADO
          if (isExplicitAssigned || (!isClosedOrPaused && !learnedAssignedTicketsTemplate)) {
            learnedAssignedTicketsTemplate = isArray
              ? [JSON.parse(JSON.stringify(item))]
              : JSON.parse(JSON.stringify(item));
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

  function inspectIncomingJsonResponse(url, json) {
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
        // Nota: Tanto ASIGNADO como CERRADO devuelven la misma key "UFN_CONVERSATION_SEL_TICKETSBYUSER_<userid>"
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
              tickets: assignedRows
            });
          }
        }

        // 2. Mensajes / interacciones dentro de un ticket
        if (key.startsWith('UFN_CONVERSATION_SEL_INTERACTION')) {
          const convIdMatch = key.match(/(\d+)$/);
          const conversationid = convIdMatch ? Number(convIdMatch[1]) : (rows[0]?.conversationid ? Number(rows[0].conversationid) : null);
          if (conversationid && (rows.length > 0 || block.success)) {
            cachedInteractionsMap.set(conversationid, rows);
            postToContentScript('INTERACTIONS', {
              key,
              conversationid,
              interactions: rows
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
            person: p
          });
        }
      }
    } catch (e) {}
  }

  // ==========================================================================
  // DETECTOR DE EVENTOS EN TIEMPO REAL DE SOCKET.IO (XHR Polling + WebSocket)
  // Cuando llega un evento de nuevo ticket por socket.io, consulta Asignados al instante
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
      if (url.includes('laraigo.com') || url.startsWith('/')) {
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
              inspectIncomingJsonResponse(url, json);
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
            inspectIncomingJsonResponse(url, json);
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
  async function apiPostJson(endpointPath, payloadObj) {
    tryDiscoverTokenFromStorage();
    if (!capturedBearerToken) {
      return { ok: false, status: 0, data: null, reason: 'NO_BEARER_TOKEN' };
    }

    const fullUrl = endpointPath.startsWith('http') ? endpointPath : `${apiOrigin}${endpointPath}`;
    const bodyString = JSON.stringify(payloadObj);

    // Usar origFetch SIN credentials:'include' (igual que Angular HttpClient con Bearer token)
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
        inspectIncomingJsonResponse(fullUrl, data);
      }
      return { ok: res.ok, status: res.status, data };
    } catch (fetchErr) {
      // Respaldo por XMLHttpRequest nativo si fetch fallara
      return new Promise((resolve) => {
        try {
          const xhr = new XMLHttpRequest();
          origOpen.call(xhr, 'POST', fullUrl, true);
          origSetRequestHeader.call(xhr, 'Accept', 'application/json, text/plain, */*');
          origSetRequestHeader.call(xhr, 'Content-Type', 'application/json');
          origSetRequestHeader.call(xhr, 'Authorization', capturedBearerToken);
          xhr.onload = function () {
            let data = null;
            try {
              data = JSON.parse(xhr.responseText || 'null');
            } catch (e) {}
            if (data) inspectIncomingJsonResponse(fullUrl, data);
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

    let queryPayload = learnedAssignedTicketsTemplate;
    let endpoint = learnedAssignedTicketsEndpoint || '/api/main';

    if (!queryPayload) {
      const uid = getUserIdFromToken();
      if (!uid) return { ok: false };
      queryPayload = {
        method: 'UFN_CONVERSATION_SEL_TICKETSBYUSER',
        key: `UFN_CONVERSATION_SEL_TICKETSBYUSER_${uid}`,
        parameters: {
          userid: Number(uid),
          status: 'ASIGNADO'
        }
      };
      endpoint = '/api/main';
    }

    return apiPostJson(endpoint, queryPayload);
  }

  async function fetchConversationDetailsInBackground(conversationid, personid) {
    tryDiscoverTokenFromStorage();
    if (!capturedBearerToken || !conversationid) {
      return { ok: false, reason: 'MISSING_TOKEN_OR_CONVID', interactions: [], person: null };
    }

    const multiPayload = [];

    if (learnedInteractionMethodTemplate) {
      const q = JSON.parse(JSON.stringify(learnedInteractionMethodTemplate));
      q.key = `UFN_CONVERSATION_SEL_INTERACTION_${conversationid}`;
      if (q.parameters) {
        const paramKeys = Object.keys(q.parameters);
        let replaced = false;
        for (const k of paramKeys) {
          if (k.toLowerCase().includes('conv') || paramKeys.length === 1) {
            q.parameters[k] = typeof q.parameters[k] === 'string' ? String(conversationid) : Number(conversationid);
            replaced = true;
          }
        }
        if (!replaced) {
          q.parameters.conversationid = Number(conversationid);
        }
      }
      multiPayload.push(q);
    } else {
      multiPayload.push({
        method: 'UFN_CONVERSATION_SEL_INTERACTION',
        key: `UFN_CONVERSATION_SEL_INTERACTION_${conversationid}`,
        parameters: {
          conversationid: Number(conversationid)
        }
      });
    }

    if (personid && learnedPersonMethodTemplate) {
      const pq = JSON.parse(JSON.stringify(learnedPersonMethodTemplate));
      pq.key = 'UFN_CONVERSATION_PERSON_SEL';
      if (pq.parameters) {
        const pKeys = Object.keys(pq.parameters);
        for (const k of pKeys) {
          if (k.toLowerCase().includes('person') || (pKeys.length === 1 && !k.toLowerCase().includes('conv'))) {
            pq.parameters[k] = typeof pq.parameters[k] === 'string' ? String(personid) : Number(personid);
          }
          if (k.toLowerCase().includes('conv')) {
            pq.parameters[k] = typeof pq.parameters[k] === 'string' ? String(conversationid) : Number(conversationid);
          }
        }
      }
      multiPayload.push(pq);
    }

    const res = await apiPostJson('/api/multi', multiPayload);
    const resJson = res.data;

    let interactions = cachedInteractionsMap.get(Number(conversationid)) || [];
    let person = null;

    if (resJson && Array.isArray(resJson.data)) {
      for (const block of resJson.data) {
        if (!block || !Array.isArray(block.data)) continue;
        const k = String(block.key || '');
        if (k.startsWith('UFN_CONVERSATION_SEL_INTERACTION') && block.data.length > 0) {
          interactions = block.data;
        }
        if (k.startsWith('UFN_CONVERSATION_PERSON_SEL') && block.data.length > 0) {
          person = block.data[0];
        }
      }
    }

    return {
      ok: res.ok,
      interactions,
      person
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
          tickets: Array.from(cachedAssignedTicketsMap.values())
        });
      }
      for (const [convId, rows] of cachedInteractionsMap.entries()) {
        postToContentScript('INTERACTIONS', {
          key: `UFN_CONVERSATION_SEL_INTERACTION_${convId}`,
          conversationid: convId,
          interactions: rows
        });
      }
      for (const p of cachedPersonsMap.values()) {
        postToContentScript('PERSON_CONTEXT', {
          key: 'UFN_CONVERSATION_PERSON_SEL',
          person: p
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

        const replyBody = {
          data: {
            p_conversationid: Number(ticketMeta.conversationid),
            p_personid: Number(ticketMeta.personid),
            p_communicationchannelid: Number(ticketMeta.communicationchannelid || 64),
            p_messagesourcekey1: String(ticketMeta.personcommunicationchannel || ''),
            p_messagetext: String(messageText),
            p_type: 'text',
            communicationchannelsite: String(ticketMeta.communicationchannelsite || '51915021111'),
            communicationchanneltype: String(ticketMeta.communicationchanneltype || 'WHAL'),
            postexternalid: ticketMeta.postexternalid || null,
            commentexternalid: ticketMeta.commentexternalid || null,
            replyexternalid: ticketMeta.replyexternalid || null,
            ticketnum: String(ticketMeta.ticketnum || ''),
            uuid: generateUUID(),
            validateUserOnTicket: true,
            newanswered: Boolean(isFirstReply),
            p_emailcopy: '',
            p_emailcocopy: ''
          }
        };

        const res = await apiPostJson('/api/ticket/reply', replyBody);
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
        const { conversationid, personid } = payload || {};
        const result = await fetchConversationDetailsInBackground(conversationid, personid);
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
