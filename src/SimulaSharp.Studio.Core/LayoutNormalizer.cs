using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;
using static Microsoft.CodeAnalysis.CSharp.SyntaxFactory;

namespace SimulaSharp.Studio.Core;

/// <summary>
/// The layout-normalization pass that runs at the end of a Generate: it makes the project's physical layout mirror its
/// namespaces — one type per file, each file named <c>&lt;TypeName&gt;.cs</c> in the directory that mirrors its
/// namespace (the project's root namespace maps to the project directory, deeper segments to subdirectories). It
/// <b>splits</b> multi-type files and <b>relocates</b> misplaced ones, so opening a messily-organised project and
/// pressing Generate tidies it. The pass is idempotent: a type already alone in its correctly-named/placed file is left
/// completely untouched, so a conforming project sees zero layout churn.
/// </summary>
public static class LayoutNormalizer
{
    private sealed record Placement(string Ns, DocumentId DocId, string CurrentPath, string TargetPath, SyntaxReference SyntaxRef);

    /// <summary>Rewrites the project's file layout to the one-type-per-file, directory-mirrors-namespace convention.</summary>
    public static async Task<Solution> NormalizeAsync(Solution solution, ProjectId projectId, CancellationToken ct = default)
    {
        var project = solution.GetProject(projectId)!;
        var compilation = await project.GetCompilationAsync(ct).ConfigureAwait(false)
                          ?? throw new InvalidOperationException("Could not recompile the project.");
        string projectDir = Path.GetDirectoryName(project.FilePath)
                            ?? throw new InvalidOperationException("The project has no directory.");
        string root = project.DefaultNamespace ?? "";

        var placements = new List<Placement>();
        foreach (var t in UserTypes(compilation))
        {
            var syntaxRef = t.DeclaringSyntaxReferences.FirstOrDefault(r =>
                !r.SyntaxTree.FilePath.EndsWith(".g.cs", StringComparison.OrdinalIgnoreCase));
            if (syntaxRef is null) continue;
            var doc = solution.GetDocument(syntaxRef.SyntaxTree);
            if (doc?.FilePath is not { } current) continue;
            string ns = t.ContainingNamespace.IsGlobalNamespace ? "" : t.ContainingNamespace.ToDisplayString();
            placements.Add(new Placement(ns, doc.Id, current, TargetPath(projectDir, root, ns, t.Name), syntaxRef));
        }

        // How many user types share each source document (to spot files that must be split).
        var perDoc = placements.GroupBy(p => p.DocId).ToDictionary(g => g.Key, g => g.Count());

        // A type conforms when it is the sole type in its file and already at its target path — leave those alone.
        var nonConforming = placements
            .Where(p => perDoc[p.DocId] != 1 || !PathEq(p.CurrentPath, p.TargetPath))
            .ToList();
        if (nonConforming.Count == 0) return solution;

        // Pull the relocated types out of their (removed) source files and re-emit each as its own file.
        foreach (var docId in nonConforming.Select(p => p.DocId).Distinct())
            solution = solution.RemoveDocument(docId);

        foreach (var p in nonConforming)
        {
            var srcRoot = (CompilationUnitSyntax)(await p.SyntaxRef.SyntaxTree.GetRootAsync(ct).ConfigureAwait(false));
            var typeDecl = (MemberDeclarationSyntax)await p.SyntaxRef.GetSyntaxAsync(ct).ConfigureAwait(false);
            var unit = BuildFile(srcRoot.Usings, p.Ns, typeDecl);

            var id = DocumentId.CreateNewId(projectId);
            solution = solution.AddDocument(id, Path.GetFileName(p.TargetPath),
                SourceText.From(unit.ToFullString(), Encoding.UTF8), filePath: p.TargetPath);
        }

        return solution;
    }

    /// <summary>The file path a type belongs at: project dir + its namespace (minus the root) as directories + name.cs.</summary>
    public static string TargetPath(string projectDir, string rootNamespace, string ns, string name)
    {
        string relative = ns == rootNamespace ? ""
            : rootNamespace.Length > 0 && ns.StartsWith(rootNamespace + ".", StringComparison.Ordinal) ? ns[(rootNamespace.Length + 1)..]
            : ns; // a namespace that doesn't extend the root falls back to its full path
        string[] segments = relative.Length == 0 ? [] : relative.Split('.');
        return Path.Combine([projectDir, .. segments, name + ".cs"]);
    }

    private static CompilationUnitSyntax BuildFile(SyntaxList<UsingDirectiveSyntax> usings, string ns, MemberDeclarationSyntax typeDecl)
    {
        MemberDeclarationSyntax body = ns.Length == 0
            ? typeDecl
            : FileScopedNamespaceDeclaration(ParseName(ns)).WithMembers(SingletonList(typeDecl));
        // NormalizeWhitespace lays out proper token spacing/indentation (the nodes are assembled trivia-free) while
        // keeping comments — including the type's doc comment, which rides along as its leading trivia.
        return CompilationUnit()
            .WithUsings(usings)
            .WithMembers(SingletonList(body))
            .NormalizeWhitespace();
    }

    private static IEnumerable<INamedTypeSymbol> UserTypes(Compilation compilation)
    {
        foreach (var t in TopLevelTypes(compilation.Assembly.GlobalNamespace))
            if (t.DeclaringSyntaxReferences.Any(r => !r.SyntaxTree.FilePath.EndsWith(".g.cs", StringComparison.OrdinalIgnoreCase)))
                yield return t;
    }

    private static IEnumerable<INamedTypeSymbol> TopLevelTypes(INamespaceSymbol ns)
    {
        foreach (var t in ns.GetTypeMembers()) yield return t; // top-level only; nested types travel with their container
        foreach (var child in ns.GetNamespaceMembers())
            foreach (var t in TopLevelTypes(child))
                yield return t;
    }

    private static bool PathEq(string a, string b) =>
        string.Equals(Path.GetFullPath(a), Path.GetFullPath(b), StringComparison.OrdinalIgnoreCase);
}
