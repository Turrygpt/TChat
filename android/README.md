# TChat Live для Android

Нативное стрим-приложение (аналог Prism Live Studio) с функциями TChat:

- эфир с **камеры** телефона или с **экрана** (RTMP);
- переключение задней/фронтальной камеры, **фронталка картинкой-в-картинке**
  поверх задней (на телефонах с поддержкой одновременных камер, Android 11+);
- **чат и алерты TChat прямо в кадре** — телефон «прожигает» в поток страницу
  `widgets/mobile-overlay.html` с сервера TChat на ПК;
- пульт TChat (`remote.html`), чат для стримера шторкой, тестовый донат.

## Как это устроено

- Поток кодирует и отдаёт [RootEncoder](https://github.com/pedroSG94/RootEncoder)
  (`GenericStream`: Camera2 / MediaProjection → RTMP).
- Для оверлеев (чат/алерты) телефон и ПК должны быть в одной сети: адрес ПК
  вводится на главном экране (порт сервера TChat — 3000). Сам эфир идёт напрямую
  на площадку и от ПК не зависит.
- Назначения потока: Twitch, YouTube или свой RTMP-адрес (VK, Rutube и др.).
- Оверлей рендерится офскрин-WebView на VirtualDisplay и подмешивается
  GL-фильтром; запасной путь — растеризация WebView в Bitmap (~12 fps).

## Сборка APK

Нужен Android SDK + JDK 17 (подойдёт JBR из Android Studio).

```powershell
cd android
$env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr'
.\gradlew.bat assembleDebug     # APK: app/build/outputs/apk/debug/app-debug.apk
.\gradlew.bat assembleRelease   # подпись debug-ключом, как раньше
```

Или открыть папку `android/` в Android Studio и `Build → Build APK(s)`.

## Требования на телефоне

- Android 8.0+ (minSdk 26); захват звука приложений в эфир экрана — Android 10+;
  фронталка-PiP — Android 11+ и поддержка concurrent camera устройством.
- Разрешения: камера, микрофон, уведомления (foreground-сервисы эфира).

## Заметки

- Старая WebView-обёртка удалена; пульт остался экраном «Пульт TChat».
