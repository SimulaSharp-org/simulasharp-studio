using SimulaSharp.Kernel.Attributes;
using SimulaSharp.Kernel.Logging;
using SimulaSharp.Kernel.Model;
using SimulaSharp.Kernel.Services;

namespace DemoSim.Power;

/// <summary>A resistive heater — a power consumer the EPS references through <see cref="IPowerConsumer"/>.</summary>
public partial class Heater(IClock c, IScheduler s, ILogger l) : ModelBase(c, s, l), IPowerConsumer
{
    [Parameter(50.0)] public double RatedW { get; set; }

    public double DrawW => RatedW;
}
