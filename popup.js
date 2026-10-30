// Popup: Control de Activo / No activo y Selector de Modo (Solo Saludo vs Completo BETA)
document.addEventListener('DOMContentLoaded', () => {
  const statusBanner = document.getElementById('status-banner');
  const statusText = document.getElementById('status-text');
  const btnSetActive = document.getElementById('btn-set-active');
  const btnSetInactive = document.getElementById('btn-set-inactive');
  const btnModeGreeting = document.getElementById('btn-mode-greeting');
  const btnModeBeta = document.getElementById('btn-mode-beta');
  const hintText = document.getElementById('hint-text');

  let currentTabId = null;
  let isTabActive = true;
  let currentMode = 'greeting_only';

  function updateUI(active) {
    isTabActive = active;
    if (active) {
      statusBanner.className = 'status-banner active';
      statusText.innerText = 'ACTIVO';
      btnSetActive.classList.add('selected');
      btnSetInactive.classList.remove('selected');
      hintText.innerText = 'Copiloto activo en esta pestaña.';
    } else {
      statusBanner.className = 'status-banner inactive';
      statusText.innerText = 'NO ACTIVO';
      btnSetInactive.classList.add('selected');
      btnSetActive.classList.remove('selected');
      hintText.innerText = 'Copiloto desactivado en esta pestaña.';
    }
  }

  function updateModeUI(mode) {
    currentMode = mode === 'full_beta' ? 'full_beta' : 'greeting_only';
    if (btnModeGreeting && btnModeBeta) {
      btnModeGreeting.classList.toggle('selected', currentMode === 'greeting_only');
      btnModeBeta.classList.toggle('selected', currentMode === 'full_beta');
    }
  }

  function applyModeToTab(mode) {
    updateModeUI(mode);
    chrome.storage.local.set({ laraigo_copilot_mode: mode });
    if (!currentTabId) return;
    chrome.tabs.sendMessage(currentTabId, { type: 'SET_OPERATION_MODE', mode }, () => {
      void chrome.runtime.lastError;
    });
  }

  function applyStateToTab(active) {
    updateUI(active);
    if (!currentTabId) return;

    chrome.tabs.sendMessage(currentTabId, { type: 'SET_TAB_STATUS', active }, (res) => {
      if (chrome.runtime.lastError || !res) {
        // Fallback por si la pestaña no se había recargado aún
        if (chrome.scripting) {
          chrome.scripting.executeScript({
            target: { tabId: currentTabId },
            func: (shouldBeActive) => {
              sessionStorage.setItem('laraigo_copilot_tab_disabled', shouldBeActive ? 'false' : 'true');
              const mainWidget = document.getElementById('laraigo-copilot-container');
              const miniPill = document.getElementById('laraigo-disabled-pill');
              if (mainWidget) mainWidget.style.display = shouldBeActive ? 'block' : 'none';
              if (miniPill) miniPill.style.display = shouldBeActive ? 'none' : 'flex';
            },
            args: [active]
          }).catch(() => {});
        }
      }
    });
  }

  chrome.storage.local.get(['laraigo_copilot_mode'], (res) => {
    if (res && (res.laraigo_copilot_mode === 'greeting_only' || res.laraigo_copilot_mode === 'full_beta')) {
      updateModeUI(res.laraigo_copilot_mode);
    }
  });

  // Consultar el estado actual de la pestaña activa
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const activeTab = tabs && tabs[0];
    if (!activeTab || !activeTab.id) {
      hintText.innerText = 'Abre una pestaña de Laraigo primero.';
      return;
    }

    currentTabId = activeTab.id;

    chrome.tabs.sendMessage(currentTabId, { type: 'GET_TAB_STATUS' }, (res) => {
      if (!chrome.runtime.lastError && res && typeof res.active === 'boolean') {
        updateUI(res.active);
        if (res.mode) updateModeUI(res.mode);
      } else if (chrome.scripting) {
        chrome.scripting.executeScript({
          target: { tabId: currentTabId },
          func: () => sessionStorage.getItem('laraigo_copilot_tab_disabled') !== 'true'
        }).then((results) => {
          if (results && results[0]) {
            updateUI(Boolean(results[0].result));
          }
        }).catch(() => {});
      }
    });
  });

  btnSetActive.addEventListener('click', () => {
    applyStateToTab(true);
  });

  btnSetInactive.addEventListener('click', () => {
    applyStateToTab(false);
  });

  if (btnModeGreeting) {
    btnModeGreeting.addEventListener('click', () => {
      applyModeToTab('greeting_only');
    });
  }

  if (btnModeBeta) {
    btnModeBeta.addEventListener('click', () => {
      applyModeToTab('full_beta');
    });
  }

  statusBanner.style.cursor = 'pointer';
  statusBanner.addEventListener('click', () => {
    applyStateToTab(!isTabActive);
  });
});
