namespace SimulaSharp.Studio.Core.Tests;

/// <summary>Parses the DemoSim assembly topology and checks the flattened IR: services, sites, containment, refs, deps.</summary>
[TestFixture]
public sealed class AssemblyReaderTests
{
    [Test]
    public async Task Reads_the_DemoSim_assembly_topology()
    {
        string csproj = FindUp("Studio", "samples", "DemoSim", "DemoSim.csproj");

        var assemblies = await new AssemblyReader().ReadAsync(csproj);

        Assert.That(assemblies, Has.Count.EqualTo(1));
        var a = assemblies[0];
        var eps = a.Sites.Single(s => s.Name == "Bus").Models.Single(m => m.Name == "Eps");
        Assert.Multiple(() =>
        {
            Assert.That(a.Name, Is.EqualTo("DemoSim"));
            Assert.That(a.Services.Any(s => s is { Name: "Environment", Type: "DemoSim.Services.Environment" }), "Environment service");

            var batteries = eps.Containers.Single(c => c.Name == "Batteries");
            Assert.That(batteries.Children.Select(m => m.Name), Is.EquivalentTo(new[] { "Bat1", "Bat2" }));
            Assert.That(batteries.Children.Single(m => m.Name == "Bat1").Config["CapacityWh"], Is.EqualTo("2000"));

            // The intra-site Reference (Refs: block) parses with IsCross=false; the cross-site CrossReference
            // (CRefs: block) with IsCross=true — both merge into the one Refs list.
            var cells = eps.Refs.Single(r => r.Name == "Cells");
            Assert.That(cells.IsCross, Is.False, "Cells is an intra-site Reference");
            Assert.That(cells.Targets, Is.EquivalentTo(new[] { "DemoSim.Eps.Bat1", "DemoSim.Eps.Bat2" }));

            var consumers = eps.Refs.Single(r => r.Name == "Consumers");
            Assert.That(consumers.IsCross, Is.True, "Consumers is a cross-site CrossReference");
            Assert.That(consumers.Targets, Does.Contain("DemoSim.Heater"));

            Assert.That(a.Sites.Single(s => s.Name == "Loads").Models.Any(m => m.Name == "Heater"), "Heater on Loads site");
            Assert.That(eps.Deps.Any(d => d is { Member: "Environment", Service: "Environment" }), "Eps → Environment dep");
        });
    }

    private static string FindUp(params string[] relative)
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            string candidate = Path.Combine([dir.FullName, .. relative]);
            if (File.Exists(candidate)) return candidate;
        }
        throw new FileNotFoundException($"Could not locate {string.Join('/', relative)}");
    }
}
