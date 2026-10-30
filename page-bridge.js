// ============================================================================
// Laraigo Auto-Reply Copilot - Page Network Bridge (MAIN World)
// Intercepta de forma pasiva las respuestas de claroapi.laraigo.com (/main, /multi, /ticket/reply)
// para leer tickets asignados, plantillas Submotivo e interacciones JSON sin necesidad
// de scrollear, y permite enviar respuestas directo por API (/api/ticket/reply).
// ============================================================================

(function () {
  if (window.__laraigoCopilotBridgeInstalled) return;
  window.__laraigoCopilotBridgeInstalled = true;

  let capturedBearerToken = null;
  let apiOrigin = 'https://claroapi.laraigo.com';

  // Plantillas de parámetros aprendidas automáticamente de las peticiones reales de Laraigo
  let learnedInteractionMethodTemplate = null;
  let learnedPersonMethodTemplate = null;

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
      postToContentScript('AUTH_CAPTURED', { hasToken: true });
    }
  }

  // Analizar el cuerpo enviado a /api/multi para aprender los nombres de parámetros exactos
  function inspectOutgoingBody(url, bodyStr) {
    if (!bodyStr || typeof bodyStr !== 'string') return;
    try {
      if (url.includes('claroapi.laraigo.com')) {
        const u = new URL(url);
        apiOrigin = u.origin;
      }
      if (!url.includes('/multi') && !url.includes('/main')) return;

      const parsed = JSON.parse(bodyStr);
      const items = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.data) ? parsed.data : [parsed]);
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        if (item.method === 'UFN_CONVERSATION_SEL_INTERACTION' && item.parameters) {
          learnedInteractionMethodTemplate = JSON.parse(JSON.stringify(item));
        }
        if (item.method === 'UFN_CONVERSATION_PERSON_SEL' && item.parameters) {
          learnedPersonMethodTemplate = JSON.parse(JSON.stringify(item));
        }
      }
    } catch (e) {}
  }

  // Analizar las respuestas JSON de /api/main y /api/multi
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

        // 1. Lista de tickets en bandeja "Asignados" (excluyendo cerrados o pausados)
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
          const convIdMatch = key.match(/UFN_CONVERSATION_SEL_INTERACTION_(\d+)/);
          const conversationid = convIdMatch ? Number(convIdMatch[1]) : null;
          postToContentScript('INTERACTIONS', {
            key,
            conversationid,
            interactions: rows
          });
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
  // 1. HOOK XMLHttpRequest (usado por Axios / Laraigo index-*.js)
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
  // 3. COMANDOS DESDE CONTENT.JS: ENVÍO DIRECTO A /api/ticket/reply Y CONSULTA /api/multi
  // ==========================================================================
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

    // Acción B: Consultar mensajes de una conversación sin abrirla en pantalla (/api/multi)
    if (action === 'FETCH_CONVERSATION_INTERACTIONS') {
      try {
        if (!capturedBearerToken) {
          postToContentScript('FETCH_INTERACTIONS_RESULT', {
            requestId,
            ok: false,
            reason: 'NO_BEARER_TOKEN'
          });
          return;
        }

        const { conversationid, personid } = payload || {};
        if (!conversationid) {
          postToContentScript('FETCH_INTERACTIONS_RESULT', {
            requestId,
            ok: false,
            reason: 'NO_CONVERSATION_ID'
          });
          return;
        }

        let interactionQuery;
        if (learnedInteractionMethodTemplate) {
          interactionQuery = JSON.parse(JSON.stringify(learnedInteractionMethodTemplate));
          interactionQuery.key = `UFN_CONVERSATION_SEL_INTERACTION_${conversationid}`;
          if (interactionQuery.parameters) {
            for (const k of Object.keys(interactionQuery.parameters)) {
              if (k.toLowerCase().includes('conversationid')) {
                interactionQuery.parameters[k] = Number(conversationid);
              }
            }
          }
        } else {
          interactionQuery = {
            method: 'UFN_CONVERSATION_SEL_INTERACTION',
            key: `UFN_CONVERSATION_SEL_INTERACTION_${conversationid}`,
            parameters: {
              p_conversationid: Number(conversationid),
              conversationid: Number(conversationid)
            }
          };
        }

        const multiPayload = [interactionQuery];

        if (personid && learnedPersonMethodTemplate) {
          const personQuery = JSON.parse(JSON.stringify(learnedPersonMethodTemplate));
          if (personQuery.parameters) {
            for (const k of Object.keys(personQuery.parameters)) {
              if (k.toLowerCase().includes('personid')) {
                personQuery.parameters[k] = Number(personid);
              }
              if (k.toLowerCase().includes('conversationid')) {
                personQuery.parameters[k] = Number(conversationid);
              }
            }
          }
          multiPayload.push(personQuery);
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

        postToContentScript('FETCH_INTERACTIONS_RESULT', {
          requestId,
          ok: res.ok,
          data: resJson
        });
      } catch (err) {
        postToContentScript('FETCH_INTERACTIONS_RESULT', {
          requestId,
          ok: false,
          reason: String(err && err.message ? err.message : err)
        });
      }
    }
  });
})();
