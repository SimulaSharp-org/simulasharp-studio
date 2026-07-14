using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.FindSymbols;
using Microsoft.CodeAnalysis.Formatting;
using Microsoft.CodeAnalysis.MSBuild;
using Microsoft.CodeAnalysis.Rename;
using Microsoft.CodeAnalysis.Text;
using static Microsoft.CodeAnalysis.CSharp.SyntaxFactory;

namespace SimulaSharp.Studio.Core;

/// <summary>
/// Replays a journal of <see cref="EditAction"/>s back into a project's source (the Generate step). The apply is
/// transactional and verify-first: edits are made against an in-memory Roslyn solution, the result is recompiled, and
/// files are only written (added / changed / deleted) if the edited project still compiles clean — so a rejected edit
/// leaves the source untouched. On success the freshly re-derived IR is returned so the SPA can rebase onto it.
/// <para>
/// Member and association actions edit a type's body; type actions (<c>addType</c> / <c>renameType</c> /
/// <c>removeType</c>) work at the solution level (a new file, a solution-wide rename, a file/declaration removal).
/// Actions are applied strictly in journal order, recompiling to re-resolve symbols after each solution-shaping step.
/// </para>
/// </summary>
public sealed class ProjectGenerator
{
    static ProjectGenerator()
    {
        if (!Microsoft.Build.Locator.MSBuildLocator.IsRegistered)
            Microsoft.Build.Locator.MSBuildLocator.RegisterDefaults();
    }

    /// <summary>Applies <paramref name="actions"/> to <paramref name="projectPath"/>, writing changes only if they compile.</summary>
    public async Task<GenerateResult> ApplyAsync(string projectPath, IReadOnlyList<EditAction> actions, CancellationToken ct = default) =>
        (await ApplyWithCatalogAsync(projectPath, actions, ct).ConfigureAwait(false)).Result;

    /// <summary>As <see cref="ApplyAsync"/>, but also returns the freshly rebuilt <see cref="TypeCatalog"/> (from the
    /// post-write compilation) on success — the hub caches it so the Type Selector reflects the new source. The catalog
    /// is <c>null</c> on failure or a no-op (the cache then keeps its prior value).</summary>
    public async Task<(GenerateResult Result, IReadOnlyList<TypeRef>? Catalog)> ApplyWithCatalogAsync(
        string projectPath, IReadOnlyList<EditAction> actions, CancellationToken ct = default)
    {
        if (actions.Count == 0) return (new GenerateResult(true, [], null), null);

        try
        {
            using var workspace = MSBuildWorkspace.Create();
            var project = await workspace.OpenProjectAsync(projectPath, cancellationToken: ct).ConfigureAwait(false);
            var originalSolution = project.Solution;
            var projectId = project.Id;
            var baseCompilation = await project.GetCompilationAsync(ct).ConfigureAwait(false)
                                  ?? throw new InvalidOperationException($"Could not compile project '{projectPath}'.");

            // Apply in journal order. Type actions reshape the solution; member/association actions edit a type body.
            var solution = originalSolution;
            foreach (var a in actions)
                solution = a.Op switch
                {
                    "addType" => AddType(solution, projectId, a),
                    "renameType" => await RenameType(solution, projectId, a, ct).ConfigureAwait(false),
                    "removeType" => await RemoveType(solution, projectId, a, ct).ConfigureAwait(false),
                    "renameNamespace" => await RenameNamespace(solution, projectId, a, ct).ConfigureAwait(false),
                    "moveType" => await MoveType(solution, projectId, a, ct).ConfigureAwait(false),
                    _ => await ApplyToTypeBody(solution, projectId, a, ct).ConfigureAwait(false),
                };

            // Drop `using`s pointing at namespaces that no longer exist (e.g. a namespace emptied by moving its last
            // type out) so they don't dangle as CS0234, then normalize the physical layout.
            solution = await PruneDanglingUsingsAsync(solution, projectId, ct).ConfigureAwait(false);
            solution = await LayoutNormalizer.NormalizeAsync(solution, projectId, ct).ConfigureAwait(false);

            // Verify: recompile and refuse to write only if the edit *introduced* errors — a pre-existing error (the
            // project may be mid-edit) shouldn't block an unrelated change. Compared by id+file+message so a shifted
            // line number doesn't read as a new error.
            var editedProject = solution.GetProject(projectId)!;
            var editedCompilation = await editedProject.GetCompilationAsync(ct).ConfigureAwait(false)
                                    ?? throw new InvalidOperationException("Could not recompile the edited project.");
            var before = baseCompilation.GetDiagnostics(ct)
                .Where(d => d.Severity == DiagnosticSeverity.Error)
                .Select(DiagnosticKey)
                .ToHashSet();
            var introduced = editedCompilation.GetDiagnostics(ct)
                .Where(d => d.Severity == DiagnosticSeverity.Error && !before.Contains(DiagnosticKey(d)))
                .Select(d => d.ToString())
                .ToList();
            if (introduced.Count > 0) return (new GenerateResult(false, introduced, null), null);

            await CommitAsync(solution, originalSolution, projectId, ct).ConfigureAwait(false);
            var model = ProjectWorkspace.BuildModel(editedProject.Name, projectPath, editedCompilation);
            return (new GenerateResult(true, [], model), TypeCatalog.Build(editedCompilation));
        }
        catch (Exception ex) when (ex is InvalidOperationException or NotSupportedException)
        {
            return (new GenerateResult(false, [ex.Message], null), null);
        }
    }

