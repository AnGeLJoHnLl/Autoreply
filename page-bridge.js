// ============================================================================
// Laraigo Auto-Reply Copilot - Page Network Bridge (MAIN World) v1.8
// Trabaja 100% en segundo plano por API (sin cambiar de chat ni scrollear):
//   1. Captura el Bearer Token y las plantillas de consulta de /api/main y /api/multi
//   2. Consulta tickets en Asignados (UFN_CONVERSATION_SEL_TICKETSBYUSER)
//   3. Consulta mensajes y Submotivo de cualquier conversación (UFN_CONVERSATION_SEL_INTERACTION + PERSON_SEL)
//   4. Envía el saludo (0s) y la 2° respuesta (5s) directo a POST /api/ticket/reply
// ============================================================================

(function () {
  if (window.__laraigoCopilotBridgeInstalled) return;
  window.__laraigoCopilotBridgeInstalled = true;

  let capturedBearerToken = localStorage.getItem('__lc_bearer_token') || null;
  let apiOrigin = 'https://claroapi.laraigo.com';

  let learnedInteractionMethodTemplate = null;
  let learnedPersonMethodTemplate = null;
  let learnedTicketsQueryTemplate = null;
  let learnedTicketsQueryEndpoint = '/api/main';

  try {
    const savedInt = localStorage.getItem('__lc_tpl_interaction');
    if (savedInt) learnedInteractionMethodTemplate = JSON.parse(savedInt);
    const savedPer = localStorage.getItem('__lc_tpl_person');
    if (savedPer) learnedPersonMethodTemplate = JSON.parse(savedPer);
    const savedTkt = localStorage.getItem('__lc_tpl_tickets');
    if (savedTkt) learnedTicketsQueryTemplate = JSON.parse(savedTkt);
    const savedEnd = localStorage.getItem('__lc_tpl_tickets_ep');
    if (savedEnd) learnedTicketsQueryEndpoint = savedEnd;
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
    if (typeof headerVal === 'string' && headerVal.toLowerCase().startsWith('bearer ')) {
      capturedBearerToken = headerVal.trim();
      try {
        localStorage.setItem('__lc_bearer_token', capturedBearerToken);
      } catch (e) {}
      postToContentScript('AUTH_CAPTURED', { hasToken: true });
    }
  }

  function inspectOutgoingBody(url, bodyStr) {
    if (!bodyStr || typeof bodyStr !== 'string') return;
    try {
      if (url.includes('claroapi.laraigo.com')) {
        const u = new URL(url);
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
          (method.startsWith('UFN_CONVERSATION_SEL_TICKETSBYUSER') || key.startsWith('UFN_CONVERSATION_SEL_TICKETSBYUSER')) &&
          !key.includes('_CLOSED_') &&
          !key.includes('_PAUSED_')
        ) {
          learnedTicketsQueryTemplate = isArray ? [JSON.parse(JSON.stringify(item))] : JSON.parse(JSON.stringify(item));
          learnedTicketsQueryEndpoint = url.includes('/multi') ? '/api/multi' : '/api/main';
          try {
            localStorage.setItem('__lc_tpl_tickets', JSON.stringify(learnedTicketsQueryTemplate));
            localStorage.setItem('__lc_tpl_tickets_ep', learnedTicketsQueryEndpoint);
          } catch (e) {}
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

        // 1. Lista de tickets en bandeja "Asignados"
        if (
          key.startsWith('UFN_CONVERSATION_SEL_TICKETSBYUSER') &&
          !key.includes('_CLOSED_') &&
          !key.includes('_PAUSED_')
        ) {
          postToContentScript('ASSIGNED_TICKETS', {
            key,
            tickets: rows
          });
        }

        // 2. Mensajes / interacciones dentro de un ticket
        if (key.startsWith('UFN_CONVERSATION_SEL_INTERACTION')) {
          const convIdMatch = key.match(/(\d+)$/);
          const conversationid = convIdMatch ? Number(convIdMatch[1]) : null;
          if (rows.length > 0 || block.success) {
            postToContentScript('INTERACTIONS', {
              key,
              conversationid,
              interactions: rows
            });
          }
        }

        // 3. Datos completos del técnico y variablecontext (incluye useranswer con SOT y Submotivo)
        if (key.startsWith('UFN_CONVERSATION_PERSON_SEL') && rows.length > 0) {
          postToContentScript('PERSON_CONTEXT', {
            key,
            person: rows[0]
          });
        }
      }
    } catch (e) {}
  }

  // ==========================================================================
  // 1. HOOK XMLHttpRequest
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
      if (url.includes('laraigo.com')) {
        if (typeof body === 'string') {
          inspectOutgoingBody(url, body);
        }
        this.addEventListener('load', function () {
          try {
            if (this.status >= 200 && this.status < 300 && this.responseText) {
              const json = JSON.parse(this.responseText);
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
        if (init && typeof init.body === 'string' && url.includes('laraigo.com')) {
          inspectOutgoingBody(url, init.body);
        }
      } catch (e) {}

      const response = await origFetch.apply(this, arguments);

      try {
        if (url.includes('laraigo.com') && response && response.ok) {
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
  // 3. COMANDOS DESDE CONTENT.JS (100% EN SEGUNDO PLANO SIN TOCAR LA PANTALLA)
  // ==========================================================================
  async function fetchConversationDetailsInBackground(conversationid, personid) {
    if (!capturedBearerToken || !conversationid) {
      return { ok: false, reason: 'MISSING_TOKEN_OR_CONVID' };
    }

    const multiPayload = [];

    if (learnedInteractionMethodTemplate) {
      const q = JSON.parse(JSON.stringify(learnedInteractionMethodTemplate));
      q.key = `UFN_CONVERSATION_SEL_INTERACTION_${conversationid}`;
      if (q.parameters) {
        let replaced = false;
        for (const k of Object.keys(q.parameters)) {
          if (k.toLowerCase().includes('conversation')) {
            q.parameters[k] = Number(conversationid);
            replaced = true;
          }
        }
        if (!replaced) {
          q.parameters.p_conversationid = Number(conversationid);
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

    if (personid) {
      if (learnedPersonMethodTemplate) {
        const pq = JSON.parse(JSON.stringify(learnedPersonMethodTemplate));
        pq.key = 'UFN_CONVERSATION_PERSON_SEL';
        if (pq.parameters) {
          for (const k of Object.keys(pq.parameters)) {
            if (k.toLowerCase().includes('person')) pq.parameters[k] = Number(personid);
            if (k.toLowerCase().includes('conversation')) pq.parameters[k] = Number(conversationid);
          }
        }
        multiPayload.push(pq);
      } else {
        multiPayload.push({
          method: 'UFN_CONVERSATION_PERSON_SEL',
          key: 'UFN_CONVERSATION_PERSON_SEL',
          parameters: {
            conversationid: Number(conversationid),
            personid: Number(personid)
          }
        });
      }
    }

    const res = await origFetch(`${apiOrigin}/api/multi`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': capturedBearerToken
      },
      credentials: 'include',
      body: JSON.stringify(multiPayload)
    });

    const resJson = await res.json();
    inspectIncomingJsonResponse(`${apiOrigin}/api/multi`, resJson);

    let interactions = [];
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

  window.addEventListener('message', async (event) => {
    if (event.source !== window || !event.data || event.data.source !== 'LARAIGO_CONTENT') return;

    const { action, requestId, payload } = event.data;

    // Acción A: Enviar mensaje directo por API POST /api/ticket/reply
    if (action === 'SEND_API_REPLY') {
      try {
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

        const res = await origFetch(`${apiOrigin}/api/ticket/reply`, {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'Authorization': capturedBearerToken
          },
          credentials: 'include',
          body: JSON.stringify(replyBody)
        });

        let resJson = null;
        try {
          resJson = await res.json();
        } catch (e) {}

        const ok = res.ok && (!resJson || resJson.error !== true);
        postToContentScript('API_REPLY_RESULT', {
          requestId,
          ok,
          status: res.status,
          data: resJson
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
      try {
        if (!capturedBearerToken || !learnedTicketsQueryTemplate) {
          postToContentScript('POLL_ASSIGNED_RESULT', { requestId, ok: false });
          return;
        }
        const res = await origFetch(`${apiOrigin}${learnedTicketsQueryEndpoint}`, {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'Authorization': capturedBearerToken
          },
          credentials: 'include',
          body: JSON.stringify(learnedTicketsQueryTemplate)
        });
        const resJson = await res.json();
        inspectIncomingJsonResponse(`${apiOrigin}${learnedTicketsQueryEndpoint}`, resJson);
        postToContentScript('POLL_ASSIGNED_RESULT', { requestId, ok: res.ok });
      } catch (e) {
        postToContentScript('POLL_ASSIGNED_RESULT', { requestId, ok: false });
      }
    }
  });
})();
