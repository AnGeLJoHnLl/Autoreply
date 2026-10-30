// Popup: Control exclusivo de Activo / No activo para la pestaña actual
document.addEventListener('DOMContentLoaded', () => {
  const statusBanner = document.getElementById('status-banner');
  const statusText = document.getElementById('status-text');
  const btnSetActive = document.getElementById('btn-set-active');
  const btnSetInactive = document.getElementById('btn-set-inactive');
  const hintText = document.getElementById('hint-text');

  let currentTabId = null;
  let isTabActive = true;

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

  statusBanner.style.cursor = 'pointer';
  statusBanner.addEventListener('click', () => {
    applyStateToTab(!isTabActive);
  });
});
