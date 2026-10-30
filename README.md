# Laraigo Auto-Reply Copilot (v1.9.0) - Soporte Técnicos de Campo Claro

Extensión para Google Chrome / Microsoft Edge diseñada para la bandeja de atención de **Laraigo** (`https://claro.laraigo.com/message_inbox`).

---

## ✨ Novedades de la versión 1.9.0

- **Atención 100% Automática sin Entrar al Ticket (2° Plano por API + Socket.IO):**
  - **No necesitas hacer clic ni entrar al ticket** para que se notifique o se responda. Puedes quedarte trabajando en tu ticket actual en la misma pestaña sin que cambie de conversación ni mueva tu scroll.
  - Detecta la llegada de nuevos tickets en `Asignados` en tiempo real mediante `Socket.IO` y sondeo directo de `UFN_CONVERSATION_SEL_TICKETSBYUSER` (filtrando estrictamente `status === "ASIGNADO"`).
- **Notificación Nativa de Windows al Instante (Sin entrar al ticket):**
  - Apenas cae un ticket en `Asignados`, lanza la notificación de Windows con el número de ticket y nombre del técnico (con filtro estricto de **1 sola vez por ticket**).
- **Envío Automático en 2 Pasos (0s + 5s) sin pulsar botones:**
  1. **Paso 1 (`0s` inmediato):** Envía `"Hola Técnico, Procederemos con la atención"` directo a `POST https://claroapi.laraigo.com/api/ticket/reply`.
  2. **Paso 2 (`5s` de espera en 2° plano):** Espera 5 segundos para que terminen de llegar las imágenes, videos o cintillos del técnico.
  3. **Paso 3:** Consulta por API (`POST https://claroapi.laraigo.com/api/multi`) el `Submotivo:`, la `SOT`, los cintillos y las fotos enviadas, y manda automáticamente el **2° mensaje exacto**.
- **Control Independiente por Pestaña (`🟢 Activo` / `🔴 No activo`):**
  - La auto-atención en segundo plano arranca **encendida por defecto** en cualquier pestaña que esté en `🟢 Activo`. Puedes apagarla en una pestaña específica cambiando a `🔴 No activo`.

---

## 🎯 Reglas Inteligentes por `Submotivo:`

| Submotivo | Con Evidencia / Captura | Sin Evidencia / Captura |
| :--- | :--- | :--- |
| **1. Activaciones** | Si envió captura de pantalla móvil (TOA): **`un momento`** *(ignora fotos de equipos)* | **`enviar error de toa`** |
| **2. Reenvío de señal** | Si envió captura de pantalla móvil (TOA): **`un momento`** *(ignora fotos de equipos)* | **`enviar captura de reenvio desde su toa`** |
| **3. Registro de mesh** | Si envió foto del repetidor: **`Un momento`** | **`Enviar imagen del repetidor`** |
| **4. Consulta de cintillos** | • Foto + Cintillos: **`Un momento`**<br>• Solo Cintillos (sin foto): **`Enviar captura de imagen de Fat/Tap`**<br>• Solo Foto (sin cintillos): **`Enviar cintillos`** | **`Enviar captura de imagen de Fat/Tap y cintillos`** |
| **5. SOT de manto** | Si envió video, foto o texto explicando motivo: **`Se revisa`** | **`Enviar motivo de sot de manto`** |
| **6. Derivación a PEXT** | Si envió fotos o videos de evidencia: **`Se revisa`** | **`Enviar evidencias porfavor`** |

---

## 📦 Instalación / Actualización en Chrome o Edge

1. Entra a tu repositorio: 👉 [https://github.com/AnGeLJoHnLl/Autoreply](https://github.com/AnGeLJoHnLl/Autoreply)
2. Haz clic en el botón verde **`<> Code`** ➔ **`Download ZIP`** y descomprime la carpeta.
3. Abre `chrome://extensions` (o `edge://extensions`) con el **Modo de desarrollador** activo.
4. Haz clic en **"Cargar descomprimida"** y selecciona la carpeta descomprimida (o presiona **🔄 Recargar** y verifica que muestre **v1.9.0**).
5. Recarga tu pestaña de Laraigo (`F5`).
