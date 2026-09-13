import com.google.gson.*;
import java.io.*;
import java.math.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.*;
import java.security.cert.*;
import java.sql.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;

/** One process owns one JDBC connection. stdout is reserved for the JSON protocol. */
public final class LocalDBViewerBridge {
    private static final Gson JSON = new GsonBuilder().disableHtmlEscaping().serializeNulls().create();
    // Windows may give System.out a legacy code page even when file.encoding
    // is UTF-8. The Node bridge always decodes this JSON channel as UTF-8.
    private static final PrintStream PROTOCOL = new PrintStream(new FileOutputStream(FileDescriptor.out), true, StandardCharsets.UTF_8);
    private static final ExecutorService QUERIES = Executors.newSingleThreadExecutor();
    private static final AtomicBoolean CANCELED = new AtomicBoolean();
    private static volatile Statement runningStatement;
    private static Connection connection;
    private static ClassLoader driverLoader = LocalDBViewerBridge.class.getClassLoader();
    private static JsonObject config;
    private static final Properties properties = new Properties();
    private static boolean explicitTransaction;
    private static boolean certificatesReady;
    private static final List<Path> temporaryFiles = new ArrayList<>();

    private static String string(JsonObject value, String key, String fallback) {
        return value.has(key) && !value.get(key).isJsonNull() ? value.get(key).getAsString() : fallback;
    }
    private static boolean bool(JsonObject value, String key, boolean fallback) {
        return value.has(key) ? value.get(key).getAsBoolean() : fallback;
    }
    private static int number(JsonObject value, String key, int fallback) {
        return value.has(key) ? value.get(key).getAsInt() : fallback;
    }
    private static synchronized void send(JsonObject message) { PROTOCOL.println(JSON.toJson(message)); PROTOCOL.flush(); }
    private static JsonObject message(String kind) { JsonObject value = new JsonObject(); value.addProperty("kind", kind); return value; }
    private static String error(Throwable error) {
        String text = error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage();
        for (String key : properties.stringPropertyNames()) {
            if (key.toLowerCase(Locale.ROOT).matches(".*(password|token|secret|credential|passphrase).*")) {
                String secret = properties.getProperty(key); if (!secret.isEmpty()) text = text.replace(secret, "<hidden>");
            }
        }
        if (config.has("certificates")) for (Map.Entry<String, JsonElement> field : config.getAsJsonObject("certificates").entrySet()) {
            if (field.getKey().endsWith("Password") && field.getValue().isJsonPrimitive()) { String secret = field.getValue().getAsString(); if (!secret.isEmpty()) text = text.replace(secret, "<hidden>"); }
        }
        return text.length() > 12000 ? text.substring(0, 12000) : text;
    }
    private static Driver driver() throws Exception {
        return (Driver) Class.forName(config.get("driverClass").getAsString(), true, driverLoader).getDeclaredConstructor().newInstance();
    }
    private static JsonObject options() { return config.has("options") ? config.getAsJsonObject("options") : new JsonObject(); }
    private static Connection connect() throws Exception {
        if (connection != null && !connection.isClosed()) return connection;
        if (!certificatesReady) { prepareCertificates(); certificatesReady = true; }
        DriverManager.setLoginTimeout(number(options(), "connectTimeoutSeconds", 30));
        if (string(config, "engine", "").equals("sqlite") && bool(options(), "readOnly", false)) properties.putIfAbsent("open_mode", "1");
        connection = driver().connect(config.get("url").getAsString(), properties);
        if (connection == null) throw new SQLException("JDBC driver does not accept this URL");
        try {
            if (bool(options(), "readOnly", false)) connection.setReadOnly(true);
            String isolation = string(options(), "isolation", "default");
            int level = switch (isolation) {
                case "read-uncommitted" -> Connection.TRANSACTION_READ_UNCOMMITTED;
                case "read-committed" -> Connection.TRANSACTION_READ_COMMITTED;
                case "repeatable-read" -> Connection.TRANSACTION_REPEATABLE_READ;
                case "serializable" -> Connection.TRANSACTION_SERIALIZABLE;
                default -> -1;
            };
            if (level != -1) connection.setTransactionIsolation(level);
            connection.setAutoCommit(bool(options(), "autoCommit", true));
            if (config.has("startupStatements")) for (JsonElement sql : config.getAsJsonArray("startupStatements")) {
                try (Statement statement = connection.createStatement()) { statement.execute(sql.getAsString()); }
            }
            return connection;
        } catch (Exception failure) { connection.close(); connection = null; throw failure; }
    }
    private static void prepareCertificates() throws Exception {
        JdbcCertificates.apply(config, properties, temporaryFiles);
        String pem = string(config, "sslCa", ""); if (pem.isBlank()) return;
        if (config.has("certificates") && !string(config.getAsJsonObject("certificates"), "trustSource", "driver").equals("driver")) return;
        String engine = string(config, "engine", "");
        Path certificate = Files.createTempFile("local-db-viewer-ca-", ".pem");
        temporaryFiles.add(certificate); Files.writeString(certificate, pem);
        if (engine.equals("postgres")) { properties.putIfAbsent("sslrootcert", certificate.toString()); return; }
        if (engine.equals("clickhouse")) { properties.putIfAbsent("sslrootcert", certificate.toString()); return; }
        if (engine.equals("mariadb")) { properties.putIfAbsent("serverSslCert", certificate.toString()); return; }
        KeyStore trust = KeyStore.getInstance("PKCS12"); trust.load(null, null);
        Collection<? extends java.security.cert.Certificate> certificates = CertificateFactory.getInstance("X.509").generateCertificates(new ByteArrayInputStream(pem.getBytes(StandardCharsets.UTF_8)));
        int index = 0;
        for (java.security.cert.Certificate value : certificates) trust.setCertificateEntry("ca-" + index++, value);
        if (index == 0) throw new CertificateException("CA file contains no certificates");
        Path store = Files.createTempFile("local-db-viewer-trust-", ".p12"); temporaryFiles.add(store);
        String password = UUID.randomUUID().toString();
        try (OutputStream output = Files.newOutputStream(store)) { trust.store(output, password.toCharArray()); }
        if (engine.equals("trino")) {
            if (!properties.containsKey("SSLTrustStorePath")) { properties.setProperty("SSLTrustStorePath", store.toString()); properties.setProperty("SSLTrustStorePassword", password); properties.setProperty("SSLTrustStoreType", "PKCS12"); }
        } else if (engine.equals("mysql")) {
            if (!properties.containsKey("trustCertificateKeyStoreUrl")) { properties.setProperty("trustCertificateKeyStoreUrl", store.toUri().toString()); properties.setProperty("trustCertificateKeyStorePassword", password); properties.setProperty("trustCertificateKeyStoreType", "PKCS12"); }
        } else if (engine.equals("mssql")) {
            if (!properties.containsKey("trustStore")) { properties.setProperty("trustStore", store.toString()); properties.setProperty("trustStorePassword", password); properties.setProperty("trustStoreType", "PKCS12"); }
        }
    }
    private static Object arrayValue(Object value) {
        if (value == null) return null;
        if (value instanceof BigDecimal decimal) return decimal.toPlainString();
        if (value instanceof BigInteger || value instanceof Long) return value.toString();
        if (value instanceof Double number && !Double.isFinite(number)) return number.toString();
        if (value instanceof Float number && !Float.isFinite(number)) return number.toString();
        if (value.getClass().isArray()) {
            List<Object> items = new ArrayList<>();
            for (int i = 0; i < java.lang.reflect.Array.getLength(value); i++) items.add(arrayValue(java.lang.reflect.Array.get(value, i)));
            return items;
        }
        return value;
    }
    private static Object cell(ResultSet result, ResultSetMetaData metadata, int column) throws SQLException, IOException {
        int type = metadata.getColumnType(column);
        if (type == Types.BIGINT || type == Types.INTEGER || type == Types.SMALLINT || type == Types.TINYINT || type == Types.NUMERIC || type == Types.DECIMAL) {
            BigDecimal value = result.getBigDecimal(column); return value == null ? null : value.toPlainString();
        }
        if (type == Types.DATE || type == Types.TIME || type == Types.TIMESTAMP || type == Types.TIME_WITH_TIMEZONE || type == Types.TIMESTAMP_WITH_TIMEZONE) return result.getString(column);
        if (type == Types.BLOB || type == Types.BINARY || type == Types.VARBINARY || type == Types.LONGVARBINARY) {
            try (InputStream stream = result.getBinaryStream(column)) {
                if (stream == null) return null;
                byte[] data = stream.readNBytes(4 * 1024 * 1024 + 1);
                if (data.length > 4 * 1024 * 1024) throw new SQLException("Binary cell exceeds 4 MB; select a smaller value");
                return HexFormat.of().formatHex(data);
            }
        }
        if (type == Types.VARCHAR || type == Types.NVARCHAR || type == Types.CHAR || type == Types.NCHAR) {
            // Trino supports getString for character columns but does not
            // implement getCharacterStream. Reserve streaming for actual LOBs.
            String value = result.getString(column);
            if (value != null && value.length() > 4 * 1024 * 1024) throw new SQLException("Text cell exceeds 4 MB; select a smaller value");
            return value;
        }
        if (type == Types.CLOB || type == Types.NCLOB || type == Types.LONGVARCHAR || type == Types.LONGNVARCHAR) {
            try (Reader reader = result.getCharacterStream(column)) {
                if (reader == null) return null;
                char[] buffer = new char[8192]; StringBuilder output = new StringBuilder(); int count;
                while ((count = reader.read(buffer)) != -1) { output.append(buffer, 0, count); if (output.length() > 4 * 1024 * 1024) throw new SQLException("Text cell exceeds 4 MB; select a smaller value"); }
                return output.toString();
            } catch (SQLFeatureNotSupportedException unsupported) {
                // Some drivers (including Trino) do not expose character streams.
                String value = result.getString(column);
                if (value != null && value.length() > 4 * 1024 * 1024) throw new SQLException("Text cell exceeds 4 MB; select a smaller value");
                return value;
            }
        }
        Object value = result.getObject(column);
        if (value == null || value instanceof Boolean || value instanceof Double || value instanceof Float || value instanceof String) return arrayValue(value);
        if (value instanceof Number) return value.toString();
        if (value instanceof java.sql.Array array) { try { return arrayValue(array.getArray()); } finally { array.free(); } }
        return value.toString();
    }
    private static void run(JsonObject request) {
        long started = System.nanoTime();
        JsonObject snapshot = new JsonObject();
        snapshot.addProperty("requestId", request.get("requestId").getAsString());
        snapshot.addProperty("queryId", ""); snapshot.addProperty("state", "RUNNING");
        JsonArray columns = new JsonArray(), rows = new JsonArray(), warnings = new JsonArray();
        snapshot.add("columns", columns); snapshot.add("rows", rows); snapshot.add("warnings", warnings);
        snapshot.addProperty("totalRows", 0); snapshot.addProperty("truncated", false);
        snapshot.add("stats", new JsonObject()); snapshot.addProperty("inTransaction", explicitTransaction);
        JsonObject initial = message("update"); initial.add("snapshot", snapshot); send(initial);
        try {
            Connection active = connect();
            if (CANCELED.get()) throw new CancellationException("Query canceled");
            String catalog = string(request, "catalog", ""), schema = string(request, "schema", "");
            if (!catalog.isEmpty() && !Objects.equals(JdbcMetadata.catalog(active), catalog)) active.setCatalog(catalog);
            if (!schema.isEmpty() && !Objects.equals(JdbcMetadata.schema(active), schema)) active.setSchema(schema);
            String sql = request.get("sql").getAsString();
            String command = string(request, "transactionAction", "");
            boolean mysqlStreaming = string(config, "driverClass", "").startsWith("com.mysql.");
            try (Statement statement = mysqlStreaming ? active.createStatement(ResultSet.TYPE_FORWARD_ONLY, ResultSet.CONCUR_READ_ONLY) : active.createStatement()) {
                runningStatement = statement;
                // Connector/J otherwise materializes the entire result before next().
                if (mysqlStreaming) statement.setFetchSize(Integer.MIN_VALUE);
                int timeout = number(options(), "queryTimeoutSeconds", 0);
                if (timeout > 0) statement.setQueryTimeout(timeout);
                if (CANCELED.get()) throw new CancellationException("Query canceled");
                boolean hasResult;
                if (!active.getAutoCommit()) explicitTransaction = true;
                if (!active.getAutoCommit() && command.startsWith("commit")) { active.commit(); hasResult = false; }
                else if (!active.getAutoCommit() && command.startsWith("rollback")) { active.rollback(); hasResult = false; }
                else hasResult = statement.execute(sql);
                if (command.equals("begin") || command.endsWith("-chain")) explicitTransaction = true;
                if (command.equals("commit") || command.equals("rollback")) explicitTransaction = false;
                if (hasResult) {
                    try (ResultSet result = statement.getResultSet()) {
                        ResultSetMetaData metadata = result.getMetaData();
                        for (int column = 1; column <= metadata.getColumnCount(); column++) {
                            JsonObject field = new JsonObject(); field.addProperty("name", metadata.getColumnLabel(column)); field.addProperty("type", metadata.getColumnTypeName(column)); columns.add(field);
                        }
                        int maximum = Math.min(10000, Math.max(1, request.get("maxRows").getAsInt()));
                        long total = 0, retained = 0;
                        while (result.next()) {
                            if (CANCELED.get()) throw new CancellationException("Query canceled");
                            total++;
                            if (rows.size() < maximum && retained < 8 * 1024 * 1024) {
                                JsonArray row = new JsonArray();
                                for (int column = 1; column <= metadata.getColumnCount(); column++) row.add(JSON.toJsonTree(cell(result, metadata, column)));
                                long length = JSON.toJson(row).getBytes(StandardCharsets.UTF_8).length;
                                if (retained + length <= 8 * 1024 * 1024) { rows.add(row); retained += length; } else retained = 8 * 1024 * 1024;
                            }
                        }
                        snapshot.addProperty("totalRows", total); snapshot.addProperty("truncated", total > rows.size());
                    }
                } else {
                    long count = statement.getLargeUpdateCount();
                    if (count >= 0) snapshot.addProperty("updateCount", Long.toString(count));
                    snapshot.addProperty("updateType", "JDBC");
                }
                for (SQLWarning warning = statement.getWarnings(); warning != null && warnings.size() < 50; warning = warning.getNextWarning()) warnings.add(error(warning));
            } finally { runningStatement = null; }
            snapshot.addProperty("state", CANCELED.get() ? "CANCELED" : "FINISHED");
            try {
                String catalogValue = JdbcMetadata.catalog(active), schemaValue = JdbcMetadata.schema(active);
                if (!catalogValue.isEmpty()) snapshot.addProperty("catalog", catalogValue);
                if (!schemaValue.isEmpty()) snapshot.addProperty("schema", schemaValue);
            } catch (SQLException unsupported) { warnings.add("Не удалось получить текущие catalog/schema: " + error(unsupported)); }
        } catch (Throwable failure) {
            snapshot.addProperty("state", CANCELED.get() || failure instanceof CancellationException ? "CANCELED" : "FAILED");
            snapshot.addProperty("error", error(failure));
        } finally {
            snapshot.addProperty("inTransaction", explicitTransaction);
            snapshot.getAsJsonObject("stats").addProperty("elapsedTimeMillis", (System.nanoTime() - started) / 1_000_000);
            JsonObject result = message("done"); result.add("snapshot", snapshot); send(result);
        }
    }
    private static void describe() {
        JsonObject result = message("properties");
        try {
            JsonArray values = new JsonArray();
            for (DriverPropertyInfo info : driver().getPropertyInfo(config.get("url").getAsString(), new Properties())) {
                JsonObject value = new JsonObject(); value.addProperty("name", info.name); value.addProperty("description", info.description);
                value.addProperty("value", info.value); value.addProperty("required", info.required); value.add("choices", JSON.toJsonTree(info.choices)); values.add(value);
            }
            result.add("properties", values);
        } catch (Throwable failure) { result.addProperty("error", error(failure)); }
        send(result);
    }
    private static void inspect(JsonObject request) {
        String kind = string(request, "kind", ""); JsonObject result = message(kind);
        if (request.has("requestId")) result.add("requestId", request.get("requestId"));
        try {
            String catalog = string(request, "catalog", ""), schema = string(request, "schema", ""), table = string(request, "table", "");
            switch (kind) {
                case "probe" -> {
                    Driver driver = driver();
                    if (!driver.acceptsURL(string(config, "url", ""))) throw new SQLException("Driver does not accept this JDBC URL");
                    result.addProperty("value", "Driver loaded");
                }
                case "test" -> { DatabaseMetaData metadata = connect().getMetaData(); result.addProperty("value", "Соединение установлено · " + metadata.getDatabaseProductName() + " · " + metadata.getDriverVersion()); }
                case "ping" -> {
                    if (connection == null || connection.isClosed()) throw new SQLException("Connection is closed");
                    if (!connection.getAutoCommit() || explicitTransaction) { result.addProperty("value", true); break; }
                    String sql = string(request, "sql", "");
                    if (sql.isBlank()) { if (!connection.isValid(10)) throw new SQLException("Connection is no longer valid"); }
                    else try (Statement statement = connection.createStatement()) { statement.setQueryTimeout(10); statement.setMaxRows(1); statement.execute(sql); }
                    result.addProperty("value", true);
                }
                case "metadata" -> result.add("value", JdbcMetadata.read(connect(), string(request, "operation", ""), catalog, schema, table));
                case "schema" -> result.add("value", JdbcMetadata.index(connect(), string(request, "profileId", ""), catalog, schema));
                case "preview" -> result.addProperty("value", JdbcMetadata.preview(connect(), catalog, schema, table));
                default -> throw new SQLException("Unknown JDBC inspection");
            }
        } catch (Throwable failure) { result.addProperty("error", error(failure)); }
        try { result.addProperty("inTransaction", connection != null && !connection.isClosed() && (!connection.getAutoCommit() || explicitTransaction)); } catch (SQLException ignored) {}
        send(result);
    }
    private static void close() {
        JsonObject result = message("closed");
        try {
            if (connection != null) {
                try {
                    if (!connection.getAutoCommit()) connection.rollback();
                    else if (explicitTransaction) try (Statement statement = connection.createStatement()) { statement.execute("ROLLBACK"); }
                } catch (SQLException failure) {
                    // Releasing SQLite's outermost SAVEPOINT already ends the transaction.
                    if (!string(config, "engine", "").equals("sqlite") || !error(failure).toLowerCase(Locale.ROOT).contains("no transaction is active")) throw failure;
                } finally { connection.close(); }
            }
        } catch (Throwable failure) { result.addProperty("error", error(failure)); }
        finally { for (Path file : temporaryFiles) try { Files.deleteIfExists(file); } catch (IOException ignored) {} send(result); System.exit(0); }
    }
    public static void main(String[] args) throws Exception {
        System.setOut(System.err);
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8))) {
            String first = reader.readLine(); if (first == null) return;
            config = JsonParser.parseString(first).getAsJsonObject();
            if (config.has("driverClasspath")) {
                List<URL> paths = new ArrayList<>();
                for (JsonElement path : config.getAsJsonArray("driverClasspath")) paths.add(Path.of(path.getAsString()).toUri().toURL());
                driverLoader = new URLClassLoader(paths.toArray(URL[]::new), ClassLoader.getPlatformClassLoader());
                Thread.currentThread().setContextClassLoader(driverLoader);
            }
            if (config.has("properties")) for (Map.Entry<String, JsonElement> item : config.getAsJsonObject("properties").entrySet()) properties.setProperty(item.getKey(), item.getValue().getAsString());
            String line;
            while ((line = reader.readLine()) != null) {
                JsonObject request = JsonParser.parseString(line).getAsJsonObject();
                switch (request.get("kind").getAsString()) {
                    case "run" -> { CANCELED.set(false); QUERIES.submit(() -> run(request)); }
                    case "properties" -> QUERIES.submit(LocalDBViewerBridge::describe);
                    case "probe", "test", "metadata", "schema", "preview", "ping" -> QUERIES.submit(() -> inspect(request));
                    case "cancel" -> {
                        CANCELED.set(true);
                        Thread.ofVirtual().start(() -> { JsonObject result = message("cancel"); try { Statement statement = runningStatement; if (statement != null) statement.cancel(); } catch (Throwable failure) { result.addProperty("error", error(failure)); } send(result); });
                    }
                    case "close" -> { QUERIES.submit(LocalDBViewerBridge::close); return; }
                    default -> throw new IllegalArgumentException("Unknown JDBC bridge command");
                }
            }
        } finally { QUERIES.submit(LocalDBViewerBridge::close); QUERIES.shutdown(); }
    }
}
