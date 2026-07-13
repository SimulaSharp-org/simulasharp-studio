using Microsoft.Build.Locator;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.MSBuild;

namespace SimulaSharp.Studio.Core;

/// <summary>
/// Opens an existing C# project via Roslyn's <see cref="MSBuildWorkspace"/> and derives the read-only IR — the
/// project's declared designable types (classified Model / Service / LooselyCoupledService / Interface / Other) and,
/// per type, its designable member rows (Parameter / Knob / Plottable / ServiceRequest / ServiceEvent). MSBuild is
/// registered from the installed .NET SDK once (static constructor), which lets <see cref="MSBuildWorkspace"/> resolve
/// the real MSBuild at run time.
/// </summary>
public sealed class ProjectWorkspace
{
    static ProjectWorkspace()
    {
        if (!MSBuildLocator.IsRegistered)
            MSBuildLocator.RegisterDefaults();
    }

    private const string Ns = "SimulaSharp.Kernel.";
    private static readonly SymbolDisplayFormat TypeFormat = SymbolDisplayFormat.MinimallyQualifiedFormat;

    /// <summary>Opens <paramref name="projectPath"/> and projects its declared types into a <see cref="ProjectModel"/>.</summary>
    public async Task<ProjectModel> OpenAsync(string projectPath, CancellationToken ct = default)
    {
        using var workspace = MSBuildWorkspace.Create();
        var project = await workspace.OpenProjectAsync(projectPath, cancellationToken: ct).ConfigureAwait(false);
        var compilation = await project.GetCompilationAsync(ct).ConfigureAwait(false)
                          ?? throw new InvalidOperationException($"Could not compile project '{projectPath}'.");

        return BuildModel(project.Name, projectPath, compilation);
    }

    /// <summary>Projects the designable-type IR from an (already-built) compilation — the shared read path
    /// used both to open a project and to re-derive the IR after a <see cref="ProjectGenerator"/> write-back.</summary>
    public static ProjectModel BuildModel(string name, string path, Compilation compilation)
    {
        var k = new Symbols(compilation);

        var types = new List<DesignableType>();
        foreach (var t in DeclaredTypes(compilation.Assembly.GlobalNamespace))
        {
            if (t.DeclaredAccessibility is not (Accessibility.Public or Accessibility.Internal)) continue;
            if (!IsUserDeclared(t)) continue;   // skip source-generator output (<Type>Ref, companion interfaces, …)
            string ns = t.ContainingNamespace.IsGlobalNamespace ? "" : t.ContainingNamespace.ToDisplayString();
            types.Add(new DesignableType(ns, t.Name, Classify(t, k), ProjectMembers(t, k), ProjectAssociations(t, k)));
        }

        return new ProjectModel(name, path, types);
    }

    // ── Classification ──────────────────────────────────────────────────────────

    private static string Classify(INamedTypeSymbol t, Symbols k)
    {
        if (t.TypeKind == TypeKind.Interface) return "Interface";
        if (t.TypeKind != TypeKind.Class) return "Other";
        if (Implements(t, k.IModel)) return "Model";
        if (k.LcServiceBase is not null && Inherits(t, k.LcServiceBase)) return "LooselyCoupledService";
        if (Implements(t, k.IService)) return "Service";
        return "Other";
    }

    // ── Member projection ───────────────────────────────────────────────────────

