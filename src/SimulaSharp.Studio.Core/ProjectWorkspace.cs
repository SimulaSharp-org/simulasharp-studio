using Microsoft.Build.Locator;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.MSBuild;

namespace SimulaSharp.Studio.Core;

/// <summary>
/// Opens an existing C# project via Roslyn's <see cref="MSBuildWorkspace"/> and derives the Phase-0 read-only IR —
/// the project's declared designable types, classified as Model / Service / LooselyCoupledService / Interface /
/// Other. MSBuild is registered from the installed .NET SDK once (in the static constructor, before any workspace
/// type is touched), which is what lets <see cref="MSBuildWorkspace"/> resolve the real MSBuild at runtime.
/// </summary>
public sealed class ProjectWorkspace
{
    static ProjectWorkspace()
    {
        if (!MSBuildLocator.IsRegistered)
            MSBuildLocator.RegisterDefaults();
    }

    private const string IModelName = "SimulaSharp.Kernel.Model.IModel";
    private const string IServiceName = "SimulaSharp.Kernel.Model.IService";
    private const string LcServiceBaseName = "SimulaSharp.Kernel.Model.LooselyCoupledServiceBase";

    /// <summary>Opens <paramref name="projectPath"/> and projects its declared types into a <see cref="ProjectModel"/>.</summary>
    public async Task<ProjectModel> OpenAsync(string projectPath, CancellationToken ct = default)
    {
        using var workspace = MSBuildWorkspace.Create();
        var project = await workspace.OpenProjectAsync(projectPath, cancellationToken: ct).ConfigureAwait(false);
        var compilation = await project.GetCompilationAsync(ct).ConfigureAwait(false)
                          ?? throw new InvalidOperationException($"Could not compile project '{projectPath}'.");

        var iModel = compilation.GetTypeByMetadataName(IModelName);
        var iService = compilation.GetTypeByMetadataName(IServiceName);
        var lcBase = compilation.GetTypeByMetadataName(LcServiceBaseName);

        var types = new List<DesignableType>();
        foreach (var t in DeclaredTypes(compilation.Assembly.GlobalNamespace))
        {
            if (t.DeclaredAccessibility is not (Accessibility.Public or Accessibility.Internal)) continue;
            string ns = t.ContainingNamespace.IsGlobalNamespace ? "" : t.ContainingNamespace.ToDisplayString();
            types.Add(new DesignableType(ns, t.Name, Classify(t, iModel, iService, lcBase)));
        }

        return new ProjectModel(project.Name, projectPath, types);
    }

    private static string Classify(INamedTypeSymbol t, INamedTypeSymbol? iModel, INamedTypeSymbol? iService, INamedTypeSymbol? lcBase)
    {
        if (t.TypeKind == TypeKind.Interface) return "Interface";
        if (t.TypeKind != TypeKind.Class) return "Other";

        bool Implements(INamedTypeSymbol? i) =>
            i is not null && t.AllInterfaces.Any(x => SymbolEqualityComparer.Default.Equals(x, i));

        if (Implements(iModel)) return "Model";
        if (lcBase is not null && Inherits(t, lcBase)) return "LooselyCoupledService";
        if (Implements(iService)) return "Service";
        return "Other";
    }

    private static bool Inherits(INamedTypeSymbol t, INamedTypeSymbol baseType)
    {
        for (var b = t.BaseType; b is not null; b = b.BaseType)
            if (SymbolEqualityComparer.Default.Equals(b, baseType)) return true;
        return false;
    }

    /// <summary>Every top-level type declared in <paramref name="ns"/> and its child namespaces.</summary>
    private static IEnumerable<INamedTypeSymbol> DeclaredTypes(INamespaceSymbol ns)
    {
        foreach (var t in ns.GetTypeMembers()) yield return t;
        foreach (var child in ns.GetNamespaceMembers())
            foreach (var t in DeclaredTypes(child))
                yield return t;
    }
}
