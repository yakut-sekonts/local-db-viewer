package fixture;

import java.sql.*;
import java.util.Properties;
import java.util.logging.Logger;
import org.sqlite.Function;

/** Deliberately ignores loginTimeout and interruption; must be stopped by the IDE. */
public final class ConnectionTimeoutDriver implements Driver {
    public Connection connect(String url, Properties properties) throws SQLException {
        if (!acceptsURL(url)) return null;
        long shutdownDelay = Long.parseLong(properties.getProperty("shutdownDelayMs", "0"));
        if (shutdownDelay > 0) Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            try { Thread.sleep(shutdownDelay); } catch (InterruptedException ignored) {}
        }));
        long deadline = System.nanoTime() + Long.parseLong(properties.getProperty("delayMs", "0")) * 1_000_000;
        while (System.nanoTime() < deadline) {
            try { Thread.sleep(20); } catch (InterruptedException ignored) {}
        }
        Connection connection = new org.sqlite.JDBC().connect("jdbc:sqlite::memory:", new Properties());
        Function.create(connection, "fixture_sleep", new Function() {
            protected void xFunc() throws SQLException {
                try { Thread.sleep(value_int(0)); } catch (InterruptedException error) { throw new SQLException(error); }
                result(1);
            }
        });
        return connection;
    }
    public boolean acceptsURL(String url) { return url.startsWith("jdbc:timeout:"); }
    public DriverPropertyInfo[] getPropertyInfo(String url, Properties info) { return new DriverPropertyInfo[0]; }
    public int getMajorVersion() { return 1; }
    public int getMinorVersion() { return 0; }
    public boolean jdbcCompliant() { return false; }
    public Logger getParentLogger() { return Logger.getGlobal(); }
}
