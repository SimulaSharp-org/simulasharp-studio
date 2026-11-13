namespace SimulaSharp.Studio.Core.Tests;

/// <summary>Round-trips the DemoSim topology through the writer: read → serialize to YAML → parse guard, and check the shape.</summary>
[TestFixture]
public sealed class TopologyGeneratorTests
{
    [Test]
    public async Task Writes_the_topology_back_to_valid_yaml()
    {
        string csproj = FindUp("samples", "DemoSim", "DemoSim.csproj");
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

    /// <summary>
    /// Reads DemoSim, writes it back, and compares the written YAML with the original as plain data trees (maps without
    /// key order, lists with order, comments ignored). Any key or value Studio does not carry through the IR shows up
    /// as a difference, so a block the writer silently drops (as <c>Events</c>/<c>Subscriptions</c>/<c>Triggers</c> once
    /// were) fails here.
    /// </summary>
    [Test]
    public async Task Writing_the_topology_back_keeps_every_key_and_value()
    {
        string csproj = FindUp("samples", "DemoSim", "DemoSim.csproj");
        var assemblies = await new AssemblyReader().ReadAsync(csproj);
        string temp = Path.Combine(Path.GetTempPath(), "studio-topo-" + Guid.NewGuid().ToString("N") + ".simassembly.yaml");

        try
        {
            var result = await new TopologyGenerator().WriteAsync([assemblies[0] with { Path = temp }]);
            Assert.That(result.Ok, Is.True, () => string.Join("\n", result.Errors));

            var deserializer = new YamlDotNet.Serialization.DeserializerBuilder().Build();
            object? original = deserializer.Deserialize<object>(await File.ReadAllTextAsync(assemblies[0].Path));
            object? written = deserializer.Deserialize<object>(await File.ReadAllTextAsync(temp));

            var diffs = new List<string>();
            Diff(original, written, "", diffs);
            Assert.That(diffs, Is.Empty, () => "Lost or changed on write-back:\n" + string.Join("\n", diffs));
        }
        finally
        {
            if (File.Exists(temp)) File.Delete(temp);
        }
    }

    /// <summary>Collects every difference between two generic YamlDotNet trees as <c>path: detail</c> lines. Maps are
    /// compared by key (order ignored), lists by position, scalars as strings.</summary>
    private static void Diff(object? expected, object? actual, string path, List<string> diffs)
    {
        switch (expected, actual)
        {
            case (IDictionary<object, object> e, IDictionary<object, object> a):
                foreach (var key in e.Keys)
                {
                    if (a.TryGetValue(key, out var value)) Diff(e[key], value, $"{path}/{key}", diffs);
                    else diffs.Add($"{path}/{key}: missing");
                }
                foreach (var key in a.Keys.Where(k => !e.ContainsKey(k)))
                    diffs.Add($"{path}/{key}: unexpected");
                break;
            case (IList<object> e, IList<object> a):
                if (e.Count != a.Count) diffs.Add($"{path}: {e.Count} items written as {a.Count}");
                for (int i = 0; i < Math.Min(e.Count, a.Count); i++) Diff(e[i], a[i], $"{path}[{i}]", diffs);
                break;
            default:
                if (!Equals(expected?.ToString(), actual?.ToString()))
                    diffs.Add($"{path}: '{expected}' written as '{actual}'");
                break;
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
