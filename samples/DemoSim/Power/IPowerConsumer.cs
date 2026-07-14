using SimulaSharp.Kernel.Attributes;

namespace DemoSim.Power;

/// <summary>How a consumer regulates its draw. A project enum — the Studio Type Selector surfaces it (a marshalable
/// value) for member and parameter slots.</summary>
public enum PowerMode
{
    /// <summary>Drawing nothing.</summary>
    Off,
    /// <summary>Capped to a low budget.</summary>
    Eco,
    /// <summary>Drawing at the rated maximum.</summary>
    Full,
}

/// <summary>A capability a power-drawing device exposes to the EPS. Framework-pure — it does not derive IModel — so it
/// can be a <see cref="CrossReferenceAttribute{T}"/> target: the EPS references its consumers through this interface and
/// the generator mints an <c>IPowerConsumerRef</c> that marshals across sites. The two members show the two low-latency
/// tiers of the cross-reference surface:
/// <list type="bullet">
///   <item><see cref="DrawW"/> is a <see cref="VolatileAccessAttribute"/> gauge — a get-only, atomically-readable
///     property the Ref reads directly (no dispatch), for cheap live sampling.</item>
///   <item><see cref="SetBudget"/> is a <see cref="TriggerableAttribute"/> command — a <c>void</c> method the Ref
///     fires and forgets (inline when same-site, a scheduler <c>Post</c> when cross-site).</item>
/// </list>
/// Any member left unattributed would instead surface as an async request/response (<c>Task&lt;T&gt;</c>).</summary>
public interface IPowerConsumer
{
    /// <summary>Instantaneous draw, in watts. A live gauge — read directly off the target with no marshalling.</summary>
    [VolatileAccess]
    double DrawW { get; }

    /// <summary>Cap this consumer's draw to <paramref name="watts"/>. Fire-and-forget: the caller does not wait for
    /// the consumer to apply it.</summary>
    [Triggerable]
    void SetBudget(double watts);

    /// <summary>Switch the consumer's regulation mode. Fire-and-forget, and — via the <see cref="PowerMode"/> enum —
    /// an example of a project-enum-typed cross-reference parameter.</summary>
    [Triggerable]
    void SetMode(PowerMode mode);
}
