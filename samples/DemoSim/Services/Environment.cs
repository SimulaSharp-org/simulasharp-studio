using SimulaSharp.Kernel.Attributes;
using SimulaSharp.Kernel.Logging;
using SimulaSharp.Kernel.Model;
using SimulaSharp.Kernel.Services;

namespace DemoSim.Services;
/// <summary>A shared environment service: publishes a <c>SunAngle</c> event and answers a current-angle request. It also
/// subscribes to the global <c>BusFault</c> event — showing that a <b>service</b> (not just a model) can be a global-event
/// subscriber; its handler runs on the service's own site.</summary>
[ServiceEvent("SunAngle", typeof(double))]
public partial class Environment(IClock c, ILogger l) : ServiceBase(c, l, "Environment")
{
    [ServiceRequest]
    protected double Handle_CurrentAngle() => 0.0;

    /// <summary>Handles the EPS's global <c>BusFault</c> broadcast (wired by the assembly's <c>Subscriptions</c> block).</summary>
    [EventHandler]
    public void OnBusFault(double busVoltage) => Logger.LogWarning($"bus fault at {busVoltage:F2} V");
}