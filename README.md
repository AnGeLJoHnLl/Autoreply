# Laraigo Auto-Reply Copilot (v2.0.0) - Soporte Técnicos de Campo Claro

Extensión para Google Chrome / Microsoft Edge diseñada para la bandeja de atención de **Laraigo** (`https://claro.laraigo.com/message_inbox`).

---

## ✨ Novedades de la versión 2.0.0

- **2 Modos de Operación Configurables (desde el panel flotante o desde el icono de la extensión):**
  1. **🔔⚡ Modo 1: Solo Notificación + Saludo Instantáneo (`0s`):**
     - Lanza la notificación nativa de Windows apenas cae un ticket nuevo en `Asignados` (1 sola vez por ticket) y envía **únicamente el 1° saludo instantáneo** (`"Hola Técnico, Procederemos con la atención"`) en 2° plano sin enviar segundas respuestas automáticas.
     - Mantiene el panel limpio ocultando las opciones de segundas respuestas.
  2. **🧠 Modo 2: Modo Completo + 2° Respuestas Inteligentes (`BETA`):**
     - Identificado con la insignia **`BETA`**, habilita el panel completo con el detector de `Submotivo:`, capturas TOA, cintillos y botones de segundas respuestas.
     - Ejecuta el flujo completo 100% en 2° plano por API: **Notificación Windows + 1° Saludo (`0s`) ➔ Espera de `5s` ➔ Análisis de evidencias ➔ 2° Respuesta automática** sin cambiar de chat ni scrollear.
- **Minimizado Ultra-Compacto en "Un Cuadrito" (`46px × 46px`):**
  - Al pulsar el botón de minimizar (`🗕`), el panel se convierte en un **cuadrito flotante de `46px × 46px`** para no ocupar espacio en pantalla.
  - Muestra un indicador luminoso de estado (`🟢`), el modo activo (`1°` o `BETA`), se puede **arrastrar a cualquier esquina** y con **un clic** vuelve a desplegar el panel completo.
- **Atención 100% Automática en 2° Plano (API + Socket.IO) sin cambiar de chat ni recargar la página.**
- **Control Independiente por Pestaña (`🟢 Activo` / `🔴 No activo`).**

---

## 🎯 Reglas Inteligentes por `Submotivo:` (Modo Completo `BETA`)

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
4. Haz clic en **"Cargar descomprimida"** y selecciona la carpeta descomprimida (o presiona **🔄 Recargar** y verifica que muestre **v2.0.0**).
5. Recarga tu pestaña de Laraigo (`F5`).
