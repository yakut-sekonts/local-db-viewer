import com.google.gson.*;
import java.io.*;
import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.security.cert.*;
import java.util.*;

/** Maps explicit certificate choices to driver properties, without weakening TLS. */
final class JdbcCertificates {
    private static String text(JsonObject object, String key, String fallback) { return object.has(key) ? object.get(key).getAsString() : fallback; }
    private static Path checked(String path) throws IOException {
        Path file = Path.of(path);
        if (!file.isAbsolute() || !Files.isRegularFile(file) || Files.size(file) > 16 * 1024 * 1024) throw new IOException("Certificate/key file must be an absolute path to a file up to 16 MB");
        return file;
    }
    private static Path temporary(String suffix, List<Path> files) throws IOException {
        Path path = Files.createTempFile("local-db-viewer-tls-", suffix); files.add(path); return path;
    }
    static void apply(JsonObject config, Properties properties, List<Path> files) throws Exception {
        JsonObject c = config.has("certificates") ? config.getAsJsonObject("certificates") : new JsonObject();
        String driver = text(config, "driverId", text(config, "engine", ""));
        String trust = text(c, "trustSource", "driver"), client = text(c, "clientMode", "none");
        if (trust.equals("driver") && client.equals("none")) return;
        if (!Set.of("trino", "presto", "postgres", "mysql", "mariadb", "mssql", "clickhouse").contains(driver))
            throw new IllegalArgumentException("Certificate panel is not supported by this JDBC driver; use its native Advanced properties");
        if (!trust.equals("driver")) {
            String path = text(c, "trustStorePath", ""), password = text(c, "trustStorePassword", ""), type = text(c, "trustStoreType", "PKCS12");
            if (trust.equals("java")) {
                path = Path.of(System.getProperty("java.home"), "lib", "security", "cacerts").toString(); password = "changeit"; type = "JKS";
            } else if (trust.equals("system")) {
                String os = System.getProperty("os.name").toLowerCase(Locale.ROOT);
                KeyStore system = KeyStore.getInstance(os.contains("win") ? "Windows-ROOT" : "KeychainStore"); system.load(null, null);
                KeyStore store = KeyStore.getInstance("PKCS12"); store.load(null, null);
                for (Enumeration<String> names = system.aliases(); names.hasMoreElements();) { String name = names.nextElement(); java.security.cert.Certificate cert = system.getCertificate(name); if (cert != null) store.setCertificateEntry(name, cert); }
                if (store.size() == 0) throw new CertificateException("System truststore contains no certificates");
                Path target = temporary(".p12", files); password = UUID.randomUUID().toString();
                try (OutputStream output = Files.newOutputStream(target)) { store.store(output, password.toCharArray()); }
                path = target.toString(); type = "PKCS12";
            }
            Path file = checked(path);
            if (type.equals("PEM") && Set.of("postgres", "mariadb", "clickhouse").contains(driver)) {
                put(properties, driver.equals("mariadb") ? "serverSslCert" : "sslrootcert", file.toString());
            } else {
                if (type.equals("PEM")) {
                    KeyStore store = KeyStore.getInstance("PKCS12"); store.load(null, null); int index = 0;
                    try (InputStream input = Files.newInputStream(file)) { for (java.security.cert.Certificate cert : CertificateFactory.getInstance("X.509").generateCertificates(input)) store.setCertificateEntry("ca-" + index++, cert); }
                    if (index == 0) throw new CertificateException("CA file contains no certificates");
                    file = temporary(".p12", files); password = UUID.randomUUID().toString(); type = "PKCS12";
                    try (OutputStream output = Files.newOutputStream(file)) { store.store(output, password.toCharArray()); }
                }
                storeProperties(driver, properties, file, password, type, false, files);
            }
        }
        if (client.equals("system")) {
            if (!Set.of("trino", "presto").contains(driver)) throw new IllegalArgumentException("System client keystore is supported in this panel for Trino/Presto only");
            put(properties, "SSLUseSystemKeyStore", "true");
        } else if (client.equals("store")) {
            storeProperties(driver, properties, checked(text(c, "clientStorePath", "")), text(c, "clientStorePassword", ""), text(c, "clientStoreType", "PKCS12"), true, files);
        } else if (client.equals("pem")) {
            Path cert = checked(text(c, "clientCertificatePath", "")), key = checked(text(c, "clientKeyPath", ""));
            String password = text(c, "clientKeyPassword", "");
            if (Set.of("trino", "presto").contains(driver)) {
                Path bundle = temporary(".pem", files);
                Files.writeString(bundle, Files.readString(cert) + "\n" + Files.readString(key), StandardCharsets.UTF_8);
                put(properties, "SSLKeyStorePath", bundle.toString()); put(properties, "SSLKeyStorePassword", password);
            } else if (driver.equals("postgres")) {
                put(properties, "sslcert", cert.toString()); put(properties, "sslkey", key.toString()); put(properties, "sslpassword", password);
            } else if (driver.equals("clickhouse")) {
                if (!password.isEmpty()) throw new IllegalArgumentException("Encrypted PEM client key is not supported by the ClickHouse certificate panel; use driver Advanced properties");
                put(properties, "sslcert", cert.toString()); put(properties, "sslkey", key.toString());
            } else throw new IllegalArgumentException("For this driver select a PKCS12/JKS client keystore instead of PEM");
        }
    }
    private static void put(Properties properties, String key, String value) {
        // Conflicting configuration is explicit; never silently ignore a selected certificate.
        if (properties.containsKey(key) && !properties.getProperty(key).equals(value)) throw new IllegalArgumentException("Certificate setting conflicts with Advanced property " + key);
        properties.setProperty(key, value);
    }
    private static void storeProperties(String driver, Properties p, Path file, String password, String type, boolean client, List<Path> files) throws Exception {
        if (Set.of("trino", "presto").contains(driver)) {
            String prefix = client ? "SSLKeyStore" : "SSLTrustStore";
            put(p, prefix + "Path", file.toString()); put(p, prefix + "Password", password); put(p, prefix + "Type", type);
        } else if (driver.equals("mysql")) {
            String prefix = client ? "clientCertificateKeyStore" : "trustCertificateKeyStore";
            put(p, prefix + "Url", file.toUri().toString()); put(p, prefix + "Password", password); put(p, prefix + "Type", type);
        } else if (driver.equals("mssql") && !client) {
            put(p, "trustStore", file.toString()); put(p, "trustStorePassword", password); put(p, "trustStoreType", type);
        } else if (driver.equals("postgres")) {
            if (client && type.equals("PKCS12")) { put(p, "sslkey", file.toString()); put(p, "sslpassword", password); }
            else if (client) throw new IllegalArgumentException("PostgreSQL client keystore must be PKCS12 with alias user");
            else exportRoots(driver, p, file, password, type, files);
        } else if (driver.equals("mariadb") && client) {
            put(p, "keyStore", file.toString()); put(p, "keyStorePassword", password);
        } else if (!client && Set.of("mariadb", "clickhouse").contains(driver)) {
            exportRoots(driver, p, file, password, type, files);
        } else throw new IllegalArgumentException("Client keystore is not supported by this driver's certificate panel; use native Advanced properties");
    }
    private static void exportRoots(String driver, Properties p, Path file, String password, String type, List<Path> files) throws Exception {
            KeyStore store = KeyStore.getInstance(type);
            try (InputStream input = Files.newInputStream(file)) { store.load(input, password.toCharArray()); }
            StringBuilder pem = new StringBuilder();
            for (Enumeration<String> names = store.aliases(); names.hasMoreElements();) { java.security.cert.Certificate cert = store.getCertificate(names.nextElement()); if (cert != null) pem.append("-----BEGIN CERTIFICATE-----\n").append(Base64.getMimeEncoder(64, new byte[]{10}).encodeToString(cert.getEncoded())).append("\n-----END CERTIFICATE-----\n"); }
            if (pem.isEmpty()) throw new CertificateException("Truststore contains no certificates");
            // MariaDB accepts the PEM content directly; ClickHouse requires a file.
            if (driver.equals("mariadb")) put(p, "serverSslCert", pem.toString());
            else { Path target = temporary(".pem", files); Files.writeString(target, pem.toString()); put(p, "sslrootcert", target.toString()); }
    }
}
