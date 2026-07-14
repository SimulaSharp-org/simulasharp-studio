using Microsoft.CodeAnalysis;

namespace SimulaSharp.Studio.Core;

/// <summary>One selectable type in the <see cref="TypeCatalog"/>. <paramref name="Fqn"/> is the canonical identity
/// (fully-qualified, no <c>global::</c>) stored on member/param types and emitted by write-back; <paramref name="Name"/>
/// is the display label (a C# alias for primitives, else the simple name). The flags drive the per-slot filters:
/// <paramref name="Volatile"/> = atomically-readable value (numeric / <c>bool</c> / <c>char</c> / enum, for
/// knobs/plottables/gauges); <paramref name="Marshalable"/> = a copyable value payload (any value type + <c>string</c>,
/// for parameters and request/response); <paramref name="Bcl"/> flags a <c>System.*</c>/<c>Microsoft.*</c> framework
/// type (hidden unless the picker's BCL toggle is on); <paramref name="Abstract"/> flags an abstract class (hidden
/// unless the slot allows abstract targets).</summary>
public sealed record TypeRef(
    string Name,
    string Fqn,
    string Namespace,
    string Category,
    bool Volatile,
    bool Marshalable,
    bool Bcl,
    bool Abstract);

/// <summary>The categories a picker slot accepts, OR-ed together. <see cref="All"/> is every bit set. A type matches a
/// filter when any set bit matches it: <see cref="Volatile"/>/<see cref="Marshalable"/> test the value flags,
/// <see cref="Models"/>/<see cref="Interfaces"/>/<see cref="Services"/> test the category.</summary>
[System.Flags]
public enum TypeFilter
{
    None = 0,
    Volatile = 1,
    Marshalable = 2,
    Models = 4,
    Interfaces = 8,
    Services = 16,
    All = Volatile | Marshalable | Models | Interfaces | Services,
}

/// <summary>A type-picker query: the accepted <see cref="Filter"/>, whether BCL and abstract classes are allowed, and
/// the (possibly empty) name search.</summary>
public sealed record TypeQuery(TypeFilter Filter, bool IncludeBcl, bool IncludeAbstractClasses, string Query);

/// <summary><paramref name="Total"/> matches; <paramref name="Items"/> is empty when <paramref name="Total"/> exceeds
/// the display cap (the picker then asks the user to narrow the search).</summary>
public sealed record TypeQueryResult(int Total, IReadOnlyList<TypeRef> Items);

/// <summary>
/// Builds and queries the flat, searchable type catalog behind Studio's Type Selector. <see cref="Build"/> walks a
/// compilation once (curated primitives + the source assembly's user types + every referenced assembly's selectable
/// types) into a <see cref="TypeRef"/> list the hub caches; <see cref="Query"/> filters that list in-memory so
/// per-keystroke picker searches never touch Roslyn.
/// </summary>
public static class TypeCatalog
{
    /// <summary>Above this match count the picker returns no items and asks the user to narrow the search.</summary>
    public const int DisplayCap = 64;

    /// <summary>The canonical fully-qualified format, <b>without</b> the <c>global::</c> prefix — the identity stored on
    /// member/param types and emitted by write-back (the pipeline's Simplifier shortens it back down).</summary>
    internal static readonly SymbolDisplayFormat Fqn = SymbolDisplayFormat.FullyQualifiedFormat
        .WithGlobalNamespaceStyle(SymbolDisplayGlobalNamespaceStyle.Omitted);

    // ── Build ────────────────────────────────────────────────────────────────────

    /// <summary>Projects the full selectable-type catalog from a compilation.</summary>
    public static IReadOnlyList<TypeRef> Build(Compilation compilation)
    {
        var k = new ProjectWorkspace.Symbols(compilation);
        var byFqn = new Dictionary<string, TypeRef>();
        void Add(TypeRef t) => byFqn[t.Fqn] = t;   // last write wins; primitives seeded first, dedupes the walk

        foreach (var p in Primitives) Add(p);

        // The source assembly: user-declared (skip generated .g.cs), public or internal.
        foreach (var t in ProjectWorkspace.DeclaredTypes(compilation.Assembly.GlobalNamespace))
            if (t.DeclaredAccessibility is Accessibility.Public or Accessibility.Internal && ProjectWorkspace.IsUserDeclared(t))
                if (ToRef(t, k, fromSource: true) is { } r) Add(r);

        // Referenced assemblies (kernel, referenced projects, BCL): public selectable types only.
        foreach (var asm in compilation.SourceModule.ReferencedAssemblySymbols)
            foreach (var t in ProjectWorkspace.DeclaredTypes(asm.GlobalNamespace))
                if (t.DeclaredAccessibility == Accessibility.Public)
                    if (ToRef(t, k, fromSource: false) is { } r) Add(r);

        return byFqn.Values.ToList();
    }

