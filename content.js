// Laraigo Auto-Reply Copilot - Especial Soporte Técnico Claro
// Flujo completo inteligente por Submotivo + Analizador de Imágenes, Videos, Cintillos y Texto:
// 1. Activaciones: Saludo -> Si hay captura App TOA (ignora fotos de equipo): "un momento" | Si no: "enviar error de toa"
// 2. Reenvío de señal: Saludo -> Si hay captura App TOA (ignora fotos de equipo): "un momento" | Si no: "enviar captura de reenvio desde su toa"
// 3. Registro de mesh: Saludo -> Si envía imagen: "Un momento" | Si no hay imagen: "Enviar imagen del repetidor"
// 4. Consulta de cintillos: Saludo ->
//    - Si envía números de cintillos (ej. 6273351...) y NO hay imagen: "Enviar captura de imagen de Fat/Tap"
//    - Si hay solo imagen y NO hay números de cintillos: "Enviar cintillos"
//    - Si NO envía ni imagen ni cintillos: "Enviar captura de imagen de Fat/Tap y cintillos"
//    - Si envió ambos (imagen + cintillos): "Un momento"
// 5. SOT de manto: Saludo -> Si hay video, imagen o texto explicando motivo: "Se revisa" | Si no hay nada: "Enviar motivo de sot de manto"
// 6. Derivación a PEXT: Saludo -> Si se ven imágenes/videos: "Se revisa" | Si no hay nada: "Enviar evidencias porfavor"

