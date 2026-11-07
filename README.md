# BBA SMP Launcher

Лаунчер модового сервера BBA SMP в стиле сайта bba.dimon20k.ru.

- **Вход через свой сервер авторизации** (Drasl): игрок вводит ник и пароль с сайта сервера. Скины подтягиваются, токены хранятся зашифрованными, пароль не сохраняется. Вход через Microsoft тоже поддерживается и включается, если указать одобренный Client ID.
- **Установка игры**: Minecraft нужной версии, загрузчик модов (Fabric / Quilt / NeoForge / Forge) и Java от Mojang. Игрокам ничего ставить не нужно.
- **Модпак с сайта**: лаунчер докачивает новые и изменённые файлы, проверяет их sha1 и удаляет лишние моды. Без интернета запускается последняя скачанная сборка.
- **Новости с сайта**: отдельная вкладка; точка на вкладке появляется, когда выходит новая новость.
- **Подключение к серверу** сразу после загрузки игры, статус сервера и онлайн в шапке.
- **Настройки**: память, своя Java, размер окна, аргументы JVM, тёмная и светлая тема.

## Запуск

Двойной щелчок по **`Запустить лаунчер.bat`** — нужна только установленная папка `node_modules`.

Для разработки нужен Node.js 20 или новее:

```bash
npm install
npm start
```

Если после `npm install` Electron не запускается, выполните `node node_modules/electron/install.js`.

## Настройка — `launcher.config.json`

```json
{
  "serverName": "BBA SMP",
  "siteUrl": "https://bba.dimon20k.ru",
  "packUrl": "https://bba.dimon20k.ru/launcher/pack.json",
  "newsUrl": "https://bba.dimon20k.ru/launcher/news.json",
  "auth": {
    "yggdrasil": {
      "url": "https://auth.bba.dimon20k.ru/authlib-injector",
      "title": "Аккаунт BBA",
      "registerUrl": "https://auth.bba.dimon20k.ru/web/registration",
      "resetUrl": ""
    },
    "microsoftClientId": ""
  },
  "server": { "host": "bba.dimon20k.ru", "port": 25565 },
  "dataFolder": ".bba-smp"
}
```

| Поле | Что это |
|---|---|
| `packUrl` | Адрес `pack.json` сборки |
| `newsUrl` | Лента новостей: `news.json`, RSS или Atom |
| `auth.yggdrasil.url` | Адрес сервера авторизации. Для Drasl — `https://<домен>/authlib-injector`. Можно указать и просто домен, если сервер отдаёт заголовок `X-Authlib-Injector-API-Location` |
| `auth.yggdrasil.title` | Как называть аккаунт в интерфейсе |
| `auth.yggdrasil.registerUrl` / `resetUrl` | Ссылки «Регистрация» и «Забыли пароль?» в окне входа (пустые — кнопки скрыты) |
| `auth.microsoftClientId` | Client ID из Azure, одобренный Mojang. Пусто — кнопки входа через Microsoft нет |
| `server` | Адрес сервера, если его нет в `pack.json` |

Конфиг вшивается в собранный `.exe`, поэтому после изменения лаунчер нужно пересобрать.

## Сервер авторизации (Drasl) — инструкция для владельца сервера

