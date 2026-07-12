namespace SimulaSharp.Studio.Core.Tests;

/// <summary>
/// Proves the risky integration: Roslyn's MSBuildWorkspace opens a real on-disk project and the Phase-0
/// projection classifies its types. Opens the framework's own Kernel project as a known fixture.
/// </summary>
[TestFixture]
public sealed class ProjectWorkspaceTests
{
    [Test]
    public async Task Opens_the_Kernel_project_and_classifies_designable_types()
    {
        string kernelCsproj = FindUp("Kernel", "Kernel.csproj");

        var model = await new ProjectWorkspace().OpenAsync(kernelCsproj);

        Assert.Multiple(() =>
        {
            Assert.That(model.Types, Is.Not.Empty, "no types projected from the Kernel project");
            Assert.That(model.Types.Any(t => t is { Name: "ModelBase", Kind: "Model" }), Is.True,
                "ModelBase should classify as Model");
            Assert.That(model.Types.Any(t => t is { Name: "IModel", Kind: "Interface" }), Is.True,
                "IModel should classify as Interface");
        });
    }

    /// <summary>Walks up from the test binary to find a file at the given relative path (locates the repo tree).</summary>
    private static string FindUp(params string[] relative)
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            string candidate = Path.Combine([dir.FullName, .. relative]);
            if (File.Exists(candidate)) return candidate;
        }
        throw new FileNotFoundException($"Could not locate {string.Join('/', relative)} above {AppContext.BaseDirectory}");
    }
}
