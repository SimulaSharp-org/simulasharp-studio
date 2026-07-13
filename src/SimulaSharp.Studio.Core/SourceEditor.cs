using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Editing;
using Microsoft.CodeAnalysis.Formatting;
using static Microsoft.CodeAnalysis.CSharp.SyntaxFactory;

namespace SimulaSharp.Studio.Core;

/// <summary>
/// The structural write-back: turns <see cref="EditAction"/>s into Roslyn syntax edits on a type's declaration
/// (add / update / remove of a member). Each pure transform is <c>TypeDeclarationSyntax → TypeDeclarationSyntax</c>
/// so it is unit-testable without a workspace; <see cref="ApplyToTypeAsync"/> folds a type's actions into one node
/// replacement and lets <see cref="ProjectGenerator"/> compile-verify before anything reaches disk.
/// </summary>
public static class SourceEditor
{
    /// <summary>Applies every action targeting <paramref name="type"/> to its user-declared source document.</summary>
    public static async Task<Solution> ApplyToTypeAsync(
        Solution solution, INamedTypeSymbol type, IReadOnlyList<EditAction> actions, CancellationToken ct = default)
    {
        // The editable declaration is the one written by the user (never a generated .g.cs partial).
        var syntaxRef = type.DeclaringSyntaxReferences.FirstOrDefault(r =>
                            !r.SyntaxTree.FilePath.EndsWith(".g.cs", StringComparison.OrdinalIgnoreCase))
                        ?? throw new InvalidOperationException($"No editable source for type '{type.Name}'.");

        var document = solution.GetDocument(syntaxRef.SyntaxTree)
                       ?? throw new InvalidOperationException($"'{type.Name}' is not in an editable document.");
        var typeDecl = (TypeDeclarationSyntax)await syntaxRef.GetSyntaxAsync(ct).ConfigureAwait(false);

        var edited = actions.Aggregate(typeDecl, Apply);

        var editor = await DocumentEditor.CreateAsync(document, ct).ConfigureAwait(false);
        editor.ReplaceNode(typeDecl, edited);
        // Re-flow only the nodes we touched (they carry the formatter annotation), keeping the diff minimal.
        var formatted = await Formatter.FormatAsync(editor.GetChangedDocument(), Formatter.Annotation, cancellationToken: ct)
            .ConfigureAwait(false);
        return formatted.Project.Solution;
    }

    private static TypeDeclarationSyntax Apply(TypeDeclarationSyntax type, EditAction a) => a.Op switch
    {
        "removeMember" => RemoveMember(type, a.Name ?? throw Missing("removeMember", "name")),
        "addMember" => AddMember(type, a.Member ?? throw Missing("addMember", "member")),
        "updateMember" => UpdateMember(type, a.Name ?? throw Missing("updateMember", "name"), a.Member ?? throw Missing("updateMember", "member")),
        _ => throw new NotSupportedException($"Generate does not yet support '{a.Op}'."),
    };

    private static InvalidOperationException Missing(string op, string field) => new($"{op} needs a {field}.");

    // ── Remove ────────────────────────────────────────────────────────────────

    /// <summary>Removes the member (property / single-variable field / method) named <paramref name="name"/>, or a
    /// class-level <c>[ServiceEvent("name")]</c> of that name.</summary>
    public static TypeDeclarationSyntax RemoveMember(TypeDeclarationSyntax type, string name)
    {
        if (FindMember(type, name) is { } member)
            // KeepNoTrivia also drops the member's leading blank line / indentation, so the gap closes cleanly.
            return (TypeDeclarationSyntax)type.RemoveNode(member, SyntaxRemoveOptions.KeepNoTrivia)!;

        if (FindServiceEvent(type, name) is { } evt)
            return (TypeDeclarationSyntax)type.RemoveNode(evt, SyntaxRemoveOptions.KeepNoTrivia)!;

        throw new InvalidOperationException($"Member '{name}' not found on '{type.Identifier.Text}'.");
    }

    // ── Add ───────────────────────────────────────────────────────────────────

