namespace SimulaSharp.Studio.Core;

/// <summary>
/// A designable member row on a type. <paramref name="Facets"/> are the roles the member carries — a single value
/// member can be several at once (e.g. a knob that is <em>also</em> a plottable), listed together on one row rather
/// than duplicated. Each facet is one of <c>Parameter</c> / <c>Knob</c> / <c>Plottable</c> / <c>ServiceRequest</c> /
/// <c>ServiceEvent</c>. <paramref name="Type"/> is the value / payload / return type where meaningful (null otherwise).
/// </summary>
public sealed record MemberRow(string Name, string? Type, IReadOnlyList<string> Facets);

/// <summary>
/// A designable type in an opened project's read-only IR: its namespace/name, its classification, and its designable
/// member rows. Association edges (containment / references / service-deps / inheritance) are added in a later step.
/// </summary>
public sealed record DesignableType(
    string Namespace,
    string Name,
    string Kind,
    IReadOnlyList<MemberRow> Members);

/// <summary>The read-only IR of an opened project: its name, path, and declared designable types.</summary>
public sealed record ProjectModel(string Name, string Path, IReadOnlyList<DesignableType> Types);
