// Laraigo Auto-Reply Copilot - Especial Soporte Técnico Claro
// Con Filtro Anti-Duplicados (por SOT + Historial DOM + Storage) y Consulta en Casuísticas
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

  // Quitar tildes y pasar a minúsculas
  function normalizeText(str) {
    return (str || '')
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim();
  }

  // ==============================================================
  // FILTRO ANTI-DUPLICADOS PERSISTENTE (SOT + FIRMA DE TICKET)
  // ==============================================================
  let answeredRegistry = {}; // { "SOT_92138252": timestamp, "SIG_...": timestamp }
  let skippedTickets = new Set(); // Tickets omitidos por el agente en esta sesión
  let isSendingLock = false; // Candado para evitar doble clic o doble envío simultáneo

  // Cargar historial de SOTs ya respondidas desde chrome.storage.local
  chrome.storage.local.get(["laraigo_answered_registry"], (res) => {
    if (res.laraigo_answered_registry) {
      // Limpiar registros de más de 24 horas para no llenar memoria
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
  });

  function markTicketAsAnswered(sot, signature) {
    const now = Date.now();
    if (sot) answeredRegistry[`SOT_${sot}`] = now;
    if (signature) answeredRegistry[`SIG_${signature}`] = now;
    chrome.storage.local.set({ laraigo_answered_registry: answeredRegistry });
  }

  function wasTicketAlreadyAnsweredInStorage(sot, signature) {
    if (sot && answeredRegistry[`SOT_${sot}`]) {
      return { answered: true, reason: `La SOT ${sot} ya fue respondida anteriormente.` };
    }
    if (signature && answeredRegistry[`SIG_${signature}`]) {
      return { answered: true, reason: `Este ticket ya fue respondido anteriormente.` };
    }
    return { answered: false };
  }

  // Estado del escáner continuo de tickets
  let isScanningQueue = false;
  let isPausedForQuestion = false;
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

  // Envío protegido con candado anti-doble-envío
  function safeSendReply(text, detectedContext = null, force = false) {
    if (isSendingLock) {
      showToast("⏳ Envío en curso, evitando duplicado...", "warning");
      return false;
    }

    const target = findChatInput();
    if (!target) {
      showToast("⚠️ Abre el chat del técnico primero", "warning");
      return false;
    }

    const detected = detectedContext || scanScreenForSubmotivo();
    const sot = detected?.sot || null;
    const sig = detected?.signature || null;

    // Verificar si ya se envió antes (salvo que el asesor fuerce el reenvío explícitamente)
    if (!force) {
      if (doesCurrentChatAlreadyHaveResponse()) {
        askAgentConfirmation(
          `⚠️ Este chat ya tiene el mensaje "Hola Técnico, Procederemos con la atención" en pantalla. ¿Seguro que deseas enviarlo otra vez?`,
          () => safeSendReply(text, detected, true)
        );
        return false;
      }

      const storageCheck = wasTicketAlreadyAnsweredInStorage(sot, sig);
      if (storageCheck.answered) {
        askAgentConfirmation(
          `⚠️ Filtro Anti-Duplicado: ${storageCheck.reason} ¿Deseas enviarlo de todas formas?`,
          () => safeSendReply(text, detected, true)
        );
        return false;
      }
    }

    // Activar candado por 3 segundos
    isSendingLock = true;
    markTicketAsAnswered(sot, sig);

    setInputValue(target, text);

    setTimeout(() => {
      triggerSend(target);
      showToast(`🚀 Enviado${sot ? ' (SOT ' + sot + ')' : ''}`, "success");
      setTimeout(() => {
        isSendingLock = false;
      }, 2500);
    }, 300);

    return true;
  }

  // ==============================================================
  // EXTRACCIÓN ESTRICTA DE "Submotivo: ..." Y DETECCIÓN DE CASUÍSTICAS
  // ==============================================================
  function extractSubmotivoFromText(rawText) {
    if (!rawText) return null;

    // Contar cuántas veces aparece "Submotivo:" en el texto para detectar múltiples plantillas
    const allSubmotivoMatches = [...rawText.matchAll(/submotivo\s*:\s*([^\r\n]+)/gi)];
    if (allSubmotivoMatches.length === 0) return null;

    // Tomar el último Submotivo enviado por el técnico
    const lastMatch = allSubmotivoMatches[allSubmotivoMatches.length - 1];
    const rawSubmotivoValue = (lastMatch[1] || '').trim();
    const normalizedValue = normalizeText(rawSubmotivoValue);

    // Extraer SOT y Nombre del técnico para el filtro anti-duplicados
    const sotMatches = [...rawText.matchAll(/SOT\s*[:#-]?\s*(\d{5,12})/gi)];
    const sotNumber = sotMatches.length > 0 ? sotMatches[sotMatches.length - 1][1] : null;

    const techMatch = rawText.match(/t[eé]cnico\s+([A-ZÁÉÍÓÚÑ\s]{5,50}?)\s+del\s+departamento/i);
    const techName = techMatch ? techMatch[1].trim() : null;

    const signature = `${techName || 'TECH'}_${sotNumber || 'NOSOT'}_${normalizedValue}`;

    // Detectar si hay múltiples submotivos distintos en el mismo chat (casuística)
    const uniqueSubmotivos = new Set(allSubmotivoMatches.map(m => normalizeText(m[1])));
    const hasMultipleDifferentSubmotivos = uniqueSubmotivos.size > 1;

    // Si el submotivo dice "null", está vacío o es muy corto
    if (!normalizedValue || normalizedValue === 'null' || normalizedValue === 'ninguno') {
      return {
        rule: null,
        rawSubmotivo: rawSubmotivoValue || 'null (vacío)',
        sot: sotNumber,
        techName,
        signature,
        casuistica: `El campo Submotivo vino vacío o "null"${sotNumber ? ' en la SOT ' + sotNumber : ''}.`
      };
    }

    // Buscar regla coincidente
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
        techName,
        signature,
        casuistica: `Submotivo no reconocido en las 6 reglas: "${rawSubmotivoValue}".`
      };
    }

    return {
      rule: matchedRules[0],
      rawSubmotivo: rawSubmotivoValue,
      sot: sotNumber,
      techName,
      signature,
      casuistica: null
    };
  }

  function scanScreenForSubmotivo() {
    const widget = document.getElementById('laraigo-copilot-container');
    const candidateNodes = document.querySelectorAll(
      '[class*="message"], [class*="bubble"], [class*="chat"], p, div, span'
    );

    let combinedChatText = '';
    for (const node of candidateNodes) {
      if (node.offsetParent === null) continue;
      if (widget && widget.contains(node)) continue;
      const text = node.innerText || '';
      if (/submotivo\s*:/i.test(text)) {
        combinedChatText += '\n' + text;
      }
    }

    if (combinedChatText) {
      return extractSubmotivoFromText(combinedChatText);
    }

    return null;
  }

  // ==========================================
  // COMPROBAR SI EL CHAT ACTUAL YA TIENE RESPUESTA EN PANTALLA
  // ==========================================
  function doesCurrentChatAlreadyHaveResponse() {
    const widget = document.getElementById('laraigo-copilot-container');
    const chatContainers = Array.from(document.querySelectorAll(
      '[class*="message"], [class*="bubble"], [class*="chat-item"], div[class*="msg"], p, span'
    ));

    const knownPhrases = [
      "hola tecnico, procederemos con la atencion",
      "enviar error de toa",
      "enviar captura de reenvio desde su toa",
      "enviar cintillos y foto del fat/tap",
      "enviar repetidor a activar",
      "cual es el motivo de la sot de manto",
      "enviar evidencias y motivo de la derivacion"
    ];

    for (const msg of chatContainers) {
      if (widget && widget.contains(msg)) continue;
      const text = normalizeText(msg.innerText || '');
      if (knownPhrases.some(phrase => text.includes(phrase))) {
        return true;
      }
    }

    // También revisar si la caja de texto ya tiene escrito el mensaje sin enviar
    const input = findChatInput();
    if (input && input.element) {
      const currentInputVal = normalizeText(input.element.value || input.element.innerText || '');
      if (currentInputVal.includes("hola tecnico")) {
        return true;
      }
    }

    return false;
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
  // MOTOR DE AUTO-ESCANEO CON PAUSA EN CASUÍSTICAS
  // ==========================================
  function toggleScanner() {
    isScanningQueue = !isScanningQueue;
    isPausedForQuestion = false;
    const btn = document.getElementById('lc-btn-scanner');
    const badge = document.getElementById('lc-scanner-status');

    if (isScanningQueue) {
      btn.classList.add('active');
      btn.innerText = "⏹️ Detener Escaneo de Bandeja";
      badge.innerText = "Iniciando escaneo seguro (anti-duplicados activo)...";
      showToast("🔍 Escaneo seguro iniciado", "info");
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
    if (!isScanningQueue || isPausedForQuestion) return;

    const tickets = getInboxTicketElements();
    const badge = document.getElementById('lc-scanner-status');

    if (tickets.length === 0) {
      badge.innerText = "Verificando chat actual...";
      processCurrentOpenTicket(() => {
        scannerLoopTimeout = setTimeout(runNextScannerStep, 3000);
      });
      return;
    }

    if (currentTicketIndex >= tickets.length) {
      badge.innerText = `Ciclo completado (${tickets.length} tickets). Vigilando nuevos...`;
      currentTicketIndex = 0;
      scannerLoopTimeout = setTimeout(runNextScannerStep, 4000);
      return;
    }

    const ticketEl = tickets[currentTicketIndex];
    badge.innerText = `Revisando ticket ${currentTicketIndex + 1} de ${tickets.length}...`;

    ticketEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    ticketEl.click();

    scannerLoopTimeout = setTimeout(() => {
      if (!isScanningQueue || isPausedForQuestion) return;
      processCurrentOpenTicket(() => {
        currentTicketIndex++;
        scannerLoopTimeout = setTimeout(runNextScannerStep, 2200);
      });
    }, 1600);
  }

  function processCurrentOpenTicket(onDone) {
    const badge = document.getElementById('lc-scanner-status');
    const detected = scanScreenForSubmotivo();
    updateDetectedPreview(detected);

    // 1. Filtro DOM: ¿Ya está nuestro mensaje en la pantalla del chat?
    if (doesCurrentChatAlreadyHaveResponse()) {
      if (detected) markTicketAsAnswered(detected.sot, detected.signature);
      badge.innerText = `✅ Ya respondido en chat. Saltando al siguiente...`;
      onDone();
      return;
    }

    // 2. Si no hay mensaje de técnico con formato de plantilla
    if (!detected) {
      badge.innerText = `🔍 Sin plantilla de técnico en este chat. Saltando...`;
      onDone();
      return;
    }

    // 3. Filtro Storage: ¿Ya habíamos respondido esta SOT antes?
    const storageCheck = wasTicketAlreadyAnsweredInStorage(detected.sot, detected.signature);
    if (storageCheck.answered) {
      badge.innerText = `🛡️ Anti-duplicado: SOT ${detected.sot || ''} ya fue atendida. Saltando...`;
      onDone();
      return;
    }

    // 4. ¿Fue omitido manualmente por el agente?
    if (skippedTickets.has(detected.signature)) {
      badge.innerText = `⏭️ Ticket omitido previamente. Saltando...`;
      onDone();
      return;
    }

    // 5. ¿Hay alguna CASUÍSTICA dudosa? -> PAUSAR Y PREGUNTAR AL ASESOR
    if (detected.casuistica || !detected.rule) {
      badge.innerText = `⚠️ Pausado: Casuística requiere tu decisión`;
      showToast("⚠️ Casuística detectada: revisa el panel", "warning");

      askAgentConfirmation(
        `❓ CASUÍSTICA DETECTADA:\n${detected.casuistica || 'No se pudo determinar la plantilla.'}\n\nElige una plantilla manualmente abajo o presiona "Omitir / Cancelar" para saltar al siguiente ticket.`,
        detected.rule ? () => {
          safeSendReply(detected.rule.reply, detected, true);
          setTimeout(onDone, 2500);
        } : null,
        () => {
          skippedTickets.add(detected.signature);
          onDone();
        }
      );
      return;
    }

    // 6. Todo claro y verificado -> Enviar 1 sola vez
    badge.innerText = `🎯 SOT ${detected.sot || ''} (${detected.rawSubmotivo}) ➔ Enviando 1 mensaje...`;
    safeSendReply(detected.rule.reply, detected, true);
    setTimeout(onDone, 2800);
  }

  function updateDetectedPreview(detected) {
    const previewEl = document.getElementById('lc-live-detected');
    if (!previewEl) return;

    document.querySelectorAll('.lc-submotivo-btn').forEach(b => b.classList.remove('highlighted'));

    const alreadyInDom = doesCurrentChatAlreadyHaveResponse();
    const alreadyInStorage = detected ? wasTicketAlreadyAnsweredInStorage(detected.sot, detected.signature).answered : false;
    const isAlreadyAttended = alreadyInDom || alreadyInStorage;

    if (detected && isAlreadyAttended) {
      previewEl.innerHTML = `
        <div class="lc-detected-box attended">
          🛡️ <b>YA ATENDIDO</b> ${detected.sot ? `(SOT: ${detected.sot})` : ''}<br>
          <small>Submotivo: ${detected.rawSubmotivo} — Bloqueado para no enviar doble.</small>
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
      previewEl.innerHTML = `
        <div class="lc-detected-box found">
          <div>🎯 Leído: <b>Submotivo: ${detected.rawSubmotivo}</b>${sotBadge}</div>
          <button id="lc-quick-send-detected" class="lc-quick-send-btn">
            🚀 Enviar 1 vez: "${detected.rule.reply}"
          </button>
        </div>
      `;
      const qBtn = document.getElementById('lc-quick-send-detected');
      if (qBtn) {
        qBtn.onclick = () => safeSendReply(detected.rule.reply, detected, false);
      }

      const matchingBtn = document.querySelector(`.lc-submotivo-btn[data-id="${detected.rule.id}"]`);
      if (matchingBtn) matchingBtn.classList.add('highlighted');
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
      }, 500);
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
          <span class="lc-badge">CLARO SOPORTE</span> Anti-Duplicado
        </div>
        <div class="lc-actions">
          <button id="lc-btn-collapse" class="lc-btn-icon" title="Minimizar">_</button>
        </div>
      </div>

      <div class="lc-body" id="lc-body">
        <!-- Modal de Pregunta ante Casuísticas o Duplicados -->
        <div id="lc-casuistica-modal" class="lc-casuistica-modal" style="display: none;">
          <div id="lc-casuistica-text" class="lc-casuistica-text"></div>
          <div class="lc-casuistica-actions">
            <button id="lc-casuistica-confirm" class="lc-btn-confirm">✅ Sí, Enviar</button>
            <button id="lc-casuistica-cancel" class="lc-btn-cancel">⏭️ Omitir / Cancelar</button>
          </div>
        </div>

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
            🛡️ Filtro activo: 1 solo mensaje por SOT + Pregunta en casuísticas
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
        const detected = scanScreenForSubmotivo();
        safeSendReply(item.reply, detected, false);
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
