# Electron Fuses

Начиная с 0.18.0, сборка задаёт пять Fuses через `build.electronFuses` в `package.json`. Electron Builder применяет их к упакованному Electron до подписи приложения.

- `RunAsNode = false`: переменная `ELECTRON_RUN_AS_NODE` не превращает IDE в Node.js CLI. Приложение не использует `child_process.fork`; прежние Node-драйверы работают в `worker_threads`, JDBC — в отдельном процессе встроенной Java.
- `EnableNodeOptionsEnvironmentVariable = false`: Electron игнорирует `NODE_OPTIONS` и `NODE_EXTRA_CA_CERTS`. Корпоративные сертификаты нужно настраивать в профиле подключения или системном хранилище согласно выбранному драйверу. Существующие настройки CA, truststore и Java VM options не меняются.
- `EnableNodeCliInspectArguments = false`: отключены Node `--inspect`, `--inspect-brk` и включение Node inspector сигналом `SIGUSR1`.
- `EnableEmbeddedAsarIntegrityValidation = true`: Electron сверяет хеш заголовка `app.asar` с данными в macOS `Info.plist` или Windows PE resource, затем проверяет содержимое файлов по ASAR integrity metadata.
- `OnlyLoadAppFromAsar = true`: основной код загружается из `app.asar`; каталог `resources/app` и `default_app.asar` не используются как запасная точка входа.

## Проверки поставки

`tests/fuses-runtime.mjs` запускает **неизменённый релизный файл**. Тест проверяет отсутствие исполнения `NODE_OPTIONS --require`, игнорирование `ELECTRON_RUN_AS_NODE`, отсутствие Node inspector при переданном `--inspect-brk`, запуск интерфейса, запросы SQLite через Node worker и встроенные JDBC/JRE. Используются временные профили без секретов, без обращения к личному Keychain разработчика.

Для управления renderer в этом тесте используется локальный Chromium CDP; Node inspector не включается. Это различие существенно: Fuses не отключают Chromium DevTools. Ограничения DevTools остаются отдельным пунктом desktop roadmap.

Отрицательные тесты изменяют только временную копию: повреждают содержимое файла в ASAR, меняют хеш в заголовке ASAR и удаляют ASAR при наличии исполняемого `resources/app`. macOS-копия заново получает ad-hoc подпись ресурсов, чтобы тест проверял отказ Electron, а не только подпись macOS.

Playwright `_electron.launch` требует Node inspector для доступа к main process. Поэтому остальные desktop-тесты работают на **отдельной временной копии**, где включён только `EnableNodeCliInspectArguments`; её `app.asar` совпадает с релизным побайтно. Копия располагается за пределами каталога публикуемых артефактов. После всех тестов CI повторно проверяет Fuses, встроенный хеш и SHA256 исходного Electron binary/framework и ASAR. Изменение релизных файлов приводит к ошибке до загрузки установщиков в artifacts.

Тесты NSIS сначала проверяют строгие Fuses установленного файла. В тестах обновления debugger включается только у временной исходной установки, используемой для управления кликом. Замена собирается со строгими настройками; после реального обновления Stable/Beta проверяются новая версия, восстановленные профили и SQL, а также все пять Fuses и ASAR integrity установленного приложения.

## Проверенный релиз

[0.18.0](https://github.com/yakut-sekonts/local-db-viewer/releases/tag/v0.18.0) опубликован 2026-10-05 после [успешного release CI](https://github.com/yakut-sekonts/local-db-viewer/actions/runs/37321947922). На обеих платформах прошли восемь runtime-проверок Fuses, проверка неизменности релизных файлов, остальные desktop-тесты и реальная установка тестовых обновлений Stable/Beta. Windows дополнительно подтвердил per-user NSIS и перезапуск в исходном пути с кириллицей; macOS сохранил резервную копию. Эти результаты относятся к CI-окружению, а не к проверке на каждом корпоративном устройстве.

## Границы

Fuses не заменяют доверенную подпись и notarization. Сейчас macOS использует ad-hoc подпись, Windows распространяется без сертификата издателя. Пользователь с правом менять весь bundle/EXE может изменить одновременно код, хеши и настройки Fuses; защиты от такого владельца файлов эти проверки не обещают.

ASAR integrity не охватывает внешние JRE/JAR, updater helpers и распакованные native modules. Их существующие проверки и модель доверия остаются отдельными. Настройки CookieEncryption и FileProtocolExtraPrivileges в этом изменении не переключаются.

Источники: [Electron Fuses](https://www.electronjs.org/docs/latest/tutorial/fuses), [ASAR integrity](https://www.electronjs.org/docs/latest/tutorial/asar-integrity).
