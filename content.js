// Laraigo Auto-Reply Copilot - Especial Soporte Técnico Claro
// Extrae exclusivamente la línea "Submotivo: ..." del mensaje del técnico
(function () {
  'use strict';

  const BASE_GREETING = "Hola Técnico, Procederemos con la atención";

  // Mapeo oficial de Submotivos (se evalúa SOLO sobre el valor de "Submotivo:")
  const SUBMOTIVO_MAP = [
    {
      id: "reenvio",
      name: "Reenvío de señal",
      keywords: ["reenvio"],
      reply: `${BASE_GREETING}, enviar captura de reenvio desde su toa`
    },
    {
      id: "cintillos",
      name: "Consulta de Cintillos",
      keywords: ["cintillo", "fat", "tap"],
      reply: `${BASE_GREETING}, enviar cintillos y foto del fat/tap`
    },
    {
      id: "mesh",
      name: "Registro Mesh",
      keywords: ["mesh", "repetidor"],
      reply: `${BASE_GREETING}, enviar repetidor a activar`
    },
    {
      id: "manto",
      name: "SOT de Manto",
      keywords: ["manto", "mantenimiento"],
      reply: `${BASE_GREETING}, ¿cuál es el motivo de la sot de manto?`
    },
    {
      id: "pext",
      name: "Derivación a PEXT",
      keywords: ["pext", "derivacion", "planta externa"],
      reply: `${BASE_GREETING}, enviar evidencias y motivo de la derivacion`
    },
    {
      id: "activaciones",
      name: "Activaciones",
      keywords: ["activacion", "activar"],
      reply: `${BASE_GREETING}, enviar error de toa`
    }
  ];

  // Quitar tildes y pasar a minúsculas para comparar sin errores
  function normalizeText(str) {
    return (str || '')
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim();
  }

  // Estado del escáner continuo de tickets
  let isScanningQueue = false;
  let scannerLoopTimeout = null;
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
    const container = inputContext
      ? inputContext.closest('form, div[class*="footer"], div[class*="input"], div[class*="chat"]') || document
      : document;

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

  // ==============================================================
  // EXTRACCIÓN ESTRICTA DE "Submotivo: ..." DEL MENSAJE DEL TÉCNICO
  // ==============================================================
  function extractSubmotivoFromText(rawText) {
    if (!rawText) return null;

    // Busca específicamente la línea "Submotivo: <valor>" ignorando "Tipo:" o "Motivo:"
    const regex = /submotivo\s*:\s*([^\r\n]+)/i;
    const match = rawText.match(regex);
    if (!match || !match[1]) return null;

    const rawSubmotivoValue = match[1].trim();
    const normalizedValue = normalizeText(rawSubmotivoValue);

    if (!normalizedValue || normalizedValue === 'null') return null;

    // Extraer opcionalmente SOT para mostrar en el widget
    const sotMatch = rawText.match(/SOT\s+(\d+)/i);
    const sotNumber = sotMatch ? sotMatch[1] : null;

    for (const rule of SUBMOTIVO_MAP) {
      if (rule.keywords.some(kw => normalizedValue.includes(normalizeText(kw)))) {
        return {
          rule,
          rawSubmotivo: rawSubmotivoValue,
          sot: sotNumber
        };
      }
    }

    return {
      rule: null,
      rawSubmotivo: rawSubmotivoValue,
      sot: sotNumber
    };
  }

  function scanScreenForSubmotivo() {
    // 1. Buscar en los mensajes del chat el bloque que contiene "Submotivo:"
    const candidateNodes = document.querySelectorAll(
      '[class*="message"], [class*="bubble"], [class*="chat"], p, div, span'
    );

    for (const node of candidateNodes) {
      if (node.offsetParent === null) continue;
      const text = node.innerText || '';
      if (/submotivo\s*:/i.test(text)) {
        const result = extractSubmotivoFromText(text);
        if (result && result.rule) {
          return result;
        }
      }
    }

    // Fallback: escanear el texto completo del body si está fragmentado
    const bodyText = document.body.innerText || '';
    if (/submotivo\s*:/i.test(bodyText)) {
      const result = extractSubmotivoFromText(bodyText);
      if (result) return result;
    }

    return null;
  }

  // ==========================================
  // COMPROBAR SI EL CHAT ACTUAL YA TIENE RESPUESTA
  // ==========================================
  function doesCurrentChatAlreadyHaveResponse() {
    const bodyText = normalizeText(document.body.innerText || '');
    // Evitar contar el texto de nuestros propios botones del widget
    const widget = document.getElementById('laraigo-copilot-container');
    const chatContainers = Array.from(document.querySelectorAll(
      '[class*="message"], [class*="bubble"], [class*="chat-item"], div[class*="msg"]'
    ));

    for (const msg of chatContainers) {
      if (widget && widget.contains(msg)) continue;
      const text = normalizeText(msg.innerText || '');
      if (text.includes("hola tecnico, procederemos con la atencion")) {
        return true;
      }
    }

    return false;
  }

  // ==========================================
  // DETECCIÓN DE LA LISTA DE TICKETS (BANDEJA)
  // ==========================================
  function getInboxTicketElements() {
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

    const leftPanel = document.querySelector('aside, div[class*="sidebar"], div[class*="inbox"], div[class*="list"]');
    if (leftPanel) {
      const items = Array.from(leftPanel.querySelectorAll('div > div')).filter(el => {
        return el.offsetParent !== null && el.innerText && el.innerText.length > 5 && el.innerText.length < 250 && el.querySelector('p, span, b');
      });
      if (items.length > 0) return items.slice(0, 15);
    }

    return [];
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
      showToast("🔍 Escaneo automático iniciado", "info");
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
      badge.innerText = "Revisando chat abierto actual...";
      processCurrentOpenTicket(() => {
        scannerLoopTimeout = setTimeout(runNextScannerStep, 3000);
      });
      return;
    }

    if (currentTicketIndex >= tickets.length) {
      badge.innerText = `Ciclo completado (${tickets.length} tickets). Re-escaneando...`;
      currentTicketIndex = 0;
      scannerLoopTimeout = setTimeout(runNextScannerStep, 3500);
      return;
    }

    const ticketEl = tickets[currentTicketIndex];
    badge.innerText = `Abriendo ticket ${currentTicketIndex + 1} de ${tickets.length}...`;

    ticketEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    ticketEl.click();

    scannerLoopTimeout = setTimeout(() => {
      if (!isScanningQueue) return;
      processCurrentOpenTicket(() => {
        currentTicketIndex++;
        scannerLoopTimeout = setTimeout(runNextScannerStep, 2000);
      });
    }, 1500);
  }

  function processCurrentOpenTicket(onDone) {
    const badge = document.getElementById('lc-scanner-status');

    if (doesCurrentChatAlreadyHaveResponse()) {
      badge.innerText = `Ticket ya tiene respuesta. Saltando...`;
      onDone();
      return;
    }

    const detected = scanScreenForSubmotivo();
    updateDetectedPreview(detected);

    if (detected && detected.rule) {
      badge.innerText = `🎯 Submotivo: "${detected.rawSubmotivo}" ➔ Enviando respuesta...`;
      sendReply(detected.rule.reply, true);
      setTimeout(onDone, 1000);
    } else if (detected && !detected.rule) {
      badge.innerText = `⚠️ Submotivo "${detected.rawSubmotivo}" sin regla asignada.`;
      onDone();
    } else {
      badge.innerText = `🔍 Sin línea "Submotivo:" visible en este chat.`;
      onDone();
    }
  }

  function updateDetectedPreview(detected) {
    const previewEl = document.getElementById('lc-live-detected');
    if (!previewEl) return;

    // Limpiar resaltados previos
    document.querySelectorAll('.lc-submotivo-btn').forEach(b => b.classList.remove('highlighted'));

    if (detected && detected.rule) {
      const sotBadge = detected.sot ? ` | <b>SOT: ${detected.sot}</b>` : '';
      previewEl.innerHTML = `
        <div class="lc-detected-box found">
          <div>🎯 Leído: <b>Submotivo: ${detected.rawSubmotivo}</b>${sotBadge}</div>
          <button id="lc-quick-send-detected" class="lc-quick-send-btn">
            🚀 Enviar ahora: "${detected.rule.reply}"
          </button>
        </div>
      `;
      const qBtn = document.getElementById('lc-quick-send-detected');
      if (qBtn) {
        qBtn.onclick = () => sendReply(detected.rule.reply, true);
      }

      const matchingBtn = document.querySelector(`.lc-submotivo-btn[data-id="${detected.rule.id}"]`);
      if (matchingBtn) matchingBtn.classList.add('highlighted');
    } else if (detected && detected.rawSubmotivo) {
      previewEl.innerHTML = `
        <div class="lc-detected-box unknown">
          ⚠️ Submotivo leído: <b>${detected.rawSubmotivo}</b> (Selecciona plantilla abajo)
        </div>
      `;
    } else {
      previewEl.innerHTML = `
        <div class="lc-detected-box waiting">
          🔍 Abre un chat para leer la línea <code>Submotivo: ...</code>
        </div>
      `;
    }
  }

  // Monitorear en vivo cuando el asesor cambia de chat manualmente
  function startManualTicketMonitor() {
    let debounceTimer = null;
    const observer = new MutationObserver(() => {
      if (isScanningQueue) return;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const detected = scanScreenForSubmotivo();
        updateDetectedPreview(detected);
      }, 600);
    });
    observer.observe(document.body, { childList: true, subtree: true });
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
          <span class="lc-badge">CLARO SOPORTE</span> Lector de Submotivo
        </div>
        <div class="lc-actions">
          <button id="lc-btn-collapse" class="lc-btn-icon" title="Minimizar">_</button>
        </div>
      </div>

      <div class="lc-body" id="lc-body">
        <!-- Detector en tiempo real del mensaje abierto -->
        <div id="lc-live-detected">
          <div class="lc-detected-box waiting">
            🔍 Abre un chat para leer la línea <code>Submotivo: ...</code>
          </div>
        </div>

        <!-- Control de Auto-Escaneo de Bandeja -->
        <div class="lc-scanner-panel">
          <button id="lc-btn-scanner" class="lc-btn-scanner">
            ▶️ Auto-Escanear Tickets Pendientes
          </button>
          <div id="lc-scanner-status" class="lc-scanner-status">
            Ignora "Tipo:" y "Motivo:", lee solo "Submotivo:"
          </div>
        </div>

        <div class="lc-section-title">⚡ Plantillas por Submotivo (1 Clic)</div>
        <div class="lc-submotivos-grid" id="lc-submotivos-list"></div>
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
    startManualTicketMonitor();
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

  initUI();

})();
