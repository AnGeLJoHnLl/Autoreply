// Laraigo Auto-Reply Copilot - Especial Soporte Técnico Claro
(function () {
  'use strict';

  // Base fija de mensaje para técnicos
  const BASE_GREETING = "Hola Técnico, Procederemos con la atención";

  // Mapeo de Submotivos y sus respuestas oficiales
  const SUBMOTIVO_MAP = [
    {
      id: "activaciones",
      name: "Activaciones",
      keywords: ["activaciones", "activacion", "activar"],
      reply: `${BASE_GREETING}, enviar error de toa`
    },
    {
      id: "reenvio",
      name: "Reenvío",
      keywords: ["reenvio", "reenvío"],
      reply: `${BASE_GREETING}, enviar captura de reenvio desde su toa`
    },
    {
      id: "cintillos",
      name: "Consulta de Cintillos",
      keywords: ["cintillos", "cintillo", "consulta de cintillos", "fat", "tap"],
      reply: `${BASE_GREETING}, enviar cintillos y foto del fat/tap`
    },
    {
      id: "mesh",
      name: "Registro Mesh",
      keywords: ["registro mesh", "mesh", "repetidor"],
      reply: `${BASE_GREETING}, enviar repetidor a activar`
    },
    {
      id: "manto",
      name: "SOT de Manto",
      keywords: ["sot de manto", "manto", "sot manto"],
      reply: `${BASE_GREETING}, ¿cuál es el motivo de la sot de manto?`
    },
    {
      id: "pext",
      name: "Derivación a PEXT",
      keywords: ["derivacion a pext", "derivación a pext", "pext", "derivacion pext"],
      reply: `${BASE_GREETING}, enviar evidencias y motivo de la derivacion`
    }
  ];

  let config = {
    autoReplyActive: false,
    autoReplyDelay: 1500, // 1.5 seg
    autoDetectSubmotivo: true
  };

  let lastTicketProcessed = null;
  let detectedSubmotivo = null;

  // Cargar configuración de almacenamiento
  chrome.storage.local.get(["laraigo_tech_config"], (result) => {
    if (result.laraigo_tech_config) {
      config = { ...config, ...result.laraigo_tech_config };
    }
    initUI();
    startTicketObserver();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.laraigo_tech_config) {
      config = { ...config, ...changes.laraigo_tech_config.newValue };
      updateUI();
    }
  });

  // Localizar campo de entrada en Laraigo
  function findChatInput() {
    const textareas = Array.from(document.querySelectorAll('textarea'));
    for (const ta of textareas) {
      if (ta.offsetParent !== null && !ta.disabled && !ta.readOnly) {
        return { element: ta, type: 'textarea' };
      }
    }

    const editables = Array.from(document.querySelectorAll('[contenteditable="true"]'));
    for (const ed of editables) {
      if (ed.offsetParent !== null) {
        return { element: ed, type: 'contenteditable' };
      }
    }

    const inputs = Array.from(document.querySelectorAll('input[type="text"]'));
    for (const inp of inputs) {
      const placeholder = (inp.placeholder || '').toLowerCase();
      if (placeholder.includes('mensaje') || placeholder.includes('escribe') || placeholder.includes('chat')) {
        return { element: inp, type: 'input' };
      }
    }

    return null;
  }

  // Localizar botón de enviar
  function findSendButton(inputContext) {
    const container = inputContext ? inputContext.closest('form, div[class*="footer"], div[class*="input"], div[class*="chat"]') || document : document;

    const submitBtn = container.querySelector('button[type="submit"]');
    if (submitBtn && submitBtn.offsetParent !== null && !submitBtn.disabled) return submitBtn;

    const buttons = Array.from(container.querySelectorAll('button'));
    for (const btn of buttons) {
      if (btn.offsetParent === null || btn.disabled) continue;
      const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
      const text = (btn.innerText || '').toLowerCase();
      const title = (btn.getAttribute('title') || '').toLowerCase();
      const hasSvg = btn.querySelector('svg');

      if (aria.includes('enviar') || aria.includes('send') || text.includes('enviar') || title.includes('enviar')) {
        return btn;
      }
      if (hasSvg && (btn.classList.toString().toLowerCase().includes('send') || btn.classList.toString().toLowerCase().includes('enviar'))) {
        return btn;
      }
    }

    for (let i = buttons.length - 1; i >= 0; i--) {
      if (buttons[i].offsetParent !== null && !buttons[i].disabled) {
        return buttons[i];
      }
    }

    return null;
  }

  // Escribir texto compatible con React / Vue
  function setInputValue(target, text) {
    if (!target) return false;
    const { element, type } = target;

    element.focus();

    if (type === 'textarea' || type === 'input') {
      const proto = Object.getPrototypeOf(element);
      const valueSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (valueSetter) {
        valueSetter.call(element, text);
      } else {
        element.value = text;
      }
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (type === 'contenteditable') {
      element.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }

    return true;
  }

  function triggerSend(inputTarget) {
    const btn = findSendButton(inputTarget?.element);
    if (btn) {
      btn.click();
      return true;
    }

    if (inputTarget?.element) {
      const enterEvent = new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true
      });
      inputTarget.element.dispatchEvent(enterEvent);
      return true;
    }
    return false;
  }

  function sendReply(text, andSend = true) {
    const target = findChatInput();
    if (!target) {
      showToast("⚠️ Abre el chat del técnico primero", "warning");
      return;
    }

    setInputValue(target, text);

    if (andSend) {
      setTimeout(() => {
        triggerSend(target);
        showToast("🚀 Mensaje enviado al técnico", "success");
      }, 200);
    } else {
      showToast("✏️ Texto insertado en el chat", "info");
    }
  }

  // ==========================================
  // DETECCIÓN INTELIGENTE DEL SUBMOTIVO
  // ==========================================
  function scanScreenForSubmotivo() {
    // 1. Buscar en campos laterales de información del ticket (labels "Submotivo", "Motivo", etc.)
    const allElements = document.querySelectorAll('div, span, p, td, label, b, strong');
    for (const el of allElements) {
      const text = el.innerText ? el.innerText.toLowerCase().trim() : '';
      if (text.startsWith('submotivo') || text.includes('submotivo:')) {
        // Mirar este elemento o el hermano/siguiente elemento
        const fullContext = (el.innerText + ' ' + (el.nextElementSibling ? el.nextElementSibling.innerText : '')).toLowerCase();
        for (const item of SUBMOTIVO_MAP) {
          if (item.keywords.some(kw => fullContext.includes(kw))) {
            return item;
          }
        }
      }
    }

    // 2. Buscar en los primeros mensajes del chat (muchas veces el bot del técnico pone "Submotivo: Activaciones")
    const messageNodes = document.querySelectorAll(
      '[class*="message"], [class*="bubble"], [class*="chat-item"], .message-received, .msg-incoming'
    );

    // Revisar los primeros 3 mensajes o todos si son pocos
    const limit = Math.min(messageNodes.length, 5);
    for (let i = 0; i < limit; i++) {
      const msgText = (messageNodes[i].innerText || '').toLowerCase();
      for (const item of SUBMOTIVO_MAP) {
        if (item.keywords.some(kw => msgText.includes(kw))) {
          return item;
        }
      }
    }

    // 3. Buscar en badges o etiquetas superiores del chat
    const headerBadges = document.querySelectorAll('header, [class*="header"], [class*="tag"], [class*="badge"]');
    for (const badge of headerBadges) {
      const bText = (badge.innerText || '').toLowerCase();
      for (const item of SUBMOTIVO_MAP) {
        if (item.keywords.some(kw => bText.includes(kw))) {
          return item;
        }
      }
    }

    return null;
  }

  // Observador de pantalla (cambio de ticket o apertura de chat)
  function startTicketObserver() {
    let scanTimeout = null;

    const observer = new MutationObserver(() => {
      clearTimeout(scanTimeout);
      scanTimeout = setTimeout(() => {
        checkCurrentTicket();
      }, 500);
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  function checkCurrentTicket() {
    // Verificar si hay un chat abierto
    const input = findChatInput();
    if (!input) return;

    // Detectar el submotivo actual en pantalla
    const match = scanScreenForSubmotivo();
    updateDetectedUI(match);

    // Si modo automático está encendido y encontramos un submotivo que no hayamos procesado en este ticket
    if (config.autoReplyActive && match) {
      // Obtener algún identificador del ticket actual (ej: URL o ID de conversación)
      const currentUrl = window.location.href;
      const ticketIdKey = currentUrl + '_' + match.id;

      if (lastTicketProcessed !== ticketIdKey) {
        lastTicketProcessed = ticketIdKey;
        showToast(`⚡ Submotivo "${match.name}" detectado. Respondiendo...`, "info");
        setTimeout(() => {
          sendReply(match.reply, true);
        }, config.autoReplyDelay || 1500);
      }
    }
  }

  function updateDetectedUI(match) {
    detectedSubmotivo = match;
    const statusEl = document.getElementById('lc-detected-badge');
    const autoSendBtn = document.getElementById('lc-auto-send-detected');
    if (!statusEl) return;

    if (match) {
      statusEl.innerHTML = `<span class="lc-tag lc-tag-found">🎯 Submotivo: <b>${match.name}</b></span>`;
      if (autoSendBtn) {
        autoSendBtn.style.display = 'block';
        autoSendBtn.innerText = `Enviar: "${match.reply}"`;
        autoSendBtn.onclick = () => sendReply(match.reply, true);
      }
    } else {
      statusEl.innerHTML = `<span class="lc-tag lc-tag-waiting">🔍 Esperando ticket con submotivo...</span>`;
      if (autoSendBtn) {
        autoSendBtn.style.display = 'none';
      }
    }

    // Resaltar el botón correspondiente en la cuadrícula
    document.querySelectorAll('.lc-submotivo-btn').forEach(btn => {
      if (match && btn.dataset.id === match.id) {
        btn.classList.add('highlighted');
      } else {
        btn.classList.remove('highlighted');
      }
    });
  }

  // Interfaz de Usuario
  function initUI() {
    if (document.getElementById('laraigo-copilot-container')) return;

    const container = document.createElement('div');
    container.id = 'laraigo-copilot-container';
    container.className = 'laraigo-copilot-widget';

    container.innerHTML = `
      <div class="lc-header" id="lc-drag-handle">
        <div class="lc-title">
          <span class="lc-badge">CLARO SOPORTE</span> Asistente Técnicos
        </div>
        <div class="lc-actions">
          <button id="lc-toggle-auto" class="lc-btn-pill ${config.autoReplyActive ? 'active' : ''}" title="Si activas esto, responderá solo al abrir el ticket">
            🤖 Auto: <span id="lc-auto-status">${config.autoReplyActive ? 'ON' : 'OFF'}</span>
          </button>
          <button id="lc-btn-collapse" class="lc-btn-icon" title="Minimizar">_</button>
        </div>
      </div>

      <div class="lc-body" id="lc-body">
        <!-- Estado detectado automáticamente -->
        <div class="lc-detection-panel">
          <div id="lc-detected-badge">
            <span class="lc-tag lc-tag-waiting">🔍 Escaneando submotivo...</span>
          </div>
          <button id="lc-auto-send-detected" class="lc-btn-detected-send" style="display: none;">
            <!-- Se llena dinámicamente -->
          </button>
        </div>

        <div class="lc-section-title">⚡ Submotivos (Clic para enviar)</div>
        <div class="lc-submotivos-grid" id="lc-submotivos-list">
          <!-- Botones de los 6 submotivos -->
        </div>

        <div class="lc-footer">
          <small>💡 <b>1 Clic:</b> Enviar mensaje directo al técnico.</small>
        </div>
      </div>
    `;

    document.body.appendChild(container);

    // Eventos
    const collapseBtn = container.querySelector('#lc-btn-collapse');
    const bodyEl = container.querySelector('#lc-body');
    const toggleAutoBtn = container.querySelector('#lc-toggle-auto');
    const autoStatus = container.querySelector('#lc-auto-status');

    collapseBtn.addEventListener('click', () => {
      bodyEl.classList.toggle('lc-collapsed');
      collapseBtn.innerText = bodyEl.classList.contains('lc-collapsed') ? '□' : '_';
    });

    toggleAutoBtn.addEventListener('click', () => {
      config.autoReplyActive = !config.autoReplyActive;
      toggleAutoBtn.classList.toggle('active', config.autoReplyActive);
      autoStatus.innerText = config.autoReplyActive ? 'ON' : 'OFF';
      chrome.storage.local.set({ laraigo_tech_config: config });
      showToast(
        config.autoReplyActive ? "🤖 Auto-Envío al abrir ticket ACTIVADO" : "⏸️ Modo manual (1 clic)",
        config.autoReplyActive ? "success" : "info"
      );
      if (config.autoReplyActive) {
        checkCurrentTicket();
      }
    });

    renderSubmotivoButtons();
  }

  function renderSubmotivoButtons() {
    const list = document.getElementById('lc-submotivos-list');
    if (!list) return;
    list.innerHTML = '';

    SUBMOTIVO_MAP.forEach((item) => {
      const btn = document.createElement('button');
      btn.className = 'lc-submotivo-btn';
      btn.dataset.id = item.id;
      btn.title = item.reply;

      btn.innerHTML = `
        <div class="lc-btn-top">
          <b>${item.name}</b>
        </div>
        <div class="lc-btn-preview">${item.reply.replace(BASE_GREETING + ',', '').trim()}</div>
      `;

      btn.addEventListener('click', () => {
        sendReply(item.reply, true);
      });

      list.appendChild(btn);
    });
  }

  function updateUI() {
    const toggleAutoBtn = document.getElementById('lc-toggle-auto');
    const autoStatus = document.getElementById('lc-auto-status');
    if (toggleAutoBtn && autoStatus) {
      toggleAutoBtn.classList.toggle('active', config.autoReplyActive);
      autoStatus.innerText = config.autoReplyActive ? 'ON' : 'OFF';
    }
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

})();