    // ── Member / association actions (edit a type body) ─────────────────────────

    private static async Task<Solution> ApplyToTypeBody(Solution solution, ProjectId projectId, EditAction a, CancellationToken ct)
    {
        var type = await ResolveType(solution, projectId, a.TypeKey, ct).ConfigureAwait(false);
        return await SourceEditor.ApplyToTypeAsync(solution, type, [a], ct).ConfigureAwait(false);
    }

    // ── Type actions (reshape the solution) ─────────────────────────────────────

    private static Solution AddType(Solution solution, ProjectId projectId, EditAction a)
    {
        var project = solution.GetProject(projectId)!;
        string dir = Path.GetDirectoryName(project.FilePath)
                     ?? throw new InvalidOperationException("The project has no directory to add a file to.");
        string ns = NamespaceOf(a.TypeKey), name = NameOf(a.TypeKey);
        // A provisional, per-key-unique path; the layout-normalization pass relocates it to the namespace's directory.
        string filePath = Path.Combine(dir, a.TypeKey + ".cs");
        var text = SourceText.From(TypeSkeleton(ns, name, a.Kind ?? "Other"), Encoding.UTF8);
        return solution.AddDocument(DocumentId.CreateNewId(projectId), name + ".cs", text, filePath: filePath);
    }

    private static async Task<Solution> RenameType(Solution solution, ProjectId projectId, EditAction a, CancellationToken ct)
    {
        var type = await ResolveType(solution, projectId, a.TypeKey, ct).ConfigureAwait(false);
        string newName = a.To ?? throw new InvalidOperationException("renameType needs a new name.");
        return await Renamer.RenameSymbolAsync(solution, type, new SymbolRenameOptions(), newName, ct).ConfigureAwait(false);
    }

    private static async Task<Solution> RemoveType(Solution solution, ProjectId projectId, EditAction a, CancellationToken ct)
    {
        var type = await ResolveType(solution, projectId, a.TypeKey, ct).ConfigureAwait(false);
        var syntaxRef = type.DeclaringSyntaxReferences.FirstOrDefault(r =>
                            !r.SyntaxTree.FilePath.EndsWith(".g.cs", StringComparison.OrdinalIgnoreCase))
                        ?? throw new InvalidOperationException($"No editable source for type '{type.Name}'.");
        var document = solution.GetDocument(syntaxRef.SyntaxTree)!;
        var root = (await document.GetSyntaxRootAsync(ct).ConfigureAwait(false))!;
        var decl = await syntaxRef.GetSyntaxAsync(ct).ConfigureAwait(false);

        // Delete the whole file when this was its only type; otherwise cut just the declaration.
        bool onlyType = !root.DescendantNodes().OfType<BaseTypeDeclarationSyntax>().Any(t => t != decl);
        if (onlyType) return solution.RemoveDocument(document.Id);

        var newRoot = root.RemoveNode(decl, SyntaxRemoveOptions.KeepNoTrivia)!;
        return solution.WithDocumentSyntaxRoot(document.Id, newRoot);
    }

