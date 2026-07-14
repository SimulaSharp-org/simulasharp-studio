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

    [Test]
    public async Task Opens_the_DemoSim_project_and_projects_designable_members()
    {
        string csproj = FindUp("Studio", "samples", "DemoSim", "DemoSim.csproj");

        var model = await new ProjectWorkspace().OpenAsync(csproj);
        var eps = model.Types.FirstOrDefault(t => t.Name == "Eps");
        var battery = model.Types.FirstOrDefault(t => t.Name == "Battery");
        var env = model.Types.FirstOrDefault(t => t.Name == "Environment");
        var ipc = model.Types.FirstOrDefault(t => t.Name == "IPowerConsumer");
        var heater = model.Types.FirstOrDefault(t => t.Name == "Heater");

        var vbus = eps?.Members.SingleOrDefault(m => m.Name == "Vbus");
        Assert.Multiple(() =>
        {
            Assert.That(eps?.Kind, Is.EqualTo("Model"));
            Assert.That(ipc?.Kind, Is.EqualTo("Interface"));
            Assert.That(ipc!.Members.Any(m => m.Name == "DrawW" && m.Facets.Contains("Property")), "IPowerConsumer.DrawW property");
            Assert.That(vbus, Is.Not.Null, "Eps.Vbus should be a single combined row");
            Assert.That(vbus!.Facets, Does.Contain("Knob").And.Contain("Plottable"), "Eps.Vbus is knob + plottable");
            Assert.That(battery!.Members.Any(m => m.Name == "CapacityWh" && m.Facets.Contains("Parameter")), "Battery.CapacityWh param");
            Assert.That(env?.Kind, Is.EqualTo("Service"));
            Assert.That(env!.Members.Any(m => m.Name == "SunAngle" && m.Facets.Contains("ServiceEvent")), "Env SunAngle event");
            Assert.That(env.Members.Any(m => m.Name == "CurrentAngle" && m.Facets.Contains("ServiceRequest")), "Env CurrentAngle request");

            // Associations: Eps contains Batteries, holds an intra-site Reference to its Cells and a cross-site
            // CrossReference to its Consumers; Heater implements IPowerConsumer.
            Assert.That(eps!.Associations.Any(a => a is { Kind: "Containment", Name: "Batteries" } && a.Target.EndsWith(".Battery")),
                "Eps [Contains<Battery>(\"Batteries\")]");
            Assert.That(eps.Associations.Any(a => a is { Kind: "Reference", Name: "Cells" } && a.Target.EndsWith(".Battery")),
                "Eps [Reference<Battery>(\"Cells\")]");
            Assert.That(eps.Associations.Any(a => a is { Kind: "CrossReference", Name: "Consumers" } && a.Target.EndsWith(".IPowerConsumer")),
                "Eps [CrossReference<IPowerConsumer>(\"Consumers\")]");
            Assert.That(heater!.Associations.Any(a => a is { Kind: "Inheritance" } && a.Target.EndsWith(".IPowerConsumer")),
                "Heater : IPowerConsumer");
            Assert.That(eps.Associations.Any(a => a is { Kind: "ServiceDep", Name: "Environment" } && a.Target.EndsWith(".Environment")),
                "Eps [ServiceRef] Environment");
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
