namespace SimulaSharp.Studio.Core.Tests;

/// <summary>The namespace → file-path mapping the layout pass places files by.</summary>
[TestFixture]
public sealed class LayoutNormalizerTests
{
    private static readonly string Dir = Path.Combine("C:", "proj");

    [Test]
    public void A_nested_namespace_becomes_subdirectories_under_the_project()
    {
        Assert.That(LayoutNormalizer.TargetPath(Dir, "DemoSim", "DemoSim.Power.Sensors", "Imu"),
            Is.EqualTo(Path.Combine(Dir, "Power", "Sensors", "Imu.cs")));
    }

    [Test]
    public void A_type_in_the_root_namespace_sits_in_the_project_directory()
    {
        Assert.That(LayoutNormalizer.TargetPath(Dir, "DemoSim", "DemoSim", "Root"),
            Is.EqualTo(Path.Combine(Dir, "Root.cs")));
    }

    [Test]
    public void A_namespace_that_does_not_extend_the_root_falls_back_to_its_full_path()
    {
        Assert.That(LayoutNormalizer.TargetPath(Dir, "DemoSim", "Other.Ns", "X"),
            Is.EqualTo(Path.Combine(Dir, "Other", "Ns", "X.cs")));
    }
}
