using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.DependencyInjection;
using Photino.NET;

namespace SimulaSharp.Studio.Host;

/// <summary>
/// The SimulaSharp.Studio desktop shell. Hosts the ASP.NET Core backend (Kestrel + SignalR) <b>in-process</b>
/// on a loopback-only, OS-assigned port, then opens a Photino native webview on it — one .NET process, no
/// Node/Chromium. This is the Phase-0 backbone: it proves the shell boots and the SPA↔backend channel is live
/// before any editor breadth is built. The served page is a placeholder until the Vite SPA is wired in.
/// </summary>
internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        // ── Backend: in-process ASP.NET Core, bound to loopback with an OS-assigned port (:0). ──
        var builder = WebApplication.CreateBuilder(args);
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        builder.Services.AddSignalR();

        var app = builder.Build();
        app.MapHub<StudioHub>("/hub");                          // the real SPA↔backend channel (used from Phase 1)
        app.MapGet("/ping", () => "backend connected");         // self-contained liveness probe for the placeholder
        app.MapGet("/", () => Results.Content(PlaceholderPage, "text/html"));

        app.StartAsync().GetAwaiter().GetResult();              // non-blocking; Kestrel runs on background threads
        var url = app.Services.GetRequiredService<IServer>()
                     .Features.Get<IServerAddressesFeature>()!.Addresses.First();

        // ── Shell: a Photino window on the served backend. ──
        new PhotinoWindow()
            .SetTitle("SimulaSharp.Studio")
            .SetUseOsDefaultSize(false)
            .SetSize(1400, 900)
            .Center()
            .Load(new Uri(url))
            .WaitForClose();                                    // blocks the main thread until the window closes

        app.StopAsync().GetAwaiter().GetResult();
    }

    private const string PlaceholderPage = """
        <!doctype html><html><head><meta charset="utf-8"><title>SimulaSharp.Studio</title>
        <style>
          body{font-family:system-ui,sans-serif;background:#0b1020;color:#dbeafe;display:grid;place-items:center;height:100vh;margin:0}
          .muted{opacity:.55}
        </style></head><body>
        <div style="text-align:center">
          <h1>SimulaSharp.Studio</h1>
          <p id="status" class="muted">checking backend…</p>
        </div>
        <script>
          fetch('/ping').then(r => r.text()).then(t => {
            const s = document.getElementById('status'); s.textContent = t; s.classList.remove('muted');
          }).catch(e => { document.getElementById('status').textContent = 'backend error: ' + e; });
        </script>
        </body></html>
        """;
}

/// <summary>The Phase-0 SignalR hub — a liveness ping today, the live channel (cross-validation, generate
/// progress, snapshot/undo push) as the backend grows.</summary>
internal sealed class StudioHub : Hub
{
    public string Ping() => "backend connected";
}
