# Bindarr — AI Context (Quick Understanding)

> Archivo guía para que cualquier IA entienda rápidamente qué es, cómo está construido y cómo operar con este código.

## ¿Qué es Bindarr?

**Bindarr** es un gestor self-hosted de colecciones de cartas coleccionables, multi-juego y multi-usuario. Soporta **Pokémon**, **Magic: The Gathering** y **Disney Lorcana**. Permite buscar, escanear con cámara, organizar por ubicación física (binders/paginas/slots y cajas/filas), gestionar decks, valorar la colección con precios en tiempo real, importar/exportar CSV/JSON, compartir colecciones públicamente y autenticarse vía sesión o OIDC/SSO.

- **Stack**: React 18 + Vite (frontend SPA) · Node.js + Express + SQLite (backend) · Docker disponible
- **Versión actual**: 1.8.7 (Unreleased en CHANGELOG)
- **Licencia**: MIT (modelos de escaneo ONNX son AGPL-3.0 y NO están incluidos)
- **Repo original**: thenotoriousJeremy/bindarr — este directorio es un port no oficial para EasyPanel/Docker

---

## Estructura del Repositorio (resumen)

```
bindarr/
├── backend/              # Express + SQLite (CommonJS)
│   ├── src/server.js     # Entry point: middleware, rutas, trabajos en background
│   ├── src/db.js         # Conexión SQLite, esquemas, migraciones, transacciones
│   ├── src/routes/       # 12 routers Express (auth, collection, storage, decks, etc.)
│   ├── src/middleware/   # Autenticación Bearer + API key, rate limits
│   ├── src/utils/        # 23+ helpers compartidos (proveedores, precios, idiomas, etc.)
│   ├── src/*.js          # Clientes de API externos (tcgApi, scryfallApi, tcgexchange, etc.) + utils/visionApi.js
│   ├── test/             # Tests unitarios (46 archivos) + E2E (6 archivos), node:test
│   └── scripts/          # Tareas de mantenimiento/operador (fetch-models, etc.)
├── frontend/             # React SPA (ESM/JSX, sin TypeScript)
│   ├── src/main.jsx      # Boot: native init, i18n, App
│   ├── src/App.jsx       # Root: auth state, tab navigation (8 tabs), fetch interceptor, toasts
│   ├── src/components/   # ~32 componentes React
│   ├── src/utils/        # 35+ utilidades + 8 tests (node:test)
│   ├── src/locales/      # 11 idiomas (BCP-47 JSON, lazy-loaded)
│   ├── src/demo/         # Fixtures para build demo (VITE_DEMO)
│   └── scripts/          # copy-ort.mjs, check-locales.mjs (CI gate)
├── shared/               # Datos compartidos runtime: languages.json, cardOrder.json,
│                         # pokemonTranslations.json, lorcanaTranslations.json,
│                         # imgproc.mjs (procesamiento imagen), cardDetectPure.mjs (detector)
├── docs/                 # TRANSLATING.md, screenshots de la app
├── docker-compose.yml    # Build desde Dockerfile (no imagen precompilada)
├── docker-compose.easypanel.yml  # Optimizado para EasyPanel
├── Dockerfile            # Build multi-stage con npm ci
├── .env.example          # Todas las variables de entorno documentadas
├── AGENTS.md             # Guías de repo y convenciones (leyendo obligatoria)
├── PROJECT.md            # Arquitectura detallada y guía de desarrollo
├── README.md             # Instalación, features, despliegue (en español)
└── AI_CONTEXT.md         # ← Este archivo
```

---

## Arquitectura Rápida

### Flujo de datos general
```
Usuario → Frontend SPA (React/Vite, :5173) → /api/* → Express (:3001) → SQLite
                                                                    ↕
                                                           APIs externas:
                                                           TCGdex, Scryfall, Lorcast,
                                                           pokemontcg.io, TCGCSV, PSA,
                                                           PokemonPriceTracker, Cardmarket
```

### Backend — Punto de entrada: `backend/src/server.js`

**Secuencia de arranque:**
1. Carga `.env` → verifica directorio de modelos de escaneo escribible
2. Aplica CSP (Report-Only), CORS, límites de body
3. Inicializa DB → divide filas apiladas → sincroniza sets
4. Monta rutas en orden de seguridad (ver abajo)
5. Inicia jobs en background (horario/diario/semanal)