    /// <summary>Adds a member synthesised from <paramref name="dto"/> (a value property, interface property/method,
    /// service-request handler, or class-level service event).</summary>
    public static TypeDeclarationSyntax AddMember(TypeDeclarationSyntax type, MemberDto dto)
    {
        if (dto.Facets.Contains("ServiceEvent"))
            return type.AddAttributeLists(ParseAttributeList(ServiceEventAttr(dto)).WithAdditionalAnnotations(Formatter.Annotation));

        var member = ParseMemberDeclaration(BuildMemberText(dto))
                     ?? throw new InvalidOperationException($"Could not synthesise member '{dto.Name}'.");
        return type.AddMembers(member.WithAdditionalAnnotations(Formatter.Annotation));
    }

    private static string BuildMemberText(MemberDto dto)
    {
        var f = dto.Facets;
        string type = string.IsNullOrWhiteSpace(dto.Type) ? "double" : dto.Type!;

        if (f.Contains("ServiceRequest"))
        {
            string ret = string.IsNullOrWhiteSpace(dto.Type) ? "void" : dto.Type!;
            string body = ret == "void" ? "{ }" : "=> throw new global::System.NotImplementedException();";
            return $"[ServiceRequest] public {ret} Handle_{dto.Name}() {body}";
        }
        if (f.Contains("Method")) // interface method
            return $"{(string.IsNullOrWhiteSpace(dto.Type) ? "void" : dto.Type)} {dto.Name}();";
        if (f.Contains("Property")) // interface property
            return $"{type} {dto.Name} {{ get; set; }}";

        // A value member: a property carrying its Parameter / Knob / Plottable attributes.
        var attrs = new List<string>();
        if (f.Contains("Parameter")) attrs.Add("[Parameter]");
        if (f.Contains("Knob")) attrs.Add(KnobAttr(type, dto.Name));
        if (f.Contains("Plottable")) attrs.Add($"[Plottable(\"{dto.Name}\")]");
        string partial = f.Contains("Knob") ? "partial " : ""; // knobs generate a backing part
        return $"{string.Join(" ", attrs)} public {partial}{type} {dto.Name} {{ get; set; }}";
    }

    // ── Update ────────────────────────────────────────────────────────────────

    /// <summary>Updates the member <paramref name="oldName"/> to match <paramref name="dto"/> — renaming, retyping and
    /// adding/removing attributes for changed facets, while <b>preserving</b> the arguments of attributes that stay.</summary>
    public static TypeDeclarationSyntax UpdateMember(TypeDeclarationSyntax type, string oldName, MemberDto dto)
    {
        var member = FindMember(type, oldName)
                     ?? throw new InvalidOperationException($"Member '{oldName}' not found on '{type.Identifier.Text}'.");

        MemberDeclarationSyntax updated = member switch
        {
            PropertyDeclarationSyntax p => UpdateProperty(p, dto),
            FieldDeclarationSyntax fld => fld
                .WithDeclaration(fld.Declaration
                    .WithType(TypeOr(dto.Type, fld.Declaration.Type))
                    .WithVariables(SingletonSeparatedList(fld.Declaration.Variables[0].WithIdentifier(Identifier(dto.Name))))),
            MethodDeclarationSyntax m => m
                .WithReturnType(TypeOr(dto.Type, m.ReturnType).WithTrailingTrivia(Space))
                .WithIdentifier(Identifier(HasAttr(m.AttributeLists, "ServiceRequest") ? "Handle_" + dto.Name : dto.Name)),
            _ => throw new NotSupportedException($"Cannot update member kind '{member.Kind()}'."),
        };

        return type.ReplaceNode(member, updated.WithAdditionalAnnotations(Formatter.Annotation));
    }

