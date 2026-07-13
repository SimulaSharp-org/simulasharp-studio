using System.Text;
using YamlDotNet.Serialization;

namespace SimulaSharp.Studio.Core;

/// <summary>The outcome of a topology write: on failure the blocking messages; on success nothing more is needed
/// (the caller already holds the edited model).</summary>
public sealed record TopologyWriteResult(bool Ok, IReadOnlyList<string> Errors);

/// <summary>
/// Writes edited <see cref="AssemblyModel"/>s back to their <c>*.simassembly.yaml</c> files. Write-back is plain YAML
/// serialization (low risk): each model is turned into the descriptor shape and serialized, round-trip re-parsed as a
/// guard, then written (LF). SIM-level validation happens on the next project build.
/// </summary>
public sealed class TopologyGenerator
{
    /// <summary>Serializes each assembly to YAML and writes it to its file; nothing is written if any fails to round-trip.</summary>
    public async Task<TopologyWriteResult> WriteAsync(IReadOnlyList<AssemblyModel> assemblies, CancellationToken ct = default)
    {
        var serializer = new SerializerBuilder()
            .ConfigureDefaultValuesHandling(DefaultValuesHandling.OmitNull)
            .Build();
        var deserializer = new DeserializerBuilder().IgnoreUnmatchedProperties().Build();

        // Serialize + verify all before writing any, so a bad one leaves every file untouched.
        var pending = new List<(string Path, string Yaml)>();
        foreach (var a in assemblies)
        {
            string yaml;
            try
            {
                yaml = serializer.Serialize(AssemblyYaml.ToDescriptor(a));
                deserializer.Deserialize<AssemblyYaml.SimAssembly>(yaml); // round-trip guard
            }
            catch (Exception ex)
            {
                return new TopologyWriteResult(false, [$"{a.Name}: {ex.Message}"]);
            }
            pending.Add((a.Path, yaml));
        }

        var utf8NoBom = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false);
        foreach (var (path, yaml) in pending)
            await File.WriteAllTextAsync(path, yaml.Replace("\r\n", "\n"), utf8NoBom, ct).ConfigureAwait(false);

        return new TopologyWriteResult(true, []);
    }
}
