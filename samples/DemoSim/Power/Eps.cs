using SimulaSharp.Kernel.Attributes;
using SimulaSharp.Kernel.Logging;
using SimulaSharp.Kernel.Model;
using SimulaSharp.Kernel.Services;

namespace DemoSim.Power;

/// <summary>The power subsystem: owns a list of batteries and references its power consumers (any
/// <see cref="IPowerConsumer"/>) cross-site through the interface.</summary>
[Contains<Battery>("Batteries")]
[References<IPowerConsumer>("Consumers")]
public partial class Eps(IClock c, IScheduler s, ILogger l) : ModelBase(c, s, l)
{
    [NumberKnob<double>("Bus voltage", Min = 0, Max = 32, DecimalPlaces = 2, IsReadOnly = true)]
    [Plottable("Vbus", Unit = "V")]
    public partial double Vbus { get; set; }
}
