# Laraigo Auto-Reply Copilot (Extensión de Navegador)

Extensión de navegador (Google Chrome / Microsoft Edge) diseñada para automatizar y agilizar la atención de mensajes en la bandeja de entrada de **Laraigo** (`claro.laraigo.com/message_inbox`).

---

## 🚀 Funcionalidades

1. **Widget Flotante Integrado**:
   - Se inyecta automáticamente en la esquina inferior derecha al abrir `claro.laraigo.com`.
   - **Clic simple**: Inserta la plantilla en la caja de texto sin enviar (para que el asesor agregue detalles).
   - **Doble clic**: Inserta y envía el mensaje de inmediato.
   - Botón para **minimizar / maximizar**.

2. **Modo 100% Automático**:
   - Detecta la llegada de mensajes entrantes del cliente mediante `MutationObserver`.
   - Si el mensaje contiene palabras clave configuradas (ej: *"hola"*, *"costo"*, *"planes"*, *"asesor"*), responde y envía automáticamente tras una demora configurable (para simular escritura humana).

3. **Panel de Control (Popup de la Extensión)**:
   - Configura el nombre del asesor (reemplaza automáticamente `{{agente}}` en las respuestas).
   - Administra plantillas de respuesta rápida.
   - Administra reglas de auto-respuesta por palabras clave.

---

## 📦 Instalación en Google Chrome o Microsoft Edge

1. Abre tu navegador y dirígete a:
   - En Chrome: `chrome://extensions`
   - En Edge: `edge://extensions`
2. Activa el **Modo de desarrollador** (interruptor en la esquina superior derecha).
3. Haz clic en el botón **"Cargar descomprimida"** (o *Load unpacked*).
4. Selecciona la carpeta donde está este proyecto:
   `C:\Users\alexa\.gemini\antigravity\scratch\laraigo-auto-reply-extension`
5. ¡Listo! La extensión ya estará activa.

---

## 🛠️ Cómo usarla

1. Inicia sesión en [https://claro.laraigo.com/message_inbox](https://claro.laraigo.com/message_inbox).
2. Verás el widget **Laraigo Copiloto** en la esquina inferior derecha.
3. Haz clic en el icono de la extensión en la barra de herramientas para personalizar tus respuestas o cambiar tu nombre de asesor.