    private static IReadOnlyList<MemberRow> ProjectMembers(INamedTypeSymbol t, Symbols k)
    {
        var rows = new List<MemberRow>();

        // An interface's designable surface is its own members (properties/methods) — the contract itself.
        if (t.TypeKind == TypeKind.Interface)
        {
            foreach (var m in t.GetMembers())
            {
                switch (m)
                {
                    case IPropertySymbol { IsIndexer: false } p:
                        rows.Add(new MemberRow(p.Name, p.Type.ToDisplayString(TypeFormat), ["Property"]));
                        break;
                    case IMethodSymbol { MethodKind: MethodKind.Ordinary } method:
                        rows.Add(new MemberRow(method.Name,
                            method.ReturnsVoid ? null : method.ReturnType.ToDisplayString(TypeFormat), ["Method"], ParamList(method)));
                        break;
                }
            }
            return rows;
        }

        // Class-level: [ServiceEvent("Name", typeof(Payload))].
        foreach (var attr in t.GetAttributes())
        {
            if (!Eq(attr.AttributeClass, k.ServiceEvent) || attr.ConstructorArguments.Length < 1) continue;
            string name = attr.ConstructorArguments[0].Value as string ?? "";
            string? payload = attr.ConstructorArguments.Length >= 2 && attr.ConstructorArguments[1].Value is INamedTypeSymbol p
                ? p.ToDisplayString(TypeFormat)
                : null;
            rows.Add(new MemberRow(name, payload, ["ServiceEvent"]));
        }

        foreach (var m in t.GetMembers())
        {
            switch (m)
            {
                case IPropertySymbol { IsIndexer: false } p:
                    AddValueMember(rows, p, p.Type, k);
                    break;
                case IFieldSymbol { IsImplicitlyDeclared: false, IsConst: false } f:
                    AddValueMember(rows, f, f.Type, k);
                    break;
                case IMethodSymbol { MethodKind: MethodKind.Ordinary } method:
                    if (HasAttr(method, k.TriggerKnob))
                        rows.Add(new MemberRow(method.Name, "trigger", ["Knob"]));
                    if (HasAttr(method, k.ServiceRequest) && method.Name.StartsWith("Handle_", StringComparison.Ordinal))
                        rows.Add(new MemberRow(method.Name["Handle_".Length..],
                            method.ReturnsVoid ? null : method.ReturnType.ToDisplayString(TypeFormat), ["ServiceRequest"], ParamList(method)));
                    break;
            }
        }

        return rows;
    }

    /// <summary>The parameter list of a method as source-like text (e.g. <c>"int slot, double watts"</c>), or null if none.</summary>
    private static string? ParamList(IMethodSymbol method) =>
        method.Parameters.Length == 0
            ? null
            : string.Join(", ", method.Parameters.Select(p => $"{p.Type.ToDisplayString(TypeFormat)} {p.Name}"));

    /// <summary>Emits one row for a value member, combining its Parameter / Knob / Plottable roles into facets.</summary>
    private static void AddValueMember(List<MemberRow> rows, ISymbol member, ITypeSymbol type, Symbols k)
    {
        var facets = new List<string>();
        if (HasAttr(member, k.Parameter)) facets.Add("Parameter");
        if (member.GetAttributes().Any(a => DerivesFrom(a.AttributeClass, k.KnobBase))) facets.Add("Knob");
        if (HasAttr(member, k.Plottable)) facets.Add("Plottable");
        if (facets.Count > 0) rows.Add(new MemberRow(member.Name, type.ToDisplayString(TypeFormat), facets));
    }

    // ── Association projection ──────────────────────────────────────────────────

    /// <summary>
    /// Projects a type's outgoing association edges: its base class + implemented interfaces (inheritance),
    /// its <c>[Contains&lt;T&gt;]</c> / <c>[References&lt;T&gt;]</c> class decorators, and its <c>[ServiceRef]</c>
    /// members (service-deps). Targets are emitted as type keys; the UI keeps only those that resolve to a node.
    /// </summary>
    private static IReadOnlyList<Association> ProjectAssociations(INamedTypeSymbol t, Symbols k)
    {
        var edges = new List<Association>();

        // Inheritance: the direct base class (if any beyond object) and directly implemented interfaces.
        if (t.BaseType is { SpecialType: not SpecialType.System_Object } baseType)
            edges.Add(new Association("Inheritance", "", TypeKey(baseType)));
        foreach (var i in t.Interfaces)
            edges.Add(new Association("Inheritance", "", TypeKey(i)));

        // Containment / references: generic class decorators [Contains<T>("Name")] / [References<T>("Name")].
        foreach (var attr in t.GetAttributes())
        {
            var def = attr.AttributeClass?.OriginalDefinition;
            string? kind =
                Eq(def, k.Contains) ? "Containment" :
                Eq(def, k.References) ? "Reference" : null;
            if (kind is null || attr.AttributeClass!.TypeArguments.Length < 1) continue;
            string name = attr.ConstructorArguments.Length >= 1 ? attr.ConstructorArguments[0].Value as string ?? "" : "";
            edges.Add(new Association(kind, name, TypeKey(attr.AttributeClass.TypeArguments[0])));
        }

        // Service-deps: [ServiceRef] fields / properties point at another service (or a service interface).
        foreach (var m in t.GetMembers())
        {
            ITypeSymbol? target = m switch
            {
                IFieldSymbol f when HasAttr(f, k.ServiceRef) => f.Type,
                IPropertySymbol p when HasAttr(p, k.ServiceRef) => p.Type,
                _ => null,
            };
            if (target is not null)
                edges.Add(new Association("ServiceDep", m.Name, TypeKey(target)));
        }

        return edges;
    }

