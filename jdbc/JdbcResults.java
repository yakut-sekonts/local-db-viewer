import com.google.gson.*;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.sql.*;
import java.util.concurrent.CancellationException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Function;

/** Consume the JDBC result chain without retaining open ResultSets or unbounded data. */
final class JdbcResults {
    private static final Gson JSON = new GsonBuilder().disableHtmlEscaping().serializeNulls().create();
    private static final long MAX_BYTES = 8 * 1024 * 1024;
    private static final int MAX_RESULTS = 100;
    @FunctionalInterface interface CellReader { Object read(ResultSet rows, ResultSetMetaData metadata, int column) throws SQLException, IOException; }
    private long retained;
    private JsonObject current;
    private final AtomicBoolean canceled;

    private JdbcResults(AtomicBoolean canceled) { this.canceled = canceled; }
    private void checkCanceled() { if (canceled.get()) throw new CancellationException("Query canceled"); }
    private static long size(JsonElement value) { return JSON.toJson(value).getBytes(StandardCharsets.UTF_8).length; }
    private static JsonObject empty() {
        JsonObject value = new JsonObject();
        value.add("columns", new JsonArray()); value.add("rows", new JsonArray());
        value.addProperty("totalRows", 0); value.addProperty("truncated", false);
        return value;
    }
    private static long updateCount(Statement statement) throws SQLException {
        try { return statement.getLargeUpdateCount(); }
        catch (SQLFeatureNotSupportedException unsupported) { return statement.getUpdateCount(); }
    }
    static void read(Statement statement, boolean hasResult, JsonObject snapshot, int maximum,
            AtomicBoolean canceled, CellReader reader, Function<Throwable, String> sanitize, Runnable notify) throws Exception {
        new JdbcResults(canceled).consume(statement, hasResult, snapshot, maximum, reader, sanitize, notify);
    }
    private void consume(Statement statement, boolean hasResult, JsonObject snapshot, int maximum,
            CellReader reader, Function<Throwable, String> sanitize, Runnable notify) throws Exception {
        JsonArray additional = new JsonArray(), warnings = snapshot.getAsJsonArray("warnings");
        int count = 0;
        long notified = 0;
        try {
            while (true) {
                checkCanceled();
                long updated = hasResult ? -1 : updateCount(statement);
                if (!hasResult && updated == -1) break;
                // A broken driver must not spin forever even when no rows are returned.
                if (++count > 1000) throw new SQLException("JDBC вернул более 1000 результатов. Чтение остановлено; уже выполненные изменения не отменяются автоматически.");
                boolean keep = count <= MAX_RESULTS;
                current = count == 1 ? snapshot : keep ? empty() : null;
                if (current != null) {
                    current.addProperty("resultState", "RUNNING");
                    if (count > 1) { additional.add(current); snapshot.add("additionalResults", additional); }
                } else snapshot.addProperty("omittedResults", count - MAX_RESULTS);
                if (hasResult) {
                    try (ResultSet result = statement.getResultSet()) {
                        if (result == null) throw new SQLException("JDBC returned no ResultSet after execute/getMoreResults returned true");
                        readRows(result, current, maximum, reader);
                    }
                } else if (current != null) {
                    current.addProperty("updateType", "JDBC");
                    current.addProperty("updateCount", Long.toString(updated));
                }
                if (current != null) current.addProperty("resultState", "FINISHED");
                for (SQLWarning warning = statement.getWarnings(); warning != null && warnings.size() < 50; warning = warning.getNextWarning()) warnings.add(sanitize.apply(warning));
                try { statement.clearWarnings(); }
                catch (SQLFeatureNotSupportedException unsupported) { /* Some third-party drivers expose read-only warnings. */ }
                long now = System.nanoTime();
                // Publish each retained result before getMoreResults can block on the server.
                if (keep || now - notified >= 200_000_000L) { notify.run(); notified = now; }
                current = null; // Errors while advancing belong to the execution, not the completed result.
                checkCanceled();
                try { hasResult = statement.getMoreResults(); }
                catch (SQLFeatureNotSupportedException unsupported) {
                    if (warnings.size() < 50) warnings.add("JDBC-драйвер не поддерживает getMoreResults; дополнительные результаты проверить невозможно.");
                    break;
                }
            }
            if (count == 0) { snapshot.addProperty("updateType", "JDBC"); snapshot.addProperty("resultState", "FINISHED"); }
        } catch (Exception failure) {
            if (current != null) {
                current.addProperty("resultState", canceled.get() || failure instanceof CancellationException ? "CANCELED" : "FAILED");
                current.addProperty("error", sanitize.apply(failure));
            }
            throw failure;
        }
    }
    private void readRows(ResultSet result, JsonObject output, int maximum, CellReader reader) throws Exception {
        JsonArray columns = new JsonArray(), rows = output == null ? null : output.getAsJsonArray("rows");
        ResultSetMetaData metadata = null;
        boolean limited = retained >= MAX_BYTES;
        int fields = 0;
        if (output != null && !limited) {
            metadata = result.getMetaData(); fields = metadata.getColumnCount();
            if (fields > 10000) throw new SQLException("Результат содержит более 10000 колонок.");
            long bytes = 4; // Empty columns and rows arrays.
            for (int column = 1; column <= fields; column++) {
                String name = metadata.getColumnLabel(column), type = metadata.getColumnTypeName(column);
                if (name != null && name.length() > 65536 || type != null && type.length() > 65536) throw new SQLException("Описание JDBC-колонки превышает 64 KiB.");
                JsonObject field = new JsonObject(); field.addProperty("name", name); field.addProperty("type", type);
                bytes += size(field) + 1;
                if (retained + bytes > MAX_BYTES) { limited = true; columns = new JsonArray(); break; }
                columns.add(field);
            }
            if (!limited) retained += bytes;
            output.add("columns", columns);
        }
        long total = 0;
        try {
            while (true) {
                checkCanceled();
                if (!result.next()) break;
                total++;
                if (output == null || limited || rows.size() >= maximum) continue;
                JsonArray row = new JsonArray();
                long bytes = 3; // Row brackets and its separator in the outer array.
                for (int column = 1; column <= fields; column++) {
                    JsonElement value = JSON.toJsonTree(reader.read(result, metadata, column));
                    bytes += size(value) + (column > 1 ? 1 : 0);
                    // Bound an individual wide row before materializing all its cells.
                    if (bytes > MAX_BYTES - retained) { limited = true; break; }
                    row.add(value);
                }
                if (!limited) { rows.add(row); retained += bytes; }
            }
        } finally {
            if (output != null) {
                output.addProperty("totalRows", total); output.addProperty("truncated", total > rows.size() || limited);
                if (limited) output.addProperty("dataLimited", true);
            }
        }
    }
}
