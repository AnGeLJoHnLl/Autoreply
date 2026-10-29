// Laraigo Auto-Reply Copilot - Especial Soporte Técnico Claro
// 1° Envía siempre el Saludo: "Hola Técnico, Procederemos con la atención"
// 2° Analiza el ticket completo (Submotivo + Imágenes):
//    - Ignora fotos de equipos (cajas ZTE, routers, códigos de barra)
//    - Si detecta captura de pantalla de app de celular (TOA) en Activaciones o Reenvío ➔ envía "un momento"
//    - Si NO hay captura de app de celular ➔ envía "enviar error de toa" / "enviar captura de reenvio desde su toa"
(function () {
  'use strict';

  const BASE_GREETING = "Hola Técnico, Procederemos con la atención";

  // Mapeo oficial de Submotivos (se evalúa SOLO sobre el valor de "Submotivo:")
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

  // Caché de análisis de imágenes por URL para no recalcular la misma foto
  const imageClassificationCache = new Map();

  // ==============================================================
  // ANALIZADOR VISUAL DE IMÁGENES DEL TICKET:
  // Distingue "Foto de Equipo (ZTE/Router/Caja)" vs "Captura de App Celular (TOA)"
  // ==============================================================
  function getChatAttachmentImages() {
    const widget = document.getElementById('laraigo-copilot-container');
    const allImgs = Array.from(document.querySelectorAll('img'));

    return allImgs.filter(img => {
      if (widget && widget.contains(img)) return false;
      if (img.offsetParent === null) return false;
      const rect = img.getBoundingClientRect();
      // Ignorar íconos pequeños, avatares de bot/agente o emojis (< 100px)
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

        // Píxeles neutros de interfaz (blanco/gris claro de TOA o modal de error)
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

    // Una captura de pantalla de app móvil (TOA) tiene alta uniformidad digital (flatStrictRatio >= 0.55)
    // y alto porcentaje de fondos neutros de interfaz (uiBgRatio >= 0.25 o >= 0.45).
    // Una foto de cámara de un equipo/caja ZTE tiene ruido de sensor y sombras (uiBgRatio ~ 0.04, flatStrictRatio ~ 0.38).
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

      // Intentar análisis directo en canvas
      try {
        if (imgEl.complete && imgEl.naturalWidth > 0) {
          const res = analyzePixelsFromImageSource(imgEl);
          imageClassificationCache.set(src, res);
          resolve(res);
          return;
        }
      } catch (corsErr) {
        // Si el servidor de imágenes de Laraigo tiene CORS, pedir el base64 al background worker
      }

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
            // Fallback por proporción de pantalla de celular si no se pudo leer por red
            const w = imgEl.naturalWidth || imgEl.clientWidth || 1;
            const h = imgEl.naturalHeight || imgEl.clientHeight || 1;
            const isVerticalPhoneScreen = (h / w) >= 1.55;
            const fallbackRes = { type: isVerticalPhoneScreen ? 'app_screenshot' : 'equipment_photo' };
            resolve(fallbackRes);
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

  // Determina cuál debe ser el 2° mensaje según el Submotivo y las imágenes presentes en el ticket
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
      showToast("⚠️ No se encontró la caja de chat", "warning");
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
  // 1° Envía SÍ O SÍ "Hola Técnico, Procederemos con la atención"
  // 2° Analiza imágenes del ticket (ignora fotos de equipo, detecta app celular) y envía el 2° mensaje
  // ==============================================================
  async function safeSendTwoStepSmartReply(ruleOrQuestion, detectedContext = null, force = false, onComplete = null) {
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

    if (!force) {
      if (doesCurrentChatAlreadyHaveResponse()) {
        askAgentConfirmation(
          `⚠️ Este chat ya tiene respuesta enviada en pantalla. ¿Seguro que deseas volver a enviar?`,
          () => safeSendTwoStepSmartReply(ruleOrQuestion, detected, true, onComplete)
        );
        return false;
      }

      const storageCheck = wasTicketAlreadyAnsweredInStorage(sot, sig);
      if (storageCheck.answered) {
        askAgentConfirmation(
          `⚠️ Filtro Anti-Duplicado: ${storageCheck.reason} ¿Deseas enviarlo de todas formas?`,
          () => safeSendTwoStepSmartReply(ruleOrQuestion, detected, true, onComplete)
        );
        return false;
      }
    }

    isSendingLock = true;
    markTicketAsAnswered(sot, sig);

    showToast(`1/2 Enviando saludo inicial...`, "info");

    // PASO 1: Enviar SÍ O SÍ el saludo primero
    pasteAndSendSingleMessage(BASE_GREETING, async (step1Ok) => {
      if (!step1Ok) {
        isSendingLock = false;
        if (onComplete) onComplete(false);
        return;
      }

      // Mientras espera para mandar el 2° mensaje, analizar todas las imágenes del ticket
      const imageStats = await analyzeAllTicketImages();

      let secondMessageText = typeof ruleOrQuestion === 'string'
        ? ruleOrQuestion
        : resolveSecondMessage(ruleOrQuestion, imageStats);

      setTimeout(() => {
        if (imageStats.hasAppScreenshot && typeof ruleOrQuestion === 'object' && ruleOrQuestion.supportsAppScreenshotCheck) {
          showToast(`📱 Captura TOA detectada ➔ Enviando: "un momento"`, "info");
        } else {
          showToast(`2/2 Enviando: "${secondMessageText}"`, "info");
        }

        // PASO 2: Enviar "un momento" (si ya mandó captura de app) o la solicitud del submotivo
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
  // MOTOR DE AUTO-ESCANEO CON ANÁLISIS DE IMÁGENES
  // ==========================================
  function toggleScanner() {
    isScanningQueue = !isScanningQueue;
    isPausedForQuestion = false;
    const btn = document.getElementById('lc-btn-scanner');
    const badge = document.getElementById('lc-scanner-status');

    if (isScanningQueue) {
      btn.classList.add('active');
      btn.innerText = "⏹️ Detener Escaneo de Bandeja";
      badge.innerText = "Escaneando Submotivos e Imágenes TOA...";
      showToast("🔍 Escaneo inteligente iniciado", "info");
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
    }, 1700);
  }

  async function processCurrentOpenTicket(onDone) {
    const badge = document.getElementById('lc-scanner-status');
    const detected = scanScreenForSubmotivo();
    const imageStats = await analyzeAllTicketImages();
    updateDetectedPreview(detected, imageStats);

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
    badge.innerText = `🎯 SOT ${detected.sot || ''} ➔ 1° Saludo + 2° "${secondMsg}"`;
    safeSendTwoStepSmartReply(detected.rule, detected, true, () => onDone());
  }

  function updateDetectedPreview(detected, imageStats = null) {
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
    let debounceTimer = null;
    const observer = new MutationObserver(() => {
      if (isScanningQueue || isSendingLock) return;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        const detected = scanScreenForSubmotivo();
        const imageStats = await analyzeAllTicketImages();
        updateDetectedPreview(detected, imageStats);
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
          <span class="lc-badge">CLARO SOPORTE</span> Detector TOA + 2 Pasos
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
            Ignora fotos de equipos. Si ya hay captura de App TOA, manda "un momento"
          </div>
        </div>

        <div class="lc-section-title">⚡ Submotivos Manuales (1° Saludo + 2° Auto/Pregunta)</div>
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
