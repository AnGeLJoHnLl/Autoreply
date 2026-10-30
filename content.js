// Laraigo Auto-Reply Copilot - Especial Soporte Técnico Claro
// Incluye:
// - Botón para Desactivar/Activar de forma independiente por pestaña (ideal cuando se usan 2 ventanas/pestañas)
// - Widget arrastrable para no tapar el chat
// - 1° Saludo fijo ➔ 2° Análisis de Submotivo + Detector de Capturas de App TOA ("un momento")
// - Triple filtro anti-duplicado sincronizado en tiempo real entre pestañas (por SOT y por N° de Ticket Laraigo)
(function () {
  'use strict';

  const BASE_GREETING = "Hola Técnico, Procederemos con la atención";

  const SUBMOTIVO_MAP = [
    {
      id: "reenvio",
      name: "Reenvío de señal",
      keywords: ["reenvio"],
      question: "enviar captura de reenvio desde su toa",
      supportsAppScreenshotCheck: true
    },
    {
      id: "activaciones",
      name: "Activaciones",
      keywords: ["activacion", "activar"],
      question: "enviar error de toa",
      supportsAppScreenshotCheck: true
    },
    {
      id: "cintillos",
      name: "Consulta de Cintillos",
      keywords: ["cintillo", "fat", "tap"],
      question: "enviar cintillos y foto del fat/tap",
      supportsAppScreenshotCheck: false
    },
    {
      id: "mesh",
      name: "Registro Mesh",
      keywords: ["mesh", "repetidor"],
      question: "enviar repetidor a activar",
      supportsAppScreenshotCheck: false
    },
    {
      id: "manto",
      name: "SOT de Manto",
      keywords: ["manto", "mantenimiento"],
      question: "¿cuál es el motivo de la sot de manto?",
      supportsAppScreenshotCheck: false
    },
    {
      id: "pext",
      name: "Derivación a PEXT",
      keywords: ["pext", "derivacion", "planta externa"],
      question: "enviar evidencias y motivo de la derivacion",
      supportsAppScreenshotCheck: false
    }
  ];

  function normalizeText(str) {
    return (str || '')
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim();
  }

  // ==============================================================
  // ESTADO INDEPENDIENTE POR PESTAÑA (Permite apagar en 1 pestaña y usar en otra)
  // ==============================================================
  let isDisabledInThisTab = sessionStorage.getItem('laraigo_copilot_tab_disabled') === 'true';
  let manualObserver = null;

  // ==============================================================
  // FILTRO ANTI-DUPLICADOS SINCRONIZADO ENTRE PESTAÑAS
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

  // Escuchar en vivo si la otra pestaña ya respondió un ticket/SOT
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.laraigo_answered_registry?.newValue) {
      answeredRegistry = changes.laraigo_answered_registry.newValue;
    }
  });

  function markTicketAsAnswered(sot, ticketNum, signature) {
    const now = Date.now();
    if (sot) answeredRegistry[`SOT_${sot}`] = now;
    if (ticketNum) answeredRegistry[`TICKET_${ticketNum}`] = now;
    if (signature) answeredRegistry[`SIG_${signature}`] = now;
    chrome.storage.local.set({ laraigo_answered_registry: answeredRegistry });
  }

  function wasTicketAlreadyAnsweredInStorage(sot, ticketNum, signature) {
    if (sot && answeredRegistry[`SOT_${sot}`]) {
      return { answered: true, reason: `La SOT ${sot} ya fue respondida.` };
    }
    if (ticketNum && answeredRegistry[`TICKET_${ticketNum}`]) {
      return { answered: true, reason: `El Ticket ${ticketNum} ya fue respondido.` };
    }
    if (signature && answeredRegistry[`SIG_${signature}`]) {
      return { answered: true, reason: `Este ticket ya fue respondido.` };
    }
    return { answered: false };
  }

  let isScanningQueue = false;
  let isPausedForQuestion = false;
  let scannerLoopTimeout = null;
  let currentTicketIndex = 0;

  const imageClassificationCache = new Map();

  // ==============================================================
  // ANALIZADOR VISUAL DE IMÁGENES DEL TICKET:
  // Ignora fotos de equipos (ZTE/cajas) y detecta capturas de App celular (TOA)
  // ==============================================================
  function getChatAttachmentImages() {
    const widget = document.getElementById('laraigo-copilot-container');
    const allImgs = Array.from(document.querySelectorAll('img'));

    return allImgs.filter(img => {
      if (widget && widget.contains(img)) return false;
      if (img.offsetParent === null) return false;
      const rect = img.getBoundingClientRect();
      if (rect.width < 100 || rect.height < 100) return false;
      const src = (img.src || '').toLowerCase();
      if (!src || src.includes('avatar') || src.includes('emoji') || src.includes('logo')) return false;
      return true;
    });
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

      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ action: "fetchImageAsDataUrl", url: src }, (response) => {
          if (response && response.ok && response.dataUrl) {
            const tempImg = new Image();
            tempImg.onload = () => {
              try {
                const res = analyzePixelsFromImageSource(tempImg);
                imageClassificationCache.set(src, res);
                resolve(res);
              } catch (e) {
                resolve({ type: 'unknown' });
              }
            };
            tempImg.onerror = () => resolve({ type: 'unknown' });
            tempImg.src = response.dataUrl;
          } else {
            const w = imgEl.naturalWidth || imgEl.clientWidth || 1;
            const h = imgEl.naturalHeight || imgEl.clientHeight || 1;
            const isVerticalPhoneScreen = (h / w) >= 1.55;
            resolve({ type: isVerticalPhoneScreen ? 'app_screenshot' : 'equipment_photo' });
          }
        });
      } else {
        resolve({ type: 'unknown' });
      }
    });
  }

  async function analyzeAllTicketImages() {
    const imgs = getChatAttachmentImages();
    if (imgs.length === 0) {
      return { totalImages: 0, appScreenshots: 0, equipmentPhotos: 0, hasAppScreenshot: false };
    }

    let appScreenshots = 0;
    let equipmentPhotos = 0;

    for (const img of imgs) {
      const result = await classifySingleImageElement(img);
      if (result.type === 'app_screenshot') {
        appScreenshots++;
      } else if (result.type === 'equipment_photo') {
        equipmentPhotos++;
      }
    }

    return {
      totalImages: imgs.length,
      appScreenshots,
      equipmentPhotos,
      hasAppScreenshot: appScreenshots > 0
    };
  }

  function resolveSecondMessage(rule, imageStats) {
    if (!rule) return null;
    if (rule.supportsAppScreenshotCheck && imageStats && imageStats.hasAppScreenshot) {
      return "un momento";
    }
    return rule.question;
  }

  // ==============================================================
  // LOCALIZAR CAJA DE TEXTO Y ENVIAR MENSAJE EN LARAIGO
  // ==============================================================
  function isConversationBlockedByHSM() {
    const bodyText = normalizeText(document.body.innerText || '');
    return bodyText.includes("esta conversacion se encuentra bloqueada hasta que el cliente responda");
  }

  function findChatInput() {
    const widget = document.getElementById('laraigo-copilot-container');

    const textareas = Array.from(document.querySelectorAll('textarea'));
    for (const ta of textareas) {
      if (widget && widget.contains(ta)) continue;
      if (ta.offsetParent !== null && !ta.disabled && !ta.readOnly) {
        return { element: ta, type: 'textarea' };
      }
    }

    const editables = Array.from(document.querySelectorAll('[contenteditable="true"]'));
    for (const ed of editables) {
      if (widget && widget.contains(ed)) continue;
      if (ed.offsetParent !== null) {
        return { element: ed, type: 'contenteditable' };
      }
    }

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

  function findSendButtonNearInput(inputElement) {
    if (!inputElement) return null;
    const widget = document.getElementById('laraigo-copilot-container');

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

      const buttonsInRow = Array.from(footerContainer.querySelectorAll('button, [role="button"]')).filter(
        b => (!widget || !widget.contains(b)) && b.offsetParent !== null && !b.disabled
      );
      if (buttonsInRow.length > 0) {
        const inputRect = inputElement.getBoundingClientRect();
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

  function simulateRealClick(el) {
    if (!el) return;
    const opts = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
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

  function pasteAndSendSingleMessage(text, callback) {
    const target = findChatInput();
    if (!target) {
      showToast("⚠️ No se encontró la caja de chat (o conversación bloqueada)", "warning");
      if (callback) callback(false);
      return;
    }

    setInputValue(target, text);

    setTimeout(() => {
      simulateEnterKey(target.element);

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
  // ENVÍO INTELIGENTE EN 2 PASOS:
  // Si el saludo "Hola Técnico, Procederemos con la atención" YA está en el chat
  // (por ej. enviado por otra macro), solo envía el 2° mensaje para no duplicar el saludo.
  // ==============================================================
  async function safeSendTwoStepSmartReply(ruleOrQuestion, detectedContext = null, force = false, onComplete = null) {
    if (isDisabledInThisTab) return false;

    if (isSendingLock) {
      showToast("⏳ Envío en curso, evitando duplicado...", "warning");
      if (onComplete) onComplete(false);
      return false;
    }

    if (isConversationBlockedByHSM()) {
      showToast("⛔ Conversación bloqueada por HSM", "warning");
      if (onComplete) onComplete(false);
      return false;
    }

    const target = findChatInput();
    if (!target) {
      showToast("⚠️ Abre un chat habilitado primero", "warning");
      if (onComplete) onComplete(false);
      return false;
    }

    const detected = detectedContext || scanScreenForSubmotivo();
    const sot = detected?.sot || null;
    const ticketNum = detected?.ticketNum || null;
    const sig = detected?.signature || null;

    if (!force) {
      if (doesCurrentChatAlreadyHaveSecondQuestion()) {
        askAgentConfirmation(
          `⚠️ Este chat ya tiene la respuesta completa enviada en pantalla. ¿Seguro que deseas volver a enviar?`,
          () => safeSendTwoStepSmartReply(ruleOrQuestion, detected, true, onComplete)
        );
        return false;
      }

      const storageCheck = wasTicketAlreadyAnsweredInStorage(sot, ticketNum, sig);
      if (storageCheck.answered) {
        askAgentConfirmation(
          `⚠️ Filtro Anti-Duplicado: ${storageCheck.reason} ¿Deseas enviarlo de todas formas?`,
          () => safeSendTwoStepSmartReply(ruleOrQuestion, detected, true, onComplete)
        );
        return false;
      }
    }

    isSendingLock = true;
    markTicketAsAnswered(sot, ticketNum, sig);

    const greetingAlreadyPresent = doesCurrentChatAlreadyHaveGreeting();

    // Analizar las imágenes del ticket antes del 2° mensaje
    const imageStats = await analyzeAllTicketImages();
    const secondMessageText = typeof ruleOrQuestion === 'string'
      ? ruleOrQuestion
      : resolveSecondMessage(ruleOrQuestion, imageStats);

    // Si el saludo ya estaba en el chat (ej. enviado por Monitoreo Activo), no duplicar el saludo; mandar solo el 2° mensaje
    if (greetingAlreadyPresent && !force) {
      showToast(`Saludo ya presente ➔ Enviando: "${secondMessageText}"`, "info");
      pasteAndSendSingleMessage(secondMessageText, () => {
        showToast(`✅ Atención completada${sot ? ' (SOT ' + sot + ')' : ''}`, "success");
        setTimeout(() => {
          isSendingLock = false;
          if (onComplete) onComplete(true);
        }, 1500);
      });
      return true;
    }

    // PASO 1: Enviar SÍ O SÍ el saludo primero
    showToast(`1/2 Enviando saludo inicial...`, "info");
    pasteAndSendSingleMessage(BASE_GREETING, (step1Ok) => {
      if (!step1Ok) {
        isSendingLock = false;
        if (onComplete) onComplete(false);
        return;
      }

      setTimeout(() => {
        if (imageStats.hasAppScreenshot && typeof ruleOrQuestion === 'object' && ruleOrQuestion.supportsAppScreenshotCheck) {
          showToast(`📱 Captura TOA detectada ➔ Enviando: "un momento"`, "info");
        } else {
          showToast(`2/2 Enviando: "${secondMessageText}"`, "info");
        }

        // PASO 2: Enviar "un momento" o la pregunta del submotivo
        pasteAndSendSingleMessage(secondMessageText, () => {
          showToast(`✅ Atención enviada${sot ? ' (SOT ' + sot + ')' : ''}`, "success");
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
  // EXTRACCIÓN ESTRICTA DE "Submotivo: ...", SOT Y TICKET DE LARAIGO
  // ==============================================================
  function getCurrentLaraigoTicketNumber() {
    const bodyText = document.body.innerText || '';
    const match = bodyText.match(/Ticket\s*:\s*(\d{5,12})/i);
    return match ? match[1] : null;
  }

  function extractSubmotivoFromText(rawText) {
    if (!rawText) return null;

    const allSubmotivoMatches = [...rawText.matchAll(/submotivo\s*:\s*([^\r\n]+)/gi)];
    if (allSubmotivoMatches.length === 0) return null;

    const lastMatch = allSubmotivoMatches[allSubmotivoMatches.length - 1];
    const rawSubmotivoValue = (lastMatch[1] || '').trim();
    const normalizedValue = normalizeText(rawSubmotivoValue);

    const sotMatches = [...rawText.matchAll(/SOT\s*[:#-]?\s*(\d{5,12})/gi)];
    const sotNumber = sotMatches.length > 0 ? sotMatches[sotMatches.length - 1][1] : null;

    const ticketNum = getCurrentLaraigoTicketNumber();

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
  // COMPROBAR SI EL CHAT YA TIENE SALUDO O PREGUNTA
  // ==========================================
  function doesCurrentChatAlreadyHaveGreeting() {
    const widget = document.getElementById('laraigo-copilot-container');
    const chatContainers = Array.from(document.querySelectorAll(
      '[class*="message"], [class*="bubble"], [class*="chat-item"], div[class*="msg"], p, span'
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

  function doesCurrentChatAlreadyHaveSecondQuestion() {
    const widget = document.getElementById('laraigo-copilot-container');
    const chatContainers = Array.from(document.querySelectorAll(
      '[class*="message"], [class*="bubble"], [class*="chat-item"], div[class*="msg"], p, span'
    ));

    const secondStepPhrases = [
      "enviar error de toa",
      "enviar captura de reenvio desde su toa",
      "enviar cintillos y foto del fat/tap",
      "enviar repetidor a activar",
      "cual es el motivo de la sot de manto",
      "enviar evidencias y motivo de la derivacion"
    ];

    let hasGreeting = false;
    let hasUnMomento = false;

    for (const msg of chatContainers) {
      if (widget && widget.contains(msg)) continue;
      const text = normalizeText(msg.innerText || '');
      if (secondStepPhrases.some(phrase => text.includes(phrase))) {
        return true;
      }
      if (text.includes("hola tecnico, procederemos con la atencion")) {
        hasGreeting = true;
      }
      if (text === "un momento" || text.startsWith("un momento\n") || text.includes("\nun momento")) {
        hasUnMomento = true;
      }
    }

    return hasGreeting && hasUnMomento;
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
  // MOTOR DE AUTO-ESCANEO CON ANÁLISIS DE IMÁGENES
  // ==========================================
  function stopScannerIfRunning() {
    if (isScanningQueue) {
      isScanningQueue = false;
      isPausedForQuestion = false;
      clearTimeout(scannerLoopTimeout);
      const btn = document.getElementById('lc-btn-scanner');
      const badge = document.getElementById('lc-scanner-status');
      if (btn) {
        btn.classList.remove('active');
        btn.innerText = "▶️ Auto-Escanear Tickets Pendientes";
      }
      if (badge) {
        badge.innerText = "Escáner en pausa";
      }
    }
  }

  function toggleScanner() {
    if (isDisabledInThisTab) return;
    isScanningQueue = !isScanningQueue;
    isPausedForQuestion = false;
    const btn = document.getElementById('lc-btn-scanner');
    const badge = document.getElementById('lc-scanner-status');

    if (isScanningQueue) {
      btn.classList.add('active');
      btn.innerText = "⏹️ Detener Escaneo de Bandeja";
      badge.innerText = "Escaneando Submotivos e Imágenes TOA...";
      showToast("🔍 Escaneo inteligente iniciado en esta pestaña", "info");
      currentTicketIndex = 0;
      runNextScannerStep();
    } else {
      stopScannerIfRunning();
      showToast("⏸️ Escaneo detenido", "warning");
    }
  }

  function runNextScannerStep() {
    if (!isScanningQueue || isPausedForQuestion || isDisabledInThisTab) return;

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
      if (!isScanningQueue || isPausedForQuestion || isDisabledInThisTab) return;
      processCurrentOpenTicket(() => {
        currentTicketIndex++;
        scannerLoopTimeout = setTimeout(runNextScannerStep, 2200);
      });
    }, 1700);
  }

  async function processCurrentOpenTicket(onDone) {
    if (isDisabledInThisTab) return;
    const badge = document.getElementById('lc-scanner-status');

    if (isConversationBlockedByHSM()) {
      badge.innerText = `⛔ Conversación bloqueada por HSM. Saltando...`;
      onDone();
      return;
    }

    const detected = scanScreenForSubmotivo();
    const imageStats = await analyzeAllTicketImages();
    updateDetectedPreview(detected, imageStats);

    if (doesCurrentChatAlreadyHaveSecondQuestion()) {
      if (detected) markTicketAsAnswered(detected.sot, detected.ticketNum, detected.signature);
      badge.innerText = `✅ Ya respondido completo en chat. Saltando...`;
      onDone();
      return;
    }

    if (!detected) {
      badge.innerText = `🔍 Sin plantilla de técnico en este chat. Saltando...`;
      onDone();
      return;
    }

    const storageCheck = wasTicketAlreadyAnsweredInStorage(detected.sot, detected.ticketNum, detected.signature);
    if (storageCheck.answered) {
      badge.innerText = `🛡️ Anti-duplicado: ${storageCheck.reason} Saltando...`;
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
          safeSendTwoStepSmartReply(detected.rule, detected, true, () => onDone());
        } : null,
        () => {
          skippedTickets.add(detected.signature);
          onDone();
        }
      );
      return;
    }

    const secondMsg = resolveSecondMessage(detected.rule, imageStats);
    badge.innerText = `🎯 SOT ${detected.sot || ''} ➔ Enviando "${secondMsg}"...`;
    safeSendTwoStepSmartReply(detected.rule, detected, true, () => onDone());
  }

  function updateDetectedPreview(detected, imageStats = null) {
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
      const secondMsg = resolveSecondMessage(detected.rule, imageStats);

      let imgSummaryHtml = '';
      if (detected.rule.supportsAppScreenshotCheck && imageStats) {
        if (imageStats.hasAppScreenshot) {
          imgSummaryHtml = `<div style="margin-top:4px; color:#047857; font-size:11px;">📱 <b>Captura de App (TOA) detectada</b>${imageStats.equipmentPhotos > 0 ? ` (${imageStats.equipmentPhotos} foto de equipo ignorada)` : ''} ➔ Dirá <b>"un momento"</b></div>`;
        } else if (imageStats.equipmentPhotos > 0) {
          imgSummaryHtml = `<div style="margin-top:4px; color:#b45309; font-size:11px;">📷 Solo foto de equipo (${imageStats.equipmentPhotos}) sin captura TOA ➔ Pedirá captura</div>`;
        } else {
          imgSummaryHtml = `<div style="margin-top:4px; color:#64748b; font-size:11px;">🖼️ Sin captura de App TOA ➔ Pedirá captura</div>`;
        }
      }

      previewEl.innerHTML = `
        <div class="lc-detected-box found">
          <div>🎯 Leído: <b>Submotivo: ${detected.rawSubmotivo}</b>${sotBadge}</div>
          ${imgSummaryHtml}
          <button id="lc-quick-send-detected" class="lc-quick-send-btn">
            🚀 Enviar: 1° Saludo ➔ 2° "${secondMsg}"
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
          🔍 Abre un chat para analizar <code>Submotivo:</code> e imágenes TOA
        </div>
      `;
    }
  }

  function startManualTicketMonitor() {
    if (manualObserver) manualObserver.disconnect();
    if (isDisabledInThisTab) return;

    let debounceTimer = null;
    manualObserver = new MutationObserver(() => {
      if (isScanningQueue || isSendingLock || isDisabledInThisTab) return;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        if (isDisabledInThisTab) return;
        const detected = scanScreenForSubmotivo();
        const imageStats = await analyzeAllTicketImages();
        updateDetectedPreview(detected, imageStats);
      }, 600);
    });
    manualObserver.observe(document.body, { childList: true, subtree: true });
  }

  // ==========================================
  // ACTIVAR / DESACTIVAR EN ESTA PESTAÑA
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
      showToast("🔌 Copiloto desactivado en esta pestaña", "warning");
    } else {
      if (miniPill) miniPill.style.display = 'none';
      if (mainWidget) mainWidget.style.display = 'block';
      startManualTicketMonitor();
      showToast("⚡ Copiloto activado en esta pestaña", "success");
    }
  }

  // Hacer que el widget se pueda arrastrar desde el encabezado
  function makeWidgetDraggable(widgetEl, handleEl) {
    let isDragging = false;
    let startX = 0, startY = 0, initialLeft = 0, initialTop = 0;

    handleEl.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      isDragging = true;
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
      const newLeft = Math.max(0, Math.min(window.innerWidth - 120, initialLeft + dx));
      const newTop = Math.max(0, Math.min(window.innerHeight - 50, initialTop + dy));
      widgetEl.style.left = `${newLeft}px`;
      widgetEl.style.top = `${newTop}px`;
    });

    document.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        widgetEl.style.transition = 'all 0.2s ease-in-out';
      }
    });
  }

  // ==========================================
  // INTERFAZ DE USUARIO (WIDGET + PASTILLA DE PESTAÑA APAGADA)
  // ==========================================
  function initUI() {
    if (document.getElementById('laraigo-copilot-container')) return;

    // 1. Crear pastilla discreta cuando está desactivado en esta pestaña
    const disabledPill = document.createElement('button');
    disabledPill.id = 'laraigo-disabled-pill';
    disabledPill.className = 'laraigo-disabled-pill';
    disabledPill.title = 'Haz clic para volver a encender el Copiloto en esta pestaña';
    disabledPill.innerHTML = `🔌 Copiloto OFF aquí`;
    disabledPill.style.display = isDisabledInThisTab ? 'flex' : 'none';
    disabledPill.addEventListener('click', () => setTabDisabledState(false));
    document.body.appendChild(disabledPill);

    // 2. Crear contenedor principal del widget
    const container = document.createElement('div');
    container.id = 'laraigo-copilot-container';
    container.className = 'laraigo-copilot-widget';
    container.style.display = isDisabledInThisTab ? 'none' : 'block';

    container.innerHTML = `
      <div class="lc-header" id="lc-drag-handle" title="Arrastra desde aquí para mover el panel">
        <div class="lc-title">
          <span class="lc-badge">CLARO</span> Copiloto TOA
        </div>
        <div class="lc-actions">
          <button id="lc-btn-disable-tab" class="lc-btn-disable-tab" title="Apagar el Copiloto solo en esta pestaña/ventana">
            🔌 Apagar aquí
          </button>
          <button id="lc-btn-collapse" class="lc-btn-icon" title="Minimizar / Maximizar">_</button>
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

        <!-- Detector en tiempo real del mensaje e imágenes abiertas -->
        <div id="lc-live-detected">
          <div class="lc-detected-box waiting">
            🔍 Abre un chat para analizar <code>Submotivo:</code> e imágenes TOA
          </div>
        </div>

        <!-- Control de Auto-Escaneo de Bandeja -->
        <div class="lc-scanner-panel">
          <button id="lc-btn-scanner" class="lc-btn-scanner">
            ▶️ Auto-Escanear Tickets Pendientes
          </button>
          <div id="lc-scanner-status" class="lc-scanner-status">
            Ignora fotos de equipos. Si hay captura de App TOA, manda "un momento"
          </div>
        </div>

        <div class="lc-section-title">⚡ Submotivos Manuales (1° Saludo + 2° Auto/Pregunta)</div>
        <div class="lc-submotivos-grid" id="lc-submotivos-list"></div>
      </div>
    `;

    document.body.appendChild(container);

    const collapseBtn = container.querySelector('#lc-btn-collapse');
    const disableTabBtn = container.querySelector('#lc-btn-disable-tab');
    const bodyEl = container.querySelector('#lc-body');
    const scannerBtn = container.querySelector('#lc-btn-scanner');
    const dragHandle = container.querySelector('#lc-drag-handle');

    collapseBtn.addEventListener('click', () => {
      bodyEl.classList.toggle('lc-collapsed');
      collapseBtn.innerText = bodyEl.classList.contains('lc-collapsed') ? '□' : '_';
    });

    disableTabBtn.addEventListener('click', () => {
      setTabDisabledState(true);
    });

    scannerBtn.addEventListener('click', toggleScanner);

    makeWidgetDraggable(container, dragHandle);
    renderSubmotivoButtons();

    if (!isDisabledInThisTab) {
      startManualTicketMonitor();
    }
  }

  function renderSubmotivoButtons() {
    const list = document.getElementById('lc-submotivos-list');
    if (!list) return;
    list.innerHTML = '';

    SUBMOTIVO_MAP.forEach((item) => {
      const btn = document.createElement('button');
      btn.className = 'lc-submotivo-btn';
      btn.dataset.id = item.id;
      const note = item.supportsAppScreenshotCheck ? ' (o "un momento" si hay captura TOA)' : '';
      btn.title = `1° ${BASE_GREETING}\n2° ${item.question}${note}`;

      btn.innerHTML = `
        <div class="lc-btn-top">
          <b>${item.name}</b>
        </div>
        <div class="lc-btn-preview">2° "${item.question}"${item.supportsAppScreenshotCheck ? ' / "un momento"' : ''}</div>
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
