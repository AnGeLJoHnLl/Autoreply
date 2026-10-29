// Background Service Worker para analizar imágenes de Laraigo sin bloqueo CORS
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "fetchImageAsDataUrl" && request.url) {
    fetch(request.url, { credentials: "include" })
      .then(response => response.blob())
      .then(blob => {
        const reader = new FileReader();
        reader.onloadend = () => {
          sendResponse({ ok: true, dataUrl: reader.result });
        };
        reader.onerror = () => {
          sendResponse({ ok: false });
        };
        reader.readAsDataURL(blob);
      })
      .catch(() => {
        sendResponse({ ok: false });
      });
    return true; // Respuesta asíncrona
  }
});
