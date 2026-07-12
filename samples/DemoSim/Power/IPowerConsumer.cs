namespace DemoSim.Power;

/// <summary>A capability a power-drawing device exposes to the EPS. Framework-pure — it does not derive IModel.</summary>
public interface IPowerConsumer
{
    /// <summary>Instantaneous draw, in watts.</summary>
    double DrawW { get; }
}
