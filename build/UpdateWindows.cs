using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

// Runs from the update cache, never from the application directory being replaced.
// .NET Framework 4.x is part of the supported Windows 11 installation.
internal static class UpdateWindows {
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static Dictionary<string, object> request;
    static string status, log;
    static string Value(string key) { return Convert.ToString(request[key]); }
    static void Write(string path, object value) {
        string temporary = path + ".tmp";
        File.WriteAllText(temporary, Json.Serialize(value), new UTF8Encoding(false));
        if (File.Exists(path)) File.Replace(temporary, path, null); else File.Move(temporary, path);
    }
    static void State(string phase, string message) {
        Write(status, new { phase = phase, message = message, version = Value("version"), token = Value("token"), timestamp = DateTime.UtcNow.ToString("o") });
        File.AppendAllText(log, DateTime.UtcNow.ToString("o") + " " + phase + ": " + message + Environment.NewLine, new UTF8Encoding(false));
    }
    static string Hash(string file) { using (var stream = File.OpenRead(file)) using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant(); }
    static Process Start(string file, string arguments, string directory) {
        return Process.Start(new ProcessStartInfo { FileName = file, Arguments = arguments, WorkingDirectory = directory, UseShellExecute = false, CreateNoWindow = true });
    }
    static bool UnderUser(string file) {
        string root = Path.GetFullPath(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile)).TrimEnd('\\') + "\\";
        return Path.GetFullPath(file).StartsWith(root, StringComparison.OrdinalIgnoreCase);
    }
    [STAThread]
    static int Main(string[] args) {
        bool parentExited = false, installerRunning = false;
        try {
            if (args.Length != 1) throw new ArgumentException("Expected an update request file");
            request = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(args[0], Encoding.UTF8));
            string installer = Path.GetFullPath(Value("installer")), application = Path.GetFullPath(Value("application"));
            string directory = Path.GetDirectoryName(application), work = Path.GetDirectoryName(args[0]);
            status = Path.GetFullPath(Value("status")); log = Path.Combine(work, "install.log");
            if (!UnderUser(application) || !UnderUser(status) || !File.Exists(installer) || !File.Exists(application) || directory.IndexOfAny(new char[] { '"', '\r', '\n' }) >= 0) throw new IOException("Invalid per-user update paths");
            if (Hash(installer) != Value("sha256")) throw new IOException("Installer SHA256 changed before launch");
            Process parent = Process.GetProcessById(Convert.ToInt32(request["parentId"]));
            if (!String.Equals(Path.GetFullPath(parent.MainModule.FileName), application, StringComparison.OrdinalIgnoreCase)) throw new IOException("Parent process does not match application");
            State("waiting", "Update helper is ready; waiting for the application to exit");
            Write(Path.Combine(work, "helper-ready.json"), new { token = Value("token"), pid = Process.GetCurrentProcess().Id });
            if (!parent.WaitForExit(60000)) throw new IOException("Application did not exit within 60 seconds; update canceled");
            parentExited = true;
            State("installing", "Installing into the current application directory");
            // NSIS /D MUST be last and unquoted, even when the path contains spaces.
            using (Process setup = Start(installer, "/S --updated /D=" + directory, work)) {
                installerRunning = true;
                if (!setup.WaitForExit(300000)) throw new IOException("Installer did not finish within 5 minutes; inspect install.log before retrying");
                installerRunning = false;
                if (setup.ExitCode != 0) throw new IOException("Installer exited with code " + setup.ExitCode);
            }
            string installedVersion = FileVersionInfo.GetVersionInfo(application).ProductVersion;
            if (installedVersion != Value("version") && installedVersion != Value("version") + ".0") throw new IOException("Installer finished but application version is " + installedVersion + "; expected " + Value("version"));
            State("restarting", "Installer completed; starting the updated application");
            using (Process restarted = Start(application, "--updated", directory)) {
                string ackPath = Path.Combine(Path.GetDirectoryName(status), "startup-ack.json");
                for (int attempt = 0; attempt < 180; attempt++) {
                    if (File.Exists(ackPath)) {
                        var ack = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(ackPath, Encoding.UTF8));
                        if (Convert.ToString(ack["token"]) == Value("token") && Convert.ToString(ack["version"]) == Value("version")) { State("complete", "Updated application started successfully"); return 0; }
                    }
                    if (restarted.HasExited) throw new IOException("Updated application exited before startup confirmation (code " + restarted.ExitCode + ")");
                    Thread.Sleep(250);
                }
                throw new IOException("Application did not confirm startup within 45 seconds");
            }
        } catch (Exception error) {
            if (status != null) try { State("error", error.Message); } catch { }
            // If installation failed, reopen the available application so it can
            // display the persistent diagnostic. Never report success from exit code alone.
            if (parentExited && !installerRunning && request != null) try {
                string application = Value("application");
                bool running = false;
                foreach (Process process in Process.GetProcessesByName(Path.GetFileNameWithoutExtension(application))) {
                    try { if (String.Equals(process.MainModule.FileName, application, StringComparison.OrdinalIgnoreCase)) running = true; } catch { }
                    process.Dispose();
                }
                if (!running && File.Exists(application)) Start(application, "--update-failed", Path.GetDirectoryName(application));
            } catch { }
            return 1;
        }
    }
}
