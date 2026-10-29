// Laraigo Auto-Reply Copilot - Especial Soporte Técnico Claro
// Envía en 2 pasos: 1) Saludo ("Hola Técnico, Procederemos con la atención") y 2) Pregunta según Submotivo
(function () {
  'use strict';

  const BASE_GREETING = "Hola Técnico, Procederemos con la atención";

  // Mapeo oficial de Submotivos (se evalúa SOLO sobre el valor de "Submotivo:")
  const SUBMOTIVO_MAP = [
    {
      id: "reenvio",
      name: "Reenvío de señal",
      keywords: ["reenvio"],
      question: "enviar captura de reenvio desde su toa"
    },
    {
      id: "cintillos",
      name: "Consulta de Cintillos",
      keywords: ["cintillo", "fat", "tap"],
      question: "enviar cintillos y foto del fat/tap"
    },
    {
      id: "mesh",
      name: "Registro Mesh",
      keywords: ["mesh", "repetidor"],
      question: "enviar repetidor a activar"
    },
    {
      id: "manto",
      name: "SOT de Manto",
      keywords: ["manto", "mantenimiento"],
      question: "¿cuál es el motivo de la sot de manto?"
    },
    {
      id: "pext",
      name: "Derivación a PEXT",
      keywords: ["pext", "derivacion", "planta externa"],
      question: "enviar evidencias y motivo de la derivacion"
    },
    {
      id: "activaciones",
      name: "Activaciones",
      keywords: ["activacion", "activar"],
      question: "enviar error de toa"
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
  let answeredRegistry = {};
  let skippedTickets = new Set();
  let isSendingLock = false;

  chrome.storage.local.get(["laraigo_answered_registry"], (res) => {
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

  let isScanningQueue = false;
  let isPausedForQuestion = false;
  let scannerLoopTimeout = null;
  let currentTicketIndex = 0;

  // ==============================================================
  // LOCALIZAR CAJA DE TEXTO Y ENVIAR MENSAJE EN LARAIGO
  // ==============================================================
  function findChatInput() {
    const widget = document.getElementById('laraigo-copilot-container');

    // 1. Textareas visibles (excluyendo nuestro widget)
    const textareas = Array.from(document.querySelectorAll('textarea'));
    for (const ta of textareas) {
      if (widget && widget.contains(ta)) continue;
      if (ta.offsetParent !== null && !ta.disabled && !ta.readOnly) {
        return { element: ta, type: 'textarea' };
      }
    }

    // 2. Divs contenteditable visibles
    const editables = Array.from(document.querySelectorAll('[contenteditable="true"]'));
    for (const ed of editables) {
      if (widget && widget.contains(ed)) continue;
      if (ed.offsetParent !== null) {
        return { element: ed, type: 'contenteditable' };
      }
    }

    // 3. Inputs de texto de chat
    const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'));
    for (const inp of inputs) {
      if (widget && widget.contains(inp)) continue;
      if (inp.offsetParent === null || inp.disabled || inp.readOnly) continue;
      const placeholder = (inp.placeholder || '').toLowerCase();
      if (placeholder.includes('mensaje') || placeholder.includes('escribe') || placeholder.includes('chat') || placeholder.includes('responder')) {
        return { element: inp, type: 'input' };
      }
    }

    return null;
  }

  // Buscar el botón o ícono de Enviar que está junto a la caja de texto de Laraigo
  function findSendButtonNearInput(inputElement) {
    if (!inputElement) return null;
    const widget = document.getElementById('laraigo-copilot-container');

    // Subir hasta 4 niveles desde el input para encontrar el contenedor de la barra de mensaje
    let footerContainer = inputElement.parentElement;
    for (let level = 0; level < 4; level++) {
      if (!footerContainer || footerContainer === document.body) break;
      const candidates = Array.from(
        footerContainer.querySelectorAll('button, [role="button"], a, i[class*="send"], i[class*="paper-plane"], span[class*="send"], mat-icon')
      ).filter(el => {
        if (widget && widget.contains(el)) return false;
        if (el.offsetParent === null || el.disabled) return false;
        return true;
      });

      // 1. Priorizar botón con atributo o ícono de envío explícito
      for (const el of candidates) {
        const clickable = el.closest('button, [role="button"], a') || el;
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

      // 2. Si hay botones dentro del mismo contenedor pequeño del input, el botón a la derecha del input suele ser Enviar
      const buttonsInRow = Array.from(footerContainer.querySelectorAll('button, [role="button"]')).filter(
        b => (!widget || !widget.contains(b)) && b.offsetParent !== null && !b.disabled
      );
      if (buttonsInRow.length > 0) {
        const inputRect = inputElement.getBoundingClientRect();
        // Buscar botón ubicado a la derecha del input
        const rightButtons = buttonsInRow.filter(b => {
          const rect = b.getBoundingClientRect();
          return rect.left >= inputRect.right - 60 && Math.abs(rect.top - inputRect.top) < 100;
        });
        if (rightButtons.length > 0) {
          return rightButtons[rightButtons.length - 1];
        }
      }

      footerContainer = footerContainer.parentElement;
    }

    return null;
  }

  // Escribir texto en la caja de Laraigo compatible con React / Angular / Vue
  function setInputValue(target, text) {
    if (!target || !target.element) return false;
    const { element, type } = target;

    element.focus();

    if (type === 'textarea' || type === 'input') {
      const proto = type === 'textarea' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const valueSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (valueSetter) {
        valueSetter.call(element, text);
      } else {
        element.value = text;
      }
      element.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (type === 'contenteditable') {
      element.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);
      element.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
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

  // Simular clic real completo (mousedown + mouseup + click)
  function simulateRealClick(el) {
    if (!el) return;
    const opts = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.click();
  }

  // Simular Enter completo (keydown + keypress + keyup)
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

    // Si está dentro de un <form>, disparar submit también
    const parentForm = el.closest('form');
    if (parentForm) {
      if (typeof parentForm.requestSubmit === 'function') {
        try { parentForm.requestSubmit(); } catch (e) {}
      } else {
        parentForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      }
    }
  }

  // Pegar y enviar un mensaje individual garantizando que salga del input
  function pasteAndSendSingleMessage(text, callback) {
    const target = findChatInput();
    if (!target) {
      showToast("⚠️ No se encontró la caja de chat", "warning");
      if (callback) callback(false);
      return;
    }

    // 1. Pegar el texto
    setInputValue(target, text);

    // 2. Esperar 150ms a que Laraigo habilite el envío y presionar Enter
    setTimeout(() => {
      simulateEnterKey(target.element);

      // 3. Verificar tras 220ms si el texto ya se envió (caja vacía); si sigue ahí, hacer clic en el botón Enviar
      setTimeout(() => {
        const remainingText = getInputCurrentText(target);
        if (remainingText.length > 0) {
          const sendBtn = findSendButtonNearInput(target.element);
          if (sendBtn) {
            simulateRealClick(sendBtn);
          }
        }
        if (callback) callback(true);
      }, 220);
    }, 150);
  }

  // ==============================================================
  // ENVÍO EN 2 PASOS: 1° SALUDO ➔ 2° PREGUNTA DEL SUBMOTIVO
  // ==============================================================
  function safeSendTwoStepReply(questionText, detectedContext = null, force = false, onComplete = null) {
    if (isSendingLock) {
      showToast("⏳ Envío en curso, evitando duplicado...", "warning");
      if (onComplete) onComplete(false);
      return false;
    }

    const target = findChatInput();
    if (!target) {
      showToast("⚠️ Abre el chat del técnico primero", "warning");
      if (onComplete) onComplete(false);
      return false;
    }

    const detected = detectedContext || scanScreenForSubmotivo();
    const sot = detected?.sot || null;
    const sig = detected?.signature || null;

    // Verificar filtro anti-duplicado antes de enviar
    if (!force) {
      if (doesCurrentChatAlreadyHaveResponse()) {
        askAgentConfirmation(
          `⚠️ Este chat ya tiene respuesta enviada en pantalla. ¿Seguro que deseas volver a enviar los 2 mensajes?`,
          () => safeSendTwoStepReply(questionText, detected, true, onComplete)
        );
        return false;
      }

      const storageCheck = wasTicketAlreadyAnsweredInStorage(sot, sig);
      if (storageCheck.answered) {
        askAgentConfirmation(
          `⚠️ Filtro Anti-Duplicado: ${storageCheck.reason} ¿Deseas enviarlo de todas formas?`,
          () => safeSendTwoStepReply(questionText, detected, true, onComplete)
        );
        return false;
      }
    }

    // Bloquear envíos duplicados mientras salen los 2 mensajes
    isSendingLock = true;
    markTicketAsAnswered(sot, sig);

    showToast(`1/2 Enviando saludo...`, "info");

    // PASO 1: Enviar el saludo "Hola Técnico, Procederemos con la atención"
    pasteAndSendSingleMessage(BASE_GREETING, (step1Ok) => {
      if (!step1Ok) {
        isSendingLock = false;
        if (onComplete) onComplete(false);
        return;
      }

      // Esperar 1.1 segundos para que el primer mensaje salga limpio antes de mandar la pregunta
      setTimeout(() => {
        showToast(`2/2 Enviando: "${questionText}"`, "info");

        // PASO 2: Enviar la pregunta del submotivo
        pasteAndSendSingleMessage(questionText, () => {
          showToast(`✅ 2 mensajes enviados${sot ? ' (SOT ' + sot + ')' : ''}`, "success");
          setTimeout(() => {
            isSendingLock = false;
            if (onComplete) onComplete(true);
          }, 1500);
        });
      }, 1100);
    });

    return true;
  }

  // ==============================================================
  // EXTRACCIÓN ESTRICTA DE "Submotivo: ..." Y DETECCIÓN DE CASUÍSTICAS
  // ==============================================================
  function extractSubmotivoFromText(rawText) {
    if (!rawText) return null;

    const allSubmotivoMatches = [...rawText.matchAll(/submotivo\s*:\s*([^\r\n]+)/gi)];
    if (allSubmotivoMatches.length === 0) return null;

    const lastMatch = allSubmotivoMatches[allSubmotivoMatches.length - 1];
    const rawSubmotivoValue = (lastMatch[1] || '').trim();
    const normalizedValue = normalizeText(rawSubmotivoValue);

    const sotMatches = [...rawText.matchAll(/SOT\s*[:#-]?\s*(\d{5,12})/gi)];
    const sotNumber = sotMatches.length > 0 ? sotMatches[sotMatches.length - 1][1] : null;

    const techMatch = rawText.match(/t[eé]cnico\s+([A-ZÁÉÍÓÚÑ\s]{5,50}?)\s+del\s+departamento/i);
    const techName = techMatch ? techMatch[1].trim() : null;

    const signature = `${techName || 'TECH'}_${sotNumber || 'NOSOT'}_${normalizedValue}`;

    const uniqueSubmotivos = new Set(allSubmotivoMatches.map(m => normalizeText(m[1])));
    const hasMultipleDifferentSubmotivos = uniqueSubmotivos.size > 1;

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
  // COMPROBAR SI EL CHAT ACTUAL YA TIENE RESPUESTA
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
      badge.innerText = "Iniciando escaneo en 2 pasos (Saludo + Pregunta)...";
      showToast("🔍 Escaneo iniciado", "info");
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
      badge.innerText = "Verificando chat abierto...";
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

    if (doesCurrentChatAlreadyHaveResponse()) {
      if (detected) markTicketAsAnswered(detected.sot, detected.signature);
      badge.innerText = `✅ Ya respondido en chat. Saltando al siguiente...`;
      onDone();
      return;
    }

    if (!detected) {
      badge.innerText = `🔍 Sin plantilla de técnico en este chat. Saltando...`;
      onDone();
      return;
    }

    const storageCheck = wasTicketAlreadyAnsweredInStorage(detected.sot, detected.signature);
    if (storageCheck.answered) {
      badge.innerText = `🛡️ Anti-duplicado: SOT ${detected.sot || ''} ya fue atendida. Saltando...`;
      onDone();
      return;
    }

    if (skippedTickets.has(detected.signature)) {
      badge.innerText = `⏭️ Ticket omitido previamente. Saltando...`;
      onDone();
      return;
    }

    if (detected.casuistica || !detected.rule) {
      badge.innerText = `⚠️ Pausado: Casuística requiere tu decisión`;
      showToast("⚠️ Casuística detectada: revisa el panel", "warning");

      askAgentConfirmation(
        `❓ CASUÍSTICA DETECTADA:\n${detected.casuistica || 'No se pudo determinar la plantilla.'}\n\nElige una plantilla manualmente abajo o presiona "Omitir / Cancelar" para saltar al siguiente ticket.`,
        detected.rule ? () => {
          safeSendTwoStepReply(detected.rule.question, detected, true, () => onDone());
        } : null,
        () => {
          skippedTickets.add(detected.signature);
          onDone();
        }
      );
      return;
    }

    badge.innerText = `🎯 SOT ${detected.sot || ''} (${detected.rawSubmotivo}) ➔ Enviando 1° Saludo y 2° Pregunta...`;
    safeSendTwoStepReply(detected.rule.question, detected, true, () => onDone());
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
            🚀 Enviar (1° Saludo + 2° "${detected.rule.question}")
          </button>
        </div>
      `;
      const qBtn = document.getElementById('lc-quick-send-detected');
      if (qBtn) {
        qBtn.onclick = () => safeSendTwoStepReply(detected.rule.question, detected, false);
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

  function startManualTicketMonitor() {
    let debounceTimer = null;
    const observer = new MutationObserver(() => {
      if (isScanningQueue || isSendingLock) return;
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
          <span class="lc-badge">CLARO SOPORTE</span> Envío 2 Pasos
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
            1° Manda Saludo ➔ 2° Manda Pregunta del Submotivo
          </div>
        </div>

        <div class="lc-section-title">⚡ Submotivos (Manda Saludo + Pregunta)</div>
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
      btn.title = `1° ${BASE_GREETING}\n2° ${item.question}`;

      btn.innerHTML = `
        <div class="lc-btn-top">
          <b>${item.name}</b>
        </div>
        <div class="lc-btn-preview">1° Saludo ➔ 2° "${item.question}"</div>
      `;

      btn.addEventListener('click', () => {
        const detected = scanScreenForSubmotivo();
        safeSendTwoStepReply(item.question, detected, false);
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
