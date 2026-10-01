# Connection timeout

В Options поле `Connection timeout, sec` задаёт общий лимит открытия JDBC-соединения. По умолчанию — 30 секунд, допустимо 0–86400. Лимит работает для SQL-консолей, Test Connection и интроспекции, включая Universal JDBC и импортированные драйверы.

Отсчёт начинается при входе Java bridge в открытие соединения, после Before connection, SSH, запуска Java и подготовки сертификатов. При превышении лимита IDE прекращает работу отдельной JVM сессии, закрывает её SSH transport и сообщает ошибку. Следующая попытка создаёт новую сессию. Запоздалые сообщения старой JVM игнорируются. SQL автоматически не повторяется.

После открытия соединения этот таймер отключается: он не ограничивает startup script, настройку SQL-сессии и выполнение пользовательского SQL. `Query timeout` — отдельное ограничение запросов. Чтение metadata и Test Connection имеют отдельный лимит ответа после подключения; время самого подключения в него не входит. Before connection и SSH также используют собственные ограничения.

## Драйверы и приоритет параметров

Значение из Options передаётся в значения по умолчанию для известных классов драйверов, в том числе выбранных через Universal JDBC:

- PostgreSQL `org.postgresql.Driver`: `connectTimeout` и `loginTimeout`, секунды.
- MySQL `com.mysql.cj.jdbc.Driver` / `com.mysql.jdbc.Driver`, MariaDB `org.mariadb.jdbc.Driver`: `connectTimeout`, миллисекунды.
- SQL Server `com.microsoft.sqlserver.jdbc.SQLServerDriver`: `loginTimeout`, секунды.
- ClickHouse `com.clickhouse.jdbc.ClickHouseDriver`: `connection_timeout`, миллисекунды.

Явные значения Advanced заменяют эти значения по умолчанию. Параметры query string JDBC URL исключаются из передаваемых Properties, чтобы сохранить приоритет URL и избежать дубликатов. Для SQL Server учитываются параметры после `;`, регистр имён и значения с экранированием `{...}`: разделитель внутри значения не принимается за новое свойство.

Advanced не меняет общий лимит IDE. Например, Options = 10 секунд и MySQL `connectTimeout=60000` разрешают драйверу более долгую попытку, но IDE всё равно прекращает открытие через 10 секунд. Для увеличения общего времени нужно изменить Options. `socketTimeout` и свойства ограничения запросов не подменяются настройкой подключения.

Для неизвестных классов свойства не добавляются: используются `DriverManager.setLoginTimeout` и общий лимит IDE. Встроенный Trino не имеет универсального JDBC-свойства `connectTimeout`; выдуманный параметр ему не передаётся.

## Значение 0

`0` отключает общий таймер IDE и передаётся в известные свойства драйверов без замены на 30 секунд. При необходимости открытие соединения можно отменить кнопкой остановки запроса.

Это не обещание бесконечного ожидания на всех транспортных уровнях. Драйвер, ОС, proxy или сервер могут иметь собственные лимиты. В частности, SQL Server трактует `loginTimeout=0` как свой стандартный таймаут, а не как бесконечное ожидание. Явные значения Advanced и URL продолжают действовать.

## HTTP и отложенные подключения

Trino и ClickHouse могут создать JDBC Connection и вернуть metadata без сетевого обращения. Поэтому при открытии их физической сессии IDE выполняет один проверочный `SELECT 1` внутри лимита подключения. Пользовательский SQL, startup script и настройка Auto/Manual выполняются после этой проверки. При повторном использовании открытого соединения проверка не повторяется.

Для произвольного стороннего драйвера общий лимит охватывает вызов его JDBC connect, но не гарантирует, что сам драйвер выполняет сетевое обращение именно в этом вызове. Автоматическая миграция legacy Node-профилей в JDBC в этот выпуск не входит.

## Проверки и источники

`node tests/connection-timeout.mjs` проверяет настоящие JDBC-драйверы на локальном TCP-сервере, который принимает сокет и не отвечает, а также неотзывчивый тестовый драйвер, `0` дольше 30 секунд, отмену и работу сессии после ошибки. Это тест транспортных отказов, а не проверка всех производственных конфигураций СУБД.

`node tests/connection-timeout-desktop.mjs` проверяет Options, IPC Test Connection и получение ошибки выполнения в Electron. Оба теста включены в release CI для macOS ARM64 и Windows x64; runtime-проверка Windows также запускается в push/PR CI.

Семантика свойств: [pgJDBC](https://jdbc.postgresql.org/documentation/use/), [MySQL Connector/J](https://dev.mysql.com/doc/connector-j/en/connector-j-connp-props-networking.html), [MariaDB Connector/J](https://mariadb.com/docs/connectors/mariadb-connector-j/about-mariadb-connector-j), [SQL Server JDBC](https://learn.microsoft.com/en-us/sql/connect/jdbc/understand-timeouts), [ClickHouse 0.10.0](https://github.com/ClickHouse/clickhouse-java/blob/v0.10.0/client-v2/src/main/java/com/clickhouse/client/api/ClientConfigProperties.java), [Trino JDBC](https://trino.io/docs/current/client/jdbc.html).
