// Laraigo Auto-Reply Copilot - Content Script
(function () {
  'use strict';

  // Configuración por defecto
  const DEFAULT_CONFIG = {
    enabled: true,
    autoReplyActive: false,
    autoReplyDelay: 2000,
    agentName: "Asesor",
    templates: [
      {
        id: "saludo",
        title: "👋 Saludo Inicial",
        text: "¡Hola! Gracias por comunicarte con Claro. Mi nombre es {{agente}}. ¿En qué puedo ayudarte hoy?"
      },
      {
        id: "solicitar_dni",
        title: "🪪 Pedir DNI / Titular",
        text: "Para brindarte una atención personalizada y validar tu línea, por favor confírmame tu nombre completo, número de DNI y el número Claro consultado."
      },
      {
        id: "espera",
        title: "⏳ Un momento",
        text: "Permíteme un momento en línea mientras verifico los detalles de tu cuenta en el sistema, por favor."
      },
      {
        id: "despedida",
        title: "🌟 Despedida",
        text: "Ha sido un gusto atenderte. Si tienes alguna otra consulta, no dudes en escribirnos. ¡Que tengas un excelente día!"
      }
    ],
    rules: [
      {
        keywords: ["hola", "buen dia", "buenas tardes", "buenas noches", "buenos dias"],
        reply: "¡Hola! Bienvenido al canal de atención de Claro. ¿En qué podemos ayudarte el día de hoy?"
      },
      {
        keywords: ["precio", "costo", "planes", "promocion", "renovacion"],
        reply: "Con gusto te comparto nuestras promociones vigentes. Por favor indícame si buscas un plan prepago, postpago o servicio para tu hogar."
      },
      {
        keywords: ["asesor", "humano", "persona", "operador"],
        reply: "¡Claro que sí! Estás en contacto con un asesor. Por favor detállanos tu consulta para ayudarte de inmediato."
      }
    ]
  };

  let currentConfig = { ...DEFAULT_CONFIG };
  let lastProcessedMessage = null;

  // Cargar configuración guardada
  chrome.storage.local.get(["laraigo_config"], (result) => {
    if (result.laraigo_config) {
      currentConfig = { ...DEFAULT_CONFIG, ...result.laraigo_config };
    } else {
      chrome.storage.local.set({ laraigo_config: currentConfig });
    }
    initUI();
    startChatObserver();
  });

  // Escuchar cambios de almacenamiento (desde el popup)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.laraigo_config) {
      currentConfig = { ...DEFAULT_CONFIG, ...changes.laraigo_config.newValue };
      updateUI();
    }
  });

  // Localizador inteligente del campo de entrada de texto en Laraigo
  function findChatInput() {
    // 1. Textarea típica de chat
    const textareas = Array.from(document.querySelectorAll('textarea'));
    for (const ta of textareas) {
      if (ta.offsetParent !== null && !ta.disabled && !ta.readOnly) {
        return { element: ta, type: 'textarea' };
      }
    }

    // 2. Div contenteditable (común en chats modernos)
    const editables = Array.from(document.querySelectorAll('[contenteditable="true"]'));
    for (const ed of editables) {
      if (ed.offsetParent !== null) {
        return { element: ed, type: 'contenteditable' };
      }
    }

    // 3. Input text visible
    const inputs = Array.from(document.querySelectorAll('input[type="text"]'));
    for (const inp of inputs) {
      const placeholder = (inp.placeholder || '').toLowerCase();
      if (placeholder.includes('mensaje') || placeholder.includes('escribe') || placeholder.includes('chat')) {
        return { element: inp, type: 'input' };
      }
    }

    return null;
  }

  // Localizador inteligente del botón de envío
  function findSendButton(inputContext) {
    // Buscar en el contenedor padre del input
    const container = inputContext ? inputContext.closest('form, div[class*="footer"], div[class*="input"], div[class*="chat"]') || document : document;

    // 1. Botones con tipo submit
    const submitBtn = container.querySelector('button[type="submit"]');
    if (submitBtn && submitBtn.offsetParent !== null && !submitBtn.disabled) return submitBtn;

    // 2. Botones con iconos SVG (común en Laraigo / chats)
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

    // Fallback: el último botón habilitado en el área del footer
    for (let i = buttons.length - 1; i >= 0; i--) {
      if (buttons[i].offsetParent !== null && !buttons[i].disabled) {
        return buttons[i];
      }
    }

    return null;
  }

  // Escribir texto de forma compatible con React/Vue
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

  // Enviar mensaje
  function triggerSend(inputTarget) {
    const btn = findSendButton(inputTarget?.element);
    if (btn) {
      btn.click();
      return true;
    }

    // Si no encuentra botón, simular tecla Enter
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

  // Procesar texto de plantilla con variables
  function formatTemplateText(templateText) {
    return templateText.replace(/\{\{agente\}\}/gi, currentConfig.agentName || "Asesor");
  }

  // Insertar respuesta en el chat
  function insertReply(text, andSend = false) {
    const processedText = formatTemplateText(text);
    const target = findChatInput();
    if (!target) {
      showToast("⚠️ No se encontró la caja de texto del chat. Abre una conversación.", "warning");
      return;
    }

    setInputValue(target, processedText);

    if (andSend) {
      setTimeout(() => {
        const sent = triggerSend(target);
        if (sent) {
          showToast("🚀 Mensaje enviado con éxito", "success");
        } else {
          showToast("✏️ Texto insertado (presiona Enviar)", "info");
        }
      }, 250);
    } else {
      showToast("📝 Respuesta insertada en el campo de texto", "info");
    }
  }

  // Buscar coincidencia por palabras clave
  function findMatchingRule(messageText) {
    if (!messageText) return null;
    const cleanMsg = messageText.toLowerCase().trim();

    for (const rule of currentConfig.rules || []) {
      for (const kw of rule.keywords) {
        if (cleanMsg.includes(kw.toLowerCase().trim())) {
          return rule;
        }
      }
    }
    return null;
  }

  // Observador de nuevos mensajes
  function startChatObserver() {
    const observer = new MutationObserver((mutations) => {
      if (!currentConfig.autoReplyActive) return;

      // Buscar mensajes entrantes del cliente
      // Laraigo suele tener mensajes alineados a la izquierda o con clase tipo 'incoming' / 'received'
      const messageNodes = document.querySelectorAll(
        '[class*="message"], [class*="bubble"], [class*="chat-item"], .message-received, .msg-incoming'
      );

      if (messageNodes.length === 0) return;
      const lastMsgNode = messageNodes[messageNodes.length - 1];
      const text = (lastMsgNode.innerText || '').trim();

      if (!text || text === lastProcessedMessage) return;

      // Descartar si el mensaje es del propio agente (normalmente a la derecha o con clase 'sent' / 'outgoing')
      const isOutgoing = lastMsgNode.closest('[class*="sent"], [class*="outgoing"], [class*="right"]');
      if (isOutgoing) return;

      lastProcessedMessage = text;

      const rule = findMatchingRule(text);
      if (rule) {
        showToast(`🤖 Regla detectada: "${rule.keywords[0]}". Respondiendo...`, "info");
        setTimeout(() => {
          insertReply(rule.reply, true);
        }, currentConfig.autoReplyDelay || 2000);
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  // Interfaz de Usuario Flotante (Widget Copiloto)
  function initUI() {
    if (document.getElementById('laraigo-copilot-container')) return;

    const container = document.createElement('div');
    container.id = 'laraigo-copilot-container';
    container.className = 'laraigo-copilot-widget';

    container.innerHTML = `
      <div class="lc-header" id="lc-drag-handle">
        <div class="lc-title">
          <span class="lc-badge">Laraigo</span> Copiloto
        </div>
        <div class="lc-actions">
          <button id="lc-toggle-auto" class="lc-btn-pill ${currentConfig.autoReplyActive ? 'active' : ''}" title="Activar/Desactivar Respuesta 100% Automática">
            🤖 Auto: <span id="lc-auto-status">${currentConfig.autoReplyActive ? 'ON' : 'OFF'}</span>
          </button>
          <button id="lc-btn-collapse" class="lc-btn-icon" title="Minimizar">_</button>
        </div>
      </div>
      <div class="lc-body" id="lc-body">
        <div class="lc-section-title">⚡ Respuestas Rápidas</div>
        <div class="lc-templates-grid" id="lc-templates-container">
          <!-- Se inyectan dinámicamente -->
        </div>

        <div class="lc-footer">
          <div class="lc-hint">💡 Clic simple: <b>Insertar</b> | Doble clic: <b>Insertar y Enviar</b></div>
        </div>
      </div>
    `;

    document.body.appendChild(container);

    // Eventos del widget
    const collapseBtn = container.querySelector('#lc-btn-collapse');
    const bodyEl = container.querySelector('#lc-body');
    const toggleAutoBtn = container.querySelector('#lc-toggle-auto');
    const autoStatus = container.querySelector('#lc-auto-status');

    collapseBtn.addEventListener('click', () => {
      bodyEl.classList.toggle('lc-collapsed');
      collapseBtn.innerText = bodyEl.classList.contains('lc-collapsed') ? '□' : '_';
    });

    toggleAutoBtn.addEventListener('click', () => {
      currentConfig.autoReplyActive = !currentConfig.autoReplyActive;
      toggleAutoBtn.classList.toggle('active', currentConfig.autoReplyActive);
      autoStatus.innerText = currentConfig.autoReplyActive ? 'ON' : 'OFF';
      chrome.storage.local.set({ laraigo_config: currentConfig });
      showToast(
        currentConfig.autoReplyActive ? "🤖 Auto-Respuesta ACTIVADA" : "⏸️ Auto-Respuesta en pausa",
        currentConfig.autoReplyActive ? "success" : "info"
      );
    });

    renderTemplates();
  }

  function renderTemplates() {
    const listContainer = document.getElementById('lc-templates-container');
    if (!listContainer) return;
    listContainer.innerHTML = '';

    currentConfig.templates.forEach((tpl) => {
      const btn = document.createElement('button');
      btn.className = 'lc-tpl-btn';
      btn.title = formatTemplateText(tpl.text);
      btn.innerHTML = `<span class="lc-tpl-name">${tpl.title}</span>`;

      // Clic simple: rellenar campo
      let clickTimeout;
      btn.addEventListener('click', () => {
        clickTimeout = setTimeout(() => {
          insertReply(tpl.text, false);
        }, 200);
      });

      // Doble clic: rellenar y enviar de inmediato
      btn.addEventListener('dblclick', () => {
        clearTimeout(clickTimeout);
        insertReply(tpl.text, true);
      });

      listContainer.appendChild(btn);
    });
  }

  function updateUI() {
    const toggleAutoBtn = document.getElementById('lc-toggle-auto');
    const autoStatus = document.getElementById('lc-auto-status');
    if (toggleAutoBtn && autoStatus) {
      toggleAutoBtn.classList.toggle('active', currentConfig.autoReplyActive);
      autoStatus.innerText = currentConfig.autoReplyActive ? 'ON' : 'OFF';
    }
    renderTemplates();
  }

  // Notificación tipo Toast
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
    }, 3200);
  }

})();
