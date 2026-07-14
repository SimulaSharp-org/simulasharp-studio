using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.MSBuild;

namespace SimulaSharp.Studio.Core.Tests;

/// <summary>Builds the Type Selector catalog from the DemoSim compilation and exercises the query filters.</summary>
[TestFixture]
public sealed class TypeCatalogTests
{
    private static IReadOnlyList<TypeRef> _catalog = null!;

    [OneTimeSetUp]
    public async Task Build_the_catalog_once()
    {
        if (!Microsoft.Build.Locator.MSBuildLocator.IsRegistered)
            Microsoft.Build.Locator.MSBuildLocator.RegisterDefaults();

        string csproj = FindUp("Studio", "samples", "DemoSim", "DemoSim.csproj");
        using var workspace = MSBuildWorkspace.Create();
        var project = await workspace.OpenProjectAsync(csproj);
        var compilation = await project.GetCompilationAsync()
                          ?? throw new InvalidOperationException("Could not compile DemoSim.");
        _catalog = TypeCatalog.Build(compilation);
    }

    private static TypeRef? Find(string fqn) => _catalog.FirstOrDefault(t => t.Fqn == fqn);

    [Test]
    public void Surfaces_primitives_project_types_and_flags_them()
    {
        Assert.Multiple(() =>
        {
            var d = Find("System.Double");
            Assert.That(d, Is.Not.Null, "double primitive present");
            Assert.That(d!.Name, Is.EqualTo("double"), "shown by C# alias");
            Assert.That(d.Volatile && d.Marshalable && !d.Bcl, "double is a non-BCL volatile+marshalable primitive");

            var battery = _catalog.FirstOrDefault(t => t.Name == "Battery");
            Assert.That(battery, Is.Not.Null.And.Property("Category").EqualTo("Model"));

            var ipc = _catalog.FirstOrDefault(t => t.Name == "IPowerConsumer");
            Assert.That(ipc, Is.Not.Null.And.Property("Category").EqualTo("Interface"));

            var env = _catalog.FirstOrDefault(t => t.Name == "Environment");
            Assert.That(env, Is.Not.Null.And.Property("Category").EqualTo("Service"));

            // A project enum surfaces as a non-BCL, marshalable, volatile value.
            var mode = Find("DemoSim.Power.PowerMode");
            Assert.That(mode, Is.Not.Null, "project enum catalogued");
            Assert.That(mode!.Category, Is.EqualTo("Enum"));
            Assert.That(mode.Volatile && mode.Marshalable && !mode.Bcl, "an enum is a non-BCL volatile+marshalable value");
        });
    }

    [Test]
    public void Kernel_ModelBase_is_an_abstract_model_from_a_referenced_assembly()
    {
        var mb = _catalog.FirstOrDefault(t => t.Name == "ModelBase");
        Assert.That(mb, Is.Not.Null, "referenced-assembly models are catalogued");
        Assert.That(mb!.Category, Is.EqualTo("Model"));
        Assert.That(mb.Abstract, Is.True, "ModelBase is an abstract base");
    }

    [Test]
    public void Bcl_types_are_flagged_and_hidden_unless_the_toggle_is_on()
    {
        // System enums exist and are flagged BCL.
        Assert.That(_catalog.Any(t => t.Category == "Enum" && t.Bcl), "closure BCL enums are catalogued and flagged");

        var withoutBcl = TypeCatalog.Query(_catalog, new TypeQuery(TypeFilter.All, IncludeBcl: false, IncludeAbstractClasses: true, ""));
        var withBcl = TypeCatalog.Query(_catalog, new TypeQuery(TypeFilter.All, IncludeBcl: true, IncludeAbstractClasses: true, ""));
        Assert.That(withBcl.Total, Is.GreaterThan(withoutBcl.Total), "the BCL toggle widens the result set");
    }

    [Test]
    public void Volatile_filter_admits_enums_and_numbers_but_not_interfaces()
    {
        var r = TypeCatalog.Query(_catalog, new TypeQuery(TypeFilter.Volatile, IncludeBcl: true, IncludeAbstractClasses: true, "Double"));
        Assert.That(r.Items.Any(t => t.Fqn == "System.Double"));
        // A Volatile slot never offers a plain interface.
        var iface = TypeCatalog.Query(_catalog, new TypeQuery(TypeFilter.Volatile, IncludeBcl: true, IncludeAbstractClasses: true, "IPowerConsumer"));
        Assert.That(iface.Items.Any(t => t.Name == "IPowerConsumer"), Is.False);
    }

    [Test]
    public void Interfaces_filter_admits_only_interfaces()
    {
        var r = TypeCatalog.Query(_catalog, new TypeQuery(TypeFilter.Interfaces, IncludeBcl: false, IncludeAbstractClasses: true, "IPowerConsumer"));
        Assert.That(r.Items, Has.All.Property("Category").EqualTo("Interface"));
        Assert.That(r.Items.Any(t => t.Name == "IPowerConsumer"), Is.True);
    }

    [Test]
    public void Abstract_classes_are_dropped_unless_allowed()
    {
        var concreteOnly = TypeCatalog.Query(_catalog, new TypeQuery(TypeFilter.Models, IncludeBcl: false, IncludeAbstractClasses: false, "ModelBase"));
        var withAbstract = TypeCatalog.Query(_catalog, new TypeQuery(TypeFilter.Models, IncludeBcl: false, IncludeAbstractClasses: true, "ModelBase"));
        Assert.That(concreteOnly.Items.Any(t => t.Name == "ModelBase"), Is.False, "abstract ModelBase hidden by default");
        Assert.That(withAbstract.Items.Any(t => t.Name == "ModelBase"), Is.True, "shown when abstract allowed");
    }

    [Test]
    public void A_too_broad_query_returns_the_count_but_no_items()
    {
        // All types, BCL included, no search — comfortably over the 64 display cap.
        var r = TypeCatalog.Query(_catalog, new TypeQuery(TypeFilter.All, IncludeBcl: true, IncludeAbstractClasses: true, ""));
        Assert.That(r.Total, Is.GreaterThan(TypeCatalog.DisplayCap));
        Assert.That(r.Items, Is.Empty, "over the cap, the picker asks the user to narrow down");
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
