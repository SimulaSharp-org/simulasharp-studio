using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.MSBuild;
using Microsoft.CodeAnalysis.Rename;
using Microsoft.CodeAnalysis.Text;

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
    public async Task<GenerateResult> ApplyAsync(string projectPath, IReadOnlyList<EditAction> actions, CancellationToken ct = default)
    {
        if (actions.Count == 0) return new GenerateResult(true, [], null);

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
                    _ => await ApplyToTypeBody(solution, projectId, a, ct).ConfigureAwait(false),
                };

            // Normalize the physical layout (one type per file, directory mirrors namespace) before verifying, so the
            // committed layout is what we compile-check.
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
            if (introduced.Count > 0) return new GenerateResult(false, introduced, null);

            await CommitAsync(solution, originalSolution, projectId, ct).ConfigureAwait(false);
            return new GenerateResult(true, [], ProjectWorkspace.BuildModel(editedProject.Name, projectPath, editedCompilation));
        }
        catch (Exception ex) when (ex is InvalidOperationException or NotSupportedException)
        {
            return new GenerateResult(false, [ex.Message], null);
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

    private static async Task<INamedTypeSymbol> ResolveType(Solution solution, ProjectId projectId, string typeKey, CancellationToken ct)
    {
        var compilation = await solution.GetProject(projectId)!.GetCompilationAsync(ct).ConfigureAwait(false)
                          ?? throw new InvalidOperationException("Could not recompile the project.");
        return compilation.GetTypeByMetadataName(typeKey)
               ?? throw new InvalidOperationException($"Type '{typeKey}' not found in the project.");
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
        return $"{usings}namespace {ns};\n\n{body}";
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
