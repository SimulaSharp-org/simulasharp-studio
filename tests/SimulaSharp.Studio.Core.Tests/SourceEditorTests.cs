using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace SimulaSharp.Studio.Core.Tests;

/// <summary>Proves the structural write-back at the syntax level, with no workspace or disk involved.</summary>
[TestFixture]
public sealed class SourceEditorTests
{
    private static TypeDeclarationSyntax Parse(string source) =>
        CSharpSyntaxTree.ParseText(source).GetRoot().DescendantNodes().OfType<TypeDeclarationSyntax>().First();

    [Test]
    public void RemoveMember_drops_the_named_property_and_keeps_the_rest()
    {
        var type = Parse(
            """
            class C
            {
                public double Vbus { get; set; }
                public int Keep { get; set; }
            }
            """);

        var edited = SourceEditor.RemoveMember(type, "Vbus").ToFullString();

        Assert.That(edited, Does.Not.Contain("Vbus"));
        Assert.That(edited, Does.Contain("Keep"));
    }

    [Test]
    public void RemoveMember_drops_a_single_variable_field()
    {
        var type = Parse("class C { private int _n; public int Keep; }");

        var edited = SourceEditor.RemoveMember(type, "_n").ToFullString();

        Assert.That(edited, Does.Not.Contain("_n"));
        Assert.That(edited, Does.Contain("Keep"));
    }

    [Test]
    public void RemoveMember_throws_for_an_unknown_member()
    {
        var type = Parse("class C { public int Keep { get; set; } }");

        Assert.That(() => SourceEditor.RemoveMember(type, "Nope"), Throws.InvalidOperationException);
    }

    [Test]
    public void AddMember_synthesises_a_knob_plus_plottable_property()
    {
        var type = Parse("partial class C { }");

        var text = SourceEditor.AddMember(type, new MemberDto("Speed", "double", ["Knob", "Plottable"])).ToFullString();

        Assert.That(text, Does.Contain("[NumberKnob<double>(\"Speed\")]"));
        Assert.That(text, Does.Contain("[Plottable(\"Speed\")]"));
        Assert.That(text, Does.Contain("partial double Speed"), "a knob property must be partial");
    }

    [Test]
    public void AddMember_synthesises_a_plain_parameter_property()
    {
        var type = Parse("partial class C { }");

        var text = SourceEditor.AddMember(type, new MemberDto("Cap", "double", ["Parameter"])).ToFullString();

        Assert.That(text, Does.Contain("[Parameter]"));
        Assert.That(text, Does.Not.Contain("partial double Cap"), "a non-knob property is not partial");
    }

    [Test]
    public void AddMember_synthesises_an_interface_property_without_an_access_modifier()
    {
        var type = Parse("interface I { }");

        var text = SourceEditor.AddMember(type, new MemberDto("Draw", "double", ["Property"])).ToFullString();

        Assert.That(text, Does.Contain("double Draw"));
        Assert.That(text, Does.Not.Contain("public double Draw"));
    }

    [Test]
    public void UpdateMember_renames_but_preserves_an_existing_attribute_argument()
    {
        var type = Parse("class C { [Parameter(1500.0)] public double CapacityWh { get; set; } }");

        var text = SourceEditor.UpdateMember(type, "CapacityWh", new MemberDto("Cap", "double", ["Parameter"])).ToFullString();

        Assert.That(text, Does.Contain("Cap"));
        Assert.That(text, Does.Not.Contain("CapacityWh"));
        Assert.That(text, Does.Contain("[Parameter(1500.0)]"), "the parameter's default must survive a rename");
    }

    [Test]
    public void UpdateMember_adds_a_facet_while_keeping_the_untouched_one()
    {
        var type = Parse("partial class C { [NumberKnob<double>(\"V\")] public partial double Vbus { get; set; } }");

        var text = SourceEditor.UpdateMember(type, "Vbus", new MemberDto("Vbus", "double", ["Knob", "Plottable"])).ToFullString();

        Assert.That(text, Does.Contain("[NumberKnob<double>(\"V\")]"), "the existing knob label must be preserved");
        Assert.That(text, Does.Contain("[Plottable(\"Vbus\")]"), "the new plottable facet is added");
    }

    [Test]
    public void UpdateMember_dropping_the_knob_facet_removes_partial_and_the_knob_attribute()
    {
        var type = Parse("partial class C { [NumberKnob<double>(\"V\")] public partial double Vbus { get; set; } }");

        var text = SourceEditor.UpdateMember(type, "Vbus", new MemberDto("Vbus", "double", ["Parameter"])).ToFullString();

        Assert.That(text, Does.Not.Contain("NumberKnob"));
        Assert.That(text, Does.Not.Contain("partial double"), "the property must no longer be partial");
        Assert.That(text, Does.Contain("[Parameter]"));
    }
}
