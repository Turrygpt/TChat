# Обход только для YouTube и только для TChat

Цель: TChat достаёт YouTube (встроенный плеер, live-чат, метаданные) через обход DPI,
а **весь остальной трафик** (VK, Twitch, Rutube, DonationAlerts, localhost) идёт **напрямую**.
Обход включается **только для процесса TChat** — на систему и другие приложения не влияет.

## Как это устроено

- `youtube-proxy.json` — выключатель и адрес локального прокси.
- `src/net/ytProxy.js` — на старте TChat:
  - Chromium (плеер/iframe): PAC-правило `scripts/yt.generated.pac` — на прокси уходят только youtube-домены;
  - `youtube-chat` (axios) и метаданные (fetch) — проксируются только для youtube-хостов.
- `youtube-bypass/` — backend обхода (локальный HTTP-прокси `127.0.0.1:1080`).

Проксируемые домены: `youtube.com`, `youtu.be`, `youtube-nocookie.com`, `googlevideo.com`,
`ytimg.com`, `ggpht.com`, `youtubei.googleapis.com`.

## Установка (backend — твой VLESS через Xray)

Ничего скачивать вручную не нужно — **Xray ставится сам при первом запуске**.
`run-xray.bat` (его дёргает `start-with-youtube.bat`) при отсутствии `xray.exe`
запускает `install-xray.ps1`, который скачивает официальный `Xray-windows-64.zip`
с GitHub и распаковывает `xray.exe`, `geosite.dat`, `geoip.dat` в `youtube-bypass/`.

Конфиг уже готов: `youtube-bypass/xray-config.json` (собран из твоей vless-ссылки,
Reality / SNI `max.ru` / flow `xtls-rprx-vision`, наружу только YouTube).

Если авто-загрузка не сработает (нет доступа к GitHub), скачай `Xray-windows-64.zip`
вручную с https://github.com/XTLS/Xray-core/releases и положи `xray.exe`,
`geosite.dat`, `geoip.dat` в папку `youtube-bypass/`.

## Запуск

Одной кнопкой (поднимает прокси, затем TChat):

```
start-with-youtube.bat
```

Или вручную двумя окнами:

```
youtube-bypass\run-xray.bat   :: сначала прокси
start.bat                     :: затем TChat
```

## Проверка, что работает

1. В окне Xray нет ошибок, слушает `127.0.0.1:10810`.
2. В логе TChat при старте видно:
   `[ytProxy] Chromium: YouTube -> http://127.0.0.1:10810 (PAC), остальное DIRECT`
   Быстрая диагностика: `youtube-bypass\test-proxy.bat`.
3. Плеер/музыка с YouTube проигрываются без вечного буфера; live-чат подключается.
4. VK/Twitch/Rutube/DonationAlerts работают как раньше (они не проксируются).

## Смена vless-ссылки (без правки файлов)

В бэкофисе TChat: вкладка **Подключения → «Обход YouTube (VLESS)»**. Вставь новую
`vless://…`, нажми **Сохранить** — приложение само пересоберёт
`youtube-bypass/xray-config.json`. Затем перезапусти прокси (окно Xray) или TChat.

## Бесплатный backend без сервера — ByeDPI

VLESS платный. Бесплатная альтернатива — **ByeDPI**: локальный DPI-desync прокси
без сервера и оплаты (https://github.com/hufrea/byedpi). Он слушает тот же порт
`127.0.0.1:10810`, поэтому TChat менять не нужно — просто запусти его **вместо** Xray:

```
youtube-bypass\run-byedpi.bat
```

При первом запуске он сам скачает `ciadpi.exe` (через GitHub API) и стартует на
`127.0.0.1:10810`. Используй **либо** `run-xray.bat` (VLESS), **либо** `run-byedpi.bat`
(ByeDPI) — не оба сразу (один порт).

Если ютуб всё ещё буферит на дефолтных настройках, попробуй другие пресеты
десинхронизации ByeDPI, например:
```
ciadpi.exe -i 127.0.0.1 -p 10810 -e1 -An
ciadpi.exe -i 127.0.0.1 -p 10810 -s1+s -An
ciadpi.exe -i 127.0.0.1 -p 10810 -f-1 -An
```
Точный рабочий набор зависит от провайдера — перебери 2-3 варианта (флаги описаны
в README ByeDPI).

## Выключить обход (вернуть всё как было)

В `youtube-proxy.json` поставь `"enabled": false` (или сними галочку в бэкофисе)
и перезапусти TChat. Больше ничего удалять не нужно.
