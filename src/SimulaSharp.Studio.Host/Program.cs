using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.DependencyInjection;
using Photino.NET;

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
        builder.Services.AddSignalR();

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
        new PhotinoWindow()
            .SetTitle("SimulaSharp.Studio")
            .SetUseOsDefaultSize(false)
            .SetSize(1400, 900)
            .Center()
            .Load(new Uri(url))
            .WaitForClose();                               // blocks the main thread until the window closes

        app.StopAsync().GetAwaiter().GetResult();
    }
}

/// <summary>The SignalR hub — a liveness ping today; the live channel (cross-validation, generate progress,
/// snapshot/undo push) as the backend grows.</summary>
internal sealed class StudioHub : Hub
{
    public string Ping() => "backend connected";
}
