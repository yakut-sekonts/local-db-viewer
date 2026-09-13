import java.io.IOException;
import java.net.*;
import javax.net.SocketFactory;

/** Driver-level SOCKS transport; leaves the original hostname available to TLS. */
public final class LocalDBViewerSocketFactory extends SocketFactory {
    private Socket socket() {
        int port = Integer.parseInt(System.getProperty("localdbviewer.ssh.port"));
        return new Socket(new Proxy(Proxy.Type.SOCKS, new InetSocketAddress("127.0.0.1", port))) {
            @Override public void connect(SocketAddress endpoint, int timeout) throws IOException {
                if (endpoint instanceof InetSocketAddress address)
                    endpoint = InetSocketAddress.createUnresolved(address.getHostString(), address.getPort());
                super.connect(endpoint, timeout);
            }
        };
    }
    @Override public Socket createSocket() { return socket(); }
    @Override public Socket createSocket(String host, int port) throws IOException { Socket s = socket(); s.connect(InetSocketAddress.createUnresolved(host, port)); return s; }
    @Override public Socket createSocket(InetAddress host, int port) throws IOException { return createSocket(host.getHostName(), port); }
    @Override public Socket createSocket(String host, int port, InetAddress local, int localPort) throws IOException { Socket s = socket(); s.bind(new InetSocketAddress(local, localPort)); s.connect(InetSocketAddress.createUnresolved(host, port)); return s; }
    @Override public Socket createSocket(InetAddress host, int port, InetAddress local, int localPort) throws IOException { return createSocket(host.getHostName(), port, local, localPort); }
}
