# Laraigo Copilot - Soporte Técnicos de Campo Claro

Extensión de navegador (Google Chrome / Edge) diseñada específicamente para la mesa de soporte a técnicos en **Laraigo** (`claro.laraigo.com/message_inbox`).

---

## 🎯 Reglas de Submotivos Implementadas

Cada vez que se atiende un ticket, el mensaje base siempre es:  
`Hola Técnico, Procederemos con la atención`

Seguido de la instrucción exacta según el **Submotivo**:

| Submotivo | Mensaje enviado al Técnico |
| :--- | :--- |
| **Activaciones** | `Hola Técnico, Procederemos con la atención, enviar error de toa` |
| **Reenvío** | `Hola Técnico, Procederemos con la atención, enviar captura de reenvio desde su toa` |
| **Consulta de cintillos** | `Hola Técnico, Procederemos con la atención, enviar cintillos y foto del fat/tap` |
| **Registro mesh** | `Hola Técnico, Procederemos con la atención, enviar repetidor a activar` |
| **SOT de manto** | `Hola Técnico, Procederemos con la atención, ¿cuál es el motivo de la sot de manto?` |
| **Derivación a PEXT** | `Hola Técnico, Procederemos con la atención, enviar evidencias y motivo de la derivacion` |

---

## ⚡ Formas de uso

1. **Modo 1 Clic (Recomendado)**:
   - Abres el ticket del técnico en Laraigo.
   - El widget escaneará la pantalla y **resaltará en verde** el submotivo detectado.
   - Haces 1 clic sobre el botón del submotivo y el mensaje se escribe y se envía solo.

2. **Modo 100% Automático (`🤖 Auto: ON`)**:
   - Activas el interruptor **Auto** en el widget.
   - Cuando abres un ticket nuevo, la extensión detecta el submotivo y **envía el mensaje automáticamente tras 1.5 segundos**.

---

## 📦 Instalación en Google Chrome / Microsoft Edge

1. Descarga el ZIP desde tu repositorio GitHub:  
   👉 [https://github.com/AnGeLJoHnLl/Autoreply](https://github.com/AnGeLJoHnLl/Autoreply) (botón verde `<> Code` -> `Download ZIP`).
2. Descomprime la carpeta `Autoreply-main`.
3. Abre tu navegador y ve a `chrome://extensions` (o `edge://extensions`).
4. Activa el **Modo de desarrollador** (arriba a la derecha).
5. Haz clic en **"Cargar descomprimida"** y selecciona la carpeta descomprimida.
6. Entra a [https://claro.laraigo.com/message_inbox](https://claro.laraigo.com/message_inbox).
