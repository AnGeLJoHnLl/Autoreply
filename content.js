// Laraigo Auto-Reply Copilot - Especial Soporte Técnico Claro (Versión Auditada v1.4)
// Mejoras clave de fiabilidad de envío:
//   1. Espera inteligente de carga del chat (waitForTicketContentToLoad + waitForChatInput) tras abrir un ticket
//   2. Envío verificado con reintentos automáticos (pasteAndSendWithRetry): comprueba que la caja de texto quede vacía;
//      si el texto sigue en la caja, reintenta hasta 4 veces combinando Enter, eventos Angular/React y clic en el botón Enviar
//   3. Saludo inmediato (0s) ➔ Espera de 5s para recibir fotos/cintillos/textos ➔ 2° Respuesta inteligente

(function () {
  'use strict';

  const BASE_GREETING = "Hola Técnico, Procederemos con la atención";
  const SECOND_MESSAGE_DELAY_MS = 5000; // 5 segundos de espera antes del 2° mensaje

  const SUBMOTIVO_MAP = [
    {
      id: "reenvio",
      name: "Reenvío de señal",
      keywords: ["reenvio"],
      defaultQuestion: "enviar captura de reenvio desde su toa"
    },
    {
      id: "cintillos",
      name: "Consulta de Cintillos",
      keywords: ["cintillo", "fat", "tap"],
      defaultQuestion: "Enviar captura de imagen de Fat/Tap y cintillos"
    },
    {
      id: "mesh",
      name: "Registro de Mesh",
      keywords: ["mesh", "repetidor"],
      defaultQuestion: "Enviar imagen del repetidor"
    },
    {
      id: "manto",
      name: "SOT de Manto",
      keywords: ["manto", "mantenimiento"],
      defaultQuestion: "Enviar motivo de sot de manto"
    },
    {
      id: "pext",
      name: "Derivación a PEXT",
      keywords: ["pext", "derivacion", "planta externa"],
      defaultQuestion: "Enviar evidencias porfavor"
    },
    {
      id: "activaciones",
      name: "Activaciones",
      keywords: ["activacion", "activar"],
      defaultQuestion: "enviar error de toa"
    }
  ];

  function normalizeText(str) {
    return (str || '')
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim();
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ==============================================================
  // ESTADO INDEPENDIENTE POR PESTAÑA
  // ==============================================================
  let isDisabledInThisTab = sessionStorage.getItem('laraigo_copilot_tab_disabled') === 'true';
  let manualObserver = null;
  let inboxArrivalObserver = null;

  // ==============================================================
  // FILTRO ANTI-DUPLICADOS SINCRONIZADO ENTRE PESTAÑAS
  // ==============================================================
  let answeredRegistry = {};
  let skippedTickets = new Set();
  let isSendingLock = false;
  let isStepInProgress = false;

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
  // DELIMITADOR GEOMÉTRICO DEL PANEL IZQUIERDO ("Asignados") Y CHAT CENTRAL
  // ==============================================================
  function isElementInOurOverlay(el) {
    if (!el) return false;
    const widget = document.getElementById('laraigo-copilot-container');
    const pill = document.getElementById('laraigo-disabled-pill');
    const toast = document.getElementById('lc-toast');
    if (widget && widget.contains(el)) return true;
    if (pill && pill.contains(el)) return true;
    if (toast && toast.contains(el)) return true;
    return false;
  }

  function getAsignadosColumnInfo() {
    const allEls = Array.from(document.querySelectorAll('div, span, a, button, li'));
    let asignadosEl = null;
    let assignedCount = 0;

    for (const el of allEls) {
      if (isElementInOurOverlay(el)) continue;
      if (el.offsetParent === null) continue;
      const txt = (el.innerText || '').trim();
      const match = txt.match(/^Asignados\s*\((\d+)\)$/i);
      if (match) {
        asignadosEl = el;
        assignedCount = parseInt(match[1], 10);
        break;
      }
    }

    if (!asignadosEl) {
      return null;
    }

    const tabRect = asignadosEl.getBoundingClientRect();

    let tabBar = asignadosEl.parentElement;
    let colLeft = Math.max(30, tabRect.left - 15);
    let colRight = Math.max(tabRect.right + 140, 240);
    let tabBarBottom = tabRect.bottom;

    for (let i = 0; i < 6; i++) {
      if (!tabBar || tabBar === document.body) break;
      const r = tabBar.getBoundingClientRect();
      const t = (tabBar.innerText || '');
      if (t.includes('Pausados') && r.width >= 140 && r.width <= 450) {
        colLeft = r.left;
        colRight = r.right;
        if (r.height < 80) {
          tabBarBottom = r.bottom;
        }
        break;
      }
      tabBar = tabBar.parentElement;
    }

    let leftColumnContainer = asignadosEl.parentElement;
    for (let i = 0; i < 7; i++) {
      if (!leftColumnContainer || leftColumnContainer === document.body) break;
      const r = leftColumnContainer.getBoundingClientRect();
      if (r.height > 260 && r.width >= 140 && r.width <= 460) {
        colLeft = r.left;
        colRight = r.right;
        break;
      }
      leftColumnContainer = leftColumnContainer.parentElement;
    }

    return {
      asignadosEl,
      assignedCount,
      colLeft,
      colRight,
      tabBarBottom,
      leftColumnContainer: leftColumnContainer || document.body
    };
  }

  function getChatColumnBounds() {
    let minLeft = 140;
    let maxRight = window.innerWidth;

    const asigInfo = getAsignadosColumnInfo();
    if (asigInfo) {
      minLeft = Math.max(120, asigInfo.colRight - 5);
    }

    const allEls = Array.from(document.querySelectorAll('div, span, a, button'));
    for (const el of allEls) {
      if (isElementInOurOverlay(el)) continue;
      const txt = (el.innerText || '').trim();
      if (txt === 'Vincular' || txt === 'Información' || txt === 'Variables') {
        const r = el.getBoundingClientRect();
        if (r.left > window.innerWidth * 0.45) {
          let panel = el.parentElement;
          for (let i = 0; i < 6; i++) {
            if (!panel || panel === document.body) break;
            const pr = panel.getBoundingClientRect();
            if (pr.height > 250 && pr.left > minLeft + 150) {
              maxRight = Math.min(maxRight, pr.left + 10);
              break;
            }
            panel = panel.parentElement;
          }
        }
      }
    }

    return { minLeft, maxRight };
  }

  function findChatMessagesScrollContainer() {
    const { minLeft, maxRight } = getChatColumnBounds();
    const allDivs = Array.from(document.querySelectorAll('div'));

    let bestCandidate = null;
    let maxScore = 0;

    for (const div of allDivs) {
      if (isElementInOurOverlay(div)) continue;
      if (div.offsetParent === null) continue;

      const rect = div.getBoundingClientRect();
      if (rect.left < minLeft - 30 || rect.right > maxRight + 40) continue;
      if (div.clientHeight < 140 || div.clientWidth < 160) continue;

      const style = window.getComputedStyle(div);
      const overflowY = style.overflowY;
      const isScrollable = (overflowY === 'auto' || overflowY === 'scroll');

      const text = (div.innerText || '').toLowerCase();
      const hasChatIndicators =
        text.includes('mensaje entregado') ||
        text.includes('submotivo:') ||
        text.includes('hola, soy el') ||
        text.includes('hola técnico') ||
        text.includes('asignado a holding') ||
        div.querySelectorAll('img, video').length > 0;

      if (hasChatIndicators && isScrollable) {
        const score = div.clientHeight * (div.scrollHeight > div.clientHeight ? 3 : 1);
        if (score > maxScore) {
          maxScore = score;
          bestCandidate = div;
        }
      }
    }

    return bestCandidate;
  }

  async function scrollChatAndCollectFullData() {
    const scrollContainer = findChatMessagesScrollContainer();
    let collectedText = '';

    if (scrollContainer) {
      if (scrollContainer.scrollHeight > scrollContainer.clientHeight + 20) {
        scrollContainer.scrollTop = 0;
        await sleep(320);
        collectedText += '\n' + (scrollContainer.innerText || '');

        scrollContainer.scrollTop = Math.floor(scrollContainer.scrollHeight / 2);
        await sleep(220);
        collectedText += '\n' + (scrollContainer.innerText || '');

        scrollContainer.scrollTop = scrollContainer.scrollHeight;
        await sleep(320);
      }
      collectedText += '\n' + (scrollContainer.innerText || '');
    }

    const detected = scanScreenForSubmotivo(collectedText);
    const contextStats = await analyzeFullTicketContext(detected, collectedText);

    return { detected, contextStats };
  }

  // Esperar hasta 3.5 segundos a que carguen los mensajes y la caja de texto cuando recién se abre un ticket
  async function waitForTicketContentToLoad(maxWaitMs = 3500) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      if (isConversationBlockedByHSM()) return true;
      const hasSubmotivo = !!scanScreenForSubmotivo();
      const hasInput = !!findChatInput();
      if (hasSubmotivo && hasInput) return true;
      await sleep(250);
    }
    return false;
  }

  // ==============================================================
  // ANALIZADOR DE IMÁGENES, VIDEOS, NÚMEROS DE CINTILLOS Y TEXTO
  // ==============================================================
  function getChatAttachmentImages() {
    const { minLeft, maxRight } = getChatColumnBounds();
    const allImgs = Array.from(document.querySelectorAll('img'));

    return allImgs.filter(img => {
      if (isElementInOurOverlay(img)) return false;
      if (img.offsetParent === null) return false;
      const rect = img.getBoundingClientRect();
      if (rect.left < minLeft - 20 || rect.left > maxRight - 30) return false;
      if (rect.width < 95 || rect.height < 95) return false;
      const src = (img.src || '').toLowerCase();
      if (!src || src.includes('avatar') || src.includes('emoji') || src.includes('logo') || src.includes('profile')) return false;
      return true;
    });
  }

  async function waitForChatImagesToLoad(imgs, maxWaitMs = 1500) {
    const pending = imgs.filter(img => !img.complete || img.naturalWidth === 0);
    if (pending.length === 0) return;

    await Promise.race([
      Promise.all(
        pending.map(img => new Promise(res => {
          img.addEventListener('load', res, { once: true });
          img.addEventListener('error', res, { once: true });
        }))
      ),
      sleep(maxWaitMs)
    ]);
  }

  function hasVideoInChat() {
    const { minLeft, maxRight } = getChatColumnBounds();
    const videos = Array.from(
      document.querySelectorAll('video, a[href*=".mp4"], a[href*=".mov"], a[href*=".3gp"], [class*="video-player"], [class*="video_message"]')
    ).filter(el => {
      if (isElementInOurOverlay(el)) return false;
      if (el.offsetParent === null) return false;
      const r = el.getBoundingClientRect();
      return r.left >= minLeft - 20 && r.left <= maxRight;
    });
    return videos.length > 0;
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

  function getCentralChatOnlyText(extraCollectedText = '') {
    const scrollContainer = findChatMessagesScrollContainer();
    if (scrollContainer) {
      return (extraCollectedText || '') + '\n' + (scrollContainer.innerText || '');
    }

    const { minLeft, maxRight } = getChatColumnBounds();
    const nodes = Array.from(document.querySelectorAll('div, p, span'));
    let chatText = extraCollectedText || '';

    for (const node of nodes) {
      if (isElementInOurOverlay(node)) continue;
      if (node.offsetParent === null) continue;
      if (node.children.length > 4) continue;
      const r = node.getBoundingClientRect();
      if (r.left >= minLeft && r.right <= maxRight && r.top > 95 && r.bottom < window.innerHeight - 40) {
        const t = (node.innerText || '').trim();
        if (t) chatText += '\n' + t;
      }
    }

    return chatText;
  }

  function analyzeTechnicianExtraText(detected, extraCollectedText = '') {
    const rawChatText = getCentralChatOnlyText(extraCollectedText);

    let cleaned = rawChatText
      .replace(/Hola,\s*soy\s*el\s*t[eé]cnico[\s\S]*?Submotivo\s*:\s*[^\r\n]+/gi, ' ')
      .replace(/Te estamos contactando con un asesor especializado[^\r\n]*/gi, ' ')
      .replace(/ASIGNADO A HOLDING[^\r\n]*/gi, ' ')
      .replace(/REASIGNADO DE HOLDING[^\r\n]*/gi, ' ')
      .replace(/MENSAJE ENTREGADO[^\r\n]*/gi, ' ')
      .replace(/Esta conversaci[oó]n se encuentra bloqueada[^\r\n]*/gi, ' ')
      .replace(/Ticket\s*:\s*\d+/gi, ' ')
      .replace(/Hola T[eé]cnico,\s*Procederemos con la atenci[oó]n\.?/gi, ' ')
      .replace(/enviar error de toa/gi, ' ')
      .replace(/enviar captura de reenvio desde su toa/gi, ' ')
      .replace(/enviar captura de imagen de fat\/tap y cintillos/gi, ' ')
      .replace(/enviar captura de imagen de fat\/tap/gi, ' ')
      .replace(/enviar cintillos/gi, ' ')
      .replace(/enviar imagen del repetidor/gi, ' ')
      .replace(/enviar motivo de sot de manto/gi, ' ')
      .replace(/enviar evidencias porfavor/gi, ' ')
      .replace(/un momento/gi, ' ')
      .replace(/se revisa/gi, ' ')
      .replace(/\b\d{1,2}:\d{2}\b/g, ' ');

    const sotStr = detected?.sot ? String(detected.sot) : '';
    const ticketStr = detected?.ticketNum ? String(detected.ticketNum) : '';

    const numberMatches = cleaned.match(/\b\d{6,9}\b/g) || [];
    const uniqueCintillos = new Set(
      numberMatches.filter(num => {
        if (num === sotStr || num === ticketStr) return false;
        if (num.length === 9 && num.startsWith('9')) return false;
        return true;
      })
    );

    const hasCintillosNumbers = uniqueCintillos.size >= 1;

    const textWithoutNumbers = cleaned
      .replace(/\b\d+\b/g, ' ')
      .replace(/\b(hola|buenas|tardes|dias|noches|buen|dia|por|favor|apoyo|gracias|estimado|asesor|con|la|el|de|en|su|para|activacion|consulta|cintillos|reenvio|mesh|manto|pext|text)\b/gi, ' ')
      .replace(/[^\wáéíóúñÁÉÍÓÚÑ]+/g, ' ')
      .trim();

    const hasExplanationText = textWithoutNumbers.length >= 8;

    return {
      hasCintillosNumbers,
      cintilloCount: uniqueCintillos.size,
      hasExplanationText
    };
  }

  async function analyzeFullTicketContext(detected, extraCollectedText = '') {
    const imgs = getChatAttachmentImages();
    await waitForChatImagesToLoad(imgs, 1500);

    let appScreenshots = 0;
    let equipmentPhotos = 0;

    for (const img of imgs) {
      const result = await classifySingleImageElement(img);
      if (result.type === 'app_screenshot') {
        appScreenshots++;
      } else {
        equipmentPhotos++;
      }
    }

    const hasVideo = hasVideoInChat();
    const extraTextStats = analyzeTechnicianExtraText(detected, extraCollectedText);

    return {
      totalImages: imgs.length,
      hasAnyImage: imgs.length > 0,
      appScreenshots,
      equipmentPhotos,
      hasAppScreenshot: appScreenshots > 0,
      hasVideo,
      hasCintillosNumbers: extraTextStats.hasCintillosNumbers,
      cintilloCount: extraTextStats.cintilloCount,
      hasExplanationText: extraTextStats.hasExplanationText
    };
  }

  // ==============================================================
  // REGLAS DE DECISIÓN DEL 2° MENSAJE SEGÚN SUBMOTIVO Y EVIDENCIAS
  // ==============================================================
  function resolveSecondMessage(rule, stats) {
    if (!rule) return null;
    if (!stats) return rule.defaultQuestion;

    switch (rule.id) {
      case "activaciones":
        return stats.hasAppScreenshot ? "un momento" : "enviar error de toa";

      case "reenvio":
        return stats.hasAppScreenshot ? "un momento" : "enviar captura de reenvio desde su toa";

      case "mesh":
        return stats.hasAnyImage ? "Un momento" : "Enviar imagen del repetidor";

      case "cintillos":
        if (stats.hasCintillosNumbers && !stats.hasAnyImage) {
          return "Enviar captura de imagen de Fat/Tap";
        }
        if (!stats.hasCintillosNumbers && stats.hasAnyImage) {
          return "Enviar cintillos";
        }
        if (stats.hasCintillosNumbers && stats.hasAnyImage) {
          return "Un momento";
        }
        return "Enviar captura de imagen de Fat/Tap y cintillos";

      case "manto":
        if (stats.hasVideo || stats.hasAnyImage || stats.hasExplanationText) {
          return "Se revisa";
        }
        return "Enviar motivo de sot de manto";

      case "pext":
        if (stats.hasAnyImage || stats.hasVideo) {
          return "Se revisa";
        }
        return "Enviar evidencias porfavor";

      default:
        return rule.defaultQuestion;
    }
  }

  function buildContextSummaryHtml(rule, stats) {
    if (!rule || !stats) return '';

    switch (rule.id) {
      case "activaciones":
      case "reenvio":
        if (stats.hasAppScreenshot) {
          return `<div class="lc-ctx-note ok">📱 Captura App TOA detectada${stats.equipmentPhotos > 0 ? ` (${stats.equipmentPhotos} foto de equipo ignorada)` : ''} ➔ <b>"un momento"</b></div>`;
        }
        if (stats.equipmentPhotos > 0) {
          return `<div class="lc-ctx-note warn">📷 Solo foto de equipo (${stats.equipmentPhotos}) sin captura App TOA ➔ Pedirá captura</div>`;
        }
        return `<div class="lc-ctx-note info">🖼️ Sin captura de App TOA ➔ Pedirá captura</div>`;

      case "mesh":
        if (stats.hasAnyImage) {
          return `<div class="lc-ctx-note ok">📷 Imagen de repetidor detectada (${stats.totalImages}) ➔ <b>"Un momento"</b></div>`;
        }
        return `<div class="lc-ctx-note info">🖼️ Sin imagen de repetidor ➔ <b>"Enviar imagen del repetidor"</b></div>`;

      case "cintillos":
        if (stats.hasCintillosNumbers && !stats.hasAnyImage) {
          return `<div class="lc-ctx-note warn">🔢 Cintillos detectados (${stats.cintilloCount} núm.) pero falta foto ➔ <b>"Enviar captura de imagen de Fat/Tap"</b></div>`;
        }
        if (!stats.hasCintillosNumbers && stats.hasAnyImage) {
          return `<div class="lc-ctx-note warn">📷 Foto detectada pero faltan números ➔ <b>"Enviar cintillos"</b></div>`;
        }
        if (stats.hasCintillosNumbers && stats.hasAnyImage) {
          return `<div class="lc-ctx-note ok">✅ Foto + Cintillos (${stats.cintilloCount}) completos ➔ <b>"Un momento"</b></div>`;
        }
        return `<div class="lc-ctx-note info">⚠️ Sin foto ni cintillos ➔ <b>"Enviar captura de imagen de Fat/Tap y cintillos"</b></div>`;

      case "manto":
        if (stats.hasVideo || stats.hasAnyImage || stats.hasExplanationText) {
          return `<div class="lc-ctx-note ok">✅ Evidencia/motivo detectado en chat ➔ <b>"Se revisa"</b></div>`;
        }
        return `<div class="lc-ctx-note info">⚠️ Sin video, imagen ni explicación ➔ <b>"Enviar motivo de sot de manto"</b></div>`;

      case "pext":
        if (stats.hasAnyImage || stats.hasVideo) {
          return `<div class="lc-ctx-note ok">📷 Imágenes de evidencia detectadas (${stats.totalImages}) ➔ <b>"Se revisa"</b></div>`;
        }
        return `<div class="lc-ctx-note info">⚠️ Sin imágenes de evidencia ➔ <b>"Enviar evidencias porfavor"</b></div>`;

      default:
        return '';
    }
  }

  // ==============================================================
  // LOCALIZAR CAJA DE TEXTO Y ENVIAR MENSAJE CON REINTENTOS VERIFICADOS
  // ==============================================================
  function isConversationBlockedByHSM() {
    const bodyText = normalizeText(document.body.innerText || '');
    return bodyText.includes("esta conversacion se encuentra bloqueada hasta que el cliente responda");
  }

  function isAnyTicketCurrentlyOpenInCenter() {
    if (getCurrentLaraigoTicketNumber()) return true;
    if (findChatInput()) return true;
    if (isConversationBlockedByHSM()) return true;
    return false;
  }

  function findChatInput() {
    const textareas = Array.from(document.querySelectorAll('textarea'));
    for (const ta of textareas) {
      if (isElementInOurOverlay(ta)) continue;
      if (ta.offsetParent !== null && !ta.disabled && !ta.readOnly) {
        return { element: ta, type: 'textarea' };
      }
    }

    const editables = Array.from(document.querySelectorAll('[contenteditable="true"]'));
    for (const ed of editables) {
      if (isElementInOurOverlay(ed)) continue;
      if (ed.offsetParent !== null) {
        return { element: ed, type: 'contenteditable' };
      }
    }

    const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'));
    for (const inp of inputs) {
      if (isElementInOurOverlay(inp)) continue;
      if (inp.offsetParent === null || inp.disabled || inp.readOnly) continue;
      const placeholder = (inp.placeholder || '').toLowerCase();
      if (
        placeholder.includes('mensaje') ||
        placeholder.includes('escribe') ||
        placeholder.includes('chat') ||
        placeholder.includes('responder') ||
        placeholder.includes('texto')
      ) {
        return { element: inp, type: 'input' };
      }
    }

    // Fallback: cualquier input de texto visible en la parte inferior central del chat
    const { minLeft, maxRight } = getChatColumnBounds();
    for (const inp of inputs) {
      if (isElementInOurOverlay(inp)) continue;
      if (inp.offsetParent === null || inp.disabled || inp.readOnly) continue;
      const r = inp.getBoundingClientRect();
      if (r.left >= minLeft - 20 && r.right <= maxRight + 20 && r.top > window.innerHeight * 0.65) {
        return { element: inp, type: 'input' };
      }
    }

    return null;
  }

  // Espera hasta 3 segundos a que la caja de texto esté lista y habilitada
  async function waitForChatInputReady(maxWaitMs = 3000) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      if (isConversationBlockedByHSM()) return null;
      const target = findChatInput();
      if (target && target.element) return target;
      await sleep(150);
    }
    return findChatInput();
  }

  function findSendButtonNearInput(inputElement) {
    if (!inputElement) return null;

    let footerContainer = inputElement.parentElement;
    for (let level = 0; level < 5; level++) {
      if (!footerContainer || footerContainer === document.body) break;
      const candidates = Array.from(
        footerContainer.querySelectorAll('button, [role="button"], a, i[class*="send"], i[class*="paper-plane"], span[class*="send"], mat-icon, svg')
      ).filter(el => {
        if (isElementInOurOverlay(el)) return false;
        if (el.offsetParent === null || el.disabled) return false;
        return true;
      });

      for (const el of candidates) {
        const clickable = el.closest('button, [role="button"], a') || el;
        if (clickable.disabled) continue;
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

      const buttonsInRow = Array.from(footerContainer.querySelectorAll('button, [role="button"], a')).filter(
        b => !isElementInOurOverlay(b) && b.offsetParent !== null && !b.disabled
      );
      if (buttonsInRow.length > 0) {
        const inputRect = inputElement.getBoundingClientRect();
        const rightButtons = buttonsInRow.filter(b => {
          const rect = b.getBoundingClientRect();
          return rect.left >= inputRect.right - 70 && Math.abs(rect.top - inputRect.top) < 110;
        });
        if (rightButtons.length > 0) {
          return rightButtons[rightButtons.length - 1];
        }
      }

      footerContainer = footerContainer.parentElement;
    }

    return null;
  }

  // Escribir texto en la caja de Laraigo activando todos los listeners de Angular / React / Vue
  function setInputValue(target, text) {
    if (!target || !target.element) return false;
    const { element, type } = target;

    // 1. Hacer clic y enfocar la caja de texto primero
    simulateRealClick(element);
    element.focus();

    if (type === 'textarea' || type === 'input') {
      const proto = type === 'textarea' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const valueSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;

      if (valueSetter) {
        valueSetter.call(element, text);
      } else {
        element.value = text;
      }

      element.dispatchEvent(new Event('focus', { bubbles: true }));
      element.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
      element.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      // Disparar keyup de una letra normal para que Angular habilite el botón Enviar si depende de (keyup)
      element.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', code: 'KeyA', keyCode: 65, bubbles: true }));
    } else if (type === 'contenteditable') {
      element.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);
      element.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
      element.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', code: 'KeyA', keyCode: 65, bubbles: true }));
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
    const rect = el.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;

    const eventInit = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX,
      clientY,
      button: 0,
      buttons: 1
    };

    try {
      el.dispatchEvent(new PointerEvent('pointerdown', eventInit));
      el.dispatchEvent(new MouseEvent('mousedown', eventInit));
      el.dispatchEvent(new PointerEvent('pointerup', eventInit));
      el.dispatchEvent(new MouseEvent('mouseup', eventInit));
    } catch (e) {}
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

  // Pegar y enviar con verificación real de vaciado de la caja y hasta 4 reintentos automáticos
  async function pasteAndSendSingleMessage(text, callback) {
    const initialTarget = await waitForChatInputReady(2800);
    if (!initialTarget) {
      showToast("⚠️ No se encontró la caja de chat habilitada", "warning");
      if (callback) callback(false);
      return false;
    }

    for (let attempt = 1; attempt <= 4; attempt++) {
      const target = findChatInput() || initialTarget;
      if (!target || !target.element) break;

      // Si en el reintento la caja está vacía pero aún no habíamos pegado, o si quedó texto atascado, asegurar que tenga el texto
      const currentVal = getInputCurrentText(target);
      if (attempt === 1 || currentVal.length === 0) {
        setInputValue(target, text);
      } else {
        // El texto ya está pegado en la caja pero no salió; refrescar eventos para habilitar envío
        target.element.focus();
        target.element.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
        target.element.dispatchEvent(new Event('change', { bubbles: true }));
      }

      await sleep(160);

      // 1. Intentar envío por tecla Enter
      simulateEnterKey(target.element);
      await sleep(220);

      // Verificar si la caja ya se vació (mensaje enviado con éxito)
      if (getInputCurrentText(target).length === 0) {
        if (callback) callback(true);
        return true;
      }

      // 2. Si el texto sigue en la caja, buscar y hacer clic en el botón Enviar junto al input
      const sendBtn = findSendButtonNearInput(target.element);
      if (sendBtn) {
        simulateRealClick(sendBtn);
        await sleep(250);
        if (getInputCurrentText(target).length === 0) {
          if (callback) callback(true);
          return true;
        }
      }

      // 3. En intentos >= 2, probar clic por coordenadas a la derecha de la caja de texto (donde suele estar el ícono de avión de papel)
      if (attempt >= 2) {
        const rect = target.element.getBoundingClientRect();
        const centerY = rect.top + rect.height / 2;
        for (const offsetX of [28, 48, 70]) {
          const probeX = rect.right + offsetX;
          if (probeX < window.innerWidth - 10) {
            const rightEl = document.elementFromPoint(probeX, centerY);
            if (rightEl && !isElementInOurOverlay(rightEl) && rightEl !== target.element) {
              const clickableRight = rightEl.closest('button, [role="button"], a') || rightEl;
              simulateRealClick(clickableRight);
              await sleep(200);
              if (getInputCurrentText(target).length === 0) {
                if (callback) callback(true);
                return true;
              }
            }
          }
        }
      }

      await sleep(200);
    }

    // Comprobación final
    const finalTarget = findChatInput() || initialTarget;
    const sentOk = finalTarget ? getInputCurrentText(finalTarget).length === 0 : false;
    if (callback) callback(sentOk);
    return sentOk;
  }

  // ==============================================================
  // ENVÍO INTELIGENTE EN 2 PASOS:
  // 1° INMEDIATO (0s): Manda SÍ O SÍ "Hola Técnico, Procederemos con la atención"
  // 2° ESPERA 5 SEGUNDOS: Da tiempo a que lleguen las fotos/cintillos/mensajes del técnico
  // 3° RE-ANALIZA EL CHAT COMPLETO y envía la 2° respuesta exacta
  // ==============================================================
  async function safeSendTwoStepSmartReply(ruleOrQuestion, detectedContext = null, force = false, onComplete = null) {
    if (isDisabledInThisTab) return false;

    if (isSendingLock) {
      showToast("⏳ Envío o espera de 5s en curso...", "warning");
      if (onComplete) onComplete(false);
      return false;
    }

    if (isConversationBlockedByHSM()) {
      showToast("⛔ Conversación bloqueada por HSM", "warning");
      if (onComplete) onComplete(false);
      return false;
    }

    const target = await waitForChatInputReady(2500);
    if (!target) {
      showToast("⚠️ Abre un chat habilitado primero", "warning");
      if (onComplete) onComplete(false);
      return false;
    }

    const initialDetected = detectedContext || scanScreenForSubmotivo();
    const initialSot = initialDetected?.sot || null;
    const initialTicketNum = initialDetected?.ticketNum || getCurrentLaraigoTicketNumber();
    const initialSig = initialDetected?.signature || null;

    if (!force) {
      if (doesCurrentChatAlreadyHaveSecondQuestion()) {
        askAgentConfirmation(
          `⚠️ Este chat ya tiene la respuesta enviada en pantalla. ¿Seguro que deseas volver a enviar?`,
          () => safeSendTwoStepSmartReply(ruleOrQuestion, initialDetected, true, onComplete)
        );
        return false;
      }

      const storageCheck = wasTicketAlreadyAnsweredInStorage(initialSot, initialTicketNum, initialSig);
      if (storageCheck.answered) {
        askAgentConfirmation(
          `⚠️ Filtro Anti-Duplicado: ${storageCheck.reason} ¿Deseas enviarlo de todas formas?`,
          () => safeSendTwoStepSmartReply(ruleOrQuestion, initialDetected, true, onComplete)
        );
        return false;
      }
    }

    isSendingLock = true;
    const badge = document.getElementById('lc-scanner-status');

    const greetingAlreadyPresent = doesCurrentChatAlreadyHaveGreeting();

    // PASO 1: Enviar el saludo DE INMEDIATO (0s)
    if (!greetingAlreadyPresent || force) {
      showToast(`⚡ 1/2 Enviando saludo inmediato...`, "info");
      if (badge) badge.innerText = `⚡ Enviando saludo inmediato...`;

      const step1Success = await pasteAndSendSingleMessage(BASE_GREETING);

      if (!step1Success) {
        showToast("⚠️ No se pudo confirmar el envío del saludo, reintentará...", "warning");
        isSendingLock = false;
        if (onComplete) onComplete(false);
        return false;
      }
    } else {
      showToast(`✅ Saludo ya en chat. Esperando 5s para evaluar 2° mensaje...`, "info");
    }

    // PASO 2: Esperar 5 segundos (con cuenta regresiva visual)
    const totalSeconds = Math.round(SECOND_MESSAGE_DELAY_MS / 1000);
    for (let remaining = totalSeconds; remaining >= 1; remaining--) {
      if (isDisabledInThisTab) {
        isSendingLock = false;
        if (onComplete) onComplete(false);
        return false;
      }
      if (badge) {
        badge.innerText = `⏳ Esperando ${remaining}s para recibir mensajes/fotos del técnico...`;
      }
      showToast(`⏳ Esperando mensajes del técnico (${remaining}s)...`, "info");

      if (remaining === 1) {
        await scrollChatAndCollectFullData();
      } else {
        await sleep(1000);
      }
    }

    const currentTicketAfterWait = getCurrentLaraigoTicketNumber();
    if (initialTicketNum && currentTicketAfterWait && initialTicketNum !== currentTicketAfterWait) {
      showToast("⚠️ Se cambió de chat durante la espera; cancelando 2° envío", "warning");
      isSendingLock = false;
      if (onComplete) onComplete(false);
      return false;
    }

    const freshDetected = scanScreenForSubmotivo() || initialDetected;
    const freshStats = await analyzeFullTicketContext(freshDetected);
    updateDetectedPreview(freshDetected, freshStats);

    const activeRule = typeof ruleOrQuestion === 'object' ? ruleOrQuestion : freshDetected?.rule;
    const secondMessageText = typeof ruleOrQuestion === 'string'
      ? ruleOrQuestion
      : resolveSecondMessage(activeRule, freshStats);

    if (!secondMessageText) {
      isSendingLock = false;
      if (onComplete) onComplete(false);
      return false;
    }

    const finalSot = freshDetected?.sot || initialSot;
    const finalTicket = freshDetected?.ticketNum || initialTicketNum;
    const finalSig = freshDetected?.signature || initialSig;

    if (badge) {
      badge.innerText = `🚀 2/2 Enviando: "${secondMessageText}"`;
    }
    showToast(`🚀 2/2 Enviando: "${secondMessageText}"`, "info");

    const step2Success = await pasteAndSendSingleMessage(secondMessageText);
    if (step2Success) {
      markTicketAsAnswered(finalSot, finalTicket, finalSig);
      showToast(`✅ Atención completada${finalSot ? ' (SOT ' + finalSot + ')' : ''}`, "success");
    } else {
      showToast(`⚠️ El 2° mensaje quedó en caja; verifica el envío`, "warning");
    }

    setTimeout(() => {
      isSendingLock = false;
      if (onComplete) onComplete(step2Success);
    }, 1200);

    return step2Success;
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

  function scanScreenForSubmotivo(extraCollectedText = '') {
    const { minLeft, maxRight } = getChatColumnBounds();
    const candidateNodes = document.querySelectorAll(
      '[class*="message"], [class*="bubble"], [class*="chat"], p, div, span'
    );

    let combinedChatText = extraCollectedText || '';
    for (const node of candidateNodes) {
      if (isElementInOurOverlay(node)) continue;
      if (node.offsetParent === null) continue;
      const r = node.getBoundingClientRect();
      if (r.left < minLeft - 30 || r.left > maxRight) continue;
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
  // COMPROBAR SI EL CHAT YA TIENE SALUDO O 2° RESPUESTA
  // ==========================================
  function getCentralChatBubbleNodes() {
    const { minLeft, maxRight } = getChatColumnBounds();
    const candidates = Array.from(document.querySelectorAll(
      '[class*="message"], [class*="bubble"], [class*="chat-item"], div[class*="msg"], p, span'
    ));

    return candidates.filter(el => {
      if (isElementInOurOverlay(el)) return false;
      if (el.offsetParent === null) return false;
      if (el.children.length > 5) return false;
      const r = el.getBoundingClientRect();
      return r.left >= minLeft - 20 && r.right <= maxRight + 20 && r.top > 90;
    });
  }

  function doesCurrentChatAlreadyHaveGreeting() {
    const bubbles = getCentralChatBubbleNodes();
    for (const msg of bubbles) {
      const text = normalizeText(msg.innerText || '');
      if (text.includes("hola tecnico, procederemos con la atencion")) {
        return true;
      }
    }
    return false;
  }

  function doesCurrentChatAlreadyHaveSecondQuestion() {
    const bubbles = getCentralChatBubbleNodes();

    const secondStepPhrases = [
      "enviar error de toa",
      "enviar captura de reenvio desde su toa",
      "enviar captura de imagen de fat/tap y cintillos",
      "enviar captura de imagen de fat/tap",
      "enviar cintillos",
      "enviar imagen del repetidor",
      "enviar motivo de sot de manto",
      "enviar evidencias porfavor",
      "enviar repetidor a activar",
      "cual es el motivo de la sot de manto",
      "enviar evidencias y motivo de la derivacion"
    ];

    let hasGreeting = false;
    let hasShortClosingReply = false;

    for (const msg of bubbles) {
      const text = normalizeText(msg.innerText || '');
      if (secondStepPhrases.some(phrase => text.includes(phrase))) {
        return true;
      }
      if (text.includes("hola tecnico, procederemos con la atencion")) {
        hasGreeting = true;
      }
      const textNoTime = text.replace(/\b\d{1,2}:\d{2}\b/g, '').trim();
      if (textNoTime === "un momento" || textNoTime === "se revisa") {
        hasShortClosingReply = true;
      }
    }

    return hasGreeting && hasShortClosingReply;
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

  // ==============================================================
  // DETECCIÓN Y APERTURA AUTOMÁTICA DE TICKETS EN "Asignados(N)"
  // ==============================================================
  function getInboxTicketElements() {
    const asigInfo = getAsignadosColumnInfo();

    if (asigInfo) {
      const { colLeft, colRight, tabBarBottom, leftColumnContainer } = asigInfo;

      const allLeftEls = Array.from(leftColumnContainer.querySelectorAll('div, li, a, mat-list-item')).filter(el => {
        if (isElementInOurOverlay(el)) return false;
        if (el.offsetParent === null) return false;
        const r = el.getBoundingClientRect();

        if (r.top < tabBarBottom - 3) return false;
        if (r.top > window.innerHeight - 35) return false;
        if (r.left < colLeft - 12 || r.left > colRight - 40) return false;
        if (r.right > colRight + 25) return false;

        if (r.width < 90) return false;
        if (r.height < 38 || r.height > 155) return false;

        const text = (el.innerText || '').trim();
        if (text.length < 2 || text.length > 350) return false;

        return true;
      });

      if (allLeftEls.length > 0) {
        const pointerEls = allLeftEls.filter(el => {
          try {
            return window.getComputedStyle(el).cursor === 'pointer';
          } catch (e) {
            return false;
          }
        });

        const basePool = pointerEls.length > 0 ? pointerEls : allLeftEls;

        const innerCards = basePool.filter(el => {
          const rA = el.getBoundingClientRect();
          const hasTightInnerCard = basePool.some(other => {
            if (other === el || !el.contains(other)) return false;
            const rB = other.getBoundingClientRect();
            return Math.abs(rA.height - rB.height) < 18 && rB.width > rA.width * 0.7;
          });
          return !hasTightInnerCard;
        });

        const sortedByTop = (innerCards.length > 0 ? innerCards : basePool).sort(
          (a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top
        );

        const distinctRows = [];
        for (const item of sortedByTop) {
          const r = item.getBoundingClientRect();
          const centerY = r.top + r.height / 2;
          const alreadyHasRowAtThisY = distinctRows.some(existing => {
            const er = existing.getBoundingClientRect();
            const eCenterY = er.top + er.height / 2;
            return Math.abs(centerY - eCenterY) < 36;
          });
          if (!alreadyHasRowAtThisY) {
            distinctRows.push(item);
          }
        }

        if (distinctRows.length > 0) {
          return distinctRows;
        }
      }
    }

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
      const list = Array.from(document.querySelectorAll(sel)).filter(
        el => !isElementInOurOverlay(el) && el.offsetParent !== null
      );
      if (list.length > 0) {
        return list;
      }
    }

    return [];
  }

  async function clickAndOpenTicketCard(ticketEl) {
    if (!ticketEl) return;

    ticketEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    await sleep(100);

    const rect = ticketEl.getBoundingClientRect();
    const centerX = rect.left + rect.width * 0.45;
    const centerY = rect.top + rect.height * 0.5;

    const hitEl = document.elementFromPoint(centerX, centerY);
    if (hitEl && !isElementInOurOverlay(hitEl)) {
      simulateRealClick(hitEl);
    }

    simulateRealClick(ticketEl);

    await sleep(550);
    if (!isAnyTicketCurrentlyOpenInCenter()) {
      const innerClickable = ticketEl.querySelector('span, b, strong, p, a, div');
      if (innerClickable) {
        simulateRealClick(innerClickable);
      }
      const leftHitEl = document.elementFromPoint(rect.left + Math.min(75, rect.width * 0.35), rect.top + Math.min(25, rect.height * 0.4));
      if (leftHitEl && !isElementInOurOverlay(leftHitEl)) {
        simulateRealClick(leftHitEl);
      }
      await sleep(500);
    }
  }

  function startInstantInboxArrivalWatcher() {
    if (inboxArrivalObserver) inboxArrivalObserver.disconnect();

    let arrivalDebounce = null;
    inboxArrivalObserver = new MutationObserver(() => {
      if (!isScanningQueue || isPausedForQuestion || isSendingLock || isStepInProgress || isDisabledInThisTab) return;

      if (!isAnyTicketCurrentlyOpenInCenter()) {
        const asigInfo = getAsignadosColumnInfo();
        const tickets = getInboxTicketElements();
        if ((asigInfo && asigInfo.assignedCount > 0) || tickets.length > 0) {
          clearTimeout(arrivalDebounce);
          arrivalDebounce = setTimeout(() => {
            if (isScanningQueue && !isSendingLock && !isStepInProgress) {
              clearTimeout(scannerLoopTimeout);
              currentTicketIndex = 0;
              runNextScannerStep();
            }
          }, 250);
        }
      }
    });

    inboxArrivalObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  // ==========================================
  // MOTOR DE AUTO-ESCANEO Y SCROLL DE CHATS
  // ==========================================
  function stopScannerIfRunning() {
    if (isScanningQueue) {
      isScanningQueue = false;
      isPausedForQuestion = false;
      isStepInProgress = false;
      clearTimeout(scannerLoopTimeout);
      if (inboxArrivalObserver) inboxArrivalObserver.disconnect();
      const btn = document.getElementById('lc-btn-scanner');
      const badge = document.getElementById('lc-scanner-status');
      if (btn) {
        btn.classList.remove('active');
        btn.innerText = "▶️ Auto-Escanear y Scrollear Chats";
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
    isStepInProgress = false;
    const btn = document.getElementById('lc-btn-scanner');
    const badge = document.getElementById('lc-scanner-status');

    if (isScanningQueue) {
      btn.classList.add('active');
      btn.innerText = "⏹️ Detener Escaneo de Bandeja";
      badge.innerText = "Vigilando Asignados: abre el ticket apenas caiga...";
      showToast("🔍 Auto-Escaneo activo (Abre tickets solos)", "info");
      currentTicketIndex = 0;
      startInstantInboxArrivalWatcher();
      runNextScannerStep();
    } else {
      stopScannerIfRunning();
      showToast("⏸️ Escaneo detenido", "warning");
    }
  }

  async function runNextScannerStep() {
    if (!isScanningQueue || isPausedForQuestion || isDisabledInThisTab || isSendingLock || isStepInProgress) return;

    isStepInProgress = true;
    const badge = document.getElementById('lc-scanner-status');
    const asigInfo = getAsignadosColumnInfo();
    const tickets = getInboxTicketElements();

    // Caso 1: Hay tarjetas de tickets en la columna izquierda ("Asignados")
    if (tickets.length > 0) {
      if (currentTicketIndex >= tickets.length) {
        currentTicketIndex = 0;
      }

      const ticketEl = tickets[currentTicketIndex];
      if (badge) {
        badge.innerText = `🖱️ Abriendo ticket ${currentTicketIndex + 1} de ${tickets.length} en Asignados...`;
      }

      await clickAndOpenTicketCard(ticketEl);
      await waitForTicketContentToLoad(3200);

      if (!isScanningQueue || isPausedForQuestion || isDisabledInThisTab) {
        isStepInProgress = false;
        return;
      }

      await processCurrentOpenTicket(() => {
        currentTicketIndex++;
        isStepInProgress = false;
        scannerLoopTimeout = setTimeout(runNextScannerStep, 1800);
      });
      return;
    }

    // Caso 2: "Asignados(N)" dice que hay >= 1 ticket pero aún no se detectó la fila
    if (asigInfo && asigInfo.assignedCount > 0) {
      if (badge) {
        badge.innerText = `🔔 Asignados(${asigInfo.assignedCount}) detectado. Abriendo primer ticket...`;
      }
      simulateRealClick(asigInfo.asignadosEl);
      await sleep(350);

      const firstRowX = asigInfo.colLeft + (asigInfo.colRight - asigInfo.colLeft) * 0.45;
      const firstRowY = asigInfo.tabBarBottom + 38;
      const targetAtFirstRow = document.elementFromPoint(firstRowX, firstRowY);
      if (targetAtFirstRow && !isElementInOurOverlay(targetAtFirstRow)) {
        simulateRealClick(targetAtFirstRow);
        await waitForTicketContentToLoad(3200);
      }

      if (isAnyTicketCurrentlyOpenInCenter()) {
        await processCurrentOpenTicket(() => {
          isStepInProgress = false;
          scannerLoopTimeout = setTimeout(runNextScannerStep, 1800);
        });
        return;
      }
    }

    // Caso 3: Si ya hay un chat abierto en el centro
    if (isAnyTicketCurrentlyOpenInCenter()) {
      await processCurrentOpenTicket(() => {
        isStepInProgress = false;
        scannerLoopTimeout = setTimeout(runNextScannerStep, 2200);
      });
      return;
    }

    // Caso 4: Bandeja totalmente vacía ("Asignados(0)")
    if (badge) {
      badge.innerText = `👀 Bandeja vacía (Asignados: 0). Esperando nuevo ticket para abrirlo...`;
    }
    isStepInProgress = false;
    scannerLoopTimeout = setTimeout(runNextScannerStep, 1500);
  }

  async function processCurrentOpenTicket(onDone) {
    if (isDisabledInThisTab) {
      onDone();
      return;
    }
    const badge = document.getElementById('lc-scanner-status');

    if (isConversationBlockedByHSM()) {
      if (badge) badge.innerText = `⛔ Conversación bloqueada por HSM. Saltando...`;
      onDone();
      return;
    }

    if (doesCurrentChatAlreadyHaveSecondQuestion()) {
      const d = scanScreenForSubmotivo();
      if (d) markTicketAsAnswered(d.sot, d.ticketNum, d.signature);
      if (badge) badge.innerText = `✅ Ya respondido completo en chat. Saltando...`;
      onDone();
      return;
    }

    let detected = scanScreenForSubmotivo();
    if (!detected) {
      const scrollData = await scrollChatAndCollectFullData();
      detected = scrollData.detected;
    }

    if (!detected) {
      if (badge) badge.innerText = `🔍 Sin plantilla de técnico en este chat. Saltando...`;
      onDone();
      return;
    }

    const storageCheck = wasTicketAlreadyAnsweredInStorage(detected.sot, detected.ticketNum, detected.signature);
    if (storageCheck.answered) {
      if (badge) badge.innerText = `🛡️ Anti-duplicado: ${storageCheck.reason} Saltando...`;
      onDone();
      return;
    }

    if (skippedTickets.has(detected.signature)) {
      if (badge) badge.innerText = `⏭️ Ticket omitido previamente. Saltando...`;
      onDone();
      return;
    }

    if (detected.casuistica || !detected.rule) {
      if (badge) badge.innerText = `⚠️ Pausado: Casuística requiere tu decisión`;
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

    safeSendTwoStepSmartReply(detected.rule, detected, true, () => onDone());
  }

  function updateDetectedPreview(detected, contextStats = null) {
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
      const secondMsg = resolveSecondMessage(detected.rule, contextStats);
      const contextSummaryHtml = buildContextSummaryHtml(detected.rule, contextStats);

      previewEl.innerHTML = `
        <div class="lc-detected-box found">
          <div>🎯 Leído: <b>Submotivo: ${detected.rawSubmotivo}</b>${sotBadge}</div>
          ${contextSummaryHtml}
          <button id="lc-quick-send-detected" class="lc-quick-send-btn">
            🚀 1° Saludo (Inmediato) ➔ (5s) ➔ 2° "${secondMsg}"
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
          🔍 Abre un chat para analizar <code>Submotivo:</code>, fotos y cintillos
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
        if (isDisabledInThisTab || isSendingLock) return;
        const detected = scanScreenForSubmotivo();
        const contextStats = await analyzeFullTicketContext(detected);
        updateDetectedPreview(detected, contextStats);
      }, 650);
    });
    manualObserver.observe(document.body, { childList: true, subtree: true });
  }

  // ==========================================
  // ACTIVAR / DESACTIVAR EN ESTA PESTAÑA (ACTIVO / NO ACTIVO)
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
      showToast("🔴 No activo en esta pestaña", "warning");
    } else {
      if (miniPill) miniPill.style.display = 'none';
      if (mainWidget) mainWidget.style.display = 'block';
      startManualTicketMonitor();
      showToast("🟢 Activo en esta pestaña", "success");
    }
  }

  // Escuchar mensajes desde el Popup de la extensión (Activo / No activo por pestaña)
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message) return;
      if (message.type === 'GET_TAB_STATUS') {
        sendResponse({
          active: !isDisabledInThisTab,
          scanning: isScanningQueue
        });
        return true;
      }
      if (message.type === 'SET_TAB_STATUS') {
        const shouldBeActive = Boolean(message.active);
        setTabDisabledState(!shouldBeActive);
        sendResponse({
          active: !isDisabledInThisTab,
          scanning: isScanningQueue
        });
        return true;
      }
    });
  }

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

    const disabledPill = document.createElement('button');
    disabledPill.id = 'laraigo-disabled-pill';
    disabledPill.className = 'laraigo-disabled-pill';
    disabledPill.title = 'Haz clic para cambiar a ACTIVO en esta pestaña';
    disabledPill.innerHTML = `🔴 No activo`;
    disabledPill.style.display = isDisabledInThisTab ? 'flex' : 'none';
    disabledPill.addEventListener('click', () => setTabDisabledState(false));
    document.body.appendChild(disabledPill);

    const container = document.createElement('div');
    container.id = 'laraigo-copilot-container';
    container.className = 'laraigo-copilot-widget';
    container.style.display = isDisabledInThisTab ? 'none' : 'block';

    container.innerHTML = `
      <div class="lc-header" id="lc-drag-handle" title="Arrastra desde aquí para mover el panel">
        <div class="lc-title">
          <span class="lc-badge">CLARO</span> Copiloto Inteligente
        </div>
        <div class="lc-actions">
          <button id="lc-btn-disable-tab" class="lc-btn-disable-tab" title="Haz clic para cambiar a NO ACTIVO en esta pestaña">
            🟢 Activo
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

        <!-- Detector en tiempo real del mensaje, imágenes y cintillos -->
        <div id="lc-live-detected">
          <div class="lc-detected-box waiting">
            🔍 Abre un chat para analizar <code>Submotivo:</code>, fotos y cintillos
          </div>
        </div>

        <!-- Control de Auto-Escaneo y Scroll de Bandeja -->
        <div class="lc-scanner-panel">
          <button id="lc-btn-scanner" class="lc-btn-scanner">
            ▶️ Auto-Escanear y Scrollear Chats
          </button>
          <div id="lc-scanner-status" class="lc-scanner-status">
            Abre el ticket apenas cae ➔ Saludo (0s) ➔ (5s) ➔ 2° Respuesta
          </div>
        </div>

        <div class="lc-section-title">⚡ Submotivos Manuales (Saludo 0s + 5s Espera)</div>
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

    const previews = {
      reenvio: 'Sin captura TOA: "enviar captura..." | Con captura: "un momento"',
      activaciones: 'Sin captura TOA: "enviar error..." | Con captura: "un momento"',
      cintillos: 'Verifica foto Fat/Tap y núm. cintillos (pide lo que falte)',
      mesh: 'Con foto: "Un momento" | Sin foto: "Enviar imagen del repetidor"',
      manto: 'Con video/foto/texto: "Se revisa" | Vacío: "Enviar motivo..."',
      pext: 'Con fotos: "Se revisa" | Sin fotos: "Enviar evidencias porfavor"'
    };

    SUBMOTIVO_MAP.forEach((item) => {
      const btn = document.createElement('button');
      btn.className = 'lc-submotivo-btn';
      btn.dataset.id = item.id;
      btn.title = previews[item.id] || item.defaultQuestion;

      btn.innerHTML = `
        <div class="lc-btn-top">
          <b>${item.name}</b>
        </div>
        <div class="lc-btn-preview">${previews[item.id]}</div>
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