    /// <summary>Renames a namespace by its leaf segment — <see cref="Renamer"/> on the namespace symbol repoints every
    /// declaration and reference (usings, qualified names) across the solution in one clean pass. The frontend only ever
    /// changes the leaf, so the parent path is unchanged.</summary>
    private static async Task<Solution> RenameNamespace(Solution solution, ProjectId projectId, EditAction a, CancellationToken ct)
    {
        var compilation = await solution.GetProject(projectId)!.GetCompilationAsync(ct).ConfigureAwait(false)
                          ?? throw new InvalidOperationException("Could not recompile the project.");
        var ns = FindNamespace(compilation.GlobalNamespace, a.TypeKey)
                 ?? throw new InvalidOperationException($"Namespace '{a.TypeKey}' not found in the project.");
        string newNs = a.To ?? throw new InvalidOperationException("renameNamespace needs a new namespace.");
        string newLeaf = newNs.Contains('.') ? newNs[(newNs.LastIndexOf('.') + 1)..] : newNs;
        return await Renamer.RenameSymbolAsync(solution, ns, new SymbolRenameOptions(), newLeaf, ct).ConfigureAwait(false);
    }

    private static INamespaceSymbol? FindNamespace(INamespaceSymbol root, string ns)
    {
        INamespaceSymbol? current = root;
        foreach (var seg in ns.Split('.'))
        {
            current = current.GetNamespaceMembers().FirstOrDefault(n => n.Name == seg);
            if (current is null) return null;
        }
        return current;
    }

    /// <summary>Moves a type to another namespace: it is cut from its current file and re-emitted under the new
    /// namespace, references get a <c>using &lt;newNs&gt;</c>, and the moved file keeps a <c>using &lt;oldNs&gt;</c> so its
    /// own references to former siblings still resolve. The layout pass then files it in the target directory.</summary>
    private static async Task<Solution> MoveType(Solution solution, ProjectId projectId, EditAction a, CancellationToken ct)
    {
        string oldNs = NamespaceOf(a.TypeKey);
        string newNs = a.To ?? throw new InvalidOperationException("moveType needs a target namespace.");
        if (newNs == oldNs) return solution;

        var type = await ResolveType(solution, projectId, a.TypeKey, ct).ConfigureAwait(false);

        // Resolve referencing documents up front — the symbol is about to be removed.
        var referencingDocs = (await SymbolFinder.FindReferencesAsync(type, solution, ct).ConfigureAwait(false))
            .SelectMany(r => r.Locations)
            .Select(l => l.Document.Id)
            .Distinct()
            .ToList();

        var syntaxRef = type.DeclaringSyntaxReferences.FirstOrDefault(r =>
                            !r.SyntaxTree.FilePath.EndsWith(".g.cs", StringComparison.OrdinalIgnoreCase))
                        ?? throw new InvalidOperationException($"No editable source for type '{type.Name}'.");
        var oldDoc = solution.GetDocument(syntaxRef.SyntaxTree)!;
        var oldRoot = (CompilationUnitSyntax)(await oldDoc.GetSyntaxRootAsync(ct).ConfigureAwait(false))!;
        var typeDecl = (MemberDeclarationSyntax)await syntaxRef.GetSyntaxAsync(ct).ConfigureAwait(false);

        // Cut the type from its current file (drop the file if it held only this type).
        bool sole = !oldRoot.DescendantNodes().OfType<BaseTypeDeclarationSyntax>().Any(t => t != typeDecl);
        solution = sole
            ? solution.RemoveDocument(oldDoc.Id)
            : solution.WithDocumentSyntaxRoot(oldDoc.Id, oldRoot.RemoveNode(typeDecl, SyntaxRemoveOptions.KeepNoTrivia)!);

        // Emit the moved type as its own file under the new namespace (provisional path; the layout pass relocates it).
        var usings = oldRoot.Usings;
        if (oldNs.Length > 0 && !usings.Any(u => u.Name?.ToString() == oldNs))
            usings = usings.Add(UsingDirective(ParseName(oldNs)));
        var unit = CompilationUnit()
            .WithUsings(usings)
            .WithMembers(SingletonList<MemberDeclarationSyntax>(FileScopedNamespaceDeclaration(ParseName(newNs)).WithMembers(SingletonList(typeDecl))))
            .NormalizeWhitespace();

        string projectDir = Path.GetDirectoryName(solution.GetProject(projectId)!.FilePath)!;
        string name = NameOf(a.TypeKey);
        solution = solution.AddDocument(DocumentId.CreateNewId(projectId), name + ".cs",
            SourceText.From(unit.ToFullString(), Encoding.UTF8), filePath: Path.Combine(projectDir, newNs + "." + name + ".cs"));

        // Every referencing file needs `using newNs;` now that the type left oldNs.
        foreach (var docId in referencingDocs)
            if (docId != oldDoc.Id)
                solution = await EnsureUsing(solution, docId, newNs, ct).ConfigureAwait(false);

        return solution;
    }

