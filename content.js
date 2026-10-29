// Laraigo Auto-Reply Copilot - Especial Soporte Técnico Claro con Auto-Escaneo de Bandeja
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

  // Estado del escáner continuo de tickets
  let isScanningQueue = false;
  let scannerLoopTimeout = null;
  const processedTicketIds = new Set();
  let currentTicketIndex = 0;

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
      return false;
    }

    setInputValue(target, text);

    if (andSend) {
      setTimeout(() => {
        triggerSend(target);
        showToast("🚀 Mensaje enviado al técnico", "success");
      }, 250);
    } else {
      showToast("✏️ Texto insertado en el chat", "info");
    }
    return true;
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
        const fullContext = (el.innerText + ' ' + (el.nextElementSibling ? el.nextElementSibling.innerText : '')).toLowerCase();
        for (const item of SUBMOTIVO_MAP) {
          if (item.keywords.some(kw => fullContext.includes(kw))) {
            return item;
          }
        }
      }
    }

    // 2. Buscar en mensajes del chat
    const messageNodes = document.querySelectorAll(
      '[class*="message"], [class*="bubble"], [class*="chat-item"], .message-received, .msg-incoming'
    );
    const limit = Math.min(messageNodes.length, 6);
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

  // ==========================================
  // COMPROBAR SI EL CHAT ACTUAL YA TIENE RESPUESTA
  // ==========================================
  function doesCurrentChatAlreadyHaveResponse() {
    // Buscar mensajes salientes (enviados por el asesor)
    // En Laraigo suelen tener clase tipo 'outgoing', 'sent', 'bubble-right', 'self', etc.
    const allMessages = Array.from(document.querySelectorAll(
      '[class*="message"], [class*="bubble"], [class*="chat-item"], div[class*="msg"]'
    ));

    for (const msg of allMessages) {
      const text = (msg.innerText || '').toLowerCase();
      // Si ya hay un mensaje nuestro con el saludo base
      if (text.includes("hola técnico") || text.includes("procederemos con la atención")) {
        return true;
      }
    }

    return false;
  }

  // ==========================================
  // DETECCIÓN DE LA LISTA DE TICKETS (BANDEJA)
  // ==========================================
  function getInboxTicketElements() {
    // Selectores habituales para ítems de conversaciones en bandejas de Laraigo
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
      const list = Array.from(document.querySelectorAll(sel)).filter(el => el.offsetParent !== null);
      if (list.length > 0) {
        return list;
      }
    }

    // Fallback: buscar divs en el panel izquierdo que tengan apariencia de ticket (contienen nombre, hora, etc.)
    const leftPanel = document.querySelector('aside, div[class*="sidebar"], div[class*="inbox"], div[class*="list"]');
    if (leftPanel) {
      const items = Array.from(leftPanel.querySelectorAll('div > div')).filter(el => {
        return el.offsetParent !== null && el.innerText && el.innerText.length > 5 && el.innerText.length < 200 && el.querySelector('p, span, b');
      });
      if (items.length > 0) return items.slice(0, 15);
    }

    return [];
  }

  function getTicketIdentifier(ticketElement) {
    if (!ticketElement) return null;
    const text = (ticketElement.innerText || '').trim();
    // Tomar las primeras 2 líneas como firma identificadora
    return text.split('\n').slice(0, 2).join('::');
  }

  // ==========================================
  // MOTOR DE AUTO-ESCANEO ENTRE TICKETS
  // ==========================================
  function toggleScanner() {
    isScanningQueue = !isScanningQueue;
    const btn = document.getElementById('lc-btn-scanner');
    const badge = document.getElementById('lc-scanner-status');

    if (isScanningQueue) {
      btn.classList.add('active');
      btn.innerText = "⏹️ Detener Escaneo de Bandeja";
      badge.innerText = "Buscando tickets sin responder...";
      showToast("🔍 Escaneo de bandeja iniciado", "info");
      currentTicketIndex = 0;
      runNextScannerStep();
    } else {
      btn.classList.remove('active');
      btn.innerText = "▶️ Auto-Escanear Tickets Pendientes";
      badge.innerText = "Escáner en pausa";
      clearTimeout(scannerLoopTimeout);
      showToast("⏸️ Escaneo detenido", "warning");
    }
  }

  function runNextScannerStep() {
    if (!isScanningQueue) return;

    const tickets = getInboxTicketElements();
    const badge = document.getElementById('lc-scanner-status');

    if (tickets.length === 0) {
      badge.innerText = "Esperando que caigan tickets a la bandeja...";
      // Volver a revisar en 3 segundos
      scannerLoopTimeout = setTimeout(runNextScannerStep, 3000);
      return;
    }

    if (currentTicketIndex >= tickets.length) {
      badge.innerText = `Revisados ${tickets.length} tickets. Esperando nuevos...`;
      currentTicketIndex = 0;
      scannerLoopTimeout = setTimeout(runNextScannerStep, 4000);
      return;
    }

    const ticketEl = tickets[currentTicketIndex];
    const ticketId = getTicketIdentifier(ticketEl);

    badge.innerText = `Revisando ticket ${currentTicketIndex + 1} de ${tickets.length}...`;

    // Hacer clic en el ticket para abrir la conversación
    ticketEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    ticketEl.click();

    // Esperar 1.5 segundos a que cargue el contenido del chat
    scannerLoopTimeout = setTimeout(() => {
      if (!isScanningQueue) return;

      const hasAnswer = doesCurrentChatAlreadyHaveResponse();

      if (hasAnswer) {
        badge.innerText = `Ticket ${currentTicketIndex + 1}: Ya respondido. Pasando al siguiente...`;
        processedTicketIds.add(ticketId);
        currentTicketIndex++;
        scannerLoopTimeout = setTimeout(runNextScannerStep, 1000);
        return;
      }

      // Si no tiene respuesta, buscar el submotivo
      badge.innerText = `Ticket ${currentTicketIndex + 1}: ¡Sin respuesta! Escaneando submotivo...`;
      const submotivo = scanScreenForSubmotivo();

      if (submotivo) {
        badge.innerText = `🎯 Encontrado: ${submotivo.name}. Enviando mensaje...`;
        sendReply(submotivo.reply, true);
        processedTicketIds.add(ticketId);

        // Esperar 2.5 segundos para confirmar envío y pasar al siguiente
        currentTicketIndex++;
        scannerLoopTimeout = setTimeout(runNextScannerStep, 2500);
      } else {
        badge.innerText = `⚠️ Submotivo no claro en ticket ${currentTicketIndex + 1}. Pasando al siguiente...`;
        currentTicketIndex++;
        scannerLoopTimeout = setTimeout(runNextScannerStep, 1800);
      }

    }, 1500);
  }

  // ==========================================
  // INTERFAZ DE USUARIO (WIDGET FLOTANTE)
  // ==========================================
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
          <button id="lc-btn-collapse" class="lc-btn-icon" title="Minimizar">_</button>
        </div>
      </div>

      <div class="lc-body" id="lc-body">
        <!-- Control de Auto-Escaneo de Bandeja -->
        <div class="lc-scanner-panel">
          <button id="lc-btn-scanner" class="lc-btn-scanner">
            ▶️ Auto-Escanear Tickets Pendientes
          </button>
          <div id="lc-scanner-status" class="lc-scanner-status">
            Listo para escanear bandeja y responder tickets vacíos
          </div>
        </div>

        <div class="lc-section-title">⚡ Submotivos (Clic para enviar directo)</div>
        <div class="lc-submotivos-grid" id="lc-submotivos-list">
          <!-- Botones de submotivos -->
        </div>

        <div class="lc-footer">
          <small>💡 El auto-escáner cambia de ticket, revisa si ya contestaste y si no, manda la plantilla del submotivo.</small>
        </div>
      </div>
    `;

    document.body.appendChild(container);

    const collapseBtn = container.querySelector('#lc-btn-collapse');
    const bodyEl = container.querySelector('#lc-body');
    const scannerBtn = container.querySelector('#lc-btn-scanner');

    collapseBtn.addEventListener('click', () => {
      bodyEl.classList.toggle('lc-collapsed');
      collapseBtn.innerText = bodyEl.classList.contains('lc-collapsed') ? '□' : '_';
    });

    scannerBtn.addEventListener('click', toggleScanner);

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

  // Iniciar al cargar página
  initUI();

})();
