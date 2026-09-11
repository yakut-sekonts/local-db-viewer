# Local DB Viewer 0.2.0

Desktop SQL IDE для Trino, PostgreSQL, MySQL, MariaDB, SQLite, Microsoft SQL Server и ClickHouse. Интерфейс выполнен по предоставленному референсу DataGrip: тёмная тема, Database Explorer, SQL-консоли, Files и нижняя панель Services с результатами. Это самостоятельное приложение, не продукт JetBrains.

## Установка в профиль пользователя

- **macOS 13 и новее, Apple Silicon (ARM64, M1 и новее):** откройте `Local-DB-Viewer-0.2.0-mac-arm64.dmg` и скопируйте `Local DB Viewer.app` в `~/Applications`. Папку можно создать в своей домашней директории. Intel Mac не поддерживается.
- **Windows 11 x64:** запустите `Local-DB-Viewer-0.2.0-windows-x64-setup.exe`. NSIS устанавливает приложение для текущего пользователя в `%LOCALAPPDATA%\Programs\Local DB Viewer`, создаёт ярлыки и не запрашивает elevation. Используются `perMachine: false`, `allowElevation: false`, `asInvoker`.

Node.js, Java, Python и отдельная установка драйверов пользователю не требуются. Сборка macOS имеет локальную ad-hoc подпись, но не Developer ID/notarization; Windows не имеет Authenticode-подписи. Корпоративные политики запуска, Gatekeeper и SmartScreen действуют независимо от возможности установки без прав администратора.

## Подключения и SQL

В настройках выберите СУБД, URL, пользователя и способ аутентификации. Trino поддерживает отсутствие пароля, username/password и Bearer token; ClickHouse — HTTP с username/password; PostgreSQL, MySQL/MariaDB и SQL Server — встроенные SQL credentials. В новых подключениях используется настоящий JDBC-драйвер; Java 25 и семь драйверов входят в приложение. Дополнительные JAR, driver class, VM options и environment задаются в Advanced. Windows Integrated Authentication SQL Server требует соответствующую библиотеку mssql-jdbc_auth; она пока не включена в установщик. Для SQLite выберите локальный файл. Для Trino и ClickHouse передача пароля/токена требует HTTPS. TLS у SQL-драйверов проверяет сертификат сервера.

Для PostgreSQL и SQL Server база задаётся в URL, например `postgresql://host:5432/analytics` или `mssql://host:1433/analytics`. Для MySQL/MariaDB можно использовать URL или поле Database. Для ClickHouse URL — HTTP endpoint, а база задаётся в поле Database. У Trino укажите catalog/schema или выберите schema значком рядом с ней в Database Explorer.

`Ctrl+Enter` / `⌘+Enter` выполняет выделение либо содержимое консоли. Выполняется одна SQL-команда за раз. `Ctrl/⌘+T` открывает консоль, `Ctrl/⌘+O` — SQL-файл, `Ctrl/⌘+S` сохраняет SQL. Консоли используют отдельные сессии; доступна отмена запроса. Закрытие сессии завершает её и откатывает незавершённую транзакцию. Отмена SQLite закрывает worker и откатывает его транзакцию.

Результаты доступны в таблице с фильтром, страницами и CSV-экспортом. Сохраняется до выбранного лимита (максимум 10 000 строк и 8 MB на результат); оставшиеся строки читаются без сохранения. Экспорт включает сохранённые строки. `bigint` и точные decimal хранятся строками, чтобы не округлять их в JavaScript. JDBC-режим сохраняет точность SQL Server decimal/numeric и money. Для старых профилей с legacy-драйвером tedious значения с precision > 15 требуют `CAST(... AS varchar(...))`; открытие и сохранение настроек переводит профиль на JDBC. Редактирование ячеек с записью в БД пока не реализовано.

## Настройки JDBC и SSL

General задаёт URL, credentials и начальную schema. Для Trino с портом 8443 включите SSL/TLS → Use SSL: адрес станет `https://host:8443`, а JDBC получит `SSL=true`. По умолчанию `SSLVerification=FULL`. Доступны CA (проверка цепочки) и NONE (без проверки сертификата), импорт CA в PEM. Секреты и CA из пользовательских подключений не входят в репозиторий или установщики.

