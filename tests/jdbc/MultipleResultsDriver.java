package fixture;

import java.lang.reflect.*;
import java.sql.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.logging.Logger;

/** A test-only driver for result-chain boundaries that real servers cannot trigger deterministically. */
public final class MultipleResultsDriver implements Driver {
    record Output(String name, int rows, String text, long updated, boolean partialFailure) {}
    @SuppressWarnings("unchecked")
    private static <T> T proxy(Class<T> type, InvocationHandler handler) {
        return (T) Proxy.newProxyInstance(MultipleResultsDriver.class.getClassLoader(), new Class<?>[]{type}, handler);
    }
    private static Object fallback(Method method) throws SQLException {
        Class<?> type = method.getReturnType();
        if (type == void.class) return null;
        if (type == boolean.class) return false;
        if (type == int.class) return 0;
        if (type == long.class) return 0L;
        if (type == String.class) return "";
        throw new SQLFeatureNotSupportedException(method.getName());
    }
    public boolean acceptsURL(String url) { return url.startsWith("jdbc:fixture:multiple"); }
    public Connection connect(String url, Properties properties) {
        if (!acceptsURL(url)) return null;
        boolean[] closed = {false}, auto = {true};
        return proxy(Connection.class, (owner, method, args) -> switch (method.getName()) {
            case "createStatement" -> statement();
            case "getAutoCommit" -> auto[0];
            case "setAutoCommit" -> { auto[0] = (boolean) args[0]; yield null; }
            case "isClosed" -> closed[0];
            case "close" -> { closed[0] = true; yield null; }
            case "getCatalog", "getSchema" -> "";
            case "getMetaData" -> proxy(DatabaseMetaData.class, (o, m, a) -> {
                if (m.getReturnType() == ResultSet.class) return rows(new Output("empty", 0, "", -1, false), new AtomicBoolean());
                if (m.getName().equals("getIdentifierQuoteString")) return "\"";
                return fallback(m);
            });
            default -> fallback(method);
        });
    }
    private static Statement statement() {
        AtomicBoolean canceled = new AtomicBoolean();
        List<Output> outputs = new ArrayList<>();
        int[] index = {0}; String[] mode = {""}; ResultSet[] current = {null}; boolean[] fetched = {false};
        return proxy(Statement.class, (owner, method, args) -> {
            Output output = index[0] < outputs.size() ? outputs.get(index[0]) : null;
            return switch (method.getName()) {
                case "execute" -> {
                    mode[0] = (String) args[0]; outputs.clear(); index[0] = 0; fetched[0] = false;
                    if (mode[0].contains("large")) {
                        outputs.add(new Output("first", 3, "x".repeat(1024 * 1024), -1, false));
                        outputs.add(new Output("second", 8, "y".repeat(1024 * 1024), -1, false));
                    } else if (mode[0].contains("many") || mode[0].contains("endless")) {
                        for (int i = 0; i < 101; i++) outputs.add(new Output("part"+i, 0, "", 0, false));
                    } else if (mode[0].contains("partial")) {
                        outputs.add(new Output("first", 1, "kept", -1, false));
                        outputs.add(new Output("second", 3, "partial", -1, true));
                    } else {
                        outputs.add(new Output("", 0, "", 0, false));
                        outputs.add(new Output("first", 2, "first", -1, false));
                        outputs.add(new Output("", 0, "", 9007199254740993L, false));
                        outputs.add(new Output("empty", 0, "", -1, false));
                        outputs.add(new Output("second", 1, "second", -1, false));
                    }
                    yield outputs.get(0).updated() == -1;
                }
                case "getResultSet" -> {
                    if (fetched[0]) throw new SQLException("getResultSet called twice for one result");
                    fetched[0] = true; current[0] = rows(output, canceled); yield current[0];
                }
                case "getLargeUpdateCount" -> {
                    if (mode[0].contains("legacy")) throw new SQLFeatureNotSupportedException("fixture legacy counts");
                    yield output == null ? -1L : output.updated();
                }
                case "getUpdateCount" -> output == null ? -1 : (int) output.updated();
                case "clearWarnings" -> {
                    if (mode[0].contains("legacy")) throw new SQLFeatureNotSupportedException("fixture read-only warnings");
                    yield null;
                }
                case "getMoreResults" -> {
                    if (current[0] != null && !current[0].isClosed()) throw new SQLException("Previous ResultSet was not closed");
                    if (mode[0].contains("unsupported")) throw new SQLFeatureNotSupportedException("fixture unsupported");
                    if (index[0] == 1 && mode[0].contains("error")) throw new SQLException("fixture later error");
                    if (index[0] == 1 && mode[0].contains("cancel")) {
                        long end = System.nanoTime() + 20_000_000_000L;
                        while (!canceled.get() && System.nanoTime() < end) Thread.sleep(10);
                        if (canceled.get()) throw new SQLException("fixture canceled");
                    }
                    if (mode[0].contains("endless")) index[0] = 0; else index[0]++;
                    current[0] = null; fetched[0] = false;
                    yield index[0] < outputs.size() && outputs.get(index[0]).updated() == -1;
                }
                case "cancel" -> { canceled.set(true); yield null; }
                case "getWarnings" -> null;
                default -> fallback(method);
            };
        });
    }
    private static ResultSet rows(Output output, AtomicBoolean canceled) {
        int[] row = {0}; boolean[] closed = {false};
        return proxy(ResultSet.class, (owner, method, args) -> switch (method.getName()) {
            case "next" -> {
                if (closed[0]) throw new SQLException("closed ResultSet");
                if (canceled.get()) throw new SQLException("canceled ResultSet");
                if (output.partialFailure() && row[0] == 1) throw new SQLException("fixture partial row error");
                yield ++row[0] <= output.rows();
            }
            case "close" -> { closed[0] = true; yield null; }
            case "isClosed" -> closed[0];
            case "getString" -> output.text();
            case "getMetaData" -> proxy(ResultSetMetaData.class, (o, m, a) -> switch (m.getName()) {
                case "getColumnCount" -> 1;
                case "getColumnLabel", "getColumnName" -> output.name();
                case "getColumnTypeName" -> "varchar";
                case "getColumnType" -> Types.VARCHAR;
                default -> fallback(m);
            });
            default -> fallback(method);
        });
    }
    public DriverPropertyInfo[] getPropertyInfo(String url, Properties properties) { return new DriverPropertyInfo[0]; }
    public int getMajorVersion() { return 1; }
    public int getMinorVersion() { return 0; }
    public boolean jdbcCompliant() { return false; }
    public Logger getParentLogger() { return Logger.getLogger("fixture"); }
}
