using Microsoft.Build.Locator;
using Microsoft.CodeAnalysis.MSBuild;
using YamlDotNet.Serialization;

namespace SimulaSharp.Studio.Core;

/// <summary>
/// Reads a project's <c>*.simassembly.yaml</c> topology files — the ones registered as <c>&lt;SimAssembly&gt;</c>, which
/// surface to Roslyn as <see cref="Microsoft.CodeAnalysis.TextDocument">AdditionalDocuments</see> — and parses each
/// (YamlDotNet, the same shape the generator uses) into a flattened <see cref="AssemblyModel"/> for the topology editor.
/// The single-key-map lists the YAML uses for <c>Models</c>/<c>Refs</c>/<c>Deps</c> are flattened into named records.
/// </summary>
public sealed class AssemblyReader
{
    static AssemblyReader()
    {
        if (!MSBuildLocator.IsRegistered)
            MSBuildLocator.RegisterDefaults();
    }

    /// <summary>Opens <paramref name="projectPath"/> and parses every assembly YAML it registers.</summary>
    public async Task<IReadOnlyList<AssemblyModel>> ReadAsync(string projectPath, CancellationToken ct = default)
    {
        using var workspace = MSBuildWorkspace.Create();
        var project = await workspace.OpenProjectAsync(projectPath, cancellationToken: ct).ConfigureAwait(false);
        var deserializer = new DeserializerBuilder().IgnoreUnmatchedProperties().Build();

        var models = new List<AssemblyModel>();
        foreach (var doc in project.AdditionalDocuments)
        {
            if (doc.FilePath is not { } path) continue;
            if (!path.EndsWith(".yaml", StringComparison.OrdinalIgnoreCase) && !path.EndsWith(".yml", StringComparison.OrdinalIgnoreCase))
                continue;

            string yaml = (await doc.GetTextAsync(ct).ConfigureAwait(false)).ToString();
            SimAssembly? parsed;
            try { parsed = deserializer.Deserialize<SimAssembly>(yaml); }
            catch { continue; } // not a (valid) assembly file — skip

            if (parsed?.Simulator is { Name: { Length: > 0 } } sim)
                models.Add(ToAssembly(sim, path));
        }
        return models;
    }

    // ── Descriptor → IR ─────────────────────────────────────────────────────────

    private static AssemblyModel ToAssembly(SimulatorDesc s, string path) => new(
        s.Name!, s.MissionStart,
        (s.Services ?? []).Select(ToService).ToList(),
        (s.Sites ?? []).Select(ToSite).ToList(),
        path);

    private static ServiceInstance ToService(ServiceDesc s) =>
        new(s.Name, s.Type, s.Config ?? new(), ToDeps(s.Deps));

    private static SiteInstance ToSite(SiteDesc s) =>
        new(s.Name, s.MaxEvents, (s.Models ?? []).Select(ToInstance).ToList());

    private static ModelInstance ToInstance(ModelNode n) => new(
        n.Name, n.Type, n.Config ?? new(),
        (n.Models ?? []).SelectMany(d => d).Select(kv => new Container(kv.Key, (kv.Value ?? []).Select(ToInstance).ToList())).ToList(),
        (n.Refs ?? []).SelectMany(d => d).Select(kv => new ReferenceBinding(kv.Key, kv.Value ?? [])).ToList(),
        ToDeps(n.Deps));

    private static IReadOnlyList<DepBinding> ToDeps(List<Dictionary<string, string>>? deps) =>
        (deps ?? []).SelectMany(d => d).Select(kv => new DepBinding(kv.Key, kv.Value)).ToList();

    // ── YamlDotNet targets (mirror the generator's SimAssembly descriptor) ────────

    private sealed class SimAssembly { public SimulatorDesc? Simulator { get; set; } }

    private sealed class SimulatorDesc
    {
        public string? Name { get; set; }
        public string? MissionStart { get; set; }
        public List<ServiceDesc>? Services { get; set; }
        public List<SiteDesc>? Sites { get; set; }
    }

    private sealed class ServiceDesc
    {
        public string Name { get; set; } = "";
        public string Type { get; set; } = "";
        public Dictionary<string, string>? Config { get; set; }
        public List<Dictionary<string, string>>? Deps { get; set; }
    }

    private sealed class SiteDesc
    {
        public string Name { get; set; } = "";
        public int MaxEvents { get; set; } = 64;
        public List<ModelNode>? Models { get; set; }
    }

    private sealed class ModelNode
    {
        public string Name { get; set; } = "";
        public string Type { get; set; } = "";
        public Dictionary<string, string>? Config { get; set; }
        public List<Dictionary<string, List<ModelNode>>>? Models { get; set; }
        public List<Dictionary<string, List<string>>>? Refs { get; set; }
        public List<Dictionary<string, string>>? Deps { get; set; }
    }
}
