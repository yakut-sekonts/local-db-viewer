import com.google.gson.*;
import java.nio.charset.StandardCharsets;
import java.sql.*;
import java.util.*;

/** Portable JDBC metadata only: never queries application table rows. */
final class JdbcMetadata {
    private static final Gson JSON = new Gson();
    static String value(ResultSet rows, String column) throws SQLException { return Objects.toString(rows.getString(column), ""); }
    static String catalog(Connection connection) throws SQLException {
        try { return Objects.toString(connection.getCatalog(), ""); } catch (SQLFeatureNotSupportedException | AbstractMethodError unsupported) { return ""; }
    }
    static String schema(Connection connection) throws SQLException {
        try { return Objects.toString(connection.getSchema(), ""); } catch (SQLFeatureNotSupportedException | AbstractMethodError unsupported) { return ""; }
    }
    private static String nullable(String value) { return value.isEmpty() ? null : value; }
    private static String pattern(DatabaseMetaData metadata, String name) throws SQLException {
        String escape = metadata.getSearchStringEscape();
        if (escape == null || escape.isEmpty()) return name;
        return name.replace(escape, escape + escape).replace("%", escape + "%").replace("_", escape + "_");
    }
    private static boolean same(ResultSet rows, String column, String expected) throws SQLException { return expected.isEmpty() || value(rows, column).equals(expected); }
    private static final class Rows {
        final JsonArray rows = new JsonArray(); long bytes; boolean truncated;
        boolean add(String... values) {
            JsonElement row = JSON.toJsonTree(values); long size = row.toString().getBytes(StandardCharsets.UTF_8).length;
            if (rows.size() >= 10000 || bytes + size > 8 * 1024 * 1024) { truncated = true; return false; }
            rows.add(row); bytes += size; return true;
        }
        JsonObject result(String... names) {
            JsonObject result = new JsonObject(); JsonArray columns = new JsonArray();
            for (String name : names) { JsonObject column = new JsonObject(); column.addProperty("name", name); column.addProperty("type", "varchar"); columns.add(column); }
            result.add("columns", columns); result.add("rows", rows); result.addProperty("truncated", truncated); return result;
        }
    }
    static JsonObject read(Connection connection, String kind, String catalog, String schema, String table) throws SQLException {
        DatabaseMetaData metadata = connection.getMetaData(); Rows output = new Rows();
        switch (kind) {
            case "catalogs" -> {
                try (ResultSet rows = metadata.getCatalogs()) { while (rows.next()) if (!output.add(value(rows, "TABLE_CAT"))) break; }
                catch (SQLFeatureNotSupportedException unsupported) { /* A driver may have no catalog namespace. */ }
                if (output.rows.isEmpty()) output.add(catalog(connection));
            }
            case "schemas" -> {
                try {
                    ResultSet source;
                    try { source = metadata.getSchemas(nullable(catalog), null); }
                    catch (SQLFeatureNotSupportedException | AbstractMethodError unsupported) { source = metadata.getSchemas(); }
                    try (ResultSet rows = source) { while (rows.next()) if (same(rows, "TABLE_CATALOG", catalog) && !output.add(value(rows, "TABLE_SCHEM"))) break; }
                } catch (SQLFeatureNotSupportedException | AbstractMethodError unsupported) { /* No schema namespace. */ }
                if (output.rows.isEmpty()) output.add(schema(connection));
            }
            case "tables" -> {
                try (ResultSet rows = metadata.getTables(nullable(catalog), pattern(metadata, schema), "%", null)) {
                    while (rows.next()) if (same(rows, "TABLE_CAT", catalog) && same(rows, "TABLE_SCHEM", schema) && !output.add(value(rows, "TABLE_NAME"))) break;
                }
            }
            case "columns" -> {
                try (ResultSet rows = metadata.getColumns(nullable(catalog), pattern(metadata, schema), pattern(metadata, table), "%")) {
                    while (rows.next()) if (same(rows, "TABLE_CAT", catalog) && same(rows, "TABLE_SCHEM", schema) && same(rows, "TABLE_NAME", table) && !output.add(value(rows, "COLUMN_NAME"), value(rows, "TYPE_NAME"))) break;
                }
            }
            default -> throw new SQLException("Unknown metadata operation");
        }
        return kind.equals("columns") ? output.result("name", "type") : output.result("name");
    }
    static JsonObject index(Connection connection, String profileId, String catalog, String schema) throws SQLException {
        if (catalog.isEmpty()) catalog = catalog(connection);
        if (schema.isEmpty()) schema = schema(connection);
        DatabaseMetaData metadata = connection.getMetaData(); JsonObject result = new JsonObject();
        result.addProperty("profileId", profileId); result.addProperty("catalog", catalog); result.addProperty("schema", schema);
        JsonArray tables = new JsonArray(), relations = new JsonArray(), warnings = new JsonArray();
        result.add("tables", tables); result.add("relationships", relations); result.add("warnings", warnings);
        JsonObject dialect = new JsonObject();
        dialect.addProperty("quote", Objects.toString(metadata.getIdentifierQuoteString(), "").trim());
        dialect.addProperty("catalogs", metadata.supportsCatalogsInDataManipulation());
        dialect.addProperty("schemas", metadata.supportsSchemasInDataManipulation());
        dialect.addProperty("catalogAtStart", metadata.isCatalogAtStart());
        dialect.addProperty("catalogSeparator", Objects.toString(metadata.getCatalogSeparator(), "."));
        dialect.addProperty("unquotedCase", metadata.storesLowerCaseIdentifiers() ? "lower" : metadata.storesUpperCaseIdentifiers() ? "upper" : "preserve");
        boolean fullOuterJoins = false;
        try { fullOuterJoins = metadata.supportsFullOuterJoins(); } catch (SQLFeatureNotSupportedException unsupported) { }
        dialect.addProperty("fullOuterJoins", fullOuterJoins); result.add("dialect", dialect);
        if (schema.isEmpty() && metadata.supportsSchemasInTableDefinitions()) {
            warnings.add("Выберите schema в Database Explorer для автодополнения."); return result;
        }
        LinkedHashMap<String, JsonObject> byTable = new LinkedHashMap<>(); Rows budget = new Rows();
        try (ResultSet rows = metadata.getColumns(nullable(catalog), pattern(metadata, schema), "%", "%")) {
            while (rows.next()) {
                if (!same(rows, "TABLE_CAT", catalog) || !same(rows, "TABLE_SCHEM", schema)) continue;
                String name = value(rows, "TABLE_NAME"), columnName = value(rows, "COLUMN_NAME"), type = value(rows, "TYPE_NAME");
                if (!budget.add(name, columnName, type)) { warnings.add("Индекс ограничен 10 000 колонок / 8 MB. Уточните schema."); break; }
                JsonObject table = byTable.get(name);
                if (table == null) { table = ref(catalog, schema, name); table.add("columns", new JsonArray()); byTable.put(name, table); tables.add(table); }
                JsonObject column = new JsonObject(); column.addProperty("name", columnName); column.addProperty("type", type); table.getAsJsonArray("columns").add(column);
            }
        }
        int count = 0, foreignRows = 0;
        for (String table : byTable.keySet()) {
            if (++count > 200) { warnings.add("Foreign keys загружены для первых 200 таблиц."); break; }
            // Named composite keys are grouped by all endpoint identifiers, never by column alone.
            LinkedHashMap<String, JsonObject> grouped = new LinkedHashMap<>(); boolean complete = true;
            try (ResultSet rows = metadata.getImportedKeys(nullable(catalog), nullable(schema), table)) {
                while (rows.next()) {
                    if (++foreignRows > 10000) { complete = false; warnings.add("Список foreign keys ограничен; неполные ключи исключены."); break; }
                    String name = value(rows, "FK_NAME");
                    if (name.isEmpty()) { if (warnings.isEmpty()) warnings.add("Безымянные foreign keys пропущены: невозможно надёжно сгруппировать составные ключи."); continue; }
                    JsonObject source = ref(value(rows, "FKTABLE_CAT"), value(rows, "FKTABLE_SCHEM"), value(rows, "FKTABLE_NAME"));
                    JsonObject target = ref(value(rows, "PKTABLE_CAT"), value(rows, "PKTABLE_SCHEM"), value(rows, "PKTABLE_NAME"));
                    String key = name + ":" + source + ":" + target;
                    JsonObject relation = grouped.get(key);
                    if (relation == null) {
                        relation = new JsonObject(); relation.addProperty("id", "jdbc:" + key); relation.addProperty("name", name); relation.addProperty("kind", "foreign-key"); relation.add("source", source); relation.add("target", target); relation.add("columns", new JsonArray()); grouped.put(key, relation);
                    }
                    JsonObject pair = new JsonObject(); pair.addProperty("source", value(rows, "FKCOLUMN_NAME")); pair.addProperty("target", value(rows, "PKCOLUMN_NAME")); relation.getAsJsonArray("columns").add(pair);
                }
            } catch (SQLException | AbstractMethodError unsupported) { warnings.add("Драйвер не вернул foreign keys: " + unsupported.getClass().getSimpleName()); break; }
            if (complete) grouped.values().forEach(relations::add); else break;
        }
        return result;
    }
    private static JsonObject ref(String catalog, String schema, String name) {
        JsonObject value = new JsonObject(); value.addProperty("catalog", catalog); value.addProperty("schema", schema); value.addProperty("name", name); return value;
    }
    private static String quote(DatabaseMetaData metadata, String name) throws SQLException {
        String quote = metadata.getIdentifierQuoteString();
        if (quote == null || quote.isBlank()) {
            if (!name.matches("[A-Za-z_][A-Za-z0-9_]*")) throw new SQLException("Driver cannot quote this identifier; enter the query manually");
            return name;
        }
        String end = quote.equals("[") ? "]" : quote;
        return quote + name.replace(end, end + end) + end;
    }
    static String preview(Connection connection, String catalog, String schema, String table) throws SQLException {
        if (table.isEmpty()) throw new SQLException("Table name is empty");
        DatabaseMetaData metadata = connection.getMetaData(); String name = quote(metadata, table);
        if (!schema.isEmpty() && metadata.supportsSchemasInDataManipulation()) name = quote(metadata, schema) + "." + name;
        if (!catalog.isEmpty() && metadata.supportsCatalogsInDataManipulation()) name = metadata.isCatalogAtStart()
            ? quote(metadata, catalog) + metadata.getCatalogSeparator() + name : name + metadata.getCatalogSeparator() + quote(metadata, catalog);
        return "SELECT * FROM " + name;
    }
}