    private static async Task<Solution> EnsureUsing(Solution solution, DocumentId docId, string ns, CancellationToken ct)
    {
        if (solution.GetDocument(docId) is not { } doc) return solution;
        if (await doc.GetSyntaxRootAsync(ct).ConfigureAwait(false) is not CompilationUnitSyntax root) return solution;
        if (root.Usings.Any(u => u.Name?.ToString() == ns)) return solution;
        var withUsing = root.AddUsings(UsingDirective(ParseName(ns)).WithAdditionalAnnotations(Formatter.Annotation));
        var formatted = await Formatter.FormatAsync(doc.WithSyntaxRoot(withUsing), Formatter.Annotation, cancellationToken: ct).ConfigureAwait(false);
        return formatted.Project.Solution;
    }

    private static async Task<INamedTypeSymbol> ResolveType(Solution solution, ProjectId projectId, string typeKey, CancellationToken ct)
    {
        var compilation = await solution.GetProject(projectId)!.GetCompilationAsync(ct).ConfigureAwait(false)
                          ?? throw new InvalidOperationException("Could not recompile the project.");
        if (compilation.GetTypeByMetadataName(typeKey) is { } type) return type;

        // Diagnose: list every project type with the same simple name — reveals a namespace mismatch or a duplicate
        // (a duplicate makes GetTypeByMetadataName return null as ambiguous).
        string simple = typeKey.Contains('.') ? typeKey[(typeKey.LastIndexOf('.') + 1)..] : typeKey;
        var same = AllTypes(compilation.Assembly.GlobalNamespace).Where(t => t.Name == simple).Select(t => t.ToDisplayString()).ToList();
        string hint = same.Count == 0 ? "no type by that name exists" : $"found by name: {string.Join(", ", same)}";
        throw new InvalidOperationException($"Type '{typeKey}' not found in the project ({hint}).");
    }

    private static IEnumerable<INamedTypeSymbol> AllTypes(INamespaceSymbol ns)
    {
        foreach (var t in ns.GetTypeMembers()) yield return t;
        foreach (var child in ns.GetNamespaceMembers())
            foreach (var t in AllTypes(child))
                yield return t;
    }

    /// <summary>Removes plain <c>using Ns;</c> directives whose namespace no longer exists in the compilation (a
    /// namespace with no types isn't a symbol, so such a using would fail as CS0234).</summary>
    private static async Task<Solution> PruneDanglingUsingsAsync(Solution solution, ProjectId projectId, CancellationToken ct)
    {
        var compilation = await solution.GetProject(projectId)!.GetCompilationAsync(ct).ConfigureAwait(false);
        if (compilation is null) return solution;

        foreach (var docId in solution.GetProject(projectId)!.DocumentIds)
        {
            var doc = solution.GetDocument(docId)!;
            if (doc.FilePath?.EndsWith(".g.cs", StringComparison.OrdinalIgnoreCase) ?? true) continue;
            if (await doc.GetSyntaxRootAsync(ct).ConfigureAwait(false) is not CompilationUnitSyntax root || root.Usings.Count == 0) continue;

            var dangling = root.Usings
                .Where(u => u is { StaticKeyword.RawKind: 0, Alias: null, Name: { } n } && !NamespaceExists(compilation, n.ToString()))
                .ToList();
            if (dangling.Count == 0) continue;

            solution = solution.WithDocumentSyntaxRoot(docId, root.RemoveNodes(dangling, SyntaxRemoveOptions.KeepNoTrivia)!);
        }
        return solution;
    }

