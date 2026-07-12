namespace SimulaSharp.Studio.Core;

/// <summary>
/// The Studio engine (Phase-0 placeholder). This UI-agnostic library holds the core: the Roslyn workspace and
/// the designable-IR projection, the shared IR-level validator (the extracted SIM rules), the snapshot journal
/// (baseline + action sets), and the transactional apply (relocatable copy → build → apply/revert). It carries
/// no Photino/ASP.NET dependency, so it stays unit-testable on its own.
/// </summary>
public sealed class StudioEngine
{
}
