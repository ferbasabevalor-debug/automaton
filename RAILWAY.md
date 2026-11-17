# Desplegar Automaton en Railway (sin terminal, desde el móvil)

Esta guía está pensada para alguien que **no programa**. Todo se hace desde el
navegador (Safari en el iPhone funciona).

> ⚠️ **Aviso importante sobre el dinero.** Este agente maneja una wallet real con
> dinero real y toma decisiones solo. Empieza con poco (5–10 USDC) y un tope de
> gasto diario bajo. Puede perder todo lo que le envíes.

---

## 1. Qué hace el agente, en cristiano

- Es un programa que **piensa y actúa solo, sin parar**: usa una IA (tipo ChatGPT)
  para decidir qué hacer, ejecuta comandos, escribe código, y vuelve a pensar.
- Tiene **su propia wallet** (cuenta de criptomonedas). Al arrancar por primera vez
  la crea él solo.
- **Gasta** dinero en: la IA que usa para pensar (lo más habitual), servidores,
  dominios web y, si lo decide, en crear "hijos" (copias de sí mismo).
- **Gana** dinero solo si consigue vender algo útil (un servicio, una API, una web…)
  y alguien le paga en USDC. **Nada garantiza que gane dinero.**
- Paga casi todo con **créditos de Conway** (la empresa que ofrece la IA y los
  servidores). Esos créditos los compra él mismo con el **USDC** de su wallet.
- Si se queda sin dinero, entra en modo ahorro y al final se "muere" (se queda parado).

---

## 2. Variables de entorno (las "claves" y ajustes)

Se ponen en Railway → tu servicio → pestaña **Variables**.

### Obligatorias

| Nombre exacto | Para qué sirve | Dónde se consigue |
|---|---|---|
| `AUTOMATON_GENESIS_PROMPT` | La misión del agente: qué tiene que hacer. Texto libre. | Lo escribes tú. Ejemplo abajo. |
| `AUTOMATON_CREATOR_ADDRESS` | **Tu** dirección de wallet (la del dueño). Queda registrada como creador del agente. | Tu app de wallet (Coinbase Wallet, MetaMask, Rainbow…): "Recibir" → copiar dirección. Empieza por `0x`. |

### Recomendadas

| Nombre exacto | Para qué sirve | Valor por defecto |
|---|---|---|
| `AUTOMATON_NAME` | Nombre del agente. | `automaton` |
| `MAX_DAILY_SPEND_USD` | **Tope de gasto diario en dólares.** Al llegar, el agente se duerme hasta las 00:00 UTC (las 01:00/02:00 en España). | `2` |

### Opcionales

| Nombre exacto | Para qué sirve | Dónde se consigue |
|---|---|---|
| `CONWAY_API_KEY` | Clave para usar Conway. **No hace falta**: el agente la consigue solo firmando con su wallet. Ponla solo si en los logs ves que no puede obtenerla. | https://app.conway.tech |
| `OPENAI_API_KEY` | Usar tu propia cuenta de OpenAI en vez de pagar la IA con créditos de Conway. | https://platform.openai.com/api-keys |
| `ANTHROPIC_API_KEY` | Igual, con tu cuenta de Anthropic (Claude). | https://console.anthropic.com |
| `AUTOMATON_INFERENCE_MODEL` | Qué modelo de IA usa. | Por defecto `gpt-5.2`. |
| `AUTOMATON_CHAIN` | `evm` (red Base, por defecto) o `solana`. **Déjalo en `evm`**: en Solana el agente no puede comprarse créditos solo. | — |
| `WALLET_PRIVATE_KEY` | Avanzado: usar una wallet que ya tengas en vez de crear una nueva. Solo se usa la primera vez. **Mejor no tocarla.** | — |
| `CONWAY_API_URL`, `AUTOMATON_RPC_URL`, `SOLANA_RPC_URL`, `OLLAMA_BASE_URL` | Avanzado: servidores alternativos. | — |

Variables que pone el proyecto o Railway automáticamente (no las toques):
`HOME=/data`, `AUTOMATON_NONINTERACTIVE=true`, `RAILWAY_VOLUME_MOUNT_PATH`.

Ejemplo de `AUTOMATON_GENESIS_PROMPT`:

```
Eres un agente que ofrece un servicio útil y honesto por el que otros quieran pagar
en USDC. Empieza pequeño, gasta lo mínimo y explica en tus notas lo que haces.
```

---

## 3. Qué cambia respecto al proyecto original

- **Sin preguntas**: en Railway no hay teclado, así que el primer arranque se
  configura solo con las variables de arriba.
- **Instrucciones de fondeo en los logs**: en cada arranque se imprime la dirección
  de la wallet, el token (USDC) y la red (Base). Nunca se imprime la clave privada.
- **Tope de gasto diario** (`MAX_DAILY_SPEND_USD`): suma lo gastado en IA,
  transferencias, pagos y fondos a hijos. Además limita las recargas de créditos:
  como máximo el tope o 5 $ al día (lo que sea mayor), porque 5 $ es la recarga mínima.
- **Protección de la wallet**: si no hay un volumen persistente, el agente **no**
  crea la wallet y te avisa en los logs (si no, se perdería en cada despliegue
  junto con el dinero).
- **Secretos fuera del repo**: `.gitignore`, `.dockerignore` y un escaneo automático
  (gitleaks) en GitHub impiden subir claves por error. Las claves que pongas en
  Railway no se copian al disco.

---

## 4. Limitaciones que debes conocer

- En Railway el agente **no está dentro de un "sandbox" de Conway**: ejecuta sus
  comandos dentro del propio contenedor de Railway, y cuando "expone un puerto"
  la dirección que obtiene es `localhost` (no pública). Para ofrecer servicios al
  público tendría que crear un sandbox de Conway (cuesta créditos).
- El tope diario cubre el bucle principal y las herramientas que mueven dinero.
  Algunas llamadas internas secundarias de IA (resúmenes de memoria, trabajadores
  en paralelo) pueden no contabilizarse con exactitud: deja margen.
- Railway cobra aparte (plan Hobby, unos 5 $/mes). Eso no lo paga el agente.
- La clave privada vive solo en el volumen de Railway. Si borras el volumen o el
  proyecto, **pierdes la wallet y su dinero**. No guardes allí más de lo que
  estés dispuesto a perder.

---

## 5. Pasos en Railway

1. Railway → New Project → Deploy from GitHub repo → elige este repo.
2. **Importante (monorepo):** este repo tiene un subpaquete auxiliar (`packages/cli`)
   y Railway puede crear solo un servicio llamado `@conway/automaton-cli` con
   Builder "Railpack". Ese **no** es el agente. En su pestaña **Settings** deja:
   - **Root Directory**: vacío (o `/`)
   - **Config as Code → Railway Config File**: `/railway.json` (con la barra inicial)
   - **Builder**: `Dockerfile`
   - **Custom Build Command**, **Custom Start Command** y **Watch Paths**: vacíos
   - Nombre del servicio (arriba del todo): por ejemplo `automaton`
3. Añade las variables obligatorias.
4. Añade un Volume con mount path `/data`.
5. Abre los logs, copia la dirección de la wallet y envíale USDC **en la red Base**.

Para saber si está bien: en los logs de **build** debe aparecer "Using Detected
Dockerfile" o pasos `RUN apt-get`/`pnpm build`, y en los de **deploy** la línea
"Conway Automaton v0.2.1 starting...". Si ves `pnpm --filter @conway/automaton-cli`,
sigue usando la configuración equivocada.
