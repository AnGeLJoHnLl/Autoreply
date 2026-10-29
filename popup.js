// Popup logic
document.addEventListener('DOMContentLoaded', () => {
  const agentNameInput = document.getElementById('agent-name');
  const autoReplyActiveCheckbox = document.getElementById('auto-reply-active');
  const autoReplyDelayInput = document.getElementById('auto-reply-delay');
  const templatesList = document.getElementById('templates-list');
  const rulesList = document.getElementById('rules-list');
  const btnAddTemplate = document.getElementById('btn-add-template');
  const btnAddRule = document.getElementById('btn-add-rule');
  const btnSave = document.getElementById('btn-save');
  const saveStatus = document.getElementById('save-status');

  let currentConfig = {
    agentName: "Asesor",
    autoReplyActive: false,
    autoReplyDelay: 2000,
    templates: [],
    rules: []
  };

  // Pestañas
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    });
  });

  // Cargar configuración existente
  chrome.storage.local.get(['laraigo_config'], (res) => {
    if (res.laraigo_config) {
      currentConfig = res.laraigo_config;
    }
    renderForm();
  });

  function renderForm() {
    agentNameInput.value = currentConfig.agentName || "";
    autoReplyActiveCheckbox.checked = !!currentConfig.autoReplyActive;
    autoReplyDelayInput.value = (currentConfig.autoReplyDelay || 2000) / 1000;

    renderTemplates();
    renderRules();
  }

  function renderTemplates() {
    templatesList.innerHTML = '';
    (currentConfig.templates || []).forEach((tpl, index) => {
      const card = document.createElement('div');
      card.className = 'item-card';
      card.innerHTML = `
        <div class="item-card-header">
          <input type="text" class="item-title-input tpl-title" value="${escapeHtml(tpl.title)}" placeholder="Nombre de plantilla">
          <button class="btn-delete" data-index="${index}">✕</button>
        </div>
        <textarea class="tpl-text" rows="2" placeholder="Texto de la plantilla">${escapeHtml(tpl.text)}</textarea>
      `;

      card.querySelector('.btn-delete').addEventListener('click', () => {
        currentConfig.templates.splice(index, 1);
        renderTemplates();
      });

      templatesList.appendChild(card);
    });
  }

  function renderRules() {
    rulesList.innerHTML = '';
    (currentConfig.rules || []).forEach((rule, index) => {
      const card = document.createElement('div');
      card.className = 'item-card';
      const kws = Array.isArray(rule.keywords) ? rule.keywords.join(', ') : rule.keywords;
      card.innerHTML = `
        <div class="item-card-header">
          <label style="font-size: 11px; font-weight: 600; color: #475569;">Si el cliente escribe:</label>
          <button class="btn-delete" data-index="${index}">✕</button>
        </div>
        <input type="text" class="rule-keywords" value="${escapeHtml(kws)}" placeholder="palabras separadas por comas" style="margin-bottom: 6px;">
        <textarea class="rule-reply" rows="2" placeholder="Respuesta automática enviada">${escapeHtml(rule.reply)}</textarea>
      `;

      card.querySelector('.btn-delete').addEventListener('click', () => {
        currentConfig.rules.splice(index, 1);
        renderRules();
      });

      rulesList.appendChild(card);
    });
  }

  btnAddTemplate.addEventListener('click', () => {
    currentConfig.templates = currentConfig.templates || [];
    currentConfig.templates.push({
      id: "tpl_" + Date.now(),
      title: "📌 Nueva Respuesta",
      text: "Hola, ¿en qué podemos ayudarte?"
    });
    renderTemplates();
  });

  btnAddRule.addEventListener('click', () => {
    currentConfig.rules = currentConfig.rules || [];
    currentConfig.rules.push({
      keywords: ["consulta", "ayuda"],
      reply: "Estamos listos para atenderte."
    });
    renderRules();
  });

  btnSave.addEventListener('click', () => {
    // Recoger valores del formulario
    currentConfig.agentName = agentNameInput.value.trim();
    currentConfig.autoReplyActive = autoReplyActiveCheckbox.checked;
    currentConfig.autoReplyDelay = parseFloat(autoReplyDelayInput.value) * 1000;

    // Recoger plantillas
    const tplCards = templatesList.querySelectorAll('.item-card');
    const updatedTemplates = [];
    tplCards.forEach((card, i) => {
      const title = card.querySelector('.tpl-title').value.trim();
      const text = card.querySelector('.tpl-text').value.trim();
      if (title && text) {
        updatedTemplates.push({
          id: currentConfig.templates[i]?.id || ("tpl_" + Date.now() + "_" + i),
          title,
          text
        });
      }
    });
    currentConfig.templates = updatedTemplates;

    // Recoger reglas
    const ruleCards = rulesList.querySelectorAll('.item-card');
    const updatedRules = [];
    ruleCards.forEach((card) => {
      const kwRaw = card.querySelector('.rule-keywords').value.trim();
      const reply = card.querySelector('.rule-reply').value.trim();
      if (kwRaw && reply) {
        const keywords = kwRaw.split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
        updatedRules.push({ keywords, reply });
      }
    });
    currentConfig.rules = updatedRules;

    // Guardar en chrome.storage.local
    chrome.storage.local.set({ laraigo_config: currentConfig }, () => {
      saveStatus.innerText = "✅ Cambios guardados correctamente";
      setTimeout(() => {
        saveStatus.innerText = "";
      }, 2500);
    });
  });

  function escapeHtml(string) {
    if (!string) return '';
    return String(string)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
});
