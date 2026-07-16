# TChat для Android

Тонкая обёртка (WebView), которая открывает хостируемый TChat как приложение.
По умолчанию грузит мобильный пульт: `http://195.62.49.244/widgets/remote.html`.

Адрес меняется в одном месте — `app/src/main/res/values/strings.xml`, строка
`server_url` (можно поставить свой домен или порт).

## Сборка APK

Нужен Android Studio (или Android SDK + JDK 17).

**Вариант 1 — Android Studio (проще):**

1. `File → Open` → выберите папку `android/`.
2. Дождитесь синхронизации Gradle (IDE сама скачает gradle wrapper и зависимости).
3. `Build → Build Bundle(s)/APK(s) → Build APK(s)`.
4. Готовый файл: `app/build/outputs/apk/release/app-release.apk`.

**Вариант 2 — из терминала:**

```bash
cd android
gradle wrapper          # один раз, создаёт ./gradlew
./gradlew assembleRelease
# APK: app/build/outputs/apk/release/app-release.apk
```

## Установка на телефон

Скиньте APK на телефон и установите (нужно разрешить установку из неизвестных
источников). Приложение откроет пульт TChat в полноэкранном WebView.

## Примечания

- Сейчас разрешён HTTP (cleartext) только для `195.62.49.244`. Если поменяете
  адрес — обновите и `network_security_config.xml`, и `strings.xml`.
- Как поднимете HTTPS-домен — можно перейти на полноценный TWA (иконка «как
  настоящее приложение», без адресной строки). Текущий WebView проще и работает по HTTP.
- `versionName` = 1.0.0, `versionCode` = 1 (в `app/build.gradle`).
