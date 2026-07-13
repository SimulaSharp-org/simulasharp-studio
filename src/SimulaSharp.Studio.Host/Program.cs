using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using System.Text.Json;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.DependencyInjection;
using Photino.NET;
using SimulaSharp.Studio.Core;

namespace SimulaSharp.Studio.Host;

/// <summary>
/// The SimulaSharp.Studio desktop shell. Hosts the ASP.NET Core backend (Kestrel + SignalR) <b>in-process</b>
/// on a loopback-only, OS-assigned port, serves the built Vite SPA from <c>wwwroot</c> (same-origin, so the
/// SPA's relative <c>/hub</c> just works), then opens a Photino native webview on it — one .NET process, no
/// Node/Chromium. Build the SPA first (<c>cd Studio/web &amp;&amp; npm run build</c>); the Host copies its
/// <c>dist</c> into <c>wwwroot</c> at build.
/// </summary>
internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        // ── Backend: in-process ASP.NET Core, loopback + OS-assigned port; web root next to the executable. ──
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions
        {
            Args = args,
            ContentRootPath = AppContext.BaseDirectory,   // so "wwwroot" resolves beside the built exe
            WebRootPath = "wwwroot",
        });
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        builder.Services.AddSignalR()
            .AddJsonProtocol(o => o.PayloadSerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase);

        var app = builder.Build();
        app.UseDefaultFiles();                             // "/" → /index.html
        app.UseStaticFiles();                              // serve the built SPA from wwwroot

        app.MapHub<StudioHub>("/hub");                     // the SPA↔backend channel
        app.MapGet("/ping", () => "backend connected");    // simple liveness probe
        app.MapFallbackToFile("index.html");               // SPA client-side routing

        app.StartAsync().GetAwaiter().GetResult();         // non-blocking; Kestrel runs on background threads
        var url = app.Services.GetRequiredService<IServer>()
                     .Features.Get<IServerAddressesFeature>()!.Addresses.First();

        // ── Shell: a Photino window on the served SPA. ──
        var window = new PhotinoWindow()
            .SetTitle("SimulaSharp.Studio")
            .SetUseOsDefaultSize(false)
            .SetSize(1400, 900)
            .Center()
            .RegisterWebMessageReceivedHandler(OnWebMessage)
            .Load(new Uri(url));
        window.WaitForClose();                             // blocks the main thread until the window closes

        app.StopAsync().GetAwaiter().GetResult();
    }

    /// <summary>Bridges native-shell requests from the SPA. Today: a native "open .csproj" file dialog whose result
    /// is posted back to the SPA as <c>project:&lt;path&gt;</c>.</summary>
    private static void OnWebMessage(object? sender, string message)
    {
        if (sender is not PhotinoWindow w) return;
        if (message == "pickProject")
        {
            var files = w.ShowOpenFile("Open a C# project", multiSelect: false,
                filters: [("C# project", ["csproj"])]);
            if (files.Length > 0)
                w.SendWebMessage("project:" + files[0]);
        }
    }
}

/// <summary>The SignalR hub — a liveness ping today; the live channel (cross-validation, generate progress,
/// snapshot/undo push) as the backend grows.</summary>
internal sealed class StudioHub : Hub
{
    public string Ping() => "backend connected";

    /// <summary>Opens an existing project and returns its designable-type IR for the SPA to render.</summary>
    public Task<ProjectModel> OpenProject(string path) => new ProjectWorkspace().OpenAsync(path);

    /// <summary>Replays the SPA's pending edit journal back into the project's source; returns the re-derived IR.</summary>
    public Task<GenerateResult> Generate(string path, EditAction[] actions) => new ProjectGenerator().ApplyAsync(path, actions);
}
