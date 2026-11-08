# SimulaSharp.Studio

Visual design tool for SimulaSharp: model and service class design plus a topology editor, with Roslyn write-back to your code.

Studio works on a real SimulaSharp project on disk. Your code and the `*.simassembly.yaml` stay the source of truth: Studio reads them through Roslyn into an in-memory model, lets you edit, and writes the changes back to the code and the YAML when you apply them. Edits stay pending until you apply them, and an apply is checked by a build before it is kept.

It has two editors:

- **Class design**: a canvas for models, services and interfaces, with their members (knobs, plottables, parameters, service events and requests) and associations (containment, references, cross-references, service dependencies). Member types are picked from a type selector that only offers concrete, resolvable types.
- **Topology**: an editor for the YAML *assembly* (sites, model instances, services, bindings).

> **Status:** Studio has fallen behind the framework ([simulasharp-core](https://github.com/SimulaSharp-org/simulasharp-core)) in development and is not released yet. Newer framework features may not be editable in it.

## Requirements

- .NET SDK 10
- Node.js 18+ and npm (for the web front end)

## Build and run

Studio is one desktop process: an in-process ASP.NET Core backend (SignalR) that serves the built web front end in a native webview (Photino). Build the front end first; the Host copies `web/dist` into its output at build.

```powershell
cd web
npm install
npm run build
cd ..
dotnet build SimulaSharp.Studio.slnx
dotnet run --project src\SimulaSharp.Studio.Host
```

## The sample and the tests

`samples/DemoSim` is a small simulation used as the test fixture. It references the framework as the `SimulaSharp` NuGet package. Until that package is on nuget.org, build it from `simulasharp-core` with its `pack.ps1` and add a `nuget.config` here that points at the result:

```xml
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <add key="simulasharp-local" value="..\core\artifacts" />
  </packageSources>
</configuration>
```

Then:

```powershell
dotnet test tests\SimulaSharp.Studio.Core.Tests\SimulaSharp.Studio.Core.Tests.csproj
```

## Layout

- `src/SimulaSharp.Studio.Core/`: the Roslyn side: project reading, the design model, code and YAML write-back, the type catalog.
- `src/SimulaSharp.Studio.Host/`: the desktop shell: ASP.NET Core + SignalR backend and the Photino window.
- `web/`: the Vite + React front end.
- `tests/SimulaSharp.Studio.Core.Tests/`: NUnit tests.
- `samples/DemoSim/`: the sample simulation.

## License

MIT. Copyright (c) 2026 Andreas Michelis. See [LICENSE](LICENSE).
