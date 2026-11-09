using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using System.Drawing;

[assembly: AssemblyTitle("Together")]
[assembly: AssemblyProduct("Together")]
[assembly: AssemblyVersion("@@ASSEMBLY_VERSION@@")]

internal static class PortableLauncher {
    private const string PayloadId = "@@PAYLOAD_ID@@";
    [STAThread]
    private static int Main(string[] args) {
        Application.EnableVisualStyles();
        string executable = Assembly.GetExecutingAssembly().Location;
        string root = Path.GetDirectoryName(executable);
        string data = Path.Combine(root, "Together-data");
        Form progress = null;
        try {
            string temp = Path.Combine(data, "Temp");
            Directory.CreateDirectory(temp);
            Environment.SetEnvironmentVariable("TEMP", temp);
            Environment.SetEnvironmentVariable("TMP", temp);
            Environment.SetEnvironmentVariable("TMPDIR", temp);
            string runtime = Path.Combine(data, "Runtime", PayloadId);
            string complete = Path.Combine(runtime, ".complete");
            string app = Path.Combine(runtime, "Together.exe");
            string mutexId;
            using (SHA256 sha = SHA256.Create()) mutexId = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(root.ToUpperInvariant() + PayloadId))).Replace("-", "");
            using (Mutex gate = new Mutex(false, "Local\\TogetherPortable-" + mutexId)) {
                bool locked;
                try { locked = gate.WaitOne(120000); } catch (AbandonedMutexException) { locked = true; }
                if (!locked) throw new IOException("Another copy is still preparing Together. Wait a moment and try again.");
                try {
                    if (!File.Exists(complete) || !File.Exists(app)) {
                        progress = new Form { Text = "Starting Together", Width = 440, Height = 150,
                            StartPosition = FormStartPosition.CenterScreen, FormBorderStyle = FormBorderStyle.FixedDialog,
                            MaximizeBox = false, MinimizeBox = false, ControlBox = false, BackColor = Color.FromArgb(19,26,19) };
                        Label label = new Label { Text = "Preparing Together beside this EXE…", ForeColor = Color.FromArgb(215,235,176),
                            Left = 22, Top = 20, Width = 390, Height = 25 };
                        ProgressBar bar = new ProgressBar { Left = 22, Top = 58, Width = 380, Height = 18 };
                        progress.Controls.Add(label); progress.Controls.Add(bar); progress.Show(); Application.DoEvents();
                        Directory.CreateDirectory(runtime);
                        string safeRoot = Path.GetFullPath(runtime) + Path.DirectorySeparatorChar;
                        using (Stream payload = Assembly.GetExecutingAssembly().GetManifestResourceStream("TogetherPayload.zip")) {
                            if (payload == null) throw new IOException("The embedded app is missing. Download Together again.");
                            using (ZipArchive archive = new ZipArchive(payload, ZipArchiveMode.Read)) {
                                int index = 0;
                                foreach (ZipArchiveEntry entry in archive.Entries) {
                                    string target = Path.GetFullPath(Path.Combine(runtime, entry.FullName));
                                    if (!target.StartsWith(safeRoot, StringComparison.OrdinalIgnoreCase)) throw new IOException("Invalid application archive path.");
                                    if (String.IsNullOrEmpty(entry.Name)) Directory.CreateDirectory(target);
                                    else {
                                        Directory.CreateDirectory(Path.GetDirectoryName(target));
                                        using (Stream input = entry.Open())
                                        using (FileStream output = new FileStream(target, FileMode.Create, FileAccess.Write)) input.CopyTo(output);
                                    }
                                    bar.Value = Math.Min(100, ++index * 100 / archive.Entries.Count);
                                    Application.DoEvents();
                                }
                            }
                        }
                        File.WriteAllText(complete, PayloadId);
                        progress.Close(); progress.Dispose(); progress = null;
                    }
                } finally { gate.ReleaseMutex(); }
            }
            ProcessStartInfo start = new ProcessStartInfo(app) { UseShellExecute = false, WorkingDirectory = root, Arguments = JoinArguments(args) };
            start.EnvironmentVariables["PORTABLE_EXECUTABLE_DIR"] = root;
            start.EnvironmentVariables["PORTABLE_EXECUTABLE_FILE"] = executable;
            start.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
            start.EnvironmentVariables["TEMP"] = temp;
            start.EnvironmentVariables["TMP"] = temp;
            using (Process child = Process.Start(start)) { child.WaitForExit(); return child.ExitCode; }
        } catch (Exception error) {
            if (progress != null) { progress.Close(); progress.Dispose(); }
            MessageBox.Show("Together could not start. Keep this EXE in a writable folder on D: (or another drive with space).\n\n" + error.Message,
                "Together", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
    private static string JoinArguments(string[] arguments) {
        StringBuilder result = new StringBuilder();
        foreach (string argument in arguments) {
            if (result.Length > 0) result.Append(' ');
            result.Append('"'); int slashes = 0;
            foreach (char c in argument) {
                if (c == '\\') { slashes++; continue; }
                if (c == '"') { result.Append('\\', slashes * 2 + 1); result.Append(c); slashes = 0; continue; }
                result.Append('\\', slashes); slashes = 0; result.Append(c);
            }
            result.Append('\\', slashes * 2); result.Append('"');
        }
        return result.ToString();
    }
}
