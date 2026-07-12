namespace SimulaSharp.Studio.Core;

/// <summary>
/// A designable type in an opened project's read-only IR (Phase-0 projection). Later phases expand this into the
/// full designable structure (members, attributes, associations); for now it is just enough to render the tree.
/// </summary>
/// <param name="Namespace">The declaring namespace, or "" for the global namespace.</param>
/// <param name="Name">The simple type name.</param>
/// <param name="Kind">One of Model / Service / LooselyCoupledService / Interface / Other.</param>
public sealed record DesignableType(string Namespace, string Name, string Kind);

/// <summary>The minimal read-only IR of an opened project: its name, path, and declared designable types.</summary>
public sealed record ProjectModel(string Name, string Path, IReadOnlyList<DesignableType> Types);
