using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.MSBuild;

namespace SimulaSharp.Studio.Core;

/// <summary>
/// Replays a journal of <see cref="EditAction"/>s back into a project's source (the Generate step). The apply is
/// transactional and verify-first: edits are made against an in-memory Roslyn solution, the result is recompiled, and
/// files are only written to disk if the edited project still compiles clean — so a rejected edit leaves the source
/// untouched. On success the freshly re-derived IR is returned so the SPA can rebase onto it.
/// <para>
/// This slice proves the pipeline end-to-end for one action kind (<c>removeMember</c>); breadth of ops, per-document
/// (rather than per-type) grouping, and the relocatable-copy sandbox for out-of-project vendored deps follow.
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
            var baseCompilation = await project.GetCompilationAsync(ct).ConfigureAwait(false)
                                  ?? throw new InvalidOperationException($"Could not compile project '{projectPath}'.");

            // Apply all actions, grouped by their target type, onto an in-memory solution.
            var solution = project.Solution;
            foreach (var group in actions.GroupBy(a => a.TypeKey))
            {
                var type = baseCompilation.GetTypeByMetadataName(group.Key)
                           ?? throw new InvalidOperationException($"Type '{group.Key}' not found in the project.");
                solution = await SourceEditor.ApplyToTypeAsync(solution, type, group.ToList(), ct).ConfigureAwait(false);
            }

            // Verify: recompile the edited project and refuse to write only if the edit *introduced* errors — a
            // pre-existing error (the project may be mid-edit) shouldn't block an unrelated change. Compared by
            // id+message so shifted line numbers don't read as new errors.
            var editedProject = solution.GetProject(project.Id)!;
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

            // Commit: write each changed document to disk (LF, matching the repo convention).
            foreach (var change in solution.GetChanges(project.Solution).GetProjectChanges())
                foreach (var docId in change.GetChangedDocuments())
                {
                    var doc = solution.GetDocument(docId)!;
                    if (doc.FilePath is not { } filePath) continue;
                    var text = await doc.GetTextAsync(ct).ConfigureAwait(false);
                    await File.WriteAllTextAsync(filePath, text.ToString().Replace("\r\n", "\n"),
                        text.Encoding ?? Encoding.UTF8, ct).ConfigureAwait(false);
                }

            return new GenerateResult(true, [], ProjectWorkspace.BuildModel(editedProject.Name, projectPath, editedCompilation));
        }
        catch (Exception ex) when (ex is InvalidOperationException or NotSupportedException)
        {
            return new GenerateResult(false, [ex.Message], null);
        }
    }

    /// <summary>A location-independent identity for a diagnostic, so a pre-existing error still matches after edits
    /// shift its line number.</summary>
    private static string DiagnosticKey(Diagnostic d) =>
        d.Id + "|" + d.Location.SourceTree?.FilePath + "|" + d.GetMessage();
}
