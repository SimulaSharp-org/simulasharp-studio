namespace SimulaSharp.Studio.Core.Tests;

/// <summary>Round-trips the DemoSim topology through the writer: read → serialize to YAML → parse guard, and check the shape.</summary>
[TestFixture]
public sealed class TopologyGeneratorTests
{
    [Test]
    public async Task Writes_the_topology_back_to_valid_yaml()
    {
        string csproj = FindUp("Studio", "samples", "DemoSim", "DemoSim.csproj");
        var assemblies = await new AssemblyReader().ReadAsync(csproj);
        string temp = Path.Combine(Path.GetTempPath(), "studio-topo-" + Guid.NewGuid().ToString("N") + ".simassembly.yaml");

        try
        {
            var result = await new TopologyGenerator().WriteAsync([assemblies[0] with { Path = temp }]);
            Assert.That(result.Ok, Is.True, () => string.Join("\n", result.Errors));

            string yaml = await File.ReadAllTextAsync(temp);
            Assert.Multiple(() =>
            {
                Assert.That(yaml, Does.Contain("Name: DemoSim"));
                Assert.That(yaml, Does.Contain("DemoSim.Services.Environment"), "service type");
                Assert.That(yaml, Does.Contain("Batteries"), "container name");
                Assert.That(yaml, Does.Contain("CapacityWh"), "config key");
                // The intra Reference lands under Refs:, the cross CrossReference under CRefs:.
                Assert.That(yaml, Does.Contain("Refs:"), "intra Refs block");
                Assert.That(yaml, Does.Contain("Cells"), "intra reference name");
                Assert.That(yaml, Does.Contain("CRefs:"), "cross CRefs block");
                Assert.That(yaml, Does.Contain("Consumers"), "cross reference name");
                Assert.That(yaml, Does.Contain("DemoSim.Heater"), "cross reference target");
                // The cross binding must sit under CRefs:, not Refs: — assert its ordering relative to the block headers.
                int crefs = yaml.IndexOf("CRefs:", StringComparison.Ordinal);
                Assert.That(crefs, Is.GreaterThan(0));
                Assert.That(yaml.IndexOf("Consumers", StringComparison.Ordinal), Is.GreaterThan(crefs), "Consumers under CRefs:");
            });
        }
        finally
        {
            if (File.Exists(temp)) File.Delete(temp);
        }
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
