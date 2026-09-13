import java.net.*;
import java.nio.file.*;
import java.sql.*;
import java.io.*;
import java.util.*;

class DriverProbe {
    public static void main(String[] args) throws Exception {
        PrintStream result = System.out; System.setOut(System.err);
        URL[] files = new URL[args.length - 2];
        for (int i = 2; i < args.length; i++) files[i - 2] = Path.of(args[i]).toUri().toURL();
        try (URLClassLoader loader = new URLClassLoader(files, ClassLoader.getPlatformClassLoader())) {
            Thread.currentThread().setContextClassLoader(loader);
            Driver driver = (Driver) Class.forName(args[0], true, loader).getDeclaredConstructor().newInstance();
            if (!driver.acceptsURL(args[1])) throw new IllegalArgumentException("Driver does not accept URL template");
            result.println("DRIVER_OK " + driver.getMajorVersion() + "." + driver.getMinorVersion());
        }
    }
}
