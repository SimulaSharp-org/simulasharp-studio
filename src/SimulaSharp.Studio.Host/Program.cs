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
    // The Type Selector's catalog, cached per project so per-keystroke QueryTypes never re-opens Roslyn. Built at
    // OpenProject (riding that MSBuild open) and rebuilt at Generate; keyed by the normalized project path.
    private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, IReadOnlyList<TypeRef>> Catalogs =
        new(StringComparer.OrdinalIgnoreCase);

    private static string CatalogKey(string path) => Path.GetFullPath(path);

    public string Ping() => "backend connected";

    /// <summary>Opens an existing project and returns its designable-type IR for the SPA to render; caches its type catalog.</summary>
    public async Task<ProjectModel> OpenProject(string path)
    {
        var (model, catalog) = await new ProjectWorkspace().OpenWithCatalogAsync(path).ConfigureAwait(false);
        Catalogs[CatalogKey(path)] = catalog;
        return model;
    }

    /// <summary>Replays the SPA's pending edit journal back into the project's source; returns the re-derived IR.</summary>
    public async Task<GenerateResult> Generate(string path, EditAction[] actions)
    {
        var (result, catalog) = await new ProjectGenerator().ApplyWithCatalogAsync(path, actions).ConfigureAwait(false);
        if (catalog is not null) Catalogs[CatalogKey(path)] = catalog;   // refresh only on a successful write
        return result;
    }

    /// <summary>Filters the cached type catalog for one Type Selector query (empty result if the project isn't open).</summary>
    public TypeQueryResult QueryTypes(string path, TypeQuery query) =>
        Catalogs.TryGetValue(CatalogKey(path), out var catalog)
            ? TypeCatalog.Query(catalog, query)
            : new TypeQueryResult(0, []);

    /// <summary>Reads the project's *.simassembly.yaml topology files for the topology editor.</summary>
    public Task<IReadOnlyList<AssemblyModel>> OpenAssemblies(string path) => new AssemblyReader().ReadAsync(path);

    /// <summary>Writes the edited topology models back to their *.simassembly.yaml files.</summary>
    public Task<TopologyWriteResult> WriteAssemblies(AssemblyModel[] assemblies) => new TopologyGenerator().WriteAsync(assemblies);

    // ── Snapshots (baseline IR + edit journal, persisted under the project's .studio/snapshots/) ──

    /// <summary>Lists the saved snapshots for a project (headers only), newest first.</summary>
    public Task<IReadOnlyList<SnapshotHeader>> ListSnapshots(string path) => new SnapshotStore().ListAsync(path);

    /// <summary>Persists a snapshot (opaque frontend JSON); re-saving the same id overwrites its file.</summary>
    public Task<SnapshotSaveResult> SaveSnapshot(string path, string snapshotJson) => new SnapshotStore().SaveAsync(path, snapshotJson);

    /// <summary>Returns the raw JSON of a snapshot by id, or null if it no longer exists.</summary>
    public Task<string?> LoadSnapshot(string path, string id) => new SnapshotStore().LoadAsync(path, id);

    /// <summary>Deletes a snapshot by id.</summary>
    public Task DeleteSnapshot(string path, string id) => new SnapshotStore().DeleteAsync(path, id);
}
