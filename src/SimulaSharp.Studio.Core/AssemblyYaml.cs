namespace SimulaSharp.Studio.Core;

/// <summary>
/// The YamlDotNet-shaped descriptor for a <c>*.simassembly.yaml</c> (mirrors the generator's own shape) plus the
/// conversions to and from the flattened <see cref="AssemblyModel"/> IR. Kept in one place so reading and writing
/// stay symmetric — the single-key-map lists the YAML uses for <c>Models</c>/<c>Refs</c>/<c>Deps</c> are flattened on
/// the way in and rebuilt on the way out.
/// </summary>
internal static class AssemblyYaml
{
    // ── Descriptor → IR (read) ──────────────────────────────────────────────────

    public static AssemblyModel ToModel(SimulatorDesc s, string path) => new(
        s.Name ?? "", s.MissionStart,
        (s.Services ?? []).Select(ToService).ToList(),
        (s.Sites ?? []).Select(ToSite).ToList(),
        path);

    private static ServiceInstance ToService(ServiceDesc s) => new(s.Name, s.Type, s.Config ?? new(), ToDeps(s.Deps));

    private static SiteInstance ToSite(SiteDesc s) => new(s.Name, s.MaxEvents, (s.Models ?? []).Select(ToInstance).ToList());

    private static ModelInstance ToInstance(ModelNode n) => new(
        n.Name, n.Type, n.Config ?? new(),
        (n.Models ?? []).SelectMany(d => d).Select(kv => new Container(kv.Key, (kv.Value ?? []).Select(ToInstance).ToList())).ToList(),
        (n.Refs ?? []).SelectMany(d => d).Select(kv => new ReferenceBinding(kv.Key, kv.Value ?? [], false))
            .Concat((n.CRefs ?? []).SelectMany(d => d).Select(kv => new ReferenceBinding(kv.Key, kv.Value ?? [], true)))
            .ToList(),
        ToDeps(n.Deps));

    private static IReadOnlyList<DepBinding> ToDeps(List<Dictionary<string, string>>? deps) =>
        (deps ?? []).SelectMany(d => d).Select(kv => new DepBinding(kv.Key, kv.Value)).ToList();

    // ── IR → descriptor (write) ─────────────────────────────────────────────────

    public static SimAssembly ToDescriptor(AssemblyModel a) => new()
    {
        Simulator = new SimulatorDesc
        {
            Name = a.Name,
            MissionStart = a.MissionStart,
            Services = a.Services.Count == 0 ? null : a.Services.Select(FromService).ToList(),
            Sites = a.Sites.Count == 0 ? null : a.Sites.Select(FromSite).ToList(),
        },
    };

    private static ServiceDesc FromService(ServiceInstance s) => new()
    {
        Name = s.Name,
        Type = s.Type,
        Config = Nullify(s.Config),
        Deps = FromDeps(s.Deps),
    };

    private static SiteDesc FromSite(SiteInstance s) => new()
    {
        Name = s.Name,
        MaxEvents = s.MaxEvents,
        Models = s.Models.Count == 0 ? null : s.Models.Select(FromInstance).ToList(),
    };

    private static ModelNode FromInstance(ModelInstance m) => new()
    {
        Name = m.Name,
        Type = m.Type,
        Config = Nullify(m.Config),
        Models = m.Containers.Count == 0 ? null : m.Containers.Select(c => new Dictionary<string, List<ModelNode>> { [c.Name] = c.Children.Select(FromInstance).ToList() }).ToList(),
        Refs = RefBlock(m.Refs.Where(r => !r.IsCross)),
        CRefs = RefBlock(m.Refs.Where(r => r.IsCross)),
        Deps = FromDeps(m.Deps),
    };

    /// <summary>Renders a subset of a model's reference bindings as a YAML descriptor block (one single-entry map per
    /// binding), or <c>null</c> when the subset is empty so the block is omitted. Used to split <see cref="ModelInstance.Refs"/>
    /// into the intra-site <c>Refs:</c> and cross-site <c>CRefs:</c> blocks by <see cref="ReferenceBinding.IsCross"/>.</summary>
    private static List<Dictionary<string, List<string>>>? RefBlock(IEnumerable<ReferenceBinding> refs)
    {
        var block = refs.Select(r => new Dictionary<string, List<string>> { [r.Name] = r.Targets.ToList() }).ToList();
        return block.Count == 0 ? null : block;
    }

    private static List<Dictionary<string, string>>? FromDeps(IReadOnlyList<DepBinding> deps) =>
        deps.Count == 0 ? null : deps.Select(d => new Dictionary<string, string> { [d.Member] = d.Service }).ToList();

    private static Dictionary<string, string>? Nullify(IReadOnlyDictionary<string, string> config) =>
        config.Count == 0 ? null : new Dictionary<string, string>(config);

    // ── Descriptor classes (YamlDotNet target) ──────────────────────────────────

    public sealed class SimAssembly { public SimulatorDesc? Simulator { get; set; } }

    public sealed class SimulatorDesc
    {
        public string? Name { get; set; }
        public string? MissionStart { get; set; }
        public List<ServiceDesc>? Services { get; set; }
        public List<SiteDesc>? Sites { get; set; }
    }

    public sealed class ServiceDesc
    {
        public string Name { get; set; } = "";
        public string Type { get; set; } = "";
        public Dictionary<string, string>? Config { get; set; }
        public List<Dictionary<string, string>>? Deps { get; set; }
    }

    public sealed class SiteDesc
    {
        public string Name { get; set; } = "";
        public int MaxEvents { get; set; } = 64;
        public List<ModelNode>? Models { get; set; }
    }

    public sealed class ModelNode
    {
        public string Name { get; set; } = "";
        public string Type { get; set; } = "";
        public Dictionary<string, string>? Config { get; set; }
        public List<Dictionary<string, List<ModelNode>>>? Models { get; set; }
        /// <summary>Intra-site <c>[Reference&lt;T&gt;]</c> bindings.</summary>
        public List<Dictionary<string, List<string>>>? Refs { get; set; }
        /// <summary>Cross-site <c>[CrossReference&lt;T&gt;]</c> bindings.</summary>
        public List<Dictionary<string, List<string>>>? CRefs { get; set; }
        public List<Dictionary<string, string>>? Deps { get; set; }
    }
}
