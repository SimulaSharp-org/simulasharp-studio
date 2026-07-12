using SimulaSharp.Kernel.Attributes;
using SimulaSharp.Kernel.Logging;
using SimulaSharp.Kernel.Model;
using SimulaSharp.Kernel.Services;

namespace DemoSim.Env;

/// <summary>A shared environment service: publishes a <c>SunAngle</c> event and answers a current-angle request.</summary>
[ServiceEvent("SunAngle", typeof(double))]
public partial class Environment(IClock c, ILogger l) : ServiceBase(c, l, "Environment")
{
    [ServiceRequest] protected double Handle_CurrentAngle() => 0.0;
}