(function () {
  'use strict';

  const BASE_GREETING = "Hola Técnico, Procederemos con la atención";

  const SUBMOTIVO_MAP = [
    {
      id: "reenvio",
      name: "Reenvío de señal",
      keywords: ["reenvio"],
      defaultQuestion: "enviar captura de reenvio desde su toa"
    },
    {
      id: "activaciones",
      name: "Activaciones",
      keywords: ["activacion", "activar"],
      defaultQuestion: "enviar error de toa"
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
  // AUTO-SCROLL DENTRO DE LA CONVERSACIÓN DEL CHAT
  // ==============================================================
  function findChatMessagesScrollContainer() {
    const widget = document.getElementById('laraigo-copilot-container');
    const allDivs = Array.from(document.querySelectorAll('div'));

    let bestCandidate = null;
    let maxScore = 0;

    for (const div of allDivs) {
      if (widget && widget.contains(div)) continue;
      if (div.offsetParent === null) continue;

      const style = window.getComputedStyle(div);
      const overflowY = style.overflowY;
      if (overflowY !== 'auto' && overflowY !== 'scroll') continue;
      if (div.clientHeight < 150 || div.clientWidth < 180) continue;

      const rect = div.getBoundingClientRect();
      if (rect.left < 100) continue;

      const text = (div.innerText || '').toLowerCase();
      const hasChatIndicators =
        text.includes('mensaje entregado') ||
        text.includes('submotivo:') ||
        text.includes('hola, soy el') ||
        text.includes('hola técnico') ||
        div.querySelectorAll('img, video').length > 0;

      if (hasChatIndicators && div.scrollHeight >= div.clientHeight) {
        const score = div.clientHeight * (div.scrollHeight > div.clientHeight ? 2 : 1);
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

    if (scrollContainer && scrollContainer.scrollHeight > scrollContainer.clientHeight + 30) {
      scrollContainer.scrollTop = 0;
      await sleep(350);
      collectedText += '\n' + (scrollContainer.innerText || '');

      scrollContainer.scrollTop = Math.floor(scrollContainer.scrollHeight / 2);
      await sleep(250);
      collectedText += '\n' + (scrollContainer.innerText || '');

      scrollContainer.scrollTop = scrollContainer.scrollHeight;
      await sleep(350);
      collectedText += '\n' + (scrollContainer.innerText || '');
    }

    const detected = scanScreenForSubmotivo(collectedText);
    const contextStats = await analyzeFullTicketContext(detected, collectedText);

    return { detected, contextStats };
  }

  // ==============================================================
  // ANALIZADOR DE IMÁGENES, VIDEOS, NÚMEROS DE CINTILLOS Y TEXTO
  // ==============================================================
  function getChatAttachmentImages() {
    const widget = document.getElementById('laraigo-copilot-container');
    const allImgs = Array.from(document.querySelectorAll('img'));

    return allImgs.filter(img => {
      if (widget && widget.contains(img)) return false;
      if (img.offsetParent === null) return false;
      const rect = img.getBoundingClientRect();
      // Excluir avatares de usuario en panel derecho (perfil grande circular) o íconos pequeños
      if (rect.width < 95 || rect.height < 95) return false;
      const src = (img.src || '').toLowerCase();
      if (!src || src.includes('avatar') || src.includes('emoji') || src.includes('logo') || src.includes('profile')) return false;
      // Excluir imágenes que estén en el panel derecho de Información del contacto
      const rightInfoPanel = img.closest('[class*="info"], [class*="profile"], [class*="contact-detail"]');
      if (rightInfoPanel) return false;
      return true;
    });
  }

  function hasVideoInChat() {
    const widget = document.getElementById('laraigo-copilot-container');
    const videos = Array.from(document.querySelectorAll('video, a[href*=".mp4"], a[href*=".mov"], [class*="video-player"], [class*="video_message"]')).filter(
      el => (!widget || !widget.contains(el)) && el.offsetParent !== null
    );
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

  // Analiza los mensajes adicionales del técnico (números de cintillos, explicaciones de SOT de manto, etc.)
  function analyzeTechnicianExtraText(detected, extraCollectedText = '') {
    const widget = document.getElementById('laraigo-copilot-container');
    const scrollContainer = findChatMessagesScrollContainer();
    const rawChatText = (extraCollectedText || '') + '\n' + (scrollContainer ? scrollContainer.innerText : document.body.innerText || '');

    // Limpiar el texto de bloques del sistema, plantilla inicial y mensajes del asesor
    let cleaned = rawChatText
      // Quitar el bloque de plantilla de ingreso "Hola, soy el técnico ... Submotivo: <linea>"
      .replace(/Hola,\s*soy\s*el\s*t[eé]cnico[\s\S]*?Submotivo\s*:\s*[^\r\n]+/gi, ' ')
      // Quitar mensajes automáticos del sistema Laraigo
      .replace(/Te estamos contactando con un asesor especializado[^\r\n]*/gi, ' ')
      .replace(/ASIGNADO A HOLDING[^\r\n]*/gi, ' ')
      .replace(/REASIGNADO DE HOLDING[^\r\n]*/gi, ' ')
      .replace(/MENSAJE ENTREGADO[^\r\n]*/gi, ' ')
      .replace(/Esta conversaci[oó]n se encuentra bloqueada[^\r\n]*/gi, ' ')
      // Quitar mensajes nuestros como asesor
      .replace(/Hola T[eé]cnico,\s*Procederemos con la atenci[oó]n\.?/gi, ' ')
      .replace(/enviar error de toa/gi, ' ')
      .replace(/enviar captura de reenvio desde su toa/gi, ' ')
      .replace(/enviar captura de imagen de fat\/tap y cintillos/gi, ' ')
      .replace(/enviar captura de imagen de fat\/tap/gi, ' ')
      .replace(/enviar cintillos/gi, ' ')
      .replace(/enviar imagen del repetidor/gi, ' ')
      .replace(/enviar motivo de sot de manto/gi, ' ')
      .replace(/enviar evidencias porfavor/gi, ' ')
      // Quitar horas tipo "10:23" o "14:32"
      .replace(/\b\d{1,2}:\d{2}\b/g, ' ');

    const sotStr = detected?.sot ? String(detected.sot) : '';
    const ticketStr = detected?.ticketNum ? String(detected.ticketNum) : '';

    // 1. Detectar números de cintillos (ej. 6273351, 8041438, 6776329...)
    // Los cintillos suelen ser números de 6 a 8 dígitos (excluyendo SOT, N° de Ticket y celulares de 9 dígitos que empiezan con 9)
    const numberMatches = cleaned.match(/\b\d{6,9}\b/g) || [];
    const cintilloNumbers = numberMatches.filter(num => {
      if (num === sotStr || num === ticketStr) return false;
      // Excluir celulares peruanos de 9 dígitos que empiezan en 9 (ej. 924356406)
      if (num.length === 9 && num.startsWith('9')) return false;
      return true;
    });

    const hasCintillosNumbers = cintilloNumbers.length >= 1;

    // 2. Detectar si el técnico escribió texto explicativo (para SOT de manto)
    // Quitar números sueltos y saludos cortos genéricos ("hola", "buenas tardes", "buenos dias")
    const textWithoutNumbers = cleaned
      .replace(/\b\d+\b/g, ' ')
      .replace(/\b(hola|buenas|tardes|dias|noches|buen|dia|por|favor|apoyo|gracias|estimado|asesor)\b/gi, ' ')
      .replace(/[^\wáéíóúñÁÉÍÓÚÑ]+/g, ' ')
      .trim();

    // Si quedan palabras con sentido (al menos 6 letras en total), hay texto explicando el motivo
    const hasExplanationText = textWithoutNumbers.length >= 6;

    return {
      hasCintillosNumbers,
      cintilloCount: cintilloNumbers.length,
      hasExplanationText
    };
  }

  async function analyzeFullTicketContext(detected, extraCollectedText = '') {
    const imgs = getChatAttachmentImages();
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
      // 1. ACTIVACIONES: Ignorar fotos de equipo; si hay captura de App de celular (TOA) -> "un momento", sino -> "enviar error de toa"
      case "activaciones":
        if (stats.hasAppScreenshot) {
          return "un momento";
        }
        return "enviar error de toa";

      // 2. REENVÍO DE SEÑAL: Ignorar fotos de equipo; si hay captura de App de celular (TOA) -> "un momento", sino -> "enviar captura de reenvio desde su toa"
      case "reenvio":
        if (stats.hasAppScreenshot) {
          return "un momento";
        }
        return "enviar captura de reenvio desde su toa";

      // 3. REGISTRO DE MESH: Si envía imagen -> "Un momento", si no hay imagen -> "Enviar imagen del repetidor"
      case "mesh":
        if (stats.hasAnyImage) {
          return "Un momento";
        }
        return "Enviar imagen del repetidor";

      // 4. CONSULTA DE CINTILLOS:
      // - Si envía números de cintillos y NO hay imagen -> "Enviar captura de imagen de Fat/Tap"
      // - Si hay solo imagen y NO hay números de cintillos -> "Enviar cintillos"
      // - Si NO envía nada -> "Enviar captura de imagen de Fat/Tap y cintillos"
      // - Si ya envió ambos (imagen + cintillos) -> "Un momento"
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

      // 5. SOT DE MANTO:
      // - Si hay algún video, imagen o texto explicando -> "Se revisa"
      // - Si no hay ningún video, imagen ni texto explicando -> "Enviar motivo de sot de manto"
      case "manto":
        if (stats.hasVideo || stats.hasAnyImage || stats.hasExplanationText) {
          return "Se revisa";
        }
        return "Enviar motivo de sot de manto";

      // 6. DERIVACIÓN A PEXT:
      // - Si se ven imágenes (o video) -> "Se revisa"
      // - Si no hay nada -> "Enviar evidencias porfavor"
      case "pext":
        if (stats.hasAnyImage || stats.hasVideo) {
          return "Se revisa";
        }
        return "Enviar evidencias porfavor";

      default:
        return rule.defaultQuestion;
    }
  }

  // Descripción amigable en el widget de lo que se detectó en el ticket
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
  // 1° Saludo ("Hola Técnico, Procederemos con la atención")
  // 2° Respuesta dinámica según evaluación del ticket
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
          `⚠️ Este chat ya tiene la respuesta enviada en pantalla. ¿Seguro que deseas volver a enviar?`,
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
    const contextStats = await analyzeFullTicketContext(detected);
    const secondMessageText = typeof ruleOrQuestion === 'string'
      ? ruleOrQuestion
      : resolveSecondMessage(ruleOrQuestion, contextStats);

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

    showToast(`1/2 Enviando saludo inicial...`, "info");
    pasteAndSendSingleMessage(BASE_GREETING, (step1Ok) => {
      if (!step1Ok) {
        isSendingLock = false;
        if (onComplete) onComplete(false);
        return;
      }

      setTimeout(() => {
        showToast(`2/2 Enviando: "${secondMessageText}"`, "info");
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

  function scanScreenForSubmotivo(extraCollectedText = '') {
    const widget = document.getElementById('laraigo-copilot-container');
    const candidateNodes = document.querySelectorAll(
      '[class*="message"], [class*="bubble"], [class*="chat"], p, div, span'
    );

    let combinedChatText = extraCollectedText || '';
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
  // COMPROBAR SI EL CHAT YA TIENE SALUDO O 2° RESPUESTA
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

    for (const msg of chatContainers) {
      if (widget && widget.contains(msg)) continue;
      const text = normalizeText(msg.innerText || '');
      if (secondStepPhrases.some(phrase => text.includes(phrase))) {
        return true;
      }
      if (text.includes("hola tecnico, procederemos con la atencion")) {
        hasGreeting = true;
      }
      if (
        text === "un momento" ||
        text.startsWith("un momento\n") ||
        text.includes("\nun momento") ||
        text === "se revisa" ||
        text.startsWith("se revisa\n") ||
        text.includes("\nse revisa")
      ) {
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
  // DETECCIÓN Y SCROLL DE LA COLUMNA "Asignados(X)" DE LARAIGO
  // ==============================================================
  function getInboxTicketElements() {
    const widget = document.getElementById('laraigo-copilot-container');

    const allElements = Array.from(document.querySelectorAll('div, span, a, button, li'));
    let asignadosTabEl = null;
    for (const el of allElements) {
      if (widget && widget.contains(el)) continue;
      const txt = (el.innerText || '').trim();
      if (/^Asignados\s*\(\d+\)$/i.test(txt)) {
        asignadosTabEl = el;
        break;
      }
    }

    if (asignadosTabEl) {
      const tabRect = asignadosTabEl.getBoundingClientRect();
      let leftColumn = asignadosTabEl.parentElement;
      for (let i = 0; i < 6; i++) {
        if (!leftColumn || leftColumn === document.body) break;
        if (leftColumn.clientHeight > 250) break;
        leftColumn = leftColumn.parentElement;
      }

      if (leftColumn) {
        const scrollableList = Array.from(leftColumn.querySelectorAll('div')).find(
          d => d.scrollHeight > d.clientHeight + 20 && d.clientHeight > 150
        );
        if (scrollableList && currentTicketIndex === 0) {
          scrollableList.scrollTop = 0;
        }

        const candidateCards = Array.from(leftColumn.querySelectorAll('div, li, a')).filter(el => {
          if (widget && widget.contains(el)) return false;
          if (el.offsetParent === null) return false;
          const r = el.getBoundingClientRect();
          if (r.top < tabRect.bottom - 2) return false;
          if (r.left > 180) return false;
          if (r.width < 110 || r.width > 340) return false;
          if (r.height < 48 || r.height > 135) return false;

          const text = (el.innerText || '').trim();
          if (text.length < 4 || text.length > 260) return false;
          return true;
        });

        const uniqueRowCards = candidateCards.filter(card => {
          return !candidateCards.some(other => other !== card && other.contains(card));
        });

        if (uniqueRowCards.length > 0) {
          return uniqueRowCards;
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
        el => (!widget || !widget.contains(el)) && el.offsetParent !== null
      );
      if (list.length > 0) {
        return list;
      }
    }

    return [];
  }

  // ==========================================
  // MOTOR DE AUTO-ESCANEO Y SCROLL DE CHATS
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
    const btn = document.getElementById('lc-btn-scanner');
    const badge = document.getElementById('lc-scanner-status');

    if (isScanningQueue) {
      btn.classList.add('active');
      btn.innerText = "⏹️ Detener Escaneo de Bandeja";
      badge.innerText = "Recorriendo Asignados y evaluando flujos...";
      showToast("🔍 Auto-Scroll inteligente iniciado", "info");
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
      badge.innerText = "Scrolleando y revisando chat abierto actual...";
      processCurrentOpenTicket(() => {
        scannerLoopTimeout = setTimeout(runNextScannerStep, 3000);
      });
      return;
    }

    if (currentTicketIndex >= tickets.length) {
      badge.innerText = `Ciclo completado (${tickets.length} chats). Vigilando nuevos...`;
      currentTicketIndex = 0;
      scannerLoopTimeout = setTimeout(runNextScannerStep, 3500);
      return;
    }

    const ticketEl = tickets[currentTicketIndex];
    badge.innerText = `Abriendo chat ${currentTicketIndex + 1} de ${tickets.length} en Asignados...`;

    ticketEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    simulateRealClick(ticketEl);

    scannerLoopTimeout = setTimeout(() => {
      if (!isScanningQueue || isPausedForQuestion || isDisabledInThisTab) return;
      processCurrentOpenTicket(() => {
        currentTicketIndex++;
        scannerLoopTimeout = setTimeout(runNextScannerStep, 2200);
      });
    }, 1400);
  }

  async function processCurrentOpenTicket(onDone) {
    if (isDisabledInThisTab) return;
    const badge = document.getElementById('lc-scanner-status');

    if (isConversationBlockedByHSM()) {
      badge.innerText = `⛔ Conversación bloqueada por HSM. Saltando...`;
      onDone();
      return;
    }

    badge.innerText = `↕️ Scrolleando chat para evaluar Submotivo y evidencias...`;
    const { detected, contextStats } = await scrollChatAndCollectFullData();
    updateDetectedPreview(detected, contextStats);

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

    const secondMsg = resolveSecondMessage(detected.rule, contextStats);
    badge.innerText = `🎯 SOT ${detected.sot || ''} ➔ Enviando "${secondMsg}"...`;
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
        if (isDisabledInThisTab) return;
        const detected = scanScreenForSubmotivo();
        const contextStats = await analyzeFullTicketContext(detected);
        updateDetectedPreview(detected, contextStats);
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
    disabledPill.title = 'Haz clic para volver a encender el Copiloto en esta pestaña';
    disabledPill.innerHTML = `🔌 Copiloto OFF aquí`;
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
            Evalúa fotos TOA, repetidor, cintillos, videos y motivos
          </div>
        </div>

        <div class="lc-section-title">⚡ Submotivos Manuales (Evalúan el chat al clic)</div>
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
