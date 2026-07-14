namespace SimulaSharp.Studio.Core;

/// <summary>
/// A designable member row on a type. <paramref name="Facets"/> are the roles the member carries — a single value
/// member can be several at once (e.g. a knob that is <em>also</em> a plottable), listed together on one row rather
/// than duplicated. Each facet is one of <c>Parameter</c> / <c>Knob</c> / <c>Plottable</c> / <c>ServiceRequest</c> /
/// <c>ServiceEvent</c> / <c>Property</c> / <c>Method</c>. <paramref name="Type"/> is the value / payload / return type
/// where meaningful (null otherwise). <paramref name="Params"/> is the parameter list of a method-shaped member (an
/// interface <c>Method</c> or a <c>ServiceRequest</c> handler), e.g. <c>"int slot, double watts"</c>; null otherwise.
/// </summary>
public sealed record MemberRow(string Name, string? Type, IReadOnlyList<string> Facets, string? Params = null);

/// <summary>
/// A directed association from one designable type to another. <paramref name="Kind"/> is
/// <c>Inheritance</c> (base class / implemented interface), <c>Containment</c> (<c>[Contains&lt;T&gt;]</c>),
/// <c>Reference</c> (<c>[Reference&lt;T&gt;]</c>, intra-site), <c>CrossReference</c> (<c>[CrossReference&lt;T&gt;]</c>,
/// cross-site) or <c>ServiceDep</c> (a <c>[ServiceRef]</c> member).
/// <paramref name="Name"/> is the association's declared name where it has one (the container / reference /
/// member name; empty for inheritance). <paramref name="Target"/> is the target type's key
/// (<c>Namespace.Name</c>), which the UI resolves to a node.
/// </summary>
public sealed record Association(string Kind, string Name, string Target);

/// <summary>
/// A designable type in an opened project's read-only IR: its namespace/name, its classification, its designable
/// member rows, and its outgoing <see cref="Association"/> edges (inheritance / containment / references / service-deps).
/// </summary>
public sealed record DesignableType(
    string Namespace,
    string Name,
    string Kind,
    IReadOnlyList<MemberRow> Members,
    IReadOnlyList<Association> Associations);

/// <summary>The read-only IR of an opened project: its name, path, and declared designable types.</summary>
public sealed record ProjectModel(string Name, string Path, IReadOnlyList<DesignableType> Types);
