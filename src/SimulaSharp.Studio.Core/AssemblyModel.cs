namespace SimulaSharp.Studio.Core;

/// <summary>Binds a <c>[ServiceRef]</c> member to a service instance by name (a model's or service's <c>Deps</c> entry).</summary>
public sealed record DepBinding(string Member, string Service);

/// <summary>Populates a reference with target instance paths. <paramref name="IsCross"/> tells the two kinds apart:
/// <c>false</c> is an intra-site <c>[Reference&lt;T&gt;]</c> (the YAML <c>Refs:</c> block), <c>true</c> a cross-site
/// <c>[CrossReference&lt;T&gt;]</c> (the YAML <c>CRefs:</c> block).</summary>
public sealed record ReferenceBinding(string Name, IReadOnlyList<string> Targets, bool IsCross = false);

/// <summary>A <c>[Contains&lt;T&gt;]</c> container and the child model instances placed in it.</summary>
public sealed record Container(string Name, IReadOnlyList<ModelInstance> Children);

/// <summary>
/// One model instance in the topology tree: its instance <paramref name="Name"/>, its <paramref name="Type"/>, its
/// <c>[Parameter]</c> <paramref name="Config"/>, and its contained children / references / service-deps.
/// </summary>
public sealed record ModelInstance(
    string Name,
    string Type,
    IReadOnlyDictionary<string, string> Config,
    IReadOnlyList<Container> Containers,
    IReadOnlyList<ReferenceBinding> Refs,
    IReadOnlyList<DepBinding> Deps);

/// <summary>A shared service instance in an assembly.</summary>
public sealed record ServiceInstance(
    string Name,
    string Type,
    IReadOnlyDictionary<string, string> Config,
    IReadOnlyList<DepBinding> Deps);

/// <summary>A SimSite and the root model instances it owns.</summary>
public sealed record SiteInstance(string Name, int MaxEvents, IReadOnlyList<ModelInstance> Models);

/// <summary>
/// The parsed topology of one <c>*.simassembly.yaml</c>: the simulator name/mission-start, its services and sites.
/// <paramref name="Path"/> is the assembly file so the editor can write it back.
/// </summary>
public sealed record AssemblyModel(
    string Name,
    string? MissionStart,
    IReadOnlyList<ServiceInstance> Services,
    IReadOnlyList<SiteInstance> Sites,
    string Path);
