using System.Text;
using System.Text.Json;

namespace SimulaSharp.Studio.Core;

/// <summary>List-view metadata for one saved snapshot — the header fields read from the file without loading its
/// (potentially large) baseline IR + journal.</summary>
public sealed record SnapshotHeader(string Id, string Label, string? SavedUtc, string? BaselineCapturedUtc);

/// <summary>The outcome of a snapshot save: the <paramref name="Id"/> it was stored under and its file path.</summary>
public sealed record SnapshotSaveResult(string Id, string Path);

/// <summary>
/// Persists design/topology snapshots as JSON files under <c>&lt;projectDir&gt;/.studio/snapshots/</c>. The snapshot body
/// is <b>frontend-shaped</b> JSON (baseline IR + edit journal) — this store treats it as an opaque blob it writes, lists
/// (reading only the header fields), loads, and deletes; it never interprets the journal. A <c>.studio/.gitignore</c>
/// (<c>*</c>) is dropped on first write so snapshots never land in the edited project's git history.
/// </summary>
public sealed class SnapshotStore
{
    private static readonly JsonSerializerOptions Json = new() { PropertyNameCaseInsensitive = true };

    /// <summary>Lists the saved snapshots for a project, newest-saved first, as lightweight headers.</summary>
    public async Task<IReadOnlyList<SnapshotHeader>> ListAsync(string projectPath, CancellationToken ct = default)
    {
        var dir = SnapshotDir(projectPath);
        if (!Directory.Exists(dir)) return [];

        var headers = new List<(SnapshotHeader Header, string SortKey)>();
        foreach (var file in Directory.EnumerateFiles(dir, "*.json"))
        {
            var header = await TryReadHeaderAsync(file, ct).ConfigureAwait(false);
            if (header is not null) headers.Add((header, header.SavedUtc ?? ""));
        }
        return headers.OrderByDescending(h => h.SortKey, StringComparer.Ordinal).Select(h => h.Header).ToList();
    }

    /// <summary>Writes a snapshot. Re-saving the same <c>id</c> (e.g. the post-Generate auto-save) overwrites its file;
    /// a new id gets a fresh <c>&lt;label&gt;-&lt;savedUtc&gt;.json</c> file.</summary>
    public async Task<SnapshotSaveResult> SaveAsync(string projectPath, string snapshotJson, CancellationToken ct = default)
    {
        using var doc = JsonDocument.Parse(snapshotJson);
        var root = doc.RootElement;
        string id = root.TryGetProperty("id", out var idEl) ? idEl.GetString() ?? "" : "";
        string label = root.TryGetProperty("label", out var lblEl) ? lblEl.GetString() ?? "" : "";
        string savedUtc = root.TryGetProperty("savedUtc", out var svEl) ? svEl.GetString() ?? "" : "";
        if (id.Length == 0) throw new InvalidOperationException("Snapshot is missing its 'id'.");

        var dir = SnapshotDir(projectPath);
        Directory.CreateDirectory(dir);
        await EnsureGitignoreAsync(projectPath, ct).ConfigureAwait(false);

        // Overwrite the existing file for this id if there is one; otherwise mint a readable filename.
        string path = await FindByIdAsync(dir, id, ct).ConfigureAwait(false)
                      ?? Path.Combine(dir, $"{Sanitize(label.Length > 0 ? label : "snapshot")}-{Sanitize(CompactStamp(savedUtc))}.json");

        await File.WriteAllTextAsync(path, snapshotJson.Replace("\r\n", "\n"), NoBom, ct).ConfigureAwait(false);
        return new SnapshotSaveResult(id, path);
    }

    /// <summary>Returns the raw JSON of the snapshot with this id, or <c>null</c> if it no longer exists.</summary>
    public async Task<string?> LoadAsync(string projectPath, string id, CancellationToken ct = default)
    {
        var path = await FindByIdAsync(SnapshotDir(projectPath), id, ct).ConfigureAwait(false);
        return path is null ? null : await File.ReadAllTextAsync(path, ct).ConfigureAwait(false);
    }

    /// <summary>Deletes the snapshot with this id (a no-op if it is already gone).</summary>
    public async Task DeleteAsync(string projectPath, string id, CancellationToken ct = default)
    {
        var path = await FindByIdAsync(SnapshotDir(projectPath), id, ct).ConfigureAwait(false);
        if (path is not null) File.Delete(path);
    }

    // ── helpers ─────────────────────────────────────────────────────────────────

    private static readonly UTF8Encoding NoBom = new(encoderShouldEmitUTF8Identifier: false);

    private static string SnapshotDir(string projectPath) =>
        Path.Combine(Path.GetDirectoryName(Path.GetFullPath(projectPath)) ?? ".", ".studio", "snapshots");

    private static async Task<SnapshotHeader?> TryReadHeaderAsync(string file, CancellationToken ct)
    {
        try
        {
            await using var stream = File.OpenRead(file);
            using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: ct).ConfigureAwait(false);
            var r = doc.RootElement;
            string id = r.TryGetProperty("id", out var idEl) ? idEl.GetString() ?? "" : "";
            if (id.Length == 0) return null;
            return new SnapshotHeader(
                id,
                r.TryGetProperty("label", out var lbl) ? lbl.GetString() ?? "" : "",
                r.TryGetProperty("savedUtc", out var sv) ? sv.GetString() : null,
                r.TryGetProperty("baselineCapturedUtc", out var bc) ? bc.GetString() : null);
        }
        catch { return null; } // not a snapshot file (bad JSON / partial write) — skip it
    }

    /// <summary>Scans the snapshot dir for the file whose stored <c>id</c> matches, so a re-save targets the same file.</summary>
    private static async Task<string?> FindByIdAsync(string dir, string id, CancellationToken ct)
    {
        if (!Directory.Exists(dir)) return null;
        foreach (var file in Directory.EnumerateFiles(dir, "*.json"))
        {
            var header = await TryReadHeaderAsync(file, ct).ConfigureAwait(false);
            if (header?.Id == id) return file;
        }
        return null;
    }

    /// <summary>Writes <c>.studio/.gitignore</c> (<c>*</c>) once, so the snapshot folder self-excludes from git.</summary>
    private static async Task EnsureGitignoreAsync(string projectPath, CancellationToken ct)
    {
        var studioDir = Path.Combine(Path.GetDirectoryName(Path.GetFullPath(projectPath)) ?? ".", ".studio");
        Directory.CreateDirectory(studioDir);
        var gitignore = Path.Combine(studioDir, ".gitignore");
        if (!File.Exists(gitignore))
            await File.WriteAllTextAsync(gitignore, "*\n", NoBom, ct).ConfigureAwait(false);
    }

    /// <summary>Reduces a label/stamp to filename-safe characters.</summary>
    private static string Sanitize(string s)
    {
        var sb = new StringBuilder(s.Length);
        foreach (var c in s) sb.Append(char.IsLetterOrDigit(c) || c is '-' or '_' ? c : '-');
        var cleaned = sb.ToString().Trim('-');
        return cleaned.Length > 0 ? cleaned : "snapshot";
    }

    /// <summary>An ISO-ish UTC string reduced to a compact, sortable, filename-safe stamp (digits only).</summary>
    private static string CompactStamp(string savedUtc)
    {
        var digits = new string(savedUtc.Where(char.IsDigit).ToArray());
        return digits.Length >= 14 ? digits[..14] : digits.Length > 0 ? digits : "0";
    }
}
