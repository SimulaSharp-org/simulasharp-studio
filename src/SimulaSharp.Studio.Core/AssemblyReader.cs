using Microsoft.Build.Locator;
using Microsoft.CodeAnalysis.MSBuild;
using YamlDotNet.Serialization;

namespace SimulaSharp.Studio.Core;

/// <summary>
/// Reads a project's <c>*.simassembly.yaml</c> topology files — the ones registered as <c>&lt;SimAssembly&gt;</c>, which
/// surface to Roslyn as <see cref="Microsoft.CodeAnalysis.TextDocument">AdditionalDocuments</see> — and parses each
/// (YamlDotNet, the shape in <see cref="AssemblyYaml"/>) into a flattened <see cref="AssemblyModel"/> for the topology
/// editor.
/// </summary>
public sealed class AssemblyReader
{
    static AssemblyReader()
    {
        if (!MSBuildLocator.IsRegistered)
            MSBuildLocator.RegisterDefaults();
    }

    /// <summary>Opens <paramref name="projectPath"/> and parses every assembly YAML it registers.</summary>
    public async Task<IReadOnlyList<AssemblyModel>> ReadAsync(string projectPath, CancellationToken ct = default)
    {
        using var workspace = MSBuildWorkspace.Create();
        var project = await workspace.OpenProjectAsync(projectPath, cancellationToken: ct).ConfigureAwait(false);
        var deserializer = new DeserializerBuilder().IgnoreUnmatchedProperties().Build();

        var models = new List<AssemblyModel>();
        foreach (var doc in project.AdditionalDocuments)
        {
            if (doc.FilePath is not { } path) continue;
            if (!path.EndsWith(".yaml", StringComparison.OrdinalIgnoreCase) && !path.EndsWith(".yml", StringComparison.OrdinalIgnoreCase))
                continue;

            string yaml = (await doc.GetTextAsync(ct).ConfigureAwait(false)).ToString();
            AssemblyYaml.SimAssembly? parsed;
            try { parsed = deserializer.Deserialize<AssemblyYaml.SimAssembly>(yaml); }
            catch { continue; } // not a (valid) assembly file — skip

            if (parsed?.Simulator is { Name: { Length: > 0 } } sim)
                models.Add(AssemblyYaml.ToModel(sim, path));
        }
        return models;
    }
}
