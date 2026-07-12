using SimulaSharp.Kernel.Attributes;
using SimulaSharp.Kernel.Logging;
using SimulaSharp.Kernel.Model;
using SimulaSharp.Kernel.Services;

namespace DemoSim.Power;

/// <summary>A battery cell — a contained EPS sub-model with a capacity parameter and a charge knob/plottable.</summary>
public partial class Battery(IClock c, IScheduler s, ILogger l) : ModelBase(c, s, l)
{
    [Parameter(1500.0)] public double CapacityWh { get; set; }

    [NumberKnob<double>("Charge", Min = 0, Max = 100, DecimalPlaces = 1, IsReadOnly = true)]
    [Plottable("Charge", Unit = "%")]
    public partial double ChargePct { get; set; }
}