    /// <summary>The node key (<c>Namespace.Name</c>) for a type symbol, matching the UI's type identity.</summary>
    private static string TypeKey(ITypeSymbol t) =>
        t.ContainingNamespace is { IsGlobalNamespace: false } ns ? ns.ToDisplayString() + "." + t.Name : t.Name;

    // ── Symbol helpers ──────────────────────────────────────────────────────────

    private static bool IsUserDeclared(INamedTypeSymbol t) =>
        t.DeclaringSyntaxReferences.Any(r =>
            !r.SyntaxTree.FilePath.EndsWith(".g.cs", StringComparison.OrdinalIgnoreCase));

    private static bool Implements(INamedTypeSymbol t, INamedTypeSymbol? i) =>
        i is not null && t.AllInterfaces.Any(x => Eq(x, i));

    private static bool Inherits(INamedTypeSymbol t, INamedTypeSymbol baseType)
    {
        for (var b = t.BaseType; b is not null; b = b.BaseType)
            if (Eq(b, baseType)) return true;
        return false;
    }

    private static bool HasAttr(ISymbol m, INamedTypeSymbol? attr) =>
        attr is not null && m.GetAttributes().Any(a => Eq(a.AttributeClass, attr));

    private static bool DerivesFrom(INamedTypeSymbol? attrClass, INamedTypeSymbol? baseAttr)
    {
        if (baseAttr is null) return false;
        for (var c = attrClass; c is not null; c = c.BaseType)
            if (Eq(c.OriginalDefinition, baseAttr)) return true;
        return false;
    }

    private static bool Eq(ISymbol? a, ISymbol? b) => SymbolEqualityComparer.Default.Equals(a, b);

    private static IEnumerable<INamedTypeSymbol> DeclaredTypes(INamespaceSymbol ns)
    {
        foreach (var t in ns.GetTypeMembers()) yield return t;
        foreach (var child in ns.GetNamespaceMembers())
            foreach (var t in DeclaredTypes(child))
                yield return t;
    }

    /// <summary>The framework attribute/base symbols resolved once from the compilation.</summary>
    private sealed class Symbols(Compilation c)
    {
        public readonly INamedTypeSymbol? IModel = c.GetTypeByMetadataName(Ns + "Model.IModel");
        public readonly INamedTypeSymbol? IService = c.GetTypeByMetadataName(Ns + "Model.IService");
        public readonly INamedTypeSymbol? LcServiceBase = c.GetTypeByMetadataName(Ns + "Model.LooselyCoupledServiceBase");
        public readonly INamedTypeSymbol? Parameter = c.GetTypeByMetadataName(Ns + "Attributes.ParameterAttribute");
        public readonly INamedTypeSymbol? Plottable = c.GetTypeByMetadataName(Ns + "Attributes.PlottableAttribute");
        public readonly INamedTypeSymbol? KnobBase = c.GetTypeByMetadataName(Ns + "Attributes.KnobAttribute");
        public readonly INamedTypeSymbol? TriggerKnob = c.GetTypeByMetadataName(Ns + "Attributes.TriggerKnobAttribute");
        public readonly INamedTypeSymbol? ServiceRequest = c.GetTypeByMetadataName(Ns + "Attributes.ServiceRequestAttribute");
        public readonly INamedTypeSymbol? ServiceEvent = c.GetTypeByMetadataName(Ns + "Attributes.ServiceEventAttribute");
        public readonly INamedTypeSymbol? ServiceRef = c.GetTypeByMetadataName(Ns + "Attributes.ServiceRefAttribute");
        public readonly INamedTypeSymbol? Contains = c.GetTypeByMetadataName(Ns + "Attributes.ContainsAttribute`1");
        public readonly INamedTypeSymbol? References = c.GetTypeByMetadataName(Ns + "Attributes.ReferencesAttribute`1");
    }
}