    private static PropertyDeclarationSyntax UpdateProperty(PropertyDeclarationSyntax p, MemberDto dto)
    {
        var want = dto.Facets;

        // Keep attribute lists whose facet is still wanted (and any non-facet attributes untouched).
        var lists = p.AttributeLists
            .Where(al => al.Attributes.All(at => FacetOf(at) is not { } facet || want.Contains(facet)))
            .ToList();
        var have = p.AttributeLists.SelectMany(al => al.Attributes).Select(FacetOf).Where(f => f is not null).ToHashSet();

        // Add attributes for newly-wanted value facets (labels/defaults default off the member's new name).
        foreach (var facet in new[] { "Parameter", "Knob", "Plottable" }.Where(f => want.Contains(f) && !have.Contains(f)))
            lists.Add(ParseAttributeList(ValueAttr(facet, TypeOr(dto.Type, p.Type).ToString(), dto.Name)));

        // Knobs need a partial property; drop the modifier if the knob facet is gone.
        var modifiers = p.Modifiers;
        bool isPartial = modifiers.Any(SyntaxKind.PartialKeyword);
        if (want.Contains("Knob") && !isPartial) modifiers = modifiers.Add(Token(SyntaxKind.PartialKeyword));
        else if (!want.Contains("Knob") && isPartial) modifiers = TokenList(modifiers.Where(m => !m.IsKind(SyntaxKind.PartialKeyword)));

        return p.WithAttributeLists(List(lists))
            .WithModifiers(modifiers)
            .WithType(TypeOr(dto.Type, p.Type).WithTrailingTrivia(Space))
            .WithIdentifier(Identifier(dto.Name));
    }

    // ── Attribute + type helpers ───────────────────────────────────────────────

    private static string ValueAttr(string facet, string type, string name) => facet switch
    {
        "Parameter" => "[Parameter]",
        "Knob" => KnobAttr(type, name),
        "Plottable" => $"[Plottable(\"{name}\")]",
        _ => throw new NotSupportedException($"No attribute for facet '{facet}'."),
    };

    private static string KnobAttr(string type, string name) => type switch
    {
        "bool" => $"[TickBoxKnob(\"{name}\")]",
        "string" => $"[TextKnob(\"{name}\")]",
        _ => $"[NumberKnob<{type}>(\"{name}\")]",
    };

    private static string ServiceEventAttr(MemberDto dto) =>
        string.IsNullOrWhiteSpace(dto.Type) ? $"[ServiceEvent(\"{dto.Name}\")]" : $"[ServiceEvent(\"{dto.Name}\", typeof({dto.Type}))]";

    /// <summary>The facet a member-level attribute represents, or null if it is not a designable-member attribute.</summary>
    private static string? FacetOf(AttributeSyntax attr)
    {
        string n = attr.Name.ToString();
        if (n.Contains("Knob")) return "Knob";
        if (n is "Parameter" or "ParameterAttribute") return "Parameter";
        if (n is "Plottable" or "PlottableAttribute") return "Plottable";
        return null;
    }

    private static bool HasAttr(SyntaxList<AttributeListSyntax> lists, string name) =>
        lists.SelectMany(l => l.Attributes).Any(a => a.Name.ToString().Contains(name));

    private static TypeSyntax TypeOr(string? type, TypeSyntax fallback) =>
        string.IsNullOrWhiteSpace(type) ? fallback : ParseTypeName(type!);

    private static AttributeListSyntax ParseAttributeList(string attr) =>
        ((MemberDeclarationSyntax)ParseMemberDeclaration($"{attr} class _ {{ }}")!).AttributeLists[0].WithoutTrivia();

    // ── Member lookup ──────────────────────────────────────────────────────────

    /// <summary>Finds a member by its designable name: a property/field identifier, an interface method, or a
    /// service-request handler (whose method is <c>Handle_&lt;name&gt;</c>).</summary>
    private static MemberDeclarationSyntax? FindMember(TypeDeclarationSyntax type, string name) =>
        type.Members.FirstOrDefault(m => m switch
        {
            PropertyDeclarationSyntax p => p.Identifier.Text == name,
            FieldDeclarationSyntax { Declaration.Variables: [{ } v] } => v.Identifier.Text == name,
            MethodDeclarationSyntax method => method.Identifier.Text == name || method.Identifier.Text == "Handle_" + name,
            _ => false,
        });

    /// <summary>Finds a class-level <c>[ServiceEvent("name", …)]</c> attribute by its event name.</summary>
    private static AttributeSyntax? FindServiceEvent(TypeDeclarationSyntax type, string name) =>
        type.AttributeLists.SelectMany(l => l.Attributes).FirstOrDefault(a =>
            a.Name.ToString().Contains("ServiceEvent") &&
            a.ArgumentList?.Arguments.FirstOrDefault()?.Expression is LiteralExpressionSyntax lit &&
            lit.Token.ValueText == name);
}
