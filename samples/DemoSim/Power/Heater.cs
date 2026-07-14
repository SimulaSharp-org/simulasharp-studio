using SimulaSharp.Kernel.Attributes;
using SimulaSharp.Kernel.Logging;
using SimulaSharp.Kernel.Model;
using SimulaSharp.Kernel.Services;

namespace DemoSim.Power;

/// <summary>A resistive heater — a power consumer the EPS references cross-site through <see cref="IPowerConsumer"/>.
/// It lives on the <c>Loads</c> site while the EPS lives on <c>Bus</c>, so the reference genuinely marshals: the
/// generated <c>IPowerConsumerRef</c> reads <see cref="DrawW"/> directly (a volatile gauge) and <c>Post</c>s
/// <see cref="SetBudget"/> onto this model's site.</summary>
public partial class Heater(IClock c, IScheduler s, ILogger l) : ModelBase(c, s, l), IPowerConsumer
{
    /// <summary>The heater's rated draw when unbudgeted, in watts.</summary>
    [Parameter(50.0)] public double RatedW { get; set; }

    // The EPS may cap us below our rating; the effective draw is the smaller of the two. Written on this site (via
    // SetBudget, marshalled here) and read from any site (via the volatile DrawW gauge), so it is a plain double —
    // word-size, hence atomically readable.
    private double _budgetW = double.PositiveInfinity;

    /// <inheritdoc/>
    public double DrawW => System.Math.Min(RatedW, _budgetW);

    /// <inheritdoc/>
    public void SetBudget(double watts) => _budgetW = watts;
}
