using SimulaSharp.Kernel.Attributes;
using SimulaSharp.Kernel.Events;
using SimulaSharp.Kernel.Logging;
using SimulaSharp.Kernel.Model;
using SimulaSharp.Kernel.Services;

namespace DemoSim.Power;

/// <summary>The power subsystem. It shows both reference kinds at once:
/// <list type="bullet">
///   <item><see cref="Cells"/> is an intra-site <see cref="ReferenceAttribute{T}"/> — it names the very batteries the
///     EPS <em>contains</em> (same site, validated at generate time), handed in as the actual
///     <see cref="Battery"/> instances with no Ref and no marshalling.</item>
///   <item><see cref="Consumers"/> is a cross-site <see cref="CrossReferenceAttribute{T}"/> over the
///     <see cref="IPowerConsumer"/> interface — its targets (e.g. a <see cref="Heater"/>) may live on another site, so
///     each is wrapped in a generated <c>IPowerConsumerRef</c> that marshals for us.</item>
/// </list>
/// It also depends on the shared <see cref="DemoSim.Services.Environment"/> service.</summary>
[Contains<Battery>("Batteries")]
[Reference<Battery>("Cells")]
[CrossReference<IPowerConsumer>("Consumers")]
public partial class Eps(IClock c, IScheduler s, ILogger l) : ModelBase(c, s, l)
{
    /// <summary>The shared environment service, bound by the assembly's <c>Deps</c> block.</summary>
    [ServiceRef]
    public DemoSim.Services.Environment Environment { get; set; } = null!;

    [NumberKnob<double>("Bus voltage", Min = 0, Max = 32, DecimalPlaces = 2, IsReadOnly = true)]
    [Plottable("Vbus", Unit = "V")]
    public partial double Vbus { get; set; }

    /// <summary>A global bus-fault broadcast — a scheduler-less <see cref="ISimEventInvocator{T}">event</see> the EPS
    /// fires (with the failing bus voltage) when demand outstrips the budget. It is ownerless: no service stands behind
    /// it. Consumers on any site subscribe with an <c>[EventHandler]</c> and shed load; the assembly's <c>Triggers</c>
    /// block fills this producer handle.</summary>
    [EventReference]
    public ISimEventInvocator<double> BusFault { get; set; } = null!;

    /// <summary>Divides a total power budget evenly across the referenced consumers, then reports the resulting draw.
    /// Demonstrates the two cross-reference tiers: <c>SetBudget</c> is fired and forgotten on each consumer (a
    /// <see cref="TriggerableAttribute"/> command), while <c>DrawW</c> is sampled straight off it (a
    /// <see cref="VolatileAccessAttribute"/> gauge). The battery pool it draws against comes from the intra-site
    /// <see cref="Cells"/> reference — the actual contained instances, read directly.</summary>
    /// <param name="totalW">The bus-wide power budget to share across consumers, in watts.</param>
    /// <returns>The summed instantaneous draw across all consumers, in watts.</returns>
    public double Rebalance(double totalW)
    {
        // Intra reference: the contained batteries, as concrete instances — no Ref, direct field access.
        double poolWh = 0;
        for (int i = 0; i < Cells.Count; i++) poolWh += Cells[i].CapacityWh;

        double share = Consumers.Count > 0 ? totalW / Consumers.Count : 0;
        double drawW = 0;
        for (int i = 0; i < Consumers.Count; i++)
        {
            Consumers[i].SetBudget(share); // [Triggerable] → fire-and-forget across the site boundary
            drawW += Consumers[i].DrawW;   // [VolatileAccess] → direct gauge read, no dispatch
        }

        // If demand outstrips the shared budget, broadcast a bus-fault carrying the current voltage. Every subscriber
        // handles it on its own site — no owning service, no scheduler behind the event.
        if (drawW > totalW) BusFault.Trigger(Vbus);

        _ = poolWh; // (a real EPS would fold the battery pool into the bus model)
        return drawW;
    }
}