[Drasl](https://github.com/unmojang/drasl) — сервер авторизации с открытым исходным кодом. В нём уже есть база игроков (`drasl.db`), регистрация через сайт, загрузка скинов и приглашения. Писать свою базу данных не нужно.

### 1. Установить Drasl

Ему нужны домен с HTTPS (например `auth.bba.dimon20k.ru`) и любая машина с Docker. Это не обязательно сервер Minecraft.

```bash
git clone https://github.com/unmojang/drasl.git
sudo cp -RTi ./drasl/example/docker /srv/drasl
cd /srv/drasl
# отредактировать config/config.toml (см. ниже)
docker compose up -d
```

Drasl слушает порт `25585`. Перед ним нужен обратный прокси с HTTPS (nginx или Caddy; вариант с Caddy лежит в `example/docker-caddy`).

Минимальный `config/config.toml`:

```toml
Domain = "auth.bba.dimon20k.ru"
BaseURL = "https://auth.bba.dimon20k.ru"
DefaultAdmins = ["ВашНик"]

[CreateNewPlayer]
Allow = true
RequireInvite = true   # регистрация только по приглашениям
```

При первом запуске Drasl выведет в лог ссылку-приглашение для первого аккаунта (`docker compose logs`). Зарегистрируйтесь по ней под ником из `DefaultAdmins`: это будет админ, он сможет выдавать приглашения остальным.

> Названия разделов конфига могут отличаться между версиями Drasl — сверяйтесь с `doc/configuration.md` в репозитории. Там же описан импорт существующих лицензионных аккаунтов с проверкой через скин (`ImportExistingPlayer`, `RequireSkinVerification`): так можно убедиться, что у игрока куплен Minecraft.

### 2. Настроить сервер Minecraft

1. Скачайте `authlib-injector.jar` (https://github.com/yushijinhun/authlib-injector/releases) и положите рядом с сервером.
2. Добавьте в команду запуска сервера аргумент **перед** `-jar`:
   ```
   java -javaagent:authlib-injector.jar=https://auth.bba.dimon20k.ru/authlib-injector -Xmx6G -jar fabric-server-launch.jar nogui
   ```
3. В `server.properties`:
   ```
   online-mode=true
   enforce-secure-profile=false
   ```
   `online-mode` остаётся `true`: сервер проверяет каждого игрока через Drasl, и под чужим ником без пароля не зайти. Белый список работает как обычно.

### 3. Вписать адрес в лаунчер

В `launcher.config.json` укажите `auth.yggdrasil.url` = `https://auth.bba.dimon20k.ru/authlib-injector` и `registerUrl`, затем пересоберите лаунчер.

### Как это работает

Лаунчер входит в Drasl по нику и паролю, получает токен и запускает игру с **authlib-injector**. Это javaagent, который заменяет адреса Mojang на ваш сервер авторизации; лаунчер скачивает его сам. Игра и сервер общаются с Drasl так же, как обычно с Mojang.

> Лицензия Minecraft требует, чтобы каждый игрок владел игрой. Лаунчер скачивает клиент с серверов Mojang для любого вошедшего игрока, поэтому выдавайте приглашения и добавляйте в белый список только тех, у кого Minecraft куплен.

## Новости

Положите на сайт файл по адресу `newsUrl`. Пример — [pack-example/news.json](pack-example/news.json):

```json
{
  "news": [
    {
      "id": "2026-11-06-update",
      "title": "Обновление сборки 1.2",
      "date": "2026-11-06T18:00:00+03:00",
      "tag": "Сборка",
      "image": "https://bba.dimon20k.ru/images/news/1.png",
      "url": "https://bba.dimon20k.ru/news",
      "text": "Первый абзац.\n\nВторой абзац."
    }
  ]
}
```

- Обязательны `title` и `date`. `tag`, `image`, `url` и `pinned` (закрепить сверху) — по желанию. Абзацы разделяются пустой строкой (`\n\n`). Вместо `text` можно передать `html`: лаунчер покажет его как обычный текст.
- Если на сайте уже есть RSS или Atom, укажите его в `newsUrl` — лаунчер его тоже понимает.
- Картинки грузятся только по `https`.
- Лаунчер обновляет ленту при запуске и каждые 10 минут. Без интернета показывает сохранённые новости.

## Модпак: как выкладывать и обновлять

1. Соберите папку так, как она должна выглядеть у игрока: `mods/`, при желании `config/`, `options.txt`.
2. Сгенерируйте `pack.json`:
   ```bash
   npm run build-pack -- ./modpack --mc 26.3 --loader fabric@0.20.1 --server bba.dimon20k.ru:25565
   ```
3. Загрузите содержимое папки вместе с `pack.json` на сайт так, чтобы он открывался по `packUrl`. Для `pack.json` лучше отключить кэширование (`Cache-Control: no-cache`).

Для обновления замените моды, перезапустите `build-pack` и снова загрузите файлы. У игроков появится кнопка «Обновить».

| Поле `pack.json` | Описание |
|---|---|
| `minecraft` | Версия игры, например `26.3` |
| `loader.type` / `loader.version` | `vanilla`, `fabric`, `quilt`, `neoforge`, `forge`. Для Fabric/Quilt версию можно не указывать |
| `server` | `{ host, port }` для автоподключения |
| `memory.recommended` | Рекомендуемая память, МБ |
| `jvmArgs` | Дополнительные аргументы JVM |
| `managedDirs` | Папки, из которых удаляются лишние файлы (по умолчанию `["mods"]`) |
| `files[]` | `path`, `url`, `sha1`, `size`, `name`; `keep: true` — скачивать, только если файла нет |

## Вход через Microsoft (необязательно)

Нужен Client ID приложения Azure, одобренный Mojang (https://aka.ms/mce-reviewappid). С личного аккаунта Microsoft без своего каталога Entra зарегистрировать приложение сейчас нельзя. Если ID появится, впишите его в `auth.microsoftClientId`, и в окне входа появится кнопка «Войти через Microsoft».

## Оформление

- **Логотип и иконка** делаются из `build/logo-source.webp`: скрипт перекрашивает розовый в цвет интерфейса и убирает фон вокруг круга.
  ```bash
  node_modules/electron/dist/electron.exe tools/make-icon.js
  ```
  Скрипт создаёт `build/icon.png` (иконка приложения и установщика), `src/renderer/assets/icon.png` (иконка окна) и `src/renderer/assets/logo.png` (логотип в шапке). Чтобы взять другой исходник, передайте путь к нему последним аргументом.
- **Цвета** лежат в переменных в начале `src/renderer/styles.css` (`--accent: #e0005a` и др.). Если меняете `--accent`, поменяйте и `ACCENT` в `tools/make-icon.js` и перезапустите скрипт.
- **Шрифт** сейчас Manrope (OFL). Чтобы поставить шрифт сайта, положите `.woff2` в `src/renderer/fonts/` и поменяйте `--font`.

## Сборка установщика

```bash
npm run dist
```

В `dist/` появятся установщик и portable-версия `.exe`. Без подписи Windows SmartScreen покажет предупреждение.

## Где лежат файлы у игрока

- `%APPDATA%\.bba-smp\` — Minecraft, библиотеки, Java, authlib-injector, игра (`game/`: моды, сохранения, логи).
- `%APPDATA%\BBA SMP Launcher\` — настройки и зашифрованные аккаунты.
- Логи: `game/logs/launcher-last.log` (вывод игры), `game/logs/latest.log`.

## Что проверено

- **Вход через сервер авторизации** (на тестовом сервере с API authlib-injector): вход, неверный пароль, обновление и истечение токена, скин. Запуск Minecraft 26.3 + Fabric с authlib-injector 1.2.8: игра вошла под ником с этого сервера и пошла подключаться к серверу.
- **Новости**: `news.json`, RSS, Atom, офлайн-кэш, пометка «новое».
- **Установка и синхронизация**: Minecraft 26.3, Fabric, Java, синхронизация модпака, упаковка в `.exe`.

**Не проверено:** работа с настоящим Drasl (его пока нет), вход через Microsoft, установка NeoForge/Forge.

## Структура

```
src/main/main.js       окно, IPC, сценарий «Играть»
src/main/yggdrasil.js  вход через сервер авторизации, authlib-injector
src/main/auth.js       вход через Microsoft
src/main/news.js       новости (JSON / RSS / Atom)
src/main/minecraft.js  установка версий, загрузчиков, Java; аргументы запуска
src/main/modpack.js    pack.json и синхронизация файлов
src/main/download.js   загрузка с проверкой sha1/sha256, повторами, таймаутами
src/main/status.js     пинг сервера
src/main/store.js      настройки и аккаунты
src/renderer/          интерфейс
tools/build-pack.mjs   генератор pack.json
```