    /// <summary>Maps a symbol to a <see cref="TypeRef"/>, or null if it is not a selectable category (a plain class,
    /// a delegate, a type parameter, …). Interfaces/enums/models/services are always kept; structs are kept from any
    /// non-generated source (BCL structs surface too, behind the BCL toggle).</summary>
    private static TypeRef? ToRef(INamedTypeSymbol t, ProjectWorkspace.Symbols k, bool fromSource)
    {
        if (t.IsImplicitlyDeclared || t.IsGenericType || t.Name.Length == 0) return null;

        string category = t.TypeKind switch
        {
            TypeKind.Interface => "Interface",
            TypeKind.Enum => "Enum",
            TypeKind.Struct => "Struct",
            TypeKind.Class => ProjectWorkspace.Classify(t, k) switch
            {
                "Model" => "Model",
                "Service" or "LooselyCoupledService" => "Service",
                _ => "Other",
            },
            _ => "Other",
        };
        if (category == "Other") return null;   // plain classes / non-selectable kinds

        bool isEnum = category == "Enum";
        bool isValue = t.IsValueType;   // struct, enum, or (from the primitives table) a primitive
        string ns = t.ContainingNamespace.IsGlobalNamespace ? "" : t.ContainingNamespace.ToDisplayString();

        return new TypeRef(
            Name: t.Name,
            Fqn: t.ToDisplayString(Fqn),
            Namespace: ns,
            Category: category,
            Volatile: isEnum,                                    // enums are word-size atomic; structs can tear
            Marshalable: isValue,                                // any value type is a copyable payload
            Bcl: IsBcl(ns),
            Abstract: t.IsAbstract && t.TypeKind == TypeKind.Class);
    }

    private static bool IsBcl(string ns) =>
        ns == "System" || ns.StartsWith("System.", StringComparison.Ordinal) ||
        ns == "Microsoft" || ns.StartsWith("Microsoft.", StringComparison.Ordinal);

    // ── Query ────────────────────────────────────────────────────────────────────

    /// <summary>Filters a built catalog for one picker request. Applies the category filter, the BCL and abstract
    /// toggles, and the name search; caps the returned items at <see cref="DisplayCap"/> (returning the true
    /// <see cref="TypeQueryResult.Total"/> so the picker can prompt the user to narrow a too-broad query).</summary>
    public static TypeQueryResult Query(IReadOnlyList<TypeRef> catalog, TypeQuery q)
    {
        var matched = catalog.Where(t =>
            Matches(t, q.Filter)
            && (q.IncludeBcl || !t.Bcl)
            && (q.IncludeAbstractClasses || !t.Abstract)
            && (string.IsNullOrWhiteSpace(q.Query) || t.Name.Contains(q.Query, StringComparison.OrdinalIgnoreCase)))
            .ToList();

        if (matched.Count > DisplayCap) return new TypeQueryResult(matched.Count, []);

        var items = matched
            .OrderBy(t => t.Namespace, StringComparer.Ordinal)
            .ThenBy(t => t.Name, StringComparer.Ordinal)
            .ToList();
        return new TypeQueryResult(items.Count, items);
    }

    private static bool Matches(TypeRef t, TypeFilter f) =>
        (f.HasFlag(TypeFilter.Volatile) && t.Volatile)
        || (f.HasFlag(TypeFilter.Marshalable) && t.Marshalable)
        || (f.HasFlag(TypeFilter.Models) && t.Category == "Model")
        || (f.HasFlag(TypeFilter.Interfaces) && t.Category == "Interface")
        || (f.HasFlag(TypeFilter.Services) && t.Category == "Service");

    // ── Curated primitives (aliased display, always visible — bcl:false) ───────────

    private static TypeRef Prim(string alias, string fqn, bool vol) =>
        new(alias, fqn, Namespace: "", Category: "Primitive", Volatile: vol, Marshalable: true, Bcl: false, Abstract: false);

    private static readonly TypeRef[] Primitives =
    [
        Prim("int", "System.Int32", true),
        Prim("uint", "System.UInt32", true),
        Prim("long", "System.Int64", true),
        Prim("ulong", "System.UInt64", true),
        Prim("short", "System.Int16", true),
        Prim("ushort", "System.UInt16", true),
        Prim("byte", "System.Byte", true),
        Prim("sbyte", "System.SByte", true),
        Prim("double", "System.Double", true),
        Prim("float", "System.Single", true),
        Prim("decimal", "System.Decimal", false),   // 128-bit — not a word-size atomic read
        Prim("bool", "System.Boolean", true),
        Prim("char", "System.Char", true),
        Prim("string", "System.String", false),     // a reference; a copyable payload but not a scalar gauge
    ];
}
