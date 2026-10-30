# Laraigo Auto-Reply Copilot (v1.8.0) - Soporte Técnicos de Campo Claro

Extensión para Google Chrome / Microsoft Edge diseñada para la bandeja de atención de **Laraigo** (`https://claro.laraigo.com/message_inbox`).

---

## ✨ Novedades de la versión 1.8.0

- **Atención 100% en 2° Plano por API (Sin Scroll ni Cambio de Ticket):**
  - Puedes seguir trabajando y escribiendo en tu ticket actual en la misma pestaña sin que la pantalla salte, sin hacer scroll automático y sin que te cambie de conversación.
  - Lee el `Submotivo:`, la `SOT`, los cintillos y las imágenes directamente desde la API interna de Laraigo (`/api/multi`) y envía las respuestas por `/api/ticket/reply`.
- **Flujo en 2 Pasos (0s + 5s):**
  1. **Paso 1 (`0s` inmediato):** Apenas cae el ticket en `Asignados`, envía `"Hola Técnico, Procederemos con la atención"`.
  2. **Paso 2 (`5s` de espera en 2° plano):** Espera 5 segundos para que terminen de llegar fotos, videos o cintillos del técnico.
  3. **Paso 3:** Evalúa las evidencias y envía el 2° mensaje exacto según el `Submotivo:`.
- **Notificación Nativa de Windows (1 sola vez por Ticket):**
  - Muestra un aviso en la esquina de Windows cuando ingresa un ticket nuevo aunque estés en otra ventana o programa.
- **Control Independiente por Pestaña (`🟢 Activo` / `🔴 No activo`):**
  - Desde el ícono de la extensión en la barra del navegador o desde el encabezado del widget puedes encender o apagar la extensión únicamente en la pestaña actual.

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
4. Haz clic en **"Cargar descomprimida"** y selecciona la carpeta descomprimida (o presiona **🔄 Recargar** si ya la tenías instalada).
5. Recarga tu pestaña de Laraigo (`F5`).
