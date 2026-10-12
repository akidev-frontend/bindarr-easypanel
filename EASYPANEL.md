# Bindarr en EasyPanel

Guía para desplegar esta copia modificada de
[bindarr](https://github.com/thenotoriousJeremy/bindarr) en un VPS gestionado por
EasyPanel (Docker + Traefik).

---

## 1. Qué se arregló y por qué

Al revisar el código encontré **un fallo real de configuración para despliegues
con proxy** y varios problemas de despliegue. Están corregidos o cubiertos:

### 1.1. CORS bloqueaba el login detrás de un dominio (el fallo importante)

`backend/src/server.js` restringía CORS a orígenes locales/LAN o a los listados en
`CORS_ORIGIN`/`PUBLIC_BASE_URL`. Detrás de EasyPanel el navegador abre la app en
`https://tu-dominio` y, aunque frontend y API están **en el mismo dominio**, el
navegador envía cabecera `Origin` en cada escritura (`POST`/`PUT`/`DELETE`). Como
ese origen no era local ni estaba en la lista, el servidor respondía **403** — el
más visible, `POST /api/auth/login`, es decir, **no se podía ni iniciar sesión**
hasta configurar además `PUBLIC_BASE_URL` o `CORS_ORIGIN`.

**Arreglado**: ahora se reconoce el *mismo origen* comparando el `Origin` con el
host por el que llegó la petición (usando `X-Forwarded-Host` si el proxy lo
reescribe). Funciona con cualquier dominio, sin tener que declararlo antes.

### 1.2. Sin `TRUST_PROXY`, todos compartían el cupo de login

Express no confiaba en `X-Forwarded-For`, así que veía a todos los usuarios como
la IP del proxy. Los limitadores de peticiones (login: 20 intentos/15 min) se
agotaban entre todos. Se resuelve con `TRUST_PROXY=1` (ya incluido en la config de
EasyPanel de esta copia).

### 1.3. El listener HTTPS autofirmado sobra en EasyPanel

La imagen arranca por defecto un segundo listener en `3443` con certificado
autofirmado. En EasyPanel el TLS lo termina Traefik con un certificado real, así
que ese puerto no aporta nada y además genera certificados dentro del volumen. La
config de EasyPanel lo desactiva con `HTTPS_PORT=` (vacío). El **escaneo con
cámara sigue funcionando** por `https://<dominio>`: el navegador solo necesita un
contexto seguro, y lo aporta el certificado del proxy.

### 1.4. Build más ligero

`.dockerignore` ahora excluye `frontend/android`, `frontend/ios`, `docs` e
imágenes que el build de Docker no usa. En un VPS la diferencia de subida/copia
es notable.

### 1.5. Ficheros nuevos

- `docker-compose.easypanel.yml` — despliegue listo para EasyPanel (volumen,
  `TRUST_PROXY`, `HTTPS_PORT` vacío, puerto interno `3001`).
- `.env.easypanel.example` — plantilla de variables si despliegas como "App".

---

## 2. Requisitos del VPS

- Docker gestionado por EasyPanel.
- **Recomendado: 2 GB de RAM** (el build compila `sqlite3` desde fuente y usa
  Vite). En un VPS de 1 GB, activa swap antes de construir.
- Espacio en disco: ~2 GB para imagen + build, y lo que crezcan los catálogos de
  escaneo (unos 5 MB por cada 10 000 cartas).

---

## 3. Despliegue (recomendado: Compose)

1. En EasyPanel: **Create → Compose**.
2. Origen: tu repositorio/copia (GitHub o subida). Si usas el repo, la ruta del
   compose es **`docker-compose.easypanel.yml`**.
3. Variables (pestaña de entorno o `.env` que EasyPanel genere). Mínimo
   recomendado:
   - `PUBLIC_BASE_URL=https://cartas.tudominio.com` (recomendado para enlaces
     compartidos; el login ya funciona sin esto).
   - `DEFAULT_ADMIN_PASSWORD=...` (o déjalo vacío y crea la cuenta al primer
     acceso desde el navegador).
4. **Deploy**. EasyPanel construye la imagen y arranca el servicio.
5. En **Domains**, añade tu dominio apuntando al puerto interno **3001**.

## 3-bis. Despliegue alternativo: App con Dockerfile

1. **Create → App**, origen GitHub/Dockerfile (usa el `Dockerfile` del repo).
2. **Environment**: copia los valores de `.env.easypanel.example`.
   - Lo imprescindible es `HTTPS_PORT=` (vacío) y `TRUST_PROXY=1`.
3. **Mounts**: añade un volumen persistente montado en **`/app/database`**
   (imprescindible: ahí viven la base de datos, backups y catálogos).
4. **Domains**: un dominio apuntando al puerto interno **3001**.

> El contenedor arranca como root, hace `chown` del volumen a `node` y luego baja
> de privilegios con `gosu`. Si ves `EACCES` escribiendo la base de datos, revisa
> que el volumen esté montado en `/app/database` y que el entrypoint se ejecute
> (no fuerces un `user:` distinto en el servicio).

---

## 4. Primer acceso

- Abre `https://tu-dominio`. Si **no** definiste `DEFAULT_ADMIN_PASSWORD`, la
  primera visita te pide crear la cuenta `admin`.
- Si definiste `DEFAULT_ADMIN_PASSWORD`, entra con usuario `admin` y esa
  contraseña. Solo se aplica cuando aún no existe ningún usuario; cambiarla
  después no toca cuentas ya creadas.

---

## 5. Escaneo con cámara (opcional)

El escaneo necesita dos cosas que **no** vienen dentro de la imagen (los modelos
ONNX son AGPL-3.0 y Bindarr es MIT, así que se descargan aparte):

1. **Modelos** (~9,6 MB). En el VPS:

   ```sh
   docker exec bindarr node scripts/fetch-models.mjs
   # reinicia el contenedor después
   ```

2. **Catálogos**: en la app, **Admin → Catalogs**, elige juego e idioma y
   constrúyelo (tarda horas para un juego completo). También se pueden traer
   catálogos ingleses prehechos con `node scripts/fetch-models.mjs --catalogs`.

Sin catálogo, el escaneo devuelve un error claro (`503 notBuilt`) en vez de
adivinar. El resto de la app funciona igual.

---

## 6. Copias de seguridad

- La app hace un snapshot automático cada 24 h en `/app/database/backups`
  (conserva 10).
- Para una copia fuera del servidor, con el contenedor parado:

  ```sh
  docker run --rm -v bindarr-data:/data -v "$PWD":/backup alpine cp /data/bindarr.db /backup/
  ```

  (Ajusta el nombre del volumen al que cree EasyPanel si no usaste Compose.)

También puedes exportar/importar la colección por usuario como CSV o JSON desde la
app.

---

## 7. Variables de entorno útiles

| Variable | En EasyPanel | Para qué |
| --- | --- | --- |
| `PORT` | `3001` | Puerto HTTP interno. El dominio debe apuntar aquí. |
| `HTTPS_PORT` | *(vacío)* | Desactiva el HTTPS autofirmado; lo aporta Traefik. |
| `TRUST_PROXY` | `1` | IP real del cliente detrás de Traefik. |
| `PUBLIC_BASE_URL` | `https://tu-dominio` | Enlaces compartidos; origen CORS extra. |
| `CORS_ORIGIN` | *(opcional)* | Orígenes adicionales separados por comas. |
| `DEFAULT_ADMIN_PASSWORD` | *(opcional)* | Crea `admin` en el primer arranque. |
| `ALLOW_REGISTRATION` | *(opcional)* | `true` = registro público. |
| `DB_PATH` | `/app/database/bindarr.db` | Ruta de la base de datos. |
| `CV_MODEL_DIR` | `/app/database/models` | Modelos y catálogos de escaneo. |

Resto de variables (SSO/OIDC, proveedores Pokémon, precios, backups): ver el
`README.md` del repo.

---

## 8. Problemas típicos

| Síntoma | Causa / solución |
| --- | --- |
| `403 Origin not allowed` al iniciar sesión | Ya corregido en esta copia. Si actualizas desde el original, define `PUBLIC_BASE_URL` o `CORS_ORIGIN`. |
| `502` en el dominio | El dominio no apunta al puerto interno correcto; usa **3001**. |
| Se pierde todo tras un redeploy | Falta el volumen persistente en **`/app/database`**. |
| "Too many attempts" con pocos intentos | Falta `TRUST_PROXY=1`. |
| `EACCES`/base de datos de solo lectura | Volumen montado mal o `user:` forzado; ver sección 3-bis. |
| El escaneo no encuentra nada | Faltan modelos o catálogos; ver sección 5. |
| Build agotado / OOM | VPS con poca RAM; activa swap o construye en una máquina mayor y publica la imagen. |

---

## 9. Actualizar

Con Compose: **Rebuild/Deploy** desde EasyPanel. El volumen `bindarr-data` no se
toca, así que datos, backups y catálogos se conservan.

> Esta copia está basada en un commit del repositorio original. Si quieres traer
> cambios nuevos, haz `git pull` sobre esta carpeta y vuelve a desplegar; el
> arreglo de CORS está en `backend/src/server.js` y conviene revisar que siga
> presente tras resolver conflictos.
