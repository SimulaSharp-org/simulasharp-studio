namespace SimulaSharp.Studio.Core;

/// <summary>The value/shape of a member in an edit action (mirrors the SPA's member row). <paramref name="Params"/>
/// is the parameter list for a method-shaped member (interface method / service-request handler); null otherwise.</summary>
public sealed record MemberDto(string Name, string? Type, IReadOnlyList<string> Facets, string? Params = null);

/// <summary>An association in an edit action (mirrors the SPA's association).</summary>
public sealed record AssocDto(string Kind, string Name, string Target);

/// <summary>
/// One pending edit from the SPA's journal, discriminated by <paramref name="Op"/>. This is the wire shape the
/// <see cref="ProjectGenerator"/> replays through Roslyn on Generate. A single nullable-field record (rather than a
/// polymorphic hierarchy) keeps the SignalR JSON contract trivial: only the fields an op uses are populated.
/// <list type="bullet">
///   <item><c>addMember</c> / <c>updateMember</c>: <paramref name="Member"/> (+ <paramref name="Name"/> = the pre-edit name for update).</item>
///   <item><c>removeMember</c>: <paramref name="Name"/>.</item>
///   <item><c>addAssociation</c>: <paramref name="Assoc"/>.</item>
///   <item><c>renameAssociation</c>: <paramref name="Ref"/> + <paramref name="To"/>.</item>
///   <item><c>removeAssociation</c>: <paramref name="Ref"/>.</item>
///   <item><c>addType</c>: <paramref name="TypeKey"/> (the new full name) + <paramref name="Kind"/>.</item>
///   <item><c>renameType</c>: <paramref name="TypeKey"/> + <paramref name="To"/> (the new simple name).</item>
///   <item><c>removeType</c>: <paramref name="TypeKey"/>.</item>
/// </list>
/// </summary>
public sealed record EditAction(
    string Op,
    string TypeKey,
    string? Name = null,
    MemberDto? Member = null,
    AssocDto? Assoc = null,
    AssocDto? Ref = null,
    string? To = null,
    string? Kind = null);

/// <summary>The outcome of a Generate: on success the freshly re-derived IR; on failure the blocking errors.</summary>
public sealed record GenerateResult(bool Ok, IReadOnlyList<string> Errors, ProjectModel? Model);