**Orden de montaje de rutas (importante — seguridad):**
```
/api/auth         → público (login, register, bootstrap, OIDC)
/api/shared       → público (colecciones compartidas)
/api/admin        → público + authenticateToken + requireAdmin
/api/card-art     → lecturas públicas, escrituras autenticadas
/api (catch-all)  → authenticateToken gate
  → collection, storage, stats, importExport, notes, sets, decks, settings
/models/cornelius.onnx → público (modelo de detección de esquinas)
/static            → SPA fallback (frontend/dist)
```

**Jobs en background:**
| Frecuencia | Tarea |
|---|---|
| Startup | DB init, dividir filas apiladas, sincronizar sets |
| Horario | Price sweeps (6 proveedores) |
| 30s post-startup | Catch-up sweeps (sin forzar) |
| 7 días | Refresh de sets, recarga de caché de sets |
| 24h (configurable) | Purgar sesiones expiradas, backup automático |

### Frontend — Punto de entrada: `frontend/src/main.jsx` → `frontend/src/App.jsx`

- **Sin router cliente**: navegación por tabs (8 tabs code-split con React.lazy)
- **Sin Redux**: estado local con useState/useEffect, Context solo para i18n
- **Persistencia**: localStorage para token, usuario, theme, idioma, moneda
- **Interceptor fetch global**: inyecta `Authorization: Bearer <token>` en /api/*, dispara logout en 401
- **Rutas públicas**: `/share/:token` (colección compartida sin auth)
- **Hydratación de i18n**: 11 idiomas lazy-loaded via `import.meta.glob`
- **Capacitor**: shells Android/iOS; `apiBase.js` reescribe /api al servidor nativo

---

## Modelo de Datos SQLite (tablas principales)

| Tabla | Propósito clave |
|---|---|
| `users` | usuario, password_hash (PBKDF2 210k iters), role (admin/member), share_token, api_key (read-only) |
| `sessions` | token, user_id, expires_at — auth Bearer |
| `card_cache` | **Una fila por carta normalizada** de cualquier proveedor: name, printed_name, language, set_id, number, image_url, prices, game |
| `collection` | **Una fila por copia física**: card_id, quantity=1, condition, printing, language, location_id, compartment_id, position, purchase_price, game, grader/grade/cert_number, market_value |
| `locations` | Contenedores físicos (binder/box/etc.) con reglas de ordenamiento |
| `compartments` | Páginas/filas dentro de un location |
| `decks` | Mazos con checkout/check-in tracking |
| `sets` | Catálogo de sets por juego |
| `price_history` | Snapshots de precios por card_id + timestamp |
| `psa_cert` | Lookup de certificados PSA (graded slabs) |
| `notes` | Notas del usuario (título, cuerpo, pinned) |
| `pokemontcgapi_cache` | Cache de respuestas de API (1024 entradas, ETag) |
| `app_settings` | Configuración global (provider, refresh_days, public_base_url, vision_base_url/model/api_key, etc.) |

**Identidad de entrada**: `collection.id` (`entry_id`) — nunca uses `card_id + position` para identificar una copia, colisiona entre compartimentos.

---

## Proveedores de Datos por Juego

| Juego | Proveedor(es) | Notas |
|---|---|---|
| Pokémon (inglés) | tcgApi (pokemontcg.io) — **deprecado, cierra 1 Mar 2027** | Requiere `POKEMON_TCG_API_KEY` |
| Pokémon (inglés) | pokemontcgapi.com (opt-in) | Requiere `POKEMONTCGAPI_KEY`, habilitado desde Admin |
| Pokémon (no-inglés) | tcgdexApi (TCGdex) | Default para nuevas instalaciones, **sin API key** |
| Magic: The Gathering | scryfallApi (Scryfall) | Único proveedor |
| Disney Lorcana | lorcastApi (Lorcast) | Único proveedor |
| Precios Pokémon | tcgcsvApi (TCGCSV) | TCGplayer mirror, sin API key |
| Precios MTG | Scryfall prices | USD o EUR |
| PSA certificados | psaApi | Cached forever |
| Precios slabs graduados | gradedPrices (PokemonPriceTracker) | Solo Pokémon, per-request |

**Regla de oro**: La decisión de proveedor Pokémon vive **solo** en `utils/pokemonProvider.js`. El dispatch de IDs de carta vive **solo** en `utils/cardApi.js`. No agregues branching por idioma en otros lugares.

---

## Escaneo de Cartas (Camera Scan)

El escaneo tiene dos mitades: **detección** (local) e **identificación** (IA de visión).

1. **Detección (local, en el navegador)**: el modelo ONNX `cornelius` (~3.2 MB, AGPL-3.0) corre con `onnxruntime-web` para encontrar las esquinas de la carta, dibujar el contorno en vivo y disparar el auto-captura. Se descarga con `node backend/scripts/fetch-models.mjs`. Sin él, el escáner no puede enfocar la carta.
2. **Identificación (servidor → IA generativa con visión)**: el cliente endereza la carta y sube el recorte a `POST /api/scan-match`. El backend llama a un endpoint **OpenAI-compatible `/chat/completions`** (`backend/src/utils/visionApi.js`) pidiéndole que identifique la carta y devuelva un JSON objetivo: `name`, `printed_name`, `set`, `set_code`, `number`, `language`, `game`, `rarity`, `confidence`.
3. **Resolución y guardado (igual que la app base)**: con esa identidad, el backend busca la impresión real en el proveedor del juego (`/api/search` internamente) y devuelve candidatos. El cliente los resuelve, re-expresa al idioma escaneado (`getPrintingInLang`) y guarda en `collection` por el camino normal. Si el modelo fue seguro **y** la impresión nombrada existe, se auto-agrega; si no, se muestra el selector.

**Configuración** (env con override en Admin → Instance Settings; en `app_settings`: `vision_base_url`, `vision_model`, `vision_api_key`):
- `VISION_BASE_URL` (default `https://api.openai.com/v1`)
- `VISION_MODEL` (default `gpt-4o-mini`)
- `VISION_API_KEY` (vacío = sin clave; un servidor local sin clave funciona solo con `VISION_BASE_URL`)

Ejemplos válidos: OpenAI, Azure OpenAI, OpenRouter, Groq, y servidores locales (Ollama, LM Studio, vLLM) que expongan `/chat/completions`. Sin `VISION_API_KEY` ni `VISION_BASE_URL`, `/api/scan-match` responde `503 notBuilt` (NO adivina).

`VISION_BASE_URL` acepta tanto la **base** (`https://api.deepseek.com` o `.../v1`) como el **endpoint completo** (`https://api.deepseek.com/chat/completions`); el backend no duplica la ruta. Si el proveedor falla (URL, clave o modelo mal), el endpoint responde `502` con el mensaje del proveedor en lugar de un `500` opaco.

**Nota de idioma**: el modelo devuelve el nombre en inglés (`name`) y el texto impreso (`printed_name`). La búsqueda se hace en inglés y el ganador se re-expresa al idioma escaneado antes de mostrarse.

### Cambio de sistema (Unreleased): de embeddings ONNX a IA de visión

El escaneo anterior usaba dos modelos ONNX (`cornelius` + `milo`) y **catálogos de embeddings** por (juego, idioma), construidos en el servidor. Eso se eliminó por completo:

- **Eliminado**: `backend/src/cvScan.js`, `backend/src/catalog.js`, `backend/src/tcgplayerCatalog.js`, `backend/src/utils/npz.js`, `frontend/src/components/CatalogPanel.jsx`, la ruta `/api/scan-sets`, las rutas `/api/admin/catalogs*` y `/api/admin/models/product-map`, el job de auto-actualización de catálogos y el calentamiento de modelos CV, y los scripts `build-catalog.mjs`, `build-cv-catalog.mjs`, `measure-scan-floor.js`.
- **Añadido**: `backend/src/utils/visionApi.js` (cliente OpenAI-compatible), columnas `vision_base_url` / `vision_model` / `vision_api_key` en `app_settings`, sección de configuración en Admin → Instance Settings, y `backend/test/visionapi.test.js` + `backend/test/live/vision.live.js`.
- **URL del endpoint**: `endpointUrl()` acepta la base o el endpoint completo `/chat/completions` (evita el 404 por doble ruta). Un fallo del proveedor devuelve `502 visionError` con el mensaje upstream, no un `500`.
- **`app_settings`**: sigue existiendo la tabla; las claves `scan_exclude_*` se conservan porque `cardSets.js` aún las lee al cachear sets.
- **`tcgplayer_product`**: la tabla y su escritura desde los proveedores (`tcgcsvApi`, `lorcastApi`, `scryfallApi`) se mantienen; solo se eliminó el *builder* del mapa de productos de TCGplayer.

Para probar el camino completo sin una clave real:

```sh
cd backend && node test/live/vision.live.js
```

Levanta un endpoint de IA falso (OpenAI-compatible) y el servidor HTTP real, y verifica que `/api/scan-match` llama a la IA, parsea el JSON, resuelve la carta, decide auto-add y devuelve `503 notBuilt` si no hay IA configurada.

Verificado también dentro de Docker: la imagen arranca `healthy`, `/api/settings` expone `vision_*` (sin devolver la clave), y con un endpoint de IA mock alcanzable por la red Docker el flujo completo funciona — `POST /api/scan-match` identifica con la IA, resuelve la impresión contra el proveedor y `POST /api/collection` guarda la copia. Las variables `VISION_BASE_URL` / `VISION_MODEL` / `VISION_API_KEY` están documentadas en `docker-compose.yml` y `.env.example`.

---

## Convenciones y Reglas de Negocio Críticas

1. **`position = slot * 1000`** — El slot humano se recupera con `Math.floor(position / 1000)`. Los gaps permiten reordenamiento manual. **Nunca asumas que un array index = slot.**
2. **Una carta = una fila en `collection`** — `quantity` siempre 1 para no-apilado. Apilamiento solo si `allow_stacking` en el location.
3. **Graded slabs nunca se apilan** — `cert_number` único por usuario.
4. **`name` vs `printed_name`**: `name` = searchable (inglés para TCGdex), `printed_name` = como aparece en la carta. Lógica que NO debe dividir por idioma (regla 4 copias deck, CSV export, marketplace links) lee `name` solamente.
5. **Precios nunca se convierten**: cada fila tiene `price_currency` y el UI muestra el símbolo correcto. Totales suman divisas tal cual.
6. **Autenticación**: todos los `/api/*` requieren Bearer token (sesión o API key read-only). API keys: `bnd_` prefijo, GET solamente. Admin requiere `role === 'admin'`.
7. **User-scoped**: todas las mutaciones usan `req.user.id` — nunca confiar en user ID del cliente.
8. **Juego-scoped**: nuevos campos de carta deben pasar por normalización tanto de `tcgApi.js` como de `scryfallApi.js`.
9. **Frontend ESLint**: `--max-warnings 0` — cualquier warning falla el build/lint.
10. **No auto-reload en backend**: cambiar backend requiere restart manual (`node src/server.js`), dev usa nodemon.

---

## Comandos de Desarrollo y Testing

```sh
npm run install:all         # npm install en root, backend/ y frontend/
npm run dev                 # Backend nodemon + Vite HTTPS dev (:5173)
npm run dev:backend         # Solo backend (nodemon, http://localhost:3001)
npm run dev:frontend        # Solo frontend (Vite, HTTPS)
npm run build:frontend      # Producción → frontend/dist
npm test                    # Backend unit + e2e + frontend utils/locales
npm start                   # Producción backend
```

```sh
cd backend && npm run test:e2e    # Solo E2E (servidores reales, SQLite temporal)
cd frontend && npm run lint       # ESLint --max-warnings 0 (CI gate)
cd frontend && npm run check:locales  # Valida traducciones
cd frontend && npm run preview    # Preview del build
```

**Tests**: Plain Node (`node:test`/`assert`), sin Jest/Vitest. Tests de backend usan SQLite temporal (set `DB_PATH` antes de importar).

---

## Configuración de Entorno (`.env.example`)

Variables más importantes:
| Variable | Default | Propósito |
|---|---|---|
| `PORT` | 3001 | API/frontend HTTP |
| `HTTPS_PORT` | 3443 | HTTPS (necesario para escaneo desde móvil) |
| `DB_PATH` | ./backend/database/bindarr.db | SQLite file |
| `POKEMON_TCG_API_KEY` | — | pokemontcg.io (deprecado) |
| `POKEMONTCGAPI_KEY` | — | pokemontcgapi.com (opt-in, servidor) |
| `PUBLIC_BASE_URL` | — | URL externa para share links + CORS |
| `DEFAULT_ADMIN_PASSWORD` | random | Crea admin al startup (solo si users vacío) |
| `ALLOW_REGISTRATION` | desactivado | Self-registration on/off |
| `TRUST_PROXY` | — | Saltos de proxy inverso |
| `OIDC_*` | — | SSO (Authelia, Authentik, Keycloak, etc.) |
| `CV_MODEL_DIR` | /app/database/models | Modelo de detección de esquinas (cornelius.onnx) |
| `VISION_BASE_URL` | https://api.openai.com/v1 | Endpoint OpenAI-compatible de la IA de visión |
| `VISION_MODEL` | gpt-4o-mini | Modelo de visión que identifica la carta |
| `VISION_API_KEY` | — | Clave de la IA de visión (un servidor local puede no necesitarla) |
| `BACKUP_INTERVAL_HOURS` | 24 | Backup automático |

---

## Patrones de Código que Debes Seguir

- **Backend (CommonJS)**: `express.Router()`, validar temprano, SQL parametrizado (`?`), try/catch, log contexto, retornar `{ error: '...' }`
- **Frontend (ESM/JSX)**: Function components + hooks estándar, `useT()` para traducciones, limpieza en `useEffect`
- **No duplicar lógica**: proveedores → `utils/pokemonProvider.js`, IDs de carta → `utils/cardApi.js`, idiomas → `utils/languages.js`, precios → `utils/priceHelpers.js`, posicionamiento → `utils/compartmentSort.js`
- **Styling**: Tokens CSS de `frontend/src/index.css` (`--bg-*`, `--text-*`, `--surface-*`, `--accent-*`, `.btn`), respetar `data-theme`
- **i18n**: Siempre `useT()` con claves estables, nunca texto literal en UI
- **Transacciones**: Usar `db.withTransaction()` para operaciones multi-step

---

## Archivos Clave (lectura prioritaria para entender el proyecto)

| Archivo | Por qué importa |
|---|---|
| `backend/src/server.js` | Composición de la app, middleware, montaje de rutas, jobs |
| `backend/src/db.js` | Esquema, migraciones, acceso SQL |
| `backend/src/routes/collection.js` | Ruta más grande: búsqueda, escaneo, CRUD, stats |
| `backend/src/utils/pokemonProvider.js` | La DECISIÓN única de proveedor Pokémon |
| `backend/src/utils/cardApi.js` | Dispatch de IDs por prefijo de proveedor |
| `backend/src/utils/compartmentSort.js` | Motor de ubicado físico y ordenamiento |
| `backend/src/utils/priceHelpers.js` | Resolución de precios, regla de "una fila, una divisa" |
| `backend/src/utils/visionApi.js` | Identificación de cartas por IA generativa con visión (endpoint OpenAI-compatible) |
| `frontend/src/App.jsx` | Root del frontend: auth, tabs, fetch interceptor |
| `frontend/src/main.jsx` | Boot sequence |
| `frontend/src/index.css` | Tokens CSS y temas |
| `frontend/src/utils/i18n.jsx` | Proveedor de traducciones |
| `.env.example` | Todas las variables de entorno |
| `AGENTS.md` | Convenciones y reglas del repositorio |
| `PROJECT.md` | Arquitectura detallada |

---

## Diagnóstico Rápido de Problemas

| Síntoma | Causa probable | Solución |
|---|---|---|
| Escaneo no funciona, 503 | Falta el detector o la IA de visión no está configurada | `node scripts/fetch-models.mjs` + configurar la IA de visión en Admin → Instance Settings |
| Login falla 403 tras proxy | CORS/BASE_URL mal configurado | Definir `PUBLIC_BASE_URL` o `CORS_ORIGIN` |
| Cartas sin imagen/precio | Proveedor sin API key o sin datos | Verificar configuración de proveedor en Admin |
| Error "pokemontcg.io deprecated" | Instalación vieja en proveedor obsoleto | Cambiar a TCGdex en Admin → Instance Settings |
| Frontend no conecta con backend | Vite proxy o puerto equivocado | Verificar `vite.config.js` proxy a :3001 |
| SQLite "database is locked" | WAL no checkpointed | Stop server, limpiar `-wal`/`-shm` o checkpoint manual |
| Lint falla | Warning ESLint | Corregir en archivo indicado (CI bloquea con warnings) |