Advanced читает свойства через `Driver.getPropertyInfo` и передаёт заданные строки напрямую в JDBC `Properties`. Встроены Trino 483, PostgreSQL 42.7.13, MySQL 26.7.0, MariaDB 3.5.10, SQLite 3.53.4.0, SQL Server 13.6.0 и ClickHouse 0.10.0. Произвольные дополнительные параметры поддерживаются; Advanced заменяет значения General, параметры собственного JDBC URL имеют приоритет. Password/token/credentials вводятся в таблице свойств, а не в URL.

Options поддерживает read-only, Auto/Manual transaction control, isolation, connection/query timeout и startup statements. Поддержка конкретного свойства и протокола аутентификации определяется JDBC-драйвером и сервером. Встроенный SSH tunnel, полное управление сессиями и интерфейс DDL mappings ещё не реализованы; это не полная копия всех возможностей DataGrip.

## Обновления на устройствах

Исходники и Releases находятся в приватном репозитории [yakut-sekonts/local-db-viewer](https://github.com/yakut-sekonts/local-db-viewer). Кнопка с колокольчиком в заголовке показывает установленную версию и открывает настройки обновления.

На каждом устройстве один раз укажите личный GitHub-токен пользователя с доступом к репозиторию и релизам. Для подходящих fine-grained tokens требуется `Contents: read`; доступность таких токенов зависит от роли пользователя и политики Organization. Обычным outside collaborators может потребоваться classic token с `repo` либо отдельная схема GitHub App. Токен не встраивается в дистрибутив и хранится через системное защищённое хранилище.

Приложение проверяет новую стабильную версию при запуске и каждые 15 минут. Уведомление открывает release notes и кнопку «Обновить и перезапустить». Загрузка проверяется по размеру и SHA256 из GitHub Releases. Credentials отправляются только GitHub API; на CDN перенаправления уходят без Authorization. Активные запросы и открытые транзакции блокируют перезапуск. SQL-консоли сохраняются перед выходом.

macOS заменяет приложение в каталоге текущего пользователя, сохраняя предыдущий bundle для восстановления. Windows запускает per-user NSIS. Для macOS наряду с DMG публикуется внутренний ZIP для обновления; пользователям для первоначальной установки нужны только DMG и EXE. Отзыв GitHub-доступа прекращает получение новых релизов и не отключает установленную программу.

Для доступа пользователям только на чтение подходит репозиторий GitHub Organization с ролью Read. Личный приватный репозиторий даёт collaborators право записи. Исходники и релизы можно разделить: `UPDATE_REPOSITORY` указывает отдельный приватный репозиторий релизов, `RELEASES_TOKEN` в GitHub Actions даёт workflow право публиковать туда. Пользователи в этом случае получают доступ только к репозиторию релизов.

## Автодополнение колонок и JOIN

При выборе подключения/schema приложение читает системные метаданные: названия таблиц, колонок, их типы и foreign keys. **Значения пользовательских данных для автодополнения не читаются.**

- После `FROM` и `JOIN` предлагаются таблицы; имена вставляются с корректным quoting для диалекта.
- После `alias.` предлагаются колонки соответствующей таблицы. Алиасы определяются и тогда, когда `FROM` расположен ниже курсора.
- В выражениях предлагаются колонки таблиц текущего запроса. Неоднозначные имена квалифицируются алиасом.
- Поддерживаются CTE с явным списком колонок, простыми проекциями, `AS` и `alias.*`. Вложенные SELECT и разные SQL-команды не смешивают алиасы.
- После `JOIN` подсказка со связью вставляет таблицу, свободный алиас и `ON`; после `ON` — условие для уже написанных алиасов. Составные ключи включают все пары через `AND`. Есть варианты `LEFT`, `INNER`, `RIGHT` и, для поддерживаемых диалектов, `FULL JOIN`.
- Foreign keys читаются из PostgreSQL, MySQL/MariaDB, SQLite и SQL Server. Для Trino/ClickHouse используйте виртуальные связи; они также доступны для остальных СУБД.

Для ручного вызова подсказок нажмите **Ctrl+Space**. Внизу редактора показано число проиндексированных таблиц и связей. Кнопка обновления перечитывает метаданные после DDL. Кнопка со звеньями открывает «Связи таблиц»: выберите таблицы и пары колонок, при необходимости загрузите другую schema и сохраните виртуальную связь. Она используется в JOIN только внутри Local DB Viewer и не создаёт constraints в БД.

Индекс хранится в памяти до 5 минут; явно указанные в запросе schemas догружаются по необходимости. Индексация ограничена 10 000 колонок / 8 MB на schema. При недоступных метаданных или ограничении объёма показывается сообщение. Частично прочитанный список составных FK не используется. Возможности анализа SQL пока уже, чем у DataGrip: сложные anonymous derived tables, динамический SQL, произвольные dialect extensions и inference типов выражений полностью не поддерживаются. Совпадения имён вроде `*_id` сами по себе не считаются установленной связью.

## Локальные данные

Настройки: `~/Library/Application Support/Local DB Viewer` на macOS и `%APPDATA%\Local DB Viewer` на Windows. Пароли/токены шифруются Electron safeStorage средствами ОС и не передаются в renderer. Профили сохраняются атомарно в `connections.json`, виртуальные связи — в `relationships.json`. Черновики до 20 консолей и последние 100 запросов сохраняются в localStorage; история и SQL не шифруются. При переходе с DataKhrip существующий каталог настроек и macOS Keychain service сохраняются; новым установкам создаётся каталог Local DB Viewer. Само приложение не отправляет телеметрию. Удаление приложения сохраняет пользовательские настройки.

## Разработка и проверка

```sh
npm ci
python3 scripts/prepare-runtime.py --platform mac-arm64 --compiler
npm test
npm run build
npm run test:ui
npm run test:drivers
npm run package:mac
npm run package:win
```

`npm test` проверяет обработку Trino pagination/session/cancellation, точность чисел, SQL quoting, защищённое хранение credentials, CSV, SQL completion, FK и persistence виртуальных связей. `test:ui` запускает настоящее Electron-окно с изолированным профилем и SQLite-файлом: проверяет запросы, ошибки, rollback, отмену, Explorer, CSV, popup Monaco, выполнение вставленного составного JOIN и создание виртуальной связи.

`test:drivers` проверяет реальные pg/mysql2/ClickHouse драйверы на локальных protocol fixtures. Это не проверка на промышленных серверах. Доступа к реальным Trino/PostgreSQL/MySQL/MariaDB/SQL Server/ClickHouse в этом окружении нет; Windows-инсталлятор собран на macOS и требует проверки установки/запуска на целевом Windows 11. macOS-пакет проверяется запуском содержащегося в нём приложения. Для проверки конкретного macOS binary: `LOCAL_DB_VIEWER_EXECUTABLE="/path/Local DB Viewer.app/Contents/MacOS/Local DB Viewer" npm run test:ui`.

Архитектура: React + Monaco в sandboxed renderer, ограниченный IPC через preload, Electron main для native dialogs/хранения, worker threads с отдельными сессиями драйверов. Сборка Windows x64 и macOS ARM64 содержит runtime и production dependencies.

Системные метаданные: [PostgreSQL pg_constraint](https://www.postgresql.org/docs/current/catalog-pg-constraint.html), [MySQL KEY_COLUMN_USAGE](https://dev.mysql.com/doc/refman/8.4/en/information-schema-key-column-usage-table.html), [SQLite PRAGMA](https://www.sqlite.org/pragma.html), [SQL Server foreign_key_columns](https://learn.microsoft.com/en-us/sql/relational-databases/system-catalog-views/sys-foreign-key-columns-transact-sql), [Trino client protocol](https://trino.io/docs/current/develop/client-protocol.html).

## Выпуск новой версии

Изменения коммитятся в Git. Для релиза обновите версию `package.json` и `package-lock.json`, добавьте запись `CHANGELOG.md`, затем отправьте commit и tag `vX.Y.Z`. Workflow `.github/workflows/release.yml` проверяет код, собирает macOS ARM64 и Windows x64, запускает тесты упакованного приложения и публикует Releases только после успешных сборок обеих платформ. Установщики опубликованной версии не заменяются: исправление выпускается следующим номером.

Java/JDBC загружаются из официальных источников по закреплённым SHA256 в `build/runtime-lock.json`. Runtime, node_modules, пользовательские данные и дистрибутивы не коммитятся в Git. Для Windows-подготовки используйте `python scripts/prepare-runtime.py --platform windows-x64`; для компиляции задайте `JAVA_HOME` на JDK 21 или новее. Пользовательской установке JDK не нужен.