    private static bool NamespaceExists(Compilation compilation, string ns)
    {
        INamespaceSymbol? current = compilation.GlobalNamespace;
        foreach (var seg in ns.Split('.'))
        {
            current = current.GetNamespaceMembers().FirstOrDefault(n => n.Name == seg);
            if (current is null) return false;
        }
        return true;
    }

    /// <summary>A minimal, compilable skeleton for a freshly added type of the given kind.</summary>
    private static string TypeSkeleton(string ns, string name, string kind)
    {
        string usings = kind is "Model" or "Service"
            ? "using SimulaSharp.Kernel.Logging;\nusing SimulaSharp.Kernel.Model;\nusing SimulaSharp.Kernel.Services;\n\n"
            : "";
        string body = kind switch
        {
            "Model" => $"public partial class {name}(IClock c, IScheduler s, ILogger l) : ModelBase(c, s, l)\n{{\n}}\n",
            "Service" => $"public partial class {name}(IClock c, ILogger l) : ServiceBase(c, l, \"{name}\")\n{{\n}}\n",
            "Interface" => $"public interface {name}\n{{\n}}\n",
            _ => $"public class {name}\n{{\n}}\n",
        };
        string nsDecl = string.IsNullOrEmpty(ns) ? "" : $"namespace {ns};\n\n"; // a global-namespace type has no declaration
        return $"{usings}{nsDecl}{body}";
    }

    // ── Commit (added / changed files written, removed files deleted) ────────────

    private static async Task CommitAsync(Solution solution, Solution originalSolution, ProjectId projectId, CancellationToken ct)
    {
        var perProject = solution.GetChanges(originalSolution).GetProjectChanges().Where(pc => pc.ProjectId == projectId).ToList();
        if (perProject.Count == 0) return;
        var changes = perProject[0];

        foreach (var id in changes.GetRemovedDocuments())
            if (originalSolution.GetDocument(id)?.FilePath is { } path && File.Exists(path))
            {
                File.Delete(path);
                PruneEmptyDirs(Path.GetDirectoryName(path), Path.GetDirectoryName(originalSolution.GetProject(projectId)!.FilePath));
            }

        foreach (var id in changes.GetAddedDocuments().Concat(changes.GetChangedDocuments()))
        {
            var doc = solution.GetDocument(id)!;
            if (doc.FilePath is not { } filePath) continue;
            Directory.CreateDirectory(Path.GetDirectoryName(filePath)!); // namespace subdirectory may be new
            var text = await doc.GetTextAsync(ct).ConfigureAwait(false);
            // LF, matching the repo convention.
            await File.WriteAllTextAsync(filePath, text.ToString().Replace("\r\n", "\n"), text.Encoding ?? Encoding.UTF8, ct)
                .ConfigureAwait(false);
        }
    }

    /// <summary>Removes now-empty directories walking up from <paramref name="dir"/>, stopping at the project root.</summary>
    private static void PruneEmptyDirs(string? dir, string? projectDir)
    {
        while (dir is not null && projectDir is not null && !PathEquals(dir, projectDir)
               && Directory.Exists(dir) && !Directory.EnumerateFileSystemEntries(dir).Any())
        {
            Directory.Delete(dir);
            dir = Path.GetDirectoryName(dir);
        }
    }

    private static bool PathEquals(string a, string b) =>
        string.Equals(Path.GetFullPath(a), Path.GetFullPath(b), StringComparison.OrdinalIgnoreCase);

    private static string NamespaceOf(string typeKey) { int d = typeKey.LastIndexOf('.'); return d < 0 ? "" : typeKey[..d]; }
    private static string NameOf(string typeKey) { int d = typeKey.LastIndexOf('.'); return d < 0 ? typeKey : typeKey[(d + 1)..]; }

    /// <summary>A location-independent identity for a diagnostic, so a pre-existing error still matches after edits
    /// shift its line number.</summary>
    private static string DiagnosticKey(Diagnostic d) =>
        d.Id + "|" + d.Location.SourceTree?.FilePath + "|" + d.GetMessage();
}
